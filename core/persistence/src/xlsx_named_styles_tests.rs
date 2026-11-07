//! FILENAME: core/persistence/src/xlsx_named_styles_tests.rs
//! PURPOSE: A named cell style's IncludeProtection through a real .xlsx, both
//!          directions, against Excel 16's own `styles.xml` (BUG-0771).
//! CONTEXT: A `#[path]` child of `xlsx_named_styles`.

use super::*;
use crate::xlsx_style_reader::{parse_styles_xml, XlsxStyleData};
use crate::{SavedCell, SavedCellValue, Sheet};
use std::io::Read;

/// [LIVE, Excel 16, 2026-11-06, lane xlsx probe3] `styles.xml` of a workbook
/// with `Styles.Add("NoProt")` (IncludeProtection False, Locked False, Bold),
/// `Styles.Add("WithProt")` (IncludeProtection True, Locked False,
/// FormulaHidden True) and `Styles.Add("DefProt")`, applied to A7, A8 and
/// (Good) A9 -- its three lists verbatim but for the `xr:uid`s.
const EXCEL_STYLES: &str = r#"<styleSheet><fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><sz val="11"/><name val="Calibri"/></font><font><sz val="11"/><color rgb="FF006100"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" applyNumberFormat="0" applyBorder="0" applyAlignment="0" applyProtection="0"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" applyProtection="0"><protection locked="0"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0"><protection locked="0" hidden="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="2" applyProtection="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="3"><protection locked="0" hidden="1"/></xf><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="1"/></cellXfs><cellStyles count="5"><cellStyle name="DefProt" xfId="4"/><cellStyle name="Good" xfId="1" builtinId="26"/><cellStyle name="NoProt" xfId="2"/><cellStyle name="Normal" xfId="0" builtinId="0"/><cellStyle name="WithProt" xfId="3"/></cellStyles></styleSheet>"#;

/// Excel's styles read as Excel holds them: NoProt keeps protection out,
/// WithProt and DefProt put it in, Good (a built-in) is Calcula's own; and the
/// cell A8, whose record has no `applyProtection`, is unlocked and hidden as
/// in Excel.
///
/// SABOTAGE (xlsx-stylexf): `named_styles_of` writes `includeProtection: true`
/// always; NoProt then reads as including protection.
#[test]
fn excels_named_styles_read_with_their_include_protection() {
    let mut data = XlsxStyleData::default();
    parse_styles_xml(EXCEL_STYLES, &mut data);
    assert_eq!(data.cell_style_xfs.len(), 5);
    let bytes = crate::xlsx_reader::named_styles_of_for_tests(&data).expect("custom styles");
    let rows: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
    let by_name = |n: &str| rows.iter().find(|r| r["name"] == n).cloned().unwrap_or_else(|| panic!("{} missing: {:?}", n, rows));
    assert!(rows.iter().all(|r| r["name"] != "Good" && r["name"] != "Normal"), "the built-ins are Calcula's own");
    assert_eq!(by_name("NoProt")["includeProtection"], false);
    assert_eq!(by_name("NoProt")["style"]["locked"], false);
    assert_eq!(by_name("NoProt")["style"]["font"]["bold"], true);
    assert_eq!(by_name("WithProt")["includeProtection"], true);
    assert_eq!(by_name("WithProt")["style"]["formulaHidden"].as_bool().or(by_name("WithProt")["style"]["formula_hidden"].as_bool()), Some(true));
    assert_eq!(by_name("DefProt")["includeProtection"], true);
    // A8 (cellXfs 4): no applyProtection, its own `<protection>`.
    let a8 = &data.cell_xfs[4];
    assert!(a8.apply_protection && !a8.locked && a8.formula_hidden, "{:?}", a8);
    // A7 (cellXfs 3): applyProtection="1", no child: locked.
    assert!(data.cell_xfs[3].locked);
}

/// A cell record with NO `<protection>` child and NO `applyProtection`, whose
/// cell style is unlocked and hidden, is LOCKED and not hidden: [LIVE, Excel
/// 16, 2026-11-06, lane tabxlsx probe2] Excel opened exactly that record (A4
/// of a style "WithProt", its child removed) as Locked=True,
/// FormulaHidden=False. The style's protection is not inherited.
///
/// SABOTAGE (tabxlsx-inherit): `inherit_style_protection` falls back to the
/// style's record again; the cell then reads unlocked.
#[test]
fn a_cell_record_without_protection_is_locked_whatever_its_style() {
    let xml = EXCEL_STYLES.replace(
        "<xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"3\"><protection locked=\"0\" hidden=\"1\"/></xf>",
        "<xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"3\"/>",
    );
    assert_ne!(xml, EXCEL_STYLES, "the fixture's A8 record is the one rewritten");
    let mut data = XlsxStyleData::default();
    parse_styles_xml(&xml, &mut data);
    let a8 = &data.cell_xfs[4];
    assert!(a8.locked && !a8.formula_hidden, "Excel reads it locked, not hidden: {:?}", a8);
}

fn styled(style_index: usize) -> SavedCell {
    SavedCell { value: SavedCellValue::Text("x".to_string()), formula: None, style_index, rich_text: None, spill: None }
}

/// The real path: Calcula's custom styles are written into `styles.xml` as
/// Excel writes them and read back with the same IncludeProtection; a style
/// no cell uses is reported.
///
/// SABOTAGE (xlsx-stylewrite): `finish_with_named_styles` returns `Ok(None)`;
/// the file then holds no `NoProt` style.
#[test]
fn named_styles_round_trip_through_a_real_xlsx() {
    let mut wb = crate::Workbook::new();
    wb.sheets.clear();
    let mut sheet = Sheet::new("Sheet1".to_string());
    let mut no_prot = CellStyle::new();
    no_prot.font.bold = true;
    no_prot.locked = false;
    let mut with_prot = CellStyle::new();
    with_prot.locked = false;
    with_prot.formula_hidden = true;
    with_prot.font.italic = true;
    let mut unused = CellStyle::new();
    unused.font.strikethrough = true;
    sheet.styles.push(no_prot.clone());
    sheet.styles.push(with_prot.clone());
    sheet.cells.insert((6, 0), styled(1));
    sheet.cells.insert((7, 0), styled(2));
    wb.sheets.push(sheet);
    let saved = serde_json::json!([
        { "name": "NoProt", "category": "Custom", "style": no_prot, "includeProtection": false },
        { "name": "Unused", "category": "Custom", "style": unused },
        { "name": "WithProt", "category": "Custom", "style": with_prot },
    ]);
    wb.user_files.insert("named_styles.json".to_string(), serde_json::to_vec(&saved).unwrap());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("styles.xlsx");
    let losses = crate::save_xlsx_reporting_losses(&wb, &path, false).unwrap();
    // A style no cell uses is WRITTEN, with a record of its own (W2 xlsx; this
    // test pinned it as reported lost before -- changed deliberately: Excel
    // keeps it, [LIVE] lane tabxlsx probe1 "Unused").
    // SABOTAGE (tabxlsx-unusedstyle): `register_unused_styles` returns an empty
    // map; "Unused" is then reported lost again.
    assert!(losses.named_styles.is_empty(), "{:?}", losses.named_styles);
    if let Ok(copy) = std::env::var("TABXLSX_EXPORT_DIR") {
        let _ = std::fs::copy(&path, std::path::Path::new(&copy).join("styles.xlsx"));
    }
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
    let mut xml = String::new();
    archive.by_name("xl/styles.xml").unwrap().read_to_string(&mut xml).unwrap();
    assert!(xml.contains("<cellStyle name=\"NoProt\" xfId=\"1\"/>"), "{}", xml);
    assert!(xml.contains("<cellStyle name=\"Unused\" xfId=\"2\"/>"), "{}", xml);
    assert!(xml.contains("<cellStyle name=\"WithProt\" xfId=\"3\"/>"), "{}", xml);
    assert!(xml.contains("applyProtection=\"0\"><protection locked=\"0\"/></xf>"), "{}", xml);
    assert!(xml.contains("<protection locked=\"0\" hidden=\"1\"/></xf></cellStyleXfs>"), "{}", xml);
    assert!(xml.contains("<cellStyleXfs count=\"4\">"), "{}", xml);
    assert!(xml.contains("<strike/>"), "the unused style's own font is in the font list: {}", xml);

    let back = crate::load_xlsx(&path).unwrap();
    let rows: Vec<serde_json::Value> = serde_json::from_slice(&back.user_files["named_styles.json"]).unwrap();
    let flag = |n: &str| rows.iter().find(|r| r["name"] == n).map(|r| r["includeProtection"].clone());
    assert_eq!(flag("NoProt"), Some(serde_json::json!(false)));
    assert_eq!(flag("WithProt"), Some(serde_json::json!(true)));
    assert_eq!(flag("Unused"), Some(serde_json::json!(true)));
    let unused_back = rows.iter().find(|r| r["name"] == "Unused").unwrap();
    assert_eq!(unused_back["style"]["font"]["strikethrough"], true, "{}", unused_back);
}
