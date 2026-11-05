//! FILENAME: app/src-tauri/src/commands/cell_shaped_names_tests.rs
//! PURPOSE: The structural commands, Insert/Delete Cells, the Cut+Paste
//!          relocation and defined names keep a LET / LAMBDA name SPELLED LIKE
//!          A CELL (`x1`, `A1`), and the Name Manager refuses the formulas
//!          Excel refuses.
//! CONTEXT: A `#[path]` child of `structure_cells_tests`, driving the REAL
//!          commands over its `Fx` harness. The pure twin, with Excel's probe
//!          table, is `structure::cell_shaped_name_shift_tests`.
//!
//! [LIVE, Excel 16, 2026-11-05, rev-parse probeA: D1 = 10, D2 = 20,
//! D3:D30 = 1003..1030; F5 =LET(x1,5,x1*2), F6 =LAMBDA(a1,b1,a1+b1)(3,4),
//! F7 =LET(A1,5,RC4) (stored `$D7`), F8 =LET(A1,5,R1C4+A1) (stored
//! `$D$1+A1`), F9 =LET(X1,5,X1*2). Delete row 1: F4..F8 hold the same names,
//! `$D6`, `#REF!+A1`; values 10, 7, 1007, #REF!, 10. Delete columns X then A:
//! `$C6`, values unchanged. Insert row 1: `$C7`, values unchanged.]

use super::*;

fn delete_rows(fx: &Fx, first: u32, count: u32, sheet: Option<usize>) {
    delete_rows_impl(&fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, first, count, sheet)
        .expect("delete rows");
}

fn insert_rows(fx: &Fx, at: u32, count: u32, sheet: Option<usize>) {
    insert_rows_impl(&fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, at, count, sheet)
        .expect("insert rows");
}

fn delete_columns(fx: &Fx, first: u32, count: u32, sheet: Option<usize>) {
    delete_columns_impl(&fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, first, count, sheet)
        .expect("delete columns");
}

fn insert_columns(fx: &Fx, at: u32, count: u32, sheet: Option<usize>) {
    insert_columns_impl(&fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, at, count, sheet)
        .expect("insert columns");
}

/// probeA's sheet: D1 = 10, D2 = 20, D3:D30 = 1003..1030.
fn probe_sheet(fx: &Fx, sheet: usize) {
    fx.put(sheet, "D1", "10");
    fx.put(sheet, "D2", "20");
    for row in 3..=30u32 {
        fx.put(sheet, &format!("D{}", row), &format!("{}", 1000 + row));
    }
}

/// THE REPRODUCTION. Calcula wrote `=LET(#REF!,5,#REF!*2)` (#VALUE!) into F4
/// on the delete of row 1, and renamed every name on the insert.
#[test]
fn delete_and_insert_lines_keep_the_names_and_move_only_the_references() {
    let fx = Fx::new(1);
    probe_sheet(&fx, 0);
    fx.put(0, "F5", "=LET(x1,5,x1*2)");
    fx.put(0, "F6", "=LAMBDA(a1,b1,a1+b1)(3,4)");
    fx.put(0, "F7", "=LET(A1,5,$D7)");
    fx.put(0, "F8", "=LET(A1,5,$D$1+A1)");
    fx.put(0, "F9", "=LET(X1,5,X1*2)");
    fx.settle();
    let names_only = [
        fx.formula(0, "F5").expect("F5"),
        fx.formula(0, "F6").expect("F6"),
        fx.formula(0, "F9").expect("F9"),
    ];
    assert_eq!(fx.number(0, "F5"), 10.0);
    assert_eq!(fx.number(0, "F7"), 1007.0);

    delete_rows(&fx, 0, 1, None);
    fx.settle();
    let after = [fx.formula(0, "F4"), fx.formula(0, "F5"), fx.formula(0, "F8")];
    assert_eq!(
        after.iter().map(|f| f.clone().unwrap_or_default()).collect::<Vec<_>>(),
        names_only.to_vec(),
        "delete row 1: Excel keeps every name"
    );
    assert_eq!(fx.formula(0, "F6").as_deref(), Some("=LET(A1,5,$D6)"));
    assert_eq!(fx.formula(0, "F7").as_deref(), Some("=LET(A1,5,#REF!+A1)"));
    assert_eq!(fx.number(0, "F4"), 10.0, "=LET(x1,5,x1*2) is 10 in Excel");
    assert_eq!(fx.number(0, "F5"), 7.0);
    assert_eq!(fx.number(0, "F6"), 1007.0);
    assert_eq!(fx.number(0, "F8"), 10.0);

    delete_columns(&fx, 23, 1, None); // X
    delete_columns(&fx, 0, 1, None); // A
    fx.settle();
    assert_eq!(fx.formula(0, "E4").unwrap_or_default(), names_only[0], "delete columns X and A");
    assert_eq!(fx.formula(0, "E5").unwrap_or_default(), names_only[1]);
    assert_eq!(fx.formula(0, "E8").unwrap_or_default(), names_only[2]);
    assert_eq!(fx.formula(0, "E6").as_deref(), Some("=LET(A1,5,$C6)"));
    assert_eq!(fx.number(0, "E6"), 1007.0);

    insert_rows(&fx, 0, 1, None);
    insert_columns(&fx, 0, 1, None);
    fx.settle();
    assert_eq!(fx.formula(0, "F5").unwrap_or_default(), names_only[0], "insert row 1 and column A");
    assert_eq!(fx.formula(0, "F6").unwrap_or_default(), names_only[1]);
    assert_eq!(fx.formula(0, "F9").unwrap_or_default(), names_only[2]);
    assert_eq!(fx.formula(0, "F7").as_deref(), Some("=LET(A1,5,$D7)"));
    assert_eq!(fx.number(0, "F5"), 10.0);
    assert_eq!(fx.number(0, "F7"), 1007.0);
}

/// Off the active sheet: Sheet2's own names under an edit of Sheet2 while
/// Sheet1 is in front, and Sheet2's reference INTO Sheet1 under an edit of
/// Sheet1.
#[test]
fn an_edit_of_another_sheet_keeps_the_names_and_moves_its_references() {
    let fx = Fx::new(2);
    probe_sheet(&fx, 0);
    fx.put(1, "B5", "=LET(x1,5,x1*2)");
    fx.put(1, "B6", "=LET(x1,5,x1+Sheet1!$D$5)");
    fx.settle();
    let kept = fx.formula(1, "B5").expect("B5");

    delete_rows(&fx, 0, 1, Some(1)); // Sheet2's row 1, Sheet1 active
    assert_eq!(fx.formula(1, "B4").unwrap_or_default(), kept, "an off-sheet delete renamed the name");
    insert_columns(&fx, 0, 1, Some(1));
    assert_eq!(fx.formula(1, "C4").unwrap_or_default(), kept);

    insert_rows(&fx, 0, 1, None); // Sheet1's row 1: only the qualified reference moves
    fx.settle();
    assert_eq!(fx.formula(1, "C5").as_deref(), Some("=LET(X1,5,X1+SHEET1!$D$6)"));
    assert_eq!(fx.number(1, "C5"), 1010.0, "5 + the 1005 that moved to D6");
}

/// Insert Cells / Delete Cells: the band shifter holds the names too.
#[test]
fn insert_and_delete_cells_keep_the_names() {
    let fx = Fx::new(1);
    fx.put(0, "B3", "7");
    fx.put(0, "E5", "=LET(B1,5,B1*2)");
    fx.put(0, "E6", "=LET(b1,5,b1+$B$3)");
    fx.settle();
    let kept = fx.formula(0, "E5").expect("E5");

    fx.shift("B1:C1", CellShift::Up, false).expect("delete B1:C1, shift up");
    fx.settle();
    assert_eq!(fx.formula(0, "E5").unwrap_or_default(), kept, "Delete Cells over B1 renamed the name B1");
    assert_eq!(fx.number(0, "E5"), 10.0);
    assert_eq!(fx.formula(0, "E6").as_deref(), Some("=LET(B1,5,B1+$B$2)"), "the real reference moved up");
    assert_eq!(fx.number(0, "E6"), 12.0);

    fx.shift("A1:B1", CellShift::Right, false).expect("insert A1:B1, shift right");
    fx.settle();
    assert_eq!(fx.formula(0, "E5").unwrap_or_default(), kept, "Insert Cells over B1 renamed the name B1");
}

/// Cut+Paste: a block cut from under a name spelled like one of its cells.
/// Calcula re-pointed the name `A1` at the block's new place.
#[test]
fn a_cut_and_paste_keeps_the_names() {
    let fx = Fx::new(1);
    fx.put(0, "A1", "3");
    fx.put(0, "H1", "=LET(A1,5,A1*2)");
    fx.put(0, "H2", "=LET(A1,5,A1+$A$1)");
    fx.settle();
    let kept = fx.formula(0, "H1").expect("H1");
    // The frontend moves the cell, then asks for the relocation.
    let moved = fx.cell(0, "A1").expect("A1");
    {
        let seed = crate::document_effect::test_seed_effect();
        fx.state.grids.write(&seed).unwrap()[0].clear_cell(0, 0);
        fx.state.grid.write(&seed).unwrap().clear_cell(0, 0);
        fx.state.grids.write(&seed).unwrap()[0].set_cell(4, 2, moved.clone());
        fx.state.grid.write(&seed).unwrap().set_cell(4, 2, moved);
    }
    crate::commands::structure::relocate_cell_references_core(
        &fx.state, &fx.file, &fx.files, &fx.pivots, &fx.pane, &fx.filters, 0, 0, 0, 0, 4, 2, None,
    )
    .expect("the relocation runs");
    assert_eq!(fx.formula(0, "H1").unwrap_or_default(), kept, "the cut re-pointed the name A1");
    assert_eq!(fx.formula(0, "H2").as_deref(), Some("=LET(A1,5,A1+$C$5)"), "the real reference follows the block");
}

/// Defined names, workbook- and sheet-scoped, as a LOADED workbook holds them
/// (Excel opens such a file; only its entry refuses them).
#[test]
fn a_defined_name_keeps_its_names_through_a_structural_edit() {
    let fx = Fx::new(1);
    probe_sheet(&fx, 0);
    {
        let seed = crate::document_effect::test_seed_effect();
        let mut names = fx.state.named_ranges.write(&seed).unwrap();
        for (name, scope, refers_to) in [
            ("DBL", None, "=LAMBDA(a1,a1+Sheet1!$D$5)"),
            ("LETN", Some(0usize), "=LET(x1,5,x1+$D$5)"),
        ] {
            names.insert(
                identity::defined_name_key(name),
                crate::named_ranges::NamedRange {
                    name: name.to_string(),
                    sheet_index: scope,
                    refers_to: refers_to.to_string(),
                    comment: None,
                    folder: None,
                },
            );
        }
    }
    insert_rows(&fx, 0, 1, None);
    delete_columns(&fx, 0, 1, None);
    let names = fx.state.named_ranges.read().unwrap();
    assert_eq!(names[&identity::defined_name_key("DBL")].refers_to, "=LAMBDA(a1,a1+Sheet1!$C$6)");
    assert_eq!(names[&identity::defined_name_key("LETN")].refers_to, "=LET(x1,5,x1+$C$6)");
}

/// rev-parse-4: the Name Manager refuses what Excel refuses [LIVE, Excel 16,
/// probes B and G], before any effect, and takes `=LAMBDA(x,x*2)`.
#[test]
fn the_name_manager_refuses_a_cell_shaped_let_or_lambda_name() {
    let fx = Fx::new(1);
    for (name, refers_to) in [
        ("DBL", "=LAMBDA(a1,a1*2)"),
        ("DBLD", "=LAMBDA(a1,a1+D1)"),
        ("DBLA", "=LAMBDA(a1,a1+Sheet1!$D$1)"),
        ("LETN", "=LET(a1,5,a1+Sheet1!$D$1)"),
        ("LETR", "=LET(a1,5,a1+R1C4)"),
    ] {
        let made = crate::named_ranges::create_named_range_impl(
            &fx.state, &fx.file, name.to_string(), None, refers_to.to_string(), None, None,
        );
        assert!(!made.success, "{name} = {refers_to} was defined; Excel refuses it");
        assert!(
            made.error.as_deref().unwrap_or_default().starts_with("There's a problem with this formula."),
            "Excel's message: {:?}",
            made.error
        );
        assert!(!fx.file.is_dirty(), "a refused name dirtied the workbook");
        assert!(!fx.state.named_ranges.read().unwrap().contains_key(&identity::defined_name_key(name)));
    }

    let made = crate::named_ranges::create_named_range_impl(
        &fx.state, &fx.file, "DBX".to_string(), None, "=LAMBDA(x,x*2)".to_string(), None, None,
    );
    assert!(made.success, "Excel takes =LAMBDA(x,x*2): {:?}", made.error);
    fx.mark_clean();

    let edited = crate::named_ranges::update_named_range_core(
        &fx.state, &fx.file, &fx.files, &fx.pivots, &fx.pane, &fx.filters,
        "DBX".to_string(), None, "=LAMBDA(a1,a1*2)".to_string(), None, None,
    );
    assert!(!edited.success, "the edit to =LAMBDA(a1,a1*2) was taken; Excel refuses it");
    assert!(edited.error.as_deref().unwrap_or_default().starts_with("There's a problem with this formula."));
    assert!(!fx.file.is_dirty(), "a refused edit dirtied the workbook");
    assert_eq!(
        fx.state.named_ranges.read().unwrap()[&identity::defined_name_key("DBX")].refers_to,
        "=LAMBDA(x,x*2)",
        "the refused edit changed the name"
    );
}
