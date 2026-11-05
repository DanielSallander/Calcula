//! FILENAME: core/persistence/src/xlsx_data_tables.rs
//! PURPOSE: A LIVE What-If DATA TABLE in `.xlsx` -- Excel's
//!          `<f t="dataTable" .../>` on the body's top-left cell -- both ways
//!          (BUG-0652).
//! CONTEXT: Calcula stores a data table's body as cells holding the
//! `TABLE(row_input, col_input)` marker (`engine::data_table`). Excel [LIVE,
//! Excel 16 over COM, 2026-11-04, whatifcalc/probe1] saves the same table as
//! ONE formula element on the body's TOP-LEFT cell and plain values on every
//! other body cell:
//!
//! ```text
//! <c r="L2"><f t="dataTable" ref="L2:L3" dt2D="0" dtr="0" r1="A1" ca="1"/><v>22</v></c>   column input A1
//! <c r="Q2"><f t="dataTable" ref="Q2:R2" dt2D="0" dtr="1" r1="A1" ca="1"/><v>4</v></c>    row input A1
//! <c r="U2"><f t="dataTable" ref="U2:V3" dt2D="1" dtr="1" r1="A1" r2="D1"/><v>20</v></c>  row A1, column D1
//! ```
//!
//! (ECMA-376 Part 1 18.3.1.40: `dt2D` two-dimensional, `dtr` one-dimensional
//! along a ROW, `r1` the first input cell -- the row input of a two-variable
//! table -- and `r2` the second.) rust_xlsxwriter has no data-table formula, so
//! the writer saves the body as values ([`strip_for_writer`]) and the finished
//! sheet part is given the element ([`with_data_table_formulas`]). The reader
//! turns each element back into the marker over its `ref`
//! ([`read_data_tables`]).

use std::collections::HashMap;

use crate::{SavedCell, SavedCellValue, Workbook};

/// One table as the sheet part states it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct XmlDataTable {
    /// The body's top-left cell, 0-indexed (row, col).
    pub top_left: (u32, u32),
    /// The body's bottom-right cell.
    pub bottom_right: (u32, u32),
    pub row_input: Option<(u32, u32)>,
    pub col_input: Option<(u32, u32)>,
}

fn a1(row: u32, col: u32) -> String {
    format!("{}{}", engine::index_to_col(col), row + 1)
}

fn parse_a1(text: &str) -> Option<(u32, u32)> {
    let text = text.trim().trim_start_matches('$');
    let split = text.find(|c: char| c.is_ascii_digit())?;
    let (letters, digits) = text.split_at(split);
    let letters = letters.trim_end_matches('$');
    if letters.is_empty() || !letters.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let row: u32 = digits.parse().ok()?;
    if row == 0 {
        return None;
    }
    Some((row - 1, engine::col_to_index(&letters.to_ascii_uppercase())))
}

/// The marker formula (`=TABLE(,A1)`) a body cell holds, as `.cala` saves it.
pub(crate) fn marker_formula(row_input: Option<(u32, u32)>, col_input: Option<(u32, u32)>) -> String {
    marker_formula_anchored(row_input, col_input, None)
}

/// [`marker_formula`] naming the table's identity (`=TABLE(,A1,M2)`, its body's
/// top-left cell) -- for a body touching another table's with the same inputs
/// (`engine::data_table`, rev-xlsx-5).
pub(crate) fn marker_formula_anchored(
    row_input: Option<(u32, u32)>,
    col_input: Option<(u32, u32)>,
    anchor: Option<(u32, u32)>,
) -> String {
    let arg = |p: Option<(u32, u32)>| p.map(|(r, c)| a1(r, c)).unwrap_or_default();
    match anchor {
        Some(at) => format!("=TABLE({},{},{})", arg(row_input), arg(col_input), a1(at.0, at.1)),
        None => format!("=TABLE({},{})", arg(row_input), arg(col_input)),
    }
}

/// The markers each table of one sheet part is written with: Excel's form,
/// except that a body touching an EARLIER table's body whose marker is the same
/// call names its own identity, so the two read back as two tables. Excel
/// [LIVE, rev-xlsx-5, SCRATCH/review-rev-xlsx/out/excel-dt2.xlsx] saves K1:L3
/// and L1:M3, both column input A1, as two `dataTable` elements; written as
/// identical markers they were read back as ONE rectangle L2:M3, refreshed and
/// re-exported with the second table's values computed from the wrong column.
pub(crate) fn markers_for(tables: &[XmlDataTable]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(tables.len());
    let rect = |t: &XmlDataTable| (t.top_left.0, t.top_left.1, t.bottom_right.0, t.bottom_right.1);
    for (i, t) in tables.iter().enumerate() {
        let plain = marker_formula(t.row_input, t.col_input);
        let clashes = tables[..i]
            .iter()
            .zip(out.iter())
            .any(|(earlier, marker)| *marker == plain && engine::data_table::bodies_touch(rect(earlier), rect(t)));
        out.push(if clashes { marker_formula_anchored(t.row_input, t.col_input, Some(t.top_left)) } else { plain });
    }
    out
}

/// The tables on one sheet, read off its cells' `TABLE(..)` formulas. A table
/// whose input cannot be stated (`#REF!` after its input cell was deleted) is
/// left out: its body is written as the values it shows.
pub(crate) fn tables_on(cells: &HashMap<(u32, u32), SavedCell>) -> Vec<XmlDataTable> {
    let mut grid = engine::Grid::new();
    let mut any = false;
    for (&(r, c), cell) in cells {
        let Some(formula) = cell.formula.as_deref() else { continue };
        let text = formula.trim_start().trim_start_matches('=').trim_start();
        if !text.get(..6).is_some_and(|h| h.eq_ignore_ascii_case("TABLE(")) {
            continue;
        }
        let Ok(ast) = parser::parse(&format!("={}", text)) else { continue };
        if engine::data_table::is_table_call(&ast) {
            grid.set_cell(r, c, engine::Cell::new_formula_with_ast(ast));
            any = true;
        }
    }
    if !any {
        return Vec::new();
    }
    use engine::data_table::TableInput;
    let cell_of = |input: TableInput| match input {
        TableInput::Cell(r, c) => Ok(Some((r, c))),
        TableInput::Omitted => Ok(None),
        TableInput::Invalid => Err(()),
    };
    engine::data_table::data_tables_in(&grid)
        .into_iter()
        .filter_map(|t| {
            let row_input = cell_of(t.inputs.row_input).ok()?;
            let col_input = cell_of(t.inputs.col_input).ok()?;
            if row_input.is_none() && col_input.is_none() {
                return None;
            }
            Some(XmlDataTable {
                top_left: (t.start_row, t.start_col),
                bottom_right: (t.end_row, t.end_col),
                row_input,
                col_input,
            })
        })
        .collect()
}

/// THE WRITER'S HALF, before the cells are written: the workbook with every
/// data-table body cell turned into its VALUE (a blank one into 0, so the
/// top-left cell has a `<c>` element to carry the formula), and the tables per
/// worksheet part (`xl/worksheets/sheet{position + 1}.xml`, the library's
/// numbering). `None` when the workbook has no data table, so an ordinary save
/// clones nothing.
pub(crate) fn strip_for_writer(workbook: &Workbook) -> Option<(Workbook, HashMap<String, Vec<XmlDataTable>>)> {
    let per_sheet: Vec<Vec<XmlDataTable>> = workbook.sheets.iter().map(|s| tables_on(&s.cells)).collect();
    if per_sheet.iter().all(|t| t.is_empty()) {
        return None;
    }
    let mut stripped = workbook.clone();
    let mut parts = HashMap::new();
    for (position, tables) in per_sheet.into_iter().enumerate() {
        if tables.is_empty() {
            continue;
        }
        let cells = &mut stripped.sheets[position].cells;
        for t in &tables {
            for r in t.top_left.0..=t.bottom_right.0 {
                for c in t.top_left.1..=t.bottom_right.1 {
                    let cell = cells.entry((r, c)).or_insert_with(|| SavedCell {
                        value: SavedCellValue::Number(0.0),
                        formula: None,
                        style_index: 0,
                        rich_text: None,
                        spill: None,
                    });
                    cell.formula = None;
                    if matches!(cell.value, SavedCellValue::Empty) {
                        cell.value = SavedCellValue::Number(0.0);
                    }
                }
            }
        }
        parts.insert(format!("xl/worksheets/sheet{}.xml", position + 1), tables);
    }
    Some((stripped, parts))
}

/// The `<f t="dataTable" .../>` element Excel writes for `t`.
fn formula_element(t: &XmlDataTable) -> String {
    let reference = format!("{}:{}", a1(t.top_left.0, t.top_left.1), a1(t.bottom_right.0, t.bottom_right.1));
    match (t.row_input, t.col_input) {
        (Some(ri), Some(ci)) => format!(
            r#"<f t="dataTable" ref="{}" dt2D="1" dtr="1" r1="{}" r2="{}"/>"#,
            reference,
            a1(ri.0, ri.1),
            a1(ci.0, ci.1)
        ),
        (Some(ri), None) => {
            format!(r#"<f t="dataTable" ref="{}" dt2D="0" dtr="1" r1="{}" ca="1"/>"#, reference, a1(ri.0, ri.1))
        }
        (None, Some(ci)) => {
            format!(r#"<f t="dataTable" ref="{}" dt2D="0" dtr="0" r1="{}" ca="1"/>"#, reference, a1(ci.0, ci.1))
        }
        (None, None) => String::new(),
    }
}

/// THE WRITER'S HALF, after the library wrote the sheet part: each table's
/// formula element inserted into its top-left cell, before the cell's value,
/// as Excel orders them (`<c><f/><v/></c>`). A cell the part does not hold is
/// an error: [`strip_for_writer`] gave every top-left cell a value.
pub(crate) fn with_data_table_formulas(sheet_xml: &str, tables: &[XmlDataTable]) -> Result<String, String> {
    with_data_table_formulas_using(sheet_xml, tables, &[])
}

/// [`with_data_table_formulas`], with the archive's shared strings (each `<si>`
/// as the XML text of its `<t>` runs, still escaped): a TEXT result on a
/// table's top-left cell is a FORMULA's string, which Excel writes inline as
/// `t="str"` with the text in `<v>` -- the library wrote it as a shared string
/// (`t="s"`, `<v>` an index), which is what a constant is (rev-dt-12).
pub(crate) fn with_data_table_formulas_using(
    sheet_xml: &str,
    tables: &[XmlDataTable],
    shared_strings: &[String],
) -> Result<String, String> {
    let mut xml = sheet_xml.to_string();
    for t in tables {
        let element = formula_element(t);
        if element.is_empty() {
            continue;
        }
        let needle = format!(r#"<c r="{}""#, a1(t.top_left.0, t.top_left.1));
        let at = xml.find(&needle).ok_or_else(|| format!("the sheet part has no cell {}", a1(t.top_left.0, t.top_left.1)))?;
        let mut tag_end = at + xml[at..].find('>').ok_or("an unclosed <c> element")?;
        if xml.as_bytes()[tag_end - 1] != b'/' && xml[at..tag_end].contains(r#" t="s""#) {
            let v_open = tag_end + xml[tag_end..].find("<v>").ok_or("a shared-string cell with no <v>")? + 3;
            let v_close = v_open + xml[v_open..].find("</v>").ok_or("an unclosed <v>")?;
            if let Some(text) = xml[v_open..v_close].trim().parse::<usize>().ok().and_then(|i| shared_strings.get(i)) {
                xml.replace_range(v_open..v_close, text);
                let t_attr = at + xml[at..tag_end].find(r#" t="s""#).expect("found above");
                xml.replace_range(t_attr..t_attr + 6, r#" t="str""#);
                tag_end += 2;
            }
        }
        if xml.as_bytes()[tag_end - 1] == b'/' {
            // `<c r="L2" s="1"/>`: open it to hold the formula.
            let start = xml[at..tag_end - 1].to_string();
            xml.replace_range(at..=tag_end, &format!("{}>{}</c>", start, element));
        } else {
            xml.insert_str(tag_end + 1, &element);
        }
    }
    Ok(xml)
}

/// Rewrite the finished archive's sheet parts named in `parts`; every other
/// part is copied as it is.
pub(crate) fn finish_with_data_tables(
    xlsx_bytes: &[u8],
    parts: &HashMap<String, Vec<XmlDataTable>>,
) -> Result<Vec<u8>, crate::PersistenceError> {
    use std::io::{Read, Write};
    let invalid = |e: zip::result::ZipError| crate::PersistenceError::InvalidFormat(format!("xlsx data tables: {}", e));
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(xlsx_bytes)).map_err(invalid)?;
    let shared_strings = match archive.by_name("xl/sharedStrings.xml") {
        Ok(mut entry) => {
            let mut text = String::new();
            entry.read_to_string(&mut text)?;
            shared_string_texts(&text)
        }
        Err(_) => Vec::new(),
    };
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(invalid)?;
        let name = entry.name().to_string();
        let Some(tables) = parts.get(&name) else {
            out.raw_copy_file(entry).map_err(invalid)?;
            continue;
        };
        let mut xml = String::new();
        entry.read_to_string(&mut xml)?;
        drop(entry);
        let rewritten = with_data_table_formulas_using(&xml, tables, &shared_strings)
            .map_err(|e| crate::PersistenceError::InvalidFormat(format!("xlsx data tables: {}", e)))?;
        out.start_file(name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated))
            .map_err(invalid)?;
        out.write_all(rewritten.as_bytes())?;
    }
    Ok(out.finish().map_err(invalid)?.into_inner())
}

/// Each `<si>` of a `sharedStrings.xml` part as the XML text of its `<t>`
/// runs, concatenated and left escaped (it goes back into XML as it is).
fn shared_string_texts(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(open) = xml[from..].find("<si>").or_else(|| xml[from..].find("<si ")) {
        let start = from + open;
        let Some(close) = xml[start..].find("</si>") else { break };
        let item = &xml[start..start + close];
        let mut text = String::new();
        let mut at = 0;
        while let Some(t) = item[at..].find("<t") {
            let tag = at + t;
            // `<t>` or `<t xml:space="preserve">`, never `<tc..` style names.
            let next = item.as_bytes().get(tag + 2).copied();
            if !matches!(next, Some(b'>') | Some(b' ')) {
                at = tag + 2;
                continue;
            }
            let Some(gt) = item[tag..].find('>') else { break };
            let body = tag + gt + 1;
            if item.as_bytes()[tag + gt - 1] == b'/' {
                at = body;
                continue;
            }
            let Some(end) = item[body..].find("</t>") else { break };
            text.push_str(&item[body..body + end]);
            at = body + end + 4;
        }
        out.push(text);
        from = start + close + 5;
    }
    out
}

/// The value of attribute `name` in one element's text.
fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!(" {}=\"", name);
    let at = tag.find(&needle)? + needle.len();
    let end = tag[at..].find('"')?;
    Some(&tag[at..at + end])
}

/// Every `<f t="dataTable" .../>` of one sheet part, with the cell it sits on.
pub(crate) fn parse_sheet_data_tables(sheet_xml: &str) -> Vec<XmlDataTable> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(found) = sheet_xml[from..].find("<f ") {
        let at = from + found;
        from = at + 3;
        let Some(end) = sheet_xml[at..].find('>') else { break };
        let tag = &sheet_xml[at..at + end];
        if attribute(tag, "t") != Some("dataTable") {
            continue;
        }
        let Some(c_at) = sheet_xml[..at].rfind("<c ") else { continue };
        let Some(c_end) = sheet_xml[c_at..].find('>') else { continue };
        let cell_tag = &sheet_xml[c_at..c_at + c_end];
        let Some(top_left) = attribute(cell_tag, "r").and_then(parse_a1) else { continue };
        let bottom_right = attribute(tag, "ref")
            .and_then(|r| r.split(':').nth(1).or(Some(r)))
            .and_then(parse_a1)
            .unwrap_or(top_left);
        let flag = |name: &str| matches!(attribute(tag, name), Some("1") | Some("true"));
        // A deleted input cell (`del1` / `del2`) cannot be stated as a marker.
        if flag("del1") || flag("del2") {
            continue;
        }
        let r1 = attribute(tag, "r1").and_then(parse_a1);
        let r2 = attribute(tag, "r2").and_then(parse_a1);
        let (row_input, col_input) = if flag("dt2D") {
            (r1, r2)
        } else if flag("dtr") {
            (r1, None)
        } else {
            (None, r1)
        };
        if row_input.is_none() && col_input.is_none() {
            continue;
        }
        if bottom_right.0 < top_left.0 || bottom_right.1 < top_left.1 {
            continue;
        }
        out.push(XmlDataTable { top_left, bottom_right, row_input, col_input });
    }
    out
}

/// THE READER'S HALF: every data table of every sheet part back into the
/// `TABLE(..)` marker over its body, keeping the values the file cached (the
/// body's last computed answers; calamine read them as plain values). A body
/// cell the file left empty is 0, as Excel shows it.
pub(crate) fn read_data_tables<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    sheet_paths: &[(usize, String)],
    sheet_names: &[String],
    wb: &mut Workbook,
) {
    use std::io::Read;
    for (position, sheet_path) in sheet_paths {
        let Some(sheet_name) = position.checked_sub(1).and_then(|p| sheet_names.get(p)) else { continue };
        let Some(sheet_index) = wb.sheets.iter().position(|s| &s.name == sheet_name) else { continue };
        let xml = {
            let Ok(mut entry) = archive.by_name(sheet_path) else { continue };
            let mut text = String::new();
            if entry.read_to_string(&mut text).is_err() {
                continue;
            }
            text
        };
        if !xml.contains("dataTable") {
            continue;
        }
        let cells = &mut wb.sheets[sheet_index].cells;
        let tables = parse_sheet_data_tables(&xml);
        let markers = markers_for(&tables);
        for (t, formula) in tables.into_iter().zip(markers) {
            for r in t.top_left.0..=t.bottom_right.0 {
                for c in t.top_left.1..=t.bottom_right.1 {
                    let cell = cells.entry((r, c)).or_insert_with(|| SavedCell {
                        value: SavedCellValue::Number(0.0),
                        formula: None,
                        style_index: 0,
                        rich_text: None,
                        spill: None,
                    });
                    if matches!(cell.value, SavedCellValue::Empty) {
                        cell.value = SavedCellValue::Number(0.0);
                    }
                    cell.formula = Some(formula.clone());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXCEL_SHEET: &str = r#"<sheetData><row r="1"><c r="L1"><f>B1</f><v>4</v></c></row><row r="2"><c r="K2"><v>11</v></c><c r="L2"><f t="dataTable" ref="L2:L3" dt2D="0" dtr="0" r1="A1" ca="1"/><v>22</v></c><c r="Q2"><f t="dataTable" ref="Q2:R2" dt2D="0" dtr="1" r1="A1" ca="1"/><v>4</v></c><c r="R2"><v>6</v></c><c r="U2"><f t="dataTable" ref="U2:V3" dt2D="1" dtr="1" r1="A1" r2="D1"/><v>20</v></c></row></sheetData>"#;

    /// Excel's own sheet part [LIVE, whatifcalc/probe1's dt1.xlsx]: the three
    /// orientations read back as Calcula's marker.
    #[test]
    fn excels_data_table_elements_parse_in_every_orientation() {
        let tables = parse_sheet_data_tables(EXCEL_SHEET);
        assert_eq!(
            tables,
            vec![
                XmlDataTable { top_left: (1, 11), bottom_right: (2, 11), row_input: None, col_input: Some((0, 0)) },
                XmlDataTable { top_left: (1, 16), bottom_right: (1, 17), row_input: Some((0, 0)), col_input: None },
                XmlDataTable { top_left: (1, 20), bottom_right: (2, 21), row_input: Some((0, 0)), col_input: Some((0, 3)) },
            ]
        );
        assert_eq!(marker_formula(None, Some((0, 0))), "=TABLE(,A1)");
        assert_eq!(marker_formula(Some((0, 0)), Some((0, 3))), "=TABLE(A1,D1)");
    }

    /// The writer's element is Excel's, on the top-left cell, before its value.
    ///
    /// SABOTAGE: swap `dtr` for the row-input orientation -- fails at the
    /// `Q2` assertion.
    #[test]
    fn the_writer_states_each_table_as_excel_does() {
        let library = r#"<row r="2"><c r="L2"><v>10</v></c><c r="L3"><v>14</v></c><c r="Q2" s="1"/></row>"#;
        let col = XmlDataTable { top_left: (1, 11), bottom_right: (2, 11), row_input: None, col_input: Some((0, 0)) };
        let row = XmlDataTable { top_left: (1, 16), bottom_right: (1, 17), row_input: Some((0, 0)), col_input: None };
        let xml = with_data_table_formulas(library, &[col.clone(), row.clone()]).unwrap();
        assert!(
            xml.contains(r#"<c r="L2"><f t="dataTable" ref="L2:L3" dt2D="0" dtr="0" r1="A1" ca="1"/><v>10</v></c>"#),
            "{}",
            xml
        );
        assert!(xml.contains(r#"<c r="Q2" s="1"><f t="dataTable" ref="Q2:R2" dt2D="0" dtr="1" r1="A1" ca="1"/></c>"#), "Q2: {}", xml);
        assert_eq!(parse_sheet_data_tables(&xml), vec![col, row], "the writer's output reads back");
        let two = XmlDataTable { top_left: (1, 20), bottom_right: (2, 21), row_input: Some((0, 0)), col_input: Some((0, 3)) };
        assert_eq!(formula_element(&two), r#"<f t="dataTable" ref="U2:V3" dt2D="1" dtr="1" r1="A1" r2="D1"/>"#);
    }

    /// rev-dt-12: a TEXT result on a table's top-left cell is a formula's
    /// string, which OOXML writes inline (`t="str"`, the text in `<v>`), never
    /// as a shared-string index (`t="s"`), which is a constant's form.
    /// SABOTAGE: skip the conversion in `with_data_table_formulas_using`.
    #[test]
    fn a_text_result_on_the_top_left_cell_is_written_as_a_formula_string() {
        let library = r#"<row r="2"><c r="L2" s="2" t="s"><v>1</v></c><c r="L3"><v>14</v></c></row>"#;
        let shared = shared_string_texts(r#"<sst count="2" uniqueCount="2"><si><t>first</t></si><si><t xml:space="preserve">a &amp; b</t></si></sst>"#);
        assert_eq!(shared, vec!["first".to_string(), "a &amp; b".to_string()]);
        let col = XmlDataTable { top_left: (1, 11), bottom_right: (2, 11), row_input: None, col_input: Some((0, 0)) };
        let xml = with_data_table_formulas_using(library, &[col.clone()], &shared).unwrap();
        assert!(
            xml.contains(r#"<c r="L2" s="2" t="str"><f t="dataTable" ref="L2:L3" dt2D="0" dtr="0" r1="A1" ca="1"/><v>a &amp; b</v></c>"#),
            "{}",
            xml
        );
        assert_eq!(parse_sheet_data_tables(&xml), vec![col], "the rewritten part reads back");
    }

    /// rev-xlsx-5: Excel's two touching tables with the same input (K1:L3 and
    /// L1:M3, column input A1 -- the second's input column is the first's body)
    /// read back as TWO tables: the second's marker names its identity, and the
    /// writer finds both again.
    /// SABOTAGE: make `markers_for` write every table's plain marker.
    #[test]
    fn touching_tables_from_excel_stay_two_tables() {
        let xml = r#"<sheetData><row r="2"><c r="L2"><f t="dataTable" ref="L2:L3" dt2D="0" dtr="0" r1="A1"/><v>10</v></c><c r="M2"><f t="dataTable" ref="M2:M3" dt2D="0" dtr="0" r1="A1"/><v>1000</v></c></row></sheetData>"#;
        let tables = parse_sheet_data_tables(xml);
        let markers = markers_for(&tables);
        assert_eq!(markers, vec!["=TABLE(,A1)".to_string(), "=TABLE(,A1,M2)".to_string()], "MERGED: one call for both");
        let mut cells = HashMap::new();
        for (t, m) in tables.iter().zip(&markers) {
            for r in t.top_left.0..=t.bottom_right.0 {
                cells.insert((r, t.top_left.1), with_formula(1.0, m));
            }
        }
        let found = tables_on(&cells);
        assert_eq!(found, tables, "the writer finds the two tables again");
    }

    fn num(n: f64) -> SavedCell {
        SavedCell { value: SavedCellValue::Number(n), formula: None, style_index: 0, rich_text: None, spill: None }
    }

    fn with_formula(n: f64, f: &str) -> SavedCell {
        SavedCell { formula: Some(f.to_string()), ..num(n) }
    }

    /// probe1's sheet: a one-variable table K1:L3 (column input A1) and a
    /// two-variable table T1:V3 (row input A1, column input D1).
    fn probe_workbook() -> Workbook {
        let mut workbook = Workbook::new();
        let cells = &mut workbook.sheets[0].cells;
        cells.insert((0, 0), num(1.0)); // A1
        cells.insert((0, 1), with_formula(2.0, "=A1*2")); // B1
        cells.insert((0, 2), with_formula(1.0, "=A1*D1")); // C1
        cells.insert((0, 3), num(1.0)); // D1
        cells.insert((1, 10), num(5.0)); // K2
        cells.insert((2, 10), num(7.0)); // K3
        cells.insert((0, 11), with_formula(2.0, "=B1")); // L1
        cells.insert((1, 11), with_formula(10.0, "=TABLE(,A1)")); // L2
        cells.insert((2, 11), with_formula(14.0, "=TABLE(,A1)")); // L3
        cells.insert((0, 19), with_formula(1.0, "=C1")); // T1
        cells.insert((0, 20), num(2.0)); // U1
        cells.insert((0, 21), num(3.0)); // V1
        cells.insert((1, 19), num(10.0)); // T2
        cells.insert((2, 19), num(20.0)); // T3
        for (r, c, v) in [(1, 20, 20.0), (1, 21, 30.0), (2, 20, 40.0), (2, 21, 60.0)] {
            cells.insert((r, c), with_formula(v, "=TABLE(A1,D1)"));
        }
        workbook
    }

    /// THE WHOLE ROUND TRIP through the real writer and reader: the body
    /// leaves as Excel's `<f t="dataTable">` on its top-left cell with values
    /// under it (no `<f>TABLE(..)</f>`, which Excel cannot open), and comes back
    /// as the marker over the whole body with the cached values.
    ///
    /// With `CALCULA_DATA_TABLE_XLSX` set, the file is also written there, for
    /// the live-Excel check (whatifcalc/probe4.ps1 opens it in Excel 16).
    ///
    /// SABOTAGE: skip `finish_with_data_tables` in `save_xlsx_reporting_losses`
    /// -- fails at "NO dataTable".
    #[test]
    fn a_data_table_round_trips_through_xlsx_as_excel_writes_it() {
        let workbook = probe_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dt.xlsx");
        crate::xlsx_writer::save_xlsx(&workbook, &path).unwrap();
        if let Ok(copy) = std::env::var("CALCULA_DATA_TABLE_XLSX") {
            std::fs::copy(&path, copy).unwrap();
        }
        let xml = {
            use std::io::Read;
            let mut zip = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
            let mut text = String::new();
            zip.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut text).unwrap();
            text
        };
        assert!(
            xml.contains(r#"<f t="dataTable" ref="L2:L3" dt2D="0" dtr="0" r1="A1" ca="1"/>"#),
            "NO dataTable element for L2:L3: {}",
            xml
        );
        assert!(xml.contains(r#"<f t="dataTable" ref="U2:V3" dt2D="1" dtr="1" r1="A1" r2="D1"/>"#), "{}", xml);
        assert!(!xml.contains("TABLE("), "a TABLE(..) formula text reached the file: {}", xml);

        let back = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let cells = &back.sheets[0].cells;
        for (r, c, f, v) in [
            (1, 11, "=TABLE(,A1)", 10.0),
            (2, 11, "=TABLE(,A1)", 14.0),
            (1, 20, "=TABLE(A1,D1)", 20.0),
            (2, 21, "=TABLE(A1,D1)", 60.0),
        ] {
            let cell = cells.get(&(r, c)).unwrap_or_else(|| panic!("({r},{c}) came back"));
            assert_eq!(cell.formula.as_deref(), Some(f), "({r},{c})");
            assert!(matches!(cell.value, SavedCellValue::Number(n) if n == v), "({r},{c}) = {:?}", cell.value);
        }
        assert_eq!(cells.get(&(0, 11)).and_then(|c| c.formula.as_deref()), Some("=B1"), "the header formula stays");
    }

    #[test]
    fn tables_are_found_from_the_saved_markers() {
        let mut cells = HashMap::new();
        for r in 1..=2 {
            cells.insert(
                (r, 11),
                SavedCell {
                    value: SavedCellValue::Number(r as f64),
                    formula: Some("=TABLE(,A1)".to_string()),
                    style_index: 0,
                    rich_text: None,
                    spill: None,
                },
            );
        }
        assert_eq!(
            tables_on(&cells),
            vec![XmlDataTable { top_left: (1, 11), bottom_right: (2, 11), row_input: None, col_input: Some((0, 0)) }]
        );
    }
}
