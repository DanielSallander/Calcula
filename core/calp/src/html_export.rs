//! FILENAME: core/calp/src/html_export.rs
//! PURPOSE: Self-contained HTML renderer for a published .calp package version.
//! CONTEXT: "Recipient reach" — let a publisher turn a published report into a
//! single offline `.html` file any phone/Mac/browser can open WITHOUT Calcula.
//!
//! This reads a published version's artifacts through the `RegistryTransport`
//! seam (so it works for any transport, local or future HTTP) exactly the way
//! `pull.rs` does — `sheets/{id}/data.json`, `styles.json`, `layout.json`,
//! `metadata.json` — then renders ONE self-contained HTML document: no external
//! CSS/JS/font/image references, everything inline, so the file works offline.
//!
//! SECURITY: a `.calp` package is THIRD-PARTY content. Every value lifted from
//! the package — cell text, sheet names, publisher name, package name — is
//! HTML-escaped before insertion (`&`, `<`, `>`, `"`, `'`). The only `<script>`
//! ever emitted is the fixed viewer-toggle in Viewer mode, which references NO
//! package data as code. A published cell value can therefore never inject
//! markup or script.

use std::collections::HashMap;
use std::fmt::Write as _;

use engine::style::{
    BorderLineStyle, BorderStyle, CellStyle, TextAlign, UnderlineStyle, VerticalAlign,
};
use persistence::{SavedCell, SavedCellValue, SavedMergedRegion};

use crate::error::CalpError;
use crate::manifest::PublishedSheetMetadata;
use crate::transport::RegistryTransport;

/// Output flavor for [`render_package_html`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HtmlExportMode {
    /// All sheets stacked under `<h2>` headings, print/PDF-friendly, no script.
    Static,
    /// Sheet tabs at the top with a tiny vanilla toggle script.
    Viewer,
}

/// Options controlling the HTML export.
#[derive(Debug, Clone)]
pub struct HtmlExportOptions {
    pub mode: HtmlExportMode,
}

impl Default for HtmlExportOptions {
    fn default() -> Self {
        Self { mode: HtmlExportMode::Static }
    }
}

/// A single sheet, read + resolved from the package, ready to render.
struct RenderSheet {
    name: String,
    cells: HashMap<(u32, u32), SavedCell>,
    styles: Vec<CellStyle>,
    column_widths: HashMap<u32, f64>,
    row_heights: HashMap<u32, f64>,
    metadata: PublishedSheetMetadata,
    /// Inclusive used range (max row / max col), already trimmed of empty
    /// trailing rows/cols. `None` when the sheet has no content at all.
    used: Option<(u32, u32)>,
}

// Default grid metrics (px) when the layout omits a row/column dimension.
const DEFAULT_COL_WIDTH: f64 = 80.0;
const DEFAULT_ROW_HEIGHT: f64 = 22.0;

/// Render a published `.calp` package version as ONE self-contained HTML
/// document. The package is read through `registry` (any `RegistryTransport`),
/// so this works for the local registry today and a future HTTP one unchanged.
///
/// Returns the complete HTML as a `String`. No external references are emitted:
/// the file is fully offline-portable.
pub fn render_package_html(
    registry: &dyn RegistryTransport,
    package: &str,
    version: &str,
    opts: &HtmlExportOptions,
) -> Result<String, CalpError> {
    let manifest = registry.get_version_manifest(package, version)?;

    // Read + resolve every visible sheet from the manifest, mirroring pull.rs.
    let mut sheets: Vec<RenderSheet> = Vec::new();
    for pub_sheet in &manifest.sheets {
        let sheet_prefix = format!("sheets/{}", pub_sheet.sheet_id);

        // metadata.json — read first so we can skip hidden/veryHidden sheets
        // before doing the rest of the work.
        let metadata: PublishedSheetMetadata =
            match registry.read_artifact(package, version, &format!("{sheet_prefix}/metadata.json"))? {
                Some(bytes) => serde_json::from_slice(&bytes)?,
                None => PublishedSheetMetadata::default(),
            };
        if is_hidden_visibility(&metadata.visibility) {
            continue;
        }

        // data.json -> SheetData -> (row,col) -> SavedCell. NOTE: data.json does
        // NOT carry per-cell style indices (they are always 0 here); the
        // cell_styles.json companion below re-associates each cell with its
        // style in the registry (styles.json).
        let mut cells: HashMap<(u32, u32), SavedCell> =
            match registry.read_artifact(package, version, &format!("{sheet_prefix}/data.json"))? {
                Some(bytes) => {
                    let sd: calcula_format::sheet_data::SheetData = serde_json::from_slice(&bytes)?;
                    calcula_format::sheet_data::sheet_data_to_cells(&sd)
                }
                None => HashMap::new(),
            };

        // cell_styles.json -> A1 -> style index, applied onto the cells (and
        // creating style-only empty cells where needed). Absent for sheets with
        // no non-default styles.
        if let Some(bytes) =
            registry.read_artifact(package, version, &format!("{sheet_prefix}/cell_styles.json"))?
        {
            let sheet_styles: calcula_format::sheet_styles::SheetStyles =
                serde_json::from_slice(&bytes)?;
            calcula_format::sheet_styles::apply_sheet_styles(&mut cells, &sheet_styles);
        }

        // styles.json -> Vec<CellStyle> (indexed by SavedCell::style_index)
        let styles: Vec<CellStyle> =
            match registry.read_artifact(package, version, &format!("{sheet_prefix}/styles.json"))? {
                Some(bytes) => serde_json::from_slice(&bytes)?,
                None => vec![CellStyle::new()],
            };

        // layout.json -> column widths / row heights
        let (column_widths, row_heights) =
            match registry.read_artifact(package, version, &format!("{sheet_prefix}/layout.json"))? {
                Some(bytes) => {
                    let layout: calcula_format::sheet_layout::SheetLayout =
                        serde_json::from_slice(&bytes)?;
                    layout.to_dimensions()
                }
                None => (HashMap::new(), HashMap::new()),
            };

        let used = compute_used_range(&cells);

        sheets.push(RenderSheet {
            name: pub_sheet.name.clone(),
            cells,
            styles,
            column_widths,
            row_heights,
            metadata,
            used,
        });
    }

    Ok(build_document(package, &manifest.version, &manifest.publisher_name, &sheets, opts))
}

/// A sheet visibility is "hidden" or "veryHidden" (case-insensitive) when it
/// must be omitted from the report.
fn is_hidden_visibility(visibility: &str) -> bool {
    let v = visibility.to_ascii_lowercase();
    v == "hidden" || v == "veryhidden"
}

/// Compute the inclusive used range (max row, max col) over cells that actually
/// carry content. Trailing empty rows/cols fall away automatically because an
/// empty cell never extends the maximum. Returns `None` for an empty sheet.
fn compute_used_range(cells: &HashMap<(u32, u32), SavedCell>) -> Option<(u32, u32)> {
    let mut max_row: Option<u32> = None;
    let mut max_col: Option<u32> = None;
    for (&(row, col), cell) in cells {
        if cell_is_blank(cell) {
            continue;
        }
        max_row = Some(max_row.map_or(row, |m| m.max(row)));
        max_col = Some(max_col.map_or(col, |m| m.max(col)));
    }
    match (max_row, max_col) {
        (Some(r), Some(c)) => Some((r, c)),
        _ => None,
    }
}

/// A cell that contributes no visible content and no non-default style: it does
/// not extend the used range.
fn cell_is_blank(cell: &SavedCell) -> bool {
    matches!(cell.value, SavedCellValue::Empty)
        && cell.formula.is_none()
        && cell.rich_text.is_none()
        && cell.style_index == 0
}

// ===========================================================================
// Document assembly
// ===========================================================================

fn build_document(
    package: &str,
    version: &str,
    publisher_name: &str,
    sheets: &[RenderSheet],
    opts: &HtmlExportOptions,
) -> String {
    let title = format!("{} {}", package, version);
    let mut out = String::with_capacity(8 * 1024);

    out.push_str("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n");
    out.push_str("<meta charset=\"utf-8\">\n");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    let _ = write!(out, "<title>{}</title>\n", escape_html(&title));
    out.push_str("<style>\n");
    out.push_str(base_css(opts.mode));
    out.push_str("</style>\n</head>\n<body>\n");

    // Report header.
    out.push_str("<header class=\"calp-report-header\">\n");
    let _ = write!(out, "<h1>{}</h1>\n", escape_html(package));
    let _ = write!(
        out,
        "<div class=\"calp-meta\">Version {}</div>\n",
        escape_html(version)
    );
    if !publisher_name.is_empty() {
        let _ = write!(
            out,
            "<div class=\"calp-meta\">Published by {}</div>\n",
            escape_html(publisher_name)
        );
    }
    out.push_str("</header>\n");

    match opts.mode {
        HtmlExportMode::Static => build_static_body(&mut out, sheets),
        HtmlExportMode::Viewer => build_viewer_body(&mut out, sheets),
    }

    out.push_str("</body>\n</html>\n");
    out
}

/// Static mode: every sheet stacked under an `<h2>`, page-break before each.
fn build_static_body(out: &mut String, sheets: &[RenderSheet]) {
    for (i, sheet) in sheets.iter().enumerate() {
        let extra = if i == 0 { "" } else { " calp-page-break" };
        let _ = write!(out, "<section class=\"calp-sheet{}\">\n", extra);
        let _ = write!(out, "<h2>{}</h2>\n", escape_html(&sheet.name));
        render_sheet_table(out, sheet);
        out.push_str("</section>\n");
    }
}

/// Viewer mode: a row of tabs + one toggled `<div data-sheet>` per sheet, plus a
/// fixed vanilla toggle script that references no package data as code.
fn build_viewer_body(out: &mut String, sheets: &[RenderSheet]) {
    // Tabs.
    out.push_str("<nav class=\"calp-tabs\" role=\"tablist\">\n");
    for (i, sheet) in sheets.iter().enumerate() {
        let active = if i == 0 { " calp-tab-active" } else { "" };
        let _ = write!(
            out,
            "<button type=\"button\" class=\"calp-tab{}\" data-tab=\"{}\">{}</button>\n",
            active,
            i,
            escape_html(&sheet.name)
        );
    }
    out.push_str("</nav>\n");

    // Panels.
    for (i, sheet) in sheets.iter().enumerate() {
        let hidden = if i == 0 { "" } else { " hidden" };
        let _ = write!(
            out,
            "<div class=\"calp-sheet\" data-sheet=\"{}\"{}>\n",
            i, hidden
        );
        render_sheet_table(out, sheet);
        out.push_str("</div>\n");
    }

    // Fixed toggle script (no package data flows into code).
    out.push_str(viewer_script());
}

// ===========================================================================
// Sheet table rendering
// ===========================================================================

fn render_sheet_table(out: &mut String, sheet: &RenderSheet) {
    let (max_row, max_col) = match sheet.used {
        Some(rc) => rc,
        None => {
            out.push_str("<p class=\"calp-empty\">(empty sheet)</p>\n");
            return;
        }
    };

    // Cells covered by a non-top-left merge corner are omitted entirely.
    let covered = build_covered_set(&sheet.metadata.merged_regions, max_row, max_col);
    // Top-left -> (rowspan, colspan).
    let merge_origins = build_merge_origins(&sheet.metadata.merged_regions);

    // Default style used for cells with no entry / out-of-range style index.
    let default_style = CellStyle::new();

    let gridlines = sheet.metadata.show_gridlines;
    let table_class = if gridlines { "calp-grid calp-gridlines" } else { "calp-grid" };
    let _ = write!(out, "<table class=\"{}\">\n", table_class);

    // <colgroup> with per-column widths.
    out.push_str("<colgroup>\n");
    for col in 0..=max_col {
        if sheet.metadata.hidden_cols.contains(&col) {
            continue;
        }
        let width = sheet
            .column_widths
            .get(&col)
            .copied()
            .unwrap_or(DEFAULT_COL_WIDTH);
        let _ = write!(out, "<col style=\"width:{}px\">\n", fmt_px(width));
    }
    out.push_str("</colgroup>\n");

    out.push_str("<tbody>\n");
    for row in 0..=max_row {
        if sheet.metadata.hidden_rows.contains(&row) {
            continue;
        }
        let height = sheet
            .row_heights
            .get(&row)
            .copied()
            .unwrap_or(DEFAULT_ROW_HEIGHT);
        let _ = write!(out, "<tr style=\"height:{}px\">\n", fmt_px(height));

        for col in 0..=max_col {
            if sheet.metadata.hidden_cols.contains(&col) {
                continue;
            }
            if covered.contains(&(row, col)) {
                // Covered by a merge whose origin is elsewhere — omit the cell.
                continue;
            }

            let cell = sheet.cells.get(&(row, col));
            let style = cell
                .map(|c| resolve_style(&sheet.styles, c.style_index, &default_style))
                .unwrap_or(&default_style);

            let mut span_attr = String::new();
            if let Some(&(rowspan, colspan)) = merge_origins.get(&(row, col)) {
                if rowspan > 1 {
                    let _ = write!(span_attr, " rowspan=\"{}\"", rowspan);
                }
                if colspan > 1 {
                    let _ = write!(span_attr, " colspan=\"{}\"", colspan);
                }
            }

            let css = cell_css(style);
            let text = cell.map(display_text).unwrap_or_default();
            let _ = write!(
                out,
                "<td{}{}>{}</td>\n",
                span_attr,
                style_attr(&css),
                escape_html(&text)
            );
        }
        out.push_str("</tr>\n");
    }
    out.push_str("</tbody>\n</table>\n");
}

/// Resolve a cell's style by index, falling back to `default` for an
/// out-of-range index (matches `StyleRegistry::get` behavior).
fn resolve_style<'a>(
    styles: &'a [CellStyle],
    index: usize,
    default: &'a CellStyle,
) -> &'a CellStyle {
    styles.get(index).unwrap_or(default)
}

/// Build the set of (row,col) coordinates that are COVERED by a merge region —
/// i.e. every cell in the rectangle except its top-left origin.
fn build_covered_set(
    regions: &[SavedMergedRegion],
    max_row: u32,
    max_col: u32,
) -> std::collections::HashSet<(u32, u32)> {
    let mut covered = std::collections::HashSet::new();
    for r in regions {
        let (sr, sc) = (r.start_row.min(r.end_row), r.start_col.min(r.end_col));
        let (er, ec) = (r.start_row.max(r.end_row), r.start_col.max(r.end_col));
        for row in sr..=er.min(max_row) {
            for col in sc..=ec.min(max_col) {
                if (row, col) == (sr, sc) {
                    continue; // origin keeps the cell
                }
                covered.insert((row, col));
            }
        }
    }
    covered
}

/// Map each merge region's top-left origin to its (rowspan, colspan).
fn build_merge_origins(
    regions: &[SavedMergedRegion],
) -> HashMap<(u32, u32), (u32, u32)> {
    let mut origins = HashMap::new();
    for r in regions {
        let (sr, sc) = (r.start_row.min(r.end_row), r.start_col.min(r.end_col));
        let (er, ec) = (r.start_row.max(r.end_row), r.start_col.max(r.end_col));
        let rowspan = er - sr + 1;
        let colspan = ec - sc + 1;
        origins.insert((sr, sc), (rowspan, colspan));
    }
    origins
}

// ===========================================================================
// CellStyle -> CSS
// ===========================================================================

/// Produce the list of CSS declarations for a cell from its `CellStyle`.
fn cell_css(style: &CellStyle) -> Vec<String> {
    let mut decls: Vec<String> = Vec::new();

    // --- Font ---
    let family = resolve_font_family(&style.font.family);
    decls.push(format!("font-family:{}", css_font_family(&family)));
    decls.push(format!("font-size:{}pt", style.font.size));
    if style.font.bold {
        decls.push("font-weight:bold".to_string());
    }
    if style.font.italic {
        decls.push("font-style:italic".to_string());
    }
    // underline + strikethrough combine into one text-decoration.
    let mut deco: Vec<&str> = Vec::new();
    if !matches!(style.font.underline, UnderlineStyle::None) {
        deco.push("underline");
    }
    if style.font.strikethrough {
        deco.push("line-through");
    }
    if !deco.is_empty() {
        decls.push(format!("text-decoration:{}", deco.join(" ")));
    }

    // text color
    decls.push(format!("color:{}", style.font.color.to_css_default()));

    // --- Fill / background ---
    if !style.fill.is_none() {
        let bg = style.fill.background_color().to_css_default();
        decls.push(format!("background-color:{}", bg));
    }

    // --- Alignment ---
    if let Some(ta) = text_align_css(style.text_align) {
        decls.push(format!("text-align:{}", ta));
    }
    decls.push(format!("vertical-align:{}", vertical_align_css(style.vertical_align)));

    // --- Borders (per side, only where present) ---
    if let Some(b) = border_css(&style.borders.top) {
        decls.push(format!("border-top:{}", b));
    }
    if let Some(b) = border_css(&style.borders.right) {
        decls.push(format!("border-right:{}", b));
    }
    if let Some(b) = border_css(&style.borders.bottom) {
        decls.push(format!("border-bottom:{}", b));
    }
    if let Some(b) = border_css(&style.borders.left) {
        decls.push(format!("border-left:{}", b));
    }

    // --- Wrap / indent ---
    if style.wrap_text {
        decls.push("white-space:normal".to_string());
        decls.push("word-break:break-word".to_string());
    }
    if style.indent > 0 {
        // Each indent level ~= 8px in Calcula's grid.
        decls.push(format!("padding-left:{}px", (style.indent as u32) * 8 + 2));
    }

    decls
}

/// Map TextAlign to a CSS text-align value. `General` returns None so the
/// browser/print default applies (which is fine for a static report).
fn text_align_css(a: TextAlign) -> Option<&'static str> {
    match a {
        TextAlign::General => None,
        TextAlign::Left => Some("left"),
        TextAlign::Center => Some("center"),
        TextAlign::Right => Some("right"),
    }
}

fn vertical_align_css(a: VerticalAlign) -> &'static str {
    match a {
        VerticalAlign::Top => "top",
        VerticalAlign::Middle => "middle",
        VerticalAlign::Bottom => "bottom",
    }
}

/// Build a CSS shorthand for a single border side, or None when there is no
/// border on that side.
fn border_css(b: &BorderStyle) -> Option<String> {
    let line = match b.style {
        BorderLineStyle::None => return None,
        BorderLineStyle::Solid => "solid",
        BorderLineStyle::Dashed => "dashed",
        BorderLineStyle::Dotted => "dotted",
        BorderLineStyle::Double => "double",
    };
    if b.width == 0 {
        return None;
    }
    // width: 1=thin, 2=medium, 3=thick -> 1px / 2px / 3px (clamped).
    let px = (b.width as u32).clamp(1, 4);
    let color = b.color.to_css_default();
    Some(format!("{}px {} {}", px, line, color))
}

/// Resolve theme-font keywords ("Body"/"Headings") to the Office theme's actual
/// font; pass any other family through unchanged.
fn resolve_font_family(family: &str) -> String {
    match family {
        "Body" | "body" => "Calibri".to_string(),
        "Headings" | "headings" => "Calibri Light".to_string(),
        other => other.to_string(),
    }
}

/// Quote a font family for CSS if it contains spaces; always provide a sensible
/// fallback stack so the report stays readable on devices lacking the font.
fn css_font_family(family: &str) -> String {
    let primary = if family.contains(' ') {
        format!("'{}'", family.replace('\'', ""))
    } else {
        family.to_string()
    };
    format!("{}, Calibri, Arial, sans-serif", primary)
}

/// Render a `style="..."` attribute (with leading space) for a set of CSS
/// declarations, or empty string when there are none.
fn style_attr(decls: &[String]) -> String {
    if decls.is_empty() {
        return String::new();
    }
    // CRITICAL: declarations include package-controlled values (notably the
    // font-family name). Without escaping, a font name like `x"><script>...`
    // would break out of the style="" attribute and inject markup into the
    // report a recipient opens in a browser. Escaping the whole declaration
    // string neutralizes that — `"`/`<`/`&` become entities the browser decodes
    // back to the intended CSS inside the attribute, so styling is unaffected.
    format!(" style=\"{}\"", escape_html(&decls.join(";")))
}

/// Format a pixel dimension without a trailing `.0` for whole numbers.
fn fmt_px(v: f64) -> String {
    let rounded = (v * 100.0).round() / 100.0;
    if (rounded.fract()).abs() < f64::EPSILON {
        format!("{}", rounded as i64)
    } else {
        format!("{}", rounded)
    }
}

// ===========================================================================
// Cell display text
// ===========================================================================

/// Compute the display string for a cell value. Mirrors how a spreadsheet shows
/// a stored value: numbers without trailing `.0` for integers, booleans as
/// TRUE/FALSE, errors as `#ERROR`-ish text. The result is NOT yet HTML-escaped;
/// callers escape at the insertion site.
fn display_text(cell: &SavedCell) -> String {
    saved_value_display(&cell.value)
}

fn saved_value_display(value: &SavedCellValue) -> String {
    match value {
        SavedCellValue::Empty => String::new(),
        SavedCellValue::Number(n) => format_number(*n),
        SavedCellValue::Text(s) => s.clone(),
        SavedCellValue::Boolean(b) => {
            if *b { "TRUE".to_string() } else { "FALSE".to_string() }
        }
        SavedCellValue::Error(msg) => {
            if msg.is_empty() {
                "#ERROR".to_string()
            } else {
                format!("#{}", msg)
            }
        }
        SavedCellValue::List(items) => {
            let parts: Vec<String> = items.iter().map(saved_value_display).collect();
            parts.join(", ")
        }
        SavedCellValue::Dict(entries) => {
            let parts: Vec<String> = entries
                .iter()
                .map(|(k, v)| format!("{}: {}", k, saved_value_display(v)))
                .collect();
            parts.join(", ")
        }
    }
}

/// Format a number for display: integers print without a decimal point; other
/// values use the shortest round-trippable representation Rust gives.
fn format_number(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

// ===========================================================================
// HTML escaping (SECURITY)
// ===========================================================================

/// Escape text for safe insertion into HTML body / attribute context. A
/// published cell value, sheet name, or publisher name must NEVER be able to
/// inject markup or script — so `&`, `<`, `>`, `"`, and `'` are all escaped.
fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

// ===========================================================================
// Static assets (CSS + viewer script) — fixed, no package data
// ===========================================================================

fn base_css(mode: HtmlExportMode) -> &'static str {
    match mode {
        HtmlExportMode::Static => STATIC_CSS,
        HtmlExportMode::Viewer => VIEWER_CSS,
    }
}

const STATIC_CSS: &str = r#"
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  font-family: Calibri, Arial, sans-serif;
  color: #1a1a1a;
  background: #ffffff;
}
.calp-report-header { margin-bottom: 20px; }
.calp-report-header h1 { margin: 0 0 4px 0; font-size: 22px; }
.calp-meta { color: #555; font-size: 13px; }
.calp-sheet h2 { font-size: 17px; margin: 18px 0 8px 0; }
.calp-empty { color: #888; font-style: italic; }
table.calp-grid {
  border-collapse: collapse;
  table-layout: fixed;
  margin-bottom: 12px;
}
table.calp-grid td {
  padding: 1px 4px;
  overflow: hidden;
  white-space: nowrap;
  vertical-align: middle;
}
table.calp-gridlines td {
  border: 1px solid #d4d4d4;
}
@media print {
  body { padding: 0; margin: 1cm; }
  .calp-page-break { page-break-before: always; }
  .calp-sheet { page-break-inside: auto; }
  table.calp-grid { page-break-inside: auto; }
  tr { page-break-inside: avoid; }
}
"#;

const VIEWER_CSS: &str = r#"
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  font-family: Calibri, Arial, sans-serif;
  color: #1a1a1a;
  background: #ffffff;
}
.calp-report-header { margin-bottom: 16px; }
.calp-report-header h1 { margin: 0 0 4px 0; font-size: 22px; }
.calp-meta { color: #555; font-size: 13px; }
.calp-empty { color: #888; font-style: italic; }
.calp-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  border-bottom: 2px solid #ccc;
  margin-bottom: 12px;
}
.calp-tab {
  border: 1px solid #ccc;
  border-bottom: none;
  background: #f3f3f3;
  padding: 6px 14px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px 4px 0 0;
}
.calp-tab-active {
  background: #ffffff;
  font-weight: bold;
}
.calp-sheet[hidden] { display: none; }
table.calp-grid {
  border-collapse: collapse;
  table-layout: fixed;
  margin-bottom: 12px;
}
table.calp-grid td {
  padding: 1px 4px;
  overflow: hidden;
  white-space: nowrap;
  vertical-align: middle;
}
table.calp-gridlines td {
  border: 1px solid #d4d4d4;
}
"#;

/// The fixed viewer-toggle script. Vanilla JS, no dependencies, references NO
/// package data as code — it only reads `data-tab` / `data-sheet` indices set
/// by the (escaped) markup above.
fn viewer_script() -> &'static str {
    r#"<script>
(function () {
  var tabs = document.querySelectorAll('.calp-tab');
  var panels = document.querySelectorAll('[data-sheet]');
  function show(idx) {
    for (var i = 0; i < panels.length; i++) {
      var match = panels[i].getAttribute('data-sheet') === String(idx);
      panels[i].hidden = !match;
    }
    for (var j = 0; j < tabs.length; j++) {
      var on = tabs[j].getAttribute('data-tab') === String(idx);
      tabs[j].classList.toggle('calp-tab-active', on);
    }
  }
  for (var k = 0; k < tabs.length; k++) {
    (function (el) {
      el.addEventListener('click', function () {
        show(el.getAttribute('data-tab'));
      });
    })(tabs[k]);
  }
})();
</script>
"#
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publish::{self, PublishRequest};
    use crate::registry::LocalRegistry;
    use crate::version::SemVer;
    use engine::cell::Cell;
    use engine::style::{CellStyle, Color};
    use engine::ThemeColor;
    use persistence::{Sheet, Workbook};
    use tempfile::TempDir;

    /// Build a workbook with two sheets, a styled (green background) bold cell,
    /// a merged region, an injection-attempt cell, plus a hidden sheet.
    fn make_workbook() -> Workbook {
        // --- Sheet 1: Dashboard ---
        let mut s1 = Sheet::new("Dashboard".to_string());

        // A styled cell: green background + bold. Style index 1.
        let green = ThemeColor::Absolute(Color::new(0, 128, 0));
        let styled = CellStyle::new().with_background(green).with_bold(true);
        s1.styles.push(styled); // index 1 (index 0 is default)

        // A1: a merge origin header.
        let mut a1 = SavedCell::from_cell(&Cell::new_text("Quarterly Report".to_string()));
        a1.style_index = 1; // styled (green bg, bold)
        s1.cells.insert((0, 0), a1);

        // B1 is covered by the merge of A1:B1 (will be omitted).
        // A2: a normal numeric value.
        s1.cells
            .insert((1, 0), SavedCell::from_cell(&Cell::new_number(1234.0)));

        // A3: a value that tries to inject markup — must be escaped.
        s1.cells.insert(
            (2, 0),
            SavedCell::from_cell(&Cell::new_text("<b>x</b>".to_string())),
        );

        // Merge A1:B1 (one row, two cols).
        s1.merged_regions.push(persistence::SavedMergedRegion {
            start_row: 0,
            start_col: 0,
            end_row: 0,
            end_col: 1,
        });

        // --- Sheet 2: Data ---
        let mut s2 = Sheet::new("Data".to_string());
        s2.cells
            .insert((0, 0), SavedCell::from_cell(&Cell::new_text("plain".to_string())));

        // --- Sheet 3: Secret (hidden) ---
        let mut s3 = Sheet::new("Secret".to_string());
        s3.visibility = "hidden".to_string();
        s3.cells.insert(
            (0, 0),
            SavedCell::from_cell(&Cell::new_text("topsecret".to_string())),
        );

        let mut wb = Workbook::default();
        wb.sheets = vec![s1, s2, s3];
        wb
    }

    fn publish_and_render(opts: &HtmlExportOptions) -> String {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = make_workbook();

        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "Sales Report".to_string(),
            version: SemVer::new(1, 2, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0, 1, 2],
            now: "2026-06-16T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(&reg, &request, prof.path()).unwrap();

        render_package_html(&reg, "Sales Report", "1.2.0", opts).unwrap()
    }

    #[test]
    fn html_contains_package_name_and_cell_text() {
        let html = publish_and_render(&HtmlExportOptions { mode: HtmlExportMode::Static });
        assert!(html.contains("Sales Report"), "package name should appear");
        assert!(html.contains("1.2.0"), "version should appear");
        // A known cell's display text (escaped, but plain text here).
        assert!(html.contains("Quarterly Report"), "header cell text should appear");
        assert!(html.contains("1234"), "numeric cell should appear without .0");
        assert!(!html.contains("1234.0"), "integer should not show trailing .0");
        // Publisher name line.
        assert!(html.contains("Published by"), "publisher line should appear");
    }

    #[test]
    fn styled_cell_background_color_in_output() {
        let html = publish_and_render(&HtmlExportOptions { mode: HtmlExportMode::Static });
        // Color::new(0,128,0).to_css() => "#008000"
        assert!(
            html.contains("background-color:#008000"),
            "green background should be emitted; html: {}",
            &html[..html.len().min(4000)]
        );
        assert!(html.contains("font-weight:bold"), "bold should be emitted");
    }

    #[test]
    fn merged_region_produces_colspan() {
        let html = publish_and_render(&HtmlExportOptions { mode: HtmlExportMode::Static });
        assert!(
            html.contains("colspan=\"2\""),
            "A1:B1 merge should yield colspan=2"
        );
    }

    #[test]
    fn cell_value_is_html_escaped() {
        let html = publish_and_render(&HtmlExportOptions { mode: HtmlExportMode::Static });
        // The escaped form must be present...
        assert!(html.contains("&lt;b&gt;x&lt;/b&gt;"), "cell value must be escaped");
        // ...and the raw injected markup must NOT appear anywhere in the body.
        assert!(
            !html.contains("<b>x</b>"),
            "raw injected markup must never appear"
        );
    }

    #[test]
    fn static_mode_has_print_css_and_no_viewer_script() {
        let html = publish_and_render(&HtmlExportOptions { mode: HtmlExportMode::Static });
        assert!(html.contains("@media print"), "static mode needs print CSS");
        assert!(html.contains("page-break-before"), "static mode needs page breaks");
        // No viewer toggle script in static mode.
        assert!(!html.contains("<script"), "static mode must not emit a script");
        assert!(!html.contains("data-sheet"), "static mode has no data-sheet panels");
    }

    #[test]
    fn viewer_mode_has_tabs_script_and_data_sheet() {
        let html = publish_and_render(&HtmlExportOptions { mode: HtmlExportMode::Viewer });
        assert!(html.contains("<script"), "viewer mode needs a toggle script");
        assert!(html.contains("data-sheet"), "viewer mode wraps sheets in data-sheet panels");
        assert!(html.contains("calp-tab"), "viewer mode needs tabs");
        // First sheet visible (no hidden attr), second hidden.
        assert!(html.contains("data-sheet=\"0\">"), "first panel visible");
        assert!(html.contains("data-sheet=\"1\" hidden>"), "second panel hidden by default");
    }

    #[test]
    fn hidden_sheet_is_omitted() {
        let html = publish_and_render(&HtmlExportOptions { mode: HtmlExportMode::Static });
        assert!(!html.contains("Secret"), "hidden sheet name must not appear");
        assert!(!html.contains("topsecret"), "hidden sheet content must not appear");
        // The two visible sheets are present.
        assert!(html.contains("Dashboard"));
        assert!(html.contains("Data"));
    }

    #[test]
    fn escape_html_covers_all_five_chars() {
        assert_eq!(escape_html("&<>\"'"), "&amp;&lt;&gt;&quot;&#39;");
    }

    #[test]
    fn style_attr_blocks_attribute_breakout() {
        // A package-controlled style value (e.g. a malicious font-family name)
        // must NOT be able to break out of the style="" attribute and inject
        // markup into the report a recipient opens in a browser.
        let evil = r#"font-family:x"><script>alert(1)</script>"#.to_string();
        let s = style_attr(&[evil]);
        assert!(!s.contains(r#"x"><script>"#), "must not allow breakout: {s}");
        assert!(s.contains("&quot;"), "breakout quote must be escaped: {s}");
        assert!(s.contains("&lt;script&gt;"), "angle brackets must be escaped: {s}");
    }

    #[test]
    fn empty_sheet_renders_placeholder() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let mut wb = Workbook::default();
        wb.sheets = vec![Sheet::new("Blank".to_string())];

        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "blank-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0],
            now: "2026-06-16T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(&reg, &request, prof.path()).unwrap();

        let html = render_package_html(
            &reg,
            "blank-pkg",
            "1.0.0",
            &HtmlExportOptions { mode: HtmlExportMode::Static },
        )
        .unwrap();
        assert!(html.contains("(empty sheet)"), "empty sheet placeholder");
    }
}
