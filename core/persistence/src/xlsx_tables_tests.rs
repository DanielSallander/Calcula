//! FILENAME: core/persistence/src/xlsx_tables_tests.rs
//!
//! Excel tables in an .xlsx (BUG-0644), against live Excel 16's own parts.
//!
//! Each `EXCEL_*` constant is Excel's file text verbatim: a fresh Excel 16
//! instance, a new workbook, the table built through the object model
//! (`ListObjects.Add`, `TotalsCalculation`, a `[@Qty]*2` typed into the
//! column), saved and read back from the archive (scratchpad
//! `xlsxtbl/probe1.ps1`, `probe2.ps1`, 2026-11-04). Calcula's export of the
//! same table must BE that part once Excel's revision ids (`xr:uid`), its
//! namespace declarations and its differential-format index (`dataDxfId`,
//! the column's number format) are set aside.
//!
//! With `CALCULA_XLSX_PROBE_DIR` set, the export is left there
//! (`calcula-tables.xlsx`) for live Excel to open.

use super::*;
use crate::{SavedCell, SavedCellValue, SavedTable, SavedTableColumn, SavedTableStyleOptions, Sheet, Workbook};
use std::io::Read;

/// [LIVE] Sales on B2:D6 -- Name / Qty / My Col, a totals row with a custom
/// `COUNTA(Sales[Name])&"x"`, a Sum and an Average, `[@Qty]*2` in My Col,
/// TableStyleMedium9, the filter buttons on.
const EXCEL_SALES: &str = r#"<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="xr xr3" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xmlns:xr3="http://schemas.microsoft.com/office/spreadsheetml/2016/revision3" id="1" xr:uid="{8DF36213-508D-41C6-945B-40E82DD0E6AD}" name="Sales" displayName="Sales" ref="B2:D6" totalsRowCount="1"><autoFilter ref="B2:D5" xr:uid="{8DF36213-508D-41C6-945B-40E82DD0E6AD}"/><tableColumns count="3"><tableColumn id="1" xr3:uid="{3B0401B4-4C90-40C6-BB86-0959063A4F95}" name="Name" totalsRowFunction="custom"><totalsRowFormula>COUNTA(Sales[Name])&amp;"x"</totalsRowFormula></tableColumn><tableColumn id="2" xr3:uid="{E1DE064E-75E9-433B-B244-4887768DE1E3}" name="Qty" totalsRowFunction="sum"/><tableColumn id="3" xr3:uid="{8AB67C9F-E4E6-4DF7-9E52-570286E169AE}" name="My Col" totalsRowFunction="average" dataDxfId="0"><calculatedColumnFormula>Sales[[#This Row],[Qty]]*2</calculatedColumnFormula></tableColumn></tableColumns><tableStyleInfo name="TableStyleMedium9" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>"#;

/// [LIVE] Data on B2:E6 -- P / Q / R and a header typed as the NUMBER 2024,
/// style None, the totals row Excel made (`Total` label), Count on Q, Count
/// Numbers on R, and `SUM(Data[P])` typed into the 2024 column.
const EXCEL_DATA: &str = r#"<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="xr xr3" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xmlns:xr3="http://schemas.microsoft.com/office/spreadsheetml/2016/revision3" id="1" xr:uid="{D8206BB7-8159-4D84-A47D-A56EDC38EFDD}" name="Data" displayName="Data" ref="B2:E6" totalsRowCount="1"><autoFilter ref="B2:E5" xr:uid="{D8206BB7-8159-4D84-A47D-A56EDC38EFDD}"/><tableColumns count="4"><tableColumn id="1" xr3:uid="{2773F07B-760E-4D39-985C-C8607BAF38C8}" name="P" totalsRowLabel="Total"/><tableColumn id="2" xr3:uid="{177952A0-F55D-4486-B538-919FC17FEF6F}" name="Q" totalsRowFunction="count"/><tableColumn id="3" xr3:uid="{A3EF9C7F-610C-493F-9B61-9315CB10CFD2}" name="R" totalsRowFunction="countNums"/><tableColumn id="4" xr3:uid="{CE0EBD2D-63E0-4E15-AB75-38EA02B6B0F8}" name="2024" totalsRowFunction="count" dataDxfId="0"><calculatedColumnFormula>SUM(Data[P])</calculatedColumnFormula></tableColumn></tableColumns><tableStyleInfo showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>"#;

/// [LIVE] Tbl2 on another sheet: no totals row, filter buttons off, row
/// stripes off, first column on. Excel named it `Tbl2_` (displayName) -- the
/// name formulas use.
const EXCEL_TBL2: &str = r#"<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="xr xr3" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xmlns:xr3="http://schemas.microsoft.com/office/spreadsheetml/2016/revision3" id="2" xr:uid="{79C0967C-2366-4180-9272-95A0E2FBE037}" name="Tbl2" displayName="Tbl2_" ref="A1:A2" totalsRowShown="0"><tableColumns count="1"><tableColumn id="1" xr3:uid="{D0EECE65-B96B-4985-BD67-597760AE5943}" name="K"/></tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="1" showLastColumn="0" showRowStripes="0" showColumnStripes="0"/></table>"#;

/// [LIVE] Excel's `<f>` text of the cells around Sales and Data (sheet XML).
const EXCEL_SALES_CELLS: &[(&str, &str)] = &[
    ("D3", "Sales[[#This Row],[Qty]]*2"),
    ("D5", "Sales[[#This Row],[Qty]]*2"),
    ("B6", "COUNTA(Sales[Name])&\"x\""),
    ("C6", "SUBTOTAL(109,Sales[Qty])"),
    ("D6", "SUBTOTAL(101,Sales[My Col])"),
    ("G2", "SUM(Sales[My Col])"),
    ("G3", "Sales[[#Totals],[Qty]]"),
    ("G4", "ROWS(Sales[#All])"),
];
const EXCEL_DATA_CELLS: &[(&str, &str)] = &[
    ("E3", "SUM(Data[P])"),
    ("C6", "SUBTOTAL(103,Data[Q])"),
    ("D6", "SUBTOTAL(102,Data[R])"),
    ("E6", "SUBTOTAL(103,Data[2024])"),
];

/// Excel's part without what is Excel's own bookkeeping: the revision ids,
/// the namespace declarations other than the main one, and the
/// differential-format index.
fn without_excel_bookkeeping(xml: &str) -> String {
    let mut out = xml.to_string();
    for attr in [
        " xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\"",
        " mc:Ignorable=\"xr xr3\"",
        " xmlns:xr=\"http://schemas.microsoft.com/office/spreadsheetml/2014/revision\"",
        " xmlns:xr3=\"http://schemas.microsoft.com/office/spreadsheetml/2016/revision3\"",
        " dataDxfId=\"0\"",
    ] {
        out = out.replace(attr, "");
    }
    while let Some(at) = out.find(" xr:uid=\"{").or_else(|| out.find(" xr3:uid=\"{")) {
        let end = out[at..].find("}\"").map(|e| at + e + 2).unwrap();
        out.replace_range(at..end, "");
    }
    out
}

fn text(s: &str) -> SavedCell {
    SavedCell { value: SavedCellValue::Text(s.to_string()), formula: None, style_index: 0, rich_text: None, spill: None }
}

fn number(v: f64) -> SavedCell {
    SavedCell { value: SavedCellValue::Number(v), formula: None, style_index: 0, rich_text: None, spill: None }
}

/// The cell Calcula stores for a typed formula, with its calculated value.
fn formula(typed: &str, value: SavedCellValue) -> SavedCell {
    let mut cell = SavedCell::from_cell(&engine::Cell::new_formula(typed.to_string()));
    assert!(cell.formula.is_some(), "Calcula holds no formula for {}", typed);
    cell.value = value;
    cell
}

/// The text Calcula stores for a typed formula.
fn stored(typed: &str) -> Option<String> {
    SavedCell::from_cell(&engine::Cell::new_formula(typed.to_string())).formula
}

fn column(name: &str, totals: &str, totals_formula: Option<&str>, calculated: Option<&str>) -> SavedTableColumn {
    SavedTableColumn {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: name.to_string(),
        totals_row_function: totals.to_string(),
        totals_row_formula: totals_formula.map(str::to_string),
        calculated_formula: calculated.map(str::to_string),
        totals_row_label: None,
    }
}

fn options(banded_rows: bool, total_row: bool, filter: bool, first_column: bool) -> SavedTableStyleOptions {
    SavedTableStyleOptions {
        banded_rows,
        banded_columns: false,
        header_row: true,
        total_row,
        first_column,
        last_column: false,
        show_filter_button: filter,
    }
}

/// Calcula's copy of the probes' workbook: Sales on Sheet1 (with G2:G4
/// beside it), Data on `Data Sheet` (with a header cell holding the number
/// 2024), Tbl2_ on `Other Sheet` (with a reference to Sales from there).
fn probe_workbook() -> Workbook {
    let mut wb = Workbook::new();
    wb.sheets.clear();

    let mut s1 = Sheet::new("Sheet1".to_string());
    for (c, h) in ["Name", "Qty", "My Col"].iter().enumerate() {
        s1.cells.insert((1, 1 + c as u32), text(h));
    }
    for (i, (n, q)) in [("a", 10.0), ("b", 20.0), ("c", 30.0)].iter().enumerate() {
        let row = 2 + i as u32;
        s1.cells.insert((row, 1), text(n));
        s1.cells.insert((row, 2), number(*q));
        s1.cells.insert((row, 3), formula("=[@Qty]*2", SavedCellValue::Number(q * 2.0)));
    }
    s1.cells.insert((5, 1), formula("=COUNTA([Name])&\"x\"", SavedCellValue::Text("3x".to_string())));
    s1.cells.insert((5, 2), formula("=SUBTOTAL(109,Sales[Qty])", SavedCellValue::Number(60.0)));
    s1.cells.insert((5, 3), formula("=SUBTOTAL(101,Sales[My Col])", SavedCellValue::Number(40.0)));
    s1.cells.insert((1, 6), formula("=SUM(Sales[My Col])", SavedCellValue::Number(120.0)));
    s1.cells.insert((2, 6), formula("=Sales[[#Totals],[Qty]]", SavedCellValue::Number(60.0)));
    s1.cells.insert((3, 6), formula("=ROWS(Sales[#All])", SavedCellValue::Number(5.0)));
    let s1_id = s1.id;
    wb.sheets.push(s1);

    let mut s2 = Sheet::new("Data Sheet".to_string());
    for (c, h) in ["P", "Q", "R"].iter().enumerate() {
        s2.cells.insert((1, 1 + c as u32), text(h));
    }
    s2.cells.insert((1, 4), number(2024.0));
    for (i, (p, q, r)) in [(1.0, text("x"), text("y")), (2.0, number(5.0), number(7.0)), (3.0, number(6.0), number(8.0))]
        .into_iter()
        .enumerate()
    {
        let row = 2 + i as u32;
        s2.cells.insert((row, 1), number(p));
        s2.cells.insert((row, 2), q);
        s2.cells.insert((row, 3), r);
        s2.cells.insert((row, 4), formula("=SUM([P])", SavedCellValue::Number(6.0)));
    }
    s2.cells.insert((5, 1), text("Total"));
    s2.cells.insert((5, 2), formula("=SUBTOTAL(103,Data[Q])", SavedCellValue::Number(3.0)));
    s2.cells.insert((5, 3), formula("=SUBTOTAL(102,Data[R])", SavedCellValue::Number(2.0)));
    s2.cells.insert((5, 4), formula("=SUBTOTAL(103,Data[2024])", SavedCellValue::Number(3.0)));
    let s2_id = s2.id;
    wb.sheets.push(s2);

    let mut s3 = Sheet::new("Other Sheet".to_string());
    s3.cells.insert((0, 0), text("K"));
    s3.cells.insert((1, 0), number(5.0));
    s3.cells.insert((0, 2), formula("=SUM(Sales[Qty])", SavedCellValue::Number(60.0)));
    let s3_id = s3.id;
    wb.sheets.push(s3);

    wb.tables.push(SavedTable {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: "Sales".to_string(),
        sheet_id: s1_id,
        start_row: 1,
        start_col: 1,
        end_row: 5,
        end_col: 3,
        columns: vec![
            column("Name", "custom", Some("=COUNTA([Name])&\"x\""), None),
            column("Qty", "sum", None, None),
            column("My Col", "average", None, Some("=[@Qty]*2")),
        ],
        style_options: options(true, true, true, false),
        style_name: "TableStyleMedium9".to_string(),
    });
    wb.tables.push(SavedTable {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: "Data".to_string(),
        sheet_id: s2_id,
        start_row: 1,
        start_col: 1,
        end_row: 5,
        end_col: 4,
        columns: vec![
            column("P", "none", None, None),
            column("Q", "count", None, None),
            column("R", "countNumbers", None, None),
            column("2024", "count", None, Some("=SUM([P])")),
        ],
        style_options: options(true, true, true, false),
        style_name: String::new(),
    });
    wb.tables.push(SavedTable {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: "Tbl2_".to_string(),
        sheet_id: s3_id,
        start_row: 0,
        start_col: 0,
        end_row: 1,
        end_col: 0,
        columns: vec![column("K", "none", None, None)],
        style_options: options(false, false, false, true),
        style_name: "TableStyleMedium2".to_string(),
    });
    wb
}

fn part(path: &std::path::Path, name: &str) -> Option<String> {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut entry = archive.by_name(name).ok()?;
    let mut xml = String::new();
    entry.read_to_string(&mut xml).unwrap();
    Some(xml)
}

fn without_declaration(xml: &str) -> &str {
    match xml.strip_prefix("<?xml") {
        Some(rest) => rest[rest.find("?>").unwrap() + 2..].trim_start(),
        None => xml,
    }
}

/// The `<f>` text of cell `address` in a sheet part, unescaped.
fn formula_of(xml: &str, address: &str) -> Option<String> {
    let at = xml.find(&format!("<c r=\"{}\"", address))?;
    let cell = &xml[at..];
    let cell = &cell[..cell.find("</c>").unwrap_or(cell.len())];
    let f = &cell[cell.find("<f")?..];
    let open = f.find('>')?;
    let close = f.find("</f>")?;
    Some(f[open + 1..close].replace("&quot;", "\"").replace("&amp;", "&"))
}

fn export(wb: &Workbook, dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("calcula-tables.xlsx");
    let losses = crate::save_xlsx_reporting_losses(wb, &path, false).unwrap();
    assert!(losses.is_empty(), "the export lost something: {:?}", losses.message());
    if let Ok(probe) = std::env::var("CALCULA_XLSX_PROBE_DIR") {
        let _ = std::fs::copy(&path, std::path::Path::new(&probe).join("calcula-tables.xlsx"));
    }
    path
}

/// Calcula's export of each probed table IS Excel's own table part.
#[test]
fn an_exported_table_is_excels_own_table_part() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(&probe_workbook(), dir.path());
    let sales = part(&path, "xl/tables/table1.xml").expect("no table part for Sales: the table is not an Excel table");
    let data = part(&path, "xl/tables/table2.xml").expect("no table part for Data");
    assert_eq!(without_declaration(&sales), without_excel_bookkeeping(EXCEL_SALES), "Sales is not Excel's part");
    // Excel's part numbers its tables across the workbook from 1; Data is
    // the second here as it was in Excel's own book.
    let excel_data = without_excel_bookkeeping(EXCEL_DATA).replace(" id=\"1\" name=\"Data\"", " id=\"2\" name=\"Data\"");
    assert_eq!(without_declaration(&data), excel_data, "Data is not Excel's part");
    let tbl2 = part(&path, "xl/tables/table3.xml").expect("no table part for Tbl2_");
    // Excel's name/displayName split is its own (`Tbl2` / `Tbl2_`); Calcula
    // names a table once, and the id is the third table's.
    let excel_tbl2 = without_excel_bookkeeping(EXCEL_TBL2).replace("name=\"Tbl2\"", "name=\"Tbl2_\"").replace("id=\"2\"", "id=\"3\"");
    assert_eq!(without_declaration(&tbl2), excel_tbl2, "Tbl2_ is not Excel's part");
}

/// The sheet links its table part as Excel's does, and the package declares
/// it.
#[test]
fn the_table_part_is_linked_from_its_sheet_and_declared() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(&probe_workbook(), dir.path());
    let sheet1 = part(&path, "xl/worksheets/sheet1.xml").unwrap();
    assert!(sheet1.contains("<tableParts count=\"1\"><tablePart r:id=\"rId1\"/></tableParts>"), "{}", sheet1);
    let rels = part(&path, "xl/worksheets/_rels/sheet1.xml.rels").expect("no sheet rels");
    assert!(
        rels.contains("Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/table\" Target=\"../tables/table1.xml\""),
        "{}",
        rels
    );
    let types = part(&path, "[Content_Types].xml").unwrap();
    assert!(
        types.contains("<Override PartName=\"/xl/tables/table1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml\"/>"),
        "{}",
        types
    );
    // One source of truth: the hidden carry sheet is not written for tables.
    let workbook_xml = part(&path, "xl/workbook.xml").unwrap();
    assert!(!workbook_xml.contains(crate::META_SHEET_NAME), "the tables still ride the metadata sheet");
}

/// Every structured reference in the cells is QUALIFIED as Excel saves it,
/// inside the table too, every table name is spelled as the table declares
/// it, and a header cell holds its column's name as text.
#[test]
fn the_cells_carry_excels_qualified_structured_references() {
    let dir = tempfile::tempdir().unwrap();
    let path = export(&probe_workbook(), dir.path());
    let mut wrong = Vec::new();
    for (sheet_part, cells) in [("xl/worksheets/sheet1.xml", EXCEL_SALES_CELLS), ("xl/worksheets/sheet2.xml", EXCEL_DATA_CELLS)] {
        let xml = part(&path, sheet_part).unwrap();
        for &(address, excel) in cells {
            let written = formula_of(&xml, address).unwrap_or_else(|| "<NO FORMULA>".to_string());
            // Exactly: a table name in another case is a file Excel refused
            // (`respell_table_names`).
            if written != excel {
                wrong.push(format!("{} {}: Calcula {} / Excel {}", sheet_part, address, written, excel));
            }
        }
    }
    assert!(wrong.is_empty(), "NOT EXCEL'S CELL TEXT:\n{}", wrong.join("\n"));
    let sheet2 = part(&path, "xl/worksheets/sheet2.xml").unwrap();
    let e2 = &sheet2[sheet2.find("<c r=\"E2\"").unwrap()..];
    let e2 = &e2[..e2.find("</c>").unwrap()];
    // [LIVE] `<c r="E2" t="s">` -- the header 2024 is the string "2024".
    assert!(e2.contains("t=\"s\""), "the numeric header is not written as its column's name: {}", e2);
    // The calculated column keeps the value Calcula calculated.
    let d3 = &part(&path, "xl/worksheets/sheet1.xml").unwrap();
    let d3 = &d3[d3.find("<c r=\"D3\"").unwrap()..];
    assert!(d3[..d3.find("</c>").unwrap()].contains("<v>20</v>"), "the calculated column lost its value");
}

/// The export reads back into the same table store, and every formula reads
/// back as Calcula holds it -- the reference to a cell's own table
/// unqualified, as Excel's formula bar shows it.
#[test]
fn an_exported_table_reads_back_into_the_table_store() {
    let dir = tempfile::tempdir().unwrap();
    let original = probe_workbook();
    let path = export(&original, dir.path());
    let back = crate::load_xlsx(&path).unwrap();
    assert_eq!(back.tables.len(), 3, "tables read back: {:?}", back.tables.iter().map(|t| &t.name).collect::<Vec<_>>());
    for want in &original.tables {
        let got = back.tables.iter().find(|t| t.name == want.name).unwrap_or_else(|| panic!("{} not read back", want.name));
        let want_sheet = original.sheets.iter().position(|s| s.id == want.sheet_id).unwrap();
        assert_eq!(got.sheet_id, back.sheets[want_sheet].id, "{} landed on the wrong sheet", want.name);
        assert_eq!(
            (got.start_row, got.start_col, got.end_row, got.end_col),
            (want.start_row, want.start_col, want.end_row, want.end_col),
            "{} geometry",
            want.name
        );
        assert_eq!(got.style_name, want.style_name, "{} style", want.name);
        let o = (&got.style_options, &want.style_options);
        assert_eq!(
            (o.0.header_row, o.0.total_row, o.0.banded_rows, o.0.banded_columns, o.0.first_column, o.0.last_column, o.0.show_filter_button),
            (o.1.header_row, o.1.total_row, o.1.banded_rows, o.1.banded_columns, o.1.first_column, o.1.last_column, o.1.show_filter_button),
            "{} options",
            want.name
        );
        for (g, w) in got.columns.iter().zip(&want.columns) {
            assert_eq!(g.name, w.name);
            assert_eq!(g.totals_row_function, w.totals_row_function, "{}[{}] totals function", want.name, w.name);
            let canonical = |f: &Option<String>| f.as_deref().and_then(stored);
            assert_eq!(canonical(&g.calculated_formula), canonical(&w.calculated_formula), "{}[{}] calculated", want.name, w.name);
            assert_eq!(canonical(&g.totals_row_formula), canonical(&w.totals_row_formula), "{}[{}] totals formula", want.name, w.name);
        }
    }
    let cell = |sheet: usize, row: u32, col: u32| back.sheets[sheet].cells.get(&(row, col)).and_then(|c| c.formula.as_deref().and_then(stored));
    assert_eq!(cell(0, 2, 3), stored("=[@Qty]*2"), "D3");
    assert_eq!(cell(0, 5, 1), stored("=COUNTA([Name])&\"x\""), "B6");
    // Inside its own table, as Excel shows it ([LIVE] `=SUBTOTAL(109,[Qty])`).
    assert_eq!(cell(0, 5, 2), stored("=SUBTOTAL(109,[Qty])"), "C6");
    // Outside the table the name stays.
    assert_eq!(cell(0, 1, 6), stored("=SUM(Sales[My Col])"), "G2");
    assert_eq!(cell(2, 0, 2), stored("=SUM(Sales[Qty])"), "Other Sheet!C1");
}

/// Excel's own parts, as Excel wrote them, read into Calcula's table store.
#[test]
fn excels_own_table_parts_read_as_calculas_tables() {
    let sheet = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let sales = parse_table_part(EXCEL_SALES, sheet).expect("Excel's Sales part was not read");
    assert_eq!(sales.name, "Sales");
    assert_eq!((sales.start_row, sales.start_col, sales.end_row, sales.end_col), (1, 1, 5, 3));
    assert!(sales.style_options.header_row && sales.style_options.total_row && sales.style_options.show_filter_button);
    assert!(sales.style_options.banded_rows && !sales.style_options.first_column);
    assert_eq!(sales.style_name, "TableStyleMedium9");
    let names: Vec<&str> = sales.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["Name", "Qty", "My Col"]);
    let functions: Vec<&str> = sales.columns.iter().map(|c| c.totals_row_function.as_str()).collect();
    assert_eq!(functions, ["custom", "sum", "average"]);
    assert_eq!(sales.columns[0].totals_row_formula.as_deref().and_then(stored), stored("=COUNTA([Name])&\"x\""));
    assert_eq!(sales.columns[2].calculated_formula.as_deref().and_then(stored), stored("=[@Qty]*2"));
    assert_eq!(sales.sheet_id, sheet);

    let data = parse_table_part(EXCEL_DATA, sheet).unwrap();
    let functions: Vec<&str> = data.columns.iter().map(|c| c.totals_row_function.as_str()).collect();
    assert_eq!(functions, ["none", "count", "countNumbers", "count"], "Excel's countNums is Calcula's countNumbers");
    assert_eq!(data.style_name, "", "a table styled None has no style name");
    assert_eq!(data.columns[3].name, "2024");
    assert_eq!(data.columns[3].calculated_formula.as_deref().and_then(stored), stored("=SUM([P])"));

    let tbl2 = parse_table_part(EXCEL_TBL2, sheet).unwrap();
    assert_eq!(tbl2.name, "Tbl2_", "the displayName is the name formulas use");
    assert!(!tbl2.style_options.total_row && !tbl2.style_options.show_filter_button);
    assert!(tbl2.style_options.first_column && !tbl2.style_options.banded_rows);
    assert_eq!(tbl2.style_name, "TableStyleMedium2");
}

/// A table Excel cannot hold is left out and REPORTED; the save goes on and
/// the other tables are written.
#[test]
fn a_table_excel_cannot_hold_is_reported_and_the_rest_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let mut wb = probe_workbook();
    let mut twin = wb.tables[1].clone();
    twin.id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    twin.sheet_id = wb.sheets[2].id;
    twin.name = "SALES".to_string(); // the name of another table, in another case
    twin.start_row = 10;
    twin.end_row = 14;
    wb.tables.push(twin);
    let mut overlap = wb.tables[2].clone();
    overlap.id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    overlap.name = "Overlap".to_string();
    wb.tables.push(overlap);
    let path = dir.path().join("losses.xlsx");
    let losses = crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    assert_eq!(losses.tables, ["Overlap", "SALES"]);
    assert!(losses.message().unwrap().contains("2 tables (Overlap, SALES)"), "{:?}", losses.message());
    assert!(part(&path, "xl/tables/table3.xml").is_some(), "the writable tables were lost too");
    assert!(part(&path, "xl/tables/table4.xml").is_none(), "an unwritable table was written");
}

/// A `tables` key in an older file's carry is ignored, not an unreadable
/// carry (its charts still come back).
#[test]
fn an_older_carry_with_tables_still_reads() {
    let meta = crate::CalculaMeta::from_json(
        r#"{"version":1,"tables":[{"anything":1}],"charts":[{"sheetIndex":0,"specJson":"{}","nativeEmitted":false}]}"#,
    )
    .expect("the carry was refused");
    assert_eq!(meta.charts.len(), 1);
}

#[test]
fn qualification_follows_calculas_parser() {
    let q = |f: &str| qualify_structured_refs(f, "Sales");
    assert_eq!(q("=[@Qty]*2").as_deref(), Some("=Sales[@Qty]*2"));
    assert_eq!(q("=SUM([Qty])+[@[My Col]]").as_deref(), Some("=SUM(Sales[Qty])+Sales[@[My Col]]"));
    assert_eq!(q("=[[#Totals],[Qty]]").as_deref(), Some("=Sales[[#Totals],[Qty]]"));
    assert_eq!(q("=SUM( [Qty] )").as_deref(), Some("=SUM( Sales[Qty] )"));
    assert_eq!(q("=[A]:[B]").as_deref(), Some("=Sales[A]:Sales[B]"));
    // Already qualified, a subscript, a string, a quoted sheet, an escaped
    // bracket inside a column name: nothing to do.
    assert_eq!(q("=Other[Qty]+A1[0]+F(1)[2]"), None);
    assert_eq!(q("=\"[Qty]\"&'My [Sheet]'!A1"), None);
    assert_eq!(q("=Sales[Cost '[USD']]"), None);
    assert_eq!(q("=[Cost '[USD']]*2").as_deref(), Some("=Sales[Cost '[USD']]*2"));
}

#[test]
fn unqualification_only_drops_the_cells_own_table() {
    let u = |f: &str| unqualify_structured_refs(f, "Sales");
    assert_eq!(u("Sales[@Qty]*2").as_deref(), Some("[@Qty]*2"));
    assert_eq!(u("SUM(sales[Qty])+Other[Qty]").as_deref(), Some("SUM([Qty])+Other[Qty]"));
    assert_eq!(u("Sales2[Qty]+x.Sales[Qty]"), None);
    assert_eq!(u("\"Sales[Qty]\"&'Sales'!A1"), None);
    assert_eq!(u("Sales+1"), None);
    for f in ["=[@Qty]*2", "=SUM([Qty])+[@[My Col]]", "=[[#Totals],[Qty]]", "=[Cost '[USD']]*2"] {
        let there = qualify_structured_refs(f, "Sales").unwrap();
        assert_eq!(u(&there).as_deref(), Some(f), "{} does not come back", f);
    }
}

#[test]
fn a_table_name_is_spelled_as_the_table_declares_it() {
    let names = ["Data", "Sales"];
    let r = |f: &str| respell_table_names(f, &names);
    // Calcula's lexer folds the name; the file must not.
    assert_eq!(r("SUBTOTAL(103,DATA[Q])+SUM(sales[My Col])").as_deref(), Some("SUBTOTAL(103,Data[Q])+SUM(Sales[My Col])"));
    assert_eq!(r("SUBTOTAL(103,Data[Q])"), None);
    // Not a table reference: no bracket, a longer name, a string, a sheet.
    assert_eq!(r("DATA+DATA2[Q]+x.DATA[Q]"), None);
    assert_eq!(r("\"DATA[Q]\"&'DATA'!A1"), None);
    // A column name in the bracket is the user's text and is not touched.
    assert_eq!(r("DATA[SALES]").as_deref(), Some("Data[SALES]"));
}

/// The live probe of the import: with `CALCULA_XLSX_EXCEL_TABLES` naming the
/// workbook Excel 16 itself saved (`xlsxtbl/probe1.ps1`: Sales on Sheet1,
/// Tbl2_ on `Other Sheet`), its tables come into the table store on the
/// sheets they were on, and the cells inside Sales read back in Calcula's
/// unqualified form. Without the variable there is no Excel file to read.
#[test]
fn an_excel_authored_workbook_reads_its_tables_live() {
    let Ok(path) = std::env::var("CALCULA_XLSX_EXCEL_TABLES") else { return };
    let wb = crate::load_xlsx(std::path::Path::new(&path)).unwrap();
    let names: Vec<&str> = wb.tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["Sales", "Tbl2_"]);
    let sales = &wb.tables[0];
    assert_eq!(sales.sheet_id, wb.sheets[0].id);
    assert_eq!((sales.start_row, sales.start_col, sales.end_row, sales.end_col), (1, 1, 5, 3));
    assert_eq!(wb.tables[1].sheet_id, wb.sheets[1].id);
    let formula = |row: u32, col: u32| wb.sheets[0].cells.get(&(row, col)).and_then(|c| c.formula.as_deref().and_then(stored));
    assert_eq!(formula(2, 3), stored("=[@Qty]*2"));
    assert_eq!(formula(5, 2), stored("=SUBTOTAL(109,[Qty])"));
    assert_eq!(formula(1, 6), stored("=SUM(Sales[My Col])"));
    eprintln!("[LIVE] read Excel's own tables: {:?}", names);
}

/// What the library writes into a table's cells (the calculated column's
/// formula in every data row, the totals formula) does not outlive the
/// workbook's own content: a cell the workbook leaves empty -- a calculated
/// column's row the user cleared, a totals cell with nothing in it -- is
/// empty in the file too.
#[test]
fn a_table_cell_the_workbook_leaves_empty_stays_empty() {
    let dir = tempfile::tempdir().unwrap();
    let mut wb = probe_workbook();
    wb.sheets[0].cells.remove(&(3, 3)); // D4, in the calculated column
    wb.sheets[0].cells.remove(&(5, 2)); // C6, the Sum total
    let path = dir.path().join("empty.xlsx");
    crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    let xml = part(&path, "xl/worksheets/sheet1.xml").unwrap();
    assert_eq!(formula_of(&xml, "D4"), None, "the library's column formula outlived the workbook's empty cell");
    assert_eq!(formula_of(&xml, "C6"), None, "the library's totals formula outlived the workbook's empty cell");
    assert_eq!(formula_of(&xml, "D3").as_deref(), Some("Sales[[#This Row],[Qty]]*2"), "the workbook's own cells were lost");
}

/// One table `name` on Sheet1 A1: a header row, three data rows, columns
/// `cols`; `calc` the second column's calculated formula, typed into its
/// data cells too.
fn one_table_workbook(name: &str, cols: [&str; 2], calc: &str) -> Workbook {
    let mut wb = Workbook::new();
    wb.sheets.clear();
    let mut s1 = Sheet::new("Sheet1".to_string());
    s1.cells.insert((0, 0), text(cols[0]));
    s1.cells.insert((0, 1), text(cols[1]));
    for row in 1..=3u32 {
        s1.cells.insert((row, 0), number(row as f64));
        s1.cells.insert((row, 1), formula(calc, SavedCellValue::Number(row as f64 * 2.0)));
    }
    let sheet_id = s1.id;
    wb.sheets.push(s1);
    wb.tables.push(SavedTable {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: name.to_string(),
        sheet_id,
        start_row: 0,
        start_col: 0,
        end_row: 3,
        end_col: 1,
        columns: vec![column(cols[0], "none", None, None), column(cols[1], "none", None, Some(calc))],
        style_options: options(true, false, true, false),
        style_name: "TableStyleMedium2".to_string(),
    });
    wb
}

/// The text of a table part's `<calculatedColumnFormula>`, unescaped.
fn calculated_column_formula(xml: &str) -> Option<String> {
    let open = "<calculatedColumnFormula>";
    let at = xml.find(open)? + open.len();
    let end = xml[at..].find("</calculatedColumnFormula>")? + at;
    Some(xml[at..end].replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
}

/// NEW-xlsx-table-names (b): a calculated column over a column whose NAME
/// holds `@`. [LIVE, Excel 16, 2026-11-05, tablefix-probe/probe5.ps1]
/// `=[@[a'@b]]*2` in table TH is saved
/// `<calculatedColumnFormula>TH[[#This Row],[a@b]]*2</calculatedColumnFormula>`
/// and the cells `<f>TH[[#This Row],[a@b]]*2</f>`. rust_xlsxwriter's
/// calculated-column setter turned the name's `@` into `[#This Row],`
/// (`TH[[#This Row],[a[#This Row],b]]*2`); the part is now finished after
/// the library wrote it. An ordinary table's part is left as written.
/// SABOTAGE (tablefix-at): `finish_archive` returns `Ok(None)`.
#[test]
fn a_calculated_column_over_an_at_sign_column_is_written_as_excel_writes_it() {
    let dir = tempfile::tempdir().unwrap();
    let wb = one_table_workbook("TH", ["a@b", "Calc"], "=[@[a@b]]*2");
    let path = dir.path().join("at.xlsx");
    let losses = crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    assert!(losses.is_empty(), "{:?}", losses.message());
    let table = part(&path, "xl/tables/table1.xml").unwrap();
    assert_eq!(calculated_column_formula(&table).as_deref(), Some("TH[[#This Row],[a@b]]*2"), "{}", table);
    let sheet = part(&path, "xl/worksheets/sheet1.xml").unwrap();
    assert_eq!(formula_of(&sheet, "B2").as_deref(), Some("TH[[#This Row],[a@b]]*2"));
    // And back: the column formula Calcula reads is the one it wrote.
    let back = crate::load_xlsx(&path).unwrap();
    assert_eq!(
        back.tables[0].columns[1].calculated_formula.as_deref().and_then(stored),
        stored("=[@[a@b]]*2"),
    );
}

/// NEW-xlsx-table-names (a): a calculated column reading a DEFINED NAME
/// spelled like a function. [LIVE, Excel 16, 2026-11-05,
/// tablefix-probe/probe1.ps1] `=[@V]*Rate`, `Rate` a defined name, is saved
/// `<calculatedColumnFormula>TJ[[#This Row],[V]]*Rate</calculatedColumnFormula>`;
/// the part's text was made without the workbook's names, so `Rate` (also a
/// function) came out the function VALUE `_xleta.RATE`, a different formula.
/// SABOTAGE (tablefix-names): `table_formula_text` calls `excel_formula_text`.
#[test]
fn a_calculated_column_reading_a_defined_name_keeps_the_name() {
    let dir = tempfile::tempdir().unwrap();
    let mut wb = one_table_workbook("TJ", ["V", "W"], "=[@V]*Rate");
    wb.named_ranges.push(crate::SavedNamedRange {
        name: "Rate".to_string(),
        refers_to: "=0.5".to_string(),
        sheet_id: None,
        comment: None,
        folder: None,
    });
    let path = dir.path().join("names.xlsx");
    let losses = crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    assert!(losses.is_empty(), "{:?}", losses.message());
    let table = part(&path, "xl/tables/table1.xml").unwrap();
    let written = calculated_column_formula(&table).unwrap_or_default();
    assert!(written.eq_ignore_ascii_case("TJ[[#This Row],[V]]*Rate"), "{}", table);
    let sheet = part(&path, "xl/worksheets/sheet1.xml").unwrap();
    assert!(formula_of(&sheet, "B2").unwrap_or_default().eq_ignore_ascii_case("TJ[[#This Row],[V]]*Rate"), "{}", sheet);
}

/// rev-xlsx-2: a calculated column -- or a custom total -- Excel cannot hold
/// (`ROUND` with one argument: [LIVE] Excel 16 refuses to type it and refused
/// to OPEN the file whose `<calculatedColumnFormula>` held it, review
/// rev-xlsx) is left out of the part and reported; the cells go value-only
/// as every unholdable cell does, and the table itself is still written.
/// SABOTAGE (tablefix-unwr): `table_formula_text` skips `unwritable_reason`.
#[test]
fn a_table_formula_excel_cannot_hold_is_left_out_of_the_part_and_reported() {
    let dir = tempfile::tempdir().unwrap();
    let mut wb = one_table_workbook("TR", ["Qty", "Calc"], "=ROUND([@Qty])");
    let table = &mut wb.tables[0];
    table.end_row = 4;
    table.style_options.total_row = true;
    table.columns[0].totals_row_function = "custom".to_string();
    table.columns[0].totals_row_formula = Some("=ROUND(SUM([Qty]))".to_string());
    wb.sheets[0].cells.insert((4, 0), formula("=ROUND(SUM([Qty]))", SavedCellValue::Number(6.0)));
    let path = dir.path().join("unwritable.xlsx");
    let losses = crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    assert!(losses.formulas.iter().any(|l| l == "TR[Calc]"), "{:?}", losses);
    assert!(losses.formulas.iter().any(|l| l == "TR[[#Totals],[Qty]]"), "{:?}", losses);
    assert!(losses.tables.is_empty(), "the table itself is written: {:?}", losses);
    let part_xml = part(&path, "xl/tables/table1.xml").unwrap();
    assert!(!part_xml.contains("calculatedColumnFormula"), "{}", part_xml);
    assert!(!part_xml.contains("totalsRowFormula"), "{}", part_xml);
}

/// NEW-totals-label-persist: a HIDDEN totals row's remembered constant is
/// written as Excel writes it -- `totalsRowLabel="7"` on the column of a table
/// part with `totalsRowShown="0"`, and no totals cell ([LIVE, Excel 16,
/// 2026-11-05, cfdv/probe2.ps1]) -- and read back into the column. A totals row
/// that SHOWS keeps its label in the cell, so the reader leaves the field
/// empty then.
/// SABOTAGE (cfeval-xlsx): the writer's hidden-row label branch never taken.
#[test]
fn a_hidden_totals_rows_label_is_written_and_read_as_excels_totals_row_label() {
    let dir = tempfile::tempdir().unwrap();
    let mut wb = one_table_workbook("TL", ["A", "B"], "=[@A]*2");
    wb.tables[0].columns[1].calculated_formula = None;
    wb.tables[0].columns[0].totals_row_label = Some("7".to_string());
    let path = dir.path().join("label.xlsx");
    let losses = crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    assert!(losses.is_empty(), "{:?}", losses.message());
    let table = part(&path, "xl/tables/table1.xml").unwrap();
    assert!(table.contains("totalsRowShown=\"0\""), "{}", table);
    assert!(table.contains("totalsRowLabel=\"7\""), "{}", table);
    let back = crate::load_xlsx(&path).unwrap();
    assert_eq!(back.tables[0].columns[0].totals_row_label.as_deref(), Some("7"));
    assert_eq!(back.tables[0].columns[1].totals_row_label, None);

    // Shown: the label is the cell's, and the field stays empty.
    let shown = parse_table_part(
        r#"<table name="T" displayName="T" ref="A1:B5" totalsRowCount="1"><tableColumns count="2"><tableColumn id="1" name="A" totalsRowLabel="Total"/><tableColumn id="2" name="B" totalsRowFunction="sum"/></tableColumns></table>"#,
        wb.sheets[0].id,
    )
    .unwrap();
    assert_eq!(shown.columns[0].totals_row_label, None);
}
