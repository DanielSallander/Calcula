//! FILENAME: core/persistence/src/xlsx_named_styles.rs
//!
//! A workbook's CUSTOM named cell styles written into an .xlsx's
//! `xl/styles.xml` (BUG-0771): one `<cellStyleXfs>` record and one
//! `<cellStyles><cellStyle>` per style, its IncludeProtection as Excel
//! spells it. The reader's half is `xlsx_reader::named_styles_of`.
//!
//! [LIVE, Excel 16, 2026-11-06, lane xlsx probe3] Excel saves a style made
//! with `IncludeProtection = False` (Locked off) as
//! `<cellStyleXfs ..><xf numFmtId="0" fontId="3" fillId="0" borderId="0"
//! applyProtection="0"><protection locked="0"/></xf>` and
//! `<cellStyle name="NoProt" xfId="2"/>`, one with it True (Locked off,
//! Formula Hidden on) with no `applyProtection` and
//! `<protection locked="0" hidden="1"/>`.
//!
//! The library (rust_xlsxwriter 0.79.4) writes only `Normal`. A style's look
//! is the look of a cell that uses it: its `cellXfs` record's font, fill,
//! border, number format and alignment, which the library has already
//! written. A style NO cell uses gets a record of its own, registered with
//! the library before any cell's (`register_unused_styles`), and that record
//! is copied; only one the file still cannot hold is left out, and said
//! (`XlsxExportLosses::named_styles`).

use crate::Workbook;
use engine::style::CellStyle;

/// One custom named style as the app saves it (`named_styles.json`).
pub(crate) struct NamedStyle {
    pub(crate) name: String,
    style: CellStyle,
    include_protection: Option<bool>,
}

/// The workbook's custom named styles, from the app's `named_styles.json`.
pub(crate) fn named_styles(workbook: &Workbook) -> Vec<NamedStyle> {
    let Some(bytes) = workbook.user_files.get("named_styles.json") else { return Vec::new() };
    let Ok(rows) = serde_json::from_slice::<Vec<serde_json::Value>>(bytes) else { return Vec::new() };
    rows.into_iter()
        .filter_map(|row| {
            Some(NamedStyle {
                name: row.get("name")?.as_str()?.to_string(),
                style: serde_json::from_value(row.get("style")?.clone()).ok()?,
                include_protection: row.get("includeProtection").and_then(serde_json::Value::as_bool),
            })
        })
        .filter(|s| !s.name.is_empty())
        .collect()
}

/// Where a cell using `style` was written: (worksheet part, `A1` address).
fn cell_using(workbook: &Workbook, style: &CellStyle) -> Option<(String, String)> {
    for (position, sheet) in workbook.sheets.iter().enumerate() {
        let mut cells: Vec<&(u32, u32)> = sheet
            .cells
            .iter()
            .filter(|(_, c)| c.style_index != 0 && sheet.styles.get(c.style_index) == Some(style))
            .map(|(at, _)| at)
            .collect();
        cells.sort();
        if let Some(&&(row, col)) = cells.first() {
            return Some((format!("xl/worksheets/sheet{}.xml", position + 1), crate::xlsx_autofilter::a1_address(row, col)));
        }
    }
    None
}

/// Every custom named style NO cell uses, registered with the writer (its
/// Format, through the library's `register_format`) BEFORE any cell's, so
/// the `cellXfs` index the library gives it is known: the default format is
/// 0, and each distinct Format registered takes the next. Returns style name
/// -> `cellXfs` index. [LIVE, Excel 16, 2026-11-06, lane tabxlsx probe1]
/// Excel saves an unused style "Unused" (bold, yellow fill, `0.0`) as its
/// own `<cellStyleXfs>` record `<xf numFmtId="164" fontId="2" fillId="3"
/// borderId="0"/>` and `<cellStyle name="Unused" xfId="1"/>`, its font, fill
/// and number format in the same lists as every cell's (W2 xlsx: such a
/// style was left out, there being no cell record to copy).
pub(crate) fn register_unused_styles(
    workbook: &Workbook,
    register: &mut dyn FnMut(&CellStyle) -> rust_xlsxwriter::Format,
) -> std::collections::HashMap<String, usize> {
    let mut out = std::collections::HashMap::new();
    let mut seen: Vec<rust_xlsxwriter::Format> = vec![rust_xlsxwriter::Format::default()];
    for named in named_styles(workbook) {
        if cell_using(workbook, &named.style).is_some() {
            continue;
        }
        let format = register(&named.style);
        let index = match seen.iter().position(|f| *f == format) {
            Some(i) => i,
            None => {
                seen.push(format);
                seen.len() - 1
            }
        };
        out.insert(named.name, index);
    }
    out
}

/// The `s` index of the cell `address` in a worksheet part.
fn style_index_of(sheet_xml: &str, address: &str) -> Option<usize> {
    let at = sheet_xml.find(&format!("<c r=\"{}\"", address))?;
    let tag = &sheet_xml[at..at + sheet_xml[at..].find('>')?];
    let s = tag.find(" s=\"").map(|i| &tag[i + 4..])?;
    s[..s.find('"')?].parse().ok()
}

/// The `n`-th `<xf>` record (with its children) inside `<{list}>`.
fn nth_record(styles_xml: &str, list: &str, n: usize) -> Option<String> {
    let start = styles_xml.find(&format!("<{} ", list)).or_else(|| styles_xml.find(&format!("<{}>", list)))?;
    let end = start + styles_xml[start..].find(&format!("</{}>", list))?;
    let mut rest = &styles_xml[start..end];
    let mut index = 0;
    while let Some(at) = rest.find("<xf ").or_else(|| rest.find("<xf>")) {
        rest = &rest[at..];
        let open_end = rest.find('>')?;
        let record_end = if rest[..open_end].ends_with('/') { open_end + 1 } else { rest.find("</xf>")? + "</xf>".len() };
        if index == n {
            return Some(rest[..record_end].to_string());
        }
        index += 1;
        rest = &rest[record_end..];
    }
    None
}

fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let at = tag.find(&format!(" {}=\"", name))? + name.len() + 3;
    Some(&tag[at..at + tag[at..].find('"')?])
}

fn xml_attr(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The finished archive with every custom named style the workbook holds
/// written into `xl/styles.xml`, and the styles it could not write (no cell
/// uses them). `None` when the workbook has no custom named style.
pub(crate) fn finish_with_named_styles(
    xlsx: &[u8],
    workbook: &Workbook,
    unused: &std::collections::HashMap<String, usize>,
) -> Result<Option<(Vec<u8>, Vec<String>)>, crate::PersistenceError> {
    use std::io::{Read, Write};
    let styles = named_styles(workbook);
    if styles.is_empty() {
        return Ok(None);
    }
    let invalid = |e: zip::result::ZipError| crate::PersistenceError::InvalidFormat(format!("xlsx named styles: {}", e));
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(xlsx)).map_err(invalid)?;
    let mut read = |name: &str| -> Option<String> {
        let mut entry = archive.by_name(name).ok()?;
        let mut text = String::new();
        entry.read_to_string(&mut text).ok()?;
        Some(text)
    };
    let Some(mut styles_xml) = read("xl/styles.xml") else { return Ok(None) };
    let mut parts: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut records: Vec<String> = Vec::new();
    let mut entries: Vec<String> = Vec::new();
    let mut lost: Vec<String> = Vec::new();
    let base = styles_xml
        .find("<cellStyleXfs count=\"")
        .and_then(|at| attribute(&styles_xml[at..], "count"))
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(1);
    for named in &styles {
        let found = match cell_using(workbook, &named.style) {
            Some((part, address)) => {
                if !parts.contains_key(&part) {
                    if let Some(xml) = read(&part) {
                        parts.insert(part.clone(), xml);
                    }
                }
                parts
                    .get(&part)
                    .and_then(|xml| style_index_of(xml, &address))
                    .and_then(|index| nth_record(&styles_xml, "cellXfs", index))
            }
            // A style no cell uses: the record `register_unused_styles` gave it.
            None => unused.get(&named.name).and_then(|index| nth_record(&styles_xml, "cellXfs", *index)),
        };
        let Some(cell_record) = found else {
            lost.push(named.name.clone());
            continue;
        };
        let open = &cell_record[..cell_record.find('>').unwrap_or(cell_record.len())];
        let ids = ["numFmtId", "fontId", "fillId", "borderId"]
            .iter()
            .map(|k| format!(" {}=\"{}\"", k, attribute(open, k).unwrap_or("0")))
            .collect::<String>();
        let alignment = cell_record
            .find("<alignment")
            .map(|at| cell_record[at..at + cell_record[at..].find("/>").map_or(0, |e| e + 2)].to_string())
            .unwrap_or_default();
        let protection = match (named.style.locked, named.style.formula_hidden) {
            (true, false) => String::new(),
            (true, true) => "<protection hidden=\"1\"/>".to_string(),
            (false, false) => "<protection locked=\"0\"/>".to_string(),
            (false, true) => "<protection locked=\"0\" hidden=\"1\"/>".to_string(),
        };
        let apply = if named.include_protection == Some(false) { " applyProtection=\"0\"" } else { "" };
        let children = format!("{}{}", alignment, protection);
        records.push(if children.is_empty() {
            format!("<xf{}{}/>", ids, apply)
        } else {
            format!("<xf{}{}>{}</xf>", ids, apply, children)
        });
        entries.push(format!("<cellStyle name=\"{}\" xfId=\"{}\"/>", xml_attr(&named.name), base + records.len() - 1));
    }
    if records.is_empty() {
        return Ok(Some((xlsx.to_vec(), lost)));
    }
    // `<cellStyleXfs count="1">..</cellStyleXfs>` and `<cellStyles count="1">..`
    // as the library writes them: append, and count.
    let append = |xml: &mut String, list: &str, items: &[String]| -> bool {
        let Some(start) = xml.find(&format!("<{} count=\"", list)) else { return false };
        let Some(close) = xml[start..].find(&format!("</{}>", list)).map(|c| start + c) else { return false };
        let count_at = start + list.len() + 9;
        let Some(count_end) = xml[count_at..].find('"').map(|e| count_at + e) else { return false };
        let Ok(count) = xml[count_at..count_end].parse::<usize>() else { return false };
        xml.insert_str(close, &items.concat());
        xml.replace_range(count_at..count_end, &(count + items.len()).to_string());
        true
    };
    if !append(&mut styles_xml, "cellStyleXfs", &records) || !append(&mut styles_xml, "cellStyles", &entries) {
        return Ok(Some((xlsx.to_vec(), styles.iter().map(|s| s.name.clone()).collect())));
    }
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let deflated = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(xlsx)).map_err(invalid)?;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(invalid)?;
        if entry.name() == "xl/styles.xml" {
            drop(entry);
            out.start_file("xl/styles.xml", deflated).map_err(invalid)?;
            out.write_all(styles_xml.as_bytes())?;
        } else {
            out.raw_copy_file(entry).map_err(invalid)?;
        }
    }
    Ok(Some((out.finish().map_err(invalid)?.into_inner(), lost)))
}

#[cfg(test)]
#[path = "xlsx_named_styles_tests.rs"]
mod tests;
