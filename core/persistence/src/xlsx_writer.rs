//! FILENAME: core/persistence/src/xlsx_writer.rs

use crate::{CalculaMeta, PersistenceError, SavedCellValue, SavedPageSetup, Workbook, META_SHEET_NAME};
use engine::style::{
    BorderLineStyle, BorderStyle, CellStyle, NumberFormat, TextAlign, TextRotation, VerticalAlign,
};
use rust_xlsxwriter::{
    Chart, ChartLegendPosition, ChartSeries, ChartType, DocProperties, Format, FormatAlign,
    FormatBorder, FormatDiagonalBorder, Note, Workbook as XlsxWorkbook,
};
use std::path::Path;

/// Which single-cell formulas are written DYNAMIC, as Excel saves them
/// (lane xlsxdyn, rev-parse-1).
#[path = "xlsx_dynamic_formula.rs"]
pub(crate) mod dynamic_formula;

/// The error literals a `t="e"` cached result may carry as they are
/// (`<c t="e"><v>#DIV/0!</v></c>`). Every other error -- Excel's newer ones
/// (`#SPILL!`, `#CALC!`, ...) and Calcula's own (`#CONFLICT!`, `#LIMIT!`, a
/// static `#CIRCULAR!`) -- is cached as `#VALUE!`, which is what Excel itself
/// writes (a FORMULA's `#CIRCULAR!` is cached as Excel's `0`, see
/// `CachedResults::literal`):
/// [LIVE] Excel 16 saves a blocked `=SEQUENCE(3)` and `=LAMBDA(x,x)` as
/// `<c t="e" vm=".."><v>#VALUE!</v></c>`, the real error living only in its
/// rich-value metadata, and REFUSES to open a file whose plain `t="e"` cell
/// says `#SPILL!` ("Unable to get the Open property").
const EXCEL_ERROR_LITERALS: &[&str] = &["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A"];

/// The literal an error is written as in a `t="e"` cell -- a formula's cached
/// result and a static error value alike. The classic seven stay as they are;
/// `#GETTING_DATA` is saved as `#N/A` ([LIVE] Excel 16 types `#GETTING_DATA`
/// as an error constant and saves it as `<c t="e"><v>#N/A</v></c>`); every
/// other error is `#VALUE!`, which is how Excel saves a static `#SPILL!` or
/// `#CALC!` too ([LIVE] Paste Values of a blocked `=SEQUENCE(3)` and of
/// `=LAMBDA(x,x)`: `<c t="e" vm=".."><v>#VALUE!</v></c>`) -- with, for the
/// errors Excel has a code for, the rich value `vm` points at, which
/// `finish_archive` writes (see [`RICH_ERROR_TYPES`]).
fn excel_error_literal(error: &str) -> &str {
    if EXCEL_ERROR_LITERALS.contains(&error) {
        error
    } else if error == "#GETTING_DATA" {
        "#N/A"
    } else {
        "#VALUE!"
    }
}

/// Excel's rich-value `errorType` for an error it saves as `#VALUE!` plus
/// rich-value metadata, `ERROR.TYPE - 1` -- [LIVE] Excel 16 saves a blocked
/// `=SEQUENCE(3)` (`#SPILL!`) with `errorType` 8 and `=LAMBDA(x,x)` and an
/// empty `FILTER` (`#CALC!`) with 13, as `<c t="e" vm=".."><v>#VALUE!</v></c>`
/// (`xl/metadata.xml` -> `xl/richData/rdrichvalue.xml`, structure `_error`).
/// The classic seven need none, `#GETTING_DATA` is saved as `#N/A`, and
/// Calcula's own errors (`#CIRCULAR!`, `#CONFLICT!`, `#LIMIT!`) have no Excel
/// code at all: they stay a plain `#VALUE!` (a formula's cached `#CIRCULAR!`
/// is Excel's `0`, see `CachedResults::literal`).
const RICH_ERROR_TYPES: &[(&str, u32)] = &[
    ("#SPILL!", 8),
    ("#CONNECT!", 9),
    ("#BLOCKED!", 10),
    ("#UNKNOWN!", 11),
    ("#FIELD!", 12),
    ("#CALC!", 13),
];

/// The rich-value `errorType` an error is saved with, if any (see
/// [`RICH_ERROR_TYPES`]).
fn rich_error_type(error: &str) -> Option<u32> {
    RICH_ERROR_TYPES.iter().find(|(literal, _)| *literal == error).map(|&(_, t)| t)
}

/// The error a rich-value `errorType` names (the reader's half of
/// [`RICH_ERROR_TYPES`]).
pub(crate) fn rich_error_literal(error_type: u32) -> Option<&'static str> {
    RICH_ERROR_TYPES.iter().find(|&&(_, t)| t == error_type).map(|&(literal, _)| literal)
}

/// The rich error values a save carries: one per distinct `errorType`, its
/// value-metadata index (`vm`, 1-based) its position here plus one.
#[derive(Default)]
struct RichErrors {
    types: Vec<u32>,
}

impl RichErrors {
    /// The `vm` index of `error`'s rich value, when it has one.
    fn vm(&mut self, error: &str) -> Option<usize> {
        let t = rich_error_type(error)?;
        Some(match self.types.iter().position(|&known| known == t) {
            Some(at) => at + 1,
            None => {
                self.types.push(t);
                self.types.len()
            }
        })
    }
}

/// The private-use character that brackets a cached-result MARKER in the
/// library's output (see [`CachedResults`]).
const CACHED_RESULT_MARK: char = '\u{F8FF}';

/// Formula results whose cell TYPE rust_xlsxwriter cannot spell.
///
/// `Formula::set_result` takes a string and types it by one rule: a string that
/// parses as a number is written untyped (a number), anything else `t="str"`.
/// So a boolean result was cached as the TEXT "TRUE", an error as `0`, and a
/// text result such as "123" as the NUMBER 123 -- which a reader that does not
/// recalculate shows as such (Excel opening a `calcMode="manual"` export is
/// one). Excel writes `t="b"` with `1`/`0`, `t="e"` with the literal, and
/// `t="str"` for every text result ([LIVE] Excel 16, `=TRUE()`, `=1/0`,
/// `="123"`).
///
/// Each such result is handed to the library as a MARKER (an index between two
/// [`CACHED_RESULT_MARK`]s, which the library types `t="str"`), and
/// [`retype_cached_results`] replaces each marker in the finished sheet part
/// with Excel's type and value.
#[derive(Default)]
struct CachedResults {
    /// `(t, v, vm)` per marker index: the cell's type, its (already escaped)
    /// value, and the rich value an error carries (see [`RICH_ERROR_TYPES`]).
    cells: Vec<(&'static str, String, Option<usize>)>,
    /// The sheet part the cells being written go to (set per sheet).
    part: String,
    /// Every sheet part that carries a marker: only those are rewritten
    /// (rev12B, round 13: every sheet part was inflated and re-deflated
    /// whenever any one needed it).
    parts: std::collections::HashSet<String>,
    /// The rich error values the markers and the static errors refer to.
    rich: RichErrors,
    /// The workbook's defined names, which a formula's bare name may be
    /// rather than a function value (`xlsx_formula_text::DefinedNames`).
    names: crate::xlsx_formula_text::DefinedNames,
    /// Which defined names Excel takes for one value, for the dynamic flag
    /// (`dynamic_formula::excel_saves_dynamic`).
    shapes: dynamic_formula::NameShapes,
}

impl CachedResults {
    fn mark(&mut self, cell_type: &'static str, value: String) -> String {
        self.mark_with(cell_type, value, None)
    }

    fn mark_with(&mut self, cell_type: &'static str, value: String, vm: Option<usize>) -> String {
        let index = self.cells.len();
        self.cells.push((cell_type, value, vm));
        self.parts.insert(self.part.clone());
        format!("{m}{index}{m}", m = CACHED_RESULT_MARK)
    }

    /// The literal to hand `Formula::set_result` for a cached value: the value
    /// itself where the library types it the way Excel does, else a marker.
    fn literal(&mut self, value: &SavedCellValue) -> String {
        match value {
            SavedCellValue::Number(n) if n.is_finite() => n.to_string(),
            // Excel has no non-finite number; it is #NUM! there.
            SavedCellValue::Number(_) => self.mark("e", "#NUM!".to_string()),
            // A text the library would take for a number is marked: not only
            // "12" and "1E5" but "NaN", "inf" and "Infinity", which Rust's f64
            // parser accepts in any case -- written untyped as `<v>NaN</v>`,
            // they made a file live Excel 16 refuses to open.
            SavedCellValue::Text(s) if s.parse::<f64>().is_err() && !s.contains(CACHED_RESULT_MARK) => s.clone(),
            SavedCellValue::Text(s) => self.mark("str", escape_xml_text(s)),
            SavedCellValue::Boolean(b) => self.mark("b", if *b { "1" } else { "0" }.to_string()),
            // Excel has no circular-reference error: [LIVE] Excel 16 caches a
            // circular formula's result as the number it stopped at, `0` for
            // `=A4+1` in A4 (`<c r="A4"><f ca="1">A4+1</f><v>0</v></c>`), and
            // shows 0. Calcula's `#CIRCULAR!` is written the same way; a
            // re-import shows that 0 until the cell is recalculated, as Excel
            // does, and a recalculation finds the cycle again.
            SavedCellValue::Error(e) if e == "#CIRCULAR!" => "0".to_string(),
            SavedCellValue::Error(e) => {
                let vm = self.rich.vm(e);
                self.mark_with("e", excel_error_literal(e).to_string(), vm)
            }
            // An empty result (a reference to an empty cell) is Excel's `0`; a
            // structured value has no Excel literal, and Excel recalculates.
            _ => "0".to_string(),
        }
    }

    /// A formula carrying its CACHED result, so the file shows the value
    /// Calcula calculated to any reader that does not recalculate on open --
    /// Excel included, once the export says `calcMode="manual"` ([LIVE] Excel
    /// 16 opens a manual file pending, showing the cached `<v>` until F9; with
    /// the library's `0` placeholder every formula showed 0). The text is
    /// Excel's spelling of it (`xlsx_formula_text::excel_formula_text`), for
    /// the cell at 0-based `(row, col)` (a bare `C` / `R` is that cell's
    /// column / row to Excel). Also whether the text calls one of the
    /// workbook's named LAMBDAs (`DefinedNames::calls_lambda`).
    fn formula(&mut self, formula: &str, value: &SavedCellValue, row: u32, col: u16) -> (rust_xlsxwriter::Formula, bool) {
        let text = crate::xlsx_formula_text::excel_formula_text_with_names(formula, Some((row, u32::from(col))), &self.names);
        let calls_lambda = self.names.calls_lambda(&text);
        (crate::xlsx_formula_text::library_formula(&text).set_result(self.literal(value)), calls_lambda)
    }
}

/// Write one cell's formula with its cached result (see [`CachedResults`]).
///
/// A call to a named LAMBDA (persisted as Calcula's `__INVOKE__` marker) is
/// written as a single-cell DYNAMIC formula, as Excel saves one ([LIVE] Excel
/// 16: `=AddOne(4)` with `AddOne` = `LAMBDA(n,n+1)` is
/// `<c r="A1" cm="1"><f t="array" ref="A1">AddOne(4)</f><v>5</v></c>`). As a
/// plain formula Excel opened it as `=@AddOne(4)`, the implicit-intersection
/// form, which cuts an array result down to one value (round 15 sweep). So
/// is a call the engine left unresolved (`Opt(1)` with `Opt` a named
/// LAMBDA, BUG-0645): the rev18x verifier's real-path export opened as
/// `=@Opt(1)`. So is every formula Excel itself saves dynamic
/// (`dynamic_formula::excel_saves_dynamic`): written plain, Excel opens it
/// with its implicit intersection and a wrong value (rev-parse-1).
fn write_formula_cell(
    worksheet: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    col: u16,
    formula: &str,
    value: &SavedCellValue,
    format: Option<&Format>,
    cached_results: &mut CachedResults,
) -> Result<(), rust_xlsxwriter::XlsxError> {
    let (formula_written, calls_lambda) = cached_results.formula(formula, value, row, col);
    let dynamic = calls_lambda
        || formula.contains(engine::ast_render::NAMED_INVOKE_MARKER)
        || dynamic_formula::excel_saves_dynamic(formula, &cached_results.shapes);
    let formula = formula_written;
    match (dynamic, format) {
        (true, Some(fmt)) => worksheet.write_dynamic_formula_with_format(row, col, formula, fmt)?,
        (true, None) => worksheet.write_dynamic_formula(row, col, formula)?,
        (false, Some(fmt)) => worksheet.write_formula_with_format(row, col, formula, fmt)?,
        (false, None) => worksheet.write_formula(row, col, formula)?,
    };
    Ok(())
}

/// The runs of a rich-text cell as the library's `(Format, text)` segments,
/// each run's font being the cell's own font with the run's overrides on top
/// -- an Excel `<r><rPr>` states the run's WHOLE font ([LIVE] Excel 16 saves
/// `rich ` + bold `text` as `<r><t>rich </t></r><r><rPr><b/><sz val="11"/>
/// ..<rFont val=".."/>..</rPr><t>text</t></r>`). `None` when the cell is
/// written as plain text: no runs, no run that changes anything, or runs whose
/// text is not the cell's value (the value is what every reader shows). Empty
/// runs are left out: Excel has none, and the library refuses one.
///
/// `linked`: the cell carries a hyperlink, so its font is the Hyperlink
/// style's (blue, single underline) wherever its own style leaves the colour
/// and underline alone (`linked_cell_format`, the library's link look for a
/// cell with no style) -- and so is every run's base (rev16C: a linked
/// unstyled cell's runs were built on the default black font, so its first
/// run showed blue and underlined and the rest did not).
///
/// A FIRST run whose font IS the cell's font is written with no `<rPr>`, as
/// Excel writes it ([LIVE] Excel 16 saves `rich ` + bold `text` on a plain
/// cell as `<r><t>rich </t></r><r><rPr><b/>..</rPr><t>text</t></r>`); the
/// library omits it only for a first run in its default format, so that run
/// gets `Format::new()`. A first run that DIFFERS from the cell's font always
/// states it (below), never `Format::new()`.
fn rich_text_formats(
    runs: Option<&[engine::cell::RichTextRun]>,
    value: &str,
    base: Option<&CellStyle>,
    linked: bool,
    fonts: &engine::theme::ThemeFonts,
) -> Option<Vec<(Format, String)>> {
    let runs = runs?;
    let has_override = runs.iter().any(|r| {
        r.bold.is_some()
            || r.italic.is_some()
            || r.underline.is_some()
            || r.strikethrough.is_some()
            || r.font_size.is_some()
            || r.font_family.is_some()
            || r.color.is_some()
            || r.superscript
            || r.subscript
    });
    if !has_override || runs.iter().map(|r| r.text.as_str()).collect::<String>() != value {
        return None;
    }
    let mut segments: Vec<(Format, String)> = runs
        .iter()
        .filter(|r| !r.text.is_empty())
        .map(|r| (rich_run_format(r, base, linked, fonts), r.text.clone()))
        .collect();
    // The cell's own font, as a run with no overrides sees it.
    let cell_font = rich_run_format(&engine::cell::RichTextRun::plain(String::new()), base, linked, fonts);
    if let Some(first) = segments.first_mut() {
        if first.0 == cell_font {
            // Excel's spelling: no `<rPr>`, the run shows in the cell's font.
            first.0 = Format::new();
        } else if first.0 == Format::new() {
            // The library writes a FIRST run in its default format with no
            // `<rPr>`, and such a run shows in the CELL's font -- on a bold
            // cell, a run that turns bold off would show bold. Its font is
            // stated: the theme text colour, which the default font writes
            // anyway (`<color theme="1"/>`), makes the format not the
            // library's default.
            first.0 = first.0.clone().set_font_color(rust_xlsxwriter::Color::Theme(1, 0));
        }
    }
    (!segments.is_empty()).then_some(segments)
}

/// One run's font: the cell's font (`base`; the library's default font when
/// the cell has no style of its own; with the Hyperlink style's colour and
/// underline where the cell is `linked` and its style leaves both alone), with
/// the run's overrides applied.
fn rich_run_format(
    run: &engine::cell::RichTextRun,
    base: Option<&CellStyle>,
    linked: bool,
    fonts: &engine::theme::ThemeFonts,
) -> Format {
    let mut format = Format::new();
    let mut bold = false;
    let mut italic = false;
    let mut underline = engine::UnderlineStyle::None;
    let mut strike = false;
    let mut own_color = false;
    if let Some(style) = base {
        bold = style.font.bold;
        italic = style.font.italic;
        underline = style.font.underline;
        strike = style.font.strikethrough;
        format = with_excel_font_name(format.set_font_size(style.font.size.points()), &style.font.family, fonts);
        if !is_default_color(&style.font.color) {
            format = format.set_font_color(color_to_xlsx(&style.font.color));
            own_color = true;
        }
    }
    // The link look, exactly where `linked_cell_format` / the library's
    // hyperlink format puts it on the cell itself: the Hyperlink colour
    // (theme 10) and a single underline, unless the style sets either.
    // `set_hyperlink` is the only way to that colour (`set_font_color`
    // refuses a theme index above 9), and it drops the font scheme, which a
    // theme font gets back -- exactly as `linked_cell_format` does.
    if linked && !own_color && underline == engine::UnderlineStyle::None {
        format = format.set_hyperlink();
        if let Some(scheme) = base.and_then(|style| excel_font(&style.font.family, fonts).1) {
            format = format.set_font_scheme(scheme);
        }
        underline = engine::UnderlineStyle::Single;
    }
    bold = run.bold.unwrap_or(bold);
    italic = run.italic.unwrap_or(italic);
    underline = run.underline.unwrap_or(underline);
    strike = run.strikethrough.unwrap_or(strike);
    if bold {
        format = format.set_bold();
    }
    if italic {
        format = format.set_italic();
    }
    match underline {
        engine::UnderlineStyle::None => {}
        engine::UnderlineStyle::Single => format = format.set_underline(rust_xlsxwriter::FormatUnderline::Single),
        engine::UnderlineStyle::Double => format = format.set_underline(rust_xlsxwriter::FormatUnderline::Double),
        engine::UnderlineStyle::SingleAccounting => {
            format = format.set_underline(rust_xlsxwriter::FormatUnderline::SingleAccounting)
        }
        engine::UnderlineStyle::DoubleAccounting => {
            format = format.set_underline(rust_xlsxwriter::FormatUnderline::DoubleAccounting)
        }
    }
    if strike {
        format = format.set_font_strikethrough();
    }
    if let Some(size) = run.font_size {
        format = format.set_font_size(size.points());
    }
    if let Some(ref family) = run.font_family {
        format = with_excel_font_name(format, family, fonts);
    }
    if let Some(c) = run.color {
        format = format.set_font_color(rust_xlsxwriter::Color::RGB(
            ((c.r as u32) << 16) | ((c.g as u32) << 8) | (c.b as u32),
        ));
    }
    if run.superscript {
        format = format.set_font_script(rust_xlsxwriter::FormatScript::Superscript);
    } else if run.subscript {
        format = format.set_font_script(rust_xlsxwriter::FormatScript::Subscript);
    }
    format
}

/// XML character data: `&`, `<` and `>` escaped (what the library escapes,
/// bar the control characters, which no cached result here carries).
fn escape_xml_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Replace every cached-result marker in a finished sheet part with Excel's
/// cell type and value (see [`CachedResults`]). The library wrote each marked
/// cell as `<c r=".." [s=".."] t="str"><f ..>..</f><v>MARK</v></c>`.
fn retype_cached_results(xml: &str, cells: &[(&'static str, String, Option<usize>)]) -> Result<String, PersistenceError> {
    let bad = |what: &str| PersistenceError::InvalidFormat(format!("xlsx cached-result rewrite: {}", what));
    let open = format!("<v>{}", CACHED_RESULT_MARK);
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    while let Some(at) = rest.find(&open) {
        out.push_str(&rest[..at]);
        let after = &rest[at + open.len()..];
        let close = after.find(CACHED_RESULT_MARK).ok_or_else(|| bad("unterminated marker"))?;
        let index: usize = after[..close].parse().map_err(|_| bad("bad marker index"))?;
        let (cell_type, value, vm) = cells.get(index).ok_or_else(|| bad("unknown marker"))?;
        let tail = &after[close + CACHED_RESULT_MARK.len_utf8()..];
        let tail = tail.strip_prefix("</v>").ok_or_else(|| bad("marker is not the whole value"))?;
        // The cell's own start tag, already copied: retype it (and point an
        // error that has one at its rich value, `vm`, as Excel does).
        let cell_start = out.rfind("<c r=\"").ok_or_else(|| bad("marker outside a cell"))?;
        let tag_end = cell_start + out[cell_start..].find('>').ok_or_else(|| bad("unclosed cell tag"))?;
        let attrs = match vm {
            Some(vm) => format!(" t=\"{}\" vm=\"{}\"", cell_type, vm),
            None => format!(" t=\"{}\"", cell_type),
        };
        // The marker was written as `t="str"` and nothing else types the
        // cell: exactly one `t=` to REPLACE and no `vm=` yet, or the rewrite
        // would leave a cell untyped or with a duplicate attribute (an
        // unopenable sheet), so it is refused instead.
        let tag = &out[cell_start..tag_end];
        if tag.matches(" t=\"").count() != 1 || !tag.contains(" t=\"str\"") || tag.contains(" vm=\"") {
            return Err(bad("a marked cell is not typed as the library's text result"));
        }
        let typed = tag.replacen(" t=\"str\"", &attrs, 1);
        out.replace_range(cell_start..tag_end, &typed);
        out.push_str("<v>");
        out.push_str(value);
        out.push_str("</v>");
        rest = tail;
    }
    out.push_str(rest);
    Ok(out)
}

/// Retype each STATIC error cell of a finished sheet part (a value with no
/// formula: a pasted value, a typed `#N/A`) as Excel's error cell. The library
/// has no error writer, so the cell loop writes it as the number `0` -- the
/// library's `<c r="A1" [s=".."]><v>0</v></c>` -- and records its literal in
/// `errors` (see [`excel_error_literal`]); this turns each into
/// `<c r="A1" [s=".."] t="e"><v>#N/A</v></c>`, which is how Excel saves a
/// static error ([LIVE] Excel 16, `#N/A` typed into a cell). It used to be
/// written as the TEXT "#N/A", so ISERROR / IFERROR / ISNA changed their answer
/// in Excel and on Calcula's own re-import. Every recorded cell must be found.
fn retype_static_errors(
    xml: &str,
    errors: &std::collections::HashMap<(u32, u32), (String, Option<usize>)>,
) -> Result<String, PersistenceError> {
    let bad = |what: &str| PersistenceError::InvalidFormat(format!("xlsx static-error rewrite: {}", what));
    let open = "<c r=\"";
    let mut out = String::with_capacity(xml.len() + errors.len() * 16);
    let mut rest = xml;
    let mut found = 0usize;
    while let Some(at) = rest.find(open) {
        let ref_start = at + open.len();
        let ref_end = ref_start + rest[ref_start..].find('"').ok_or_else(|| bad("unterminated cell reference"))?;
        let found_error = parse_cell_ref(&rest[ref_start..ref_end]).and_then(|at| errors.get(&at));
        let Some((literal, vm)) = found_error else {
            out.push_str(&rest[..ref_end]);
            rest = &rest[ref_end..];
            continue;
        };
        let tag_end = ref_end + rest[ref_end..].find('>').ok_or_else(|| bad("unclosed cell tag"))?;
        let body = "<v>0</v></c>";
        if rest[..tag_end].ends_with('/') || !rest[tag_end + 1..].starts_with(body) {
            return Err(bad("a static error cell was not written as the expected placeholder"));
        }
        // The placeholder is an untyped NUMBER. A cell tag that already types
        // its value (`t="s"`: a shared string whose index happens to be 0) or
        // points at metadata was overwritten by something else; retyping it
        // would write a second `t=` -- `<c t="s" t="e">`, a sheet neither Excel
        // nor Calcula can open (rev13C, round 14) -- so the save is refused.
        let tag = &rest[at..tag_end];
        if tag.contains(" t=\"") || tag.contains(" vm=\"") || tag.contains(" cm=\"") {
            return Err(bad("a static error cell's placeholder was overwritten by a typed value"));
        }
        out.push_str(&rest[..tag_end]);
        out.push_str(" t=\"e\"");
        if let Some(vm) = vm {
            out.push_str(&format!(" vm=\"{}\"", vm));
        }
        out.push_str("><v>");
        out.push_str(literal);
        out.push_str("</v></c>");
        rest = &rest[tag_end + 1 + body.len()..];
        found += 1;
    }
    out.push_str(rest);
    if found != errors.len() {
        return Err(bad("a static error cell was not found in its sheet part"));
    }
    Ok(out)
}

/// The longest ScreenTip Excel keeps, in characters.
const EXCEL_SCREEN_TIP_MAX_CHARS: usize = 255;

/// A hyperlink's ScreenTip as the file can hold it: at most 255 characters,
/// cut by CHARACTER (never inside one), the rest dropped.
///
/// [LIVE] Excel 16 (round 19, misc19/probe1.ps1) refuses a longer one
/// outright (`Hyperlinks.Add` with a 300- or 258-character tip fails, setting
/// `ScreenTip` to 300 characters fails) and its ScreenTip box stops at 255;
/// rust_xlsxwriter refuses one over 255 too (`Url::initialize`,
/// `MAX_PARAMETER_LEN`), and that refusal dropped the WHOLE link from the
/// export (rev17, round 18). A link is never lost for its tip: the tip is
/// shortened to what Excel itself would hold.
fn excel_screen_tip(tooltip: Option<&str>) -> String {
    let tip = tooltip.unwrap_or_default();
    match tip.char_indices().nth(EXCEL_SCREEN_TIP_MAX_CHARS) {
        Some((cut, _)) => tip[..cut].to_string(),
        None => tip.to_string(),
    }
}

/// A hyperlink target as rust_xlsxwriter spells it. Calcula holds a link to a
/// place in the workbook as `#Sheet2!A1` (the xlsx reader's convention for
/// `<hyperlink location="..">`) or `'Sheet2'!A1` (Insert Hyperlink's), and a
/// file as a bare path; the library knows only URLs, `mailto:`, `file://` and
/// `internal:`, and refused every other target with `UnknownUrlType` -- which
/// refused the WHOLE save, so a workbook with an internal link could not be
/// exported at all (round 15 sweep).
///
/// [LIVE] Excel 16 (round 17) saves a link to a defined name as a place
/// (`<hyperlink location="Tax.Rate">`, no relationship) even when the name
/// holds a dot, so a target that `is_defined_name` knows is a place before the
/// `.` heuristic is asked (rev15A: `Tax.Rate` was written as a file). A
/// relative file (`report.xlsx`) is the relationship `Target="report.xlsx"
/// TargetMode="External"` in Excel's file; the library writes exactly that for
/// `file:///report.xlsx` (it strips `file:///` from a relative path), so that
/// mapping stands. A file with a place in it (`report.xlsx#Sheet1!A1`) is
/// Excel's relationship plus `location="Sheet1!A1"` -- the library's split of
/// `file:///report.xlsx#Sheet1!A1`; it used to be taken for a place in THIS
/// workbook because it holds a `!`.
fn excel_hyperlink_target(target: &str, is_defined_name: &dyn Fn(&str) -> bool) -> String {
    let lower = target.to_ascii_lowercase();
    if let Some(location) = target.strip_prefix('#') {
        return format!("internal:{}", location);
    }
    let has_scheme = ["http://", "https://", "ftp://", "ftps://", "mailto:", "file://", "internal:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme));
    if has_scheme {
        return target.to_string();
    }
    if is_defined_name(target) {
        return format!("internal:{}", target);
    }
    // `file#place`: a file before the `#` (no sheet qualifier, no quote).
    if let Some((file, _place)) = target.split_once('#') {
        if !file.is_empty() && !file.contains('!') && !file.starts_with('\'') {
            return format!("file:///{}", target);
        }
    }
    let path_like = target.contains('\\') || target.contains('/');
    // A sheet-qualified place, a cell or range, or a defined name (a name has
    // no `.`; a file has an extension).
    let place_like = !path_like && (target.contains('!') || !target.contains('.'));
    if place_like {
        format!("internal:{}", target)
    } else {
        format!("file:///{}", target)
    }
}

/// A sheet's STANDARD column width, in px, as `<sheetFormatPr defaultColWidth>`
/// spells it: the padded character width, by the same rule rust_xlsxwriter
/// applies to `<col width>` (Calibri 11: 7px per digit, 5px padding), so the
/// reader's `px = round(w * 7)` gives back exactly the px written.
fn padded_column_width(px: f64) -> f64 {
    let chars = ((px - 5.0) / 7.0).max(0.0);
    if chars < 1.0 {
        ((chars * 12.0).round() / 7.0 * 256.0).floor() / 256.0
    } else {
        (((chars * 7.0).round() + 5.0) / 7.0 * 256.0).floor() / 256.0
    }
}

/// State a sheet part's standard column width the way Excel saves it
/// ([LIVE] Excel 16, Format > Default Width 20 or Select All + Column Width 20:
/// `<sheetFormatPr defaultColWidth="20.59765625" ..>` and a `<col>` only for a
/// column that has a width of its own). rust_xlsxwriter has no
/// `defaultColWidth`, so it is added here; and a `<col>` the library wrote for
/// a column with NO width of its own (one that only carries a style, written
/// with the library's 8.43 default and no `customWidth`) is given the standard,
/// since that is the width the column shows.
fn with_default_column_width(sheet_xml: &str, padded: f64) -> Result<String, PersistenceError> {
    let bad = |what: &str| PersistenceError::InvalidFormat(format!("xlsx standard-width rewrite: {}", what));
    let tag = "<sheetFormatPr";
    let at = sheet_xml.find(tag).ok_or_else(|| bad("the sheet part has no <sheetFormatPr>"))?;
    // Never a second `defaultColWidth` on the element (an unopenable part).
    let element_end = at + sheet_xml[at..].find('>').ok_or_else(|| bad("unclosed <sheetFormatPr>"))?;
    if sheet_xml[at..element_end].contains(" defaultColWidth=") {
        return Err(bad("the sheet part already states a defaultColWidth"));
    }
    let mut out = String::with_capacity(sheet_xml.len() + 64);
    out.push_str(&sheet_xml[..at + tag.len()]);
    out.push_str(&format!(" defaultColWidth=\"{}\"", padded));
    let rest = &sheet_xml[at + tag.len()..];
    let Some(cols_at) = rest.find("<cols>") else {
        out.push_str(rest);
        return Ok(out);
    };
    let cols_end = cols_at + rest[cols_at..].find("</cols>").ok_or_else(|| bad("unclosed <cols>"))?;
    out.push_str(&rest[..cols_at]);
    let mut cols = &rest[cols_at..cols_end];
    while let Some(col_at) = cols.find("<col ") {
        out.push_str(&cols[..col_at]);
        let end = col_at + cols[col_at..].find("/>").ok_or_else(|| bad("unclosed <col>"))? + 2;
        let element = &cols[col_at..end];
        if element.contains("customWidth=") {
            out.push_str(element);
        } else if let Some(w_at) = element.find(" width=\"") {
            let value_at = w_at + " width=\"".len();
            let value_end = value_at + element[value_at..].find('"').ok_or_else(|| bad("bad width"))?;
            out.push_str(&element[..value_at]);
            out.push_str(&padded.to_string());
            out.push_str(&element[value_end..]);
        } else {
            out.push_str(element);
        }
        cols = &cols[end..];
    }
    out.push_str(cols);
    out.push_str(&rest[cols_end..]);
    Ok(out)
}

pub fn save_xlsx(workbook: &Workbook, path: &Path) -> Result<(), PersistenceError> {
    save_xlsx_with_calculation_mode(workbook, path, false)
}

/// [`save_xlsx`], stating the calculation mode the export carries.
///
/// The calculation mode is an APPLICATION setting in Excel that each save
/// writes into the file: [LIVE] Excel 16 writes `<calcPr calcMode="manual"/>`
/// when the application is manual and no `calcMode` when it is automatic, and
/// a manual-mode file resaved while the application is automatic is written
/// WITHOUT it -- the file records the mode at save time, not the mode it was
/// opened with. `manual_calculation` is that application mode (Calcula's
/// `AppState.calculation_mode`).
pub fn save_xlsx_with_calculation_mode(
    workbook: &Workbook,
    path: &Path,
    manual_calculation: bool,
) -> Result<(), PersistenceError> {
    save_xlsx_reporting_losses(workbook, path, manual_calculation).map(|_| ())
}

/// What an .xlsx export could not write and left out: hyperlinks (by cell,
/// `Sheet1!B2`) and defined names (by name) the file format or the library
/// refused -- an over-long URL, a name Excel does not allow. Each is left out
/// rather than refusing the whole save, and the user must be told
/// ([`XlsxExportLosses::message`]); a `[WARN]` on stderr was all there was
/// (rev15A, round 16).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct XlsxExportLosses {
    pub hyperlinks: Vec<String>,
    pub defined_names: Vec<String>,
    /// Cells (`Sheet1!J17`) whose formula Excel could not hold
    /// (`xlsx_formula_text::Unwritable`): written as the value alone.
    pub formulas: Vec<String>,
    /// Tables Excel could not hold as tables (`xlsx_tables::TableParts`): a
    /// reused name, an overlap, a column list that does not fit the range.
    /// Their cells are written; the table is not.
    pub tables: Vec<String>,
    /// Tables (by name) and sheet filters (`Sheet1!A1:B7`) whose filter
    /// criterion or sort level Excel's part cannot be given from Calcula (a
    /// colour or icon filter or sort, `xlsx_autofilter`), or a sheet filter
    /// over a table: the rows it hid stay hidden, the criterion is left out.
    pub filters: Vec<String>,
    /// Custom named cell styles the file's style list could not be given
    /// (`xlsx_named_styles`: no `cellXfs` record found for it -- a style no
    /// cell uses now gets one of its own): left out of the file's style list.
    pub named_styles: Vec<String>,
}

impl XlsxExportLosses {
    pub fn is_empty(&self) -> bool {
        self.hyperlinks.is_empty() && self.defined_names.is_empty() && self.formulas.is_empty() && self.tables.is_empty() && self.filters.is_empty() && self.named_styles.is_empty()
    }

    /// The sentence the user reads, or `None` when nothing was left out.
    pub fn message(&self) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        let list = |items: &[String]| {
            let shown: Vec<&str> = items.iter().take(5).map(String::as_str).collect();
            match items.len() {
                n if n > 5 => format!("{} and {} more", shown.join(", "), n - 5),
                _ => shown.join(", "),
            }
        };
        let mut parts = Vec::new();
        match self.hyperlinks.len() {
            0 => {}
            1 => parts.push(format!("the hyperlink in {}", list(&self.hyperlinks))),
            n => parts.push(format!("{} hyperlinks ({})", n, list(&self.hyperlinks))),
        }
        match self.defined_names.len() {
            0 => {}
            1 => parts.push(format!("the defined name {}", list(&self.defined_names))),
            n => parts.push(format!("{} defined names ({})", n, list(&self.defined_names))),
        }
        match self.formulas.len() {
            0 => {}
            1 => parts.push(format!("the formula in {}", list(&self.formulas))),
            n => parts.push(format!("the formulas in {} cells ({})", n, list(&self.formulas))),
        }
        match self.tables.len() {
            0 => {}
            1 => parts.push(format!("the table {}", list(&self.tables))),
            n => parts.push(format!("{} tables ({})", n, list(&self.tables))),
        }
        match self.filters.len() {
            0 => {}
            1 => parts.push(format!("the filter or sort of {}", list(&self.filters))),
            n => parts.push(format!("the filters or sorts of {} tables or ranges ({})", n, list(&self.filters))),
        }
        match self.named_styles.len() {
            0 => {}
            1 => parts.push(format!("the cell style {}, which no cell uses,", list(&self.named_styles))),
            n => parts.push(format!("{} cell styles no cell uses ({})", n, list(&self.named_styles))),
        }
        Some(format!(
            "The workbook was saved as .xlsx, but {} could not be written to that format and {} left out of the file.",
            parts.join(" and "),
            if self.hyperlinks.len() + self.defined_names.len() + self.formulas.len() + self.tables.len() + self.filters.len() + self.named_styles.len() == 1 { "was" } else { "were" }
        ))
    }
}

/// [`save_xlsx_with_calculation_mode`], returning what the file could not
/// hold ([`XlsxExportLosses`]) so the caller can tell the user.
pub fn save_xlsx_reporting_losses(
    workbook: &Workbook,
    path: &Path,
    manual_calculation: bool,
) -> Result<XlsxExportLosses, PersistenceError> {
    let mut losses = XlsxExportLosses::default();
    // LIVE DATA TABLES (BUG-0652): their bodies are written as values and the
    // finished sheet parts given Excel's `<f t="dataTable">` element
    // (`xlsx_data_tables`). `None` -- and nothing cloned -- without one.
    let data_tables = crate::xlsx_data_tables::strip_for_writer(workbook);
    let workbook: &Workbook = data_tables.as_ref().map_or(workbook, |(stripped, _)| stripped);
    // The theme's body / heading fonts, which a `Body` / `Headings` family is
    // written as (`with_excel_font_name`).
    let theme_fonts = &workbook.theme.fonts;
    // A hyperlink to a defined name is a place in the workbook, whatever its
    // spelling (`excel_hyperlink_target`).
    let is_defined_name = |target: &str| {
        workbook.named_ranges.iter().any(|nr| identity::defined_names_equal(&nr.name, target))
    };
    let mut xlsx = XlsxWorkbook::new();
    // The custom named styles NO cell uses get a `cellXfs` record of their
    // own, registered FIRST so its index is known (W2 xlsx: such a style was
    // left out). `xlsx_named_styles::finish_with_named_styles` copies the
    // record into the style's `cellStyleXfs` entry, as Excel keeps one.
    let unused_style_records = crate::xlsx_named_styles::register_unused_styles(workbook, &mut |style| {
        let format = convert_style_to_format(style, theme_fonts);
        xlsx.register_format(&format);
        format
    });
    // Chart ids that were successfully emitted as native OOXML charts — the
    // meta carry records this per chart so the reader can detect Excel-side
    // chart edits (see MetaChart::native_emitted).
    let mut natively_emitted: std::collections::HashSet<identity::EntityId> =
        std::collections::HashSet::new();

    // ========================================================================
    // Workbook properties
    // ========================================================================
    {
        let props = &workbook.properties;
        let mut doc_props = DocProperties::new();
        if !props.title.is_empty() {
            doc_props = doc_props.set_title(&props.title);
        }
        if !props.author.is_empty() {
            doc_props = doc_props.set_author(&props.author);
        }
        if !props.subject.is_empty() {
            doc_props = doc_props.set_subject(&props.subject);
        }
        if !props.description.is_empty() {
            doc_props = doc_props.set_comment(&props.description);
        }
        if !props.keywords.is_empty() {
            doc_props = doc_props.set_keywords(&props.keywords);
        }
        if !props.category.is_empty() {
            doc_props = doc_props.set_category(&props.category);
        }
        xlsx.set_properties(&doc_props);
    }

    // Cached formula results Excel types and the library cannot (see
    // `CachedResults`), and each sheet part's standard column width (padded),
    // both stated in the finished archive by `finish_archive`.
    let mut cached_results = CachedResults {
        names: crate::xlsx_formula_text::DefinedNames::of(workbook),
        shapes: dynamic_formula::NameShapes::of(workbook),
        ..CachedResults::default()
    };
    let mut standard_widths: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    // Static error cells per sheet part, written as Excel's `t="e"` by
    // `finish_archive` (see `retype_static_errors`).
    // The literal and the rich value (`vm`) of each.
    let mut static_errors: std::collections::HashMap<String, std::collections::HashMap<(u32, u32), (String, Option<usize>)>> =
        std::collections::HashMap::new();

    // The tables Excel can hold, as Excel table parts (`xlsx_tables`).
    let table_parts = crate::xlsx_tables::TableParts::new(workbook, &mut losses);

    // ========================================================================
    // Sheets
    // ========================================================================
    for (sheet_position, sheet) in workbook.sheets.iter().enumerate() {
        // The sheet's cells as Excel holds them beside its tables (qualified
        // structured references, text headers: `TableParts::export_sheet`).
        let exported = table_parts.export_sheet(sheet);
        let sheet = exported.as_ref().unwrap_or(sheet);
        let worksheet = xlsx.add_worksheet();
        // rust_xlsxwriter numbers its worksheet parts in the order the sheets
        // are added, from 1: the part this sheet's cached results go to.
        cached_results.part = format!("xl/worksheets/sheet{}.xml", sheet_position + 1);
        // Excel's sheet-name rule is stricter than Calcula's LOAD path, which
        // deliberately accepts and carries whatever a legacy or imported file
        // held (`app/src-tauri/src/sheet_names.rs` enforces the rule at ENTRY,
        // not on open). So this call CAN fail on a real workbook -- and it used
        // to fail with a raw rust_xlsxwriter message, aborting the entire
        // "Save As .xlsx" with nothing the user could act on and no clue which
        // of thirty sheets was at fault.
        worksheet.set_name(&sheet.name).map_err(|e| {
            PersistenceError::InvalidFormat(format!(
                "The sheet name {:?} cannot be written to an .xlsx file: {}. \
                 Excel allows 1-31 characters and forbids : \\ / ? * [ ] and a \
                 leading or trailing apostrophe. Rename the sheet and save \
                 again, or save as .cala, which keeps the name as it is.",
                sheet.name, e
            ))
        })?;

        // ---- Gridlines visibility ----
        if !sheet.show_gridlines {
            worksheet.set_screen_gridlines(false);
        }

        // ---- Tab color ----
        if !sheet.tab_color.is_empty() {
            let hex = sheet.tab_color.trim_start_matches('#');
            if let Ok(rgb) = u32::from_str_radix(hex, 16) {
                worksheet.set_tab_color(rust_xlsxwriter::Color::RGB(rgb));
            }
        }

        // ---- Sheet visibility ----
        match sheet.visibility.as_str() {
            "hidden" | "veryHidden" => {
                worksheet.set_hidden(true);
            }
            _ => {}
        }

        // ---- Freeze panes ----
        {
            let freeze_r = sheet.freeze_row.unwrap_or(0);
            let freeze_c = sheet.freeze_col.unwrap_or(0);
            if freeze_r > 0 || freeze_c > 0 {
                worksheet.set_freeze_panes(freeze_r, freeze_c as u16)?;
            }
        }

        // ---- Zoom ----
        // Excel's zoomScale is the same unit Calcula stores (a percent), so
        // this is a straight copy. Written only when it differs from 100 so a
        // normal sheet keeps producing the file Excel itself would.
        {
            let zoom = sheet.zoom.round();
            if (zoom - crate::DEFAULT_SHEET_ZOOM_PERCENT).abs() >= 1.0
                && (10.0..=400.0).contains(&zoom)
            {
                worksheet.set_zoom(zoom as u16);
            }
        }

        // ---- Column widths ----
        for (col, width) in &sheet.column_widths {
            // Characters WITHOUT the 5px padding: rust_xlsxwriter adds the
            // padding itself when it writes `width`, and the reader's px = w * 7
            // (xlsx_style_reader) takes it back out, so widths don't inflate per
            // round trip.
            let excel_width = ((*width - 5.0) / 7.0).max(0.0);
            worksheet.set_column_width(*col as u16, excel_width)?;
        }

        // ---- The sheet's standard column width (Format > Default Width) ----
        // Excel's own `<sheetFormatPr defaultColWidth>`, with a `<col>` only for
        // the columns that have a width of their own (see
        // `with_default_column_width`). rust_xlsxwriter has no setting for it,
        // so the finished part is rewritten. Writing the standard as a width on
        // every one of the 16,384 columns instead (as this once did) showed the
        // same in Excel but made every column CUSTOM-width there, so Excel's
        // Standard Width no longer moved any of them.
        if let Some(standard) = sheet.default_column_width {
            if (standard - crate::DEFAULT_COLUMN_WIDTH_PX).abs() > 1e-6 {
                // rust_xlsxwriter numbers its worksheet parts in the order the
                // sheets are added, from 1.
                standard_widths.insert(
                    format!("xl/worksheets/sheet{}.xml", sheet_position + 1),
                    padded_column_width(standard),
                );
            }
        }

        // ---- The sheet's standard row height (Select All + Row Height) ----
        // Excel's own <sheetFormatPr defaultRowHeight=".." customHeight="1">
        // (probed live: Select All + Row Height 30 writes exactly that and no
        // per-row heights). Points, like every row height in the file.
        if let Some(standard) = sheet.default_row_height {
            if (standard - crate::DEFAULT_ROW_HEIGHT_PX).abs() > 1e-6 && standard > 0.0 {
                worksheet.set_default_row_height(standard / 1.333);
            }
        }

        // ---- Row heights ----
        for (row, height) in &sheet.row_heights {
            // Stored heights are PIXELS; xlsx wants POINTS. Inverse of the
            // reader's px = pt * 1.333 (xlsx_style_reader), same as the width
            // conversion above — without it every custom row height inflates
            // ~33% per round trip.
            worksheet.set_row_height(*row, *height / 1.333)?;
        }

        // ---- Row / column default-style tiers ----
        //
        // These are Excel's own `<row s="..">` / `<col s="..">`, so they export
        // as a format on the row or column rather than being flattened onto
        // every cell. Flattening would be the wrong shape twice over: it would
        // materialise up to a million cells per styled column, and Excel would
        // no longer recognise the column as formatted as a unit.
        //
        // Emitted BEFORE cell writes so a per-cell format still wins where one
        // exists — matching the cell > row > column precedence the resolver uses.
        for (col, style_index) in &sheet.column_styles {
            if let Some(style) = sheet.styles.get(*style_index) {
                let format = convert_style_to_format(style, theme_fonts);
                worksheet.set_column_format(*col as u16, &format)?;
            }
        }
        for (row, style_index) in &sheet.row_styles {
            if let Some(style) = sheet.styles.get(*style_index) {
                let format = convert_style_to_format(style, theme_fonts);
                worksheet.set_row_format(*row, &format)?;
            }
        }

        // ---- Hidden rows ----
        // The EFFECTIVE set: the derived filter/outline cache UNION the rows
        // the user hid by hand. Excel has one `hidden="1"` bit and no notion of
        // provenance, so both authorities collapse into it here. Writing only
        // the derived cache exported a workbook whose hand-hidden rows were
        // visible again.
        for row in sheet.hidden_rows.union(&sheet.user_hidden_rows) {
            worksheet.set_row_hidden(*row)?;
        }

        // ---- Hidden columns ----
        for col in sheet.hidden_cols.union(&sheet.user_hidden_cols) {
            worksheet.set_column_hidden(*col as u16)?;
        }

        // ---- Tables ----
        // BEFORE every other writer of cells: the library writes table
        // captions and formulas into the cells, which the merges, links and
        // the cell loop below then overwrite (`TableParts::add_to_sheet`).
        let column_format = |style_index: usize| sheet.styles.get(style_index).map(|style| convert_style_to_format(style, theme_fonts));
        table_parts.add_to_sheet(worksheet, sheet, &mut losses, &column_format);
        // The sheet's own AutoFilter (one no table owns), W2 xlsx.
        table_parts.add_sheet_filter(worksheet, sheet_position, &mut losses);

        // ---- Merged regions ----
        // MUST run BEFORE the cell loop: merge_range writes a blank string into
        // every cell of the region (including the anchor), and a later write to
        // the same cell replaces the earlier one. Writing merges first, then
        // cells, lets the anchor's real value/formula/format overwrite the
        // placeholder while the merge geometry is preserved (the documented
        // rust_xlsxwriter pattern for non-string merged content).
        for region in &sheet.merged_regions {
            let merge_format = Format::new();
            worksheet.merge_range(
                region.start_row,
                region.start_col as u16,
                region.end_row,
                region.end_col as u16,
                "",
                &merge_format,
            )?;
        }

        // ---- Hyperlinks ----
        //
        // A hyperlink is a property of a cell, not its value: [LIVE] Excel 16
        // keeps a hyperlinked cell's formula, number or error and saves the
        // link beside it (`<c r="B1" s="1" t="e"><f>1/0</f><v>#DIV/0!</v></c>`
        // with `<hyperlink ref="B1" r:id=".."/>`; a static `#N/A` typed over a
        // link stays `<c t="e"><v>#N/A</v></c>`). The library's `write_url`
        // writes the link's TEXT into the cell as a string, so this runs
        // BEFORE the array formulas and the cell loop, which then write the
        // cell's real content over that string while the link stays. It used to
        // run AFTER the cell loop: a hyperlinked formula lost its formula, and a
        // hyperlinked static error -- written as a `0` placeholder that
        // `retype_static_errors` retypes -- was replaced by a shared string, so
        // the save was refused or wrote `<c t="s" t="e">`, a sheet no reader can
        // open (rev13C, round 14). A link on a cell with no content keeps the
        // library's text. A linked cell with no style of its own keeps the
        // library's hyperlink look (`linked_cells`, below); one WITH a style
        // keeps that style, with the link look added where the style leaves
        // the font's colour and underline alone (`linked_cell_format`) --
        // [LIVE] Excel 16 keeps a filled empty cell's fill when a link is
        // added and gives it the Hyperlink style's font. It used to keep only
        // the library's link look on an empty linked cell (its fill was lost)
        // and only its own style on any other (rev15A, round 16). The tooltip
        // is written too ([LIVE] Excel's `<hyperlink tooltip="..">`).
        let mut linked_cells: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
        for link in &sheet.hyperlinks {
            let target = excel_hyperlink_target(&link.target, &is_defined_name);
            let own_format = sheet
                .cells
                .get(&(link.row, link.col))
                .filter(|cell| cell.style_index > 0 && cell.style_index < sheet.styles.len())
                .map(|cell| linked_cell_format(&sheet.styles[cell.style_index], theme_fonts));
            let written = worksheet.write_url_with_options(
                link.row,
                link.col as u16,
                target.as_str(),
                link.display_text.clone().unwrap_or_default(),
                excel_screen_tip(link.tooltip.as_deref()),
                own_format.as_ref(),
            );
            match written {
                Ok(_) => {
                    linked_cells.insert((link.row, link.col));
                }
                // A link the library cannot spell (an over-long URL) is lost;
                // it must not refuse the whole save, and the user is told
                // (`XlsxExportLosses`, shown by the app when the save is done).
                Err(e) => {
                    eprintln!(
                        "[WARN] xlsx save: hyperlink at ({}, {}) to '{}' skipped: {}",
                        link.row, link.col, link.target, e
                    );
                    losses.hyperlinks.push(format!(
                        "{}!{}",
                        sheet.name,
                        rust_xlsxwriter::utility::row_col_to_cell(link.row, link.col as u16)
                    ));
                }
            }
        }
        let hyperlink_format = Format::new().set_hyperlink();

        // ---- Dynamic-array footprints ----
        //
        // A spill ORIGIN must be exported as an ARRAY formula
        // (`<f t="array" ref="A1:A4">` plus the `cm="1"` dynamic marker), which
        // is how Excel itself stores one (ECMA-376 Part 1 18.3.1.40: `ref` =
        // "range of cells which the formula applies to").
        //
        // WHAT THIS FIXES, and it is a corruption rather than a nicety. Before
        // this the writer had no notion of a spill, so `=SEQUENCE(4)` in A1
        // exported as an ORDINARY formula in A1 with three loose literals in
        // A2:A4. Excel recalculates on open (the writer sets `fullCalcOnLoad`),
        // the array tries to spill onto the very literals this writer put
        // there, and it is blocked by its own output: the exported file shows
        // `#SPILL!` where the workbook showed 1 2 3 4. The `ref` is what tells
        // Excel those cells BELONG to the array, and nothing else can.
        //
        // ORDER MATTERS, twice.
        //   * This runs BEFORE the cell loop, because the origin may be visited
        //     after the cells it covers and `write_dynamic_array_formula` pads
        //     the whole range with `0` placeholders (rust_xlsxwriter's
        //     documented behaviour) — writing it second would erase the real
        //     cached values.
        //   * The cell loop then writes those covered cells normally, which
        //     REPLACES the placeholders with the values the workbook actually
        //     holds while leaving the `ref` on the origin untouched. The result
        //     is byte-shaped exactly like Excel's own output: formula + extent
        //     on the origin, value-only cells under it.
        //
        // A cell inside the footprint that carries its OWN formula is left to
        // the cell loop and lands as a formula -- and then the origin is
        // written as Excel saves a BLOCKED array, because Excel refuses the
        // whole workbook when a formula cell sits inside an array formula's
        // `ref` ("Unable to get the Open property", xlsx5 round 17 [LIVE]).
        // [LIVE] Excel 16, round 18: `={1,2,3}` in A1 blocked by
        // `=SUM({1,2})` in B1 is saved as
        // `<c r="A1" t="e" cm="1" vm=".."><f t="array" ref="A1" ..>{1,2,3}</f><v>#VALUE!</v></c>`
        // -- the `ref` is the origin ALONE, the cached value the #SPILL!
        // rich value -- and the footprint holds only the blocker. So a blocked
        // origin keeps a one-cell `ref` and caches #SPILL!, and the array's
        // value-only cells under it (its own output, which Excel does not
        // store for a blocked array) are not written as constants: they would
        // block the array again once the blocker is gone (`blocked_footprint`).
        let mut array_origins: Vec<(u32, u32)> = sheet
            .cells
            .iter()
            .filter_map(|(&(row, col), cell)| {
                let (end_row, end_col) = cell.spill?;
                // A formula Excel cannot hold is written as values by the
                // cell loop (see there).
                let formula = cell.formula.as_ref()?;
                if crate::xlsx_formula_text::unwritable_reason(formula, Some((row, col))).is_some() {
                    return None;
                }
                if end_row < row || end_col < col || (end_row == row && end_col == col) {
                    return None;
                }
                Some((row, col))
            })
            .collect();
        // Deterministic output: the sheet's cells live in a HashMap.
        array_origins.sort_unstable();

        // The value-only cells under a BLOCKED origin (see above): written
        // with their style but without the array's stale output.
        let mut blocked_footprint: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
        for (row, col) in &array_origins {
            let cell = &sheet.cells[&(*row, *col)];
            let (spill_end_row, spill_end_col) = cell.spill.expect("filtered above");
            let inside = |r: u32, c: u32| r >= *row && r <= spill_end_row && c >= *col && c <= spill_end_col && (r, c) != (*row, *col);
            let blocked = sheet
                .cells
                .iter()
                .any(|(&(r, c), other)| inside(r, c) && other.formula.is_some());
            let (end_row, end_col) = if blocked {
                blocked_footprint.extend(
                    sheet.cells.iter().filter(|(&(r, c), other)| inside(r, c) && other.formula.is_none()).map(|(&rc, _)| rc),
                );
                (*row, *col)
            } else {
                (spill_end_row, spill_end_col)
            };
            let formula_text = cell.formula.as_ref().expect("filtered above");
            let clean_formula = formula_text.strip_prefix('=').unwrap_or(formula_text);
            // The origin's own cached result, so a reader that does NOT
            // recalculate still shows the array's first value rather than the
            // library's `0` placeholder -- or, blocked, the #SPILL! Excel
            // caches for it (#VALUE! plus the rich value that names it).
            let cached = if blocked { SavedCellValue::Error("#SPILL!".to_string()) } else { cell.value.clone() };
            let formula = crate::xlsx_formula_text::library_formula(&crate::xlsx_formula_text::excel_formula_text_with_names(clean_formula, Some((*row, *col)), &cached_results.names))
                .set_result(cached_results.literal(&cached));
            let format = cell_format(sheet, cell, linked_cells.contains(&(*row, *col)), &hyperlink_format, theme_fonts);
            match format {
                Some(fmt) => worksheet.write_dynamic_array_formula_with_format(
                    *row,
                    *col as u16,
                    end_row,
                    end_col as u16,
                    formula,
                    &fmt,
                )?,
                None => worksheet.write_dynamic_array_formula(
                    *row,
                    *col as u16,
                    end_row,
                    end_col as u16,
                    formula,
                )?,
            };
        }
        let array_origin_set: std::collections::HashSet<(u32, u32)> =
            array_origins.into_iter().collect();

        // ---- Write cells ----
        let mut lost_formulas: Vec<(u32, u32)> = Vec::new();
        for ((row, col), cell) in &sheet.cells {
            // Already written above, with its extent. Writing it again as an
            // ordinary formula would drop the `ref` and re-create the defect.
            if array_origin_set.contains(&(*row, *col)) {
                continue;
            }

            // A linked cell keeps its own style with the link look, or the
            // library's link look when it has none (see the hyperlink pass).
            let format = cell_format(sheet, cell, linked_cells.contains(&(*row, *col)), &hyperlink_format, theme_fonts);

            // Under a BLOCKED array: the array's own output is not a constant
            // of the sheet (see the dynamic-array pass). Its style stays.
            if blocked_footprint.contains(&(*row, *col)) {
                if let Some(fmt) = format.as_ref() {
                    worksheet.write_blank(*row, *col as u16, fmt)?;
                }
                continue;
            }

            // Excel has no non-finite number. A static NaN / infinity is the
            // error Excel gives one, #NUM! (a formula's is cached so already,
            // `CachedResults::literal`): the library writes a NaN as the TEXT
            // "#NUM!" and an infinity as an untyped `<v>inf</v>`, a value no
            // reader parses (round 15 sweep).
            // A formula Excel cannot hold -- it refused every file with one
            // (`xlsx_formula_text::Unwritable`) -- loses the formula, not the
            // workbook: the cell keeps its value, and the user is told.
            let formula: Option<&String> = match cell.formula.as_ref() {
                Some(f) if crate::xlsx_formula_text::unwritable_reason(f, Some((*row, *col))).is_some() => {
                    lost_formulas.push((*row, *col));
                    None
                }
                f => f,
            };
            let non_finite;
            let value = match &cell.value {
                SavedCellValue::Number(n) if !n.is_finite() && formula.is_none() => {
                    non_finite = SavedCellValue::Error("#NUM!".to_string());
                    &non_finite
                }
                value => value,
            };
            match value {
                SavedCellValue::Empty => {
                    // A formula whose current value is Empty must still write
                    // the formula — skipping it deletes the formula from the file.
                    if let Some(formula) = formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        write_formula_cell(worksheet, *row, *col as u16, clean_formula, &cell.value, format.as_ref(), &mut cached_results)?;
                    } else if cell.style_index > 0
                        && cell.style_index < sheet.styles.len()
                        && !linked_cells.contains(&(*row, *col))
                    {
                        // An empty cell with a style of its own keeps it, as
                        // Excel saves one (`<c r="B2" s="1"/>`); it used to be
                        // dropped, and its format with it (round 15 sweep).
                        if let Some(fmt) = format {
                            worksheet.write_blank(*row, *col as u16, &fmt)?;
                        }
                    }
                }
                SavedCellValue::Number(n) => {
                    if let Some(formula) = formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        write_formula_cell(worksheet, *row, *col as u16, clean_formula, &cell.value, format.as_ref(), &mut cached_results)?;
                    } else if let Some(fmt) = format {
                        worksheet.write_number_with_format(*row, *col as u16, *n, &fmt)?;
                    } else {
                        worksheet.write_number(*row, *col as u16, *n)?;
                    }
                }
                SavedCellValue::Text(s) => {
                    let base_style = (cell.style_index > 0 && cell.style_index < sheet.styles.len())
                        .then(|| &sheet.styles[cell.style_index]);
                    let rich_formats = rich_text_formats(
                        cell.rich_text.as_deref(),
                        s,
                        base_style,
                        linked_cells.contains(&(*row, *col)),
                        theme_fonts,
                    );
                    if let Some(formula) = formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        write_formula_cell(worksheet, *row, *col as u16, clean_formula, &cell.value, format.as_ref(), &mut cached_results)?;
                    } else if let Some(runs) = rich_formats {
                        // Per-run formatting, as Excel saves it: a shared
                        // string of `<r>` runs, each `<rPr>` the run's font
                        // (round 15: the runs were dropped and the cell
                        // exported as plain text).
                        let segments: Vec<(&Format, &str)> = runs.iter().map(|(f, t)| (f, t.as_str())).collect();
                        match format {
                            Some(fmt) => worksheet.write_rich_string_with_format(*row, *col as u16, &segments, &fmt)?,
                            None => worksheet.write_rich_string(*row, *col as u16, &segments)?,
                        };
                    } else if let Some(fmt) = format {
                        worksheet.write_string_with_format(*row, *col as u16, s, &fmt)?;
                    } else {
                        worksheet.write_string(*row, *col as u16, s)?;
                    }
                }
                SavedCellValue::Boolean(b) => {
                    if let Some(formula) = formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        write_formula_cell(worksheet, *row, *col as u16, clean_formula, &cell.value, format.as_ref(), &mut cached_results)?;
                    } else if let Some(fmt) = format {
                        worksheet.write_boolean_with_format(*row, *col as u16, *b, &fmt)?;
                    } else {
                        worksheet.write_boolean(*row, *col as u16, *b)?;
                    }
                }
                SavedCellValue::Error(err) => {
                    // A formula currently in error keeps its FORMULA (Excel
                    // recalculates on open) with its error cached; a static
                    // error cell is Excel's error constant, `t="e"` -- written
                    // as a `0` placeholder here and retyped by `finish_archive`
                    // (`retype_static_errors`), never as the TEXT "#N/A".
                    if let Some(formula) = formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        write_formula_cell(worksheet, *row, *col as u16, clean_formula, &cell.value, format.as_ref(), &mut cached_results)?;
                    } else {
                        if let Some(fmt) = format {
                            worksheet.write_number_with_format(*row, *col as u16, 0.0, &fmt)?;
                        } else {
                            worksheet.write_number(*row, *col as u16, 0.0)?;
                        }
                        // rust_xlsxwriter numbers its worksheet parts in the
                        // order the sheets are added, from 1.
                        let vm = cached_results.rich.vm(err);
                        static_errors
                            .entry(format!("xl/worksheets/sheet{}.xml", sheet_position + 1))
                            .or_default()
                            .insert((*row, *col), (excel_error_literal(err).to_string(), vm));
                    }
                }
                SavedCellValue::List(items) => {
                    if let Some(formula) = formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        write_formula_cell(worksheet, *row, *col as u16, clean_formula, &cell.value, format.as_ref(), &mut cached_results)?;
                    } else {
                        let display = format!("[List({})]", items.len());
                        if let Some(fmt) = format {
                            worksheet.write_string_with_format(*row, *col as u16, &display, &fmt)?;
                        } else {
                            worksheet.write_string(*row, *col as u16, &display)?;
                        }
                    }
                }
                SavedCellValue::Dict(entries) => {
                    if let Some(formula) = formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        write_formula_cell(worksheet, *row, *col as u16, clean_formula, &cell.value, format.as_ref(), &mut cached_results)?;
                    } else {
                        let display = format!("[Dict({})]", entries.len());
                        if let Some(fmt) = format {
                            worksheet.write_string_with_format(*row, *col as u16, &display, &fmt)?;
                        } else {
                            worksheet.write_string(*row, *col as u16, &display)?;
                        }
                    }
                }
            }
        }

        // The cells whose formula was left out, in sheet order (the cells
        // live in a HashMap).
        lost_formulas.sort_unstable();
        losses.formulas.extend(
            lost_formulas.into_iter().map(|(row, col)| format!("{}!{}", sheet.name, rust_xlsxwriter::utility::row_col_to_cell(row, col as u16))),
        );

        // ---- Notes / Comments ----
        for note in &sheet.notes {
            let xlsx_note = Note::new(&note.text);
            worksheet.insert_note(note.row, note.col as u16, &xlsx_note)?;
        }

        // ---- Page setup / Print settings ----
        if let Some(ref ps) = sheet.page_setup {
            write_page_setup(worksheet, ps)?;
        }

        // ---- Charts (native OOXML emission, best-effort) ----
        // Basic marks map to real Excel charts so Excel users see them; the
        // full-fidelity ChartDefinition additionally rides the _calcula_meta
        // sheet below, so a Calcula round-trip is lossless regardless of how
        // faithful this native mapping is. A chart that cannot be mapped is
        // skipped here (not an error) — it still survives via the meta carry.
        for chart_entry in workbook.charts.iter().filter(|c| c.sheet_id == sheet.id) {
            // An unparseable spec (kept as a string value) has no native form.
            let def = &chart_entry.spec;
            if !def.is_object() {
                continue;
            }
            if let Some((chart, row, col)) = build_native_chart(def, &sheet.name) {
                match worksheet.insert_chart(row, col, &chart) {
                    Ok(_) => {
                        natively_emitted.insert(chart_entry.id);
                    }
                    Err(e) => {
                        eprintln!("[WARN] xlsx save: chart '{}' skipped: {}", chart_entry.id, e);
                    }
                }
            }
        }
    }

    // ========================================================================
    // Named ranges / Defined names
    // ========================================================================
    // Each name's formula as Excel spells it in a file: `_xlpm.` on LAMBDA /
    // LET parameters and the `_xlfn.` future-function prefixes, which
    // `define_name` does not add ([LIVE] Excel 16 saves a name `=LAMBDA(n,n+1)`
    // as `_xlfn.LAMBDA(_xlpm.n,_xlpm.n+1)` and `=XLOOKUP(..)` as
    // `_xlfn.XLOOKUP(..)`; see `xlsx_formula_text`), and a reference that
    // names no sheet as the using sheet's, `!A1` (its `$` as the name has it:
    // a relative part means the using cell) -- [LIVE] Excel refused a
    // workbook whose name read `A1` (`excel_name_formula_text`). A table
    // name in it is spelled as the table declares it, as in a cell
    // (`xlsx_tables::respell_table_names`): a name's text re-rendered by a
    // rename or a structural edit holds the lexer's upper-case `DATA[Q]`, and
    // [LIVE] Excel 16 refused a file whose formula read so for a table Data.
    let declared_tables: Vec<&str> = workbook.tables.iter().map(|t| t.name.as_str()).collect();
    let name_formulas = crate::xlsx_formula_text::escape_defined_name_formulas(
        &workbook
            .named_ranges
            .iter()
            .map(|nr| {
                let text = crate::xlsx_formula_text::excel_name_formula_text(&nr.refers_to, &cached_results.names);
                crate::xlsx_tables::respell_table_names(&text, &declared_tables).unwrap_or(text)
            })
            .collect::<Vec<_>>(),
    )?;
    // Names scoped to a sheet whose name holds a `!`, written into the
    // workbook part by `finish_archive` (`with_local_defined_names`): the
    // library splits a scoped name at its FIRST `!`, so `'a!b'!Rate` was read
    // as sheet `'a`, name `b'!Rate`, refused, and the name lost (xlsx4, round
    // 16). [LIVE] Excel 16 saves it as `<definedName name="Rate"
    // localSheetId="1">'a!b'!$B$1</definedName>`.
    let mut bang_scoped_names: Vec<LocalDefinedName> = Vec::new();
    for (nr, name_formula) in workbook.named_ranges.iter().zip(&name_formulas) {
        // A name whose formula Excel cannot hold (a bare `C` / `R` or an
        // R1C1-shaped name, relative to a cell a name does not have; see
        // `xlsx_formula_text::Unwritable`) is left out, and the user told.
        if crate::xlsx_formula_text::unwritable_reason(&nr.refers_to, None).is_some() {
            eprintln!("[WARN] xlsx save: defined name '{}' skipped: no formula Excel can hold", nr.name);
            losses.defined_names.push(nr.name.clone());
            continue;
        }
        // rust_xlsxwriter define_name expects the formula with sheet reference
        // For sheet-scoped names, prefix with "SheetName!"
        let full_name = if let Some(sid) = nr.sheet_id {
            // Find the sheet's position by its stable SheetId
            if let Some((position, sheet)) = workbook.sheets.iter().enumerate().find(|(_, s)| s.id == sid) {
                if sheet.name.contains('!') {
                    // The library's own check of the name itself (letters,
                    // no space or `,/*[]:"'`), on a scratch workbook.
                    if let Err(e) = XlsxWorkbook::new().define_name(&nr.name, "=0") {
                        eprintln!("[WARN] xlsx save: defined name '{}' skipped: {}", nr.name, e);
                        losses.defined_names.push(nr.name.clone());
                        continue;
                    }
                    bang_scoped_names.push(LocalDefinedName {
                        name: nr.name.clone(),
                        sheet_position: position,
                        formula: name_formula.clone(),
                    });
                    continue;
                }
                // Quoted as a formula quotes a sheet name: an apostrophe in
                // it is doubled ([LIVE] Excel 16 lists a name on a sheet
                // called It's as `'It''s'!Rate`). The library un-doubles it to
                // find the sheet; undoubled, docProps/app.xml listed the name
                // as `'It's'!Rate`.
                format!("'{}'!{}", sheet.name.replace('\'', "''"), nr.name)
            } else {
                nr.name.clone()
            }
        } else {
            nr.name.clone()
        };
        // The refers_to should already include sheet references like "Sheet1!$A$1:$B$5"
        let formula = format!("={}", name_formula);
        if let Err(e) = xlsx.define_name(&full_name, &formula) {
            // A bad name must not abort the whole save; the user is told what
            // was left out (`XlsxExportLosses`).
            eprintln!("[WARN] xlsx save: defined name '{}' skipped: {}", full_name, e);
            losses.defined_names.push(nr.name.clone());
        }
    }

    // ========================================================================
    // Calcula metadata sheet (full-fidelity charts/sparklines)
    // ========================================================================
    // Tables are not carried: they are Excel table parts (`xlsx_tables`).
    // Charts/sparklines are keyed by visible-sheet POSITION (SheetIds are
    // re-minted on import); entries whose sheet no longer exists are dropped.
    let meta_charts: Vec<crate::MetaChart> = workbook
        .charts
        .iter()
        .filter_map(|c| {
            workbook
                .sheets
                .iter()
                .position(|s| s.id == c.sheet_id)
                .map(|idx| crate::MetaChart {
                    sheet_index: idx,
                    // The meta sheet carries TEXT. An unparseable spec kept
                    // as a string value round-trips as its original text.
                    spec_json: match &c.spec {
                        serde_json::Value::String(raw) => raw.clone(),
                        other => other.to_string(),
                    },
                    native_emitted: natively_emitted.contains(&c.id),
                })
        })
        .collect();
    let meta_sparklines: Vec<crate::MetaSparkline> = workbook
        .sparklines
        .iter()
        .filter_map(|sp| {
            workbook
                .sheets
                .iter()
                .position(|s| s.id == sp.sheet_id)
                .map(|idx| crate::MetaSparkline {
                    sheet_index: idx,
                    groups_json: sp.groups_json.clone(),
                })
        })
        .collect();
    if !meta_charts.is_empty() || !meta_sparklines.is_empty() {
        let mut meta = CalculaMeta::new();
        meta.charts = meta_charts;
        meta.sparklines = meta_sparklines;
        let json = meta.to_json();

        let meta_ws = xlsx.add_worksheet();
        meta_ws.set_name(META_SHEET_NAME)?;
        // Excel caps a cell string at 32,767 chars; a chart-heavy carry can
        // exceed that, which would abort the WHOLE save. Chunk the JSON across
        // row 0 (A1, B1, C1, ...); the reader concatenates row 0's strings.
        // Chunks split on char boundaries so multi-byte text never tears.
        const META_CHUNK_CHARS: usize = 30_000;
        let chars: Vec<char> = json.chars().collect();
        let mut col: u16 = 0;
        for chunk in chars.chunks(META_CHUNK_CHARS) {
            let piece: String = chunk.iter().collect();
            meta_ws.write_string(0, col, &piece)?;
            col = col.saturating_add(1);
        }
        meta_ws.set_hidden(true);
    }

    let wrote_meta_charts = !workbook.charts.is_empty();
    {
        // Excel's own markers for values saved without recalculating
        // (`Workbook::calculation_incomplete`, BUG-0615#2) and for a manual
        // calculation mode, its typed cached results, its standard column
        // width, and the calculation features every Excel 16 workbook states
        // (`with_calc_features`). rust_xlsxwriter has no setting for any of
        // them, so the archive is finished in memory and stated before the
        // file is written. Every save is finished, because every workbook
        // carries the calculation features ([LIVE] Excel 16 writes them into
        // a blank workbook too); parts with nothing to state are copied as
        // the library wrote them.
        let bytes = xlsx.save_to_buffer()?;
        let bytes = finish_archive(
            &bytes,
            workbook.calculation_incomplete,
            manual_calculation,
            !manual_calculation && workbook.calculation_except_tables,
            &cached_results,
            &standard_widths,
            &static_errors,
            &bang_scoped_names,
        )?;
        let bytes = match &data_tables {
            Some((_, parts)) => crate::xlsx_data_tables::finish_with_data_tables(&bytes, parts)?,
            None => bytes,
        };
        // A calculated column whose formula holds an `@` (a column NAME's):
        // the library garbles it in the table part (`TableParts::finish_archive`).
        let bytes = table_parts.finish_archive(&bytes)?.unwrap_or(bytes);
        // The custom named cell styles, which the library cannot write
        // (`xlsx_named_styles`, BUG-0771).
        let bytes = match crate::xlsx_named_styles::finish_with_named_styles(&bytes, workbook, &unused_style_records)? {
            Some((finished, lost)) => {
                losses.named_styles.extend(lost);
                finished
            }
            None => bytes,
        };
        std::fs::write(path, bytes)?;
    }

    // Freshness marker: an ORPHAN zip part (valid .xml content type, but no
    // OPC relationship). Excel/LibreOffice rebuild the package on save and
    // drop unreferenced parts, so on reopen: marker PRESENT = the file has
    // not been resaved by another app since Calcula wrote it (the lossless
    // _calcula_meta chart carry is trustworthy); marker ABSENT = another app
    // resaved it (its native charts win, even for edits that keep the chart
    // count unchanged). Best-effort — a failure must not fail the save.
    if wrote_meta_charts {
        if let Err(e) = append_freshness_marker(path) {
            eprintln!("[WARN] xlsx save: freshness marker not written: {}", e);
        }
    }
    Ok(losses)
}

/// The orphan-part path checked by the reader (see save_xlsx).
pub const XLSX_FRESHNESS_MARKER: &str = "calculaMeta/marker.xml";

/// The workbook part whose `<calcPr>` carries the calculation state.
pub(crate) const XLSX_WORKBOOK_PART: &str = "xl/workbook.xml";

/// The rich-value parts, at the paths Excel 16 writes them ([LIVE]).
pub(crate) const XLSX_METADATA_PART: &str = "xl/metadata.xml";
pub(crate) const XLSX_RICH_VALUE_PART: &str = "xl/richData/rdrichvalue.xml";
pub(crate) const XLSX_RICH_VALUE_STRUCTURE_PART: &str = "xl/richData/rdrichvaluestructure.xml";
const XLSX_RICH_VALUE_TYPES_PART: &str = "xl/richData/rdRichValueTypes.xml";
const XLSX_WORKBOOK_RELS_PART: &str = "xl/_rels/workbook.xml.rels";
const XLSX_CONTENT_TYPES_PART: &str = "[Content_Types].xml";

/// A metadata part with nothing in it, for [`with_rich_value_metadata`] to fill.
const EMPTY_METADATA_XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<metadata xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><metadataTypes count=\"0\"></metadataTypes></metadata>";

/// The one rich-value structure an error needs: Excel's `_error` with its
/// `errorType` key (Excel adds keys such as `subType` and the spill offsets
/// where it knows them; Calcula does not keep them).
const RICH_VALUE_STRUCTURE_XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<rvStructures xmlns=\"http://schemas.microsoft.com/office/spreadsheetml/2017/richdata\" count=\"1\"><s t=\"_error\"><k n=\"errorType\" t=\"i\"/></s></rvStructures>";

/// `rdRichValueTypes.xml` as Excel 16 writes it ([LIVE]).
const RICH_VALUE_TYPES_XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<rvTypesInfo xmlns=\"http://schemas.microsoft.com/office/spreadsheetml/2017/richdata2\" xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" mc:Ignorable=\"x\" xmlns:x=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><global><keyFlags><key name=\"_Self\"><flag name=\"ExcludeFromFile\" value=\"1\"/><flag name=\"ExcludeFromCalcComparison\" value=\"1\"/></key><key name=\"_DisplayString\"><flag name=\"ExcludeFromCalcComparison\" value=\"1\"/></key><key name=\"_Flags\"><flag name=\"ExcludeFromCalcComparison\" value=\"1\"/></key><key name=\"_Format\"><flag name=\"ExcludeFromCalcComparison\" value=\"1\"/></key><key name=\"_SubLabel\"><flag name=\"ExcludeFromCalcComparison\" value=\"1\"/></key><key name=\"_Attribution\"><flag name=\"ExcludeFromCalcComparison\" value=\"1\"/></key><key name=\"_Icon\"><flag name=\"ExcludeFromCalcComparison\" value=\"1\"/></key><key name=\"_Display\"><flag name=\"ExcludeFromCalcComparison\" value=\"1\"/></key><key name=\"_CanonicalPropertyNames\"><flag name=\"ExcludeFromCalcComparison\" value=\"1\"/></key><key name=\"_ClassificationId\"><flag name=\"ExcludeFromCalcComparison\" value=\"1\"/></key></keyFlags></global></rvTypesInfo>";

/// `rdrichvalue.xml`: one `_error` rich value per error type, in `vm` order.
fn rich_value_data_xml(types: &[u32]) -> String {
    let mut xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<rvData xmlns=\"http://schemas.microsoft.com/office/spreadsheetml/2017/richdata\" count=\"{}\">",
        types.len()
    );
    for t in types {
        xml.push_str(&format!("<rv s=\"0\"><v>{}</v></rv>", t));
    }
    xml.push_str("</rvData>");
    xml
}

/// `xl/metadata.xml` with an `XLRICHVALUE` metadata type and one value-metadata
/// block per rich value (`vm` = 1..=`count`), as Excel 16 writes them
/// ([LIVE]); added to whatever the part already holds (the library's
/// `XLDAPR` dynamic-array metadata).
fn with_rich_value_metadata(xml: &str, count: usize) -> Result<String, PersistenceError> {
    let bad = |what: &str| PersistenceError::InvalidFormat(format!("xlsx rich-value metadata: {}", what));
    if xml.contains("<valueMetadata") || xml.contains("name=\"XLRICHVALUE\"") {
        return Err(bad("the metadata part already carries rich values"));
    }
    let mut out = xml.to_string();
    // The richdata namespace on the root element.
    let root = out.find("<metadata").ok_or_else(|| bad("no <metadata> element"))?;
    let root_end = root + out[root..].find('>').ok_or_else(|| bad("unclosed <metadata>"))?;
    if !out[root..root_end].contains("xmlns:xlrd=") {
        out.insert_str(root_end, " xmlns:xlrd=\"http://schemas.microsoft.com/office/spreadsheetml/2017/richdata\"");
    }
    // The metadata type, last in the list: its 1-based index is the new count.
    let types_at = out.find("<metadataTypes").ok_or_else(|| bad("no <metadataTypes>"))?;
    let count_at = types_at + out[types_at..].find("count=\"").ok_or_else(|| bad("no metadataTypes count"))? + 7;
    let count_end = count_at + out[count_at..].find('"').ok_or_else(|| bad("bad metadataTypes count"))?;
    let type_index = out[count_at..count_end].parse::<usize>().map_err(|_| bad("bad metadataTypes count"))? + 1;
    out.replace_range(count_at..count_end, &type_index.to_string());
    let types_end = out.find("</metadataTypes>").ok_or_else(|| bad("unclosed <metadataTypes>"))?;
    out.insert_str(
        types_end,
        "<metadataType name=\"XLRICHVALUE\" minSupportedVersion=\"120000\" copy=\"1\" pasteAll=\"1\" pasteValues=\"1\" merge=\"1\" splitFirst=\"1\" rowColShift=\"1\" clearFormats=\"1\" clearComments=\"1\" assign=\"1\" coerce=\"1\"/>",
    );
    // Its future metadata: after the last one there is (the schema's order).
    let mut future = format!("<futureMetadata name=\"XLRICHVALUE\" count=\"{}\">", count);
    for i in 0..count {
        future.push_str(&format!(
            "<bk><extLst><ext uri=\"{{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}}\"><xlrd:rvb i=\"{}\"/></ext></extLst></bk>",
            i
        ));
    }
    future.push_str("</futureMetadata>");
    let future_at = match out.rfind("</futureMetadata>") {
        Some(at) => at + "</futureMetadata>".len(),
        None => out.find("</metadataTypes>").ok_or_else(|| bad("unclosed <metadataTypes>"))? + "</metadataTypes>".len(),
    };
    out.insert_str(future_at, &future);
    // The value metadata, last before the root's end.
    let mut values = format!("<valueMetadata count=\"{}\">", count);
    for i in 0..count {
        values.push_str(&format!("<bk><rc t=\"{}\" v=\"{}\"/></bk>", type_index, i));
    }
    values.push_str("</valueMetadata>");
    let end = out.rfind("</metadata>").ok_or_else(|| bad("unclosed <metadata>"))?;
    out.insert_str(end, &values);
    Ok(out)
}

/// The workbook's relationships with the rich-value parts (and the metadata
/// part when the library wrote none), at fresh ids.
fn with_rich_value_relationships(xml: &str, add_metadata: bool) -> Result<String, PersistenceError> {
    let bad = |what: &str| PersistenceError::InvalidFormat(format!("xlsx rich-value relationships: {}", what));
    let mut next_id = 1 + xml
        .match_indices("Id=\"rId")
        .filter_map(|(at, m)| {
            let rest = &xml[at + m.len()..];
            rest[..rest.find('"')?].parse::<u32>().ok()
        })
        .max()
        .unwrap_or(0);
    let mut added = String::new();
    let mut add = |kind: &str, target: &str| {
        added.push_str(&format!("<Relationship Id=\"rId{}\" Type=\"{}\" Target=\"{}\"/>", next_id, kind, target));
        next_id += 1;
    };
    if add_metadata {
        add("http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata", "metadata.xml");
    }
    add("http://schemas.microsoft.com/office/2017/06/relationships/rdRichValue", "richData/rdrichvalue.xml");
    add("http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueStructure", "richData/rdrichvaluestructure.xml");
    add("http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueTypes", "richData/rdRichValueTypes.xml");
    let end = xml.rfind("</Relationships>").ok_or_else(|| bad("no </Relationships>"))?;
    Ok(format!("{}{}{}", &xml[..end], added, &xml[end..]))
}

/// The package's content types with the rich-value parts (and the metadata
/// part when the library wrote none).
fn with_rich_value_content_types(xml: &str, add_metadata: bool) -> Result<String, PersistenceError> {
    let bad = |what: &str| PersistenceError::InvalidFormat(format!("xlsx rich-value content types: {}", what));
    let mut added = String::new();
    if add_metadata {
        added.push_str("<Override PartName=\"/xl/metadata.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml\"/>");
    }
    added.push_str("<Override PartName=\"/xl/richData/rdrichvalue.xml\" ContentType=\"application/vnd.ms-excel.rdrichvalue+xml\"/>");
    added.push_str("<Override PartName=\"/xl/richData/rdrichvaluestructure.xml\" ContentType=\"application/vnd.ms-excel.rdrichvaluestructure+xml\"/>");
    added.push_str("<Override PartName=\"/xl/richData/rdRichValueTypes.xml\" ContentType=\"application/vnd.ms-excel.rdrichvaluetypes+xml\"/>");
    let end = xml.rfind("</Types>").ok_or_else(|| bad("no </Types>"))?;
    Ok(format!("{}{}{}", &xml[..end], added, &xml[end..]))
}

/// Rewrite a finished .xlsx archive's `<calcPr>`. With `incomplete` it says
/// `calcCompleted="0"` -- what Excel writes for a workbook saved with
/// calculation pending.
///
/// [LIVE] Excel 16, manual calculation, a precedent changed, saved with
/// CalculateBeforeSave off: `<calcPr calcId="191029" calcMode="manual"
/// calcCompleted="0" calcOnSave="0"/>`, and the reopened workbook reports
/// CalculationState = xlPending with the stale value shown. `fullCalcOnLoad`
/// (which rust_xlsxwriter always writes) is KEPT: [LIVE] a file with
/// `fullCalcOnLoad="1" calcCompleted="0"` and no `calcMode` opens in Excel
/// recalculated (xlDone, the fresh value), so Excel never shows a stale value
/// as calculated either way; the marker is what tells a reader that does not
/// recalculate -- Calcula's own included -- that the cached values may be
/// stale. Every other part is copied byte for byte. A workbook part with no
/// `<calcPr>` is refused rather than saved silently unmarked.
///
/// With `manual` it also says `calcMode="manual"`, as Excel does for a
/// workbook saved while calculation is manual ([LIVE] Excel 16:
/// `<calcPr calcId="191029" calcMode="manual"/>`). `fullCalcOnLoad` stays
/// here too: [LIVE] a `calcMode="manual" fullCalcOnLoad="1"` file opens in
/// Excel MANUAL and xlPending, showing the cached values, so the user sees
/// Calcula's values with Excel's "Calculate" until they press F9 -- the
/// formulas carry their cached results (`CachedResults`).
///
/// The same pass states what rust_xlsxwriter cannot in the SHEET parts: each
/// marked cached result's type and value (`retype_cached_results`, every
/// worksheet part that carries a marker) and a sheet's standard column width
/// (`with_default_column_width`, the parts named in `standard_widths`), and
/// each static error cell as Excel's `t="e"` (`retype_static_errors`, the parts
/// named in `static_errors`). The workbook part is rewritten only when
/// `incomplete` or `manual` asks for it, and a sheet part only when it carries
/// something to state (rev12B, round 13: every sheet part was inflated and
/// re-deflated whenever any one of them needed it); every other part is
/// copied byte for byte.
///
/// An error Excel saves as `#VALUE!` plus RICH-VALUE metadata (`#SPILL!`,
/// `#CALC!`, ... see [`RICH_ERROR_TYPES`]) gets that metadata, the way Excel
/// writes it: `xl/metadata.xml` (an `XLRICHVALUE` value-metadata block per
/// rich value, merged into the part the library writes for dynamic arrays),
/// `xl/richData/rdrichvalue.xml` and its structure and types parts, their
/// workbook relationships and content types -- so Excel and Calcula's own
/// reader get the real error back rather than `#VALUE!`.
fn finish_archive(
    xlsx_bytes: &[u8],
    incomplete: bool,
    manual: bool,
    except_tables: bool,
    cached_results: &CachedResults,
    standard_widths: &std::collections::HashMap<String, f64>,
    static_errors: &std::collections::HashMap<String, std::collections::HashMap<(u32, u32), (String, Option<usize>)>>,
    local_names: &[LocalDefinedName],
) -> Result<Vec<u8>, PersistenceError> {
    use std::io::{Read, Write};
    let invalid = |e: zip::result::ZipError| PersistenceError::InvalidFormat(format!("xlsx calcPr rewrite: {}", e));
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(xlsx_bytes)).map_err(invalid)?;
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let state_calculation = incomplete || manual || except_tables;
    let rich_types = &cached_results.rich.types;
    let has_rich = !rich_types.is_empty();
    let had_metadata = archive.file_names().any(|n| n == XLSX_METADATA_PART);
    let mut marked = false;
    let mut widths_stated = 0usize;
    let mut errors_stated = 0usize;
    let marker = format!("<v>{}", CACHED_RESULT_MARK);
    let deflated = || zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(invalid)?;
        let name = entry.name().to_string();
        // Always: the workbook part states Excel's calculation features
        // (`with_calc_features`), and the calculation state when asked.
        let is_workbook = name == XLSX_WORKBOOK_PART;
        let is_sheet = name.starts_with("xl/worksheets/sheet")
            && name.ends_with(".xml")
            && (standard_widths.contains_key(&name)
                || static_errors.contains_key(&name)
                || cached_results.parts.contains(&name));
        let is_rich_part = has_rich
            && (name == XLSX_METADATA_PART || name == XLSX_WORKBOOK_RELS_PART || name == XLSX_CONTENT_TYPES_PART);
        if !is_workbook && !is_sheet && !is_rich_part {
            out.raw_copy_file(entry).map_err(invalid)?;
            continue;
        }
        if is_rich_part {
            let mut xml = String::new();
            entry.read_to_string(&mut xml)?;
            drop(entry);
            let rewritten = if name == XLSX_METADATA_PART {
                with_rich_value_metadata(&xml, rich_types.len())?
            } else if name == XLSX_WORKBOOK_RELS_PART {
                with_rich_value_relationships(&xml, !had_metadata)?
            } else {
                with_rich_value_content_types(&xml, !had_metadata)?
            };
            out.start_file(name, deflated()).map_err(invalid)?;
            out.write_all(rewritten.as_bytes())?;
            continue;
        }
        let mut xml = String::new();
        entry.read_to_string(&mut xml)?;
        drop(entry);
        let mut rewritten = xml;
        if is_workbook {
            let no_calc_pr = || {
                PersistenceError::InvalidFormat(
                    "xlsx save: the workbook part has no <calcPr> to state the calculation in".to_string(),
                )
            };
            if incomplete {
                rewritten = with_calc_completed_false(&rewritten).ok_or_else(no_calc_pr)?;
            }
            if manual {
                rewritten = with_calc_pr_attribute(&rewritten, "calcMode", "manual").ok_or_else(no_calc_pr)?;
            } else if except_tables {
                // Automatic except for data tables (BUG-0754), as Excel 16
                // writes it [LIVE, dtable/probe2.ps1].
                rewritten = with_calc_pr_attribute(&rewritten, "calcMode", "autoNoTable").ok_or_else(no_calc_pr)?;
            }
            rewritten = with_local_defined_names(&rewritten, local_names)?;
            rewritten = with_calc_features(&rewritten)?;
            marked = true;
        } else {
            if let Some(&padded) = standard_widths.get(&name) {
                rewritten = with_default_column_width(&rewritten, padded)?;
                widths_stated += 1;
            }
            if rewritten.contains(&marker) {
                rewritten = retype_cached_results(&rewritten, &cached_results.cells)?;
            }
            if let Some(errors) = static_errors.get(&name) {
                rewritten = retype_static_errors(&rewritten, errors)?;
                errors_stated += 1;
            }
        }
        out.start_file(name, deflated()).map_err(invalid)?;
        out.write_all(rewritten.as_bytes())?;
    }
    if has_rich {
        if !had_metadata {
            out.start_file(XLSX_METADATA_PART, deflated()).map_err(invalid)?;
            out.write_all(with_rich_value_metadata(EMPTY_METADATA_XML, rich_types.len())?.as_bytes())?;
        }
        out.start_file(XLSX_RICH_VALUE_PART, deflated()).map_err(invalid)?;
        out.write_all(rich_value_data_xml(rich_types).as_bytes())?;
        out.start_file(XLSX_RICH_VALUE_STRUCTURE_PART, deflated()).map_err(invalid)?;
        out.write_all(RICH_VALUE_STRUCTURE_XML.as_bytes())?;
        out.start_file(XLSX_RICH_VALUE_TYPES_PART, deflated()).map_err(invalid)?;
        out.write_all(RICH_VALUE_TYPES_XML.as_bytes())?;
    }
    if widths_stated != standard_widths.len() {
        return Err(PersistenceError::InvalidFormat(
            "xlsx save: a sheet's standard column width found no sheet part to be stated in".to_string(),
        ));
    }
    if errors_stated != static_errors.len() {
        return Err(PersistenceError::InvalidFormat(
            "xlsx save: a sheet's static error cells found no sheet part to be stated in".to_string(),
        ));
    }
    if state_calculation && !marked {
        return Err(PersistenceError::InvalidFormat(format!(
            "xlsx save: no {} part to state the calculation in",
            XLSX_WORKBOOK_PART
        )));
    }
    Ok(out.finish().map_err(invalid)?.into_inner())
}

/// A sheet-scoped defined name written straight into the workbook part.
struct LocalDefinedName {
    name: String,
    /// The sheet's position in `<sheets>` (Excel's `localSheetId`).
    sheet_position: usize,
    /// The formula as the file carries it (no leading `=`).
    formula: String,
}

/// XML text / attribute escaping for the five predefined entities.
fn escape_xml_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The workbook part with `names` added to its `<definedNames>` (created
/// before `<calcPr>` when the library wrote none), each as Excel 16 writes a
/// sheet-scoped name ([LIVE] round 17: `<definedName name="Rate"
/// localSheetId="1">'a!b'!$B$1</definedName>`). A name the part already
/// holds with the same scope is refused rather than written twice.
fn with_local_defined_names(workbook_xml: &str, names: &[LocalDefinedName]) -> Result<String, PersistenceError> {
    if names.is_empty() {
        return Ok(workbook_xml.to_string());
    }
    let bad = |what: &str| PersistenceError::InvalidFormat(format!("xlsx local defined names: {}", what));
    let mut added = String::new();
    for name in names {
        let open = format!(
            "<definedName name=\"{}\" localSheetId=\"{}\">",
            escape_xml_attr(&name.name),
            name.sheet_position
        );
        if workbook_xml.contains(&open) || added.contains(&open) {
            return Err(bad("a sheet-scoped name would be written twice"));
        }
        added.push_str(&open);
        added.push_str(&escape_xml_text(&name.formula));
        added.push_str("</definedName>");
    }
    if let Some(end) = workbook_xml.find("</definedNames>") {
        return Ok(format!("{}{}{}", &workbook_xml[..end], added, &workbook_xml[end..]));
    }
    if workbook_xml.contains("<definedNames/>") {
        return Ok(workbook_xml.replacen("<definedNames/>", &format!("<definedNames>{}</definedNames>", added), 1));
    }
    // The schema's place: after `<sheets>` and before `<calcPr>`.
    let at = workbook_xml
        .find("<calcPr")
        .or_else(|| workbook_xml.find("</sheets>").map(|at| at + "</sheets>".len()))
        .ok_or_else(|| bad("the workbook part has neither <calcPr> nor </sheets>"))?;
    Ok(format!("{}<definedNames>{}</definedNames>{}", &workbook_xml[..at], added, &workbook_xml[at..]))
}

/// `<calcPr .../>` with `calcCompleted="0"` added (or an existing value
/// replaced); `None` when the part has no `<calcPr>` element.
fn with_calc_completed_false(workbook_xml: &str) -> Option<String> {
    with_calc_pr_attribute(workbook_xml, "calcCompleted", "0")
}

/// `<calcPr .../>` with `name="value"` added (or an existing value of that
/// attribute replaced); `None` when the part has no `<calcPr>` element.
fn with_calc_pr_attribute(workbook_xml: &str, name: &str, value: &str) -> Option<String> {
    let start = workbook_xml.find("<calcPr")?;
    // The element's own end: `/>` or `>` (rust_xlsxwriter writes it empty).
    let rel_end = workbook_xml[start..].find('>')?;
    let end = start + rel_end;
    let self_closing = workbook_xml[..end].ends_with('/');
    let attrs_end = if self_closing { end - 1 } else { end };
    let element = &workbook_xml[start..attrs_end];
    let needle = format!(" {}=", name);
    let element = match element.find(&needle) {
        Some(at) => {
            // Drop the existing attribute: name, `=`, quoted value.
            let after = &element[at + needle.len()..];
            let quote = after.chars().next()?;
            let close = after[1..].find(quote)? + 2;
            format!("{}{}", &element[..at], &after[close..])
        }
        None => element.to_string(),
    };
    let element = element.trim_end();
    Some(format!(
        "{}{} {}=\"{}\"{}{}",
        &workbook_xml[..start],
        element,
        name,
        value,
        &workbook_xml[attrs_end..end],
        &workbook_xml[end..]
    ))
}

/// Excel's calculation-features extension of the workbook part, verbatim as
/// Excel 16 writes it into EVERY workbook, a blank one included ([LIVE],
/// round 16). It states which calculation features the file's author knows
/// (`LET_WF`, `LAMBDA_WF`, the `@` operator `Single`, ...); written so the
/// workbook part says what Excel's own does.
///
/// It is NOT what makes Excel list hidden `_xlfn.LAMBDA` / `_xlpm.x` ...
/// `=#NAME?` names, as round 15 supposed: [LIVE] Excel 16 lists those for its
/// OWN file too (10 names for 4 real ones), with or without this extension,
/// `fileVersion lastEdited="7"` or the compatibility-version extension, and
/// saves none of them back into the file.
pub(crate) const XLSX_CALC_FEATURES_EXT: &str = "<ext uri=\"{B58B0392-4F1F-4190-BB64-5DF3571DCE5F}\" xmlns:xcalcf=\"http://schemas.microsoft.com/office/spreadsheetml/2018/calcfeatures\"><xcalcf:calcFeatures><xcalcf:feature name=\"microsoft.com:RD\"/><xcalcf:feature name=\"microsoft.com:Single\"/><xcalcf:feature name=\"microsoft.com:FV\"/><xcalcf:feature name=\"microsoft.com:CNMTM\"/><xcalcf:feature name=\"microsoft.com:LET_WF\"/><xcalcf:feature name=\"microsoft.com:LAMBDA_WF\"/><xcalcf:feature name=\"microsoft.com:ARRAYTEXT_WF\"/></xcalcf:calcFeatures></ext>";

/// The workbook part with [`XLSX_CALC_FEATURES_EXT`] as the last child of
/// `<workbook>` (CT_Workbook's `extLst` comes last), inside the part's own
/// `<extLst>` when it has one. Refuses a part that already states the
/// features (a second extension of one uri) or has no `</workbook>`.
fn with_calc_features(workbook_xml: &str) -> Result<String, PersistenceError> {
    let refuse = |why: &str| PersistenceError::InvalidFormat(format!("xlsx save: the workbook part {}", why));
    // The ELEMENT, never the bare uri text: a defined name may hold the GUID
    // as a string constant (`="{B58B0392-...}"`), which is written verbatim
    // into `<definedNames>` and refused every export of that workbook
    // (rev16C). User content is escaped, so `<ext uri="` cannot occur in it.
    if workbook_xml.contains("<ext uri=\"{B58B0392-4F1F-4190-BB64-5DF3571DCE5F}\"") {
        return Err(refuse("already states its calculation features"));
    }
    let close = workbook_xml.rfind("</workbook>").ok_or_else(|| refuse("has no </workbook>"))?;
    let head = workbook_xml[..close].trim_end();
    let (before, ext) = match head.strip_suffix("</extLst>") {
        Some(inner) => (inner.to_string(), format!("{}</extLst>", XLSX_CALC_FEATURES_EXT)),
        None => (head.to_string(), format!("<extLst>{}</extLst>", XLSX_CALC_FEATURES_EXT)),
    };
    Ok(format!("{}{}{}", before, ext, &workbook_xml[close..]))
}

/// Append the freshness marker part to an already-saved .xlsx (zip append —
/// does not rewrite the archive).
fn append_freshness_marker(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Write;
    let file = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
    let mut zip = zip::ZipWriter::new_append(file)?;
    zip.start_file(
        XLSX_FRESHNESS_MARKER,
        zip::write::SimpleFileOptions::default(),
    )?;
    zip.write_all(b"<calculaMeta generator=\"calcula\"/>")?;
    zip.finish()?;
    Ok(())
}

/// Map a Calcula ChartDefinition (the parsed spec_json) to a native
/// rust_xlsxwriter Chart plus its cell anchor. Returns None for marks or specs
/// that cannot be represented natively — the caller skips those (the chart
/// still round-trips via the _calcula_meta carry).
fn build_native_chart(
    def: &serde_json::Value,
    owning_sheet: &str,
) -> Option<(Chart, u32, u16)> {
    let spec = def.get("spec")?;
    let mark = spec.get("mark").and_then(|v| v.as_str())?;
    let stack = spec
        .get("markOptions")
        .and_then(|m| m.get("stackMode"))
        .and_then(|v| v.as_str())
        .unwrap_or("none");
    let chart_type = match (mark, stack) {
        ("bar", "stacked") => ChartType::ColumnStacked,
        ("bar", "percentStacked") => ChartType::ColumnPercentStacked,
        ("bar", _) => ChartType::Column,
        ("horizontalBar", "stacked") => ChartType::BarStacked,
        ("horizontalBar", "percentStacked") => ChartType::BarPercentStacked,
        ("horizontalBar", _) => ChartType::Bar,
        ("line", _) => ChartType::Line,
        ("area", "stacked") => ChartType::AreaStacked,
        ("area", "percentStacked") => ChartType::AreaPercentStacked,
        ("area", _) => ChartType::Area,
        ("pie", _) => ChartType::Pie,
        ("donut", _) => ChartType::Doughnut,
        ("scatter", _) => ChartType::Scatter,
        ("radar", _) => ChartType::Radar,
        _ => return None,
    };
    let mut chart = Chart::new(chart_type);

    // Data range: "A1:D10" on the owning sheet, or an explicit "Sheet!A1:D10".
    let data = spec.get("data").and_then(|v| v.as_str())?;
    let (sheet_name, range_part) = match data.split_once('!') {
        Some((s, r)) => (s.trim_matches('\''), r),
        None => (owning_sheet, data),
    };
    let ((r1, c1), (r2, c2)) = parse_cell_range(range_part)?;
    if c2 > u16::MAX as u32 {
        return None;
    }
    let has_headers = spec.get("hasHeaders").and_then(|v| v.as_bool()).unwrap_or(true);
    let orientation = spec
        .get("seriesOrientation")
        .and_then(|v| v.as_str())
        .unwrap_or("columns");
    let cat_index = spec.get("categoryIndex").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let series = spec.get("series").and_then(|v| v.as_array())?;
    if series.is_empty() {
        return None;
    }

    let mut wrote_series = false;
    if orientation == "rows" {
        // Series are rows within the range; categories are one row of it. With
        // headers, the FIRST COLUMN holds labels (mirror of the renderer's
        // parseRowOriented: dataStartCol = hasHeaders ? 1 : 0) — without this
        // the header text cell becomes a bogus data point in every series.
        let first_data_col = if has_headers { c1 + 1 } else { c1 };
        if first_data_col > c2 {
            return None;
        }
        let cat_row = r1 + cat_index;
        for s in series {
            let src = s.get("sourceIndex").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let val_row = r1 + src;
            if val_row > r2 {
                continue;
            }
            let cs = chart.add_series();
            cs.set_values((sheet_name, val_row, first_data_col as u16, val_row, c2 as u16));
            if cat_row <= r2 {
                cs.set_categories((sheet_name, cat_row, first_data_col as u16, cat_row, c2 as u16));
            }
            set_series_name(cs, s);
            wrote_series = true;
        }
    } else {
        // Series are columns within the range; categories are one column of it.
        let first_data_row = if has_headers { r1 + 1 } else { r1 };
        if first_data_row > r2 {
            return None;
        }
        let cat_col = c1 + cat_index;
        for s in series {
            let src = s.get("sourceIndex").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let val_col = c1 + src;
            if val_col > c2 {
                continue;
            }
            let cs = chart.add_series();
            cs.set_values((sheet_name, first_data_row, val_col as u16, r2, val_col as u16));
            if cat_col <= c2 {
                cs.set_categories((sheet_name, first_data_row, cat_col as u16, r2, cat_col as u16));
            }
            set_series_name(cs, s);
            wrote_series = true;
        }
    }
    if !wrote_series {
        return None;
    }

    if let Some(title) = spec.get("title").and_then(|v| v.as_str()) {
        if !title.is_empty() {
            chart.title().set_name(title);
        }
    }
    if let Some(legend) = spec.get("legend") {
        let show = legend.get("show").and_then(|v| v.as_bool()).unwrap_or(true);
        if !show {
            chart.legend().set_hidden();
        } else if let Some(pos) = legend.get("position").and_then(|v| v.as_str()) {
            let p = match pos {
                "left" => ChartLegendPosition::Left,
                "top" => ChartLegendPosition::Top,
                "bottom" => ChartLegendPosition::Bottom,
                _ => ChartLegendPosition::Right,
            };
            chart.legend().set_position(p);
        }
    }

    let width = def.get("width").and_then(|v| v.as_f64()).unwrap_or(480.0);
    let height = def.get("height").and_then(|v| v.as_f64()).unwrap_or(320.0);
    chart.set_width(width.max(1.0) as u32);
    chart.set_height(height.max(1.0) as u32);

    // Reverse of the importer's pixel approximation (col 100px, row 24px).
    let x = def.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0).max(0.0);
    let y = def.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0).max(0.0);
    let anchor_row = (y / 24.0) as u32;
    let anchor_col = ((x / 100.0) as u32).min(u16::MAX as u32) as u16;
    Some((chart, anchor_row, anchor_col))
}

/// Set a chart series' name: a "=Sheet1!$B$1" spec name becomes a cell
/// reference (resolved by Excel at render time), anything else is a literal.
fn set_series_name(cs: &mut ChartSeries, s: &serde_json::Value) {
    if let Some(name) = s.get("name").and_then(|v| v.as_str()) {
        if name.is_empty() {
            return;
        }
        if let Some(refstr) = name.strip_prefix('=') {
            cs.set_name(refstr);
        } else {
            cs.set_name(name);
        }
    }
}

/// Write page setup / print settings to a worksheet.
fn write_page_setup(
    worksheet: &mut rust_xlsxwriter::Worksheet,
    ps: &SavedPageSetup,
) -> Result<(), PersistenceError> {
    // Paper size
    let paper = match ps.paper_size.as_str() {
        "letter" => 1,
        "legal" => 5,
        "a3" => 8,
        "a4" => 9,
        "tabloid" => 3,
        _ => 9, // default A4
    };
    worksheet.set_paper_size(paper);

    // Orientation
    if ps.orientation == "landscape" {
        worksheet.set_landscape();
    }

    // Margins (rust_xlsxwriter order: left, right, top, bottom, header, footer)
    worksheet.set_margins(
        ps.margin_left,
        ps.margin_right,
        ps.margin_top,
        ps.margin_bottom,
        ps.margin_header,
        ps.margin_footer,
    );

    // Header / Footer
    if !ps.header.is_empty() {
        worksheet.set_header(&ps.header);
    }
    if !ps.footer.is_empty() {
        worksheet.set_footer(&ps.footer);
    }

    // Print area
    if !ps.print_area.is_empty() {
        if let Some((start, end)) = parse_cell_range(&ps.print_area) {
            let _ = worksheet.set_print_area(start.0, start.1 as u16, end.0, end.1 as u16);
        }
    }

    // Repeat rows at top
    if !ps.print_titles_rows.is_empty() {
        if let Some((first, last)) = parse_row_range(&ps.print_titles_rows) {
            let _ = worksheet.set_repeat_rows(first, last);
        }
    }

    // Page breaks
    if !ps.manual_row_breaks.is_empty() {
        let _ = worksheet.set_page_breaks(&ps.manual_row_breaks);
    }

    // Print gridlines
    if ps.print_gridlines {
        worksheet.set_print_gridlines(true);
    }

    // Center on page
    if ps.center_horizontally {
        worksheet.set_print_center_horizontally(true);
    }
    if ps.center_vertically {
        worksheet.set_print_center_vertically(true);
    }

    // Scaling
    if ps.fit_to_width > 0 || ps.fit_to_height > 0 {
        worksheet.set_print_fit_to_pages(ps.fit_to_width as u16, ps.fit_to_height as u16);
    } else if ps.scale != 100 {
        worksheet.set_print_scale(ps.scale as u16);
    }

    // Page order (overThenDown = true in rust_xlsxwriter)
    if ps.page_order == "overThenDown" {
        worksheet.set_page_order(true);
    }

    // First page number
    if ps.first_page_number > 0 {
        worksheet.set_print_first_page_number(ps.first_page_number as u16);
    }

    Ok(())
}

/// Parse a cell range string like "A1:F20" into ((row, col), (row, col)).
fn parse_cell_range(range: &str) -> Option<((u32, u32), (u32, u32))> {
    let parts: Vec<&str> = range.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let start = parse_cell_ref(parts[0])?;
    let end = parse_cell_ref(parts[1])?;
    Some((start, end))
}

/// Parse a cell reference like "A1" into (row, col) 0-indexed.
fn parse_cell_ref(cell_ref: &str) -> Option<(u32, u32)> {
    let cell_ref = cell_ref.replace('$', "");
    let mut col_str = String::new();
    let mut row_str = String::new();
    for c in cell_ref.chars() {
        if c.is_ascii_alphabetic() {
            col_str.push(c.to_ascii_uppercase());
        } else if c.is_ascii_digit() {
            row_str.push(c);
        }
    }
    if col_str.is_empty() || row_str.is_empty() {
        return None;
    }
    let col = col_letters_to_index(&col_str)?;
    let row: u32 = row_str.parse().ok()?;
    if row == 0 {
        return None;
    }
    Some((row - 1, col))
}

/// Convert column letters (e.g. "A" -> 0, "B" -> 1, "AA" -> 26) to 0-based index.
fn col_letters_to_index(letters: &str) -> Option<u32> {
    let mut result: u32 = 0;
    for c in letters.chars() {
        let val = (c as u32) - ('A' as u32) + 1;
        result = result * 26 + val;
    }
    if result == 0 {
        return None;
    }
    Some(result - 1)
}

/// Parse a row range string like "1:2" into (first_row, last_row) 0-indexed.
fn parse_row_range(range: &str) -> Option<(u32, u32)> {
    let parts: Vec<&str> = range.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let first: u32 = parts[0].trim().parse().ok()?;
    let last: u32 = parts[1].trim().parse().ok()?;
    if first == 0 || last == 0 {
        return None;
    }
    Some((first - 1, last - 1))
}

/// The minor (body) and major (heading) Latin fonts of the theme part
/// rust_xlsxwriter writes into every file (Office 2007's).
const FILE_THEME_MINOR_FONT: &str = "Calibri";
const FILE_THEME_MAJOR_FONT: &str = "Cambria";

/// The font name and the theme scheme (`minor` / `major`) a Calcula font
/// family is written with.
///
/// The theme keywords `Body` / `Headings` (`ThemeDefinition::resolve_font`)
/// are the workbook theme's body / heading font. [LIVE] Excel 16 writes a
/// theme font as that font by name WITH its scheme (`<name val="Aptos
/// Narrow"/><family val="2"/><scheme val="minor"/>` for Body, `<name
/// val="Aptos Display"/><scheme val="major"/>` for Headings); they used to be
/// written literally, `<name val="Body"/>`, and Excel showed a font called
/// "Body" (xlsx4, round 16). A scheme makes Excel show the FILE theme's font,
/// whatever the name says ([LIVE] round 17: `<name val="Calibri Light"/>
/// <scheme val="major"/>` showed Cambria, the library theme's major font --
/// even with the theme part rewritten to Calibri Light, which Excel 16 did not
/// take), so the scheme is written only when the file theme's font IS the
/// workbook theme's (Body = Calibri in the Office theme); otherwise the font
/// is written by name alone, the font the user sees.
fn excel_font(family: &str, fonts: &engine::theme::ThemeFonts) -> (String, Option<&'static str>) {
    let (name, scheme, file_font) = match family {
        "Body" | "body" => (&fonts.body, "minor", FILE_THEME_MINOR_FONT),
        "Headings" | "headings" => (&fonts.heading, "major", FILE_THEME_MAJOR_FONT),
        other => return (other.to_string(), None),
    };
    (name.clone(), (name.as_str() == file_font).then_some(scheme))
}

/// Set a format's font name (and theme scheme) from a Calcula font family
/// ([`excel_font`]).
fn with_excel_font_name(format: Format, family: &str, fonts: &engine::theme::ThemeFonts) -> Format {
    let (name, scheme) = excel_font(family, fonts);
    // The library's `set_font_name` drops the default `minor` scheme for any
    // font but Calibri, and keeps it for Calibri: state it either way.
    let format = format.set_font_name(&name);
    match scheme {
        Some(scheme) => format.set_font_scheme(scheme),
        None => format.set_font_scheme(""),
    }
}

/// A linked cell's format: its own style, with the Hyperlink style's font
/// (blue, underlined) where the style leaves the font's colour and underline
/// alone -- [LIVE] Excel 16 keeps a cell's fill when a link is added and gives
/// it the Hyperlink style's font (`<xf fontId=".." fillId="2" xfId="1">`, the
/// `Hyperlink` cell style). A colour or underline the cell sets is its own.
fn linked_cell_format(style: &CellStyle, fonts: &engine::theme::ThemeFonts) -> Format {
    let format = convert_style_to_format(style, fonts);
    if !is_default_color(&style.font.color) || style.font.underline != engine::UnderlineStyle::None {
        return format;
    }
    // `set_hyperlink` drops the font scheme; a theme font keeps it.
    let format = format.set_hyperlink();
    match excel_font(&style.font.family, fonts).1 {
        Some(scheme) => format.set_font_scheme(scheme),
        None => format,
    }
}

/// A cell's format in the cell loop: its own style (with the link look when
/// it is linked, [`linked_cell_format`]), else the library's link look for a
/// linked cell, else none.
fn cell_format(
    sheet: &crate::Sheet,
    cell: &crate::SavedCell,
    linked: bool,
    hyperlink_format: &Format,
    fonts: &engine::theme::ThemeFonts,
) -> Option<Format> {
    if cell.style_index > 0 && cell.style_index < sheet.styles.len() {
        let style = &sheet.styles[cell.style_index];
        Some(if linked { linked_cell_format(style, fonts) } else { convert_style_to_format(style, fonts) })
    } else if linked {
        Some(hyperlink_format.clone())
    } else {
        None
    }
}

fn convert_style_to_format(style: &CellStyle, fonts: &engine::theme::ThemeFonts) -> Format {
    let mut format = Format::new();

    // Font settings
    if style.font.bold {
        format = format.set_bold();
    }
    if style.font.italic {
        format = format.set_italic();
    }
    match style.font.underline {
        engine::UnderlineStyle::None => {}
        engine::UnderlineStyle::Single => {
            format = format.set_underline(rust_xlsxwriter::FormatUnderline::Single);
        }
        engine::UnderlineStyle::Double => {
            format = format.set_underline(rust_xlsxwriter::FormatUnderline::Double);
        }
        engine::UnderlineStyle::SingleAccounting => {
            format = format.set_underline(rust_xlsxwriter::FormatUnderline::SingleAccounting);
        }
        engine::UnderlineStyle::DoubleAccounting => {
            format = format.set_underline(rust_xlsxwriter::FormatUnderline::DoubleAccounting);
        }
    }
    if style.font.strikethrough {
        format = format.set_font_strikethrough();
    }

    // Points as a double -- `<sz val="10.5"/>` -- the unit OOXML stores.
    format = format.set_font_size(style.font.size.points());
    format = with_excel_font_name(format, &style.font.family, fonts);

    // Colors
    if !is_default_color(&style.font.color) {
        format = format.set_font_color(color_to_xlsx(&style.font.color));
    }
    if !style.fill.is_none() {
        let bg = style.fill.background_color();
        if !is_default_background(bg) {
            format = format.set_background_color(color_to_xlsx(bg));
        }
    }

    // Horizontal alignment
    format = format.set_align(match style.text_align {
        TextAlign::Left => FormatAlign::Left,
        TextAlign::Center => FormatAlign::Center,
        TextAlign::Right => FormatAlign::Right,
        TextAlign::General => FormatAlign::General,
    });

    // Vertical alignment
    format = format.set_align(match style.vertical_align {
        VerticalAlign::Top => FormatAlign::Top,
        VerticalAlign::Middle => FormatAlign::VerticalCenter,
        VerticalAlign::Bottom => FormatAlign::Bottom,
    });

    // Text rotation.
    //
    // rust_xlsxwriter's `set_rotation` takes an ANGLE in -90..=90 and ONE magic
    // value, 270, which it writes as OOXML 255 -- STACKED text. `Rotate270`
    // ("Rotate Text Down", 90 degrees clockwise) used to be passed as 270, so
    // every rotated-down cell exported as Excel's Vertical Text and came back
    // from a re-import as Rotate Text UP. Clockwise is a NEGATIVE angle here.
    match style.text_rotation {
        TextRotation::None => {}
        TextRotation::Rotate90 => {
            format = format.set_rotation(90);
        }
        TextRotation::Rotate270 => {
            format = format.set_rotation(-90);
        }
        TextRotation::Custom(angle) => {
            format = format.set_rotation(angle.clamp(-90, 90));
        }
        TextRotation::Vertical => {
            // The crate's spelling of OOXML 255.
            format = format.set_rotation(270);
        }
    }

    // Word wrap
    if style.wrap_text {
        format = format.set_text_wrap();
    }

    // Indent
    if style.indent > 0 {
        format = format.set_indent(style.indent);
    }

    // Shrink to fit
    if style.shrink_to_fit {
        format = format.set_shrink();
    }

    // Number format
    let num_format = convert_number_format(&style.number_format);
    if !num_format.is_empty() {
        format = format.set_num_format(&num_format);
    }

    // Borders
    format = apply_borders(format, &style.borders);

    // Protection. Excel keeps locked/hidden in the cell format
    // (`cellXfs/<xf>/<protection>`), the same place Calcula does, so this
    // round-trips with the reader. Nothing was emitted before, which meant an
    // exported workbook lost every unlocked cell: on re-open in Excel the whole
    // sheet read as locked, and protecting it would have frozen the inputs the
    // author had deliberately opened up.
    if !style.locked {
        format = format.set_unlocked();
    }
    if style.formula_hidden {
        format = format.set_hidden();
    }

    format
}

/// Apply border styles from CellStyle::Borders to a rust_xlsxwriter Format.
fn apply_borders(mut format: Format, borders: &engine::style::Borders) -> Format {
    // Top border
    if let Some(xlsx_border) = border_style_to_format_border(&borders.top) {
        format = format.set_border_top(xlsx_border);
        if !is_default_border_color(&borders.top.color) {
            format = format.set_border_top_color(color_to_xlsx(&borders.top.color));
        }
    }

    // Right border
    if let Some(xlsx_border) = border_style_to_format_border(&borders.right) {
        format = format.set_border_right(xlsx_border);
        if !is_default_border_color(&borders.right.color) {
            format = format.set_border_right_color(color_to_xlsx(&borders.right.color));
        }
    }

    // Bottom border
    if let Some(xlsx_border) = border_style_to_format_border(&borders.bottom) {
        format = format.set_border_bottom(xlsx_border);
        if !is_default_border_color(&borders.bottom.color) {
            format = format.set_border_bottom_color(color_to_xlsx(&borders.bottom.color));
        }
    }

    // Left border
    if let Some(xlsx_border) = border_style_to_format_border(&borders.left) {
        format = format.set_border_left(xlsx_border);
        if !is_default_border_color(&borders.left.color) {
            format = format.set_border_left_color(color_to_xlsx(&borders.left.color));
        }
    }

    // Diagonal borders
    let has_diag_down = borders.diagonal_down.style != BorderLineStyle::None && borders.diagonal_down.width > 0;
    let has_diag_up = borders.diagonal_up.style != BorderLineStyle::None && borders.diagonal_up.width > 0;

    if has_diag_down || has_diag_up {
        // Determine diagonal border type
        let diag_type = match (has_diag_down, has_diag_up) {
            (true, true) => FormatDiagonalBorder::BorderUpDown,
            (true, false) => FormatDiagonalBorder::BorderDown,
            (false, true) => FormatDiagonalBorder::BorderUp,
            (false, false) => FormatDiagonalBorder::None,
        };
        format = format.set_border_diagonal_type(diag_type);

        // Use the style from whichever diagonal is active (prefer down if both)
        let diag_ref = if has_diag_down { &borders.diagonal_down } else { &borders.diagonal_up };
        if let Some(xlsx_border) = border_style_to_format_border(diag_ref) {
            format = format.set_border_diagonal(xlsx_border);
        }
        if !is_default_border_color(&diag_ref.color) {
            format = format.set_border_diagonal_color(color_to_xlsx(&diag_ref.color));
        }
    }

    format
}

/// Convert a Calcula BorderStyle to a rust_xlsxwriter FormatBorder.
/// Returns None if no border (width == 0 or style == None).
fn border_style_to_format_border(border: &BorderStyle) -> Option<FormatBorder> {
    if border.width == 0 || border.style == BorderLineStyle::None {
        return None;
    }

    Some(match border.style {
        BorderLineStyle::None => return None,
        BorderLineStyle::Solid => {
            match border.width {
                1 => FormatBorder::Thin,
                2 => FormatBorder::Medium,
                _ => FormatBorder::Thick, // 3+
            }
        }
        BorderLineStyle::Dashed => FormatBorder::Dashed,
        BorderLineStyle::Dotted => FormatBorder::Dotted,
        BorderLineStyle::Double => FormatBorder::Double,
    })
}

/// Check if a border color is the default (black).
fn is_default_border_color(color: &engine::theme::ThemeColor) -> bool {
    match color {
        engine::theme::ThemeColor::Theme { slot: engine::theme::ThemeColorSlot::Dark1, tint } if tint.0 == 0 => true,
        engine::theme::ThemeColor::Absolute(c) => c.r == 0 && c.g == 0 && c.b == 0,
        _ => false,
    }
}

fn convert_number_format(format: &NumberFormat) -> String {
    match format {
        NumberFormat::General => String::new(),
        NumberFormat::Number { decimal_places, use_thousands_separator } => {
            let decimal_part = if *decimal_places > 0 {
                format!(".{}", "0".repeat(*decimal_places as usize))
            } else {
                String::new()
            };
            if *use_thousands_separator {
                format!("#,##0{}", decimal_part)
            } else {
                format!("0{}", decimal_part)
            }
        }
        NumberFormat::Currency { decimal_places, symbol, symbol_position: _, negative_style } => {
            let decimal_part = if *decimal_places > 0 {
                format!(".{}", "0".repeat(*decimal_places as usize))
            } else {
                String::new()
            };
            let positive = format!("{}#,##0{}", symbol, decimal_part);
            // ONE SECTION IS THE DEFAULT, and it is not an omission: Excel's
            // first "Negative numbers:" entry IS a single-section code, which
            // renders a negative with a leading minus. The other three entries
            // are codes with a negative section, and writing them is what makes
            // the round trip honest -- this writer emitted the bare code for
            // every currency cell while the app painted parentheses, so a
            // workbook changed its own appearance on the way to Excel.
            match negative_style {
                engine::style::NegativeStyle::Minus => positive,
                engine::style::NegativeStyle::Red => format!("{p};[Red]{p}", p = positive),
                engine::style::NegativeStyle::Parentheses => {
                    format!("{p};({p})", p = positive)
                }
                engine::style::NegativeStyle::RedParentheses => {
                    format!("{p};[Red]({p})", p = positive)
                }
            }
        }
        NumberFormat::Accounting { decimal_places, symbol, symbol_position, negative_style } => {
            accounting_format_code(*decimal_places, symbol, *symbol_position, *negative_style)
        }
        NumberFormat::Fraction { denominator, max_digits } => {
            let num_placeholders = "?".repeat(*max_digits as usize);
            match denominator {
                Some(d) => format!("# {}/{}", num_placeholders, d),
                None => {
                    let den_placeholders = "?".repeat(*max_digits as usize);
                    format!("# {}/{}", num_placeholders, den_placeholders)
                }
            }
        }
        NumberFormat::Percentage { decimal_places } => {
            let decimal_part = if *decimal_places > 0 {
                format!(".{}", "0".repeat(*decimal_places as usize))
            } else {
                String::new()
            };
            format!("0{}%", decimal_part)
        }
        NumberFormat::Scientific { decimal_places } => {
            let decimal_part = if *decimal_places > 0 {
                format!(".{}", "0".repeat(*decimal_places as usize))
            } else {
                String::new()
            };
            format!("0{}E+00", decimal_part)
        }
        NumberFormat::Date { format: fmt } => fmt.clone(),
        NumberFormat::Time { format: fmt } => fmt.clone(),
        NumberFormat::Custom { format: fmt } => fmt.clone(),
    }
}

/// The Excel code for a typed Accounting format, in the shape Excel itself
/// writes for that region's pattern.
///
/// - PARENTHESES (en-US): `_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)`
///   -- the `_(`/`_)` pads reserve the width of the brackets.
/// - MINUS (everywhere else): `_-"£"* #,##0.00_-;-"£"* #,##0.00_-;_-"£"* "-"??_-;_-@_-`
///   -- the minus sits BEFORE the fill, at the cell's left edge, which is what
///   Excel's sv-SE Accounting button writes (live probe 2026-10-04). This
///   writer used to emit the parenthesised code for every accounting cell, so
///   a Swedish ledger changed its negatives on the way to Excel.
///
/// An EMPTY symbol (Comma Style) writes NO quoted literal at all -- `""` is
/// legal but is not what Excel writes, and Excel's own Comma code is
/// `_-* #,##0.00_-;-* #,##0.00_-;...`. A suffix symbol is written with its
/// separating space inside the quotes (`" kr"`). The two `[Red]` entries put
/// the colour at the head of the negative section. Read back by
/// `xlsx_style_reader::parse_accounting_code`; the pair is pinned by
/// `every_accounting_shape_round_trips_through_the_reader`.
fn accounting_format_code(
    decimal_places: u8,
    symbol: &str,
    symbol_position: engine::style::CurrencyPosition,
    negative_style: engine::style::NegativeStyle,
) -> String {
    use engine::style::{CurrencyPosition, NegativeStyle};
    let decimal_part = if decimal_places > 0 {
        format!(".{}", "0".repeat(decimal_places as usize))
    } else {
        String::new()
    };
    let num = format!("#,##0{}", decimal_part);
    // Excel's zero section: a dash and one `?` (a digit-width space) per
    // decimal -- the same padding the renderer draws (`format_accounting_parts`).
    let dash = format!("\"-\"{}", "?".repeat(decimal_places as usize));
    let (prefix, suffix) = match (symbol.is_empty(), symbol_position) {
        (true, _) => (String::new(), String::new()),
        (false, CurrencyPosition::Before) => (format!("\"{}\"", symbol), String::new()),
        (false, CurrencyPosition::After) => (String::new(), format!("\" {}\"", symbol)),
    };
    let red = if negative_style.is_red() { "[Red]" } else { "" };
    if negative_style.uses_parentheses() {
        format!(
            "_({prefix}* {num}{suffix}_);{red}_({prefix}* ({num}){suffix};_({prefix}* {dash}{suffix}_);_(@_)"
        )
    } else {
        // `Red` carries no sign (Excel's red entry); `Minus` leads with one.
        let sign = if negative_style == NegativeStyle::Red { "_-" } else { "-" };
        format!(
            "_-{prefix}* {num}{suffix}_-;{red}{sign}{prefix}* {num}{suffix}_-;_-{prefix}* {dash}{suffix}_-;_-@_-"
        )
    }
}

fn color_to_xlsx(color: &engine::theme::ThemeColor) -> rust_xlsxwriter::Color {
    // Resolve theme colors using Office theme for XLSX export
    let theme = engine::theme::ThemeDefinition::office();
    let resolved = theme.resolve_color(color);
    rust_xlsxwriter::Color::RGB(
        ((resolved.r as u32) << 16) | ((resolved.g as u32) << 8) | (resolved.b as u32)
    )
}

fn is_default_color(color: &engine::theme::ThemeColor) -> bool {
    match color {
        engine::theme::ThemeColor::Theme { slot: engine::theme::ThemeColorSlot::Dark1, tint } if tint.0 == 0 => true,
        engine::theme::ThemeColor::Absolute(c) => c.r == 0 && c.g == 0 && c.b == 0 && c.a == 255,
        _ => false,
    }
}

fn is_default_background(color: &engine::theme::ThemeColor) -> bool {
    match color {
        engine::theme::ThemeColor::Theme { slot: engine::theme::ThemeColorSlot::Light1, tint } if tint.0 == 0 => true,
        engine::theme::ThemeColor::Absolute(c) => c.r == 255 && c.g == 255 && c.b == 255 && c.a == 255,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SavedCell, SavedCellValue, Sheet};

    /// EXCEL PARITY, xlsx FIDELITY: a default-aligned cell exports with NO
    /// `vertical` attribute at all, and an explicitly-middle one exports as
    /// `vertical="center"`.
    ///
    /// This is the export-side half of the Middle -> Bottom default change and
    /// it is the half that could have silently gone wrong in either direction:
    ///
    ///   - Before the change every default cell carried `VerticalAlign::Middle`,
    ///     so any cell that got a format at all wrote `vertical="center"` --
    ///     a spurious explicit alignment in the exported file, and a round trip
    ///     through Excel that was NOT idempotent (Excel writes nothing there).
    ///   - After the change a naive writer could emit `vertical="bottom"` on
    ///     every cell instead, which is harmless to Excel but is the same
    ///     noise with a different spelling.
    ///
    /// `rust_xlsxwriter` gets this right on its own (`Format::has_alignment`
    /// treats `FormatAlign::Bottom` as the Excel default and omits the
    /// `<alignment>` element), so the correct behaviour follows from the
    /// default move -- but "follows from a dependency's internals" is exactly
    /// the kind of claim that needs bytes behind it, so the bytes are read.
    #[test]
    fn a_default_aligned_cell_exports_with_no_vertical_attribute_at_all() {
        use engine::style::VerticalAlign;
        use std::io::Read;

        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        let mut sheet = Sheet::new("Align".to_string());
        // Index 0 is the document default; index 1 is an EXPLICIT middle.
        sheet.styles = vec![
            CellStyle::new(),
            CellStyle::new().with_vertical_align(VerticalAlign::Middle),
        ];
        sheet.cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Text("default".to_string()),
                formula: None,
                style_index: 0,
                rich_text: None,
                spill: None,
            },
        );
        sheet.cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Text("middle".to_string()),
                formula: None,
                style_index: 1,
                rich_text: None,
                spill: None,
            },
        );
        workbook.sheets.push(sheet);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("align.xlsx");
        save_xlsx(&workbook, &path).unwrap();

        let file = std::fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut styles_xml = String::new();
        zip.by_name("xl/styles.xml")
            .unwrap()
            .read_to_string(&mut styles_xml)
            .unwrap();

        assert!(
            !styles_xml.contains("vertical=\"bottom\""),
            "the document default must be expressed by OMITTING the attribute, \
             the way Excel does; got: {styles_xml}"
        );
        assert_eq!(
            styles_xml.matches("vertical=\"center\"").count(),
            1,
            "exactly one xf -- the EXPLICITLY middle cell -- may carry a \
             vertical alignment; got: {styles_xml}"
        );

        // And the round trip agrees with the bytes.
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let s = &loaded.sheets[0];
        let a1 = &s.styles[s.cells[&(0, 0)].style_index];
        let a2 = &s.styles[s.cells[&(1, 0)].style_index];
        assert_eq!(
            a1.vertical_align,
            VerticalAlign::Bottom,
            "an absent vertical attribute must read back as Excel's default, Bottom"
        );
        assert_eq!(
            a2.vertical_align,
            VerticalAlign::Middle,
            "an explicitly-middle cell must survive the xlsx round trip"
        );
    }

    /// Hidden rows and columns must survive an xlsx export/import.
    ///
    /// This used to be a second copy of the .cala data-loss bug: the writer
    /// only emitted the DERIVED filter/outline cache (so a hand-hidden row was
    /// exported visible), and the reader dropped what it parsed into the same
    /// derived cache, which the app never reads back (so an Excel file with
    /// hidden rows imported with every row visible).
    #[test]
    fn test_hidden_rows_and_cols_survive_the_xlsx_roundtrip() {
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        let mut sheet = Sheet::new("Data".to_string());
        // Some content so the sheet has a used range covering the hidden rows.
        for r in 0..12u32 {
            sheet.cells.insert(
                (r, 0),
                SavedCell {
                    value: SavedCellValue::Number(r as f64),
                    formula: None,
                    style_index: 0,
                    rich_text: None,
                    spill: None,
                },
            );
            sheet.cells.insert(
                (r, 3),
                SavedCell {
                    value: SavedCellValue::Text(format!("row{r}")),
                    formula: None,
                    style_index: 0,
                    rich_text: None,
                    spill: None,
                },
            );
        }
        // A filter hid row 2 (derived cache); the user hid rows 5 and 9 and
        // column 1 by hand.
        sheet.hidden_rows = [2u32].into_iter().collect();
        sheet.user_hidden_rows = [5u32, 9].into_iter().collect();
        sheet.user_hidden_cols = [1u32].into_iter().collect();
        workbook.sheets.push(sheet);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hidden.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();

        let s = &loaded.sheets[0];
        // Excel has one hidden bit, so BOTH authorities come back as the user
        // set (the only authority an import can honestly claim).
        let mut rows: Vec<u32> = s.user_hidden_rows.iter().copied().collect();
        rows.sort_unstable();
        assert_eq!(rows, vec![2, 5, 9], "every hidden row must survive export+import");
        let cols: Vec<u32> = s.user_hidden_cols.iter().copied().collect();
        assert_eq!(cols, vec![1], "hidden column must survive export+import");
    }

    /// BUG-0352/0353: each sheet's STANDARD row height and column width survive
    /// an xlsx export/import, per sheet, and an explicit size that differs from
    /// the standard keeps its own value. The row standard is Excel's own
    /// `<sheetFormatPr defaultRowHeight customHeight="1">` (probed live).
    #[test]
    fn per_sheet_standard_sizes_survive_the_xlsx_roundtrip() {
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        let mut sized = Sheet::new("Sized".to_string());
        sized.default_row_height = Some(40.0);
        sized.default_column_width = Some(145.0);
        sized.row_heights.insert(4, 20.0);
        sized.column_widths.insert(2, 68.0);
        workbook.sheets.push(sized);
        workbook.sheets.push(Sheet::new("Plain".to_string()));

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("standard.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();

        let s = &loaded.sheets[0];
        assert_eq!(s.default_row_height, Some(40.0), "the sheet's standard row height");
        assert_eq!(s.default_column_width, Some(145.0), "the sheet's standard column width");
        assert_eq!(s.row_heights.get(&4), Some(&20.0), "an explicit standard-looking row keeps its height");
        assert_eq!(s.column_widths.get(&2), Some(&68.0));
        assert_eq!(s.column_widths.len(), 1, "the standard is not 16,384 explicit widths");
        let plain = &loaded.sheets[1];
        assert_eq!(plain.default_row_height, None, "the other sheet keeps the application standard");
        assert_eq!(plain.default_column_width, None);
    }

    /// A DYNAMIC ARRAY must export as one array formula, not as a formula plus
    /// the literals it produced.
    ///
    /// THE DEFECT THIS CLOSES was a corruption, not a nicety. The writer had no
    /// notion of a spill, so `=SEQUENCE(4)` in A1 exported as an ordinary
    /// formula in A1 and three literal numbers in A2:A4. Excel recalculates on
    /// open, the array tries to spill onto the very literals this writer put
    /// there, and it is blocked by its own output: the exported file shows
    /// `#SPILL!` where the workbook showed 1 2 3 4.
    ///
    /// The bytes are checked directly, because that is the whole claim.
    /// ECMA-376 Part 1 18.3.1.40: `t="array"` with `ref` = the range the
    /// formula applies to; `cm="1"` marks it DYNAMIC rather than a legacy CSE
    /// array.
    #[test]
    fn a_dynamic_array_exports_as_one_array_formula_not_as_literals() {
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        let mut sheet = Sheet::new("Data".to_string());
        sheet.cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Number(1.0),
                formula: Some("SEQUENCE(4)".to_string()),
                style_index: 0,
                rich_text: None,
                spill: Some((3, 0)),
            },
        );
        for r in 1..4u32 {
            sheet.cells.insert(
                (r, 0),
                SavedCell {
                    value: SavedCellValue::Number(f64::from(r + 1)),
                    formula: None,
                    style_index: 0,
                    rich_text: None,
                    spill: None,
                },
            );
        }
        // A neighbour that is NOT part of the array must still be written.
        sheet.cells.insert(
            (0, 1),
            SavedCell {
                value: SavedCellValue::Text("keep me".to_string()),
                formula: None,
                style_index: 0,
                rich_text: None,
                spill: None,
            },
        );
        workbook.sheets.push(sheet);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("array.xlsx");
        save_xlsx(&workbook, &path).unwrap();

        let file = std::fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut xml = String::new();
        {
            use std::io::Read;
            zip.by_name("xl/worksheets/sheet1.xml")
                .unwrap()
                .read_to_string(&mut xml)
                .unwrap();
        }

        // THE WHOLE CLAIM, and it is Excel's own shape: formula + extent on the
        // origin, value-only cells under it. `_xlfn.` is rust_xlsxwriter's
        // required prefix for a post-2007 function, not a Calcula artefact.
        assert!(
            xml.contains(r#"<c r="A1" cm="1"><f t="array" ref="A1:A4">_xlfn.SEQUENCE(4)</f><v>1</v></c>"#),
            "the origin must carry the array formula, its EXTENT (`ref`), the              DYNAMIC marker (`cm=\"1\"`) and its real cached value. Without              `ref`, Excel recalculates the origin on open, finds A2:A4 occupied              by the literals this writer emitted, and shows #SPILL! where the              workbook showed 1 2 3 4. sheet1.xml was:
{}",
            xml
        );
        for covered in [r#"<c r="A2"><v>2</v></c>"#, r#"<c r="A3"><v>3</v></c>"#, r#"<c r="A4"><v>4</v></c>"#] {
            assert!(
                xml.contains(covered),
                "{} must be exported as a VALUE-ONLY cell inside the array's                  `ref` — carrying the real cached value, not the library's `0`                  placeholder, and carrying no formula of its own. sheet1.xml                  was:
{}",
                covered,
                xml
            );
        }
        assert!(
            xml.contains(r#"<c r="B1""#),
            "a cell outside the array must still be exported"
        );
    }

    /// ...and a cell that is GENUINELY in the way is still written, so Excel's
    /// `#SPILL!` remains available for the case it is the right answer -- with
    /// the origin written as Excel saves a BLOCKED array. The array's `ref`
    /// used to cover the blocker, and live Excel refused the whole workbook
    /// when a formula cell sat inside an array formula's `ref` (xlsx5, round 17
    /// [LIVE]). [LIVE] Excel 16, round 18 (calcref/probe-spill.ps1): a blocked
    /// `={1,2,3}` is saved `<c r="A1" t="e" cm="1" vm="1"><f t="array" aca="1"
    /// ref="A1" ca="1">{1,2,3}</f><v>#VALUE!</v></c>` -- `ref` the origin
    /// alone, the #SPILL! rich value cached -- beside the blocker; and this
    /// export (`CALCULA_XLSX_PROBE_DIR`) opened, A1 showing #SPILL!.
    ///
    /// The re-pin is deliberate (calcref): the test used to check only that the
    /// blocker's formula was written, which is the file Excel refused.
    ///
    /// SABOTAGE: treat no origin as blocked -- fails at "BLOCKED REF".
    #[test]
    fn a_real_blocker_inside_a_footprint_is_still_exported() {
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        let mut sheet = Sheet::new("Data".to_string());
        sheet.cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Number(1.0),
                formula: Some("SEQUENCE(3)".to_string()),
                style_index: 0,
                rich_text: None,
                spill: Some((2, 0)),
            },
        );
        // A2 carries its own FORMULA, so it is not one of the array's cells
        // whatever the extent says.
        sheet.cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Number(99.0),
                formula: Some("11*9".to_string()),
                style_index: 0,
                rich_text: None,
                spill: None,
            },
        );
        // A3: the array's own (stale) output, a value-only cell under it.
        sheet.cells.insert(
            (2, 0),
            SavedCell {
                value: SavedCellValue::Number(3.0),
                formula: None,
                style_index: 0,
                rich_text: None,
                spill: None,
            },
        );
        // A second, UNblocked array beside it keeps its full extent.
        sheet.cells.insert(
            (0, 2),
            SavedCell {
                value: SavedCellValue::Number(1.0),
                formula: Some("SEQUENCE(2)".to_string()),
                style_index: 0,
                rich_text: None,
                spill: Some((1, 2)),
            },
        );
        sheet.cells.insert(
            (1, 2),
            SavedCell {
                value: SavedCellValue::Number(2.0),
                formula: None,
                style_index: 0,
                rich_text: None,
                spill: None,
            },
        );
        workbook.sheets.push(sheet);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blocked.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        keep_for_live_probe(&path);

        let xml = sheet_part_of(&path, "xl/worksheets/sheet1.xml");
        assert!(
            xml.contains("11*9"),
            "a cell with its own formula inside the footprint must not be swallowed by the array; sheet1.xml was:\n{}",
            xml
        );
        let origin = xml
            .split("<c ")
            .find(|c| c.starts_with(r#"r="A1""#))
            .unwrap_or_else(|| panic!("no A1 in\n{xml}"));
        assert!(
            origin.contains(r#"<f t="array" ref="A1">"#) && !xml.contains(r#"ref="A1:A3""#),
            "BLOCKED REF: a formula cell inside the array's ref makes live Excel refuse the file; \
             Excel saves a blocked origin with ref = the origin alone. A1 was: {origin}"
        );
        assert!(
            origin.contains(r#"t="e""#) && origin.contains("<v>#VALUE!</v>") && origin.contains("vm="),
            "a blocked origin caches #SPILL! as Excel does (#VALUE! plus the rich value): {origin}"
        );
        assert!(
            !xml.contains(r#"<c r="A3"><v>3</v></c>"#),
            "the blocked array's own output was written as a constant, which would block it again: \n{xml}"
        );
        assert!(
            xml.contains(r#"<f t="array" ref="C1:C2">"#) && xml.contains(r#"<c r="C2"><v>2</v></c>"#),
            "an unblocked array keeps its extent and its output: \n{xml}"
        );

        let loaded = crate::xlsx_reader::load_xlsx(&path).expect("the export re-imports");
        let data = &loaded.sheets[0];
        assert_eq!(
            data.cells.get(&(0, 0)).map(|c| format!("{:?}", c.value)),
            Some(format!("{:?}", SavedCellValue::Error("#SPILL!".to_string()))),
            "the blocked origin reads back as #SPILL!"
        );
        assert_eq!(data.cells.get(&(1, 0)).and_then(|c| c.formula.clone()).as_deref().map(|f| f.trim_start_matches('=')), Some("11*9"));
    }

    // ========================================================================
    // FORMULA / ERROR ROUND-TRIP THROUGH A REAL .xlsx FILE
    // ========================================================================
    //
    // Between them the xlsx reader and writer had exactly ONE test before these
    // (hidden rows/cols, above). No formula round-trip, no error round-trip.
    // That absence is precisely why three wrong-answer defects lived here:
    // every static error imported as #VALUE!, every post-2007 Excel function
    // imported as #NAME?, and a formula whose cell carried no cached value was
    // dropped outright. Each is pinned below on a REAL file written by the
    // writer and read by the reader.

    fn one_sheet(cells: Vec<((u32, u32), SavedCell)>) -> Workbook {
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        let mut sheet = Sheet::new("Data".to_string());
        for (rc, cell) in cells {
            sheet.cells.insert(rc, cell);
        }
        workbook.sheets.push(sheet);
        workbook
    }

    fn formula_cell(f: &str) -> SavedCell {
        SavedCell {
            value: SavedCellValue::Number(0.0),
            formula: Some(f.to_string()),
            style_index: 0,
            rich_text: None,
            spill: None,
        }
    }

    /// A GROUPED expression and a DOTTED function name must survive a real
    /// .xlsx round-trip.
    ///
    /// This is the end-to-end check on the renderer work: `=(A1+B1)*C1` has no
    /// parenthesis node in the AST, so only the renderer's precedence guard puts
    /// the brackets back, and `STDEV.S` is one of the 248 built-ins that a
    /// Debug-format catch-all used to print as `StdevS`. Both now go out through
    /// the ONE canonical renderer -- and .xlsx is the format other applications
    /// read, so a defect here is a defect in someone else's spreadsheet.
    #[test]
    fn a_grouped_expression_and_a_dotted_function_survive_a_real_xlsx_file() {
        let workbook = one_sheet(vec![
            ((0, 0), formula_cell("=(A1+B1)*C1")),
            ((1, 0), formula_cell("=A1+B1*C1")),
            ((2, 0), formula_cell("=STDEV.S(D1:D9)")),
            ((3, 0), formula_cell("=NORM.DIST(1,0,1,TRUE)")),
            ((4, 0), formula_cell("=(A1&B1)&C1")),
            ((5, 0), formula_cell("=-(A1+B1)")),
            ((6, 0), formula_cell("=A1^(B1^C1)")),
            ((7, 0), formula_cell("=(A1^B1)^C1")),
        ]);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("formulas.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let s = &loaded.sheets[0];

        for (row, expected) in [
            (0u32, "=(A1+B1)*C1"),
            (1, "=A1+B1*C1"),
            (2, "=STDEV.S(D1:D9)"),
            (3, "=NORM.DIST(1,0,1,TRUE)"),
            (4, "=(A1&B1)&C1"),
            (5, "=-(A1+B1)"),
            (6, "=A1^(B1^C1)"),
            (7, "=(A1^B1)^C1"),
        ] {
            let got = s
                .cells
                .get(&(row, 0))
                .unwrap_or_else(|| panic!("cell at row {} was dropped by the xlsx round-trip", row))
                .formula
                .as_deref()
                .unwrap_or_else(|| panic!("cell at row {} lost its formula", row));
            assert_eq!(
                got, expected,
                "formula at row {} changed meaning across a real .xlsx file",
                row
            );
        }
    }

    /// `_xlfn.`-prefixed "future functions" must import as the plain function.
    ///
    /// Excel stores every function added after 2007 with a namespace prefix
    /// (`_xlfn.STDEV.S`, `_xlfn._xlws.FILTER`, `_xlpm.` for LAMBDA parameters).
    /// Calcula IMPLEMENTS all of them, but the lexer accepts `_` and `.` inside
    /// an identifier, so the prefixed name lexed as one unknown identifier and
    /// every modern Excel workbook opened with `#NAME?` down the sheet.
    ///
    /// The last case is the one that makes the strip non-trivial: a prefix
    /// inside a STRING LITERAL is the user's data and must not be touched.
    #[test]
    fn future_function_prefixes_are_stripped_on_import_but_not_inside_strings() {
        use crate::xlsx_reader::strip_future_function_prefixes;

        for (stored, expected) in [
            ("_xlfn.STDEV.S(A1:A9)", "STDEV.S(A1:A9)"),
            ("_xlfn.XLOOKUP(A1,B:B,C:C)", "XLOOKUP(A1,B:B,C:C)"),
            ("_xlfn._xlws.FILTER(A1:A9,B1:B9)", "FILTER(A1:A9,B1:B9)"),
            ("_xlfn._xlws.SORT(A1:A9)", "SORT(A1:A9)"),
            ("_xlfn.LET(_xlpm.x,1,_xlpm.x+1)", "LET(x,1,x+1)"),
            (
                "_xlfn.LAMBDA(_xlpm.a,_xlpm.b,_xlpm.a+_xlpm.b)",
                "LAMBDA(a,b,a+b)",
            ),
            ("SUM(A1:A9)", "SUM(A1:A9)"),
            // A string literal that happens to contain the prefix is DATA.
            (
                "CONCAT(\"_xlfn.NOT_A_FUNC\",A1)",
                "CONCAT(\"_xlfn.NOT_A_FUNC\",A1)",
            ),
            // Doubled quotes keep us inside the literal.
            (
                "CONCAT(\"say \"\"_xlfn.X\"\" now\",A1)",
                "CONCAT(\"say \"\"_xlfn.X\"\" now\",A1)",
            ),
            // Not at an identifier boundary: this is somebody's defined name.
            ("MY_xlfn.THING+1", "MY_xlfn.THING+1"),
            // NON-ASCII. The scan walked BYTES and pushed each one as a
            // Latin-1 char, so `"åäö"` came back as `"Ã¥Ã¤Ã¶"`, and a
            // non-ASCII char OUTSIDE a literal panicked on a slice inside the
            // character. sv-SE is the default locale: Swedish sheet names
            // are ordinary, not exotic.
            ("LEN(\"åäö\")", "LEN(\"åäö\")"),
            ("'Försäljning'!A1+1", "'Försäljning'!A1+1"),
            (
                "_xlfn.TEXTBEFORE(\"Åke Öberg\",\" \")",
                "TEXTBEFORE(\"Åke Öberg\",\" \")",
            ),
            ("CONCAT(\"日本\",\"😀\")", "CONCAT(\"日本\",\"😀\")"),
            ("A1&\"x\"&Ä1", "A1&\"x\"&Ä1"),
            // A non-ASCII LETTER is part of a name too: no boundary after Ö.
            ("Ö_xlfn.X+1", "Ö_xlfn.X+1"),
            // A prefix AFTER non-ASCII text is still stripped.
            (
                "'Ö'!A1+_xlfn.TEXTBEFORE(A1,\"-\")",
                "'Ö'!A1+TEXTBEFORE(A1,\"-\")",
            ),
            ("LEN(\"åäö\")+_xlfn.STDEV.S(A1:A9)", "LEN(\"åäö\")+STDEV.S(A1:A9)"),
            // A quoted sheet name is OPAQUE: a sheet may be called
            // `_xlfn.Data`, and Excel allows `"` in a sheet name, which must
            // not open a string literal (`''` is the escaped apostrophe).
            ("'_xlfn.Data'!A1+1", "'_xlfn.Data'!A1+1"),
            (
                "'Say \"hi'!A1+_xlfn.STDEV.S(A1:A9)",
                "'Say \"hi'!A1+STDEV.S(A1:A9)",
            ),
            (
                "'Bob''s _xlfn.X'!A1+_xlfn.XOR(TRUE)",
                "'Bob''s _xlfn.X'!A1+XOR(TRUE)",
            ),
            // Inside a structured reference `'` is an ESCAPE, not a quote,
            // and a column may legitimately be named with the prefix.
            (
                "SUM(T[Price'[USD']])+_xlfn.XOR(TRUE)",
                "SUM(T[Price'[USD']])+XOR(TRUE)",
            ),
            ("SUM(T[_xlfn.Col])", "SUM(T[_xlfn.Col])"),
            ("SUM(T[It''s])+_xlfn.XOR(1)", "SUM(T[It''s])+XOR(1)"),
        ] {
            assert_eq!(
                strip_future_function_prefixes(stored),
                expected,
                "stripping {:?}",
                stored
            );
        }
    }

    /// A real .xlsx with a SWEDISH sheet name, non-ASCII string literals and
    /// an Excel-shaped `_xlfn.LAMBDA` defined name must open, unchanged.
    ///
    /// `='Försäljning'!B1+1` PANICKED the importer (a byte slice inside `ö`),
    /// so any workbook that referenced a Swedish sheet could not be opened at
    /// all; `"åäö"` came back as mojibake; and a defined name kept its
    /// `_xlfn.`/`_xlpm.` storage prefixes, so every imported named LAMBDA was
    /// `#NAME?`. This goes through the public `load_xlsx`, the path `open_file`
    /// takes, so the panic itself is pinned and not only the helper.
    #[test]
    fn a_non_ascii_sheet_name_and_literal_and_a_prefixed_defined_name_import_intact() {
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("svenska.xlsx");
        {
            let mut zw = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            zw.start_file("[Content_Types].xml", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#).unwrap();
            zw.start_file("_rels/.rels", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#).unwrap();
            zw.start_file("xl/workbook.xml", o).unwrap();
            zw.write_all(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Försäljning" sheetId="1" r:id="rId1"/></sheets>
<definedNames><definedName name="PADLEFT">_xlfn.LAMBDA(_xlpm.t,_xlpm.n,_xlpm.c,RIGHT(REPT(_xlpm.c,_xlpm.n)&amp;_xlpm.t,_xlpm.n))</definedName><definedName name="Kvot">'Försäljning'!$B$1/2</definedName></definedNames>
</workbook>"#.as_bytes()).unwrap();
            zw.start_file("xl/_rels/workbook.xml.rels", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#).unwrap();
            zw.start_file("xl/worksheets/sheet1.xml", o).unwrap();
            zw.write_all(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">
<c r="A1"><f>'Försäljning'!B1+1</f><v>42</v></c>
<c r="B1"><v>41</v></c>
<c r="C1" t="str"><f>LEN("åäö")</f><v>3</v></c>
<c r="D1" t="str"><f>_xlfn.TEXTBEFORE("Åke Öberg"," ")</f><v>Åke</v></c>
<c r="E1" t="str"><f>CONCAT("日本","😀")</f><v>日本😀</v></c>
</row></sheetData></worksheet>"#.as_bytes()).unwrap();
            zw.finish().unwrap();
        }

        let loaded = crate::xlsx_reader::load_xlsx(&path)
            .expect("an .xlsx with a Swedish sheet name must open");
        let s = &loaded.sheets[0];
        assert_eq!(s.name, "Försäljning");
        for (col, expected) in [
            (0u32, "='Försäljning'!B1+1"),
            (2, "=LEN(\"åäö\")"),
            (3, "=TEXTBEFORE(\"Åke Öberg\",\" \")"),
            (4, "=CONCAT(\"日本\",\"😀\")"),
        ] {
            let got = s
                .cells
                .get(&(0, col))
                .unwrap_or_else(|| panic!("cell at column {} was dropped", col))
                .formula
                .as_deref()
                .unwrap_or_else(|| panic!("cell at column {} lost its formula", col));
            assert_eq!(got, expected, "formula at column {} changed on import", col);
        }

        let name = |n: &str| {
            loaded
                .named_ranges
                .iter()
                .find(|r| r.name == n)
                .unwrap_or_else(|| panic!("defined name {} was not imported", n))
                .refers_to
                .clone()
        };
        assert_eq!(
            name("PADLEFT"),
            "=LAMBDA(t,n,c,RIGHT(REPT(c,n)&t,n))",
            "a defined name must lose its _xlfn./_xlpm. storage prefixes like a cell formula"
        );
        assert_eq!(name("Kvot"), "='Försäljning'!$B$1/2");
    }

    /// Every Excel error literal must survive an .xlsx import as ITSELF.
    ///
    /// The reader wrote `format!("{:?}", e)` -- calamine's DEBUG names, `Div0`
    /// / `NA` / `Ref` / `Name` / `Null` / `Num` -- and nothing reads those back,
    /// so `CellError::from_literal` fell through to `Value` and EVERY imported
    /// error became `#VALUE!`. `ERROR.TYPE` reported the wrong number and
    /// `IFERROR` took a branch on an error the file never contained.
    #[test]
    fn every_excel_error_literal_survives_an_xlsx_import() {
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("errors.xlsx");
        {
            let mut zw = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            zw.start_file("[Content_Types].xml", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#).unwrap();
            zw.start_file("_rels/.rels", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#).unwrap();
            zw.start_file("xl/workbook.xml", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#).unwrap();
            zw.start_file("xl/_rels/workbook.xml.rels", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#).unwrap();
            zw.start_file("xl/worksheets/sheet1.xml", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">
<c r="A1" t="e"><v>#DIV/0!</v></c>
<c r="B1" t="e"><v>#N/A</v></c>
<c r="C1" t="e"><v>#REF!</v></c>
<c r="D1" t="e"><v>#NAME?</v></c>
<c r="E1" t="e"><v>#NULL!</v></c>
<c r="F1" t="e"><v>#NUM!</v></c>
<c r="G1" t="e"><v>#VALUE!</v></c>
</row></sheetData></worksheet>"#).unwrap();
            zw.finish().unwrap();
        }

        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let s = &loaded.sheets[0];
        for (col, expected) in [
            (0u32, "#DIV/0!"),
            (1, "#N/A"),
            (2, "#REF!"),
            (3, "#NAME?"),
            (4, "#NULL!"),
            (5, "#NUM!"),
            (6, "#VALUE!"),
        ] {
            match &s.cells.get(&(0, col)).expect("error cell missing").value {
                SavedCellValue::Error(got) => assert_eq!(
                    got, expected,
                    "error cell at column {} imported as the wrong error",
                    col
                ),
                other => panic!("column {} imported as {:?}, not an error", col, other),
            }
        }

        // And each one must survive the trip into the engine's own type, which
        // is where the collapse to #VALUE! actually happened.
        for literal in ["#DIV/0!", "#N/A", "#REF!", "#NAME?", "#NULL!", "#NUM!", "#VALUE!"] {
            assert_eq!(
                engine::CellError::from_literal(literal).as_literal(),
                literal,
                "{} does not round-trip through CellError",
                literal
            );
        }
    }

    /// A formula cell with no cached `<v>` must keep its formula.
    ///
    /// The reader skipped "empty" cells BEFORE looking for a formula, so
    /// `<c r="A1"><f>A1*2</f></c>` -- what LibreOffice and several generators
    /// emit whenever the sheet recalculates on load -- was dropped whole.
    #[test]
    fn a_formula_with_no_cached_value_is_not_dropped_on_import() {
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("novalue.xlsx");
        {
            let mut zw = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            zw.start_file("[Content_Types].xml", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#).unwrap();
            zw.start_file("_rels/.rels", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#).unwrap();
            zw.start_file("xl/workbook.xml", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#).unwrap();
            zw.start_file("xl/_rels/workbook.xml.rels", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#).unwrap();
            zw.start_file("xl/worksheets/sheet1.xml", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">
<c r="A1"><v>5</v></c>
<c r="B1"><f>A1*2</f></c>
<c r="C1"><f>A1*3</f><v>15</v></c>
</row></sheetData></worksheet>"#).unwrap();
            zw.finish().unwrap();
        }

        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let s = &loaded.sheets[0];
        let b1 = s
            .cells
            .get(&(0, 1))
            .expect("the formula cell with no cached value was dropped entirely");
        assert_eq!(b1.formula.as_deref(), Some("=A1*2"));
        assert_eq!(s.cells.get(&(0, 2)).unwrap().formula.as_deref(), Some("=A1*3"));
    }

    /// An illegal sheet name must produce an ACTIONABLE refusal, not a raw
    /// library message, and it must name the sheet.
    ///
    /// The load path deliberately accepts names that Excel forbids (a legacy or
    /// imported workbook keeps whatever it had), so this is reachable on a real
    /// document -- and it used to abort the whole "Save As .xlsx" with
    /// rust_xlsxwriter's own wording and no indication which sheet was at fault.
    #[test]
    fn an_illegal_sheet_name_refuses_the_xlsx_save_by_name() {
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        workbook.sheets.push(Sheet::new("Budget[2026]".to_string()));

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad-name.xlsx");
        let err = save_xlsx(&workbook, &path)
            .expect_err("a sheet name Excel forbids must not save silently");
        let msg = err.to_string();
        assert!(
            msg.contains("Budget[2026]"),
            "the refusal must name the offending sheet; got: {}",
            msg
        );
        assert!(
            msg.contains(".cala"),
            "the refusal must offer the lossless alternative; got: {}",
            msg
        );
    }

    // -----------------------------------------------------------------------
    // S10 — the 1904 date system
    // -----------------------------------------------------------------------

    /// Build a one-sheet .xlsx with the given `<workbookPr>` attributes and a
    /// styles part that assigns built-in number formats to columns A..E.
    ///
    /// Built-ins used, and why each one is in the fixture:
    ///   xf 1 -> numFmtId 14  (`mm-dd-yy`)      a DATE: must shift
    ///   xf 2 -> numFmtId 0   (`General`)       a plain number: must NOT shift
    ///   xf 3 -> numFmtId 20  (`HH:mm`)         a TIME
    ///   xf 4 -> numFmtId 46  (`[h]:mm:ss`)     ELAPSED time: a duration
    fn write_dated_xlsx(path: &std::path::Path, workbook_pr: &str) {
        use std::io::Write;
        let mut zw = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        zw.start_file("[Content_Types].xml", o).unwrap();
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#).unwrap();
        zw.start_file("_rels/.rels", o).unwrap();
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#).unwrap();
        zw.start_file("xl/workbook.xml", o).unwrap();
        zw.write_all(
            format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
{}<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
                workbook_pr
            )
            .as_bytes(),
        )
        .unwrap();
        zw.start_file("xl/_rels/workbook.xml.rels", o).unwrap();
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#).unwrap();
        zw.start_file("xl/styles.xml", o).unwrap();
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>
<xf numFmtId="20" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>
<xf numFmtId="46" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>"#).unwrap();
        zw.start_file("xl/worksheets/sheet1.xml", o).unwrap();
        // A1 = 1904-serial 0 (the 1904 epoch itself), date-formatted.
        // B1 = 1904-serial 36892 (2004-12-31), date-formatted.
        // C1 = 36892 as a PLAIN NUMBER -- the control.
        // D1 = 0.5, time-formatted: noon, identical in both systems.
        // E1 = 1.25, elapsed-time-formatted: thirty hours, a DURATION.
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">
<c r="A1" s="1"><v>0</v></c>
<c r="B1" s="1"><v>36892</v></c>
<c r="C1" s="2"><v>36892</v></c>
<c r="D1" s="3"><v>0.5</v></c>
<c r="E1" s="4"><v>1.25</v></c>
</row></sheetData></worksheet>"#).unwrap();
        zw.finish().unwrap();
    }

    fn number_at(sheet: &Sheet, row: u32, col: u32) -> f64 {
        match &sheet.cells.get(&(row, col)).expect("cell missing").value {
            SavedCellValue::Number(n) => *n,
            other => panic!("cell ({},{}) is {:?}, not a number", row, col, other),
        }
    }

    /// A Mac-authored workbook declares `date1904="1"`, and every date serial
    /// in it counts from 1904-01-01. This reader ignored the flag entirely, so
    /// every date came in FOUR YEARS AND A DAY early -- and silently, because
    /// 1462 days off is still a perfectly valid date.
    #[test]
    fn the_1904_date_system_is_honoured_on_import() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mac1904.xlsx");
        write_dated_xlsx(&path, r#"<workbookPr date1904="1"/>"#);

        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let s = &loaded.sheets[0];

        // The 1904 epoch itself. Serial 0 there is 1904-01-01, which is serial
        // 1462 in the 1900 system Calcula stores.
        assert_eq!(
            number_at(s, 0, 0),
            1462.0,
            "the 1904 epoch must land on 1904-01-01, not on 1900-01-00"
        );
        // A real date: 1904-serial 36892 is 2004-12-31.
        assert_eq!(number_at(s, 0, 1), 36892.0 + 1462.0);

        // THE CONTROL, and it is the reason the shift is format-driven rather
        // than blanket: the same number with a GENERAL format is not a date and
        // must come through untouched. A blanket +1462 would corrupt every
        // quantity, price and count in a Mac workbook.
        assert_eq!(
            number_at(s, 0, 2),
            36892.0,
            "a plain number must not be shifted by the date system"
        );

        // A bare time of day is the same number in both systems.
        assert_eq!(
            number_at(s, 0, 3),
            0.5,
            "0.5 is noon in both date systems -- shifting it invents a date"
        );

        // An ELAPSED-time format is a duration and has no epoch at all.
        assert_eq!(
            number_at(s, 0, 4),
            1.25,
            "[h]:mm:ss is thirty hours, not an instant in 1904"
        );
    }

    /// The default, and the half that must not regress: an ordinary 1900-system
    /// workbook -- with the attribute absent, or present and false -- is
    /// imported unchanged.
    #[test]
    fn a_1900_workbook_is_not_shifted() {
        let dir = tempfile::tempdir().unwrap();
        for (name, pr) in [
            ("absent.xlsx", ""),
            ("zero.xlsx", r#"<workbookPr date1904="0"/>"#),
            ("false.xlsx", r#"<workbookPr date1904="false"/>"#),
        ] {
            let path = dir.path().join(name);
            write_dated_xlsx(&path, pr);
            let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
            let s = &loaded.sheets[0];
            assert_eq!(number_at(s, 0, 0), 0.0, "{}", name);
            assert_eq!(number_at(s, 0, 1), 36892.0, "{}", name);
            assert_eq!(number_at(s, 0, 2), 36892.0, "{}", name);
        }
    }

    /// `date1904` is an OOXML boolean, so `"true"` means the same as `"1"`.
    /// LibreOffice writes the word; reading only `"1"` would take the 1900
    /// branch on every file it produces, which is the silent-wrong-answer shape
    /// this whole register keeps cataloguing.
    #[test]
    fn date1904_accepts_every_ooxml_boolean_spelling() {
        let dir = tempfile::tempdir().unwrap();
        for (name, pr) in [
            ("one.xlsx", r#"<workbookPr date1904="1"/>"#),
            ("true.xlsx", r#"<workbookPr date1904="true"/>"#),
            ("True.xlsx", r#"<workbookPr date1904="True"/>"#),
        ] {
            let path = dir.path().join(name);
            write_dated_xlsx(&path, pr);
            let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
            assert_eq!(
                number_at(&loaded.sheets[0], 0, 1),
                36892.0 + 1462.0,
                "{} was read as a 1900-system workbook",
                name
            );
        }
    }

    /// D9's THIRD ARGUMENT, made checkable (open-items 1.2).
    ///
    /// The decision not to offer the 1904 date system as a user setting rests
    /// partly on the claim that "a 1904 file is read correctly and written back
    /// as 1900 with the attribute omitted, and the only thing lost is the FLAG,
    /// which carries no user intent". That was prose. This asserts it.
    ///
    /// Two failure modes it catches, both silent: an export that re-emits
    /// `date1904` (the workbook would be read back and shifted a SECOND time
    /// by anything honouring it), and a normalisation applied twice or undone.
    /// A 1462-day error is still a perfectly valid date, which is why nothing
    /// on screen would say so.
    #[test]
    fn a_1904_workbook_is_exported_as_1900_with_no_date1904_attribute() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("mac1904.xlsx");
        write_dated_xlsx(&source, r#"<workbookPr date1904="1"/>"#);

        let loaded = crate::xlsx_reader::load_xlsx(&source).unwrap();
        let exported = dir.path().join("exported.xlsx");
        save_xlsx(&loaded, &exported).unwrap();

        // (i) The flag is not written. OOXML's default for an absent
        // `date1904` is false, i.e. the 1900 system Calcula actually stores.
        let file = std::fs::File::open(&exported).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut workbook_xml = String::new();
        {
            use std::io::Read;
            zip.by_name("xl/workbook.xml")
                .unwrap()
                .read_to_string(&mut workbook_xml)
                .unwrap();
        }
        assert!(
            !workbook_xml.contains("date1904"),
            "the export must not carry a date-system flag; xl/workbook.xml was:\n{}",
            workbook_xml
        );

        // (ii) The date was normalised ONCE. Not re-shifted, not shifted back.
        let round_tripped = crate::xlsx_reader::load_xlsx(&exported).unwrap();
        let s = &round_tripped.sheets[0];
        assert_eq!(
            number_at(s, 0, 1),
            36892.0 + 1462.0,
            "the date must survive the round trip on Calcula's 1900 epoch"
        );
        // (iii) ...and the plain number still never moved.
        assert_eq!(number_at(s, 0, 2), 36892.0);
    }

    /// `DATE_SYSTEM_OFFSET` is 1462 ONLY BECAUSE the engine's calendar
    /// deliberately reproduces Lotus 1-2-3's fictitious 1900-02-29
    /// (`is_leap_year_excel`, core/engine/src/date_serial.rs). The constant
    /// lives in this crate and the bug that produces it lives in another, so
    /// nothing today connects them: somebody "fixing" the phantom leap day
    /// would make this importer off by one, and every S10 test above would
    /// still pass because they hard-code 1462 too.
    #[test]
    fn the_date_system_offset_is_the_engine_calendars_1904_epoch() {
        assert_eq!(
            engine::date_serial::date_to_serial(1904, 1, 1),
            crate::xlsx_reader::DATE_SYSTEM_OFFSET,
            "the 1904 epoch as the ENGINE computes it must equal the offset the \
             importer adds -- 4x365 days, +1 because the 1900 system numbers its \
             epoch day 1 rather than 0, and +1 for the phantom 1900-02-29 that \
             the 1904 system never had"
        );
    }

    /// S8: the writer emitted document properties and the reader threw them
    /// away, so `save_xlsx` -> `load_xlsx` -- the app's own round trip through
    /// its own export -- lost the title, author, subject, description,
    /// keywords and category the user had typed. Nothing said so: the Document
    /// Properties dialog simply came back empty.
    #[test]
    fn document_properties_survive_the_xlsx_round_trip() {
        let mut workbook = Workbook::new();
        workbook.properties = crate::WorkbookProperties {
            title: "Quarterly Report".to_string(),
            author: "Daniel Sallander".to_string(),
            subject: "Revenue".to_string(),
            description: "Figures for Q3, unaudited".to_string(),
            keywords: "revenue,q3,draft".to_string(),
            category: "Finance".to_string(),
            created: String::new(),
            last_modified: String::new(),
        };

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("props.xlsx");
        save_xlsx(&workbook, &path).unwrap();

        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        assert_eq!(loaded.properties.title, "Quarterly Report");
        assert_eq!(
            loaded.properties.author, "Daniel Sallander",
            "dc:creator is Calcula's `author`, and it is the field most likely \
             to be mapped to the wrong name"
        );
        assert_eq!(loaded.properties.subject, "Revenue");
        assert_eq!(
            loaded.properties.description, "Figures for Q3, unaudited",
            "the writer puts `description` in dc:description via set_comment; \
             reading dc:subject here would look correct on a fixture where the \
             two agree"
        );
        assert_eq!(loaded.properties.keywords, "revenue,q3,draft");
        assert_eq!(loaded.properties.category, "Finance");
        // rust_xlsxwriter stamps dcterms:created on every file it writes, so
        // this one is asserted as PRESENT rather than as a value.
        assert!(
            !loaded.properties.created.is_empty(),
            "dcterms:created is written unconditionally and must be read back"
        );
    }

    /// The counterweight: a file with no `docProps/core.xml` at all, and one
    /// whose properties are empty, must import as empty strings rather than
    /// failing the whole load. Document metadata is advisory; nothing about it
    /// may cost a user their data.
    #[test]
    fn a_workbook_without_document_properties_still_imports() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nodocprops.xlsx");
        // `write_dated_xlsx` builds the archive by hand and writes no docProps
        // part at all -- exactly the case under test.
        write_dated_xlsx(&path, "");

        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        assert_eq!(loaded.properties.title, "");
        assert_eq!(loaded.properties.author, "");
        assert_eq!(
            number_at(&loaded.sheets[0], 0, 1),
            36892.0,
            "the cells must still load -- a missing docProps part is not an error"
        );
    }
    // ------------------------------------------------------------------
    // Excel's "Negative numbers:" entries survive the export (open-items 1.1)
    // ------------------------------------------------------------------

    /// The writer emitted the bare one-section code for every currency cell
    /// while the app painted parentheses, so a workbook CHANGED ITS OWN
    /// APPEARANCE on the way to Excel. One section now means exactly what
    /// Excel means by it -- a leading minus -- and the other three entries
    /// write their own codes.
    #[test]
    fn each_currency_negative_entry_exports_the_code_excel_writes_for_it() {
        let usd = |negative_style| NumberFormat::Currency {
            decimal_places: 2,
            symbol: "$".to_string(),
            symbol_position: engine::style::CurrencyPosition::Before,
            negative_style,
        };
        assert_eq!(
            convert_number_format(&usd(engine::style::NegativeStyle::Minus)),
            "$#,##0.00"
        );
        assert_eq!(
            convert_number_format(&usd(engine::style::NegativeStyle::Red)),
            "$#,##0.00;[Red]$#,##0.00"
        );
        assert_eq!(
            convert_number_format(&usd(engine::style::NegativeStyle::Parentheses)),
            "$#,##0.00;($#,##0.00)"
        );
        assert_eq!(
            convert_number_format(&usd(engine::style::NegativeStyle::RedParentheses)),
            "$#,##0.00;[Red]($#,##0.00)"
        );
    }

    /// The two halves of the fidelity claim have to meet: what this writer
    /// emits must read back as the format it came from.
    #[test]
    fn every_currency_negative_entry_round_trips_through_the_reader() {
        for negative_style in [
            engine::style::NegativeStyle::Minus,
            engine::style::NegativeStyle::Red,
            engine::style::NegativeStyle::Parentheses,
            engine::style::NegativeStyle::RedParentheses,
        ] {
            let original = NumberFormat::Currency {
                decimal_places: 2,
                symbol: "$".to_string(),
                symbol_position: engine::style::CurrencyPosition::Before,
                negative_style,
            };
            let code = convert_number_format(&original);
            assert_eq!(
                crate::xlsx_style_reader::parse_format_code_for_test(&code),
                original,
                "{:?} did not survive the code {}",
                negative_style,
                code
            );
        }
    }

    // ------------------------------------------------------------------
    // Home tab = Excel's Home tab (rust-format lane, 2026-10-04)
    // ------------------------------------------------------------------

    /// The codes Excel writes, region by region: en-US brackets negatives
    /// behind `_(` pads; every minus region puts the minus BEFORE the fill.
    /// The sv-SE Comma code is byte-for-byte the one Excel's Comma Style
    /// wrote in the live probe (in its invariant spelling).
    #[test]
    fn accounting_exports_the_regional_code_excel_writes() {
        use engine::style::{CurrencyPosition, NegativeStyle};
        let acct = |sym: &str, pos, neg| NumberFormat::Accounting {
            decimal_places: 2,
            symbol: sym.to_string(),
            symbol_position: pos,
            negative_style: neg,
        };
        assert_eq!(
            convert_number_format(&acct("", CurrencyPosition::Before, NegativeStyle::Minus)),
            "_-* #,##0.00_-;-* #,##0.00_-;_-* \"-\"??_-;_-@_-"
        );
        assert_eq!(
            convert_number_format(&acct("kr", CurrencyPosition::After, NegativeStyle::Minus)),
            "_-* #,##0.00\" kr\"_-;-* #,##0.00\" kr\"_-;_-* \"-\"??\" kr\"_-;_-@_-"
        );
        assert_eq!(
            convert_number_format(&acct("$", CurrencyPosition::Before, NegativeStyle::Parentheses)),
            "_(\"$\"* #,##0.00_);_(\"$\"* (#,##0.00);_(\"$\"* \"-\"??_);_(@_)"
        );
        assert_eq!(
            convert_number_format(&acct("\u{00A3}", CurrencyPosition::Before, NegativeStyle::Minus)),
            "_-\"\u{00A3}\"* #,##0.00_-;-\"\u{00A3}\"* #,##0.00_-;_-\"\u{00A3}\"* \"-\"??_-;_-@_-"
        );
    }

    /// Every accounting shape the writer can emit reads back as the format it
    /// came from: symbol (empty, prefix, suffix, multi-letter, non-ASCII),
    /// side, decimals, and all four negative entries.
    #[test]
    fn every_accounting_shape_round_trips_through_the_reader() {
        use engine::style::{CurrencyPosition, NegativeStyle};
        for symbol in ["", "$", "\u{00A3}", "\u{20AC}", "\u{00A5}", "CHF", "kr"] {
            for position in [CurrencyPosition::Before, CurrencyPosition::After] {
                if symbol.is_empty() && position == CurrencyPosition::After {
                    continue; // no symbol has no side; it reads back as Before
                }
                for negative_style in [
                    NegativeStyle::Minus,
                    NegativeStyle::Parentheses,
                    NegativeStyle::Red,
                    NegativeStyle::RedParentheses,
                ] {
                    for decimal_places in [0u8, 2, 3] {
                        let original = NumberFormat::Accounting {
                            decimal_places,
                            symbol: symbol.to_string(),
                            symbol_position: position,
                            negative_style,
                        };
                        let code = convert_number_format(&original);
                        assert_eq!(
                            crate::xlsx_style_reader::parse_format_code_for_test(&code),
                            original,
                            "did not survive the code {code}"
                        );
                    }
                }
            }
        }
    }

    /// Rotation, stacked text and a half-point size survive save + load. This
    /// is where "Rotate Text Down" used to become Excel's Vertical Text (the
    /// crate's magic 270 is OOXML 255) and come back as Rotate Text UP, and
    /// where 10.5 pt was written and read back as 10.
    #[test]
    fn rotations_stacked_text_and_half_point_sizes_survive_the_xlsx_roundtrip() {
        use engine::style::{FontSize, TextRotation};
        let rotations = [
            TextRotation::Rotate90,
            TextRotation::Rotate270,
            TextRotation::Vertical,
            TextRotation::Custom(45),
            TextRotation::Custom(-45),
        ];
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        let mut sheet = Sheet::new("Orient".to_string());
        sheet.styles = vec![CellStyle::new()];
        for (i, rotation) in rotations.iter().enumerate() {
            sheet.styles.push(CellStyle::new().with_text_rotation(*rotation));
            sheet.cells.insert(
                (i as u32, 0),
                SavedCell {
                    value: SavedCellValue::Text("ab".to_string()),
                    formula: None,
                    style_index: i + 1,
                    rich_text: None,
                    spill: None,
                },
            );
        }
        let mut half = CellStyle::new();
        half.font.size = FontSize::from_points(10.5).unwrap();
        let mut big = CellStyle::new();
        big.font.size = FontSize::from_whole_points(409);
        for (offset, style) in [half, big].into_iter().enumerate() {
            sheet.styles.push(style);
            let row = (rotations.len() + offset) as u32;
            let style_index = sheet.styles.len() - 1;
            sheet.cells.insert(
                (row, 0),
                SavedCell {
                    value: SavedCellValue::Text("size".to_string()),
                    formula: None,
                    style_index,
                    rich_text: None,
                    spill: None,
                },
            );
        }
        workbook.sheets.push(sheet);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("orient.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let s = &loaded.sheets[0];
        for (i, rotation) in rotations.iter().enumerate() {
            let style = &s.styles[s.cells[&(i as u32, 0)].style_index];
            assert_eq!(style.text_rotation, *rotation, "row {i}");
        }
        let half_back = &s.styles[s.cells[&(rotations.len() as u32, 0)].style_index];
        assert_eq!(half_back.font.size.points(), 10.5);
        let big_back = &s.styles[s.cells[&(rotations.len() as u32 + 1, 0)].style_index];
        assert_eq!(big_back.font.size.points(), 409.0);
    }

    // =======================================================================
    // S7 — SHARED FORMULAS, and what a 2-D `ref` actually loses
    // =======================================================================
    //
    // WHAT A SHARED FORMULA IS. Excel stores a block of identical-modulo-offset
    // formulas ONCE: the first cell carries `<f t="shared" ref="B2:D4" si="0">`
    // with the text, and every other cell in `ref` carries only
    // `<f t="shared" si="0"/>` — no text at all. The reader is expected to
    // reconstruct each follower by translating the master's RELATIVE references by
    // the follower's offset from the master.
    //
    // WHAT CALAMINE DOES, read out of `cells_reader.rs` rather than assumed: it
    // builds the offset map in two MUTUALLY EXCLUSIVE branches — if the `ref`
    // spans rows it walks rows only, at the fixed start COLUMN; else if it spans
    // columns it walks columns only, at the fixed start ROW. So for a RECTANGULAR
    // ref the first branch fires and only the range's FIRST COLUMN is reconstructed.
    // Every other column's follower looks itself up in the map, misses, and is left
    // with no formula at all.
    //
    // THE ARCHIVE GOT THIS WRONG IN THE OTHER DIRECTION, and the wrong version is
    // the dangerous one for whoever fixes this: `open-decisions-2026-08.md` says a
    // 2-D ref "yields an empty map and every follower gets no formula". It does not.
    // A test written to that description would fail on the surviving first column
    // and be misread as proof the bug was fixed. Hence this fixture: PARTIAL
    // survival, pinned.
    //
    // THIS TEST DOCUMENTS A LOSS RATHER THAN ASSERTING CORRECTNESS. That is
    // deliberate and is what `docs/design/open-items.md` asks for as the first step:
    // there is no fix here yet, and a fix cannot be proved without a fixture that
    // shows exactly what is lost today.

    /// Write a .xlsx whose B2:D4 block is ONE shared formula with a 2-D `ref`.
    ///
    /// Layout: A2:A4 hold 1,2,3. B2 is the master `=$A2*10` with `ref="B2:D4"`;
    /// B3, B4, C2..C4 and D2..D4 are text-less followers. In Excel every cell in
    /// B2:D4 shows a number.
    fn write_shared_formula_xlsx(path: &std::path::Path) {
        use std::io::Write;
        let mut zw = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let o = zip::write::SimpleFileOptions::default();

        zw.start_file("[Content_Types].xml", o).unwrap();
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#).unwrap();

        zw.start_file("_rels/.rels", o).unwrap();
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#).unwrap();

        zw.start_file("xl/workbook.xml", o).unwrap();
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#).unwrap();

        zw.start_file("xl/_rels/workbook.xml.rels", o).unwrap();
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#).unwrap();

        // The cached <v> values are what Excel last computed, and they are correct
        // for every cell — so a reader that drops the FORMULA still shows the right
        // NUMBER until something recalculates. That is what makes this loss quiet.
        zw.start_file("xl/worksheets/sheet1.xml", o).unwrap();
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="2"><c r="A2"><v>1</v></c><c r="B2"><f t="shared" ref="B2:D4" si="0">$A2*10</f><v>10</v></c><c r="C2"><f t="shared" si="0"/><v>10</v></c><c r="D2"><f t="shared" si="0"/><v>10</v></c></row>
<row r="3"><c r="A3"><v>2</v></c><c r="B3"><f t="shared" si="0"/><v>20</v></c><c r="C3"><f t="shared" si="0"/><v>20</v></c><c r="D3"><f t="shared" si="0"/><v>20</v></c></row>
<row r="4"><c r="A4"><v>3</v></c><c r="B4"><f t="shared" si="0"/><v>30</v></c><c r="C4"><f t="shared" si="0"/><v>30</v></c><c r="D4"><f t="shared" si="0"/><v>30</v></c></row>
</sheetData>
</worksheet>"#).unwrap();

        zw.finish().unwrap();
    }

    /// The 2-D shared-formula `ref` loses formulas — PARTIALLY, and this pins which.
    #[test]
    fn a_two_dimensional_shared_formula_ref_loses_all_but_the_first_column() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shared-2d.xlsx");
        write_shared_formula_xlsx(&path);

        let wb = crate::xlsx_reader::load_xlsx(&path).expect("the fixture opens");
        let sheet = &wb.sheets[0];

        // A1 -> (row, col), both 0-based. Local to the test: the reader exposes no
        // such helper and this fixture is the only caller.
        fn a1(s: &str) -> (u32, u32) {
            let split = s.find(|c: char| c.is_ascii_digit()).expect("an A1 ref has a digit");
            let (letters, digits) = s.split_at(split);
            let col = letters
                .bytes()
                .fold(0u32, |acc, b| acc * 26 + u32::from(b - b'A' + 1))
                - 1;
            let row: u32 = digits.parse().expect("a row number");
            (row - 1, col)
        }
        let formula_at = |ref_: &str| -> Option<String> {
            let (row, col) = a1(ref_);
            sheet.cells.get(&(row, col)).and_then(|c| c.formula.clone())
        };

        // THE MASTER always survives: it carries its own text.
        assert!(
            formula_at("B2").is_some(),
            "the master cell carries the formula text inline and must always survive"
        );

        // Record what is TRUE today, cell by cell, so a future fix has something to
        // change. Followers in the FIRST COLUMN of the ref may survive (calamine's
        // row-walking branch); every other column is the documented loss.
        let first_col_followers = ["B3", "B4"].iter().filter(|a| formula_at(a).is_some()).count();
        let other_col_followers = ["C2", "C3", "C4", "D2", "D3", "D4"]
            .iter()
            .filter(|a| formula_at(a).is_some())
            .count();

        assert_eq!(
            other_col_followers, 0,
            "DOCUMENTING TODAY'S LOSS: every follower outside the ref's first column \
             should have no formula. If this now reports 6, the loss is FIXED — \
             update this test to assert correctness (each cell equals the master \
             translated by its offset) and strike S7 from open-items.md."
        );

        // The values are intact either way, which is why the loss is quiet: the
        // sheet LOOKS right until something recalculates and the formula-less cells
        // stay frozen at Excel's last answer.
        for (ref_, expected) in [("C2", 10.0), ("D4", 30.0)] {
            let (row, col) = a1(ref_);
            let cell = sheet.cells.get(&(row, col)).expect("the cell exists");
            assert!(
                matches!(cell.value, crate::SavedCellValue::Number(n) if (n - expected).abs() < 1e-9),
                "{} should still hold Excel's cached value {} — the VALUE survives, \
                 the FORMULA does not, and that is what makes this silent",
                ref_,
                expected
            );
        }

        // Stated rather than asserted, because it is calamine's choice and not
        // Calcula's: the first-column count is 0 or 2 depending on the dependency's
        // branch, and either way the OTHER columns are the defect.
        println!(
            "[S7] first-column followers with a formula: {} of 2; other columns: {} of 6",
            first_col_followers, other_col_followers
        );
    }

    /// .cala v10 embeds the chart spec as a JSON VALUE; the xlsx meta carry
    /// still holds it as TEXT. A chart must survive save_xlsx -> load_xlsx
    /// through the carry with its spec back as the same OBJECT (not a string
    /// holding JSON) and its identity kept, and an unparseable spec that was
    /// kept as a string value must come back as that same string.
    #[test]
    fn a_chart_spec_value_survives_the_xlsx_meta_carry_as_an_object() {
        let mut workbook = Workbook::new();
        let sheet_id = workbook.sheets[0].id;
        let chart_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        // A mark with no native OOXML form, so ONLY the carry can restore it.
        let spec = serde_json::json!({
            "chartId": chart_id.to_string(),
            "name": "Gauge 1",
            "sheetIndex": 0,
            "x": 10, "y": 20, "width": 300, "height": 200,
            "spec": { "mark": "gauge", "data": "A1:B3", "title": "Kärna" }
        });
        workbook.charts.push(crate::SavedChart { id: chart_id, sheet_id, spec: spec.clone() });
        let broken_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        workbook.charts.push(crate::SavedChart {
            id: broken_id,
            sheet_id,
            spec: serde_json::Value::String("{not json".to_string()),
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chart.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();

        let back = loaded
            .charts
            .iter()
            .find(|c| c.id == chart_id)
            .expect("the carried chart must keep its id");
        assert!(back.spec.is_object(), "spec must be an embedded object, got {:?}", back.spec);
        assert_eq!(back.spec, spec, "the carried spec must round-trip unchanged");
        assert_eq!(back.sheet_id, loaded.sheets[0].id);

        let raw = loaded
            .charts
            .iter()
            .find(|c| c.spec.is_string())
            .expect("an unparseable spec is kept, never dropped");
        assert_eq!(raw.spec, serde_json::Value::String("{not json".to_string()));
    }

    // ========================================================================
    // EXCEL'S calcCompleted="0" (BUG-0615#2 follow-up)
    // ========================================================================

    fn workbook_part_of(path: &std::path::Path) -> String {
        use std::io::Read;
        let file = std::fs::File::open(path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut xml = String::new();
        zip.by_name(XLSX_WORKBOOK_PART).unwrap().read_to_string(&mut xml).unwrap();
        xml
    }

    /// A workbook saved with calculation incomplete exports Excel's own
    /// marker, and the reader reads it back -- through real files, the path
    /// `save_file` / `open_file` take. [LIVE] Excel 16 writes
    /// `calcCompleted="0"` for a manual workbook saved with a precedent
    /// changed, and reopens it with CalculationState = xlPending.
    #[test]
    fn an_incomplete_calculation_exports_excels_calc_completed_marker() {
        let mut workbook = one_sheet(vec![((0, 1), formula_cell("A1*2"))]);
        workbook.calculation_incomplete = true;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("incomplete.xlsx");
        save_xlsx(&workbook, &path).unwrap();

        let xml = workbook_part_of(&path);
        let calc_pr = &xml[xml.find("<calcPr").expect("no <calcPr>")..];
        let calc_pr = &calc_pr[..calc_pr.find('>').unwrap() + 1];
        assert!(
            calc_pr.contains("calcCompleted=\"0\""),
            "the export did not say its values were saved with calculation pending: {}",
            calc_pr
        );
        // fullCalcOnLoad stays: Excel opening the export recalculates it.
        assert!(calc_pr.contains("fullCalcOnLoad=\"1\""), "{}", calc_pr);
        assert!(calc_pr.ends_with("/>"), "the element must stay well-formed: {}", calc_pr);

        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        assert!(
            loaded.calculation_incomplete,
            "the xlsx reader dropped Excel's calcCompleted=\"0\": the reopened workbook vouches for stale values"
        );
        // The rest of the archive is intact.
        assert_eq!(loaded.sheets.len(), 1);
        assert_eq!(loaded.sheets[0].cells.get(&(0, 1)).and_then(|c| c.formula.clone()).as_deref(), Some("=A1*2"));
    }

    #[test]
    fn a_completed_calculation_exports_no_marker() {
        let workbook = one_sheet(vec![((0, 1), formula_cell("A1*2"))]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("complete.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        assert!(!workbook_part_of(&path).contains("calcCompleted"));
        assert!(!crate::xlsx_reader::load_xlsx(&path).unwrap().calculation_incomplete);
    }

    /// Excel's own text, verbatim from a [LIVE] Excel 16 save, and the forms
    /// the attribute can take.
    #[test]
    fn the_reader_reads_excels_own_calc_pr() {
        use crate::xlsx_reader::calc_pr_says_incomplete as says;
        let excel = r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/><calcPr calcId="191029" calcMode="manual" calcCompleted="0" calcOnSave="0"/></workbook>"#;
        assert!(says(excel));
        assert!(says(r#"<workbook><calcPr calcCompleted="false"></calcPr></workbook>"#));
        assert!(!says(r#"<workbook><calcPr calcId="191029"/></workbook>"#));
        assert!(!says(r#"<workbook><calcPr calcId="191029" calcCompleted="1"/></workbook>"#));
        assert!(!says(r#"<workbook><sheets/></workbook>"#));
    }

    #[test]
    fn the_marker_rewrite_replaces_an_existing_value_and_keeps_the_element_whole() {
        assert_eq!(
            with_calc_completed_false(r#"<w><calcPr calcId="1" calcCompleted="1"/></w>"#).as_deref(),
            Some(r#"<w><calcPr calcId="1" calcCompleted="0"/></w>"#)
        );
        assert_eq!(
            with_calc_completed_false(r#"<w><calcPr calcId="124519" fullCalcOnLoad="1"/></w>"#).as_deref(),
            Some(r#"<w><calcPr calcId="124519" fullCalcOnLoad="1" calcCompleted="0"/></w>"#)
        );
        assert_eq!(with_calc_completed_false("<w/>"), None);
    }

    /// The `<calcPr>` element of an exported file, start tag only.
    fn calc_pr_of(path: &std::path::Path) -> String {
        let xml = workbook_part_of(path);
        let calc_pr = &xml[xml.find("<calcPr").expect("no <calcPr>")..];
        calc_pr[..calc_pr.find('>').unwrap() + 1].to_string()
    }

    /// Excel's calculation mode through a real file: an export made while
    /// calculation is MANUAL says `calcMode="manual"` (what [LIVE] Excel 16
    /// writes: `<calcPr calcId="191029" calcMode="manual"/>`), an automatic
    /// one says nothing (Excel's default `auto`), and the reader reads each
    /// back. Manual and incomplete together carry both attributes.
    #[test]
    fn a_manual_calculation_exports_excels_calc_mode_and_reads_it_back() {
        let workbook = one_sheet(vec![((0, 1), formula_cell("A1*2"))]);
        let dir = tempfile::tempdir().unwrap();

        let manual = dir.path().join("manual.xlsx");
        save_xlsx_with_calculation_mode(&workbook, &manual, true).unwrap();
        let calc_pr = calc_pr_of(&manual);
        assert!(
            calc_pr.contains("calcMode=\"manual\""),
            "an export made under manual calculation did not say so: {}",
            calc_pr
        );
        assert!(calc_pr.contains("fullCalcOnLoad=\"1\""), "{}", calc_pr);
        assert!(!calc_pr.contains("calcCompleted"), "a complete calculation is not marked: {}", calc_pr);
        assert!(calc_pr.ends_with("/>"), "the element must stay well-formed: {}", calc_pr);
        assert!(
            crate::xlsx_reader::read_xlsx_manual_calculation(&manual).unwrap(),
            "the xlsx reader dropped Excel's calcMode=\"manual\""
        );
        // The rest of the archive is intact.
        let loaded = crate::xlsx_reader::load_xlsx(&manual).unwrap();
        assert_eq!(loaded.sheets[0].cells.get(&(0, 1)).and_then(|c| c.formula.clone()).as_deref(), Some("=A1*2"));

        let automatic = dir.path().join("automatic.xlsx");
        save_xlsx_with_calculation_mode(&workbook, &automatic, false).unwrap();
        assert!(!calc_pr_of(&automatic).contains("calcMode"), "{}", calc_pr_of(&automatic));
        assert!(!crate::xlsx_reader::read_xlsx_manual_calculation(&automatic).unwrap());

        let mut incomplete = workbook.clone();
        incomplete.calculation_incomplete = true;
        let both = dir.path().join("both.xlsx");
        save_xlsx_with_calculation_mode(&incomplete, &both, true).unwrap();
        let calc_pr = calc_pr_of(&both);
        assert!(calc_pr.contains("calcMode=\"manual\"") && calc_pr.contains("calcCompleted=\"0\""), "{}", calc_pr);
        assert!(crate::xlsx_reader::read_xlsx_manual_calculation(&both).unwrap());
        assert!(crate::xlsx_reader::load_xlsx(&both).unwrap().calculation_incomplete);
    }

    /// BUG-0754: Automatic except for data tables exports Excel's
    /// `calcMode="autoNoTable"` ([LIVE] Excel 16, dtable/probe2.ps1, wrote
    /// `<calcPr calcId="191029" calcMode="autoNoTable"/>`) and reads back as
    /// that mode -- never as manual; manual wins when both are asked.
    ///
    /// SABOTAGE: drop the `except_tables` arm in `finish_archive`.
    #[test]
    fn automatic_except_tables_exports_excels_auto_no_table_and_reads_it_back() {
        let mut workbook = one_sheet(vec![((0, 1), formula_cell("A1*2"))]);
        workbook.calculation_except_tables = true;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("semi.xlsx");
        save_xlsx_with_calculation_mode(&workbook, &path, false).unwrap();
        let calc_pr = calc_pr_of(&path);
        assert!(calc_pr.contains("calcMode=\"autoNoTable\""), "AUTO NO TABLE LOST: {}", calc_pr);
        assert_eq!(crate::xlsx_reader::read_xlsx_calculation_mode(&path).unwrap(), "automaticExceptTables");
        assert!(!crate::xlsx_reader::read_xlsx_manual_calculation(&path).unwrap());
        let manual = dir.path().join("manual.xlsx");
        save_xlsx_with_calculation_mode(&workbook, &manual, true).unwrap();
        assert_eq!(crate::xlsx_reader::read_xlsx_calculation_mode(&manual).unwrap(), "manual");
        workbook.calculation_except_tables = false;
        let auto = dir.path().join("auto.xlsx");
        save_xlsx_with_calculation_mode(&workbook, &auto, false).unwrap();
        assert_eq!(crate::xlsx_reader::read_xlsx_calculation_mode(&auto).unwrap(), "automatic");
    }

    /// Excel's own `<calcPr>` text and the forms `calcMode` can take.
    #[test]
    fn the_reader_reads_excels_own_calc_mode() {
        use crate::xlsx_reader::calc_pr_says_manual as manual;
        assert!(manual(r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/><calcPr calcId="191029" calcMode="manual"/></workbook>"#));
        assert!(manual(r#"<workbook><calcPr calcId="191029" calcMode="manual" calcCompleted="0" calcOnSave="0"/></workbook>"#));
        assert!(!manual(r#"<workbook><calcPr calcId="191029"/></workbook>"#));
        assert!(!manual(r#"<workbook><calcPr calcMode="auto"/></workbook>"#));
        assert!(!manual(r#"<workbook><calcPr calcMode="autoNoTable"/></workbook>"#));
        assert!(!manual(r#"<workbook><sheets/></workbook>"#));
        assert_eq!(
            with_calc_pr_attribute(r#"<w><calcPr calcId="1" calcMode="auto"/></w>"#, "calcMode", "manual").as_deref(),
            Some(r#"<w><calcPr calcId="1" calcMode="manual"/></w>"#)
        );
    }

    /// A formula carries its CACHED result: an export opened by a reader that
    /// does not recalculate -- Excel, once the file says manual ([LIVE] Excel
    /// 16 opens a manual file xlPending, showing the cached `<v>`) -- shows the
    /// value Calcula calculated, not the library's `0` placeholder.
    #[test]
    fn a_formula_exports_its_cached_result() {
        use std::io::Read;
        let mut number = formula_cell("A1*2");
        number.value = SavedCellValue::Number(14.0);
        let mut text = formula_cell("\"x\"&\"y\"");
        text.value = SavedCellValue::Text("xy".to_string());
        let workbook = one_sheet(vec![((0, 1), number), ((0, 2), text)]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cached.xlsx");
        save_xlsx_with_calculation_mode(&workbook, &path, true).unwrap();
        let file = std::fs::File::open(&path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut sheet = String::new();
        zip.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut sheet).unwrap();
        assert!(
            sheet.contains("<f>A1*2</f><v>14</v>"),
            "the formula's cached result was not exported: {}",
            sheet
        );
        assert!(sheet.contains("<v>xy</v>"), "the text result was not exported: {}", sheet);
    }

    /// Keep a copy of an exported file for a live-Excel check, when
    /// `CALCULA_XLSX_PROBE_DIR` names a folder (unset in every normal run).
    fn keep_for_live_probe(path: &std::path::Path) {
        if let Ok(dir) = std::env::var("CALCULA_XLSX_PROBE_DIR") {
            let _ = std::fs::copy(path, std::path::Path::new(&dir).join(path.file_name().unwrap()));
        }
    }

    /// One worksheet part of an exported file.
    fn sheet_part_of(path: &std::path::Path, part: &str) -> String {
        use std::io::Read;
        let mut zip = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
        let mut xml = String::new();
        zip.by_name(part).unwrap().read_to_string(&mut xml).unwrap();
        xml
    }

    /// A formula's cached result carries EXCEL'S cell type ([LIVE] Excel 16
    /// saves `=TRUE()` as `<c t="b"><f>TRUE()</f><v>1</v></c>`, `=1/0` as
    /// `t="e"` with `#DIV/0!`, and `="123"` as `t="str"` with `123`), not the
    /// library's number-or-`t="str"` guess: a boolean was cached as the TEXT
    /// "TRUE", an error as `0`, a numeric-looking text as a NUMBER. An error
    /// outside the classic seven is cached as `#VALUE!`, as Excel caches
    /// `#SPILL!` ([LIVE] Excel 16 would not open the file with `t="e"`
    /// `#SPILL!`). The reader reads each back as its own type, an array
    /// origin's result too. The file opens in live Excel 16 (manual, pending)
    /// showing TRUE / FALSE / #DIV/0! / "123" as Boolean / Boolean / error /
    /// String.
    #[test]
    fn a_formula_result_is_cached_with_excels_cell_type_and_read_back_as_that_type() {
        let cell = |f: &str, v: SavedCellValue| {
            let mut c = formula_cell(f);
            c.value = v;
            c
        };
        let mut array = cell("B6:B7>1", SavedCellValue::Boolean(false));
        array.spill = Some((6, 0));
        let workbook = one_sheet(vec![
            ((0, 0), cell("TRUE()", SavedCellValue::Boolean(true))),
            ((0, 1), cell("1>2", SavedCellValue::Boolean(false))),
            ((0, 2), cell("1/0", SavedCellValue::Error("#DIV/0!".to_string()))),
            ((0, 3), cell("\"123\"", SavedCellValue::Text("123".to_string()))),
            ((0, 4), cell("\"a<b\"", SavedCellValue::Text("a<b".to_string()))),
            ((0, 5), cell("A1+1", SavedCellValue::Number(7.5))),
            ((0, 6), cell("A9", SavedCellValue::Error("#SPILL!".to_string()))),
            ((0, 7), cell("A8", SavedCellValue::Error("#CIRCULAR!".to_string()))),
            ((5, 0), array),
            (
                (6, 0),
                SavedCell {
                    value: SavedCellValue::Boolean(true),
                    formula: None,
                    style_index: 0,
                    rich_text: None,
                    spill: None,
                },
            ),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("typed.xlsx");
        save_xlsx_with_calculation_mode(&workbook, &path, true).unwrap();
        keep_for_live_probe(&path);
        let xml = sheet_part_of(&path, "xl/worksheets/sheet1.xml");
        assert!(!xml.contains(CACHED_RESULT_MARK), "a cached-result marker was left in the file: {}", xml);
        for expected in [
            r#"<c r="A1" t="b"><f>TRUE()</f><v>1</v></c>"#,
            r#"<c r="B1" t="b"><f>1&gt;2</f><v>0</v></c>"#,
            r#"<c r="C1" t="e"><f>1/0</f><v>#DIV/0!</v></c>"#,
            r#"<c r="D1" t="str"><f>"123"</f><v>123</v></c>"#,
            r#"<c r="E1" t="str"><f>"a&lt;b"</f><v>a&lt;b</v></c>"#,
            r#"<c r="F1"><f>A1+1</f><v>7.5</v></c>"#,
            // #SPILL!: #VALUE! plus the rich value that names it, as Excel saves it.
            r#"<c r="G1" t="e" vm="1"><f>A9</f><v>#VALUE!</v></c>"#,
            // #CIRCULAR!: Excel caches a circular formula as 0 ([LIVE], round 15).
            r#"<c r="H1"><f>A8</f><v>0</v></c>"#,
            r#"<c r="A6" cm="1" t="b"><f t="array" ref="A6:A7">B6:B7&gt;1</f><v>0</v></c>"#,
        ] {
            assert!(
                xml.contains(expected),
                "a cached result did not carry Excel's cell type: expected {} in {}",
                expected,
                xml
            );
        }

        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let value = |row: u32, col: u32| loaded.sheets[0].cells.get(&(row, col)).map(|c| c.value.clone()).map(|v| format!("{:?}", v));
        assert_eq!(value(0, 0), Some(format!("{:?}", SavedCellValue::Boolean(true))), "a TRUE result came back as another type");
        assert_eq!(value(0, 1), Some(format!("{:?}", SavedCellValue::Boolean(false))));
        assert_eq!(value(0, 2), Some(format!("{:?}", SavedCellValue::Error("#DIV/0!".to_string()))));
        assert_eq!(
            value(0, 3),
            Some(format!("{:?}", SavedCellValue::Text("123".to_string()))),
            "a text result that looks like a number came back as a number"
        );
        assert_eq!(value(0, 4), Some(format!("{:?}", SavedCellValue::Text("a<b".to_string()))));
        assert_eq!(value(0, 5), Some(format!("{:?}", SavedCellValue::Number(7.5))));
        assert_eq!(
            value(0, 6),
            Some(format!("{:?}", SavedCellValue::Error("#SPILL!".to_string()))),
            "a #SPILL! is cached as Excel caches it (#VALUE! plus its rich value) and read back as #SPILL!"
        );
        assert_eq!(value(0, 7), Some(format!("{:?}", SavedCellValue::Number(0.0))), "a circular formula is cached as Excel caches it");
        assert_eq!(value(5, 0), Some(format!("{:?}", SavedCellValue::Boolean(false))), "the array origin's cached result");
    }

    /// The reader against the bytes Excel writes: a cached error OUTSIDE the
    /// seven calamine parses (`#SPILL!`, `#CALC!`, ...) used to fail the whole
    /// sheet -- calamine refuses a `t="e"` value it does not know -- and a
    /// `t="str"` result that looks like a number came back as a number.
    #[test]
    fn the_reader_reads_excels_typed_cached_results() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("excel-typed.xlsx");
        {
            let mut zw = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            zw.start_file("[Content_Types].xml", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#).unwrap();
            zw.start_file("_rels/.rels", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#).unwrap();
            zw.start_file("xl/workbook.xml", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" calcMode="manual"/></workbook>"#).unwrap();
            zw.start_file("xl/_rels/workbook.xml.rels", o).unwrap();
            zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#).unwrap();
            zw.start_file("xl/worksheets/sheet1.xml", o).unwrap();
            zw.write_all(br##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="e" cm="1"><f t="array" ref="A1">_xlfn.SEQUENCE(2)</f><v>#SPILL!</v></c><c r="B1" t="e"><f>_xlfn.LAMBDA(1)</f><v>#CALC!</v></c><c r="C1" t="str"><f>"0123"</f><v>0123</v></c><c r="D1" t="b"><f>TRUE()</f><v>1</v></c><c r="E1" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="F1" t="str"><f>"#SPILL!"</f><v>#SPILL!</v></c></row></sheetData></worksheet>"##).unwrap();
            zw.finish().unwrap();
        }
        let loaded = crate::xlsx_reader::load_xlsx(&path).expect("a cached #SPILL! must not fail the import");
        let value = |col: u32| loaded.sheets[0].cells.get(&(0, col)).map(|c| c.value.clone()).map(|v| format!("{:?}", v));
        assert_eq!(value(0), Some(format!("{:?}", SavedCellValue::Error("#SPILL!".to_string()))));
        assert_eq!(value(1), Some(format!("{:?}", SavedCellValue::Error("#CALC!".to_string()))));
        assert_eq!(value(2), Some(format!("{:?}", SavedCellValue::Text("0123".to_string()))), "a text result read as a number");
        assert_eq!(value(3), Some(format!("{:?}", SavedCellValue::Boolean(true))));
        assert_eq!(value(4), Some(format!("{:?}", SavedCellValue::Error("#DIV/0!".to_string()))));
        assert_eq!(value(5), Some(format!("{:?}", SavedCellValue::Text("#SPILL!".to_string()))), "a TEXT result is not an error");
        // A1 is DYNAMIC (`cm="1"`, as Excel 16 saves a spilling SEQUENCE);
        // written plain it would be a legacy formula, which Excel -- and so
        // Calcula -- reads as `=@SEQUENCE(2)` ([LIVE] lane xlsx probe1).
        assert_eq!(loaded.sheets[0].cells.get(&(0, 0)).and_then(|c| c.formula.clone()).as_deref(), Some("=SEQUENCE(2)"));
    }

    /// A sheet's STANDARD column width is written the way Excel saves it
    /// ([LIVE] Excel 16, StandardWidth 20 and column C at 30: `<sheetFormatPr
    /// defaultColWidth="20.59765625" ..>` and ONE `<col min="3" max="3"
    /// customWidth="1">`), not as a custom width on all 16,384 columns, which
    /// made every column custom-width in Excel. Each sheet states its own; a
    /// column that only carries a style shows the standard; a hidden one stays
    /// hidden; and the reader reads it all back.
    #[test]
    fn a_sheets_standard_width_is_written_as_excels_default_col_width() {
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        let mut wide = Sheet::new("Wide".to_string());
        wide.default_column_width = Some(145.0);
        wide.column_widths.insert(2, 215.0);
        wide.user_hidden_cols = [5u32].into_iter().collect();
        let mut bold = CellStyle::new();
        bold.font.bold = true;
        wide.styles.push(bold);
        wide.column_styles.insert(7, 1);
        workbook.sheets.push(wide);
        workbook.sheets.push(Sheet::new("Plain".to_string()));
        let mut narrow = Sheet::new("Narrow".to_string());
        narrow.default_column_width = Some(40.0);
        workbook.sheets.push(narrow);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("standard-width.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        keep_for_live_probe(&path);

        let wide_xml = sheet_part_of(&path, "xl/worksheets/sheet1.xml");
        assert!(
            wide_xml.contains(r#"<sheetFormatPr defaultColWidth="20.7109375" "#),
            "the standard width was not written as Excel's defaultColWidth: {}",
            wide_xml
        );
        let cols = &wide_xml[wide_xml.find("<cols>").unwrap()..wide_xml.find("</cols>").unwrap()];
        assert_eq!(
            cols.matches("<col ").count(),
            3,
            "only the columns that differ (C, a hidden F, a styled H) may carry a <col>: {}",
            cols
        );
        assert!(cols.contains(r#"<col min="3" max="3" width="30.7109375" customWidth="1"/>"#), "{}", cols);
        assert!(cols.contains(r#"<col min="6" max="6" width="0" hidden="1" customWidth="1"/>"#), "{}", cols);
        assert!(
            cols.contains(r#"<col min="8" max="8" width="20.7109375" style="1"/>"#),
            "a styled column with no width of its own shows the STANDARD: {}",
            cols
        );
        let plain_xml = sheet_part_of(&path, "xl/worksheets/sheet2.xml");
        assert!(!plain_xml.contains("defaultColWidth"), "{}", plain_xml);
        let narrow_xml = sheet_part_of(&path, "xl/worksheets/sheet3.xml");
        assert!(narrow_xml.contains(r#"<sheetFormatPr defaultColWidth="5.7109375" "#), "{}", narrow_xml);
        assert!(!narrow_xml.contains("<cols>"), "{}", narrow_xml);

        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let wide = &loaded.sheets[0];
        assert_eq!(wide.default_column_width, Some(145.0));
        assert_eq!(wide.column_widths.get(&2), Some(&215.0));
        assert_eq!(wide.user_hidden_cols.iter().copied().collect::<Vec<_>>(), vec![5]);
        assert_eq!(loaded.sheets[1].default_column_width, None);
        assert_eq!(loaded.sheets[2].default_column_width, Some(40.0));
        assert!(loaded.sheets[2].column_widths.is_empty());
    }

    /// A formula's TEXT result is cached as text however it parses. Rust's f64
    /// parser accepts "NaN", "inf" and "Infinity" in any case, so the library
    /// wrote such a result untyped (`<v>NaN</v>`) -- a file live Excel 16
    /// refused to open ("Unable to get the Open property") -- and "12" / "1E5"
    /// came back as numbers. Each is `t="str"` and reads back as the text.
    #[test]
    fn a_text_result_rust_would_parse_as_a_number_is_cached_as_text() {
        let texts = ["NaN", "nan", "Inf", "-inf", "Infinity", "12", "1E5", "+3.5"];
        let cells: Vec<((u32, u32), SavedCell)> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let mut c = formula_cell(&format!("\"{}\"", t));
                c.value = SavedCellValue::Text(t.to_string());
                ((0, i as u32), c)
            })
            .collect();
        let workbook = one_sheet(cells);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("text-results.xlsx");
        save_xlsx_with_calculation_mode(&workbook, &path, true).unwrap();
        keep_for_live_probe(&path);
        let xml = sheet_part_of(&path, "xl/worksheets/sheet1.xml");
        for (i, t) in texts.iter().enumerate() {
            let col = (b'A' + i as u8) as char;
            let expected = format!(r#"<c r="{}1" t="str"><f>"{}"</f><v>{}</v></c>"#, col, t, t);
            assert!(
                xml.contains(&expected),
                "a text result that parses as a number was not cached as text: expected {} in {}",
                expected,
                xml
            );
        }
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        for (i, t) in texts.iter().enumerate() {
            let got = loaded.sheets[0].cells.get(&(0, i as u32)).map(|c| format!("{:?}", c.value));
            assert_eq!(got, Some(format!("{:?}", SavedCellValue::Text(t.to_string()))), "the text result {:?} came back as another type", t);
        }
    }

    /// A STATIC error cell (a value with no formula -- a pasted value, a typed
    /// `#N/A`) is Excel's error constant: [LIVE] Excel 16 saves a typed `#N/A`
    /// as `<c r="A10" t="e"><v>#N/A</v></c>`, `#GETTING_DATA` as `#N/A`, and a
    /// pasted `#SPILL!` / `#CALC!` as `t="e"` `#VALUE!` (its real error only in
    /// rich-value metadata). It was written as the TEXT "#N/A", so ISERROR /
    /// ISNA changed their answer in Excel and on re-import. A text that merely
    /// reads "#N/A" stays text.
    #[test]
    fn a_static_error_cell_is_written_as_excels_error_constant() {
        let static_cell = |value: SavedCellValue, style_index: usize| SavedCell {
            value,
            formula: None,
            style_index,
            rich_text: None,
            spill: None,
        };
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        let mut first = Sheet::new("First".to_string());
        first.cells.insert((0, 0), static_cell(SavedCellValue::Number(1.0), 0));
        workbook.sheets.push(first);
        let mut errors = Sheet::new("Errors".to_string());
        let mut bold = CellStyle::new();
        bold.font.bold = true;
        errors.styles.push(bold);
        for (col, value) in [
            SavedCellValue::Error("#N/A".to_string()),
            SavedCellValue::Error("#DIV/0!".to_string()),
            SavedCellValue::Error("#SPILL!".to_string()),
            SavedCellValue::Error("#GETTING_DATA".to_string()),
            SavedCellValue::Text("#N/A".to_string()),
            SavedCellValue::Number(0.0),
        ]
        .into_iter()
        .enumerate()
        {
            errors.cells.insert((0, col as u32), static_cell(value, 0));
        }
        errors.cells.insert((2, 0), static_cell(SavedCellValue::Error("#REF!".to_string()), 1));
        workbook.sheets.push(errors);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("static-errors.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        keep_for_live_probe(&path);
        let xml = sheet_part_of(&path, "xl/worksheets/sheet2.xml");
        for expected in [
            r#"<c r="A1" t="e"><v>#N/A</v></c>"#,
            r#"<c r="B1" t="e"><v>#DIV/0!</v></c>"#,
            r#"<c r="C1" t="e" vm="1"><v>#VALUE!</v></c>"#,
            r#"<c r="D1" t="e"><v>#N/A</v></c>"#,
            r#"<c r="E1" t="s">"#,
            r#"<c r="F1"><v>0</v></c>"#,
            r#"<c r="A3" s="1" t="e"><v>#REF!</v></c>"#,
        ] {
            assert!(
                xml.contains(expected),
                "a static error cell was not written as Excel's error constant: expected {} in {}",
                expected,
                xml
            );
        }
        assert!(!sheet_part_of(&path, "xl/worksheets/sheet1.xml").contains("t=\"e\""));

        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let value = |row: u32, col: u32| loaded.sheets[1].cells.get(&(row, col)).map(|c| format!("{:?}", c.value));
        let error = |e: &str| Some(format!("{:?}", SavedCellValue::Error(e.to_string())));
        assert_eq!(value(0, 0), error("#N/A"), "a static #N/A came back as another type");
        assert_eq!(value(0, 1), error("#DIV/0!"));
        assert_eq!(value(0, 2), error("#SPILL!"), "a static #SPILL! comes back through its rich value");
        assert_eq!(value(0, 3), error("#N/A"));
        assert_eq!(value(0, 4), Some(format!("{:?}", SavedCellValue::Text("#N/A".to_string()))), "a TEXT that reads #N/A is not an error");
        assert_eq!(value(0, 5), Some(format!("{:?}", SavedCellValue::Number(0.0))), "a real 0 is not an error");
        assert_eq!(value(2, 0), error("#REF!"));
    }

    /// rev12B (round 13): a `#SPILL!` / `#CALC!` came back from Calcula's own
    /// .xlsx as `#VALUE!`. [LIVE] Excel 16 saves them as `#VALUE!` plus a rich
    /// value (`<c t="e" vm="1">`, `xl/metadata.xml` XLRICHVALUE ->
    /// `xl/richData/rdrichvalue.xml`, an `_error` with `errorType` 8 / 13), and
    /// reads the real error back from it; so does Calcula now, for a formula's
    /// cached error and a static one, next to the library's own dynamic-array
    /// metadata (merged into one part) and without it (a part of its own).
    /// Calcula's own `#CIRCULAR!` has no Excel code: a formula's is cached as
    /// Excel caches a circular reference, `0` (round 15, [LIVE]).
    ///
    /// [LIVE] Excel 16 opens both files (round 14, CALCULA_XLSX_PROBE_DIR):
    /// a static `#SPILL!` / `#CALC!` shows as itself (ERROR.TYPE 9), with the
    /// library's dynamic-array metadata merged or without it. A FORMULA's cached
    /// `#SPILL!` in a manual-calculation export still shows `#VALUE!` in Excel
    /// until F9 (Excel's own file shows the rich error there; the difference
    /// was not found) -- Calcula's reader gets it back either way.
    ///
    /// SABOTAGE: drop the `vm` attribute from the retyped cells -- fails at
    /// "RICH VALUE LOST".
    #[test]
    fn an_extended_error_round_trips_through_excels_rich_value_metadata() {
        let cell = |f: Option<&str>, v: SavedCellValue| {
            let mut c = formula_cell(f.unwrap_or("1"));
            if f.is_none() {
                c.formula = None;
            }
            c.value = v;
            c
        };
        let mut spill = cell(Some("SEQUENCE(2)"), SavedCellValue::Number(1.0));
        spill.spill = Some((5, 0));
        let with_array = one_sheet(vec![
            ((0, 0), cell(Some("A9"), SavedCellValue::Error("#SPILL!".to_string()))),
            ((0, 1), cell(Some("B9"), SavedCellValue::Error("#CALC!".to_string()))),
            ((0, 2), cell(None, SavedCellValue::Error("#CALC!".to_string()))),
            ((0, 3), cell(Some("D1"), SavedCellValue::Error("#CIRCULAR!".to_string()))),
            ((0, 4), cell(Some("1/0"), SavedCellValue::Error("#DIV/0!".to_string()))),
            ((4, 0), spill),
            ((5, 0), cell(None, SavedCellValue::Number(2.0))),
        ]);
        let without_array = one_sheet(vec![((1, 1), cell(None, SavedCellValue::Error("#SPILL!".to_string())))]);
        let dir = tempfile::tempdir().unwrap();
        for (name, workbook) in [("rich-errors.xlsx", &with_array), ("rich-errors-plain.xlsx", &without_array)] {
            let path = dir.path().join(name);
            save_xlsx(workbook, &path).unwrap();
            keep_for_live_probe(&path);
            let metadata = sheet_part_of(&path, XLSX_METADATA_PART);
            assert!(metadata.contains("name=\"XLRICHVALUE\""), "no XLRICHVALUE metadata type: {}", metadata);
            assert!(sheet_part_of(&path, XLSX_RICH_VALUE_PART).contains("<rv s=\"0\"><v>"), "no rich value");
            assert!(sheet_part_of(&path, "[Content_Types].xml").contains("/xl/richData/rdrichvalue.xml"));
            assert!(sheet_part_of(&path, "xl/_rels/workbook.xml.rels").contains("richData/rdrichvaluestructure.xml"));
            let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
            let value = |row: u32, col: u32| loaded.sheets[0].cells.get(&(row, col)).map(|c| format!("{:?}", c.value));
            let error = |e: &str| Some(format!("{:?}", SavedCellValue::Error(e.to_string())));
            if name == "rich-errors.xlsx" {
                assert!(metadata.contains("name=\"XLDAPR\""), "the library's dynamic-array metadata was lost: {}", metadata);
                let xml = sheet_part_of(&path, "xl/worksheets/sheet1.xml");
                // The `vm` numbers follow the order the cells are written in;
                // one rich value per error type, shared by its cells.
                let vm_of = |at: &str| -> Option<String> {
                    let start = xml.find(&format!("<c r=\"{}\"", at))?;
                    let tag = &xml[start..start + xml[start..].find('>')?];
                    let v = tag.find(" vm=\"")? + 5;
                    Some(tag[v..v + tag[v..].find('"')?].to_string())
                };
                let (spill, calc, calc_static) = (vm_of("A1"), vm_of("B1"), vm_of("C1"));
                assert!(spill.is_some() && calc.is_some(), "RICH VALUE LOST: no vm on the cached errors in {}", xml);
                assert_eq!(calc, calc_static, "one rich value per error type");
                assert_ne!(spill, calc);
                assert_eq!(vm_of("D1"), None, "#CIRCULAR! has no Excel rich value");
                assert_eq!(vm_of("E1"), None, "#DIV/0! needs none");
                for expected in [
                    r#"<f>A9</f><v>#VALUE!</v></c>"#,
                    // [LIVE] Excel caches a circular formula as 0 (round 15).
                    r#"<c r="D1"><f>D1</f><v>0</v></c>"#,
                    r#"<c r="E1" t="e"><f>1/0</f><v>#DIV/0!</v></c>"#,
                ] {
                    assert!(xml.contains(expected), "expected {} in {}", expected, xml);
                }
                assert_eq!(value(0, 0), error("#SPILL!"), "RICH VALUE LOST: a cached #SPILL! came back as another error");
                assert_eq!(value(0, 1), error("#CALC!"));
                assert_eq!(value(0, 2), error("#CALC!"), "a static #CALC! comes back too");
                // ...as the ENGINE's own #CALC! (BUG-0774): until the variant
                // existed the literal survived the file and became #VALUE! in
                // the cell (`CellError::from_literal`'s fallback).
                for at in [(0, 1), (0, 2)] {
                    assert_eq!(
                        loaded.sheets[0].cells[&at].value.to_value(),
                        engine::CellValue::Error(engine::CellError::Calc),
                        "{at:?}: the file's #CALC! is the engine's #CALC!"
                    );
                }
                // And the engine's #CALC! is what a save writes.
                assert_eq!(
                    format!("{:?}", SavedCellValue::from_value(&engine::CellValue::Error(engine::CellError::Calc))),
                    format!("{:?}", SavedCellValue::Error("#CALC!".to_string()))
                );
                assert_eq!(
                    value(0, 3),
                    Some(format!("{:?}", SavedCellValue::Number(0.0))),
                    "a circular formula is cached as Excel caches it, 0"
                );
                assert_eq!(value(0, 4), error("#DIV/0!"));
            } else {
                assert_eq!(value(1, 1), error("#SPILL!"), "RICH VALUE LOST: a metadata part of its own");
            }
        }
    }

    /// The reader against the rich-value parts live Excel 16 wrote for a
    /// blocked `=SEQUENCE(3)` (#SPILL!, with spill offsets), `=LAMBDA(x,x)`
    /// and an empty `FILTER` (#CALC!) and `=A1#` (a propagated #SPILL!), next
    /// to Excel's XLDAPR dynamic-array metadata (round 14 probe, verbatim).
    #[test]
    fn excels_own_rich_error_values_are_read() {
        let metadata = r#"<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray"><metadataTypes count="2"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/><metadataType name="XLRICHVALUE" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1"/></metadataTypes><futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata><futureMetadata name="XLRICHVALUE" count="4"><bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="0"/></ext></extLst></bk><bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="1"/></ext></extLst></bk><bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="2"/></ext></extLst></bk><bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="3"/></ext></extLst></bk></futureMetadata><cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata><valueMetadata count="4"><bk><rc t="2" v="0"/></bk><bk><rc t="2" v="1"/></bk><bk><rc t="2" v="2"/></bk><bk><rc t="2" v="3"/></bk></valueMetadata></metadata>"#;
        let values = r#"<rvData xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="4"><rv s="0"><v>0</v><v>8</v><v>2</v><v>1</v></rv><rv s="1"><v>13</v><v>24</v></rv><rv s="1"><v>13</v><v>3</v></rv><rv s="2"><v>8</v><v>1</v></rv></rvData>"#;
        let structures = r#"<rvStructures xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="3"><s t="_error"><k n="colOffset" t="i"/><k n="errorType" t="i"/><k n="rwOffset" t="i"/><k n="subType" t="i"/></s><s t="_error"><k n="errorType" t="i"/><k n="subType" t="i"/></s><s t="_error"><k n="errorType" t="i"/><k n="propagated" t="b"/></s></rvStructures>"#;
        let parsed = crate::xlsx_style_reader::parse_rich_value_parts(metadata, values, structures);
        let mut got: Vec<(u32, u32)> = parsed.into_iter().collect();
        got.sort_unstable();
        assert_eq!(got, vec![(1, 8), (2, 13), (3, 13), (4, 8)]);
        assert_eq!(rich_error_literal(8), Some("#SPILL!"));
        assert_eq!(rich_error_literal(13), Some("#CALC!"));
    }

    /// rev12B (round 13): `finish_archive` inflated and re-deflated EVERY
    /// worksheet part whenever one feature needed any. Only a part that
    /// carries something to state is rewritten; the rest are copied as the
    /// library wrote them (here: still STORED, never re-deflated).
    ///
    /// SABOTAGE: treat every sheet part as one to rewrite again -- fails at
    /// "RE-DEFLATED".
    #[test]
    fn finishing_the_archive_rewrites_only_the_sheet_parts_that_need_it() {
        use std::io::Write;
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let sheet = r#"<worksheet><sheetFormatPr defaultRowHeight="15"/><sheetData/></worksheet>"#;
        for part in ["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"] {
            zw.start_file(part, stored).unwrap();
            zw.write_all(sheet.as_bytes()).unwrap();
        }
        let bytes = zw.finish().unwrap().into_inner();
        let mut widths = std::collections::HashMap::new();
        widths.insert("xl/worksheets/sheet1.xml".to_string(), 20.0);
        let out = finish_archive(
            &bytes,
            false,
            false,
            false,
            &CachedResults::default(),
            &widths,
            &std::collections::HashMap::new(),
            &[],
        )
        .unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(out)).unwrap();
        assert_eq!(
            archive.by_name("xl/worksheets/sheet1.xml").unwrap().compression(),
            zip::CompressionMethod::Deflated,
            "the part with a standard width is rewritten"
        );
        assert_eq!(
            archive.by_name("xl/worksheets/sheet2.xml").unwrap().compression(),
            zip::CompressionMethod::Stored,
            "RE-DEFLATED: a sheet part with nothing to state was inflated and re-deflated"
        );
    }

    /// A minimal one-sheet .xlsx around a hand-written worksheet part.
    fn write_minimal_xlsx(path: &std::path::Path, sheet_xml: &str) {
        use std::io::Write;
        let mut zw = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        zw.start_file("[Content_Types].xml", o).unwrap();
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#).unwrap();
        zw.start_file("_rels/.rels", o).unwrap();
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#).unwrap();
        zw.start_file("xl/workbook.xml", o).unwrap();
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>"#).unwrap();
        zw.start_file("xl/_rels/workbook.xml.rels", o).unwrap();
        zw.write_all(br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#).unwrap();
        zw.start_file("xl/worksheets/sheet1.xml", o).unwrap();
        zw.write_all(sheet_xml.as_bytes()).unwrap();
        zw.finish().unwrap();
    }

    /// A hidden column with no width of its own reads back with NO width, so it
    /// unhides at the standard -- as in Excel. [LIVE] Excel 16 saves a hidden
    /// column with no width of its own (and one given ColumnWidth 0) as
    /// `<col width="0" hidden="1" customWidth="1"/>`, a hidden width-20 column
    /// with its width kept, a hidden row with no `ht`, a hidden 30pt row with
    /// `ht="30"`, and RowHeight 0 as a hidden row with no `ht`; reopened and
    /// unhidden, the zero-width columns and the row with no height come back
    /// at the standard (8.47 / 14.3) and the sized ones at 20 / 30. The reader
    /// stored the 0 as the column's own width, so unhiding it in Calcula
    /// (which only clears the hidden set) showed a 0px column. A zero width
    /// with no `hidden` attribute (another generator's spelling) is hidden too:
    /// [LIVE] Excel opens this very file with column E hidden and unhides it at
    /// 8.47. Rows differ: Excel never writes `ht="0"`, and opening this file it
    /// unhides the `ht="0"` rows at height 0, so the reader keeps their 0.
    #[test]
    fn a_hidden_line_with_no_size_of_its_own_unhides_at_the_standard() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hidden-lines.xlsx");
        write_minimal_xlsx(
            &path,
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetFormatPr defaultRowHeight="15"/><cols><col min="3" max="3" width="0" hidden="1" customWidth="1"/><col min="4" max="4" width="20.7109375" hidden="1" customWidth="1"/><col min="5" max="5" width="0" customWidth="1"/></cols><sheetData><row r="3" hidden="1"/><row r="4" ht="30" hidden="1" customHeight="1"/><row r="5" ht="0" hidden="1" customHeight="1"/><row r="6" ht="0" customHeight="1"/><row r="7"><c r="A7"><v>1</v></c></row></sheetData></worksheet>"#,
        );
        keep_for_live_probe(&path);
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let sheet = &loaded.sheets[0];
        assert_eq!(sheet.column_widths.get(&2), None, "a hidden column with no width of its own read its 0 as a width");
        assert_eq!(sheet.column_widths.get(&4), None, "a zero-width column read its 0 as a width");
        assert_eq!(sheet.column_widths.get(&3), Some(&145.0), "a hidden column keeps the width it has");
        let mut cols: Vec<u32> = sheet.user_hidden_cols.iter().copied().collect();
        cols.sort_unstable();
        assert_eq!(cols, vec![2, 3, 4]);
        assert_eq!(sheet.row_heights.get(&2), None, "a hidden row with no ht has no height of its own");
        assert_eq!(sheet.row_heights.get(&3), Some(&40.0), "a hidden row keeps the height it has");
        assert_eq!(sheet.row_heights.get(&4), Some(&0.0), "Excel unhides an ht=\"0\" row at 0");
        let mut rows: Vec<u32> = sheet.user_hidden_rows.iter().copied().collect();
        rows.sort_unstable();
        assert_eq!(rows, vec![2, 3, 4]);
    }

    /// Every `<c ..>` start tag in a sheet part that carries one attribute
    /// twice -- an XML well-formedness error no reader opens.
    fn duplicate_attribute_cells(xml: &str) -> Vec<String> {
        let mut bad = Vec::new();
        let mut rest = xml;
        while let Some(at) = rest.find("<c r=\"") {
            let end = at + rest[at..].find('>').unwrap();
            let tag = &rest[at..end];
            let mut names: Vec<&str> = tag
                .split(' ')
                .skip(1)
                .filter_map(|part| part.split_once('=').map(|(name, _)| name))
                .collect();
            let all = names.len();
            names.sort_unstable();
            names.dedup();
            if names.len() != all {
                bad.push(tag.to_string());
            }
            rest = &rest[end..];
        }
        bad
    }

    /// Every cell in a sheet part whose value is UNTYPED (a number to every
    /// reader) but is not a number Excel can parse -- `<v>inf</v>`, `<v>NaN</v>`.
    fn untyped_non_numbers(xml: &str) -> Vec<String> {
        let mut bad = Vec::new();
        let mut rest = xml;
        while let Some(at) = rest.find("<c r=\"") {
            let end = at + rest[at..].find('>').unwrap();
            let tag = &rest[at..end];
            let body = &rest[end + 1..];
            if !tag.contains(" t=\"") && !tag.ends_with('/') {
                let close = body.find("</c>").unwrap();
                let cell = &body[..close];
                if let Some(v_at) = cell.find("<v>") {
                    let v = &cell[v_at + 3..cell.find("</v>").unwrap()];
                    let numeric = !v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || "+-.eE".contains(c));
                    if !numeric {
                        bad.push(format!("{}>{}", tag, cell));
                    }
                }
            }
            rest = &rest[end..];
        }
        bad
    }

    fn link(row: u32, col: u32, target: &str, display: Option<&str>) -> crate::SavedHyperlink {
        crate::SavedHyperlink {
            row,
            col,
            target: target.to_string(),
            display_text: display.map(str::to_string),
            tooltip: None,
        }
    }

    /// rev13C (round 14, BLOCKER): a STATIC error cell that carries a
    /// hyperlink exported as `<c t="s" t="e">` (the link's text landed in the
    /// shared strings at index 0, which looks like the `0` placeholder) -- a
    /// sheet neither Excel nor Calcula can open -- or the whole save was refused
    /// (index non-0). A hyperlinked FORMULA lost its formula. [LIVE] Excel 16
    /// keeps a linked cell's content: `<c r="B1" s="1" t="e"><f>1/0</f>
    /// <v>#DIV/0!</v></c>` and a static `#N/A` typed over a link as
    /// `<c r="B2" s="1" t="e"><v>#N/A</v></c>`, each with its `<hyperlink>`.
    /// Both shared-string orders: the linked error first (its text would be
    /// index 0) and after a text cell (index 1).
    ///
    /// SABOTAGE: run the hyperlink pass after the cell loop again -- fails at
    /// "LINKED ERROR".
    #[test]
    fn a_static_error_with_a_hyperlink_keeps_its_error_and_its_link() {
        let plain = |value: SavedCellValue| SavedCell {
            value,
            formula: None,
            style_index: 0,
            rich_text: None,
            spill: None,
        };
        let dir = tempfile::tempdir().unwrap();
        for (name, first_text) in [("linked-error-sst0.xlsx", false), ("linked-error-sst1.xlsx", true)] {
            let mut cells = vec![((1, 1), plain(SavedCellValue::Error("#N/A".to_string())))];
            if first_text {
                cells.push(((0, 0), plain(SavedCellValue::Text("first".to_string()))));
            }
            let mut formula = formula_cell("1/0");
            formula.value = SavedCellValue::Error("#DIV/0!".to_string());
            cells.push(((2, 1), formula));
            cells.push(((3, 1), plain(SavedCellValue::Number(42.0))));
            let mut workbook = one_sheet(cells);
            workbook.sheets[0].hyperlinks = vec![
                link(1, 1, "https://example.com/b2", None),
                link(2, 1, "https://example.com/b3", Some("shown")),
                link(3, 1, "#Data!A1", None),
                link(5, 1, "https://example.com/b6", Some("only a link")),
            ];
            let path = dir.path().join(name);
            save_xlsx(&workbook, &path).unwrap_or_else(|e| panic!("LINKED ERROR: the save was refused ({}): {:?}", name, e));
            keep_for_live_probe(&path);
            let xml = sheet_part_of(&path, "xl/worksheets/sheet1.xml");
            assert_eq!(duplicate_attribute_cells(&xml), Vec::<String>::new(), "LINKED ERROR: a duplicate attribute in {}", xml);
            for expected in [
                r#"<c r="B2" s="1" t="e"><v>#N/A</v></c>"#,
                r#"<c r="B3" s="1" t="e"><f>1/0</f><v>#DIV/0!</v></c>"#,
                r#"<c r="B4" s="1"><v>42</v></c>"#,
                r#"<c r="B6" s="1" t="s">"#,
            ] {
                assert!(xml.contains(expected), "LINKED ERROR: expected {} in {} ({})", expected, xml, name);
            }
            assert_eq!(xml.matches("<hyperlink ").count(), 4, "a link was lost: {}", xml);

            let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap_or_else(|e| panic!("LINKED ERROR: Calcula cannot open its own file: {:?}", e));
            let sheet = &loaded.sheets[0];
            let value = |row: u32, col: u32| sheet.cells.get(&(row, col)).map(|c| format!("{:?}", c.value));
            assert_eq!(value(1, 1), Some(format!("{:?}", SavedCellValue::Error("#N/A".to_string()))));
            assert_eq!(value(2, 1), Some(format!("{:?}", SavedCellValue::Error("#DIV/0!".to_string()))));
            assert_eq!(sheet.cells[&(2, 1)].formula.as_deref(), Some("=1/0"), "a linked formula lost its formula");
            assert_eq!(value(3, 1), Some(format!("{:?}", SavedCellValue::Number(42.0))));
            assert_eq!(value(5, 1), Some(format!("{:?}", SavedCellValue::Text("only a link".to_string()))));
            let mut linked: Vec<(u32, u32)> = sheet.hyperlinks.iter().map(|h| (h.row, h.col)).collect();
            linked.sort_unstable();
            assert_eq!(linked, vec![(1, 1), (2, 1), (3, 1), (5, 1)]);
            let internal = sheet.hyperlinks.iter().find(|h| (h.row, h.col) == (3, 1)).unwrap();
            assert_eq!(internal.target, "#Data!A1", "an internal link refused the save or changed its target");
        }
    }

    /// Every hyperlink target Calcula holds is one the library can write: the
    /// reader's `#Sheet!A1`, Insert Hyperlink's `'Sheet 2'!A1` and a defined
    /// name are places in the workbook, a bare path a file. Each used to fail
    /// the library with `UnknownUrlType` -- and with it the whole save.
    ///
    /// SABOTAGE: return the target unchanged -- fails at "UNWRITABLE LINK".
    #[test]
    fn every_hyperlink_target_calcula_holds_is_written() {
        for (calcula, library) in [
            ("#Data!A1", "internal:Data!A1"),
            ("'Sheet 2'!B3", "internal:'Sheet 2'!B3"),
            ("A1", "internal:A1"),
            ("MyRange", "internal:MyRange"),
            ("https://example.com/a.b", "https://example.com/a.b"),
            ("mailto:a@b.se?subject=x", "mailto:a@b.se?subject=x"),
            ("C:\\Temp\\Book1.xlsx", "file:///C:\\Temp\\Book1.xlsx"),
            ("Book2.xlsx", "file:///Book2.xlsx"),
            // round 17: a defined name with a dot is a place; a file with a
            // place in it is a file.
            ("Tax.Rate", "internal:Tax.Rate"),
            ("report.xlsx#Sheet1!A1", "file:///report.xlsx#Sheet1!A1"),
            ("#'My#Sheet'!A1", "internal:'My#Sheet'!A1"),
        ] {
            let is_name = |t: &str| t == "Tax.Rate" || t == "MyRange";
            assert_eq!(excel_hyperlink_target(calcula, &is_name), library, "UNWRITABLE LINK: {}", calcula);
            let mut book = XlsxWorkbook::new();
            let written = book.add_worksheet().write_url(0, 0, excel_hyperlink_target(calcula, &is_name).as_str()).map(|_| ());
            assert!(written.is_ok(), "UNWRITABLE LINK: the library refused {} ({:?})", calcula, written);
        }
    }

    /// The post-processing rewrites never write an attribute twice: a cell
    /// they were not written for is REFUSED rather than given a second `t=`.
    /// `retype_static_errors` against a shared string whose index is 0 (the
    /// exact shape of the rev13C blocker), and `retype_cached_results` against a
    /// marker cell something else typed; `with_default_column_width` against a
    /// part that already states a `defaultColWidth`.
    ///
    /// SABOTAGE: drop the typed-tag refusal in `retype_static_errors` -- fails
    /// at "DUPLICATE t=".
    #[test]
    fn the_archive_rewrites_refuse_rather_than_duplicate_an_attribute() {
        let mut errors = std::collections::HashMap::new();
        errors.insert((0u32, 0u32), ("#N/A".to_string(), None));
        let shared_string_zero = r#"<sheetData><row r="1"><c r="A1" s="1" t="s"><v>0</v></c></row></sheetData>"#;
        let result = retype_static_errors(shared_string_zero, &errors);
        assert!(result.is_err(), "DUPLICATE t=: a shared string at index 0 was retyped: {:?}", result);
        let number_zero = r#"<sheetData><row r="1"><c r="A1" s="1"><v>0</v></c></row></sheetData>"#;
        assert_eq!(
            retype_static_errors(number_zero, &errors).unwrap(),
            r#"<sheetData><row r="1"><c r="A1" s="1" t="e"><v>#N/A</v></c></row></sheetData>"#
        );

        let mark = |i: usize| format!("{m}{i}{m}", m = CACHED_RESULT_MARK);
        let cells = vec![("e", "#VALUE!".to_string(), Some(1))];
        let typed_elsewhere = format!(r#"<c r="A1" t="s"><f>A9</f><v>{}</v></c>"#, mark(0));
        assert!(retype_cached_results(&typed_elsewhere, &cells).is_err(), "a cell not typed t=\"str\" was retyped");
        let with_vm = format!(r#"<c r="A1" t="str" vm="2"><f>A9</f><v>{}</v></c>"#, mark(0));
        assert!(retype_cached_results(&with_vm, &cells).is_err(), "a second vm= was written");
        let library = format!(r#"<c r="A1" t="str" cm="1"><f>A9</f><v>{}</v></c>"#, mark(0));
        assert_eq!(
            retype_cached_results(&library, &cells).unwrap(),
            r#"<c r="A1" t="e" vm="1" cm="1"><f>A9</f><v>#VALUE!</v></c>"#
        );

        assert!(with_default_column_width(r#"<sheetFormatPr defaultColWidth="9" defaultRowHeight="15"/>"#, 20.0).is_err());
    }

    /// dims3 (round 14, LIVE): a LAMBDA's parameters exported without Excel's
    /// `_xlpm.` prefix (`<f>_xlfn.LAMBDA(x,x)</f>`), and live Excel 16 refused
    /// to open the whole workbook. [LIVE] Excel 16 writes
    /// `_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1)(2)` (with `cm="1"`, an array formula),
    /// `_xlfn.LET(_xlpm.a,5,..)` (no `cm`), and a defined name `=LAMBDA(n,n+1)`
    /// as `_xlfn.LAMBDA(_xlpm.n,_xlpm.n+1)`. A call to a named LAMBDA leaves as
    /// the call the user wrote, never as Calcula's `__INVOKE__` marker. Each
    /// comes back as Calcula's own text.
    ///
    /// SABOTAGE: `excel_formula_text` returns the formula without the
    /// parameter prefixes -- fails at "NO _xlpm.".
    #[test]
    fn lambda_and_let_parameters_are_exported_with_excels_xlpm_prefix() {
        let cell = |f: &str, v: SavedCellValue| {
            let mut c = formula_cell(f);
            c.value = v;
            c
        };
        let mut workbook = one_sheet(vec![
            ((0, 0), cell("=LAMBDA(x,x+1)(2)", SavedCellValue::Number(3.0))),
            ((1, 0), cell("=LET(a,5,b,a*2,a+b)", SavedCellValue::Number(15.0))),
            ((2, 0), cell("=__INVOKE__(\"AddOne\",LAMBDA(n,n+1),4)", SavedCellValue::Number(5.0))),
            ((3, 0), cell("=MAP({1,2},LAMBDA(v,v*2))", SavedCellValue::Number(2.0))),
        ]);
        workbook.sheets[0].cells.get_mut(&(3, 0)).unwrap().spill = Some((3, 1));
        workbook.sheets[0].cells.insert((3, 1), SavedCell {
            value: SavedCellValue::Number(4.0),
            formula: None,
            style_index: 0,
            rich_text: None,
            spill: None,
        });
        workbook.named_ranges = vec![
            crate::SavedNamedRange { name: "AddOne".to_string(), refers_to: "=LAMBDA(n,n+1)".to_string(), sheet_id: None, comment: None, folder: None },
            crate::SavedNamedRange { name: "Lk".to_string(), refers_to: "=XLOOKUP(2,{1,2},{10,20})".to_string(), sheet_id: None, comment: None, folder: None },
        ];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lambda-params.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        keep_for_live_probe(&path);
        let xml = sheet_part_of(&path, "xl/worksheets/sheet1.xml");
        for expected in [
            "_xlfn.LAMBDA(_xlpm.x,_xlpm.x+1)(2)</f>",
            "<f>_xlfn.LET(_xlpm.a,5,_xlpm.b,_xlpm.a*2,_xlpm.a+_xlpm.b)</f>",
            // A named LAMBDA call is a dynamic formula, as Excel saves it.
            r#"<c r="A3" cm="1"><f t="array" ref="A3">AddOne(4)</f><v>5</v></c>"#,
            "_xlfn.MAP({1,2},_xlfn.LAMBDA(_xlpm.v,_xlpm.v*2))</f>",
        ] {
            assert!(xml.contains(expected), "NO _xlpm.: expected {} in {}", expected, xml);
        }
        assert!(!xml.contains("__INVOKE__"), "Calcula's internal marker reached the file: {}", xml);
        let book = sheet_part_of(&path, "xl/workbook.xml");
        for expected in [
            "<definedName name=\"AddOne\">_xlfn.LAMBDA(_xlpm.n,_xlpm.n+1)</definedName>",
            "<definedName name=\"Lk\">_xlfn.XLOOKUP(2,{1,2},{10,20})</definedName>",
        ] {
            assert!(book.contains(expected), "NO _xlpm.: expected {} in {}", expected, book);
        }

        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let formula = |row: u32| loaded.sheets[0].cells[&(row, 0)].formula.clone();
        assert_eq!(formula(0).as_deref(), Some("=LAMBDA(x,x+1)(2)"));
        assert_eq!(formula(1).as_deref(), Some("=LET(a,5,b,a*2,a+b)"));
        assert_eq!(formula(2).as_deref(), Some("=AddOne(4)"));
        let add_one = loaded.named_ranges.iter().find(|n| n.name == "AddOne").expect("the name was lost");
        assert_eq!(add_one.refers_to.trim_start_matches('='), "LAMBDA(n,n+1)");
    }

    /// The round-15 SWEEP: one workbook holding every kind of cell Calcula can
    /// hold -- numbers (incl. non-finite), text (incl. numeric-looking, NaN,
    /// Inf), booleans, every error (classic, extended, Calcula's own), styled
    /// empties, rich text, a hyperlink on each kind, formulas with each result
    /// kind (incl. a spill and a circular one), LAMBDA / LET, names, notes,
    /// merged cells, hidden rows and columns -- saved in both calculation modes.
    /// Each file is well-formed (no cell carries an attribute twice) and opens
    /// in Calcula's own reader; `CALCULA_XLSX_PROBE_DIR` keeps them for the
    /// live-Excel probe (round 15: [LIVE] Excel 16 opened both).
    #[test]
    fn every_cell_kind_exports_a_file_that_opens() {
        let plain = |value: SavedCellValue, style_index: usize| SavedCell {
            value,
            formula: None,
            style_index,
            rich_text: None,
            spill: None,
        };
        let cell = |f: &str, v: SavedCellValue| {
            let mut c = formula_cell(f);
            c.value = v;
            c
        };
        let mut sheet = Sheet::new("Kinds".to_string());
        let mut bold = CellStyle::new();
        bold.font.bold = true;
        sheet.styles.push(bold);
        let errors = [
            "#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA", "#SPILL!", "#CALC!",
            "#BLOCKED!", "#FIELD!", "#CONNECT!", "#UNKNOWN!", "#CIRCULAR!", "#CONFLICT!", "#LIMIT!",
        ];
        let statics: Vec<SavedCellValue> = [
            SavedCellValue::Number(1.5),
            SavedCellValue::Number(f64::NAN),
            SavedCellValue::Number(f64::INFINITY),
            SavedCellValue::Text("plain".to_string()),
            SavedCellValue::Text("12".to_string()),
            SavedCellValue::Text("NaN".to_string()),
            SavedCellValue::Text("-inf".to_string()),
            SavedCellValue::Text("#N/A".to_string()),
            SavedCellValue::Boolean(true),
            SavedCellValue::Boolean(false),
            SavedCellValue::Empty,
        ]
        .into_iter()
        .chain(errors.iter().map(|e| SavedCellValue::Error(e.to_string())))
        .collect();
        // Column A: each static kind; column B: the same, styled; column C:
        // the same, hyperlinked; column D: a formula with that result.
        for (row, value) in statics.iter().enumerate() {
            let row = row as u32;
            sheet.cells.insert((row, 0), plain(value.clone(), 0));
            sheet.cells.insert((row, 1), plain(value.clone(), 1));
            sheet.cells.insert((row, 2), plain(value.clone(), 0));
            sheet.hyperlinks.push(link(row, 2, "https://example.com/", None));
            sheet.cells.insert((row, 3), cell(&format!("A{}", row + 1), value.clone()));
        }
        let base = statics.len() as u32 + 1;
        let rich: Vec<engine::cell::RichTextRun> =
            serde_json::from_value(serde_json::json!([{ "text": "rich " }, { "text": "text", "bold": true }])).unwrap();
        let mut rich_cell = plain(SavedCellValue::Text("rich text".to_string()), 0);
        rich_cell.rich_text = Some(rich);
        sheet.cells.insert((base, 0), rich_cell);
        let mut spill = cell("=SEQUENCE(3)", SavedCellValue::Number(1.0));
        spill.spill = Some((base + 2, 1));
        sheet.cells.insert((base, 1), spill);
        sheet.cells.insert((base + 1, 1), plain(SavedCellValue::Number(2.0), 0));
        sheet.cells.insert((base + 2, 1), plain(SavedCellValue::Number(3.0), 0));
        sheet.hyperlinks.push(link(base, 1, "https://example.com/spill", None));
        sheet.cells.insert((base, 2), cell(&format!("=C{}+1", base + 1), SavedCellValue::Error("#CIRCULAR!".to_string())));
        sheet.cells.insert((base, 3), cell("=LAMBDA(x,x+1)(2)", SavedCellValue::Number(3.0)));
        sheet.cells.insert((base, 4), cell("=LET(sum,3,sum+1)", SavedCellValue::Number(4.0)));
        sheet.cells.insert((base, 5), cell("=LAMBDA(x,x)", SavedCellValue::Error("#CALC!".to_string())));
        sheet.cells.insert((base, 6), cell("=Rate*2", SavedCellValue::Number(0.2)));
        sheet.cells.insert((base, 7), cell("=AddOne(1)", SavedCellValue::Number(2.0)));
        sheet.cells.insert((base, 8), cell("=\"a&b<c>\"\"q\"\"\"", SavedCellValue::Text("a&b<c>\"q\"".to_string())));
        sheet.cells.insert((base + 3, 0), plain(SavedCellValue::Text("merged".to_string()), 1));
        sheet.merged_regions.push(crate::SavedMergedRegion { start_row: base + 3, start_col: 0, end_row: base + 4, end_col: 2 });
        sheet.hyperlinks.push(link(base + 3, 0, "https://example.com/merged", None));
        sheet.notes.push(crate::SavedNote {
            row: 0,
            col: 0,
            text: "a note".to_string(),
            author: "Calcula".to_string(),
            rich_content: None,
            width: 0.0,
            height: 0.0,
            visible: false,
            created_at: String::new(),
            modified_at: String::new(),
        });
        sheet.user_hidden_rows.insert(base + 5);
        sheet.user_hidden_cols.insert(10);
        // Round 17: references beside a same-named LET / LAMBDA parameter,
        // array constants at a formula's ends and in a name, every hyperlink
        // target shape, a styled empty linked cell, a Headings font, and a
        // name scoped to a sheet called a!b.
        let r17 = base + 7;
        for (col, f) in [
            "=LET(a,5,$A$1+a)",
            "=LET(a,1,A$1+a)",
            "=LET(a,1,$A1+a)",
            "=LET(x,1,Kinds!$X$1+x)",
            "=LET(b,2,SUM($B:$B)*b)",
            "=LET(b,2,SUM(Kinds!B:B)*b)",
            "=LAMBDA(x,x*Kinds!$X$1)(2)",
            "=SUM(Months)",
        ]
        .into_iter()
        .enumerate()
        {
            sheet.cells.insert((r17, col as u32), cell(f, SavedCellValue::Number(0.0)));
        }
        let mut constant = cell("={1,2,3}", SavedCellValue::Number(1.0));
        constant.spill = Some((r17 + 1, 2));
        sheet.cells.insert((r17 + 1, 0), constant);
        sheet.cells.insert((r17 + 1, 1), plain(SavedCellValue::Number(2.0), 0));
        sheet.cells.insert((r17 + 1, 2), plain(SavedCellValue::Number(3.0), 0));
        sheet.cells.insert((r17 + 1, 3), cell("=10*{1;2}", SavedCellValue::Number(10.0)));
        let mut filled = CellStyle::new();
        filled.fill = engine::style::Fill::Solid { color: engine::theme::ThemeColor::Absolute(engine::style::Color::new(255, 255, 0)) };
        sheet.styles.push(filled);
        let mut heading = CellStyle::new();
        heading.font.family = "Headings".to_string();
        sheet.styles.push(heading);
        sheet.cells.insert((r17 + 2, 0), plain(SavedCellValue::Empty, 2));
        sheet.hyperlinks.push(link(r17 + 2, 0, "https://example.com/filled", None));
        sheet.hyperlinks.push(link(r17 + 2, 1, "report.xlsx", Some("relative")));
        sheet.hyperlinks.push(link(r17 + 2, 2, "Tax.Rate", Some("dotted name")));
        sheet.hyperlinks.push(link(r17 + 2, 3, "report.xlsx#Kinds!A1", Some("file at a place")));
        sheet.cells.insert((r17 + 3, 0), plain(SavedCellValue::Text("heading".to_string()), 3));
        // Round 19 (rev17, CONFIRMED LIVE): an error literal, a bare column
        // range and a number's exponent beside a same-named parameter, a use
        // in another case, and a built-in called beside a parameter of its
        // name. The column ranges sit right of the columns they sum.
        let r19 = r17 + 5;
        let round_19 = [
            ("=LET(e,2,1E5+e)", "_xlfn.LET(_xlpm.e,2,1E5+_xlpm.e)"),
            ("=LET(Ab,1,AB+ab)", "_xlfn.LET(_xlpm.Ab,1,_xlpm.Ab+_xlpm.Ab)"),
            ("=LET(sum,3,SUM(sum,1))", "_xlfn.LET(_xlpm.sum,3,SUM(_xlpm.sum,1))"),
            ("=LET(b,2,SUM(A:B))", "_xlfn.LET(_xlpm.b,2,SUM(A:B))"),
            ("=LET(c,2,SUM(A:C)*c)", "_xlfn.LET(_xlpm.c,2,SUM(A:C)*_xlpm.c)"),
            ("=LET(a,1,IFERROR(1/0,#N/A))", "_xlfn.LET(_xlpm.a,1,IFERROR(1/0,#N/A))"),
            ("=LET(n,1,IF(n,#N/A,0))", "_xlfn.LET(_xlpm.n,1,IF(_xlpm.n,#N/A,0))"),
            ("=LET(div,1,IFERROR(1/0,#DIV/0!))", "_xlfn.LET(_xlpm.div,1,IFERROR(1/0,#DIV/0!))"),
        ];
        for (col, (f, _)) in round_19.iter().enumerate() {
            sheet.cells.insert((r19, col as u32), cell(f, SavedCellValue::Number(0.0)));
        }
        let mut bang = Sheet::new("a!b".to_string());
        bang.cells.insert((0, 1), plain(SavedCellValue::Number(0.25), 0));
        let bang_id = bang.id;
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        let sheet_id = sheet.id;
        workbook.sheets.push(sheet);
        workbook.sheets.push(bang);
        workbook.named_ranges = vec![
            crate::SavedNamedRange { name: "Rate".to_string(), refers_to: "=Kinds!$A$1".to_string(), sheet_id: None, comment: None, folder: None },
            crate::SavedNamedRange { name: "AddOne".to_string(), refers_to: "=LAMBDA(n,n+1)".to_string(), sheet_id: None, comment: None, folder: None },
            crate::SavedNamedRange { name: "Local".to_string(), refers_to: "=LET(k,2,k*3)".to_string(), sheet_id: Some(sheet_id), comment: None, folder: None },
            crate::SavedNamedRange { name: "Months".to_string(), refers_to: "={1,2,3}".to_string(), sheet_id: None, comment: None, folder: None },
            crate::SavedNamedRange { name: "Tax.Rate".to_string(), refers_to: "=Kinds!$B$1".to_string(), sheet_id: None, comment: None, folder: None },
            crate::SavedNamedRange { name: "BangRate".to_string(), refers_to: "='a!b'!$B$1".to_string(), sheet_id: Some(bang_id), comment: None, folder: None },
        ];
        let dir = tempfile::tempdir().unwrap();
        for (name, manual) in [("every-kind-auto.xlsx", false), ("every-kind-manual.xlsx", true)] {
            let path = dir.path().join(name);
            save_xlsx_with_calculation_mode(&workbook, &path, manual).unwrap_or_else(|e| panic!("{} was refused: {:?}", name, e));
            keep_for_live_probe(&path);
            let xml = sheet_part_of(&path, "xl/worksheets/sheet1.xml");
            assert_eq!(duplicate_attribute_cells(&xml), Vec::<String>::new(), "a duplicate attribute in {}", name);
            assert_eq!(untyped_non_numbers(&xml), Vec::<String>::new(), "NON-FINITE: an untyped value that is no number in {}", name);
            // The bold format's xf index, as the library numbered it: B1 is a
            // bold 1.5. (Linked styled cells register their own formats in
            // the hyperlink pass, before the cell loop reaches the bold cells,
            // so the index is read, not assumed; round 17.)
            let b1 = xml.find(r#"<c r="B1" s=""#).expect("B1 is styled") + r#"<c r="B1" s=""#.len();
            let bold = &xml[b1..b1 + xml[b1..].find('"').unwrap()];
            assert_ne!(bold, "0");
            for expected in [
                // A static NaN / infinity is Excel's #NUM!, styled or not.
                r#"<c r="A2" t="e"><v>#NUM!</v></c>"#.to_string(),
                r#"<c r="A3" t="e"><v>#NUM!</v></c>"#.to_string(),
                format!(r#"<c r="B3" s="{}" t="e"><v>#NUM!</v></c>"#, bold),
                // An empty cell keeps its style.
                format!(r#"<c r="B11" s="{}"/>"#, bold),
            ] {
                assert!(xml.contains(&expected), "{}: expected {} in {}", name, expected, xml);
            }
            // [LIVE] Excel 16's own spelling of each round-19 formula.
            for (_, excel) in round_19 {
                assert!(xml.contains(&format!("{}</f>", excel)), "{}: NOT EXCEL'S SPELLING, expected {} in {}", name, excel, xml);
            }
            let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap_or_else(|e| panic!("Calcula cannot open {}: {:?}", name, e));
            let sheet = &loaded.sheets[0];
            let num_error = format!("{:?}", SavedCellValue::Error("#NUM!".to_string()));
            for at in [(1, 0), (2, 0), (2, 1)] {
                assert_eq!(sheet.cells.get(&at).map(|c| format!("{:?}", c.value)), Some(num_error.clone()), "NON-FINITE at {:?}", at);
            }
            assert_eq!(sheet.cells.get(&(10, 1)).map(|c| c.style_index > 0), Some(true), "a styled empty cell lost its style");
            // Every static error and every cached error comes back an error
            // (the extended ones through their rich value); Calcula's own have
            // no Excel code and come back #VALUE!, a cached #CIRCULAR! as 0.
            for (offset, e) in errors.iter().enumerate() {
                let row = (statics.len() - errors.len() + offset) as u32;
                for col in [0, 1, 2] {
                    assert!(
                        matches!(sheet.cells.get(&(row, col)).map(|c| &c.value), Some(SavedCellValue::Error(_))),
                        "{}: the static {} at ({}, {}) did not come back an error",
                        name,
                        e,
                        row,
                        col
                    );
                }
            }
            assert_eq!(sheet.hyperlinks.len(), statics.len() + 6, "{}: a link was lost", name);
            for f in ["=LET(a,5,$A$1+a)", "=LET(b,2,SUM(Kinds!B:B)*b)"] {
                assert!(sheet.cells.values().any(|c| c.formula.as_deref() == Some(f)), "{}: {} did not come back", name, f);
            }
            assert!(sheet.cells.values().any(|c| c.formula.as_deref() == Some("={1,2,3}")), "{}: the array constant", name);
            assert!(loaded.named_ranges.iter().any(|n| n.name == "BangRate" && n.sheet_id == Some(loaded.sheets[1].id)), "{}: the a!b name", name);
            assert!(loaded.named_ranges.iter().any(|n| n.name == "Months" && n.refers_to == "={1,2,3}"), "{}: Months", name);
            assert_eq!(sheet.cells[&(base, 3)].formula.as_deref(), Some("=LAMBDA(x,x+1)(2)"));
            assert_eq!(sheet.cells[&(base, 1)].formula.as_deref(), Some("=SEQUENCE(3)"), "{}: a linked spill lost its formula", name);
            assert!(matches!(sheet.cells[&(base, 2)].value, SavedCellValue::Number(n) if n == 0.0), "{}: circular", name);
        }
    }

    /// One shared-strings part of an exported file.
    fn shared_strings_of(path: &std::path::Path) -> String {
        sheet_part_of(path, "xl/sharedStrings.xml")
    }

    fn rich_runs(json: serde_json::Value) -> Vec<engine::cell::RichTextRun> {
        serde_json::from_value(json).unwrap()
    }

    /// round 15 (NEW-xlsx-rich-text-exported-plain): a rich-text cell was
    /// exported as a plain shared string and every run's formatting was lost
    /// ([LIVE] Excel 16 showed `rich text` with Font.Bold False on "text").
    /// [LIVE] Excel 16 saves `rich ` + bold `text` + ` ` + italic red 14pt
    /// `plain` as one `<si>` of four `<r>` runs, the first with no `<rPr>`
    /// and each other restating its whole font (`<b/><sz val="11"/>..`), and a
    /// superscript as `<vertAlign val="superscript"/>`. The export writes the
    /// runs, each over the cell's own font (a run on a bold cell that turns
    /// bold OFF is written without `<b/>`), and the reader reads them back as
    /// the runs Calcula holds -- only what differs from the cell's font.
    ///
    /// SABOTAGE: write the cell as plain text again -- fails at "PLAIN".
    #[test]
    fn rich_text_cells_export_excels_runs_and_read_back() {
        let text_cell = |text: &str, style_index: usize, runs: serde_json::Value| SavedCell {
            value: SavedCellValue::Text(text.to_string()),
            formula: None,
            style_index,
            rich_text: Some(rich_runs(runs)),
            spill: None,
        };
        let mut sheet = Sheet::new("Rich".to_string());
        let mut bold = CellStyle::new();
        bold.font.bold = true;
        sheet.styles.push(bold);
        let a1 = serde_json::json!([
            { "text": "rich " },
            { "text": "text", "bold": true },
            { "text": " " },
            { "text": "plain", "italic": true, "fontSize": 14, "color": { "r": 255, "g": 0, "b": 0, "a": 255 } }
        ]);
        let a2 = serde_json::json!([{ "text": "x" }, { "text": "2", "superscript": true }]);
        let a3 = serde_json::json!([{ "text": "not", "bold": false }, { "text": " bold" }]);
        sheet.cells.insert((0, 0), text_cell("rich text plain", 0, a1.clone()));
        sheet.cells.insert((1, 0), text_cell("x2", 0, a2.clone()));
        sheet.cells.insert((2, 0), text_cell("not bold", 1, a3.clone()));
        // Runs that change nothing, and runs that are not the cell's text,
        // stay plain text.
        sheet.cells.insert((3, 0), text_cell("same", 0, serde_json::json!([{ "text": "same" }])));
        sheet.cells.insert((4, 0), text_cell("value", 0, serde_json::json!([{ "text": "other", "bold": true }])));
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        workbook.sheets.push(sheet);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rich-text.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        keep_for_live_probe(&path);

        let sst = shared_strings_of(&path);
        for expected in [
            r#"<r><t xml:space="preserve">rich </t></r><r><rPr><b/>"#,
            r#"<t>text</t></r>"#,
            r#"<vertAlign val="superscript"/>"#,
            r#"<r><rPr><i/><sz val="14"/><color rgb="FFFF0000"/>"#,
        ] {
            assert!(sst.contains(expected), "PLAIN: expected {} in {}", expected, sst);
        }
        // The run on the bold cell that turns bold off carries no <b/>; the
        // run that keeps the cell's font is bold.
        let not_bold = sst.find("<t>not</t>").expect("PLAIN: the run 'not' is no run of its own");
        let run_start = sst[..not_bold].rfind("<r>").unwrap();
        assert!(!sst[run_start..not_bold].contains("<b/>"), "the bold-off run was written bold: {}", sst);
        assert!(sst.contains("<t>same</t>") && !sst.contains("<r><t>same"), "a run that changes nothing is plain text");
        assert!(sst.contains("<t>value</t>"), "runs that are not the cell's text keep the cell's text");

        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let cells = &loaded.sheets[0].cells;
        assert_eq!(cells[&(0, 0)].rich_text, Some(rich_runs(a1)), "the runs did not read back");
        assert_eq!(cells[&(1, 0)].rich_text, Some(rich_runs(a2)));
        assert_eq!(cells[&(2, 0)].rich_text, Some(rich_runs(a3)));
        assert_eq!(cells[&(3, 0)].rich_text, None);
        assert_eq!(cells[&(4, 0)].rich_text, None);
        assert!(matches!(&cells[&(0, 0)].value, SavedCellValue::Text(t) if t == "rich text plain"));
    }

    /// rev16C (round 17, two nits): a rich run is written over the font the
    /// cell SHOWS. (1) A linked cell with no style of its own shows the
    /// Hyperlink font (blue, underlined), and its runs were built on the
    /// default black font: the first run (no `<rPr>`) showed the link look and
    /// every later run restated black with no underline, and the re-import
    /// gave each run a black colour and no-underline override. (2) A FIRST run
    /// whose font is the cell's own is written with no `<rPr>`, as Excel
    /// writes it ([LIVE] Excel 16: `<si><r><t xml:space="preserve">rich
    /// </t></r><r><rPr><b/>..`); on a styled cell it restated the cell's font.
    ///
    /// SABOTAGE: build the runs with `linked = false` -- fails at "LINK LOOK";
    /// drop the first-run `Format::new()` -- fails at "FIRST RUN".
    #[test]
    fn rich_runs_are_written_over_the_font_the_cell_shows() {
        let text_cell = |text: &str, style_index: usize, runs: serde_json::Value| SavedCell {
            value: SavedCellValue::Text(text.to_string()),
            formula: None,
            style_index,
            rich_text: Some(rich_runs(runs)),
            spill: None,
        };
        let mut sheet = Sheet::new("Rich".to_string());
        let mut bold = CellStyle::new();
        bold.font.bold = true;
        sheet.styles.push(bold);
        let a1 = serde_json::json!([{ "text": "same " }, { "text": "off", "bold": false }]);
        let a2 = serde_json::json!([{ "text": "link " }, { "text": "bold", "bold": true }]);
        sheet.cells.insert((0, 0), text_cell("same off", 1, a1.clone()));
        sheet.cells.insert((1, 0), text_cell("link bold", 0, a2.clone()));
        sheet.hyperlinks = vec![link(1, 0, "https://example.com/", Some("link bold"))];
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        workbook.sheets.push(sheet);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rich-over-cell-font.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        keep_for_live_probe(&path);

        let sst = shared_strings_of(&path);
        assert!(
            sst.contains(r#"<si><r><t xml:space="preserve">same </t></r>"#),
            "FIRST RUN: a first run in the cell's own font restated it: {sst}"
        );
        let link_si = sst.split("<si>").find(|si| si.contains("link ")).expect("the linked cell's runs");
        assert!(link_si.starts_with(r#"<r><t xml:space="preserve">link </t></r>"#), "FIRST RUN: {link_si}");
        let bold_run = &link_si[link_si.find("<r><rPr>").expect("the bold run states its font")..];
        assert!(
            bold_run.contains("<b/>") && bold_run.contains("<u/>") && bold_run.contains(r#"<color theme="10"/>"#),
            "LINK LOOK: a run on a linked cell lost the Hyperlink font: {link_si}"
        );

        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let cells = &loaded.sheets[0].cells;
        assert_eq!(cells[&(0, 0)].rich_text, Some(rich_runs(a1)));
        assert_eq!(
            cells[&(1, 0)].rich_text,
            Some(rich_runs(a2)),
            "LINK LOOK: the linked cell's runs came back with colour or underline overrides"
        );
    }

    /// Excel's own rich shared strings ([LIVE] Excel 16, round 16: the file
    /// Excel saves for `rich ` + bold `text` + ` ` + italic red 14pt `plain`,
    /// and `x` + superscript `2`, verbatim), plus a phonetic guide, whose text
    /// is no part of the cell's. The reader keeps only what differs from the
    /// cell's font (Aptos Narrow 11, theme text colour).
    ///
    /// SABOTAGE: read the phonetic guide's text as a run -- fails at "PHONETIC".
    #[test]
    fn excels_own_rich_shared_strings_are_read_as_runs() {
        let sst = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><r><t xml:space="preserve">rich </t></r><r><rPr><b/><sz val="11"/><color theme="1"/><rFont val="Aptos Narrow"/><family val="2"/><scheme val="minor"/></rPr><t>text</t></r><r><rPr><sz val="11"/><color theme="1"/><rFont val="Aptos Narrow"/><family val="2"/><scheme val="minor"/></rPr><t xml:space="preserve"> </t></r><r><rPr><i/><sz val="14"/><color rgb="FFFF0000"/><rFont val="Aptos Narrow"/><family val="2"/><scheme val="minor"/></rPr><t>plain</t></r></si><si><t>plain only</t></si><si><r><t>x</t></r><r><rPr><vertAlign val="superscript"/><sz val="11"/><color theme="1"/><rFont val="Aptos Narrow"/><family val="2"/><scheme val="minor"/></rPr><t>2</t></r></si><si><r><t>A</t></r><r><rPr><b/></rPr><t>B</t></r><rPh sb="0" eb="1"><t>yomi</t></rPh></si></sst>"#;
        let parsed = crate::xlsx_style_reader::parse_rich_shared_strings(sst);
        let mut indices: Vec<u32> = parsed.keys().copied().collect();
        indices.sort_unstable();
        assert_eq!(indices, vec![0, 2, 3], "the plain string is no rich string; the indices count it");
        let base = crate::xlsx_style_reader::ParsedFont {
            size: engine::style::FontSize::from_whole_points(11),
            name: "Aptos Narrow".to_string(),
            color: Some(engine::style::Color::new(0, 0, 0)),
            ..Default::default()
        };
        let runs = crate::xlsx_style_reader::rich_text_runs(&parsed[&0], "rich text plain", &base).unwrap();
        assert_eq!(
            runs,
            rich_runs(serde_json::json!([
                { "text": "rich " },
                { "text": "text", "bold": true },
                { "text": " " },
                { "text": "plain", "italic": true, "fontSize": 14, "color": { "r": 255, "g": 0, "b": 0, "a": 255 } }
            ]))
        );
        let runs = crate::xlsx_style_reader::rich_text_runs(&parsed[&2], "x2", &base).unwrap();
        assert_eq!(runs, rich_runs(serde_json::json!([{ "text": "x" }, { "text": "2", "superscript": true }])));
        let texts: Vec<&str> = parsed[&3].iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, vec!["A", "B"], "PHONETIC: the phonetic guide's text was read as part of the cell's");
        // Runs whose text is not the cell's are not the cell's runs.
        assert_eq!(crate::xlsx_style_reader::rich_text_runs(&parsed[&3], "AB?", &base), None);
    }

    /// round 15 (NEW-xlsx-missing-calcfeatures-hidden-names): every Excel 16
    /// workbook part carries Excel's calculation-features extension ([LIVE]
    /// round 16: a blank workbook too, the seven features verbatim), and
    /// Calcula's did not. The export now states it, once, as the workbook's
    /// last child. (The hidden `=#NAME?` names Excel lists on opening a
    /// LAMBDA/LET file are Excel's own: [LIVE] it lists them for its own file
    /// too; see `XLSX_CALC_FEATURES_EXT`.)
    ///
    /// SABOTAGE: skip `with_calc_features` -- fails at "NO CALC FEATURES".
    #[test]
    fn every_export_states_excels_calc_features() {
        let dir = tempfile::tempdir().unwrap();
        for (name, manual) in [("calc-features.xlsx", false), ("calc-features-manual.xlsx", true)] {
            let path = dir.path().join(name);
            let mut workbook = one_sheet(vec![((0, 0), formula_cell("=LET(a,1,LAMBDA(x,x+a)(2))"))]);
            workbook.named_ranges = vec![crate::SavedNamedRange {
                name: "AddOne".to_string(),
                refers_to: "=LAMBDA(n,n+1)".to_string(),
                sheet_id: None,
                comment: None,
                folder: None,
            }];
            save_xlsx_with_calculation_mode(&workbook, &path, manual).unwrap();
            keep_for_live_probe(&path);
            let xml = workbook_part_of(&path);
            let expected = format!("<extLst>{}</extLst></workbook>", XLSX_CALC_FEATURES_EXT);
            assert!(xml.ends_with(&expected), "NO CALC FEATURES in {}: {}", name, xml);
            assert_eq!(xml.matches("calcFeatures>").count(), 2, "the features are stated once");
            assert_eq!(manual, xml.contains("calcMode=\"manual\""), "{}: the calculation mode", name);
            crate::xlsx_reader::load_xlsx(&path).unwrap();
        }
        // Inside a part's own extLst; a second statement is refused.
        let with_ext = with_calc_features("<workbook><sheets/><extLst><ext uri=\"x\"/></extLst></workbook>").unwrap();
        assert_eq!(
            with_ext,
            format!("<workbook><sheets/><extLst><ext uri=\"x\"/>{}</extLst></workbook>", XLSX_CALC_FEATURES_EXT)
        );
        assert!(with_calc_features(&with_ext).is_err(), "a second calcFeatures extension was written");
        // A defined name holding the GUID as TEXT is user content, not the
        // extension: it must not refuse the save (rev16C). SABOTAGE: match the
        // bare GUID again -- fails at "GUID TEXT".
        let guid_name = "<workbook><sheets/><definedNames><definedName name=\"G\">&quot;{B58B0392-4F1F-4190-BB64-5DF3571DCE5F}&quot;</definedName></definedNames></workbook>";
        let written = with_calc_features(guid_name).expect("GUID TEXT in a defined name refused the save");
        assert!(written.ends_with(&format!("<extLst>{}</extLst></workbook>", XLSX_CALC_FEATURES_EXT)));
    }

    /// A minimal one-sheet .xlsx around a hand-written workbook part and
    /// worksheet part.
    fn write_minimal_xlsx_with_workbook(path: &std::path::Path, workbook_xml: &str, sheet_xml: &str) {
        use std::io::{Read, Write};
        write_minimal_xlsx(path, sheet_xml);
        let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
        let mut parts: Vec<(String, Vec<u8>)> = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            parts.push((entry.name().to_string(), bytes));
        }
        drop(archive);
        let mut zw = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, bytes) in parts {
            zw.start_file(name.as_str(), zip::write::SimpleFileOptions::default()).unwrap();
            if name == "xl/workbook.xml" {
                zw.write_all(workbook_xml.as_bytes()).unwrap();
            } else {
                zw.write_all(&bytes).unwrap();
            }
        }
        zw.finish().unwrap();
    }

    /// Excel's compatibility names are no user's names: [LIVE] Excel 16
    /// lists them as hidden `=#NAME?` names (`_xlfn.LAMBDA`, `_xlpm.x`, ...)
    /// and refuses `Names.Add` for any name starting `_xlfn.` / `_xlpm.`.
    /// Imported, a name `_xlfn.LET` would be a user name no Excel could hold.
    /// Hidden ones were already skipped (Excel 16 writes none on save,
    /// [LIVE]); a writer that writes them unhidden must not bring them in
    /// either -- in any case: Excel names are case-insensitive, and the skip
    /// was not (rev16C: `_XLFN.XLOOKUP` and `_Xlpm.y` came in as user names).
    ///
    /// SABOTAGE: drop the prefix skip -- fails at "COMPATIBILITY NAME"; match
    /// the prefixes case-sensitively -- fails at the same assertion.
    #[test]
    fn excels_compatibility_names_are_not_imported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("compat-names.xlsx");
        write_minimal_xlsx_with_workbook(
            &path,
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlfn.LAMBDA" hidden="1">#NAME?</definedName><definedName name="_xlfn.LET">#NAME?</definedName><definedName name="_xlpm.x">#NAME?</definedName><definedName name="_XLFN.XLOOKUP">#NAME?</definedName><definedName name="_Xlpm.y">#NAME?</definedName><definedName name="AddOne">_xlfn.LAMBDA(_xlpm.n,_xlpm.n+1)</definedName></definedNames></workbook>"#,
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>"#,
        );
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let names: Vec<(&str, &str)> =
            loaded.named_ranges.iter().map(|n| (n.name.as_str(), n.refers_to.as_str())).collect();
        assert_eq!(names, vec![("AddOne", "=LAMBDA(n,n+1)")], "COMPATIBILITY NAME imported: {:?}", names);
    }

    /// round 15 (NEW-xlsx-sheet-scoped-name-apostrophe): a name scoped to a
    /// sheet called It's was handed to the library as `'It's'!Rate`, an
    /// apostrophe undoubled, and the file listed it so (docProps/app.xml).
    /// [LIVE] Excel 16 saves it as `<definedName name="Rate" localSheetId="0">`
    /// and lists `'It''s'!Rate`. The name keeps its sheet on re-import.
    ///
    /// SABOTAGE: stop doubling the apostrophe -- fails at "UNDOUBLED".
    #[test]
    fn a_name_scoped_to_a_sheet_with_an_apostrophe_is_written_as_excel_does() {
        let mut sheet = Sheet::new("It's".to_string());
        sheet.cells.insert((0, 1), SavedCell {
            value: SavedCellValue::Number(0.25),
            formula: None,
            style_index: 0,
            rich_text: None,
            spill: None,
        });
        let sheet_id = sheet.id;
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        workbook.sheets.push(sheet);
        workbook.named_ranges = vec![crate::SavedNamedRange {
            name: "Rate".to_string(),
            refers_to: "='It''s'!$B$1".to_string(),
            sheet_id: Some(sheet_id),
            comment: None,
            folder: None,
        }];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("apostrophe-scope.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        keep_for_live_probe(&path);
        assert!(
            workbook_part_of(&path).contains(r#"<definedName name="Rate" localSheetId="0">'It''s'!$B$1</definedName>"#),
            "the name lost its scope: {}",
            workbook_part_of(&path)
        );
        let app = sheet_part_of(&path, "docProps/app.xml");
        assert!(app.contains("<vt:lpstr>'It''s'!Rate</vt:lpstr>"), "UNDOUBLED: {}", app);
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        assert_eq!(loaded.named_ranges.len(), 1);
        assert_eq!(loaded.named_ranges[0].sheet_id, Some(loaded.sheets[0].id), "the name lost its sheet");
    }

    /// rev14C nit (round 15): a cell with no `r` attribute (ECMA-376 allows
    /// one; it is the column after the previous cell) was skipped by the
    /// metadata pass, so an unknown error literal in one (`#SPILL!` written
    /// plainly by another generator) never asked for the archive to be
    /// sanitized, and calamine refused the WHOLE import. It is now placed
    /// where calamine places it, and its literal is read back.
    ///
    /// SABOTAGE: skip an `r`-less cell again -- fails at "R-LESS".
    #[test]
    fn an_unknown_error_in_a_cell_with_no_r_attribute_still_imports() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("r-less.xlsx");
        write_minimal_xlsx(
            &path,
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c><v>5</v></c><c t="e"><v>#SPILL!</v></c></row><row><c t="e"><v>#CALC!</v></c><c r="C2" t="e"><v>#N/A</v></c><c><v>7</v></c></row></sheetData></worksheet>"#,
        );
        keep_for_live_probe(&path);
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap_or_else(|e| panic!("R-LESS: the import was refused: {:?}", e));
        let at = |row: u32, col: u32| loaded.sheets[0].cells.get(&(row, col)).map(|c| format!("{:?}", c.value));
        let error = |e: &str| Some(format!("{:?}", SavedCellValue::Error(e.to_string())));
        let number = |n: f64| Some(format!("{:?}", SavedCellValue::Number(n)));
        assert_eq!(at(0, 0), number(5.0));
        assert_eq!(at(0, 1), error("#SPILL!"));
        assert_eq!(at(1, 0), error("#CALC!"));
        assert_eq!(at(1, 2), error("#N/A"));
        assert_eq!(at(1, 3), number(7.0));
    }

    /// rev15A (round 16, CONFIRMED LIVE): a formula or a name with an array
    /// constant at either end lost its braces -- the library strips them as
    /// array-formula braces -- so `={1,2,3}` was written `1,2,3`,
    /// `=B5:B7*{1;2;3}` as `B5:B7*{1;2;3`, and a name `={1,2,3}` beside a
    /// name with a call as `1,2,3`; [LIVE] Excel 16 refused the file. [LIVE]
    /// Excel 16 (round 17) saves each whole: `<f t="array" ref="D5:F5">
    /// {1,2,3}</f>`, `B5:B7*{1;2;3}`, `<definedName name="Months">{1,2,3}
    /// </definedName>`. Each comes back as Calcula's text.
    ///
    /// SABOTAGE: `library_formula` passes the text unguarded -- fails at
    /// "BRACES CUT".
    #[test]
    fn array_constants_at_either_end_of_a_formula_or_name_keep_their_braces() {
        let cell = |f: &str, v: SavedCellValue| {
            let mut c = formula_cell(f);
            c.value = v;
            c
        };
        let mut workbook = one_sheet(vec![
            ((0, 0), cell("={1,2,3}", SavedCellValue::Number(1.0))),
            ((3, 0), cell("=SUM({1,2})", SavedCellValue::Number(3.0))),
            ((1, 0), cell("=A1:A3*{1;2;3}", SavedCellValue::Number(1.0))),
            ((2, 0), cell("={\"a\",\"b\"}&\"x\"", SavedCellValue::Text("ax".to_string()))),
        ]);
        workbook.sheets[0].cells.get_mut(&(0, 0)).unwrap().spill = Some((0, 2));
        let name = |n: &str, f: &str| crate::SavedNamedRange { name: n.to_string(), refers_to: f.to_string(), sheet_id: None, comment: None, folder: None };
        workbook.named_ranges = vec![
            name("Months", "={1,2,3}"),
            name("AddOne", "=LAMBDA(n,n+1)"),
            name("Pair", "={\"a\",\"b\"}&SUM(1)"),
            name("Tail", "=XLOOKUP(2,{1,2},{10,20})+{1,2}"),
        ];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("array-constants.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        keep_for_live_probe(&path);
        let xml = sheet_part_of(&path, "xl/worksheets/sheet1.xml");
        for expected in [
            r#"<f t="array" ref="A1:C1">{1,2,3}</f>"#,
            "<f>SUM({1,2})</f>",
            // Dynamic now, as Excel saves it (`<f t="array" ..>B5:B7*{1;2;3}</f>`
            // above; NEW-xlsx-let-dynamic) -- the braces are what this pins.
            ">A1:A3*{1;2;3}</f>",
            "{&quot;a&quot;,&quot;b&quot;}&amp;&quot;x&quot;</f>",
        ] {
            let alt = expected.replace("&quot;", "\"");
            assert!(xml.contains(expected) || xml.contains(&alt), "BRACES CUT: expected {} in {}", alt, xml);
        }
        let book = workbook_part_of(&path);
        for expected in [
            "<definedName name=\"Months\">{1,2,3}</definedName>",
            "<definedName name=\"AddOne\">_xlfn.LAMBDA(_xlpm.n,_xlpm.n+1)</definedName>",
            "<definedName name=\"Tail\">_xlfn.XLOOKUP(2,{1,2},{10,20})+{1,2}</definedName>",
        ] {
            assert!(book.contains(expected), "BRACES CUT: expected {} in {}", expected, book);
        }
        assert!(
            book.contains("<definedName name=\"Pair\">{&quot;a&quot;,&quot;b&quot;}&amp;SUM(1)</definedName>")
                || book.contains("<definedName name=\"Pair\">{\"a\",\"b\"}&amp;SUM(1)</definedName>"),
            "BRACES CUT: Pair in {}",
            book
        );
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let formula = |row: u32, col: u32| loaded.sheets[0].cells[&(row, col)].formula.clone();
        assert_eq!(formula(0, 0).as_deref(), Some("={1,2,3}"));
        assert_eq!(formula(1, 0).as_deref(), Some("=A1:A3*{1;2;3}"));
        let months = loaded.named_ranges.iter().find(|n| n.name == "Months").expect("Months was lost");
        assert_eq!(months.refers_to, "={1,2,3}");
    }

    /// rev15A (round 16, PLAUSIBLE) + round 17: every hyperlink target is
    /// written as Excel saves it and read back as Calcula holds it. [LIVE]
    /// Excel 16 (round 17): a relative file link is the relationship
    /// `Target="report.xlsx" TargetMode="External"` (the library writes the
    /// same for `file:///report.xlsx`: that mapping was right); a link to the
    /// defined name `Tax.Rate` is `<hyperlink location="Tax.Rate">` with no
    /// relationship (it was written as the file `file:///Tax.Rate`); a link
    /// to `report.xlsx` at `Sheet1!A1` is the relationship plus
    /// `location="Sheet1!A1"` (it was taken for a place in this workbook, and
    /// the reader dropped an external link's location). A tooltip is written.
    ///
    /// SABOTAGE: drop the defined-name lookup in `excel_hyperlink_target` --
    /// fails at "DOTTED NAME".
    #[test]
    fn hyperlink_targets_are_written_as_excel_saves_them_and_read_back() {
        let plain = |text: &str| SavedCell {
            value: SavedCellValue::Text(text.to_string()),
            formula: None,
            style_index: 0,
            rich_text: None,
            spill: None,
        };
        let mut workbook = one_sheet(vec![((0, 0), plain("rel")), ((1, 0), plain("tax")), ((2, 0), plain("anchored")), ((3, 0), plain("web"))]);
        workbook.sheets[0].hyperlinks = vec![
            link(0, 0, "report.xlsx", Some("rel")),
            link(1, 0, "Tax.Rate", Some("tax")),
            link(2, 0, "report.xlsx#Sheet1!A1", Some("anchored")),
            crate::SavedHyperlink {
                row: 3,
                col: 0,
                target: "https://example.com/page#part".to_string(),
                display_text: Some("web".to_string()),
                tooltip: Some("a tip".to_string()),
            },
        ];
        workbook.named_ranges = vec![crate::SavedNamedRange {
            name: "Tax.Rate".to_string(),
            refers_to: "=Data!$B$1".to_string(),
            sheet_id: None,
            comment: None,
            folder: None,
        }];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("link-targets.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        keep_for_live_probe(&path);
        let xml = sheet_part_of(&path, "xl/worksheets/sheet1.xml");
        let rels = sheet_part_of(&path, "xl/worksheets/_rels/sheet1.xml.rels");
        assert!(xml.contains(r#"<hyperlink ref="A2" location="Tax.Rate""#), "DOTTED NAME: the name link is no place: {}", xml);
        assert!(!rels.contains("Tax.Rate"), "DOTTED NAME: the name link is a file: {}", rels);
        assert!(rels.contains(r#"Target="report.xlsx" TargetMode="External""#), "a relative file link: {}", rels);
        assert!(!rels.contains("file:///"), "a relative file link was written as an absolute one: {}", rels);
        assert!(xml.contains(r#"location="Sheet1!A1""#), "the file link's place: {}", xml);
        assert!(xml.contains(r#"tooltip="a tip""#), "the tooltip was lost: {}", xml);
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let target = |row: u32| loaded.sheets[0].hyperlinks.iter().find(|h| h.row == row).map(|h| h.target.clone());
        assert_eq!(target(0).as_deref(), Some("report.xlsx"));
        assert_eq!(target(1).as_deref(), Some("#Tax.Rate"));
        assert_eq!(target(2).as_deref(), Some("report.xlsx#Sheet1!A1"), "LOCATION: an external link's place was dropped");
        assert_eq!(target(3).as_deref(), Some("https://example.com/page#part"), "LOCATION: a URL's fragment was dropped");
        let web = loaded.sheets[0].hyperlinks.iter().find(|h| h.row == 3).unwrap();
        assert_eq!(web.tooltip.as_deref(), Some("a tip"));
    }

    /// misc19 (round 19): a ScreenTip over 255 characters dropped the WHOLE
    /// link from the export (the library refuses the tip, and the refusal
    /// skipped the link). [LIVE] Excel 16 holds at most 255 characters
    /// (misc19/probe1.ps1: a longer tip is refused). The link is kept and the
    /// tip cut to 255 characters -- by character, so a two-byte `é` at the cut
    /// is never split.
    ///
    /// SABOTAGE: pass the tooltip through uncut -- fails at "the link was
    /// dropped for its tip".
    #[test]
    fn an_over_long_screen_tip_is_cut_to_excels_255_and_the_link_kept() {
        let plain = |text: &str| SavedCell {
            value: SavedCellValue::Text(text.to_string()),
            formula: None,
            style_index: 0,
            rich_text: None,
            spill: None,
        };
        let mut workbook = one_sheet(vec![((0, 0), plain("long")), ((1, 0), plain("exact"))]);
        let long_tip: String = std::iter::repeat('\u{e9}').take(300).collect();
        let exact_tip: String = std::iter::repeat('x').take(255).collect();
        workbook.sheets[0].hyperlinks = vec![
            crate::SavedHyperlink {
                row: 0,
                col: 0,
                target: "https://example.com/long".to_string(),
                display_text: Some("long".to_string()),
                tooltip: Some(long_tip),
            },
            crate::SavedHyperlink {
                row: 1,
                col: 0,
                target: "https://example.com/exact".to_string(),
                display_text: Some("exact".to_string()),
                tooltip: Some(exact_tip.clone()),
            },
        ];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("long-tip.xlsx");
        let losses = save_xlsx_reporting_losses(&workbook, &path, false).unwrap();
        assert!(losses.hyperlinks.is_empty(), "the link was dropped for its tip: {:?}", losses.hyperlinks);
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let tip = |row: u32| {
            loaded.sheets[0].hyperlinks.iter().find(|h| h.row == row).and_then(|h| h.tooltip.clone())
        };
        let cut = tip(0).expect("the long link and its tip are in the file");
        assert_eq!(cut.chars().count(), 255, "the tip is cut to Excel's 255 characters");
        assert!(cut.chars().all(|c| c == '\u{e9}'), "cut by character, never inside one");
        assert_eq!(tip(1).as_deref(), Some(exact_tip.as_str()), "a 255-character tip is kept whole");
    }

    /// xlsx5 (round 17, remaining): a file link with a space is the
    /// relationship `Target="my%20report.xlsx"` (Excel and the library both
    /// write it so), and the reader brought it back as `my%20report.xlsx`, a
    /// file no one has. [LIVE] Excel 16, round 18 (calcref/probe-link.ps1),
    /// its own file reopened: `my report.xlsx`, `https://example.com/a b`,
    /// `https://example.com/a b?q=1%202` (the query keeps its escape) and
    /// `sub dir/x%25y.xlsx` (no escape but `%20` is decoded).
    ///
    /// SABOTAGE: return the Target as it is in `excel_link_address` -- fails
    /// at "SPACE".
    #[test]
    fn a_link_target_with_a_space_reads_back_as_excel_shows_it() {
        let plain = |text: &str| SavedCell {
            value: SavedCellValue::Text(text.to_string()),
            formula: None,
            style_index: 0,
            rich_text: None,
            spill: None,
        };
        let mut workbook = one_sheet(vec![((0, 0), plain("file")), ((1, 0), plain("web"))]);
        workbook.sheets[0].hyperlinks = vec![
            link(0, 0, "my report.xlsx", Some("file")),
            link(1, 0, "https://example.com/a b?q=1%202", Some("web")),
        ];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("link-space.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        keep_for_live_probe(&path);
        let rels = sheet_part_of(&path, "xl/worksheets/_rels/sheet1.xml.rels");
        assert!(rels.contains(r#"Target="my%20report.xlsx""#), "the file spells the space as Excel does: {}", rels);
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let target = |row: u32| loaded.sheets[0].hyperlinks.iter().find(|h| h.row == row).map(|h| h.target.clone());
        assert_eq!(target(0).as_deref(), Some("my report.xlsx"), "SPACE: the file link came back percent-encoded");
        assert_eq!(target(1).as_deref(), Some("https://example.com/a b?q=1%202"), "SPACE: the URL's path or query");
        // Excel's own spellings, as its file holds them.
        for (file, shown) in [
            ("my%20report.xlsx", "my report.xlsx"),
            ("https://example.com/a%20b", "https://example.com/a b"),
            ("https://example.com/a%20b?q=1%202", "https://example.com/a b?q=1%202"),
            ("sub%20dir/x%25y.xlsx", "sub dir/x%25y.xlsx"),
        ] {
            assert_eq!(crate::xlsx_style_reader::excel_link_address(file), shown, "SPACE: {file}");
        }
    }

    /// rev15A (round 16, CONFIRMED): a hyperlink the library refuses (an
    /// over-long URL) and a defined name Excel does not allow were left out
    /// with only a stderr `[WARN]`; the save reported success and the user was
    /// never told. The export now returns what it left out, and the app shows
    /// the sentence when the save is done. Everything else is still written.
    ///
    /// SABOTAGE: stop recording a skipped hyperlink -- fails at "SILENT LOSS".
    #[test]
    fn what_an_export_leaves_out_is_reported() {
        let long = format!("https://example.com/{}", "a".repeat(2100));
        let mut workbook = one_sheet(vec![]);
        workbook.sheets[0].hyperlinks = vec![link(1, 1, &long, Some("long")), link(0, 0, "https://example.com/", None)];
        workbook.named_ranges = vec![
            crate::SavedNamedRange { name: "Bad Name".to_string(), refers_to: "=Data!$A$1".to_string(), sheet_id: None, comment: None, folder: None },
            crate::SavedNamedRange { name: "Good".to_string(), refers_to: "=Data!$A$1".to_string(), sheet_id: None, comment: None, folder: None },
        ];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("losses.xlsx");
        let losses = save_xlsx_reporting_losses(&workbook, &path, false).unwrap();
        assert_eq!(losses.hyperlinks, vec!["Data!B2".to_string()], "SILENT LOSS: {:?}", losses);
        assert_eq!(losses.defined_names, vec!["Bad Name".to_string()], "SILENT LOSS: {:?}", losses);
        assert_eq!(
            losses.message().as_deref(),
            Some("The workbook was saved as .xlsx, but the hyperlink in Data!B2 and the defined name Bad Name could not be written to that format and were left out of the file.")
        );
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        assert_eq!(loaded.sheets[0].hyperlinks.len(), 1, "the writable link was lost too");
        assert!(loaded.named_ranges.iter().any(|n| n.name == "Good"), "the writable name was lost too");
        // Nothing left out, nothing to say.
        let clean = save_xlsx_reporting_losses(&one_sheet(vec![]), &dir.path().join("clean.xlsx"), false).unwrap();
        assert!(clean.is_empty() && clean.message().is_none());
        let many = XlsxExportLosses { hyperlinks: (1..=7).map(|i| format!("S!A{}", i)).collect(), defined_names: vec![], formulas: vec![], tables: vec![], filters: vec![], named_styles: vec![] };
        assert_eq!(
            many.message().as_deref(),
            Some("The workbook was saved as .xlsx, but 7 hyperlinks (S!A1, S!A2, S!A3, S!A4, S!A5 and 2 more) could not be written to that format and were left out of the file.")
        );
    }

    /// rev15A (round 16, nit): a STYLED EMPTY linked cell was exported with
    /// the library's link look only -- its fill was lost -- and a styled linked
    /// cell with content with its own style only. [LIVE] Excel 16 (round 17):
    /// a link added to an empty yellow cell keeps the fill and takes the
    /// Hyperlink style's font (`<xf fontId="2" fillId="2" xfId="1">`, font
    /// `<u/><color theme="10"/>`). A colour the cell sets itself stays.
    ///
    /// SABOTAGE: the hyperlink pass writes the link with the library's look
    /// again -- fails at "FILL LOST".
    #[test]
    fn a_styled_linked_cell_keeps_its_style_with_the_link_look() {
        let styled = |value: SavedCellValue, style_index: usize| SavedCell { value, formula: None, style_index, rich_text: None, spill: None };
        let mut sheet = Sheet::new("Links".to_string());
        let mut yellow = CellStyle::new();
        yellow.fill = engine::style::Fill::Solid { color: engine::theme::ThemeColor::Absolute(engine::style::Color::new(255, 255, 0)) };
        let mut red = yellow.clone();
        red.font.color = engine::theme::ThemeColor::Absolute(engine::style::Color::new(255, 0, 0));
        sheet.styles.push(yellow);
        sheet.styles.push(red);
        sheet.cells.insert((0, 0), styled(SavedCellValue::Empty, 1));
        sheet.cells.insert((1, 0), styled(SavedCellValue::Number(42.0), 1));
        sheet.cells.insert((2, 0), styled(SavedCellValue::Text("red".to_string()), 2));
        sheet.hyperlinks = vec![
            link(0, 0, "https://example.com/", None),
            link(1, 0, "https://example.com/n", None),
            link(2, 0, "https://example.com/r", None),
        ];
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        workbook.sheets.push(sheet);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("styled-links.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        keep_for_live_probe(&path);
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let sheet = &loaded.sheets[0];
        let style_of = |row: u32| {
            let cell = sheet.cells.get(&(row, 0)).unwrap_or_else(|| panic!("FILL LOST: the cell at row {} is gone", row));
            sheet.styles[cell.style_index].clone()
        };
        let yellow = engine::style::Color::new(255, 255, 0);
        for row in [0, 1, 2] {
            let style = style_of(row);
            assert_eq!(
                style.fill.background_color(),
                &engine::theme::ThemeColor::Absolute(yellow),
                "FILL LOST: the linked cell at row {} lost its fill ({:?})",
                row,
                style.fill
            );
        }
        for row in [0, 1] {
            assert_eq!(style_of(row).font.underline, engine::UnderlineStyle::Single, "row {}: the link look is missing", row);
        }
        assert_eq!(
            style_of(2).font.color,
            engine::theme::ThemeColor::Absolute(engine::style::Color::new(255, 0, 0)),
            "the cell's own colour was replaced by the link look"
        );
        assert!(matches!(&sheet.cells[&(0, 0)].value, SavedCellValue::Text(t) if t == "https://example.com/"), "the empty linked cell shows the link, as in Excel");
        assert!(matches!(sheet.cells[&(1, 0)].value, SavedCellValue::Number(n) if n == 42.0));
        assert_eq!(sheet.hyperlinks.len(), 3);
    }

    /// xlsx4 (round 16, LIVE): every STYLED cell was exported with the font
    /// name `Body`, Calcula's theme keyword, and Excel showed a font called
    /// "Body". [LIVE] Excel 16 writes a theme font as the theme's font by name
    /// with its scheme: `<name val="Aptos Narrow"/><family val="2"/><scheme
    /// val="minor"/>` (Body), `<name val="Aptos Display"/><scheme
    /// val="major"/>` (Headings). A scheme shows the FILE theme's font ([LIVE]
    /// round 17: `Calibri Light` + `major` showed Cambria, the library
    /// theme's), so the export writes the workbook theme's font by name, with
    /// the scheme only where the file theme's font is that font: Body =
    /// Calibri + `minor`; Headings = Calibri Light, by name. In cells and in
    /// rich-text runs. They read back as `Body` / `Headings` (which the reader
    /// used to call "Heading", a keyword no theme resolves).
    ///
    /// SABOTAGE: `with_excel_font_name` writes the family literally -- fails
    /// at "LITERAL THEME FONT".
    #[test]
    fn theme_fonts_are_written_as_excels_theme_font_references() {
        let mut sheet = Sheet::new("Fonts".to_string());
        let mut body_bold = CellStyle::new();
        body_bold.font.bold = true;
        let mut heading = CellStyle::new();
        heading.font.family = "Headings".to_string();
        let mut named = CellStyle::new();
        named.font.family = "Consolas".to_string();
        sheet.styles.push(body_bold);
        sheet.styles.push(heading);
        sheet.styles.push(named);
        let text = |t: &str, style_index: usize, runs: Option<serde_json::Value>| SavedCell {
            value: SavedCellValue::Text(t.to_string()),
            formula: None,
            style_index,
            rich_text: runs.map(|r| serde_json::from_value(r).unwrap()),
            spill: None,
        };
        sheet.cells.insert((0, 0), text("body", 1, None));
        sheet.cells.insert((1, 0), text("head", 2, None));
        sheet.cells.insert((2, 0), text("mono", 3, None));
        sheet.cells.insert((3, 0), text("a head", 1, Some(serde_json::json!([{ "text": "a " }, { "text": "head", "fontFamily": "Headings" }]))));
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        workbook.sheets.push(sheet);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("theme-fonts.xlsx");
        save_xlsx(&workbook, &path).unwrap();
        keep_for_live_probe(&path);
        let styles = sheet_part_of(&path, "xl/styles.xml");
        let sst = sheet_part_of(&path, "xl/sharedStrings.xml");
        for part in [&styles, &sst] {
            assert!(!part.contains("val=\"Body\"") && !part.contains("val=\"Headings\""), "LITERAL THEME FONT: {}", part);
        }
        assert!(styles.contains(r#"<b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/>"#), "LITERAL THEME FONT: no Body font in {}", styles);
        assert!(styles.contains(r#"<name val="Calibri Light"/><family val="2"/></font>"#), "LITERAL THEME FONT: no Headings font in {}", styles);
        assert!(!styles.contains(r#"<scheme val="major"/>"#), "a major scheme would show the file theme's Cambria: {}", styles);
        assert!(styles.contains(r#"<name val="Consolas"/><family val="2"/></font>"#), "a named font is no theme font: {}", styles);
        assert!(sst.contains(r#"<rFont val="Calibri Light"/><family val="2"/></rPr>"#), "LITERAL THEME FONT: the run in {}", sst);
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let sheet = &loaded.sheets[0];
        let family = |row: u32| sheet.styles[sheet.cells[&(row, 0)].style_index].font.family.clone();
        assert_eq!(family(0), "Body");
        assert_eq!(family(1), "Headings");
        assert_eq!(family(2), "Consolas");
        let runs = sheet.cells[&(3, 0)].rich_text.clone().expect("the runs were lost");
        assert_eq!(runs[1].font_family.as_deref(), Some("Headings"));
    }

    /// xlsx4 (round 16): a name scoped to a sheet whose name holds a `!`
    /// (Excel allows `a!b`) was dropped: the library splits a scoped name at
    /// its first `!`. [LIVE] Excel 16 (round 17) saves it as
    /// `<definedName name="Rate" localSheetId="1">'a!b'!$B$1</definedName>`;
    /// the export writes it so, and it comes back scoped to that sheet.
    ///
    /// SABOTAGE: hand such a name to the library again -- fails at "BANG SCOPE".
    #[test]
    fn a_name_scoped_to_a_sheet_with_a_bang_is_written_as_excel_does() {
        let mut first = Sheet::new("Main".to_string());
        first.cells.insert((0, 0), SavedCell { value: SavedCellValue::Number(1.0), formula: None, style_index: 0, rich_text: None, spill: None });
        let mut bang = Sheet::new("a!b".to_string());
        bang.cells.insert((0, 1), SavedCell { value: SavedCellValue::Number(0.25), formula: None, style_index: 0, rich_text: None, spill: None });
        let bang_id = bang.id;
        let mut workbook = Workbook::new();
        workbook.sheets.clear();
        workbook.sheets.push(first);
        workbook.sheets.push(bang);
        workbook.named_ranges = vec![
            crate::SavedNamedRange { name: "Rate".to_string(), refers_to: "='a!b'!$B$1".to_string(), sheet_id: Some(bang_id), comment: None, folder: None },
            crate::SavedNamedRange { name: "Base".to_string(), refers_to: "=Main!$A$1".to_string(), sheet_id: None, comment: None, folder: None },
            crate::SavedNamedRange { name: "Twice".to_string(), refers_to: "=LAMBDA(x,x*2)".to_string(), sheet_id: Some(bang_id), comment: None, folder: None },
        ];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bang-scope.xlsx");
        let losses = save_xlsx_reporting_losses(&workbook, &path, false).unwrap();
        keep_for_live_probe(&path);
        assert!(losses.is_empty(), "BANG SCOPE: {:?}", losses);
        let book = workbook_part_of(&path);
        for expected in [
            r#"<definedName name="Rate" localSheetId="1">'a!b'!$B$1</definedName>"#,
            r#"<definedName name="Base">Main!$A$1</definedName>"#,
            r#"<definedName name="Twice" localSheetId="1">_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2)</definedName>"#,
        ] {
            assert!(book.contains(expected), "BANG SCOPE: expected {} in {}", expected, book);
        }
        assert_eq!(book.matches("<definedNames>").count(), 1, "one definedNames element: {}", book);
        let loaded = crate::xlsx_reader::load_xlsx(&path).unwrap();
        let scoped: Vec<(&str, Option<identity::SheetId>)> = loaded.named_ranges.iter().map(|n| (n.name.as_str(), n.sheet_id)).collect();
        assert!(scoped.contains(&("Rate", Some(loaded.sheets[1].id))), "the scoped name lost its sheet: {:?}", scoped);
        assert!(scoped.contains(&("Base", None)), "the global name was lost: {:?}", scoped);
        assert!(scoped.contains(&("Twice", Some(loaded.sheets[1].id))), "{:?}", scoped);
        // The part's own shapes: no definedNames yet, and a second statement.
        let names = [LocalDefinedName { name: "R".to_string(), sheet_position: 0, formula: "'a!b'!$A$1".to_string() }];
        assert_eq!(
            with_local_defined_names("<workbook><sheets/><calcPr calcId=\"1\"/></workbook>", &names).unwrap(),
            "<workbook><sheets/><definedNames><definedName name=\"R\" localSheetId=\"0\">'a!b'!$A$1</definedName></definedNames><calcPr calcId=\"1\"/></workbook>"
        );
        let once = with_local_defined_names("<workbook><sheets/><calcPr/></workbook>", &names).unwrap();
        assert!(with_local_defined_names(&once, &names).is_err(), "a scoped name was written twice");
    }
}
