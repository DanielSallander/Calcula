//! FILENAME: core/persistence/src/xlsx_formula_text_names_tests.rs
//! PURPOSE: A NAME spelled like a cell (`'D5'`) and an implicit intersection
//!          of a deleted sheet's reference (`@#REF!A1:A3`) through the .xlsx
//!          file text, both directions, unit and real path.
//! CONTEXT: A `#[path]` child of `xlsx_formula_text`.
//!
//! [LIVE, Excel 16, 2026-11-06, lane xlsx probe3 + verify-formula p1.json]
//! `=R[-1]C+D5` in J298 shows `=J297+'D5'` (#NAME?) and is saved
//! `J297+_xlnm.D5` (dynamic, `cm="1"`); `=SUM(R[-1]C:D5)` in J306 is saved
//! `SUM(J305:_xlnm.D5)`; `=R[-1]C+Sheet2!D5` in J10 shows `=J9+Sheet2!'D5'`
//! and is saved `J9+Sheet2!_xlnm.D5`. After its sheet is deleted,
//! `=SUM(@Gone!A1:A3)+1` shows `=SUM(@#REF!A1:A3)+1`, saved
//! `SUM(_xlfn.SINGLE(#REF!))+1`, and `=@Gone!A1` `_xlfn.SINGLE(#REF!)`.

use super::*;
use crate::{SavedCell, SavedCellValue, Sheet, Workbook};
use std::io::Read;

/// The writer spells a quoted cell-shaped name as Excel's `_xlnm.`, behind a
/// sheet too, and leaves a quoted SHEET alone.
///
/// SABOTAGE (xlsx-xlnmw): `mark_quoted_cell_names` returns at once; the first
/// row then keeps `'D5'`, a text Excel refuses.
#[test]
fn a_quoted_cell_shaped_name_is_written_as_excels_xlnm() {
    for (calcula, excel) in [
        ("=J297+'D5'", "J297+_xlnm.D5"),
        ("=SUM(J305:'D5')", "SUM(J305:_xlnm.D5)"),
        // (A bare sheet name comes back in the lexer's case, as for any
        // formula re-rendered; Excel matches sheet names ignoring case.)
        ("=J9+Sheet2!'D5'", "J9+SHEET2!_xlnm.D5"),
        ("='My Sheet'!A1+'D5'", "'My Sheet'!A1+_xlnm.D5"),
        ("=SUM(Sheet1:'Sheet 2'!A1)", "SUM(Sheet1:'Sheet 2'!A1)"),
        ("=SUM('A 1':'B 2'!A1)", "SUM('A 1':'B 2'!A1)"),
        ("='D5'!A1", "'D5'!A1"),
    ] {
        assert_eq!(excel_formula_text(calcula, Some((297, 9))), excel, "for {}", calcula);
    }
}

/// The reader turns Excel's `_xlnm.D5` back into the NAME, quoted, where the
/// formula declares no cell-shaped parameter; bare where it does (Calcula
/// reads that formula in R1C1, where a bare `D5` is a name).
///
/// SABOTAGE (xlsx-xlnmr): the `_xlnm.` arm writes `rest` bare (not
/// `'{}'`); the first row then reads back as the CELL D5.
#[test]
fn excels_xlnm_reads_back_as_the_name() {
    for (file, calcula) in [
        ("J297+_xlnm.D5", "J297+'D5'"),
        ("SUM(J305:_xlnm.D5)", "SUM(J305:'D5')"),
        ("J9+Sheet2!_xlnm.D5", "J9+Sheet2!'D5'"),
        ("_xlfn.LET(_xlpm.E5,_xlnm.E5+1,_xlpm.E5)", "LET(E5,E5+1,E5)"),
        ("_xlfn.LET(_xlpm.E5,2,SUM(_xlpm.E5:_xlnm.E6))", "LET(E5,2,SUM(E5:E6))"),
        ("_xlfn.LET(_xlpm.a,_xlnm.A1,SUM(_xlpm.a:J:J))", "LET(a,A1,SUM(a:J:J))"),
        ("_xlfn.LET(_xlpm.A1,1,_xlfn.ANCHORARRAY(_xlnm.B1))", "LET(A1,1,B1#)"),
    ] {
        assert_eq!(calcula_formula_text(file), calcula, "for {}", file);
    }
    // And the text parses as Excel shows it: the NAME, never the cell.
    let tree = parser::parse("=J297+'D5'").expect("parses");
    assert!(
        matches!(&tree, parser::ast::Expression::BinaryOp { right, .. } if matches!(right.as_ref(), parser::ast::Expression::NamedRef { .. })),
        "{:?}",
        tree
    );
}

/// `@` of a reference whose sheet was deleted: Excel's `SINGLE(#REF!)` is
/// Calcula's `@#REF!`, and Calcula's `@#REF!A1:A3` leaves as `SINGLE(#REF!)`.
///
/// SABOTAGE (xlsx-refsingle): drop the `#REF!` arm of
/// `intersection_operand`; the reader then keeps `SINGLE(#REF!)`, a function
/// Calcula does not have.
#[test]
fn an_intersection_of_a_deleted_sheets_reference_reads_as_excel_shows_it() {
    assert_eq!(calcula_formula_text("SUM(_xlfn.SINGLE(#REF!))+1"), "SUM(@#REF!)+1");
    assert_eq!(calcula_formula_text("_xlfn.SINGLE(#REF!)"), "@#REF!");
    assert_eq!(excel_formula_text("=SUM(@#REF!A1:A3)+1", Some((10, 13))), "SUM(SINGLE(#REF!))+1");
    assert_eq!(excel_formula_text("=@#REF!A1", Some((12, 13))), "SINGLE(#REF!)");
    assert_eq!(excel_formula_text("=@#REF!$A$1:$A$3", Some((12, 13))), "SINGLE(#REF!)");
}

fn sheet_xml(path: &std::path::Path) -> String {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut xml = String::new();
    archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut xml).unwrap();
    xml
}

/// The real path, both directions: Calcula's `=R[-1]C+D5` (stored
/// `J297+'D5'`) is saved as Excel saves it and loads back as the same name,
/// and Excel's own `<f>` texts load as the formula Excel shows.
///
/// SABOTAGE (xlsx-collapse, engine): `collapse_formula_text` renders bare
/// again -- the file then reads `J297+D5`, the cell.
#[test]
fn a_name_spelled_like_a_cell_round_trips_through_a_real_xlsx() {
    let mut wb = Workbook::new();
    wb.sheets.clear();
    let mut sheet = Sheet::new("Sheet1".to_string());
    // What typing `=R[-1]C+D5` in J298 / `=SUM(R[-1]C:D5)` in J306 stores.
    let stored = [(297u32, "=J297+'D5'"), (305u32, "=SUM(J305:'D5')")];
    for &(row, formula) in &stored {
        let mut cell = SavedCell::from_cell(&engine::Cell::new_formula(formula.to_string()));
        assert_eq!(cell.formula.as_deref(), Some(&formula[1..]), "the stored text quotes the name");
        cell.value = SavedCellValue::Error("#NAME?".to_string());
        sheet.cells.insert((row, 9), cell);
    }
    wb.sheets.push(sheet);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("names.xlsx");
    crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    let xml = sheet_xml(&path);
    assert!(xml.contains(">J297+_xlnm.D5</f>"), "{}", xml);
    assert!(xml.contains(">SUM(J305:_xlnm.D5)</f>"), "{}", xml);
    // Excel's own flag for the bare name at the top: dynamic.
    assert!(xml.contains("<c r=\"J298\" cm=\"1\" t=\"e\"><f t=\"array\" ref=\"J298\">"), "{}", xml);
    let back = crate::load_xlsx(&path).unwrap();
    let cells = &back.sheets[0].cells;
    assert_eq!(cells[&(297, 9)].formula.as_deref(), Some("=J297+'D5'"));
    assert_eq!(cells[&(305, 9)].formula.as_deref(), Some("=SUM(J305:'D5')"));
    // ...and the loaded cell is the NAME (#NAME?), not a sum of two cells.
    let loaded = cells[&(297, 9)].to_cell();
    assert_eq!(loaded.formula_string().as_deref(), Some("J297+'D5'"));
}

/// A DEFINED NAME holding a spill or an implicit intersection of a sheetless
/// reference survives Calcula's own round trip: the writer spells the
/// reference as the using sheet's (`!A1`, `excel_name_formula_text`), so the
/// file reads `ANCHORARRAY(!A1)` / `SINGLE(!A1:A3)`, and the reader takes the
/// `!` as part of that reference (it was left as a call, `ANCHORARRAY(A1)`,
/// and a grouped `@(A1:A3)`).
///
/// SABOTAGE (tabxlsx-namespill): the ANCHORARRAY / SINGLE arms of
/// `calcula_cell_formula_text` start the operand at `open + 1` again.
#[test]
fn a_defined_names_sheetless_spill_and_intersection_round_trip() {
    let none = DefinedNames::default();
    for (name, file, back) in [
        ("=SUM(A1#)", "SUM(ANCHORARRAY(!A1))", "SUM(A1#)"),
        ("=A1#", "ANCHORARRAY(!A1)", "A1#"),
        ("=SUM(@A1:A3)", "SUM(SINGLE(!A1:A3))", "SUM(@A1:A3)"),
        ("=@$B$2", "SINGLE(!$B$2)", "@$B$2"),
        ("=ROWS(Sheet1!A1#)", "ROWS(ANCHORARRAY(Sheet1!A1))", "ROWS(Sheet1!A1#)"),
    ] {
        let written = excel_name_formula_text(name, &none);
        assert_eq!(written, file, "written for {}", name);
        let escaped = escape_future_functions(&written);
        assert_eq!(calcula_formula_text(&escaped), back, "read back from {}", escaped);
    }
}
