//! FILENAME: core/persistence/src/xlsx_dynamic_formula_legacy_tests.rs
//! PURPOSE: A LEGACY formula (an .xlsx `<f>` with no `cm`) is read with the
//!          implicit intersection Excel puts in it (BUG-0645 item 4).
//! CONTEXT: A `#[path]` child of `xlsx_dynamic_formula`.
//!
//! [LIVE, Excel 16, 2026-11-06, lane xlsx probe1.ps1 / probe2.ps1] Each row:
//! the text set with `Range.Formula` (a legacy formula) in a fresh workbook
//! beside A1:A5 = 1..5, B1:B5 = 10..50, C1:C3 = t1..t3, D1 = 2 and `MyR` =
//! `Sheet1!$A$1:$A$3`, and `Range.Formula2` read back: Excel's own reading.

use super::*;

/// (legacy text, Excel 16's `Formula2` of it)
const EXCEL: &[(&str, &str)] = &[
    ("A1:A5", "@A1:A5"),
    ("A1:A3+1", "@A1:A3+1"),
    ("SUM(A1:A3*2)", "SUM(@A1:A3*2)"),
    ("SUM(LEN(C1:C3))", "SUM(LEN(@C1:C3))"),
    ("ABS(A1:A3)", "ABS(@A1:A3)"),
    ("INDEX(A1:A5,D1)", "@INDEX(A1:A5,D1)"),
    ("ABS(INDEX(A1:A5,D1))", "ABS(@INDEX(A1:A5,D1))"),
    ("IF(A1>0,A1:A3,B1:B3)", "@IF(A1>0,A1:A3,B1:B3)"),
    ("IF(A1:A3>0,1,2)", "IF(@A1:A3>0,1,2)"),
    ("ABS({1,-2})", "ABS(@{1,-2})"),
    ("{1,2,3}", "@{1,2,3}"),
    ("-A1:A3", "-@A1:A3"),
    ("A1:A3&\"x\"", "@A1:A3&\"x\""),
    ("VLOOKUP(A1:A3,A1:B5,2,FALSE)", "VLOOKUP(@A1:A3,A1:B5,2,FALSE)"),
    ("SUMPRODUCT(A1:A3*B1:B3)", "SUMPRODUCT(A1:A3*B1:B3)"),
    ("MyR", "@MyR"),
    ("MyR+1", "@MyR+1"),
    ("SUM(MyR)", "SUM(MyR)"),
    ("TRANSPOSE(A1:A3)", "@TRANSPOSE(@A1:A3)"),
    ("MMULT({1,2},{3;4})", "@MMULT({1,2},{3;4})"),
    ("OFFSET(A1,0,0,3)", "@OFFSET(A1,0,0,3)"),
    ("SUM(OFFSET(A1,0,0,3))", "SUM(OFFSET(A1,0,0,3))"),
    ("INDIRECT(\"A1:A3\")", "@INDIRECT(\"A1:A3\")"),
    ("ROW(A1:A3)", "@ROW(A1:A3)"),
    ("SUM(ROW(A1:A3))", "SUM(@ROW(A1:A3))"),
    ("A1:A3*B1:B3", "@A1:A3*@B1:B3"),
    ("LEN(A1:A3)+1", "LEN(@A1:A3)+1"),
    ("COUNTIF(A1:A5,A1:A3)", "COUNTIF(A1:A5,@A1:A3)"),
    ("SUM(IF(A1:A3>1,1,0))", "SUM(IF(@A1:A3>1,1,0))"),
    ("Sheet2!A1:A3", "@Sheet2!A1:A3"),
    ("SUM(A1:A3,B1:B3)", "SUM(A1:A3,B1:B3)"),
    ("AND(A1:A3>0)", "AND(@A1:A3>0)"),
    ("MAX(ABS(A1:A3))", "MAX(ABS(@A1:A3))"),
    ("TEXTJOIN(\",\",TRUE,A1:A3)", "TEXTJOIN(\",\",TRUE,A1:A3)"),
    ("CELL(\"address\",A1:A3)", "@CELL(\"address\",A1:A3)"),
    ("FILTER(A1:A5,A1:A5>1)", "@FILTER(A1:A5,A1:A5>1)"),
    ("SEQUENCE(3)", "@SEQUENCE(3)"),
    ("ISNUMBER(A1:A3)", "ISNUMBER(@A1:A3)"),
    ("N(A1:A3)", "N(A1:A3)"),
    ("A1", "A1"),
    ("SUM(A1:A3)", "SUM(A1:A3)"),
    ("INDEX(A1:A5,2)", "INDEX(A1:A5,2)"),
    ("CHOOSE(1,A1:A3,B1:B3)", "@CHOOSE(1,A1:A3,B1:B3)"),
    ("-{1,2}", "-@{1,2}"),
    ("A1:A3=1", "@A1:A3=1"),
    ("(A1:A3)", "(@A1:A3)"),
    ("+A1:A3", "+@A1:A3"),
    ("A1:A3%", "@A1:A3%"),
    ("XLOOKUP(1,A1:A5,B1:B5)", "XLOOKUP(1,A1:A5,B1:B5)"),
    ("ROWS(A1:A3)", "ROWS(A1:A3)"),
    ("A:A", "@A:A"),
    ("1:1", "@1:1"),
    ("ABS(A1:A3)+B1:B3", "ABS(@A1:A3)+@B1:B3"),
    ("IFERROR(A1:A3,0)", "IFERROR(@A1:A3,0)"),
    ("SUM(A1:A3)+A1:A3", "SUM(A1:A3)+@A1:A3"),
    ("INDEX(A1:B5,2,0)", "@INDEX(A1:B5,2,0)"),
    ("ABS(MyR)", "ABS(@MyR)"),
    ("ABS(-A1:A3)", "ABS(-@A1:A3)"),
    ("SUM(-A1:A3)", "SUM(-@A1:A3)"),
    ("ABS((A1:A3))", "ABS((@A1:A3))"),
    ("LEN(TRANSPOSE(A1:A3))", "LEN(@TRANSPOSE(@A1:A3))"),
    ("SUM(LEN(TRANSPOSE(A1:A3)))", "SUM(LEN(TRANSPOSE(@A1:A3)))"),
    ("A1:A3 A2:B2", "@A1:A3 A2:B2"),
    ("ABS(A1:A3 A2:B2)", "ABS(@A1:A3 A2:B2)"),
    ("Sheet1:Sheet2!A1", "@Sheet1:Sheet2!A1"),
    ("SUM(Sheet1:Sheet2!A1)", "SUM(Sheet1:Sheet2!A1)"),
    ("EDATE(A1:A3,1)", "EDATE(A1:A3,1)"),
    ("ABS(IF(A1>0,A1:A3,0))", "ABS(@IF(A1>0,A1:A3,0))"),
    ("IF(A1>0,A1:A3)+1", "@IF(A1>0,A1:A3)+1"),
    ("SUMPRODUCT(LEN(A1:A3))", "SUMPRODUCT(LEN(A1:A3))"),
    ("SUMPRODUCT(ABS(INDEX(A1:A5,D1)))", "SUMPRODUCT(ABS(INDEX(A1:A5,D1)))"),
    ("SUMPRODUCT(ROW(A1:A3))", "SUMPRODUCT(ROW(A1:A3))"),
    ("MMULT(A1:A3*1,{1})", "@MMULT(A1:A3*1,{1})"),
    ("CORREL(A1:A3*1,B1:B3)", "CORREL(A1:A3*1,B1:B3)"),
    ("SUM(A1:A3*B1:B3)", "SUM(@A1:A3*@B1:B3)"),
    ("MAX(A1:A3*2)", "MAX(@A1:A3*2)"),
    ("COUNT(A1:A3*1)", "COUNT(@A1:A3*1)"),
    ("LOOKUP(2,A1:A3*1)", "LOOKUP(2,A1:A3*1)"),
    ("INDEX(A1:A3*2,1)", "@INDEX(A1:A3*2,1)"),
    ("MATCH(1,A1:A3*1,0)", "MATCH(1,@A1:A3*1,0)"),
    ("FREQUENCY(A1:A3,B1:B3)", "@FREQUENCY(A1:A3,B1:B3)"),
    ("TRANSPOSE(A1:A3*2)", "@TRANSPOSE(@A1:A3*2)"),
    ("COLUMN(A1:C1)", "@COLUMN(A1:C1)"),
    ("SUM(COLUMN(A1:C1))", "SUM(@COLUMN(A1:C1))"),
    ("ABS(ROW(A1))", "ABS(ROW(A1))"),
    ("SUM(INDEX(A1:A5,D1))", "SUM(INDEX(A1:A5,D1))"),
    ("SUM(IF(A1>0,A1:A3,0))", "SUM(IF(A1>0,A1:A3,0))"),
    ("COUNTIF(A1:A5,\">\"&A1:A3)", "COUNTIF(A1:A5,\">\"&@A1:A3)"),
    ("SUMIF(A1:A5,A1:A3)", "SUMIF(A1:A5,@A1:A3)"),
    ("AVERAGE(A1:A3+B1:B3)", "AVERAGE(@A1:A3+@B1:B3)"),
    ("SUM(A1:A3,B1:B3*2)", "SUM(A1:A3,@B1:B3*2)"),
    ("CONCATENATE(A1:A3)", "CONCATENATE(@A1:A3)"),
    ("TEXT(A1:A3,\"0\")", "TEXT(@A1:A3,\"0\")"),
    ("SUM(--(A1:A3>1))", "SUM(--(@A1:A3>1))"),
    ("MIN(IF(A1:A3>1,A1:A3))", "MIN(IF(@A1:A3>1,A1:A3))"),
    ("LARGE(A1:A3*1,1)", "LARGE(@A1:A3*1,1)"),
    ("SMALL(A1:A3,{1,2})", "SMALL(A1:A3,@{1,2})"),
    ("MEDIAN(A1:A3*1)", "MEDIAN(@A1:A3*1)"),
    ("INDEX(A1:A5,MATCH(1,A1:A5,0))", "INDEX(A1:A5,MATCH(1,A1:A5,0))"),
    ("SUM(MyR*2)", "SUM(@MyR*2)"),
    ("SUMPRODUCT(MyR)", "SUMPRODUCT(MyR)"),
    ("TRANSPOSE(TRANSPOSE(A1:A3))", "@TRANSPOSE(TRANSPOSE(@A1:A3))"),
    ("MMULT(TRANSPOSE(A1:A3),A1:A3)", "@MMULT(TRANSPOSE(@A1:A3),A1:A3)"),
    ("SUM(MMULT(TRANSPOSE(A1:A3),A1:A3))", "SUM(MMULT(TRANSPOSE(@A1:A3),A1:A3))"),
    ("N(TRANSPOSE(A1:A3))", "N(@TRANSPOSE(@A1:A3))"),
    ("SUM(SEQUENCE(3))", "SUM(SEQUENCE(3))"),
    ("ABS(SEQUENCE(3))", "ABS(@SEQUENCE(3))"),
    ("SUM(ABS(SEQUENCE(3)))", "SUM(ABS(SEQUENCE(3)))"),
    ("SUM(FILTER(A1:A5,A1:A5>1))", "SUM(FILTER(A1:A5,A1:A5>1))"),
    ("SUM(ROW(A1:A3)*1)", "SUM(@ROW(A1:A3)*1)"),
    ("ROW(A1:A3)+1", "@ROW(A1:A3)+1"),
    ("SUM(OFFSET(A1,0,0,3)*1)", "SUM(@OFFSET(A1,0,0,3)*1)"),
    ("LEN(OFFSET(A1,0,0,3))", "LEN(@OFFSET(A1,0,0,3))"),
    ("SUM(LEN(OFFSET(A1,0,0,3)))", "SUM(LEN(@OFFSET(A1,0,0,3)))"),
    ("MAX(LEN(A1:A3))", "MAX(LEN(@A1:A3))"),
    ("SUMIFS(B1:B5,A1:A5,A1:A3)", "SUMIFS(B1:B5,A1:A5,@A1:A3)"),
    ("INDEX(A1:A5,ROW(A1:A2))", "@INDEX(A1:A5,@ROW(A1:A2))"),
    ("SUM(INDEX(A1:A5,ROW(A1:A2)))", "SUM(INDEX(A1:A5,@ROW(A1:A2)))"),
    ("VLOOKUP(A1,A1:B5,{1,2},FALSE)", "VLOOKUP(A1,A1:B5,@{1,2},FALSE)"),
    ("SUM(VLOOKUP(A1,A1:B5,{1,2},FALSE))", "SUM(VLOOKUP(A1,A1:B5,@{1,2},FALSE))"),
    ("CHOOSE({1,2},A1,B1)", "@CHOOSE({1,2},A1,B1)"),
    ("IF({1,0},A1,B1)", "@IF({1,0},A1,B1)"),
    ("A1:A3>{1;2;3}", "@A1:A3>@{1;2;3}"),
    ("AND(A1:A3)", "AND(A1:A3)"),
    ("OR(A1:A3=1)", "OR(@A1:A3=1)"),
    ("SUM(1/A1:A3)", "SUM(1/@A1:A3)"),
    ("XLOOKUP(A1:A3,A1:A5,B1:B5)", "XLOOKUP(@A1:A3,A1:A5,B1:B5)"),
    ("SUM(XLOOKUP(1,A1:A5,B1:B5))", "SUM(XLOOKUP(1,A1:A5,B1:B5))"),
    ("ABS(XLOOKUP(1,A1:A5,B1:B5))", "ABS(XLOOKUP(1,A1:A5,B1:B5))"),
    ("XLOOKUP(1,A1:A5,B1:B5)+1", "XLOOKUP(1,A1:A5,B1:B5)+1"),
    ("SUM(ABS(A1:A3)*2)", "SUM(ABS(@A1:A3)*2)"),
    ("ABS(SUM(A1:A3*2))", "ABS(SUM(@A1:A3*2))"),
    ("IF(A1>0,SUM(A1:A3*2),0)", "IF(A1>0,SUM(@A1:A3*2),0)"),
    ("SUM(IF(A1>0,ABS(A1:A3),0))", "SUM(IF(A1>0,ABS(@A1:A3),0))"),
    ("SUMPRODUCT(IF(A1:A3>1,1,0))", "SUMPRODUCT(IF(@A1:A3>1,1,0))"),
    ("SUMPRODUCT(SUM(A1:A3*2))", "SUMPRODUCT(SUM(A1:A3*2))"),
    ("SUMPRODUCT(ABS(TRANSPOSE(A1:A3)))", "SUMPRODUCT(ABS(TRANSPOSE(@A1:A3)))"),
    ("ROWS(TRANSPOSE(A1:A3))", "ROWS(TRANSPOSE(@A1:A3))"),
    ("ABS(MMULT({1,2},{3;4}))", "ABS(@MMULT({1,2},{3;4}))"),
    ("SUM(MMULT({1,2},{3;4}))", "SUM(MMULT({1,2},{3;4}))"),
    ("SUM(ABS(MMULT({1,2},{3;4})))", "SUM(ABS(MMULT({1,2},{3;4})))"),
    ("SUM(TRANSPOSE(A1:A3))", "SUM(TRANSPOSE(@A1:A3))"),
    ("SUM(A1:A3 A2:B2)", "SUM(A1:A3 A2:B2)"),
    ("SUM(ABS(INDEX(A1:A5,D1)))", "SUM(ABS(@INDEX(A1:A5,D1)))"),
    ("SUM(OFFSET(A1:A3,0,0))", "SUM(OFFSET(A1:A3,0,0))"),
    ("SUM(ABS(OFFSET(A1,0,0,3)))", "SUM(ABS(@OFFSET(A1,0,0,3)))"),
    ("SUM(INDIRECT(\"A1:A3\"))", "SUM(INDIRECT(\"A1:A3\"))"),
    ("ABS(SUM(LEN(A1:A3)))", "ABS(SUM(LEN(@A1:A3)))"),
    ("INDEX(MyR,D1)", "@INDEX(MyR,D1)"),
    ("MyR*MyR", "@MyR*@MyR"),
    ("ABS(A1:A3 A2)", "ABS(A1:A3 A2)"),
    ("ABS(Sheet1:Sheet2!A1)", "ABS(@Sheet1:Sheet2!A1)"),
    ("SUM(ABS(Sheet1:Sheet2!A1))", "SUM(ABS(@Sheet1:Sheet2!A1))"),
    ("SUM(Sheet2!A1:A3*2)", "SUM(@Sheet2!A1:A3*2)"),
    ("SUM({1,2}*2)", "SUM({1,2}*2)"),
    ("SUM(ABS({1,-2}))", "SUM(ABS({1,-2}))"),
    ("ABS({1,-2}+1)", "ABS(@{1,-2}+1)"),
    ("{1,2}+A1:A2", "@{1,2}+@A1:A2"),
    ("LEN(C1:C3)&\"x\"", "LEN(@C1:C3)&\"x\""),
    ("COUNTIFS(A1:A5,A1:A3)", "COUNTIFS(A1:A5,@A1:A3)"),
    ("SUM(COLUMN(A1:C1)*1)", "SUM(@COLUMN(A1:C1)*1)"),
    ("COLUMN(A1:C1)*1", "@COLUMN(A1:C1)*1"),
    ("SUM(INDEX(A1:B5,0,1))", "SUM(INDEX(A1:B5,0,1))"),
    ("SUM(INDEX(A1:B5,0,1)*1)", "SUM(@INDEX(A1:B5,0,1)*1)"),
    ("ISERROR(A1:A3)", "ISERROR(@A1:A3)"),
    ("SUM(ISERROR(A1:A3)*1)", "SUM(ISERROR(@A1:A3)*1)"),
    ("SUM(N(A1:A3))", "SUM(N(A1:A3))"),
    ("ABS(N(A1:A3))", "ABS(N(A1:A3))"),
    ("SUM(T(C1:C3)&\"x\")", "SUM(T(C1:C3)&\"x\")"),
    ("SUM(LEN(C1:C3),A1:A3)", "SUM(LEN(@C1:C3),A1:A3)"),
    ("MAX(A1:A3,B1:B3*1)", "MAX(A1:A3,@B1:B3*1)"),
    ("SUM(SUM(A1:A3*2))", "SUM(SUM(@A1:A3*2))"),
    ("SUM(ABS(SUM(A1:A3*2)))", "SUM(ABS(SUM(@A1:A3*2)))"),
];

/// Rows where Calcula's reading is knowingly not Excel's: an array constant
/// in a lifted parameter inside a parameter taken whole (Excel intersects it,
/// Calcula reads it dynamic), and Excel's `@A1:A3 A2:B2` -- `@` of the whole
/// intersection, which Calcula spells `@(A1:A3 A2:B2)` and its parser reads
/// `@A1:A3 A2:B2` as the intersection of `@A1:A3` (so the DISPLAYED text is
/// compared by meaning, below).
const KNOWN: &[&str] = &["SUM(VLOOKUP(A1,A1:B5,{1,2},FALSE))"];

fn shapes() -> NameShapes {
    let mut wb = crate::Workbook::new();
    wb.named_ranges.push(crate::SavedNamedRange {
        name: "MyR".to_string(),
        refers_to: "=Sheet1!$A$1:$A$3".to_string(),
        sheet_id: None,
        comment: None,
        folder: None,
    });
    NameShapes::of(&wb)
}

fn canonical(text: &str) -> String {
    engine::ast_render::render_formula_raw(&parser::parse(text).unwrap_or_else(|e| panic!("{} does not parse: {:?}", text, e)))
}

/// Every probed legacy formula reads as Excel shows it.
///
/// SABOTAGE (xlsx-legacy): `legacy_formula_text` returns `None`; every row
/// with an `@` then fails.
#[test]
fn a_legacy_formula_reads_as_excel_shows_it() {
    let names = shapes();
    let mut wrong = Vec::new();
    for &(legacy, excel) in EXCEL {
        if KNOWN.contains(&legacy) {
            continue;
        }
        let ours = legacy_formula_text(legacy, &names).unwrap_or_else(|| canonical(legacy));
        // Excel's `@A1:A3 A2:B2` is `@` of the whole intersection.
        let excel = excel.replace("@A1:A3 A2:B2", "@(A1:A3 A2:B2)");
        if canonical(&ours) != canonical(&excel) {
            wrong.push(format!("{}  ours {}  excel {}", legacy, ours, excel));
        }
    }
    assert!(wrong.is_empty(), "{} of {} rows read otherwise than Excel:\n{}", wrong.len(), EXCEL.len(), wrong.join("\n"));
}

/// A formula Excel saves plain reads the same either way and is never
/// touched, so a Calcula export's own plain formulas come back as written.
#[test]
fn a_formula_excel_saves_plain_is_left_as_written() {
    let names = shapes();
    for plain in ["SUM(A1:A3)", "A1+B2", "INDEX(A1:A5,2)", "SUMPRODUCT(A1:A3*B1:B3)", "sum( A1:A3 )"] {
        assert_eq!(legacy_formula_text(plain, &names), None, "{}", plain);
    }
}

/// One worksheet part of an .xlsx rewritten by `edit`, the rest copied.
fn rewrite_sheet(path: &std::path::Path, edit: impl Fn(&str) -> String) {
    use std::io::{Read, Write};
    let bytes = std::fs::read(path).unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let name = entry.name().to_string();
        if name == "xl/worksheets/sheet1.xml" {
            let mut xml = String::new();
            entry.read_to_string(&mut xml).unwrap();
            drop(entry);
            out.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            out.write_all(edit(&xml).as_bytes()).unwrap();
        } else {
            out.raw_copy_file(entry).unwrap();
        }
    }
    std::fs::write(path, out.finish().unwrap().into_inner()).unwrap();
}

/// The real path: a legacy `<f>` (no `cm`) loads with Excel's `@`, the same
/// text written dynamic (`cm="1"`, `t="array"`) loads as written.
///
/// SABOTAGE (xlsx-legacyread): the `"f"` arm of the sheet-XML walk records
/// nothing; `=A1:A5` then loads spilling.
#[test]
fn a_legacy_cell_formula_loads_with_its_implicit_intersection() {
    let mut wb = crate::Workbook::new();
    wb.sheets.clear();
    let mut sheet = crate::Sheet::new("Sheet1".to_string());
    for (row, formula) in [(0u32, "=A1:A5"), (1, "=SUM(LEN(C1:C3))"), (2, "=A1:A5"), (3, "=SUM(A1:A3)")] {
        let mut cell = crate::SavedCell::from_cell(&engine::Cell::new_formula(formula.to_string()));
        cell.value = crate::SavedCellValue::Number(1.0);
        sheet.cells.insert((row, 7), cell);
    }
    wb.sheets.push(sheet);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.xlsx");
    crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    // H1 and H2 made legacy, as an older Excel (or another writer) saves
    // them; H3 keeps Calcula's dynamic flag.
    rewrite_sheet(&path, |xml| {
        let mut xml = xml.to_string();
        for cell in ["H1", "H2"] {
            let at = xml.find(&format!("<c r=\"{}\"", cell)).unwrap();
            let end = at + xml[at..].find("</c>").unwrap();
            let legacy = xml[at..end].replace(" cm=\"1\"", "").replace(&format!(" t=\"array\" ref=\"{}\"", cell), "");
            xml.replace_range(at..end, &legacy);
        }
        xml
    });
    let back = crate::load_xlsx(&path).unwrap();
    let cells = &back.sheets[0].cells;
    assert_eq!(cells[&(0, 7)].formula.as_deref(), Some("=@A1:A5"));
    assert_eq!(cells[&(1, 7)].formula.as_deref(), Some("=SUM(LEN(@C1:C3))"));
    assert_eq!(cells[&(2, 7)].formula.as_deref(), Some("=A1:A5"), "a dynamic formula is read as written");
    assert_eq!(cells[&(3, 7)].formula.as_deref(), Some("=SUM(A1:A3)"), "a plain formula is untouched");
}
