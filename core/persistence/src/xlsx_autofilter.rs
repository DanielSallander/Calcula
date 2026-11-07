//! FILENAME: core/persistence/src/xlsx_autofilter.rs
//!
//! A TABLE's filter criteria in an .xlsx file (BUG-0740): Calcula's AutoFilter
//! state written into the table part's `<autoFilter>`, and a table part's
//! `<autoFilter>` read back into it.
//!
//! WHY. The table part carried only `<autoFilter ref=".."/>`: the export kept
//! the rows a filter had hidden (`<row hidden="1">`) and dropped the criterion
//! that hid them, so Excel opened a table with rows missing and no filter on
//! any column to say why, or to clear; the import did the same to Excel's.
//!
//! WHAT EXCEL WRITES [LIVE, Excel 16, 2026-11-06, lane xlsx probe3: a table
//! `Tbl` on A1:D6, `Range.AutoFilter 2, ">1"` and `4, "x", xlOr, "y"`, a
//! table `Tbl2` filtered to `Array("k0","k2")` with `xlFilterValues`]:
//!
//! ```text
//! <autoFilter ref="A1:D6">
//!   <filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="1"/></customFilters></filterColumn>
//!   <filterColumn colId="3"><filters><filter val="x"/><filter val="y"/></filters></filterColumn>
//! </autoFilter>
//! <autoFilter ref="G1:H6"><filterColumn colId="0"><filters><filter val="k0"/><filter val="k2"/></filters></filterColumn></autoFilter>
//! ```
//!
//! and the hidden rows as `<row hidden="1">`. `colId` is 0-based within the
//! range; `<customFilters and="1">` joins two criteria with AND (absent: OR,
//! ECMA-376 18.3.2.2); a missing `operator` is `equal`. A `<top10>` and a
//! `<dynamicFilter>` are the Top 10 and the date / average filters.
//!
//! CALCULA'S SIDE is the app's AutoFilter store, which rides the workbook as
//! `user_files["autofilters.json"]` (one filter per sheet, keyed by the
//! sheet's position, `app/src-tauri/src/autofilter.rs::AutoFilter`); the
//! import writes that entry and the app's load links the filter to its table
//! as it does for a `.cala`. Only the fields this module reads or writes are
//! named here: the JSON is the app's.
//!
//! A SHEET's own filter (no table) is the worksheet part's `<autoFilter>`,
//! and the filter's SORT definition (`sortState` on Calcula's filter, Data >
//! Reapply re-sorts by it) is `<sortState>` -- after a table part's
//! `<autoFilter>`, inside a sheet's (W2 xlsx / BUG-0740, wave 3).
//!
//! NOT CARRIED: an icon filter or sort (it names an icon set), a colour
//! filter or sort on EXPORT (it names a dxf the export does not write; on
//! import an RGB dxf colour is read), a date group (`<dateGroupItem>`), and a
//! filter on a SECOND table of a sheet (Calcula keeps one filter per sheet)
//! -- each is reported (`XlsxExportLosses::filters`,
//! `XlsxImportLosses::filters`); the rows it hid stay hidden either way.

use crate::Workbook;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// The workbook's AutoFilters by sheet position, as the app saved them.
pub(crate) fn sheet_filters(workbook: &Workbook) -> HashMap<usize, Value> {
    workbook
        .user_files
        .get("autofilters.json")
        .and_then(|bytes| serde_json::from_slice::<HashMap<String, Value>>(bytes).ok())
        .map(|all| all.into_iter().filter_map(|(k, v)| Some((k.parse::<usize>().ok()?, v))).collect())
        .unwrap_or_default()
}

/// A filter's range, 0-based `(start_row, start_col, end_row, end_col)`.
pub(crate) fn filter_range(filter: &Value) -> Option<(u32, u32, u32, u32)> {
    let n = |key: &str| filter.get(key).and_then(Value::as_u64).map(|v| v as u32);
    Some((n("startRow")?, n("startCol")?, n("endRow")?, n("endCol")?))
}

fn xml_attr(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// `A1` for 0-based `(row, col)`.
pub(crate) fn a1_address(row: u32, col: u32) -> String {
    let mut letters = String::new();
    let mut n = col + 1;
    while n > 0 {
        let r = (n - 1) % 26;
        letters.insert(0, (b'A' + r as u8) as char);
        n = (n - 1) / 26;
    }
    format!("{}{}", letters, row + 1)
}

/// Excel's operator for a Calcula custom criterion (`>1`, `<>x`, `=*a*`).
fn custom_filter(criterion: &str) -> String {
    let criterion = criterion.trim();
    let (operator, value) = [(">=", "greaterThanOrEqual"), ("<=", "lessThanOrEqual"), ("<>", "notEqual"), (">", "greaterThan"), ("<", "lessThan"), ("=", "")]
        .iter()
        .find_map(|(prefix, op)| criterion.strip_prefix(prefix).map(|rest| (*op, rest.trim())))
        .unwrap_or(("", criterion));
    if operator.is_empty() {
        format!("<customFilter val=\"{}\"/>", xml_attr(value))
    } else {
        format!("<customFilter operator=\"{}\" val=\"{}\"/>", operator, xml_attr(value))
    }
}

/// Excel's `dynamicFilter type` for Calcula's dynamic criterion.
fn dynamic_type(criterion: &str) -> Option<String> {
    const MONTHS: [&str; 12] =
        ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    if let Some(rest) = criterion.strip_prefix("allDatesInPeriod") {
        if let Some(q) = rest.strip_prefix("Quarter") {
            return Some(format!("Q{}", q));
        }
        return MONTHS.iter().position(|m| *m == rest).map(|i| format!("M{}", i + 1));
    }
    match criterion {
        "aboveAverage" | "belowAverage" | "today" | "tomorrow" | "yesterday" | "thisWeek" | "lastWeek" | "nextWeek"
        | "thisMonth" | "lastMonth" | "nextMonth" | "thisQuarter" | "lastQuarter" | "nextQuarter" | "thisYear"
        | "lastYear" | "nextYear" | "yearToDate" => Some(criterion.to_string()),
        _ => None,
    }
}

/// Calcula's dynamic criterion for Excel's `dynamicFilter type`.
fn dynamic_criterion(kind: &str) -> Option<String> {
    const MONTHS: [&str; 12] =
        ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    if let Some(m) = kind.strip_prefix('M').and_then(|n| n.parse::<usize>().ok()).filter(|n| (1..=12).contains(n)) {
        return Some(format!("allDatesInPeriod{}", MONTHS[m - 1]));
    }
    if let Some(q) = kind.strip_prefix('Q').and_then(|n| n.parse::<usize>().ok()).filter(|n| (1..=4).contains(n)) {
        return Some(format!("allDatesInPeriodQuarter{}", q));
    }
    dynamic_type(kind).filter(|_| !kind.starts_with("allDates"))
}

/// The `<autoFilter>` element a table part carries for `filter` (Calcula's
/// AutoFilter JSON), its criteria included, and whether a criterion could not
/// be written (a colour or icon filter).
pub(crate) fn auto_filter_element(filter: &Value) -> Option<(String, bool)> {
    let (r0, c0, r1, c1) = filter_range(filter)?;
    let mut lossy = false;
    let mut columns: Vec<(u64, String)> = Vec::new();
    if let Some(map) = filter.get("columnFilters").and_then(Value::as_object) {
        for column in map.values() {
            let Some(col) = column.get("columnIndex").and_then(Value::as_u64) else { continue };
            let criteria = column.get("criteria").cloned().unwrap_or(Value::Null);
            let text = |key: &str| criteria.get(key).and_then(Value::as_str).map(str::to_string);
            let filter_on = text("filterOn").unwrap_or_else(|| "values".to_string());
            let body = match filter_on.as_str() {
                "values" => {
                    let values: Vec<String> =
                        criteria.get("values").and_then(Value::as_array).map(|v| v.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                    let blanks = values.iter().any(|v| v == "(Blanks)");
                    let listed: Vec<&String> = values.iter().filter(|v| *v != "(Blanks)").collect();
                    if listed.is_empty() && !blanks {
                        // No list: "not blank" when blanks are filtered out,
                        // else no criterion at all (Excel's NonBlanks).
                        if criteria.get("filterOutBlanks").and_then(Value::as_bool).unwrap_or(false) {
                            Some("<customFilters><customFilter operator=\"notEqual\" val=\" \"/></customFilters>".to_string())
                        } else {
                            None
                        }
                    } else {
                        let mut out = String::from(if blanks { "<filters blank=\"1\">" } else { "<filters>" });
                        for v in listed {
                            out.push_str(&format!("<filter val=\"{}\"/>", xml_attr(v)));
                        }
                        out.push_str("</filters>");
                        Some(out)
                    }
                }
                "custom" => {
                    let parts: Vec<String> = [text("criterion1"), text("criterion2")].into_iter().flatten().map(|c| custom_filter(&c)).collect();
                    let and = criteria.get("operator").and_then(Value::as_str) != Some("or") && parts.len() == 2;
                    (!parts.is_empty()).then(|| format!("<customFilters{}>{}</customFilters>", if and { " and=\"1\"" } else { "" }, parts.concat()))
                }
                "topItems" | "topPercent" | "bottomItems" | "bottomPercent" => {
                    let n = text("criterion1").and_then(|c| c.trim().parse::<f64>().ok()).unwrap_or(10.0);
                    let top = filter_on.starts_with("top");
                    let percent = filter_on.ends_with("Percent");
                    Some(format!(
                        "<top10{}{} val=\"{}\"/>",
                        if top { "" } else { " top=\"0\"" },
                        if percent { " percent=\"1\"" } else { "" },
                        n
                    ))
                }
                "dynamic" => text("dynamicCriteria").as_deref().and_then(dynamic_type).map(|t| format!("<dynamicFilter type=\"{}\"/>", t)),
                _ => None,
            };
            match body {
                Some(body) => columns.push((col, body)),
                None if matches!(filter_on.as_str(), "values") => {}
                None => lossy = true,
            }
        }
    }
    columns.sort_by_key(|(col, _)| *col);
    let reference = format!("{}:{}", a1_address(r0, c0), a1_address(r1, c1));
    if columns.is_empty() {
        return Some((format!("<autoFilter ref=\"{}\"/>", reference), lossy));
    }
    let mut out = format!("<autoFilter ref=\"{}\">", reference);
    for (col, body) in columns {
        out.push_str(&format!("<filterColumn colId=\"{}\">{}</filterColumn>", col, body));
    }
    out.push_str("</autoFilter>");
    Some((out, lossy))
}

/// A part's `<autoFilter>` as Calcula's AutoFilter JSON (no `id`: the app
/// mints one), with the criteria Calcula can hold, and whether one could not
/// be read (a colour, icon or date-group filter). `None` when the part has no
/// `<autoFilter>`, or it filters no column.
pub(crate) fn parse_auto_filter(xml: &str) -> Option<(Value, bool)> {
    parse_auto_filter_with(xml, &[])
}

/// [`parse_auto_filter`] with the workbook's dxf colours, so a COLOUR filter
/// (`<colorFilter dxfId=".." [cellColor="0"]/>`) is read as Calcula's filter
/// by cell or font colour where its dxf names an RGB colour. A filter whose
/// criteria are ALL lost (a colour filter Calcula cannot hold, an icon or a
/// date-group filter) is still returned, with no columns and `lossy` set, so
/// the caller reports it rather than dropping it unsaid.
pub(crate) fn parse_auto_filter_with(xml: &str, dxfs: &[DxfColors]) -> Option<(Value, bool)> {
    use quick_xml::events::Event;
    let start = xml.find("<autoFilter")?;
    let mut reader = quick_xml::Reader::from_str(&xml[start..]);
    let attr = |e: &quick_xml::events::BytesStart, key: &str| -> Option<String> {
        e.attributes().flatten().find(|a| a.key.local_name().as_ref() == key.as_bytes()).map(|a| {
            let raw = String::from_utf8_lossy(&a.value).into_owned();
            quick_xml::escape::unescape(&raw).map(|v| v.into_owned()).unwrap_or(raw)
        })
    };
    let mut range: Option<(u32, u32, u32, u32)> = None;
    let mut columns = Map::new();
    let mut lossy = false;
    let mut col: Option<u64> = None;
    let mut values: Vec<String> = Vec::new();
    let mut blanks = false;
    let mut custom: Vec<String> = Vec::new();
    let mut and = false;
    let mut criteria: Option<Value> = None;
    let mut depth = 0usize;
    loop {
        let event = match reader.read_event() {
            Ok(e) => e,
            Err(_) => return None,
        };
        let is_empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(e) | Event::Empty(e) => {
                let name = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                match name.as_str() {
                    "autoFilter" => range = attr(&e, "ref").and_then(|r| crate::xlsx_tables::parse_ref(&r)),
                    "filterColumn" => {
                        col = attr(&e, "colId").and_then(|v| v.parse().ok());
                        values.clear();
                        blanks = false;
                        custom.clear();
                        and = false;
                        criteria = None;
                    }
                    "filters" => blanks = attr(&e, "blank").is_some_and(|v| v == "1" || v == "true"),
                    "filter" => values.extend(attr(&e, "val")),
                    "customFilters" => and = attr(&e, "and").is_some_and(|v| v == "1" || v == "true"),
                    "customFilter" => {
                        let value = attr(&e, "val").unwrap_or_default();
                        let prefix = match attr(&e, "operator").as_deref() {
                            Some("greaterThan") => ">",
                            Some("greaterThanOrEqual") => ">=",
                            Some("lessThan") => "<",
                            Some("lessThanOrEqual") => "<=",
                            Some("notEqual") => "<>",
                            _ => "=",
                        };
                        custom.push(format!("{}{}", prefix, value));
                    }
                    "top10" => {
                        let top = attr(&e, "top").map_or(true, |v| v == "1" || v == "true");
                        let percent = attr(&e, "percent").is_some_and(|v| v == "1" || v == "true");
                        let on = match (top, percent) {
                            (true, false) => "topItems",
                            (true, true) => "topPercent",
                            (false, false) => "bottomItems",
                            (false, true) => "bottomPercent",
                        };
                        let n = attr(&e, "val").unwrap_or_else(|| "10".to_string());
                        criteria = Some(json!({ "criterion1": n, "filterOn": on, "values": [], "filterOutBlanks": false }));
                    }
                    "dynamicFilter" => match attr(&e, "type").as_deref().and_then(dynamic_criterion) {
                        Some(kind) => criteria = Some(json!({ "filterOn": "dynamic", "dynamicCriteria": kind, "values": [], "filterOutBlanks": false })),
                        None => lossy = true,
                    },
                    "colorFilter" => {
                        // [LIVE, Excel 16, 2026-11-06, lane tabxlsx probe1]
                        // `AutoFilter 1, 255, xlFilterCellColor` on a table is
                        // saved `<colorFilter dxfId="0"/>`, the dxf
                        // `<fill><patternFill patternType="solid"><fgColor
                        // rgb="FFFF0000"/>..`; `cellColor="0"` is a FONT colour.
                        let by_cell = attr(&e, "cellColor").map_or(true, |v| v == "1" || v == "true");
                        let dxf = attr(&e, "dxfId").and_then(|v| v.parse::<usize>().ok()).and_then(|i| dxfs.get(i));
                        match dxf.and_then(|d| if by_cell { d.fill.clone() } else { d.font.clone() }) {
                            Some(color) => {
                                criteria = Some(json!({
                                    "filterOn": if by_cell { "cellColor" } else { "fontColor" },
                                    "color": color,
                                    "values": [],
                                    "filterOutBlanks": false
                                }))
                            }
                            None => lossy = true,
                        }
                    }
                    "iconFilter" | "dateGroupItem" => lossy = true,
                    _ => {}
                }
                if !is_empty {
                    depth += 1;
                }
            }
            Event::End(e) => {
                let name = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if name == "filterColumn" {
                    let found = criteria.take().or_else(|| {
                        if !custom.is_empty() {
                            // Excel's "not blank" is `<>` a space.
                            if custom.len() == 1 && custom[0] == "<> " {
                                return Some(json!({ "filterOn": "values", "values": [], "filterOutBlanks": true }));
                            }
                            let mut c = json!({ "criterion1": custom[0], "filterOn": "custom", "values": [], "filterOutBlanks": false });
                            if let Some(second) = custom.get(1) {
                                c["criterion2"] = json!(second);
                                c["operator"] = json!(if and { "and" } else { "or" });
                            }
                            Some(c)
                        } else if !values.is_empty() || blanks {
                            let mut list = values.clone();
                            if blanks {
                                list.push("(Blanks)".to_string());
                            }
                            Some(json!({ "filterOn": "values", "values": list, "filterOutBlanks": !blanks }))
                        } else {
                            None
                        }
                    });
                    if let (Some(c), Some(criteria)) = (col, found) {
                        columns.insert(c.to_string(), json!({ "columnIndex": c, "criteria": criteria }));
                    }
                    col = None;
                }
                depth = depth.saturating_sub(1);
                if name == "autoFilter" || depth == 0 {
                    break;
                }
            }
            Event::Eof => break,
            _ => {}
        }
        if depth == 0 && range.is_some() && is_empty {
            // `<autoFilter ref=".."/>`: no column filtered.
            break;
        }
    }
    let (r0, c0, r1, c1) = range?;
    if columns.is_empty() && !lossy {
        return None;
    }
    Some((
        json!({ "startRow": r0, "startCol": c0, "endRow": r1, "endCol": c1, "columnFilters": Value::Object(columns), "hiddenRows": [], "enabled": true }),
        lossy,
    ))
}

// ============================================================================
// DXF COLOURS (a colour filter's or a colour sort's colour)
// ============================================================================

/// The colours of one `<dxf>` of `xl/styles.xml`, as CSS (`#rrggbb`): its
/// fill and its font colour, where each is an RGB colour. A theme or indexed
/// colour is `None` (Calcula cannot resolve it here), so a criterion that
/// names it is reported lost, never matched against the wrong colour.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DxfColors {
    pub(crate) fill: Option<String>,
    pub(crate) font: Option<String>,
}

/// `FFFF0000` (ARGB) or `FF0000` as `#ff0000`.
fn css_of_rgb(rgb: &str) -> Option<String> {
    let hex = rgb.trim();
    let hex = if hex.len() == 8 { &hex[2..] } else { hex };
    (hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit())).then(|| format!("#{}", hex.to_ascii_lowercase()))
}

/// Every `<dxf>` of a styles part, in order (a `dxfId` indexes this list).
/// A colour filter's dxf names its colour as the pattern's `fgColor` [LIVE,
/// lane tabxlsx probe1: `<fgColor rgb="FFFF0000"/><bgColor rgb="FFFFFFFF"/>`
/// for a red cell]; a dxf with only a `bgColor` (how a conditional format's
/// solid fill is written) gives that.
pub(crate) fn parse_dxf_colors(styles_xml: &str) -> Vec<DxfColors> {
    use quick_xml::events::Event;
    let Some(start) = styles_xml.find("<dxfs") else { return Vec::new() };
    let mut reader = quick_xml::Reader::from_str(&styles_xml[start..]);
    let rgb = |e: &quick_xml::events::BytesStart| -> Option<String> {
        e.attributes()
            .flatten()
            .find(|a| a.key.local_name().as_ref() == b"rgb")
            .and_then(|a| css_of_rgb(&String::from_utf8_lossy(&a.value)))
    };
    let mut out = Vec::new();
    let mut current: Option<DxfColors> = None;
    let (mut in_fill, mut in_font) = (false, false);
    let (mut fg, mut bg): (Option<String>, Option<String>) = (None, None);
    loop {
        match reader.read_event() {
            // `<dxf/>`: nothing set.
            Ok(Event::Empty(e)) if e.local_name().as_ref() == b"dxf" => out.push(DxfColors::default()),
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                b"dxf" => current = Some(DxfColors::default()),
                b"fill" => {
                    in_fill = true;
                    fg = None;
                    bg = None;
                }
                b"font" => in_font = true,
                b"fgColor" if in_fill => fg = rgb(&e),
                b"bgColor" if in_fill => bg = rgb(&e),
                b"color" if in_font => {
                    if let Some(c) = current.as_mut() {
                        c.font = rgb(&e);
                    }
                }
                _ => {}
            },
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"fill" => {
                    in_fill = false;
                    if let Some(c) = current.as_mut() {
                        c.fill = fg.take().or(bg.take());
                    }
                }
                b"font" => in_font = false,
                b"dxf" => out.extend(current.take()),
                b"dxfs" => break,
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

// ============================================================================
// SORT STATE (Data > Reapply re-sorts, BUG-0740)
// ============================================================================

/// Excel's English custom lists for Calcula's built-in sort orders.
const BUILT_IN_LISTS: [(&str, &str); 4] = [
    ("weekdays", "Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday"),
    ("weekdaysShort", "Sun,Mon,Tue,Wed,Thu,Fri,Sat"),
    ("months", "January,February,March,April,May,June,July,August,September,October,November,December"),
    ("monthsShort", "Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec"),
];

/// The `<sortState>` a filter's sort definition is written as (Calcula's
/// AutoFilter `sortState`, keys relative to the filter's first column), and
/// whether a level could not be written (a colour or icon sort, which names a
/// dxf / an icon set). `None` when the filter keeps no sort.
///
/// [LIVE, Excel 16, 2026-11-06, lane tabxlsx probe1] a table `ST` (A1:B7)
/// sorted ascending on its second column is saved
/// `<sortState ref="A2:B7"><sortCondition ref="B2:B7"/></sortState>` after
/// its `<autoFilter>`, a descending level `descending="1"`; a sheet filter's
/// is the same element after the worksheet's `<autoFilter>`.
pub(crate) fn sort_state_element(filter: &Value) -> Option<(String, bool)> {
    let (r0, c0, r1, c1) = filter_range(filter)?;
    let state = filter.get("sortState")?;
    let fields = state.get("fields").and_then(Value::as_array)?;
    if r1 <= r0 {
        return None;
    }
    let mut lossy = false;
    let mut conditions = String::new();
    for field in fields {
        let Some(key) = field.get("key").and_then(Value::as_u64) else { continue };
        let col = c0 + key as u32;
        if col > c1 {
            lossy = true;
            continue;
        }
        let sort_on = field.get("sortOn").and_then(Value::as_str).unwrap_or("value");
        if sort_on != "value" {
            lossy = true;
            continue;
        }
        let descending = field.get("ascending").and_then(Value::as_bool) == Some(false);
        let custom = field.get("customOrder").and_then(Value::as_str).map(|order| {
            BUILT_IN_LISTS.iter().find(|(name, _)| *name == order).map_or(order.to_string(), |(_, list)| list.to_string())
        });
        conditions.push_str(&format!(
            "<sortCondition{} ref=\"{}:{}\"{}/>",
            if descending { " descending=\"1\"" } else { "" },
            a1_address(r0 + 1, col),
            a1_address(r1, col),
            custom.map(|c| format!(" customList=\"{}\"", xml_attr(&c))).unwrap_or_default()
        ));
    }
    if conditions.is_empty() {
        return lossy.then(|| (String::new(), true));
    }
    let case = if state.get("matchCase").and_then(Value::as_bool) == Some(true) { " caseSensitive=\"1\"" } else { "" };
    Some((
        format!("<sortState{} ref=\"{}:{}\">{}</sortState>", case, a1_address(r0 + 1, c0), a1_address(r1, c1), conditions),
        lossy,
    ))
}

/// A part's `<sortState>` as Calcula's AutoFilter `sortState` (keys relative
/// to `first_col`, the filter's first column), and whether a level could not
/// be read (an icon sort, or a colour whose dxf names no RGB colour). `None`
/// when the part keeps no sort.
pub(crate) fn parse_sort_state(xml: &str, first_col: u32, dxfs: &[DxfColors]) -> Option<(Value, bool)> {
    use quick_xml::events::Event;
    let start = xml.find("<sortState")?;
    let mut reader = quick_xml::Reader::from_str(&xml[start..]);
    let attr = |e: &quick_xml::events::BytesStart, key: &str| -> Option<String> {
        e.attributes().flatten().find(|a| a.key.local_name().as_ref() == key.as_bytes()).map(|a| {
            let raw = String::from_utf8_lossy(&a.value).into_owned();
            quick_xml::escape::unescape(&raw).map(|v| v.into_owned()).unwrap_or(raw)
        })
    };
    let truthy = |v: Option<String>| v.is_some_and(|v| v == "1" || v == "true");
    let mut match_case = false;
    let mut fields: Vec<Value> = Vec::new();
    let mut lossy = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                b"sortState" => match_case = truthy(attr(&e, "caseSensitive")),
                b"sortCondition" => {
                    let Some((_, col, _, _)) = attr(&e, "ref").and_then(|r| crate::xlsx_tables::parse_ref(&r)) else {
                        lossy = true;
                        continue;
                    };
                    let Some(key) = col.checked_sub(first_col) else {
                        lossy = true;
                        continue;
                    };
                    let mut field = json!({ "key": key, "ascending": !truthy(attr(&e, "descending")) });
                    match attr(&e, "sortBy").as_deref().unwrap_or("value") {
                        "value" => {}
                        by @ ("cellColor" | "fontColor") => {
                            let dxf = attr(&e, "dxfId").and_then(|v| v.parse::<usize>().ok()).and_then(|i| dxfs.get(i));
                            let color = dxf.and_then(|d| if by == "cellColor" { d.fill.clone() } else { d.font.clone() });
                            match color {
                                Some(color) => {
                                    field["sortOn"] = json!(by);
                                    field["color"] = json!(color);
                                }
                                None => {
                                    lossy = true;
                                    continue;
                                }
                            }
                        }
                        _ => {
                            lossy = true;
                            continue;
                        }
                    }
                    if let Some(list) = attr(&e, "customList").filter(|l| !l.is_empty()) {
                        let named = BUILT_IN_LISTS.iter().find(|(_, text)| *text == list).map(|(name, _)| name.to_string());
                        field["customOrder"] = json!(named.unwrap_or(list));
                    }
                    fields.push(field);
                }
                _ => {}
            },
            Ok(Event::End(e)) if e.local_name().as_ref() == b"sortState" => break,
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    if fields.is_empty() {
        return lossy.then(|| (Value::Null, true));
    }
    Some((json!({ "fields": fields, "matchCase": match_case }), lossy))
}

/// The worksheet's OWN `<autoFilter>` (a sheet filter, not a table's: a
/// table's lives in its table part) with its `<sortState>`, as Calcula's
/// AutoFilter JSON, and whether a criterion or a sort level was lost. A sheet
/// filter with no criterion is returned too: its dropdowns are the filter.
/// [LIVE, Excel 16, 2026-11-06, lane tabxlsx probe1] a sheet filtered on
/// A1:B7 is saved `<sheetPr filterMode="1"/>`, `<autoFilter ref="A1:B7"><filterColumn colId="1"><customFilters><customFilter
/// operator="greaterThan" val="1"/></customFilters></filterColumn></autoFilter><sortState ref="A3:B7"><sortCondition
/// descending="1" ref="B2:B7"/></sortState>` and a hidden name
/// `_xlnm._FilterDatabase` (localSheetId) for `S4s!$A$1:$B$7`.
pub(crate) fn parse_sheet_auto_filter(sheet_xml: &str, dxfs: &[DxfColors]) -> Option<(Value, bool)> {
    // The worksheet's own `<autoFilter>` comes BEFORE `<customSheetViews>` in
    // CT_Worksheet, and each custom view may carry an `<autoFilter>` of its
    // own: searched past that point, a sheet with no filter but a view that
    // has one imported the VIEW's as the live filter, and every row hidden by
    // hand in its range became filter-hidden.
    let own_part = sheet_xml.find("<customSheetViews").map_or(sheet_xml, |end| &sheet_xml[..end]);
    let at = own_part.find("<autoFilter")?;
    let element = &sheet_xml[at..];
    let (mut filter, mut lossy) = match parse_auto_filter_with(element, dxfs) {
        Some(found) => found,
        None => {
            // A range with no criterion: the filter's dropdowns alone.
            let open = &element[..element.find('>')?];
            let reference = open.find(" ref=\"").map(|i| &open[i + 6..]).and_then(|r| r.find('"').map(|e| &r[..e]))?;
            let (r0, c0, r1, c1) = crate::xlsx_tables::parse_ref(reference)?;
            (json!({ "startRow": r0, "startCol": c0, "endRow": r1, "endCol": c1, "columnFilters": {}, "hiddenRows": [], "enabled": true }), false)
        }
    };
    // The filter's sort is the `<sortState>` INSIDE its element (a sibling
    // one is the sheet's own Sort, `with_sort_inside`).
    let open_end = element.find('>')?;
    let own = if element[..open_end].ends_with('/') {
        ""
    } else {
        element.find("</autoFilter>").map_or("", |e| &element[..e])
    };
    attach_sort_state(&mut filter, &mut lossy, own, dxfs);
    Some((filter, lossy))
}

/// `<autoFilter>` element `element` with `sort` (a `<sortState>`, or "")
/// placed inside it, after its columns, as a SHEET filter carries it.
pub(crate) fn with_sort_inside(element: &str, sort: &str) -> String {
    if sort.is_empty() {
        return element.to_string();
    }
    if let Some(open) = element.strip_suffix("/>") {
        return format!("{}>{}</autoFilter>", open, sort);
    }
    match element.rfind("</autoFilter>") {
        Some(at) => format!("{}{}{}", &element[..at], sort, &element[at..]),
        None => element.to_string(),
    }
}

/// The part's `<sortState>` set on `filter` (see [`parse_sort_state`]).
pub(crate) fn attach_sort_state(filter: &mut Value, lossy: &mut bool, xml: &str, dxfs: &[DxfColors]) {
    let Some((_, c0, _, _)) = filter_range(filter) else { return };
    if let Some((state, lost)) = parse_sort_state(xml, c0, dxfs) {
        *lossy |= lost;
        if !state.is_null() {
            filter["sortState"] = state;
        }
    }
}

#[cfg(test)]
#[path = "xlsx_autofilter_tests.rs"]
mod tests;
