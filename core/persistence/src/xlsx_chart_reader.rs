//! FILENAME: core/persistence/src/xlsx_chart_reader.rs
//! PURPOSE: Parse chart definitions from XLSX archive (xl/charts/chartN.xml + xl/drawings/).
//! Converts OOXML chart XML into Calcula's ChartDefinition JSON format.

use crate::SavedChart;
use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::HashMap;
use std::io::Read;

/// Parse all charts from an XLSX ZIP archive.
/// `sheet_paths` maps 0-based logical sheet index to the XML path (e.g., "xl/worksheets/sheet5.xml").
/// Returns a list of (sheet_index, SavedChart) pairs.
pub fn parse_xlsx_charts(
    archive: &mut zip::ZipArchive<std::fs::File>,
    sheet_paths: &[(usize, String)],
) -> Vec<(usize, SavedChart)> {
    let mut results = Vec::new();
    let mut chart_id_counter = 1u32;

    // Step 1: Find which sheets reference which drawings
    for (logical_idx, sheet_xml_path) in sheet_paths {
        // Derive the rels path from the sheet XML path
        // e.g., xl/worksheets/sheet5.xml -> xl/worksheets/_rels/sheet5.xml.rels
        let sheet_fname = sheet_xml_path.rsplit('/').next().unwrap_or("");
        let sheet_dir = sheet_xml_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("xl/worksheets");
        let sheet_rels_path = format!("{}/_rels/{}.rels", sheet_dir, sheet_fname);

        let drawing_path = match find_drawing_target(archive, &sheet_rels_path) {
            Some(p) => p,
            None => continue,
        };

        // Step 2: Parse the drawing XML for chart references and anchoring
        let drawing_rels_path = {
            // e.g., xl/drawings/drawing2.xml -> xl/drawings/_rels/drawing2.xml.rels
            let fname = drawing_path.rsplit('/').next().unwrap_or("");
            format!(
                "{}/_rels/{}.rels",
                drawing_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("xl/drawings"),
                fname
            )
        };

        let drawing_xml = match read_zip_entry(archive, &drawing_path) {
            Ok(xml) => xml,
            Err(_) => continue,
        };

        // Parse drawing rels to map rId -> chart path
        let chart_rels = parse_drawing_rels(archive, &drawing_rels_path);

        // Parse anchors in the drawing XML
        let anchors = parse_drawing_anchors(&drawing_xml, &chart_rels);

        // Step 3: Parse each chart XML referenced by this drawing
        for anchor in anchors {
            let chart_xml = match read_zip_entry(archive, &anchor.chart_path) {
                Ok(xml) => xml,
                Err(_) => continue,
            };

            if let Some(spec_json) = parse_chart_xml(&chart_xml, &anchor) {
                // Use the logical sheet index (0-based, from the caller's mapping)
                let sheet_index = logical_idx.saturating_sub(1);
                results.push((
                    sheet_index,
                    SavedChart {
                        id: chart_id_counter,
                        sheet_index,
                        spec_json,
                    },
                ));
                chart_id_counter += 1;
            }
        }
    }

    results
}

// ============================================================================
// Internal types
// ============================================================================

struct ChartAnchor {
    chart_path: String,
    from_col: u32,
    from_row: u32,
    to_col: u32,
    to_row: u32,
    name: String,
}

// ============================================================================
// Drawing and relationship parsing
// ============================================================================

fn find_drawing_target(
    archive: &mut zip::ZipArchive<std::fs::File>,
    rels_path: &str,
) -> Option<String> {
    let xml = read_zip_entry(archive, rels_path).ok()?;
    let mut reader = Reader::from_str(&xml);
    reader.trim_text(true);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let local = e.local_name();
                let tag = std::str::from_utf8(local.as_ref()).unwrap_or("");
                if tag == "Relationship" {
                    let rel_type = get_attr(e, "Type").unwrap_or_default();
                    if rel_type.contains("drawing") {
                        let target = get_attr(e, "Target").unwrap_or_default();
                        // Target is relative to xl/worksheets/, e.g., "../drawings/drawing2.xml"
                        let resolved = resolve_path("xl/worksheets/", &target);
                        return Some(resolved);
                    }
                }
            }
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    None
}

fn parse_drawing_rels(
    archive: &mut zip::ZipArchive<std::fs::File>,
    rels_path: &str,
) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let xml = match read_zip_entry(archive, rels_path) {
        Ok(xml) => xml,
        Err(_) => return map,
    };

    let mut reader = Reader::from_str(&xml);
    reader.trim_text(true);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let local = e.local_name();
                let tag = std::str::from_utf8(local.as_ref()).unwrap_or("");
                if tag == "Relationship" {
                    let rel_type = get_attr(e, "Type").unwrap_or_default();
                    if rel_type.contains("chart") {
                        let id = get_attr(e, "Id").unwrap_or_default();
                        let target = get_attr(e, "Target").unwrap_or_default();
                        let base = rels_path
                            .rsplit_once("/_rels/")
                            .map(|(d, _)| d)
                            .unwrap_or("xl/drawings");
                        let resolved = resolve_path(&format!("{}/", base), &target);
                        map.insert(id, resolved);
                    }
                }
            }
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    map
}

fn parse_drawing_anchors(xml: &str, chart_rels: &HashMap<String, String>) -> Vec<ChartAnchor> {
    let mut anchors = Vec::new();
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);
    let mut buf = Vec::new();

    let mut in_anchor = false;
    let mut in_from = false;
    let mut in_to = false;
    let mut from_col = 0u32;
    let mut from_row = 0u32;
    let mut to_col = 0u32;
    let mut to_row = 0u32;
    let mut chart_rid = String::new();
    let mut chart_name = String::new();
    let mut current_text_tag = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let local = e.local_name();
                let tag = std::str::from_utf8(local.as_ref()).unwrap_or("");

                match tag {
                    "twoCellAnchor" | "oneCellAnchor" => {
                        in_anchor = true;
                        from_col = 0;
                        from_row = 0;
                        to_col = 0;
                        to_row = 0;
                        chart_rid.clear();
                        chart_name.clear();
                    }
                    "from" if in_anchor => in_from = true,
                    "to" if in_anchor => in_to = true,
                    "col" if in_from || in_to => current_text_tag = "col".to_string(),
                    "row" if in_from || in_to => current_text_tag = "row".to_string(),
                    "cNvPr" if in_anchor => {
                        chart_name = get_attr(e, "name").unwrap_or_default();
                    }
                    "chart" if in_anchor => {
                        // <c:chart r:id="rId1"/>
                        chart_rid = get_attr_any_ns(e, "id").unwrap_or_default();
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref t)) => {
                let text = t.unescape().map(|s| s.to_string()).unwrap_or_default();
                if in_from {
                    match current_text_tag.as_str() {
                        "col" => from_col = text.trim().parse().unwrap_or(0),
                        "row" => from_row = text.trim().parse().unwrap_or(0),
                        _ => {}
                    }
                } else if in_to {
                    match current_text_tag.as_str() {
                        "col" => to_col = text.trim().parse().unwrap_or(0),
                        "row" => to_row = text.trim().parse().unwrap_or(0),
                        _ => {}
                    }
                }
                current_text_tag.clear();
            }
            Ok(Event::End(ref e)) => {
                let local = e.local_name();
                let tag = std::str::from_utf8(local.as_ref()).unwrap_or("");
                match tag {
                    "from" => in_from = false,
                    "to" => in_to = false,
                    "twoCellAnchor" | "oneCellAnchor" => {
                        if !chart_rid.is_empty() {
                            if let Some(chart_path) = chart_rels.get(&chart_rid) {
                                anchors.push(ChartAnchor {
                                    chart_path: chart_path.clone(),
                                    from_col,
                                    from_row,
                                    to_col: if to_col > 0 { to_col } else { from_col + 6 },
                                    to_row: if to_row > 0 { to_row } else { from_row + 15 },
                                    name: if chart_name.is_empty() {
                                        "Chart".to_string()
                                    } else {
                                        chart_name.clone()
                                    },
                                });
                            }
                        }
                        in_anchor = false;
                    }
                    _ => {}
                }
            }
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    anchors
}

// ============================================================================
// Chart XML parsing
// ============================================================================

fn parse_chart_xml(xml: &str, anchor: &ChartAnchor) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);
    let mut buf = Vec::new();

    let mut chart_type = String::new();
    let mut title = String::new();
    let mut series_list: Vec<SeriesInfo> = Vec::new();
    let mut current_series: Option<SeriesInfo> = None;
    let mut bar_dir = "col".to_string();
    let mut grouping = "clustered".to_string();

    // Track parsing context
    let mut in_chart = false;
    let mut in_title = false;
    let mut in_plot_area = false;
    let mut in_chart_type = false;
    let mut in_ser = false;
    let mut in_tx = false;
    let mut in_cat = false;
    let mut in_val = false;
    let mut capture_text = false;
    let mut text_buf = String::new();
    let mut in_f = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) => break,
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let local = e.local_name();
                let tag = std::str::from_utf8(local.as_ref()).unwrap_or("");

                match tag {
                    "chart" => in_chart = true,
                    "title" if in_chart && !in_plot_area => in_title = true,
                    "t" if in_title => capture_text = true,
                    "plotArea" => {
                        in_plot_area = true;
                        in_title = false;
                    }
                    "barChart" | "bar3DChart" => {
                        chart_type = "bar".to_string();
                        in_chart_type = true;
                    }
                    "lineChart" | "line3DChart" => {
                        chart_type = "line".to_string();
                        in_chart_type = true;
                    }
                    "areaChart" | "area3DChart" => {
                        chart_type = "area".to_string();
                        in_chart_type = true;
                    }
                    "pieChart" | "pie3DChart" | "ofPieChart" => {
                        chart_type = "pie".to_string();
                        in_chart_type = true;
                    }
                    "doughnutChart" => {
                        chart_type = "donut".to_string();
                        in_chart_type = true;
                    }
                    "scatterChart" => {
                        chart_type = "scatter".to_string();
                        in_chart_type = true;
                    }
                    "radarChart" => {
                        chart_type = "radar".to_string();
                        in_chart_type = true;
                    }
                    "bubbleChart" => {
                        chart_type = "bubble".to_string();
                        in_chart_type = true;
                    }
                    "stockChart" => {
                        chart_type = "stock".to_string();
                        in_chart_type = true;
                    }
                    "barDir" if in_chart_type => {
                        bar_dir = get_attr(e, "val").unwrap_or("col".to_string());
                    }
                    "grouping" if in_chart_type => {
                        grouping = get_attr(e, "val").unwrap_or("clustered".to_string());
                    }
                    "ser" if in_chart_type => {
                        in_ser = true;
                        current_series = Some(SeriesInfo::default());
                    }
                    "tx" if in_ser => in_tx = true,
                    "cat" if in_ser => in_cat = true,
                    "val" | "yVal" if in_ser => in_val = true,
                    "f" if in_ser && (in_tx || in_cat || in_val) => {
                        in_f = true;
                        text_buf.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref t)) => {
                let text = t.unescape().map(|s| s.to_string()).unwrap_or_default();
                if capture_text && title.is_empty() {
                    title = text;
                } else if in_f {
                    text_buf.push_str(&text);
                }
            }
            Ok(Event::End(ref e)) => {
                let local = e.local_name();
                let tag = std::str::from_utf8(local.as_ref()).unwrap_or("");
                match tag {
                    "t" => capture_text = false,
                    "title" => in_title = false,
                    "f" => {
                        if in_f && !text_buf.is_empty() {
                            if let Some(ref mut s) = current_series {
                                if in_tx {
                                    s.name_ref = text_buf.clone();
                                } else if in_cat {
                                    s.cat_ref = text_buf.clone();
                                } else if in_val {
                                    s.val_ref = text_buf.clone();
                                }
                            }
                        }
                        in_f = false;
                        text_buf.clear();
                    }
                    "tx" => in_tx = false,
                    "cat" => in_cat = false,
                    "val" | "yVal" => in_val = false,
                    "ser" => {
                        if let Some(s) = current_series.take() {
                            series_list.push(s);
                        }
                        in_ser = false;
                    }
                    "barChart" | "bar3DChart" | "lineChart" | "line3DChart" | "areaChart"
                    | "area3DChart" | "pieChart" | "pie3DChart" | "ofPieChart"
                    | "doughnutChart" | "scatterChart" | "radarChart" | "bubbleChart"
                    | "stockChart" => {
                        in_chart_type = false;
                    }
                    "plotArea" => in_plot_area = false,
                    "chart" => in_chart = false,
                    _ => {}
                }
            }
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    if chart_type.is_empty() || series_list.is_empty() {
        return None;
    }

    // Adjust bar chart type based on direction
    let mark = if chart_type == "bar" && bar_dir == "bar" {
        "horizontalBar"
    } else {
        &chart_type
    };

    // Map OOXML grouping to Calcula stackMode
    let stack_mode = match grouping.as_str() {
        "stacked" => "stacked",
        "percentStacked" => "percentStacked",
        _ => "none", // "clustered" or "standard"
    };

    // Build the data range: find the overall range covering all series
    let data_range = build_data_range(&series_list);

    // Build ChartDefinition JSON with dynamic name references and seriesRefs
    let series_json: Vec<String> = series_list
        .iter()
        .enumerate()
        .map(|(i, s)| {
            // Use dynamic name reference if available (resolves to cell value at render time)
            let name = if !s.name_ref.is_empty() {
                format!("={}", s.name_ref)
            } else {
                format!("Series {}", i + 1)
            };
            // sourceIndex is the column index within the data range (0-based).
            // categoryIndex=0 takes the first column, so series start at index 1.
            format!(
                r#"{{"name":"{}","sourceIndex":{},"color":null}}"#,
                escape_json(&name),
                i + 1
            )
        })
        .collect();

    // Build per-series references for SERIES formula reconstruction
    let series_refs_json: Vec<String> = series_list
        .iter()
        .map(|s| {
            let name_ref = if s.name_ref.is_empty() {
                "null".to_string()
            } else {
                format!("\"{}\"", escape_json(&s.name_ref))
            };
            let cat_ref = if s.cat_ref.is_empty() {
                "null".to_string()
            } else {
                format!("\"{}\"", escape_json(&s.cat_ref))
            };
            let val_ref = if s.val_ref.is_empty() {
                "null".to_string()
            } else {
                format!("\"{}\"", escape_json(&s.val_ref))
            };
            format!(
                r#"{{"nameRef":{},"catRef":{},"valRef":{}}}"#,
                name_ref, cat_ref, val_ref
            )
        })
        .collect();

    // Approximate pixel position from cell coordinates
    let col_width = 100.0;
    let row_height = 24.0;
    let x = anchor.from_col as f64 * col_width;
    let y = anchor.from_row as f64 * row_height;
    let w = (anchor.to_col - anchor.from_col) as f64 * col_width;
    let h = (anchor.to_row - anchor.from_row) as f64 * row_height;

    let title_json = if title.is_empty() {
        "null".to_string()
    } else {
        format!("\"{}\"", escape_json(&title))
    };

    // Build markOptions JSON (for stacking, etc.)
    let mark_options_json = if stack_mode != "none" {
        format!(r#","markOptions":{{"stackMode":"{}"}}"#, stack_mode)
    } else {
        String::new()
    };

    let series_refs_field = format!(r#","seriesRefs":[{}]"#, series_refs_json.join(","));

    let spec_json = format!(
        r#"{{"chartId":{},"name":"{}","sheetIndex":0,"x":{},"y":{},"width":{},"height":{},"spec":{{"mark":"{}","data":"{}","hasHeaders":true,"seriesOrientation":"columns","categoryIndex":0,"series":[{}],"title":{},"xAxis":{{"title":null,"showGrid":false,"showLabels":true}},"yAxis":{{"title":null,"showGrid":true,"showLabels":true}},"legend":{{"position":"right","show":true}},"palette":"default"{}{}}}}}"#,
        0, // chartId will be set by the caller
        escape_json(&anchor.name),
        x,
        y,
        w.max(300.0),
        h.max(200.0),
        mark,
        escape_json(&data_range),
        series_json.join(","),
        title_json,
        mark_options_json,
        series_refs_field,
    );

    Some(spec_json)
}

#[derive(Debug, Default)]
struct SeriesInfo {
    name_ref: String,
    cat_ref: String,
    val_ref: String,
}

/// Build an A1-style data range string that covers all series data.
fn build_data_range(series: &[SeriesInfo]) -> String {
    // Find the first series with a category and value ref
    let cat_ref = series.iter().find(|s| !s.cat_ref.is_empty()).map(|s| &s.cat_ref);
    let val_refs: Vec<&str> = series.iter().filter(|s| !s.val_ref.is_empty()).map(|s| s.val_ref.as_str()).collect();

    if val_refs.is_empty() {
        return String::new();
    }

    // Try to build a unified range: SheetName!$B$17:$E$20
    // Parse sheet name and cell range from the refs
    if let Some(cat) = cat_ref {
        // Find the sheet name prefix
        let sheet_prefix = cat.split('!').next().unwrap_or("");
        // Find the top-left and bottom-right across all refs
        let all_refs: Vec<&str> = std::iter::once(cat.as_str())
            .chain(val_refs.iter().copied())
            .chain(series.iter().filter(|s| !s.name_ref.is_empty()).map(|s| s.name_ref.as_str()))
            .collect();

        let mut min_row = u32::MAX;
        let mut max_row = 0u32;
        let mut min_col = u32::MAX;
        let mut max_col = 0u32;

        for r in &all_refs {
            let cell_part = r.split('!').last().unwrap_or(r);
            for part in cell_part.split(':') {
                let clean = part.replace('$', "");
                if let Some((row, col)) = parse_a1_ref(&clean) {
                    min_row = min_row.min(row);
                    max_row = max_row.max(row);
                    min_col = min_col.min(col);
                    max_col = max_col.max(col);
                }
            }
        }

        if min_row <= max_row && min_col <= max_col {
            let start = format_a1(min_row, min_col);
            let end = format_a1(max_row, max_col);
            return format!("{}!{}:{}", sheet_prefix, start, end);
        }
    }

    // Fallback: return the first value ref
    val_refs.first().map(|s| s.to_string()).unwrap_or_default()
}

fn parse_a1_ref(cell_ref: &str) -> Option<(u32, u32)> {
    let bytes = cell_ref.as_bytes();
    let mut col: u32 = 0;
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        col = col * 26 + (bytes[i].to_ascii_uppercase() - b'A') as u32 + 1;
        i += 1;
    }
    if i == 0 || col == 0 {
        return None;
    }
    col -= 1;
    let row: u32 = cell_ref[i..].parse().ok()?;
    if row == 0 {
        return None;
    }
    Some((row - 1, col))
}

fn format_a1(row: u32, col: u32) -> String {
    let mut col_str = String::new();
    let mut c = col + 1;
    while c > 0 {
        c -= 1;
        col_str.insert(0, (b'A' + (c % 26) as u8) as char);
        c /= 26;
    }
    format!("{}{}", col_str, row + 1)
}

// ============================================================================
// Helpers
// ============================================================================

fn read_zip_entry(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<String, ()> {
    let mut entry = archive.by_name(name).map_err(|_| ())?;
    let mut buf = String::new();
    entry.read_to_string(&mut buf).map_err(|_| ())?;
    Ok(buf)
}

fn get_attr(e: &quick_xml::events::BytesStart, name: &str) -> Option<String> {
    for attr in e.attributes().flatten() {
        if std::str::from_utf8(attr.key.as_ref()).ok()? == name {
            return std::str::from_utf8(&attr.value).ok().map(|s| s.to_string());
        }
    }
    None
}

/// Get attribute value matching by local name (ignoring namespace prefix).
fn get_attr_any_ns(e: &quick_xml::events::BytesStart, local_name: &str) -> Option<String> {
    for attr in e.attributes().flatten() {
        let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
        // Match "r:id" or just "id" etc.
        let local = key.rsplit(':').next().unwrap_or(key);
        if local == local_name {
            return std::str::from_utf8(&attr.value).ok().map(|s| s.to_string());
        }
    }
    None
}

/// Resolve a relative path against a base directory.
fn resolve_path(base: &str, relative: &str) -> String {
    if !relative.starts_with("..") {
        return format!("{}{}", base, relative);
    }
    // Handle "../" segments
    let mut base_parts: Vec<&str> = base.trim_end_matches('/').split('/').collect();
    let rel_parts: Vec<&str> = relative.split('/').collect();

    for part in &rel_parts {
        if *part == ".." {
            base_parts.pop();
        } else {
            base_parts.push(part);
        }
    }
    base_parts.join("/")
}

fn escape_json(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}
