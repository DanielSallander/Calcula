//! FILENAME: core/persistence/src/xlsx_style_reader.rs
//! PURPOSE: Parse XLSX style and metadata XML that calamine does not expose.
//! CONTEXT: An XLSX file is a ZIP archive. After calamine reads cell values,
//! this module does a second pass to extract fonts, fills, borders, number
//! formats, cell style indices, merge cells, column widths, row heights,
//! and freeze panes from the raw XML inside the archive.

use engine::style::{
    BorderLineStyle, BorderStyle, Borders, CellStyle, Color, CurrencyPosition, Fill,
    NumberFormat, PatternType, TextAlign, TextRotation, UnderlineStyle, VerticalAlign,
};
use engine::theme::ThemeColor;
use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

// ============================================================================
// Public result types
// ============================================================================

/// All style-related data extracted from the XLSX archive.
#[derive(Debug, Default)]
pub struct XlsxStyleData {
    /// Parsed fonts from xl/styles.xml <fonts>
    pub fonts: Vec<ParsedFont>,
    /// Parsed fills from xl/styles.xml <fills>
    pub fills: Vec<ParsedFill>,
    /// Parsed borders from xl/styles.xml <borders>
    pub borders: Vec<ParsedBorder>,
    /// Number format strings keyed by id from xl/styles.xml <numFmts>
    pub number_formats: HashMap<u32, String>,
    /// Cell XF records: (font_idx, fill_idx, border_idx, numfmt_id, alignment)
    pub cell_xfs: Vec<ParsedXf>,
    /// Per-sheet metadata, keyed by 1-based sheet index
    pub sheet_meta: HashMap<usize, SheetMeta>,
}

/// Font properties parsed from <font> elements.
#[derive(Debug, Clone, Default)]
pub struct ParsedFont {
    pub bold: bool,
    pub italic: bool,
    pub underline: UnderlineStyle,
    pub strikethrough: bool,
    pub size: u8,
    pub color: Option<Color>,
    pub name: String,
}

/// Fill properties parsed from <fill> elements.
#[derive(Debug, Clone, Default)]
pub struct ParsedFill {
    pub pattern_type: String,
    pub fg_color: Option<Color>,
    pub bg_color: Option<Color>,
}

/// Border properties parsed from <border> elements.
#[derive(Debug, Clone, Default)]
pub struct ParsedBorder {
    pub left: ParsedBorderEdge,
    pub right: ParsedBorderEdge,
    pub top: ParsedBorderEdge,
    pub bottom: ParsedBorderEdge,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedBorderEdge {
    pub style: String,
    pub color: Option<Color>,
}

/// Alignment data from a <xf> element's <alignment> child.
#[derive(Debug, Clone, Default)]
pub struct ParsedAlignment {
    pub horizontal: String,
    pub vertical: String,
    pub wrap_text: bool,
    pub text_rotation: u16,
    pub indent: u8,
    pub shrink_to_fit: bool,
}

/// A cell XF record combining indices into fonts/fills/borders/numFmts.
#[derive(Debug, Clone, Default)]
pub struct ParsedXf {
    pub font_id: usize,
    pub fill_id: usize,
    pub border_id: usize,
    pub num_fmt_id: u32,
    pub alignment: ParsedAlignment,
    pub apply_font: bool,
    pub apply_fill: bool,
    pub apply_border: bool,
    pub apply_number_format: bool,
    pub apply_alignment: bool,
}

/// Per-sheet metadata that calamine doesn't provide.
#[derive(Debug, Clone, Default)]
pub struct SheetMeta {
    /// Cell style index per (row, col)
    pub cell_styles: HashMap<(u32, u32), u32>,
    /// Merged cell ranges as (start_row, start_col, end_row, end_col)
    pub merge_cells: Vec<(u32, u32, u32, u32)>,
    /// Custom column widths keyed by 0-based column index (in pixels, converted from Excel character widths)
    pub column_widths: HashMap<u32, f64>,
    /// Custom row heights keyed by 0-based row index (in pixels, converted from Excel points)
    pub row_heights: HashMap<u32, f64>,
    /// Freeze pane position (frozen_rows, frozen_cols)
    pub freeze_pane: Option<(u32, u32)>,
    /// Hidden columns (0-based)
    pub hidden_columns: Vec<u32>,
    /// Hidden rows (0-based)
    pub hidden_rows: Vec<u32>,
}

// ============================================================================
// Main entry point
// ============================================================================

/// Parse style and metadata from an XLSX file.
/// Returns None if the ZIP cannot be opened or the required XML files are missing.
pub fn parse_xlsx_styles(path: &Path) -> Option<XlsxStyleData> {
    let file = std::fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;

    let mut data = XlsxStyleData::default();

    // Parse xl/styles.xml
    if let Ok(styles_xml) = read_zip_entry(&mut archive, "xl/styles.xml") {
        parse_styles_xml(&styles_xml, &mut data);
    }

    // Build logical sheet order → XML path mapping via workbook.xml + rels
    let logical_sheet_paths = build_sheet_path_mapping(&mut archive);

    if !logical_sheet_paths.is_empty() {
        // Use the relationship-based mapping (1-based logical index → path)
        for (logical_idx, sheet_path) in &logical_sheet_paths {
            if let Ok(sheet_xml) = read_zip_entry(&mut archive, sheet_path) {
                let meta = parse_sheet_xml(&sheet_xml);
                data.sheet_meta.insert(*logical_idx, meta);
            }
        }
    } else {
        // Fallback: enumerate sheet XML files by filename number
        let mut sheet_paths: Vec<(usize, String)> = Vec::new();
        for i in 0..archive.len() {
            if let Ok(entry) = archive.by_index(i) {
                let name = entry.name().to_string();
                if let Some(num) = extract_sheet_number(&name) {
                    sheet_paths.push((num, name));
                }
            }
        }
        sheet_paths.sort_by_key(|(n, _)| *n);

        for (sheet_num, sheet_path) in &sheet_paths {
            if let Ok(sheet_xml) = read_zip_entry(&mut archive, sheet_path) {
                let meta = parse_sheet_xml(&sheet_xml);
                data.sheet_meta.insert(*sheet_num, meta);
            }
        }
    }

    Some(data)
}

/// Build mapping from logical sheet order (1-based) to sheet XML path
/// by parsing xl/workbook.xml and xl/_rels/workbook.xml.rels.
fn build_sheet_path_mapping(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> Vec<(usize, String)> {
    // Step 1: Parse relationships to get rId → Target path
    let rels_xml = match read_zip_entry(archive, "xl/_rels/workbook.xml.rels") {
        Ok(xml) => xml,
        Err(_) => return Vec::new(),
    };
    let mut rid_to_target: HashMap<String, String> = HashMap::new();
    {
        let mut reader = Reader::from_str(&rels_xml);
        reader.trim_text(true);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Eof) => break,
                Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                    let local = e.local_name();
                    let tag = std::str::from_utf8(local.as_ref()).unwrap_or("");
                    if tag == "Relationship" {
                        let id = get_attr(e, "Id").unwrap_or_default();
                        let target = get_attr(e, "Target").unwrap_or_default();
                        let rel_type = get_attr(e, "Type").unwrap_or_default();
                        if rel_type.contains("worksheet") && !id.is_empty() {
                            // Target is relative to xl/, e.g., "worksheets/sheet1.xml"
                            rid_to_target.insert(id, format!("xl/{}", target));
                        }
                    }
                }
                Err(_) => break,
                _ => {}
            }
            buf.clear();
        }
    }

    if rid_to_target.is_empty() {
        return Vec::new();
    }

    // Step 2: Parse workbook.xml to get sheet order and rId references
    let wb_xml = match read_zip_entry(archive, "xl/workbook.xml") {
        Ok(xml) => xml,
        Err(_) => return Vec::new(),
    };
    let mut result: Vec<(usize, String)> = Vec::new();
    let mut logical_idx: usize = 0;
    {
        let mut reader = Reader::from_str(&wb_xml);
        reader.trim_text(true);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Eof) => break,
                Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                    let local = e.local_name();
                    let tag = std::str::from_utf8(local.as_ref()).unwrap_or("");
                    if tag == "sheet" {
                        logical_idx += 1;
                        // Get r:id attribute (may be "r:id" or just "id" depending on namespace)
                        let rid = get_attr(e, "r:id")
                            .or_else(|| {
                                // Try with namespace prefix variations
                                for attr in e.attributes().flatten() {
                                    let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                                    if key.ends_with(":id") || key == "r:id" {
                                        return std::str::from_utf8(&attr.value)
                                            .ok()
                                            .map(|s| s.to_string());
                                    }
                                }
                                None
                            })
                            .unwrap_or_default();
                        if let Some(path) = rid_to_target.get(&rid) {
                            result.push((logical_idx, path.clone()));
                        }
                    }
                }
                Err(_) => break,
                _ => {}
            }
            buf.clear();
        }
    }

    result
}

/// Read a file entry from the ZIP archive as a UTF-8 string.
fn read_zip_entry(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<String, ()> {
    let mut entry = archive.by_name(name).map_err(|_| ())?;
    let mut buf = String::new();
    entry.read_to_string(&mut buf).map_err(|_| ())?;
    Ok(buf)
}

/// Extract the sheet number from a path like "xl/worksheets/sheet3.xml" -> 3
fn extract_sheet_number(path: &str) -> Option<usize> {
    let lower = path.to_lowercase();
    if !lower.starts_with("xl/worksheets/sheet") || !lower.ends_with(".xml") {
        return None;
    }
    let stem = &path["xl/worksheets/sheet".len()..path.len() - 4];
    stem.parse::<usize>().ok()
}

// ============================================================================
// xl/styles.xml parser
// ============================================================================

fn parse_styles_xml(xml: &str, data: &mut XlsxStyleData) {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);

    let mut buf = Vec::new();
    let mut context = StyleParseContext::None;

    // Nested element tracking
    let mut current_font = ParsedFont::default();
    let mut current_fill = ParsedFill::default();
    let mut current_border = ParsedBorder::default();
    let mut current_border_edge = String::new();
    let mut current_xf = ParsedXf::default();
    let mut in_cell_xfs = false;
    let mut xf_depth = 0u32;

    loop {
        // Read event and track whether it's self-closing (Empty).
        // Self-closing elements like <xf .../> fire Empty but NOT End,
        // so container elements must be pushed immediately.
        let event = reader.read_event_into(&mut buf);
        let is_empty = matches!(&event, Ok(Event::Empty(_)));

        match event {
            Ok(Event::Eof) => break,
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let tag = e.local_name();
                let tag_str = std::str::from_utf8(tag.as_ref()).unwrap_or("");

                match tag_str {
                    "numFmt" => {
                        let mut id = 0u32;
                        let mut code = String::new();
                        for attr in e.attributes().flatten() {
                            let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                            let val = std::str::from_utf8(&attr.value).unwrap_or("");
                            match key {
                                "numFmtId" => id = val.parse().unwrap_or(0),
                                "formatCode" => code = val.to_string(),
                                _ => {}
                            }
                        }
                        if id > 0 || !code.is_empty() {
                            data.number_formats.insert(id, code);
                        }
                    }
                    "fonts" => context = StyleParseContext::Fonts,
                    "font" if matches!(context, StyleParseContext::Fonts) => {
                        current_font = ParsedFont {
                            size: 11,
                            name: "Calibri".to_string(),
                            ..Default::default()
                        };
                        // Self-closing <font/> — push immediately
                        if is_empty {
                            data.fonts.push(current_font.clone());
                            current_font = ParsedFont::default();
                        }
                    }
                    "b" if matches!(context, StyleParseContext::Fonts) => {
                        // <b/> or <b val="1"> means bold; <b val="0"> means NOT bold
                        let val = get_attr(e, "val");
                        current_font.bold = val.as_deref() != Some("0") && val.as_deref() != Some("false");
                    }
                    "i" if matches!(context, StyleParseContext::Fonts) => {
                        let val = get_attr(e, "val");
                        current_font.italic = val.as_deref() != Some("0") && val.as_deref() != Some("false");
                    }
                    "u" if matches!(context, StyleParseContext::Fonts) => {
                        let val_attr = get_attr(e, "val");
                        current_font.underline = match val_attr.as_deref() {
                            Some("double") => UnderlineStyle::Double,
                            Some("singleAccounting") => UnderlineStyle::SingleAccounting,
                            Some("doubleAccounting") => UnderlineStyle::DoubleAccounting,
                            Some("none") => UnderlineStyle::None,
                            _ => UnderlineStyle::Single, // default or "single"
                        };
                    }
                    "strike" if matches!(context, StyleParseContext::Fonts) => {
                        let val = get_attr(e, "val");
                        current_font.strikethrough = val.as_deref() != Some("0") && val.as_deref() != Some("false");
                    }
                    "sz" if matches!(context, StyleParseContext::Fonts) => {
                        if let Some(v) = get_attr(e, "val") {
                            current_font.size = v.parse::<f64>().unwrap_or(11.0) as u8;
                        }
                    }
                    "color" if matches!(context, StyleParseContext::Fonts) => {
                        current_font.color = parse_color_element(e);
                    }
                    "name" if matches!(context, StyleParseContext::Fonts) => {
                        if let Some(v) = get_attr(e, "val") {
                            current_font.name = v;
                        }
                    }
                    "fills" => context = StyleParseContext::Fills,
                    "fill" if matches!(context, StyleParseContext::Fills) => {
                        current_fill = ParsedFill::default();
                        // Self-closing <fill/> — push immediately
                        if is_empty {
                            data.fills.push(current_fill.clone());
                            current_fill = ParsedFill::default();
                        }
                    }
                    "patternFill" if matches!(context, StyleParseContext::Fills) => {
                        if let Some(v) = get_attr(e, "patternType") {
                            current_fill.pattern_type = v;
                        }
                        // Self-closing <patternFill patternType="none"/> is common.
                        // The fill will be pushed when </fill> or empty <fill/> fires.
                    }
                    "fgColor" if matches!(context, StyleParseContext::Fills) => {
                        current_fill.fg_color = parse_color_element(e);
                    }
                    "bgColor" if matches!(context, StyleParseContext::Fills) => {
                        current_fill.bg_color = parse_color_element(e);
                    }
                    "borders" => context = StyleParseContext::Borders,
                    "border" if matches!(context, StyleParseContext::Borders) => {
                        current_border = ParsedBorder::default();
                        // Self-closing <border/> — push immediately
                        if is_empty {
                            data.borders.push(current_border.clone());
                            current_border = ParsedBorder::default();
                        }
                    }
                    "left" | "right" | "top" | "bottom"
                        if matches!(context, StyleParseContext::Borders) =>
                    {
                        current_border_edge = tag_str.to_string();
                        let style = get_attr(e, "style").unwrap_or_default();
                        match current_border_edge.as_str() {
                            "left" => current_border.left.style = style,
                            "right" => current_border.right.style = style,
                            "top" => current_border.top.style = style,
                            "bottom" => current_border.bottom.style = style,
                            _ => {}
                        }
                        // Self-closing border edge like <left/> — clear edge context
                        if is_empty {
                            current_border_edge.clear();
                        }
                    }
                    "color" if matches!(context, StyleParseContext::Borders)
                        && !current_border_edge.is_empty() =>
                    {
                        let c = parse_color_element(e);
                        match current_border_edge.as_str() {
                            "left" => current_border.left.color = c,
                            "right" => current_border.right.color = c,
                            "top" => current_border.top.color = c,
                            "bottom" => current_border.bottom.color = c,
                            _ => {}
                        }
                    }
                    "cellXfs" => {
                        context = StyleParseContext::CellXfs;
                        in_cell_xfs = true;
                    }
                    "xf" if in_cell_xfs => {
                        current_xf = ParsedXf::default();
                        for attr in e.attributes().flatten() {
                            let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                            let val = std::str::from_utf8(&attr.value).unwrap_or("");
                            match key {
                                "fontId" => {
                                    current_xf.font_id = val.parse().unwrap_or(0)
                                }
                                "fillId" => {
                                    current_xf.fill_id = val.parse().unwrap_or(0)
                                }
                                "borderId" => {
                                    current_xf.border_id = val.parse().unwrap_or(0)
                                }
                                "numFmtId" => {
                                    current_xf.num_fmt_id = val.parse().unwrap_or(0)
                                }
                                "applyFont" => {
                                    current_xf.apply_font = val == "1" || val == "true"
                                }
                                "applyFill" => {
                                    current_xf.apply_fill = val == "1" || val == "true"
                                }
                                "applyBorder" => {
                                    current_xf.apply_border = val == "1" || val == "true"
                                }
                                "applyNumberFormat" => {
                                    current_xf.apply_number_format =
                                        val == "1" || val == "true"
                                }
                                "applyAlignment" => {
                                    current_xf.apply_alignment =
                                        val == "1" || val == "true"
                                }
                                _ => {}
                            }
                        }
                        // Self-closing <xf .../> — push immediately (no alignment child)
                        if is_empty {
                            data.cell_xfs.push(current_xf.clone());
                            current_xf = ParsedXf::default();
                            xf_depth = 0;
                        } else {
                            xf_depth = 1;
                        }
                    }
                    "alignment" if in_cell_xfs && xf_depth > 0 => {
                        for attr in e.attributes().flatten() {
                            let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                            let val = std::str::from_utf8(&attr.value).unwrap_or("");
                            match key {
                                "horizontal" => {
                                    current_xf.alignment.horizontal = val.to_string()
                                }
                                "vertical" => {
                                    current_xf.alignment.vertical = val.to_string()
                                }
                                "wrapText" => {
                                    current_xf.alignment.wrap_text =
                                        val == "1" || val == "true"
                                }
                                "textRotation" => {
                                    current_xf.alignment.text_rotation =
                                        val.parse().unwrap_or(0)
                                }
                                "indent" => {
                                    current_xf.alignment.indent =
                                        val.parse().unwrap_or(0)
                                }
                                "shrinkToFit" => {
                                    current_xf.alignment.shrink_to_fit =
                                        val == "1" || val == "true"
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => {
                let tag = e.local_name();
                let tag_str = std::str::from_utf8(tag.as_ref()).unwrap_or("");
                match tag_str {
                    "font" if matches!(context, StyleParseContext::Fonts) => {
                        data.fonts.push(current_font.clone());
                        current_font = ParsedFont::default();
                    }
                    "fonts" => context = StyleParseContext::None,
                    "fill" if matches!(context, StyleParseContext::Fills) => {
                        data.fills.push(current_fill.clone());
                        current_fill = ParsedFill::default();
                    }
                    "fills" => context = StyleParseContext::None,
                    "border" if matches!(context, StyleParseContext::Borders) => {
                        data.borders.push(current_border.clone());
                        current_border = ParsedBorder::default();
                    }
                    "borders" => context = StyleParseContext::None,
                    "left" | "right" | "top" | "bottom"
                        if matches!(context, StyleParseContext::Borders) =>
                    {
                        current_border_edge.clear();
                    }
                    "xf" if in_cell_xfs => {
                        data.cell_xfs.push(current_xf.clone());
                        current_xf = ParsedXf::default();
                        xf_depth = 0;
                    }
                    "cellXfs" => {
                        in_cell_xfs = false;
                        context = StyleParseContext::None;
                    }
                    _ => {}
                }
            }
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
}

#[derive(Debug)]
enum StyleParseContext {
    None,
    Fonts,
    Fills,
    Borders,
    CellXfs,
}

// ============================================================================
// xl/worksheets/sheetN.xml parser
// ============================================================================

fn parse_sheet_xml(xml: &str) -> SheetMeta {
    let mut meta = SheetMeta::default();
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);

    let mut buf = Vec::new();
    let mut in_sheet_views = false;
    let mut in_merge_cells = false;
    let mut in_sheet_data = false;
    let mut current_row: u32 = 0;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let tag = e.local_name();
                let tag_str = std::str::from_utf8(tag.as_ref()).unwrap_or("");

                match tag_str {
                    "sheetViews" => in_sheet_views = true,
                    "pane" if in_sheet_views => {
                        // Freeze pane: <pane xSplit="1" ySplit="2" state="frozen" ...>
                        let state = get_attr(e, "state").unwrap_or_default();
                        if state == "frozen" || state == "frozenSplit" {
                            let x_split: u32 =
                                get_attr(e, "xSplit").and_then(|v| v.parse().ok()).unwrap_or(0);
                            let y_split: u32 =
                                get_attr(e, "ySplit").and_then(|v| v.parse().ok()).unwrap_or(0);
                            if x_split > 0 || y_split > 0 {
                                meta.freeze_pane = Some((y_split, x_split));
                            }
                        }
                    }
                    "sheetData" => in_sheet_data = true,
                    "row" if in_sheet_data => {
                        // Row element: <row r="5" ht="20" customHeight="1" hidden="1">
                        if let Some(r_str) = get_attr(e, "r") {
                            current_row = r_str.parse::<u32>().unwrap_or(1).saturating_sub(1);
                        }
                        // Row height: read whenever ht is present
                        // (customHeight="1" means user-set, but ht without it
                        // still represents the actual rendered height)
                        if let Some(ht_str) = get_attr(e, "ht") {
                            if let Ok(ht) = ht_str.parse::<f64>() {
                                // Excel stores row height in points; convert to pixels (1 pt = 1.333 px)
                                let px = (ht * 1.333).round();
                                // Only store if different from the default (15pt = 20px)
                                // to avoid bloating the map with thousands of default-height rows
                                if (px - 20.0).abs() > 1.0 {
                                    meta.row_heights.insert(current_row, px);
                                }
                            }
                        }
                        // Hidden row
                        if get_attr(e, "hidden").map(|v| v == "1" || v == "true").unwrap_or(false) {
                            meta.hidden_rows.push(current_row);
                        }
                    }
                    "c" if in_sheet_data => {
                        // Cell element: <c r="B3" s="5" t="s">
                        if let Some(r_str) = get_attr(e, "r") {
                            if let Some((row, col)) = parse_cell_ref(&r_str) {
                                if let Some(s_str) = get_attr(e, "s") {
                                    if let Ok(s) = s_str.parse::<u32>() {
                                        meta.cell_styles.insert((row, col), s);
                                    }
                                }
                            }
                        }
                    }
                    "col" => {
                        // <col min="2" max="5" width="15.5" customWidth="1" hidden="1"/>
                        let min: u32 = get_attr(e, "min")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(1);
                        let max: u32 = get_attr(e, "max")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(min);
                        let custom_width = get_attr(e, "customWidth")
                            .map(|v| v == "1" || v == "true")
                            .unwrap_or(false);
                        let hidden = get_attr(e, "hidden")
                            .map(|v| v == "1" || v == "true")
                            .unwrap_or(false);

                        if custom_width {
                            if let Some(w_str) = get_attr(e, "width") {
                                if let Ok(w) = w_str.parse::<f64>() {
                                    // Excel character width -> pixels: w * 7.0 + 5 (approximate)
                                    let px = (w * 7.0 + 5.0).round();
                                    for c in min..=max {
                                        meta.column_widths.insert(c - 1, px); // 0-based
                                    }
                                }
                            }
                        }
                        if hidden {
                            for c in min..=max {
                                meta.hidden_columns.push(c - 1);
                            }
                        }
                    }
                    "mergeCells" => in_merge_cells = true,
                    "mergeCell" if in_merge_cells => {
                        // <mergeCell ref="A1:C3"/>
                        if let Some(ref_str) = get_attr(e, "ref") {
                            if let Some(range) = parse_range_ref(&ref_str) {
                                meta.merge_cells.push(range);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(ref e)) => {
                let tag = e.local_name();
                let tag_str = std::str::from_utf8(tag.as_ref()).unwrap_or("");
                match tag_str {
                    "sheetViews" => in_sheet_views = false,
                    "sheetData" => in_sheet_data = false,
                    "mergeCells" => in_merge_cells = false,
                    _ => {}
                }
            }
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    meta
}

// ============================================================================
// Helper: get attribute value from an XML element
// ============================================================================

fn get_attr(e: &quick_xml::events::BytesStart, name: &str) -> Option<String> {
    for attr in e.attributes().flatten() {
        if std::str::from_utf8(attr.key.as_ref()).ok()? == name {
            return std::str::from_utf8(&attr.value).ok().map(|s| s.to_string());
        }
    }
    None
}

/// Parse an ARGB hex string from Excel XML (e.g., "FF00FF00" -> Color).
/// Excel stores colors as AARRGGBB.
fn parse_argb(argb: &str) -> Option<Color> {
    let hex = argb.trim();
    if hex.len() == 8 {
        let a = u8::from_str_radix(&hex[0..2], 16).ok()?;
        let r = u8::from_str_radix(&hex[2..4], 16).ok()?;
        let g = u8::from_str_radix(&hex[4..6], 16).ok()?;
        let b = u8::from_str_radix(&hex[6..8], 16).ok()?;
        Some(Color::with_alpha(r, g, b, a))
    } else if hex.len() == 6 {
        let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
        let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
        let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
        Some(Color::new(r, g, b))
    } else {
        None
    }
}

/// Parse a <color> element. Handles rgb="FFRRGGBB", indexed="N", theme="N".
fn parse_color_element(e: &quick_xml::events::BytesStart) -> Option<Color> {
    // rgb attribute takes priority
    if let Some(rgb) = get_attr(e, "rgb") {
        return parse_argb(&rgb);
    }
    // indexed color (Excel legacy palette)
    if let Some(idx_str) = get_attr(e, "indexed") {
        if let Ok(idx) = idx_str.parse::<u32>() {
            return Some(indexed_color(idx));
        }
    }
    // theme color - we resolve to default theme colors
    if let Some(theme_str) = get_attr(e, "theme") {
        if let Ok(theme_idx) = theme_str.parse::<u32>() {
            let tint: f64 = get_attr(e, "tint")
                .and_then(|t| t.parse().ok())
                .unwrap_or(0.0);
            return Some(resolve_theme_color(theme_idx, tint));
        }
    }
    None
}

/// Excel default indexed color palette (first 64 colors).
fn indexed_color(idx: u32) -> Color {
    // Standard Excel indexed colors
    match idx {
        0 => Color::new(0, 0, 0),        // Black
        1 => Color::new(255, 255, 255),   // White
        2 => Color::new(255, 0, 0),       // Red
        3 => Color::new(0, 255, 0),       // Green
        4 => Color::new(0, 0, 255),       // Blue
        5 => Color::new(255, 255, 0),     // Yellow
        6 => Color::new(255, 0, 255),     // Magenta
        7 => Color::new(0, 255, 255),     // Cyan
        8 => Color::new(0, 0, 0),         // Black
        9 => Color::new(255, 255, 255),   // White
        10 => Color::new(255, 0, 0),      // Red
        11 => Color::new(0, 255, 0),      // Green
        12 => Color::new(0, 0, 255),      // Blue
        13 => Color::new(255, 255, 0),    // Yellow
        14 => Color::new(255, 0, 255),    // Magenta
        15 => Color::new(0, 255, 255),    // Cyan
        16 => Color::new(128, 0, 0),      // Dark Red
        17 => Color::new(0, 128, 0),      // Dark Green
        18 => Color::new(0, 0, 128),      // Dark Blue
        19 => Color::new(128, 128, 0),    // Olive
        20 => Color::new(128, 0, 128),    // Purple
        21 => Color::new(0, 128, 128),    // Teal
        22 => Color::new(192, 192, 192),  // Silver
        23 => Color::new(128, 128, 128),  // Gray
        24 => Color::new(153, 153, 255),  // Light Blue
        25 => Color::new(153, 51, 102),   // Plum
        26 => Color::new(255, 255, 204),  // Ivory
        27 => Color::new(204, 255, 255),  // Light Cyan
        28 => Color::new(102, 0, 102),    // Dark Purple
        29 => Color::new(255, 128, 128),  // Coral
        30 => Color::new(0, 102, 204),    // Ocean Blue
        31 => Color::new(204, 204, 255),  // Periwinkle
        32 => Color::new(0, 0, 128),      // Navy
        33 => Color::new(255, 0, 255),    // Magenta
        34 => Color::new(255, 255, 0),    // Yellow
        35 => Color::new(0, 255, 255),    // Cyan
        36 => Color::new(128, 0, 128),    // Purple
        37 => Color::new(128, 0, 0),      // Dark Red
        38 => Color::new(0, 128, 128),    // Teal
        39 => Color::new(0, 0, 255),      // Blue
        40 => Color::new(0, 204, 255),    // Sky Blue
        41 => Color::new(204, 255, 255),  // Light Cyan
        42 => Color::new(204, 255, 204),  // Light Green
        43 => Color::new(255, 255, 153),  // Light Yellow
        44 => Color::new(153, 204, 255),  // Light Sky Blue
        45 => Color::new(255, 153, 204),  // Light Pink
        46 => Color::new(204, 153, 255),  // Light Purple
        47 => Color::new(255, 204, 153),  // Light Orange
        48 => Color::new(51, 102, 255),   // Medium Blue
        49 => Color::new(51, 204, 204),   // Medium Teal
        50 => Color::new(153, 204, 0),    // Lime
        51 => Color::new(255, 204, 0),    // Gold
        52 => Color::new(255, 153, 0),    // Orange
        53 => Color::new(255, 102, 0),    // Dark Orange
        54 => Color::new(102, 102, 153),  // Blue Gray
        55 => Color::new(150, 150, 150),  // Gray 40
        56 => Color::new(0, 51, 102),     // Dark Teal
        57 => Color::new(51, 153, 102),   // Sea Green
        58 => Color::new(0, 51, 0),       // Very Dark Green
        59 => Color::new(51, 51, 0),      // Very Dark Olive
        60 => Color::new(153, 51, 0),     // Brown
        61 => Color::new(153, 51, 51),    // Dark Rose
        62 => Color::new(51, 51, 153),    // Indigo
        63 => Color::new(51, 51, 51),     // Gray 80
        64 => Color::new(0, 0, 0, ),      // System foreground (black)
        65 => Color::new(255, 255, 255),  // System background (white)
        _ => Color::new(0, 0, 0),         // Default to black
    }
}

/// Resolve a theme color index (0-based from OOXML) to an approximate RGB color.
/// Uses the default Office theme as fallback. Tint is applied.
///
/// IMPORTANT: OOXML theme indices 0-3 are swapped relative to the clrScheme order.
/// The theme XML defines [dk1, lt1, dk2, lt2, accent1..6, hlink, folHlink],
/// but the OOXML theme index mapping is:
///   0 → lt1 (light background), 1 → dk1 (dark text),
///   2 → lt2 (light accent bg), 3 → dk2 (dark accent text)
fn resolve_theme_color(theme_idx: u32, tint: f64) -> Color {
    let base = match theme_idx {
        0 => Color::new(255, 255, 255),   // lt1 (OOXML index 0 = light 1)
        1 => Color::new(0, 0, 0),         // dk1 (OOXML index 1 = dark 1)
        2 => Color::new(232, 232, 232),   // lt2 (OOXML index 2 = light 2)
        3 => Color::new(68, 84, 106),     // dk2 (OOXML index 3 = dark 2)
        4 => Color::new(68, 114, 196),    // accent1
        5 => Color::new(237, 125, 49),    // accent2
        6 => Color::new(165, 165, 165),   // accent3
        7 => Color::new(255, 192, 0),     // accent4
        8 => Color::new(91, 155, 213),    // accent5
        9 => Color::new(112, 173, 71),    // accent6
        10 => Color::new(5, 99, 193),     // hyperlink
        11 => Color::new(149, 79, 114),   // followed hyperlink
        _ => Color::new(0, 0, 0),
    };

    if tint.abs() < 0.001 {
        return base;
    }
    apply_tint(base, tint)
}

/// Apply an Excel tint value (-1.0 to 1.0) to a base color.
/// Positive tint lightens (blends toward white), negative darkens (blends toward black).
fn apply_tint(color: Color, tint: f64) -> Color {
    let tint_component = |c: u8| -> u8 {
        let cf = c as f64;
        let result = if tint < 0.0 {
            cf * (1.0 + tint)
        } else {
            cf * (1.0 - tint) + 255.0 * tint
        };
        result.round().clamp(0.0, 255.0) as u8
    };
    Color::new(
        tint_component(color.r),
        tint_component(color.g),
        tint_component(color.b),
    )
}

/// Parse a cell reference like "B3" to (row, col) 0-based.
fn parse_cell_ref(cell_ref: &str) -> Option<(u32, u32)> {
    let bytes = cell_ref.as_bytes();
    let mut col: u32 = 0;
    let mut i = 0;

    // Parse column letters
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        col = col * 26 + (bytes[i].to_ascii_uppercase() - b'A') as u32 + 1;
        i += 1;
    }
    if i == 0 || col == 0 {
        return None;
    }
    col -= 1; // 0-based

    // Parse row number
    let row_str = &cell_ref[i..];
    let row: u32 = row_str.parse().ok()?;
    if row == 0 {
        return None;
    }

    Some((row - 1, col))
}

/// Parse a range reference like "A1:C3" to (start_row, start_col, end_row, end_col) 0-based.
fn parse_range_ref(range_ref: &str) -> Option<(u32, u32, u32, u32)> {
    let parts: Vec<&str> = range_ref.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let (r1, c1) = parse_cell_ref(parts[0])?;
    let (r2, c2) = parse_cell_ref(parts[1])?;
    Some((r1, c1, r2, c2))
}

// ============================================================================
// Conversion: Parsed XLSX data -> Calcula CellStyle
// ============================================================================

/// Convert an XLSX cell XF record into a Calcula CellStyle.
pub fn xf_to_cell_style(
    xf: &ParsedXf,
    fonts: &[ParsedFont],
    fills: &[ParsedFill],
    borders: &[ParsedBorder],
    number_formats: &HashMap<u32, String>,
) -> CellStyle {
    let mut style = CellStyle::new();

    // Font — always apply from the XF record's fontId.
    // In cellXfs, the fontId IS the definitive font for the cell.
    if let Some(font) = fonts.get(xf.font_id) {
        style.font.bold = font.bold;
        style.font.italic = font.italic;
        style.font.underline = font.underline;
        style.font.strikethrough = font.strikethrough;
        style.font.size = font.size;
        if let Some(c) = font.color {
            style.font.color = ThemeColor::Absolute(c);
        }
        // Map Excel font name to Calcula font family
        style.font.family = map_font_name(&font.name);
    }

    // Fill
    if let Some(fill) = fills.get(xf.fill_id) {
        style.fill = convert_fill(fill);
    }

    // Borders
    if let Some(border) = borders.get(xf.border_id) {
        style.borders = convert_borders(border);
    }

    // Number format
    style.number_format = convert_number_format(xf.num_fmt_id, number_formats);

    // Alignment
    style.text_align = match xf.alignment.horizontal.as_str() {
        "left" => TextAlign::Left,
        "center" => TextAlign::Center,
        "right" => TextAlign::Right,
        _ => TextAlign::General,
    };
    style.vertical_align = match xf.alignment.vertical.as_str() {
        "top" => VerticalAlign::Top,
        "center" => VerticalAlign::Middle,
        "bottom" => VerticalAlign::Bottom,
        _ => VerticalAlign::Bottom, // Excel default is bottom
    };
    style.wrap_text = xf.alignment.wrap_text;
    style.indent = xf.alignment.indent;
    style.shrink_to_fit = xf.alignment.shrink_to_fit;
    style.text_rotation = match xf.alignment.text_rotation {
        0 => TextRotation::None,
        90 => TextRotation::Rotate90,
        180 => TextRotation::Rotate270, // Excel uses 180 for vertical down
        255 => TextRotation::Rotate90,   // Vertical text
        r if r <= 90 => TextRotation::Custom(r as i16),
        r if r <= 180 => TextRotation::Custom(-((r - 90) as i16)),
        _ => TextRotation::None,
    };

    style
}

/// Map Excel font name to Calcula font family.
/// "Calibri" (Excel default body font) maps to "Body" (theme-aware).
fn map_font_name(name: &str) -> String {
    match name {
        "Calibri" => "Body".to_string(),
        "Cambria" | "Calibri Light" => "Heading".to_string(),
        other => other.to_string(),
    }
}

/// Convert a parsed fill to a Calcula Fill.
fn convert_fill(fill: &ParsedFill) -> Fill {
    match fill.pattern_type.as_str() {
        "solid" => {
            // For solid fills, Excel puts the actual color in fgColor
            if let Some(c) = fill.fg_color {
                Fill::Solid {
                    color: ThemeColor::Absolute(c),
                }
            } else {
                Fill::None
            }
        }
        "none" | "" => Fill::None,
        // gray125 is Excel's "default empty fill" placeholder (fill index 1).
        // It's not meant to produce visible coloring — treat as no fill.
        "gray125" | "gray0625" => Fill::None,
        // Map Excel gray patterns
        pattern_name => {
            let pattern_type = match pattern_name {
                "darkGray" => PatternType::DarkGray,
                "mediumGray" => PatternType::MediumGray,
                "lightGray" => PatternType::LightGray,
                "darkHorizontal" => PatternType::DarkHorizontal,
                "darkVertical" => PatternType::DarkVertical,
                "darkDown" => PatternType::DarkDown,
                "darkUp" => PatternType::DarkUp,
                "darkGrid" => PatternType::DarkGrid,
                "darkTrellis" => PatternType::DarkTrellis,
                "lightHorizontal" => PatternType::LightHorizontal,
                "lightVertical" => PatternType::LightVertical,
                "lightDown" => PatternType::LightDown,
                "lightUp" => PatternType::LightUp,
                "lightGrid" => PatternType::LightGrid,
                "lightTrellis" => PatternType::LightTrellis,
                _ => return Fill::None,
            };
            let fg = fill
                .fg_color
                .map(ThemeColor::Absolute)
                .unwrap_or(ThemeColor::default_text());
            let bg = fill
                .bg_color
                .map(ThemeColor::Absolute)
                .unwrap_or(ThemeColor::default_background());
            Fill::Pattern {
                pattern_type,
                fg_color: fg,
                bg_color: bg,
            }
        }
    }
}

/// Convert parsed border data to Calcula Borders.
fn convert_borders(border: &ParsedBorder) -> Borders {
    Borders {
        top: convert_border_edge(&border.top),
        right: convert_border_edge(&border.right),
        bottom: convert_border_edge(&border.bottom),
        left: convert_border_edge(&border.left),
        diagonal_down: BorderStyle::default(),
        diagonal_up: BorderStyle::default(),
    }
}

fn convert_border_edge(edge: &ParsedBorderEdge) -> BorderStyle {
    let (line_style, width) = match edge.style.as_str() {
        "thin" => (BorderLineStyle::Solid, 1),
        "medium" => (BorderLineStyle::Solid, 2),
        "thick" => (BorderLineStyle::Solid, 3),
        "dashed" => (BorderLineStyle::Dashed, 1),
        "dotted" => (BorderLineStyle::Dotted, 1),
        "double" => (BorderLineStyle::Double, 1),
        "hair" => (BorderLineStyle::Dotted, 1),
        "mediumDashed" => (BorderLineStyle::Dashed, 2),
        "dashDot" => (BorderLineStyle::Dashed, 1),
        "mediumDashDot" => (BorderLineStyle::Dashed, 2),
        "dashDotDot" => (BorderLineStyle::Dotted, 1),
        "mediumDashDotDot" => (BorderLineStyle::Dotted, 2),
        "slantDashDot" => (BorderLineStyle::Dashed, 1),
        _ => return BorderStyle::default(),
    };

    let color = edge
        .color
        .map(ThemeColor::Absolute)
        .unwrap_or(ThemeColor::default_text());

    BorderStyle {
        width,
        color,
        style: line_style,
    }
}

/// Convert an Excel numFmtId to a Calcula NumberFormat.
fn convert_number_format(num_fmt_id: u32, custom_formats: &HashMap<u32, String>) -> NumberFormat {
    // Built-in Excel number format IDs
    match num_fmt_id {
        0 => NumberFormat::General,
        1 => NumberFormat::Number {
            decimal_places: 0,
            use_thousands_separator: false,
        },
        2 => NumberFormat::Number {
            decimal_places: 2,
            use_thousands_separator: false,
        },
        3 => NumberFormat::Number {
            decimal_places: 0,
            use_thousands_separator: true,
        },
        4 => NumberFormat::Number {
            decimal_places: 2,
            use_thousands_separator: true,
        },
        5 | 6 | 7 | 8 => NumberFormat::Currency {
            decimal_places: if num_fmt_id <= 6 { 0 } else { 2 },
            symbol: "$".to_string(),
            symbol_position: CurrencyPosition::Before,
        },
        9 => NumberFormat::Percentage { decimal_places: 0 },
        10 => NumberFormat::Percentage { decimal_places: 2 },
        11 => NumberFormat::Scientific { decimal_places: 2 },
        12 => NumberFormat::Fraction {
            denominator: None,
            max_digits: 1,
        },
        13 => NumberFormat::Fraction {
            denominator: None,
            max_digits: 2,
        },
        14 => NumberFormat::Date {
            format: "MM/DD/YYYY".to_string(),
        },
        15 => NumberFormat::Date {
            format: "D-MMM-YY".to_string(),
        },
        16 => NumberFormat::Date {
            format: "D-MMM".to_string(),
        },
        17 => NumberFormat::Date {
            format: "MMM-YY".to_string(),
        },
        18 => NumberFormat::Time {
            format: "h:mm AM/PM".to_string(),
        },
        19 => NumberFormat::Time {
            format: "h:mm:ss AM/PM".to_string(),
        },
        20 => NumberFormat::Time {
            format: "HH:mm".to_string(),
        },
        21 => NumberFormat::Time {
            format: "HH:mm:ss".to_string(),
        },
        22 => NumberFormat::Date {
            format: "M/D/YYYY HH:mm".to_string(),
        },
        37 | 38 | 39 | 40 => NumberFormat::Number {
            decimal_places: if num_fmt_id >= 39 { 2 } else { 0 },
            use_thousands_separator: true,
        },
        41 | 42 | 43 | 44 => NumberFormat::Accounting {
            decimal_places: if num_fmt_id % 2 == 0 { 2 } else { 0 },
            symbol: "$".to_string(),
            symbol_position: CurrencyPosition::Before,
        },
        45 => NumberFormat::Time {
            format: "mm:ss".to_string(),
        },
        46 => NumberFormat::Time {
            format: "[h]:mm:ss".to_string(),
        },
        47 => NumberFormat::Time {
            format: "mm:ss.0".to_string(),
        },
        48 => NumberFormat::Scientific { decimal_places: 1 },
        49 => NumberFormat::Custom {
            format: "@".to_string(),
        },
        _ => {
            // Look up custom format code
            if let Some(code) = custom_formats.get(&num_fmt_id) {
                parse_format_code(code)
            } else {
                NumberFormat::General
            }
        }
    }
}

/// Attempt to classify a custom format code string into a Calcula NumberFormat.
fn parse_format_code(code: &str) -> NumberFormat {
    let lower = code.to_lowercase();

    // Date patterns
    if lower.contains('y') || lower.contains("mmm") || lower.contains('d') {
        // If it also contains time elements, it could be datetime
        return NumberFormat::Date {
            format: code.to_string(),
        };
    }

    // Time patterns (must check after date since some dates have "h" in month names)
    if lower.contains('h') || lower.contains("ss") || lower.contains("am/pm") {
        return NumberFormat::Time {
            format: code.to_string(),
        };
    }

    // Percentage
    if code.contains('%') {
        let decimals = count_decimal_places(code);
        return NumberFormat::Percentage {
            decimal_places: decimals,
        };
    }

    // Currency (contains $ or other currency symbols)
    if code.contains('$') || code.contains('\u{20AC}') || code.contains('\u{00A3}') {
        let decimals = count_decimal_places(code);
        // Try to extract symbol
        let symbol = if code.contains('$') {
            "$"
        } else if code.contains('\u{20AC}') {
            "\u{20AC}"
        } else {
            "\u{00A3}"
        };
        let pos = if code.starts_with(symbol) || code.starts_with('[') {
            CurrencyPosition::Before
        } else {
            CurrencyPosition::After
        };
        return NumberFormat::Currency {
            decimal_places: decimals,
            symbol: symbol.to_string(),
            symbol_position: pos,
        };
    }

    // Scientific
    if lower.contains("e+") || lower.contains("e-") {
        let decimals = count_decimal_places(code);
        return NumberFormat::Scientific {
            decimal_places: decimals,
        };
    }

    // Fraction
    if code.contains('/') && !code.contains(':') {
        return NumberFormat::Fraction {
            denominator: None,
            max_digits: 2,
        };
    }

    // Plain number
    if code.contains('0') || code.contains('#') {
        let decimals = count_decimal_places(code);
        let thousands = code.contains(',') || code.contains(' ');
        return NumberFormat::Number {
            decimal_places: decimals,
            use_thousands_separator: thousands,
        };
    }

    // Fallback: store as custom
    NumberFormat::Custom {
        format: code.to_string(),
    }
}

/// Count decimal places from a format code by looking at digits after '.'.
fn count_decimal_places(code: &str) -> u8 {
    // Find the decimal point and count 0's after it
    if let Some(dot_pos) = code.find('.') {
        let after_dot = &code[dot_pos + 1..];
        after_dot
            .chars()
            .take_while(|c| *c == '0' || *c == '#')
            .count() as u8
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_cell_ref() {
        assert_eq!(parse_cell_ref("A1"), Some((0, 0)));
        assert_eq!(parse_cell_ref("B3"), Some((2, 1)));
        assert_eq!(parse_cell_ref("Z1"), Some((0, 25)));
        assert_eq!(parse_cell_ref("AA1"), Some((0, 26)));
        assert_eq!(parse_cell_ref("AZ1"), Some((0, 51)));
    }

    #[test]
    fn test_parse_range_ref() {
        assert_eq!(parse_range_ref("A1:C3"), Some((0, 0, 2, 2)));
        assert_eq!(parse_range_ref("B2:D5"), Some((1, 1, 4, 3)));
    }

    #[test]
    fn test_parse_argb() {
        let c = parse_argb("FF00FF00").unwrap();
        assert_eq!(c.r, 0);
        assert_eq!(c.g, 255);
        assert_eq!(c.b, 0);
        assert_eq!(c.a, 255);

        let c2 = parse_argb("80FF0000").unwrap();
        assert_eq!(c2.r, 255);
        assert_eq!(c2.g, 0);
        assert_eq!(c2.b, 0);
        assert_eq!(c2.a, 128);
    }

    #[test]
    fn test_apply_tint() {
        // 50% lighter
        let c = apply_tint(Color::new(100, 100, 100), 0.5);
        assert_eq!(c.r, 178); // 100 * 0.5 + 255 * 0.5 = 177.5 -> 178
        // 50% darker
        let d = apply_tint(Color::new(200, 200, 200), -0.5);
        assert_eq!(d.r, 100); // 200 * 0.5 = 100
    }

    #[test]
    fn test_count_decimal_places() {
        assert_eq!(count_decimal_places("#,##0.00"), 2);
        assert_eq!(count_decimal_places("0"), 0);
        assert_eq!(count_decimal_places("0.000"), 3);
    }

    #[test]
    fn test_format_code_classification() {
        assert!(matches!(
            parse_format_code("0.00%"),
            NumberFormat::Percentage { decimal_places: 2 }
        ));
        assert!(matches!(
            parse_format_code("YYYY-MM-DD"),
            NumberFormat::Date { .. }
        ));
        assert!(matches!(
            parse_format_code("HH:mm:ss"),
            NumberFormat::Time { .. }
        ));
        assert!(matches!(
            parse_format_code("0.00E+00"),
            NumberFormat::Scientific { decimal_places: 2 }
        ));
    }

    #[test]
    fn test_indexed_color_bounds() {
        // Smoke test: no panic for any reasonable index
        for i in 0..70 {
            let _ = indexed_color(i);
        }
    }

    #[test]
    fn test_extract_sheet_number() {
        assert_eq!(extract_sheet_number("xl/worksheets/sheet1.xml"), Some(1));
        assert_eq!(extract_sheet_number("xl/worksheets/sheet12.xml"), Some(12));
        assert_eq!(extract_sheet_number("xl/worksheets/sheetabc.xml"), None);
        assert_eq!(extract_sheet_number("xl/workbook.xml"), None);
    }
}
