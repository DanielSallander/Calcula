//! FILENAME: core/persistence/src/xlsx_autofilter_tests.rs
//! PURPOSE: A table's filter criteria and column data format through a real
//!          .xlsx, both directions, against Excel 16's own part text
//!          (BUG-0740).
//! CONTEXT: A `#[path]` child of `xlsx_autofilter`.

use super::*;
use crate::{SavedCell, SavedCellValue, SavedTable, SavedTableColumn, SavedTableStyleOptions, Sheet, Workbook};
use std::io::Read;

/// [LIVE, Excel 16, 2026-11-06, lane xlsx probe3] the `<autoFilter>` of
/// `Tbl` (A1:D6) after `Range.AutoFilter 2, ">1"` and
/// `Range.AutoFilter 4, "x", xlOr, "y"`, verbatim but for its `xr:uid`.
const EXCEL_TBL: &str = r#"<autoFilter ref="A1:D6"><filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="1"/></customFilters></filterColumn><filterColumn colId="3"><filters><filter val="x"/><filter val="y"/></filters></filterColumn></autoFilter>"#;

fn criteria_of(filter: &Value, col: u32) -> Value {
    filter["columnFilters"][col.to_string()]["criteria"].clone()
}

/// Excel's own criteria read into Calcula's, and Calcula's written back as
/// Excel's text, byte for byte.
///
/// SABOTAGE (xlsx-afwrite): `auto_filter_element` writes no `filterColumn`;
/// the round trip then loses both criteria.
#[test]
fn excels_table_filter_reads_and_writes_as_excel_spells_it() {
    let (filter, lossy) = parse_auto_filter(&format!("<table>{}<tableColumns/></table>", EXCEL_TBL)).expect("a filtered table");
    assert!(!lossy);
    assert_eq!(filter_range(&filter), Some((0, 0, 5, 3)));
    assert_eq!(criteria_of(&filter, 1)["filterOn"], "custom");
    assert_eq!(criteria_of(&filter, 1)["criterion1"], ">1");
    assert_eq!(criteria_of(&filter, 3)["filterOn"], "values");
    assert_eq!(criteria_of(&filter, 3)["values"], json!(["x", "y"]));
    let (element, lossy) = auto_filter_element(&filter).unwrap();
    assert!(!lossy);
    assert_eq!(element, EXCEL_TBL);
}

/// The other criteria Excel's part holds: two custom criteria joined by AND
/// or OR, a blank in a value list, Top / Bottom 10, a dynamic filter; a
/// colour filter is reported lost.
#[test]
fn every_criterion_shape_round_trips() {
    for element in [
        r#"<autoFilter ref="B2:C9"><filterColumn colId="0"><customFilters and="1"><customFilter operator="greaterThanOrEqual" val="2"/><customFilter operator="lessThan" val="8"/></customFilters></filterColumn></autoFilter>"#,
        r#"<autoFilter ref="B2:C9"><filterColumn colId="1"><customFilters><customFilter val="a*"/><customFilter operator="notEqual" val="b"/></customFilters></filterColumn></autoFilter>"#,
        r#"<autoFilter ref="B2:C9"><filterColumn colId="1"><filters blank="1"><filter val="k"/></filters></filterColumn></autoFilter>"#,
        r#"<autoFilter ref="B2:C9"><filterColumn colId="0"><top10 top="0" percent="1" val="25"/></filterColumn></autoFilter>"#,
        r#"<autoFilter ref="B2:C9"><filterColumn colId="0"><top10 val="3"/></filterColumn></autoFilter>"#,
        r#"<autoFilter ref="B2:C9"><filterColumn colId="0"><dynamicFilter type="aboveAverage"/></filterColumn></autoFilter>"#,
        r#"<autoFilter ref="B2:C9"><filterColumn colId="0"><dynamicFilter type="M3"/></filterColumn></autoFilter>"#,
        r#"<autoFilter ref="B2:C9"><filterColumn colId="0"><customFilters><customFilter operator="notEqual" val=" "/></customFilters></filterColumn></autoFilter>"#,
    ] {
        let (filter, lossy) = parse_auto_filter(element).unwrap_or_else(|| panic!("{}", element));
        assert!(!lossy, "{}", element);
        assert_eq!(auto_filter_element(&filter).unwrap().0, element);
    }
    let color = r#"<autoFilter ref="B2:C9"><filterColumn colId="0"><colorFilter dxfId="0"/></filterColumn></autoFilter>"#;
    let (_, lossy) = parse_auto_filter(color).map_or((Value::Null, true), |r| r);
    assert!(lossy, "a colour filter is reported");
    assert!(parse_auto_filter(r#"<autoFilter ref="B2:C9"/>"#).is_none(), "a range alone filters nothing");
}

fn sales_workbook() -> Workbook {
    let mut wb = Workbook::new();
    wb.sheets.clear();
    wb.tables.clear();
    let mut sheet = Sheet::new("Sheet1".to_string());
    let cell = |value: SavedCellValue, style_index: usize| SavedCell { value, formula: None, style_index, rich_text: None, spill: None };
    let text = |s: &str| cell(SavedCellValue::Text(s.to_string()), 0);
    for (c, h) in ["Name", "Qty", "Amt", "Tag"].iter().enumerate() {
        sheet.cells.insert((0, c as u32), text(h));
    }
    let rows = [("a", 3.0, 1.5, "x"), ("b", 1.0, 2.5, "y"), ("c", 5.0, 3.5, "x"), ("d", 2.0, 4.5, "z"), ("e", 4.0, 5.5, "y")];
    let mut percent = engine::style::CellStyle::new();
    percent.number_format = engine::style::NumberFormat::Custom { format: "0.00%".to_string() };
    sheet.styles.push(percent);
    let percent_index = sheet.styles.len() - 1;
    for (i, (n, q, a, t)) in rows.iter().enumerate() {
        let r = i as u32 + 1;
        sheet.cells.insert((r, 0), text(n));
        sheet.cells.insert((r, 1), cell(SavedCellValue::Number(*q), 0));
        sheet.cells.insert((r, 2), cell(SavedCellValue::Number(*a), percent_index));
        sheet.cells.insert((r, 3), text(t));
    }
    // What the filter (Qty > 1 and Tag in x, y) hides: rows 2 (b, 1) and 4 (d, z).
    sheet.hidden_rows.extend([2u32, 4]);
    let sheet_id = sheet.id;
    wb.sheets.push(sheet);
    let column = |name: &str| SavedTableColumn {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: name.to_string(),
        totals_row_function: "none".to_string(),
        totals_row_formula: None,
        calculated_formula: None,
        totals_row_label: None,
    };
    wb.tables.push(SavedTable {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: "Tbl".to_string(),
        sheet_id,
        start_row: 0,
        start_col: 0,
        end_row: 5,
        end_col: 3,
        columns: ["Name", "Qty", "Amt", "Tag"].iter().map(|n| column(n)).collect(),
        style_options: SavedTableStyleOptions {
            banded_rows: true,
            banded_columns: false,
            header_row: true,
            total_row: false,
            first_column: false,
            last_column: false,
            show_filter_button: true,
        },
        style_name: "TableStyleMedium2".to_string(),
    });
    let (filter, _) = parse_auto_filter(EXCEL_TBL).unwrap();
    let mut filter = filter;
    filter["hiddenRows"] = json!([2, 4]);
    wb.user_files.insert("autofilters.json".to_string(), serde_json::to_vec(&json!({ "0": filter })).unwrap());
    wb
}

/// The real path: Calcula's table filter is written into the table part as
/// Excel writes it, its column format as `dataDxfId`, and the file read back
/// holds the same filter, its hidden rows the FILTER's.
///
/// SABOTAGE (xlsx-afpart): `finish_archive` skips the filter elements; the
/// part then reads `<autoFilter ref="A1:D6"/>`.
#[test]
fn a_tables_filter_and_column_format_round_trip_through_a_real_xlsx() {
    let wb = sales_workbook();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("filters.xlsx");
    let losses = crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    assert!(losses.filters.is_empty(), "{:?}", losses);
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
    let mut part = String::new();
    archive.by_name("xl/tables/table1.xml").unwrap().read_to_string(&mut part).unwrap();
    assert!(part.contains(EXCEL_TBL), "{}", part);
    assert!(part.contains("name=\"Amt\" dataDxfId=\""), "the column's data format: {}", part);
    assert!(!part.contains("name=\"Qty\" dataDxfId"), "{}", part);

    let mut back = crate::load_xlsx(&path).unwrap();
    assert!(crate::take_xlsx_import_losses(&mut back).is_empty());
    let store: HashMap<String, Value> = serde_json::from_slice(&back.user_files["autofilters.json"]).unwrap();
    let filter = &store["0"];
    assert_eq!(filter_range(filter), Some((0, 0, 5, 3)));
    assert_eq!(criteria_of(filter, 1)["criterion1"], ">1");
    assert_eq!(criteria_of(filter, 3)["values"], json!(["x", "y"]));
    assert_eq!(filter["hiddenRows"], json!([2, 4]));
    let sheet = &back.sheets[0];
    assert!(sheet.user_hidden_rows.is_empty(), "a row the filter hid is not the user's: {:?}", sheet.user_hidden_rows);
    assert!(sheet.hidden_rows.contains(&2) && sheet.hidden_rows.contains(&4));
}

/// A formula Calcula cannot read is reported, not dropped in silence: Excel's
/// own `Rate[](10,-100,800)` ([LIVE] the table Rate called, #REF!).
///
/// SABOTAGE (xlsx-unread): `note_unreadable_formulas` returns at once.
#[test]
fn an_unreadable_formula_is_reported_on_import() {
    let mut wb = Workbook::new();
    wb.sheets.clear();
    let mut sheet = Sheet::new("Other".to_string());
    sheet.cells.insert((1, 0), SavedCell::from_cell(&engine::Cell::new_formula("=1+1".to_string())));
    wb.sheets.push(sheet);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rate.xlsx");
    crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    // Excel's own text for the cell, as it saved it.
    let bytes = std::fs::read(&path).unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for index in 0..archive.len() {
        use std::io::Write;
        let mut entry = archive.by_index(index).unwrap();
        let name = entry.name().to_string();
        if name == "xl/worksheets/sheet1.xml" {
            let mut xml = String::new();
            entry.read_to_string(&mut xml).unwrap();
            drop(entry);
            let xml = xml.replace(">1+1</f>", ">Rate[](10,-100,800)+1</f>");
            out.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            out.write_all(xml.as_bytes()).unwrap();
        } else {
            out.raw_copy_file(entry).unwrap();
        }
    }
    std::fs::write(&path, out.finish().unwrap().into_inner()).unwrap();
    let mut back = crate::load_xlsx(&path).unwrap();
    let losses = crate::take_xlsx_import_losses(&mut back);
    assert_eq!(losses.formulas, vec!["Other!A2".to_string()]);
    assert!(losses.message().unwrap().contains("Other!A2"), "{:?}", losses.message());
    assert!(!back.user_files.contains_key(IMPORT_LOSSES_FILE_FOR_TESTS));
}

const IMPORT_LOSSES_FILE_FOR_TESTS: &str = "xlsx_import_losses.json";

/// [LIVE, Excel 16, 2026-11-06, lane tabxlsx probe1] the table `ST` (A1:B7)
/// after `Sort.SortFields.Add(V's body, xlSortOnValues, xlAscending)`,
/// `Apply`, then `AutoFilter 2, "<60"`: its `<autoFilter>` and `<sortState>`
/// verbatim but for the `xr:uid` and the `xmlns:xlrd2` declaration.
const EXCEL_ST: &str = r#"<autoFilter ref="A1:B7"><filterColumn colId="1"><customFilters><customFilter operator="lessThan" val="60"/></customFilters></filterColumn></autoFilter><sortState ref="A2:B7"><sortCondition ref="B2:B7"/></sortState>"#;

/// Excel's sort definition read into the filter's `sortState` (keys relative
/// to the filter's first column) and written back as Excel spells it; a
/// descending level and a built-in custom list too.
///
/// SABOTAGE (tabxlsx-sortstate): `sort_state_element` returns `None`.
#[test]
fn excels_sort_state_reads_and_writes_as_excel_spells_it() {
    let xml = format!("<table>{}<tableColumns/></table>", EXCEL_ST);
    let (mut filter, mut lossy) = parse_auto_filter(&xml).expect("a filtered table");
    attach_sort_state(&mut filter, &mut lossy, &xml, &[]);
    assert!(!lossy);
    assert_eq!(filter["sortState"], json!({ "fields": [{ "key": 1, "ascending": true }], "matchCase": false }));
    let (element, _) = auto_filter_element(&filter).unwrap();
    let (sort, lost) = sort_state_element(&filter).expect("a sort is written");
    assert!(!lost);
    assert_eq!(format!("{}{}", element, sort), EXCEL_ST);

    let descending = r#"<sortState ref="A2:D6"><sortCondition descending="1" ref="B2:B6" customList="Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec"/></sortState>"#;
    let (state, lost) = parse_sort_state(descending, 0, &[]).unwrap();
    assert!(!lost);
    assert_eq!(state["fields"][0], json!({ "key": 1, "ascending": false, "customOrder": "monthsShort" }));
    let filter = json!({ "startRow": 0, "startCol": 0, "endRow": 5, "endCol": 3, "columnFilters": {}, "sortState": state });
    assert_eq!(sort_state_element(&filter).unwrap().0, descending);
    // An icon sort is reported, never written as a value sort.
    let icon = r#"<sortState ref="A2:D6"><sortCondition sortBy="icon" ref="B2:B6" iconSet="3Arrows"/></sortState>"#;
    assert!(parse_sort_state(icon, 0, &[]).unwrap().1, "an icon sort is lost, and said");
}

/// [LIVE, lane tabxlsx probe1] `AutoFilter 1, 255, xlFilterCellColor` on a
/// table is saved `<colorFilter dxfId="0"/>` with the dxf below: read as
/// Calcula's filter by cell colour. A filter whose only criterion is lost
/// (an icon) is returned, lossy, so it is reported rather than dropped
/// unsaid (W2 verifier: it was `None`, and no loss was listed).
///
/// SABOTAGE (tabxlsx-color): the `colorFilter` arm sets `lossy` only.
#[test]
fn a_colour_filter_is_read_and_a_lost_one_is_reported() {
    let styles = r#"<styleSheet><dxfs count="2"><dxf><fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/><bgColor rgb="FFFFFFFF"/></patternFill></fill></dxf><dxf><font><color rgb="FF00B050"/></font><numFmt numFmtId="19" formatCode="yyyy/mm/dd"/></dxf></dxfs></styleSheet>"#;
    let dxfs = parse_dxf_colors(styles);
    assert_eq!(dxfs.len(), 2);
    assert_eq!(dxfs[0].fill.as_deref(), Some("#ff0000"));
    assert_eq!(dxfs[1].font.as_deref(), Some("#00b050"));
    let ct = r#"<autoFilter ref="A1:B5"><filterColumn colId="0"><colorFilter dxfId="0"/></filterColumn></autoFilter>"#;
    let (filter, lossy) = parse_auto_filter_with(ct, &dxfs).unwrap();
    assert!(!lossy);
    assert_eq!(criteria_of(&filter, 0)["filterOn"], "cellColor");
    assert_eq!(criteria_of(&filter, 0)["color"], "#ff0000");
    let font = r#"<autoFilter ref="A1:B5"><filterColumn colId="1"><colorFilter dxfId="1" cellColor="0"/></filterColumn></autoFilter>"#;
    assert_eq!(criteria_of(&parse_auto_filter_with(font, &dxfs).unwrap().0, 1)["filterOn"], "fontColor");
    let icon = r#"<autoFilter ref="A1:B5"><filterColumn colId="0"><iconFilter iconSet="3Arrows" iconId="1"/></filterColumn></autoFilter>"#;
    let (filter, lossy) = parse_auto_filter_with(icon, &dxfs).expect("a lost criterion is still reported");
    assert!(lossy);
    assert_eq!(filter["columnFilters"], json!({}));
}

/// A TABLE's sort definition is written after its `<autoFilter>` in the table
/// part, as Excel writes it ([LIVE] probe3 `Tbl`: `<sortState ref="A2:D6">
/// <sortCondition descending="1" ref="B2:B6"/></sortState>`), and read back.
#[test]
fn a_tables_sort_state_round_trips_through_a_real_xlsx() {
    let mut wb = sales_workbook();
    let mut store: HashMap<String, Value> = serde_json::from_slice(&wb.user_files["autofilters.json"]).unwrap();
    store.get_mut("0").unwrap()["sortState"] = json!({ "fields": [{ "key": 1, "ascending": false }], "matchCase": false });
    wb.user_files.insert("autofilters.json".to_string(), serde_json::to_vec(&store).unwrap());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tablesort.xlsx");
    let losses = crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    assert!(losses.filters.is_empty(), "{:?}", losses);
    if let Ok(copy) = std::env::var("TABXLSX_EXPORT_DIR") {
        let _ = std::fs::copy(&path, std::path::Path::new(&copy).join("tablesort.xlsx"));
    }
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
    let mut part = String::new();
    archive.by_name("xl/tables/table1.xml").unwrap().read_to_string(&mut part).unwrap();
    assert!(
        part.contains(&format!("{}<sortState ref=\"A2:D6\"><sortCondition descending=\"1\" ref=\"B2:B6\"/></sortState><tableColumns", EXCEL_TBL)),
        "{}",
        part
    );
    let back = crate::load_xlsx(&path).unwrap();
    let store: HashMap<String, Value> = serde_json::from_slice(&back.user_files["autofilters.json"]).unwrap();
    assert_eq!(store["0"]["sortState"]["fields"][0], json!({ "key": 1, "ascending": false }));
}

/// A SHEET filter (no table) is written into its worksheet part as Excel
/// writes it -- criteria, sort, `filterMode`, the `_xlnm._FilterDatabase`
/// name -- and read back with its hidden rows the FILTER's (W2 xlsx: it was
/// neither written nor read).
///
/// SABOTAGE (tabxlsx-sheetaf): `add_sheet_filter` returns at once; the part
/// then has no `<autoFilter>` and the load no filter.
#[test]
fn a_sheet_filter_and_its_sort_round_trip_through_a_real_xlsx() {
    let mut wb = Workbook::new();
    wb.sheets.clear();
    wb.tables.clear();
    let mut sheet = Sheet::new("S".to_string());
    let cell = |value: SavedCellValue| SavedCell { value, formula: None, style_index: 0, rich_text: None, spill: None };
    sheet.cells.insert((0, 0), cell(SavedCellValue::Text("K".to_string())));
    sheet.cells.insert((0, 1), cell(SavedCellValue::Text("V".to_string())));
    for (i, v) in [9.0, 8.0, 5.0, 1.0, 3.0, 2.0].iter().enumerate() {
        sheet.cells.insert((i as u32 + 1, 0), cell(SavedCellValue::Text(format!("k{}", i))));
        sheet.cells.insert((i as u32 + 1, 1), cell(SavedCellValue::Number(*v)));
    }
    sheet.hidden_rows.insert(4);
    wb.sheets.push(sheet);
    let filter = json!({
        "startRow": 0, "startCol": 0, "endRow": 6, "endCol": 1,
        "columnFilters": { "1": { "columnIndex": 1, "criteria": { "criterion1": ">1", "filterOn": "custom", "values": [], "filterOutBlanks": false } } },
        "hiddenRows": [4], "enabled": true,
        "sortState": { "fields": [{ "key": 1, "ascending": false }], "matchCase": false }
    });
    wb.user_files.insert("autofilters.json".to_string(), serde_json::to_vec(&json!({ "0": filter })).unwrap());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sheetfilter.xlsx");
    let losses = crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    assert!(losses.filters.is_empty(), "{:?}", losses);
    if let Ok(copy) = std::env::var("TABXLSX_EXPORT_DIR") {
        let _ = std::fs::copy(&path, std::path::Path::new(&copy).join("sheetfilter.xlsx"));
    }
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
    let mut xml = String::new();
    archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut xml).unwrap();
    assert!(xml.contains("<sheetPr filterMode=\"1\""), "{}", xml);
    assert!(
        xml.contains("<autoFilter ref=\"A1:B7\"><filterColumn colId=\"1\"><customFilters><customFilter operator=\"greaterThan\" val=\"1\"/></customFilters></filterColumn><sortState ref=\"A2:B7\"><sortCondition descending=\"1\" ref=\"B2:B7\"/></sortState></autoFilter>"),
        "{}",
        xml
    );
    let mut book = String::new();
    archive.by_name("xl/workbook.xml").unwrap().read_to_string(&mut book).unwrap();
    assert!(book.contains("_xlnm._FilterDatabase"), "{}", book);

    let mut back = crate::load_xlsx(&path).unwrap();
    assert!(crate::take_xlsx_import_losses(&mut back).is_empty());
    assert!(back.named_ranges.iter().all(|n| !n.name.contains("FilterDatabase")), "Excel's built-in name is not a user name");
    let store: HashMap<String, Value> = serde_json::from_slice(&back.user_files["autofilters.json"]).unwrap();
    let filter = &store["0"];
    assert_eq!(filter_range(filter), Some((0, 0, 6, 1)));
    assert_eq!(criteria_of(filter, 1)["criterion1"], ">1");
    assert_eq!(filter["sortState"]["fields"][0], json!({ "key": 1, "ascending": false }));
    assert_eq!(filter["hiddenRows"], json!([4]));
    assert!(back.sheets[0].user_hidden_rows.is_empty() && back.sheets[0].hidden_rows.contains(&4));

    // Excel's own sheet part [LIVE, lane tabxlsx probe1, sheet S4s] reads the
    // same; a worksheet-level `<sortState>` (the sheet's own Sort) is not the
    // filter's.
    let excel = r#"<worksheet><sheetData/><autoFilter ref="A1:B7" xr:uid="{BFBD99F4-AFF7-4FDC-B1A5-CB2A39EB83A4}"><filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="1"/></customFilters></filterColumn><sortState ref="A3:B7" xmlns:xlrd2="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata2"><sortCondition descending="1" ref="B2:B7"/></sortState></autoFilter><pageMargins left="0.7"/></worksheet>"#;
    let (filter, lossy) = parse_sheet_auto_filter(excel, &[]).expect("Excel's sheet filter");
    assert!(!lossy);
    assert_eq!(criteria_of(&filter, 1)["criterion1"], ">1");
    assert_eq!(filter["sortState"]["fields"][0], json!({ "key": 1, "ascending": false }));
    let sibling = r#"<worksheet><autoFilter ref="A1:B7"/><sortState ref="A2:B5"><sortCondition ref="B2:B5"/></sortState></worksheet>"#;
    let (filter, _) = parse_sheet_auto_filter(sibling, &[]).expect("a sheet filter with no criterion");
    assert!(filter.get("sortState").is_none(), "{}", filter);
}

/// A CUSTOM VIEW's `<autoFilter>` is not the sheet's: CT_Worksheet puts the
/// sheet's own before `<customSheetViews>`, and each `<customSheetView>` may
/// carry one. Read past that point, a sheet with no filter imported the view's
/// as its live filter.
///
/// SABOTAGE (tab4-cview): the search runs over the whole part again.
#[test]
fn a_custom_views_auto_filter_is_not_the_sheets() {
    let view_only = r#"<worksheet><sheetData/><customSheetViews><customSheetView guid="{0B0C1D2E-0000-0000-0000-000000000001}" filter="1"><autoFilter ref="A1:B7"><filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="1"/></customFilters></filterColumn></autoFilter></customSheetView></customSheetViews><pageMargins left="0.7"/></worksheet>"#;
    assert!(parse_sheet_auto_filter(view_only, &[]).is_none(), "a custom view's filter was read as the sheet's");
    let both = r#"<worksheet><sheetData/><autoFilter ref="D1:E9"/><customSheetViews><customSheetView guid="{0B0C1D2E-0000-0000-0000-000000000001}" filter="1"><autoFilter ref="A1:B7"><filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="1"/></customFilters></filterColumn></autoFilter></customSheetView></customSheetViews></worksheet>"#;
    let (filter, _) = parse_sheet_auto_filter(both, &[]).expect("the sheet's own filter");
    assert_eq!(filter_range(&filter), Some((0, 3, 8, 4)), "{}", filter);
}

/// A sheet with a sheet filter AND a table with filter buttons: Excel keeps
/// both, Calcula holds one filter per sheet, so the import chooses one and
/// REPORTS the other. The table's bare `<autoFilter ref>` was not even listed,
/// so the sheet filter took the slot and the table's dropdowns went in silence
/// (wave-4 verifier finding, xlsx_tables.rs:899).
///
/// SABOTAGE (tab4-bare): a table with buttons but no criterion and no sort is
/// unlisted again; nothing is reported.
#[test]
fn a_sheet_filter_beside_a_filter_button_table_reports_the_one_it_cannot_hold() {
    let mut wb = Workbook::new();
    wb.sheets.clear();
    wb.tables.clear();
    let mut sheet = Sheet::new("S".to_string());
    let cell = |value: SavedCellValue| SavedCell { value, formula: None, style_index: 0, rich_text: None, spill: None };
    for (c, h) in ["K", "V", "", "H1", "H2"].iter().enumerate() {
        if !h.is_empty() {
            sheet.cells.insert((0, c as u32), cell(SavedCellValue::Text(h.to_string())));
        }
    }
    for r in 1..=6u32 {
        sheet.cells.insert((r, 0), cell(SavedCellValue::Text(format!("k{}", r))));
        sheet.cells.insert((r, 1), cell(SavedCellValue::Number(r as f64)));
    }
    for r in 1..=3u32 {
        sheet.cells.insert((r, 3), cell(SavedCellValue::Number(r as f64)));
        sheet.cells.insert((r, 4), cell(SavedCellValue::Number(10.0 * r as f64)));
    }
    let sheet_id = sheet.id;
    wb.sheets.push(sheet);
    let column = |name: &str| SavedTableColumn {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: name.to_string(),
        totals_row_function: "none".to_string(),
        totals_row_formula: None,
        calculated_formula: None,
        totals_row_label: None,
    };
    wb.tables.push(SavedTable {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: "T".to_string(),
        sheet_id,
        start_row: 0,
        start_col: 3,
        end_row: 3,
        end_col: 4,
        columns: ["H1", "H2"].iter().map(|n| column(n)).collect(),
        style_options: SavedTableStyleOptions {
            banded_rows: true,
            banded_columns: false,
            header_row: true,
            total_row: false,
            first_column: false,
            last_column: false,
            show_filter_button: true,
        },
        style_name: "TableStyleMedium2".to_string(),
    });
    // The sheet filter: dropdowns on A1:B7, no criterion.
    let filter = json!({ "startRow": 0, "startCol": 0, "endRow": 6, "endCol": 1, "columnFilters": {}, "hiddenRows": [], "enabled": true });
    wb.user_files.insert("autofilters.json".to_string(), serde_json::to_vec(&json!({ "0": filter })).unwrap());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("both.xlsx");
    crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    let mut back = crate::load_xlsx(&path).unwrap();
    let losses = crate::take_xlsx_import_losses(&mut back);
    assert_eq!(losses.filters, vec!["T".to_string()], "the table whose dropdowns are not held is reported");
    let store: HashMap<String, Value> = serde_json::from_slice(&back.user_files["autofilters.json"]).unwrap();
    assert_eq!(filter_range(&store["0"]), Some((0, 0, 6, 1)), "between two dropdown-only filters the first in the sheet is kept");
}

/// The choice itself: a filter that FILTERS or SORTS beats one that is only
/// dropdowns, wherever it sits (losing it would show the rows it hid, or
/// forget the order Reapply keeps); the other is reported.
#[test]
fn the_import_keeps_the_filter_that_filters_and_reports_the_other() {
    let mut wb = Workbook::new();
    wb.sheets.clear();
    wb.sheets.push(Sheet::new("S".to_string()));
    let bare = json!({ "startRow": 0, "startCol": 0, "endRow": 6, "endCol": 1, "columnFilters": {}, "hiddenRows": [], "enabled": true });
    let (filtering, _) = parse_auto_filter(r#"<autoFilter ref="D1:E4"><filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="10"/></customFilters></filterColumn></autoFilter>"#).unwrap();
    crate::xlsx_tables::install_table_filters(
        &mut wb,
        vec![(0, "S!A1:B7".to_string(), bare.clone(), false), (0, "T".to_string(), filtering, false)],
    );
    let losses = crate::take_xlsx_import_losses(&mut wb);
    assert_eq!(losses.filters, vec!["S!A1:B7".to_string()]);
    let store: HashMap<String, Value> = serde_json::from_slice(&wb.user_files["autofilters.json"]).unwrap();
    assert_eq!(filter_range(&store["0"]), Some((0, 3, 3, 4)), "the filter with a criterion is kept");

    // A sort counts as much as a criterion.
    let mut wb = Workbook::new();
    wb.sheets.clear();
    wb.sheets.push(Sheet::new("S".to_string()));
    let mut sorted = json!({ "startRow": 0, "startCol": 3, "endRow": 3, "endCol": 4, "columnFilters": {}, "hiddenRows": [], "enabled": true });
    sorted["sortState"] = json!({ "fields": [{ "key": 1, "ascending": false }], "matchCase": false });
    crate::xlsx_tables::install_table_filters(&mut wb, vec![(0, "S!A1:B7".to_string(), bare, false), (0, "T".to_string(), sorted, false)]);
    let store: HashMap<String, Value> = serde_json::from_slice(&wb.user_files["autofilters.json"]).unwrap();
    assert_eq!(filter_range(&store["0"]), Some((0, 3, 3, 4)), "the sorted filter is kept");
}
