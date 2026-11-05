//! FILENAME: app/src-tauri/src/commands/cell_shaped_name_shift_tests.rs
//! PURPOSE: A LET name or LAMBDA parameter SPELLED LIKE A CELL (`x1`, `A1`,
//!          `XFD1`) is a name to every text shifter -- Fill and Copy+Paste,
//!          the structural row / column shifts on and off the sheet, the
//!          Cut+Paste relocation and Insert/Delete Cells -- and so is every
//!          other plain cell spelling in a formula that declares one (Excel's
//!          R1C1 fallback, `parser::parser::apply_r1c1_fallback`).
//! CONTEXT: A `#[path]` child of `commands::structure`, so it reaches the
//!          private shifters and the hold itself. The command-level twins are
//!          `structure_cells_tests::cell_shaped_names` (the structural
//!          commands and defined names) and `data::let_name_fill_tests` (Fill,
//!          Copy+Paste, Cut+Paste).
//!
//! [LIVE, Excel 16, 2026-11-05, rev-parse probeA, a fresh unsaved workbook,
//! D1 = 10, D2 = 20, D3:D30 = 1003..1030; the formulas typed into F5:F9]
//!   F5 =LET(x1,5,x1*2)              10   unchanged through everything below
//!   F6 =LAMBDA(a1,b1,a1+b1)(3,4)     7   unchanged
//!   F7 =LET(A1,5,RC4)  stored $D7  1007   delete row 1 -> $D6, delete columns
//!                                        X then A -> $C6, insert row 1 -> $C7
//!   F8 =LET(A1,5,R1C4+A1) ($D$1)     15   delete row 1 -> #REF!+A1
//!   F9 =LET(X1,5,X1*2)              10   unchanged
//! and on Sheet2: B2 =LET(x1,5,x1*2) and C2 =LET(A1,5,A1+RC4) (`$D2`) copied up
//! to row 1 (`$D1`), filled down to row 4 (`$D4`); XFC3 =LET(XFD1,5,XFD1*2)
//! filled right onto XFD3, A3 =LET(a1,5,a1*2) copied to B5, Q7
//! =LET(Q5,2,Q5*3) filled right onto R7 -- every name unchanged.

use super::structure_cells::{shift_formula_in_band, BandEdit, CellShift};
use super::*;
use parser::Expression;

/// Every edit probeA made, through the sheet-aware structural shifter (the
/// formula on Sheet1, Sheet1 edited) and the sheet-blind one the print and
/// scroll areas use.
#[test]
fn a_structural_edit_never_renames_a_name_spelled_like_a_cell() {
    let del_row1 = |f: &str| shift_formula_rows_sheet_aware(f, "Sheet1", "Sheet1", 0, -1);
    let ins_row1 = |f: &str| shift_formula_rows_sheet_aware(f, "Sheet1", "Sheet1", 0, 1);
    let del_col_x = |f: &str| shift_formula_cols_sheet_aware(f, "Sheet1", "Sheet1", 23, -1);
    let del_col_a = |f: &str| shift_formula_cols_sheet_aware(f, "Sheet1", "Sheet1", 0, -1);
    let ins_col_a = |f: &str| shift_formula_cols_sheet_aware(f, "Sheet1", "Sheet1", 0, 1);
    let mut wrong = Vec::new();
    for keeps in ["=LET(x1,5,x1*2)", "=LAMBDA(a1,b1,a1+b1)(3,4)", "=LET(X1,5,X1*2)", "=LET(XFD1,5,XFD1*2)"] {
        for (edit, got) in [
            ("delete row 1", del_row1(keeps)),
            ("insert row 1", ins_row1(keeps)),
            ("delete column X", del_col_x(keeps)),
            ("delete column A", del_col_a(keeps)),
            ("insert column A", ins_col_a(keeps)),
            ("delete row 1 (sheet-blind)", shift_formula_row_references(keeps, 0, -1)),
            ("insert column A (sheet-blind)", shift_formula_col_references(keeps, 0, 1)),
        ] {
            if got != keeps {
                wrong.push(format!("{keeps}, {edit}: got {got}, Excel keeps it"));
            }
        }
    }
    assert!(wrong.is_empty(), "a LET / LAMBDA name spelled like a cell was shifted:\n  {}", wrong.join("\n  "));

    // Only the real references move, as in Excel.
    assert_eq!(del_row1("=LET(A1,5,$D7)"), "=LET(A1,5,$D6)");
    assert_eq!(del_col_a(&del_col_x("=LET(A1,5,$D6)")), "=LET(A1,5,$C6)");
    assert_eq!(ins_row1("=LET(A1,5,$C6)"), "=LET(A1,5,$C7)");
    assert_eq!(del_row1("=LET(A1,5,$D$1+A1)"), "=LET(A1,5,#REF!+A1)");
    // Off the edited sheet: a qualified reference to the edited sheet moves,
    // the names do not.
    assert_eq!(
        shift_formula_rows_sheet_aware("=LET(x1,5,x1+Sheet1!$D$5)", "Sheet2", "Sheet1", 0, 1),
        "=LET(x1,5,x1+Sheet1!$D$6)"
    );
    assert_eq!(
        shift_formula_cols_sheet_aware("=LET(x1,5,x1+Sheet1!$D$5)", "Sheet2", "Sheet1", 0, -1),
        "=LET(x1,5,x1+Sheet1!$C$5)"
    );
    // A formula that declares no cell-shaped name is read in A1 as before...
    assert_eq!(ins_row1("=LET(x,5,x+D1)"), "=LET(x,5,x+D2)");
    // ...and a name spelled like a cell PAST the sheet's edge is a name in
    // any formula [LIVE, probe B: `=LET(XFE1,5,XFE1+D1)` and
    // `=LET(A1048577,5,A1048577+D1)` are 15, D1 a reference].
    assert_eq!(ins_row1("=LET(XFE1,5,XFE1+D1)"), "=LET(XFE1,5,XFE1+D2)", "XFE1 is no cell: no fallback");
    assert_eq!(ins_row1("=LET(A1048577,5,A1048577+D1)"), "=LET(A1048577,5,A1048577+D2)");
    assert_eq!(ins_col_a("=ZZZ1+B1"), "=ZZZ1+C1", "a defined name ZZZ1 is no column");
    assert_eq!(shift_formula_internal("=ZZZ1*B1", 1, 1), "=ZZZ1*C2");
}

/// Fill and Copy+Paste: probeA's Sheet2 half.
#[test]
fn a_fill_or_a_copy_never_renames_a_name_spelled_like_a_cell() {
    let mut wrong = Vec::new();
    for (formula, dr, dc, excel) in [
        ("=LET(x1,5,x1*2)", -1, 0, "=LET(x1,5,x1*2)"),
        ("=LET(A1,5,A1+$D2)", -1, 0, "=LET(A1,5,A1+$D1)"),
        ("=LET(x1,5,x1*2)", 2, 0, "=LET(x1,5,x1*2)"),
        ("=LET(A1,5,A1+$D2)", 2, 0, "=LET(A1,5,A1+$D4)"),
        ("=LET(XFD1,5,XFD1*2)", 0, 1, "=LET(XFD1,5,XFD1*2)"),
        ("=LET(a1,5,a1*2)", 2, 1, "=LET(a1,5,a1*2)"),
        ("=LET(Q5,2,Q5*3)", 0, 1, "=LET(Q5,2,Q5*3)"),
        ("=LAMBDA(a1,b1,a1+b1)(3,4)", 5, 5, "=LAMBDA(a1,b1,a1+b1)(3,4)"),
        // The names a fallback formula reads without binding stay too.
        ("=LET(x1,1,x1)+SUM(D1:D2)", 1, 1, "=LET(x1,1,x1)+SUM(D1:D2)"),
        // A copy up past row 1 is #REF! only for a real reference.
        ("=LET(x1,5,x1+$D1)", -1, 0, "=LET(x1,5,x1+#REF!)"),
    ] {
        let got = shift_formula_internal(formula, dr, dc);
        if got != excel {
            wrong.push(format!("{formula} by ({dr},{dc}): got {got}, Excel holds {excel}"));
        }
    }
    assert!(wrong.is_empty(), "a fill or copy renamed a name spelled like a cell:\n  {}", wrong.join("\n  "));
}

/// Insert/Delete Cells and the Cut+Paste relocation run the same hold.
#[test]
fn insert_delete_cells_and_a_move_never_rename_a_name_spelled_like_a_cell() {
    // B1:C1 deleted, shift up: a band over columns B:C, row 1.
    let up = BandEdit::new(0, 1, 0, 2, CellShift::Up);
    assert_eq!(shift_formula_in_band("=LET(B1,5,B1*2)", "Sheet1", "Sheet1", &up), "=LET(B1,5,B1*2)");
    assert_eq!(shift_formula_in_band("=LET(b1,5,b1+$B$3)", "Sheet1", "Sheet1", &up), "=LET(b1,5,b1+$B$2)");
    let right = BandEdit::new(0, 0, 3, 0, CellShift::Right);
    assert_eq!(shift_formula_in_band("=LET(a1,5,a1*2)", "Sheet1", "Sheet1", &right), "=LET(a1,5,a1*2)");

    // A1:C3 cut and pasted at E5, and a formula carried to another sheet.
    let on_sheet = CellMove { source_sheet: "Sheet1", dest_sheet: "Sheet1", block: (0, 0, 2, 2), delta_row: 4, delta_col: 4 };
    assert_eq!(relocate_references_for_move("=LET(a1,5,a1*2)", "Sheet1", "Sheet1", &on_sheet), "=LET(a1,5,a1*2)");
    assert_eq!(
        relocate_references_for_move("=LET(a1,5,a1+$B$2)", "Sheet1", "Sheet1", &on_sheet),
        "=LET(a1,5,a1+$F$6)",
        "the real reference into the block follows it"
    );
    let off_sheet = CellMove { source_sheet: "Sheet1", dest_sheet: "Sheet2", block: (0, 0, 2, 2), delta_row: 0, delta_col: 0 };
    assert_eq!(
        relocate_references_for_move("=LET(x1,5,x1*2)", "Sheet1", "Sheet2", &off_sheet),
        "=LET(x1,5,x1*2)",
        "a name gains no sheet qualifier when its formula moves sheets"
    );
}

/// The column-range hold of round 20 is unchanged for a formula that declares
/// no cell-shaped name, and in one that does, every plain column range is a
/// pair of names (`=LET(A1,5,D:D)` is `D:(D)` to Excel).
#[test]
fn column_ranges_keep_their_rule_on_both_sides_of_the_fallback() {
    let ins = |f: &str| shift_formula_cols_sheet_aware(f, "Sheet1", "Sheet1", 0, 1);
    assert_eq!(ins("=LET(b,2,SUM(B:B)*b)"), "=LET(b,2,SUM(B:B)*b)");
    assert_eq!(ins("=LET(x,2,SUM(B:B)*x)"), "=LET(x,2,SUM(C:C)*x)");
    assert_eq!(ins("=LET(A1,5,SUM(D:D)+A1)"), "=LET(A1,5,SUM(D:D)+A1)");
    assert_eq!(ins("=LET(A1,5,SUM($D:$D)+A1)"), "=LET(A1,5,SUM($E:$E)+A1)", "an absolute column is a column");
}

/// The names `parser::parse` reads in `formula`, as the hold must see them:
/// every NamedRef spelled like a cell, and both halves of a range of two
/// column-letter names (`D:D` read in R1C1). Uppercased, sorted.
fn names_the_parser_reads(formula: &str) -> Vec<String> {
    fn letters(name: &str) -> bool {
        (1..=3).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphabetic())
    }
    // Letters then digits: a cell spelling, or one past the sheet's edge.
    fn cell_shaped(name: &str) -> bool {
        let letters = name.chars().take_while(|c| c.is_ascii_alphabetic()).count();
        (1..=3).contains(&letters)
            && name.len() > letters
            && name[letters..].chars().all(|c| c.is_ascii_digit())
    }
    fn walk(expr: &Expression, out: &mut Vec<String>) {
        match expr {
            Expression::NamedRef { name, .. } if cell_shaped(name) => out.push(name.to_ascii_uppercase()),
            Expression::Range { sheet, start, end, .. } => {
                if let (Expression::NamedRef { name: a, .. }, Expression::NamedRef { name: b, .. }) =
                    (start.as_ref(), end.as_ref())
                {
                    if letters(a) && letters(b) {
                        out.push(a.to_ascii_uppercase());
                        out.push(b.to_ascii_uppercase());
                        return;
                    }
                    // `Sheet2!A1` is read as the range of the name `A1` with
                    // itself: ONE token (the corpus spells no `Sheet2!A1:A1`).
                    if sheet.is_some() && a == b && parser::parser::is_cell_spelling(a) {
                        out.push(a.to_ascii_uppercase());
                        return;
                    }
                }
                walk(start, out);
                walk(end, out);
            }
            Expression::FunctionCall { args, .. } => args.iter().for_each(|a| walk(a, out)),
            Expression::BinaryOp { left, right, .. } => {
                walk(left, out);
                walk(right, out);
            }
            Expression::UnaryOp { operand, .. } | Expression::ImplicitIntersection { operand } => walk(operand, out),
            Expression::IndexAccess { target, index } => {
                walk(target, out);
                walk(index, out);
            }
            Expression::ArrayLiteral { rows } => rows.iter().flatten().for_each(|e| walk(e, out)),
            Expression::ListLiteral { elements } => elements.iter().for_each(|e| walk(e, out)),
            Expression::DictLiteral { entries } => entries.iter().for_each(|(k, v)| {
                walk(k, out);
                walk(v, out);
            }),
            Expression::SpillRef { cell, .. } => walk(cell, out),
            Expression::Sheet3DRef { reference, .. } => walk(reference, out),
            _ => {}
        }
    }
    let ast = parser::parse(formula).unwrap_or_else(|e| panic!("`{formula}` must parse: {e:?}"));
    let mut out = Vec::new();
    walk(&ast, &mut out);
    out.sort();
    out
}

/// The names the hold takes out of `formula`, in the same shape.
fn names_the_hold_takes(formula: &str) -> Vec<String> {
    let (_, held) = hold_formula_names(formula);
    let mut out: Vec<String> = held
        .iter()
        .flat_map(|h| h.split(':').map(|s| s.to_ascii_uppercase()).collect::<Vec<_>>())
        .collect();
    out.sort();
    out
}

/// THE HOLD AND THE PARSER AGREE, token for token: what the shifters leave
/// alone is exactly what the parser reads as a name, so a shift can never
/// rename a name or leave a reference behind.
#[test]
fn the_held_names_are_the_names_the_parser_reads() {
    let corpus = [
        "=LET(x1,5,x1*2)",
        "=LAMBDA(a1,b1,a1+b1)(3,4)",
        "=LET(X1,5,X1*2)",
        "=LET(A1,5,$D7)",
        "=LET(A1,5,$D$1+A1)",
        "=LET(A1,5,A1+$D1)",
        "=LET(XFD1,5,XFD1*2)",
        "=LET(Q5,2,Q5*3)",
        "=LET(x1,1,x1)+SUM(D1:D2)",
        "=D1+LET(A1,5,A1)",
        "=IF(TRUE,D1,LET(A1,1,A1))",
        "=LET(n,5,LAMBDA(n1,n1+n)(1))+D1",
        "=LET(A1,5,A1+INDEX(T1,1,1))",
        "=LET(A1,5,D:D)",
        "=LET(A1,5,SUM(D:E)+A1)",
        "=LET(A1,5,SUM(Sheet2!D:D)+A1)",
        "=LET(A1,5,SUM($D:$D)+A1)",
        "=LET(A1,5,SUM(Sheet2!D1:D2)+A1)",
        "=LET(A1,5,Sheet2!D1+A1)",
        "=LET(A1,5,SUM('My Sheet'!D1:D2)+A1)",
        "=LET(A1,5,SUM(Sheet1:Sheet3!D1:D2)+A1)",
        "=LET(A1,5,SUM(Sheet1:Sheet3!D1)+A1)",
        "=LET(A1,5,SUM('Jan:Mar'!D1:D2)+A1)",
        "=LET(A1,5,SUM(D1:$D$2)+A1)",
        "=LET(A1,5,SUM($D$1:D2)+A1)",
        "=LET(A1,5,LOG10(100)+A1)",
        "=LET(A1,1E5,A1)",
        "=LET(A1,5,A1&\"B2\")",
        "=LET(A1,SEQUENCE(3),SUM(A1#))",
        "=LET(x1,5,SUM(D1:.D8)+x1)",
        "=LET(A1,5,SUM(5:5)+A1)",
        "=LET(a1,5,b,2,SUM(b:D)+a1)",
        "=LET(A1,5,A1+Tbl[c])",
        "=LET(A1,5,A1+ROWS(Tbl[#All]))",
        "=LET(XFE1,5,XFE1+D1)",
        "=LET(A1048577,5,A1048577+D1)",
        "=LET(b,2,SUM(B:B)*b)",
        "=SUM(A1:A3)+LET(x,1,x)",
    ];
    let mut wrong = Vec::new();
    for formula in corpus {
        let parser_reads = names_the_parser_reads(formula);
        let hold_takes = names_the_hold_takes(formula);
        if parser_reads != hold_takes {
            wrong.push(format!("{formula}: the parser reads {parser_reads:?}, the hold takes {hold_takes:?}"));
        }
    }
    assert!(wrong.is_empty(), "the hold and the parser disagree:\n  {}", wrong.join("\n  "));
}
