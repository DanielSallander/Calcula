//! FILENAME: app/src-tauri/src/chart_range_shift.rs
//! PURPOSE: Chart and sparkline DATA RANGES follow a structural edit (BUG-0357):
//!          insert/delete rows or columns, and Excel's Insert/Delete Cells.
//! CONTEXT: A child of `chart_commands` (declared there with `#[path]`). Every
//!          structural command calls [`shift_chart_and_sparkline_ranges`]
//!          INSIDE its open undo transaction, beside the other coordinate-store
//!          shifters in `commands/structure.rs`, so one Ctrl+Z puts the cells
//!          and the charts back together (the stores record `obj_chart` /
//!          `obj_sparklines` restores, whose undo already announces the
//!          `objects` domain the two extensions re-read on).
//!
//! THE RULES, measured on live Excel 16 (2026-10-29, fresh unsaved workbooks
//! over COM; a chart over Sheet1!A1:C5 -- header row, categories in A, series
//! B and C -- and a sparkline group E2:E5 over A2:C5):
//!
//! A chart range is ONE rectangle here (`spec.data`), where Excel keeps one
//! SERIES formula per series. Each series line (a column, or a row for series
//! in rows) is therefore treated as its own reference, the way Excel's are:
//!
//! 1. An edit ALONG THE POINTS (rows for series in columns) moves the lines as
//!    references: inserting inside the range grows it (row 3 -> A1:C6), at or
//!    above its first row moves it (row 1 -> A2:C6), just after it changes
//!    nothing; deleting inside shrinks it, deleting every row is `#REF!`. With
//!    Insert/Delete Cells a line outside the band keeps its address; when the
//!    band holds every SERIES line (not the category line) the range follows
//!    the series (Excel: values B2:B6 while the categories stay A2:A5 -- the
//!    fifth point has no label there, here it reads the cell under the
//!    category column); when the series lines part ways the range keeps its
//!    address (one rectangle cannot hold both).
//! 2. An edit ALONG THE SERIES (columns for series in columns) re-points each
//!    series: inserting column C makes series C column D, the inserted column
//!    is no series; deleting a series' column takes the series out of the
//!    chart (Excel leaves it as a `#REF!` series that plots nothing -- a range
//!    chart cannot hold one); deleting the category column leaves Excel with
//!    1, 2, 3 ... labels, here the category moves to the first line that is no
//!    series (or the first line, when every line is one).
//! 3. The HEADER ROW deleted (every surviving series' name cell gone) turns
//!    the header row off, so the data under it is still all plotted -- Excel
//!    keeps every value and shows the names as `#REF!`; the stored series
//!    names stay here.
//! 4. A range on ANOTHER sheet than the chart follows ITS sheet: a range is
//!    matched by its sheet id when it has one, by its sheet index otherwise; a
//!    sheet-qualified A1 string (`Sheet1!A1:C5`, what a script or an AI tool
//!    may store) by its sheet name. An UNQUALIFIED string means the active
//!    sheet at read time and a defined name follows its own definition, so
//!    neither is rewritten. A model / design-query / PivotChart source has no
//!    cells and is never touched.
//! 5. KNOWN DIVERGENCE: inserting at the FIRST DATA ROW (row 2 under a header
//!    in row 1) grows the range here; Excel moves the values (B3:B6) and keeps
//!    the name in B1, which one rectangle cannot say. The inserted row is an
//!    empty point.
//! 6. A chart PARAMETER's cells -- `params[].cellRef` (the cell a param reads)
//!    and `params[].writeTo` (the cell a point selection writes back) -- are
//!    one unqualified cell each, on the sheet `locateParamCell`
//!    (Charts/lib/dataSourceResolver.ts) names: the sheet the chart is placed
//!    on, or, for a chart on a CANVAS (which has no cells), the sheet its data
//!    comes from ([`ParamHost`]) -- a DEFINED NAME's data included: the sheet
//!    its definition names, else the sheet it is scoped to, as
//!    `resolveDataSource` resolves it ([`DefinedNameSheets`]; rev3C#4). They
//!    move as a formula's `=B1` does: a row
//!    inserted above makes it `=B2`, and a deleted cell is `=#REF!`, which the
//!    param reader treats as no cell (it reads the literal default and the
//!    write-back is skipped). Moved inside the same `obj_chart` restore.
//!
//! SPARKLINES (Excel: each sparkline is its own cell over its own data line):
//! a group is cut into its (location cell, data line) pairs, the cell moves
//! like a cell and the line like a reference, and an INSERTED cell right after
//! a sparkline cell takes a copy of it, its line offset like a copied formula
//! (Excel's "format same as above": a row inserted inside OR just after a
//! column group grows it by one sparkline over the inserted data row). The
//! pairs are packed back into as few AREAS as their cells allow; a deleted
//! cell or a deleted line leaves the group (Excel keeps a `#REF!` sparkline
//! that draws nothing), and a group with no pair left is removed.
//!
//! GROUP IDENTITY (measured live 2026-10-29 and 2026-10-30): Excel keeps a
//! group ONE group whatever the edit does to its cells -- E2:E6 over A2:C6
//! with column F inserted is one group of ten (location `E2,F2,E3,F3,...`,
//! F2 over B2:D2), a row group A8:C8 with row 9 inserted is one group of six,
//! and an Insert Cells that parts its sparklines leaves one group. A group is
//! therefore one or more AREAS, each a location rectangle over a data
//! rectangle: the first is the group's own `location` / `dataRange`, the rest
//! ride `moreAreas` (`[{location, dataRange}, ...]`, absent when there are
//! none; Sparklines/types.ts `SparklineGroup.moreAreas`). Every area is
//! shifted by the same rules, and an edit that parts a group's sparklines
//! adds areas to it, never a second group -- so a later group-level edit
//! (Sparkline Design's type, colour, markers, axis) reaches every sparkline
//! the group had, as in Excel.

use crate::commands::coord_shift::CellRange;
use crate::commands::structure::structure_cells::BandEdit;
use crate::document_effect::DocumentEffect;
use crate::AppState;
use serde_json::{Map, Value};

#[cfg(test)]
#[path = "chart_range_shift_tests.rs"]
mod tests;

/// What a range whose every cell was deleted becomes: Excel's `#REF!`. The
/// chart keeps its series and plots nothing; its Select Data shows `#REF!`.
pub(crate) const REF_ERROR_SOURCE: &str = "#REF!";

/// The undo description of the restores this module records.
const SHIFT_DESCRIPTION: &str = "Shift chart and sparkline ranges";

/// Same bound as the sheet-id stamp walk (`MAX_CONCAT_STAMP_DEPTH`).
const MAX_CONCAT_DEPTH: usize = 16;

// ============================================================================
// The edited sheet
// ============================================================================

/// The sheet a structural edit happened on, as a chart range can name it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct EditedSheet<'a> {
    pub(crate) index: usize,
    /// The sheet's stable id (`SheetId::to_string()`), what a stamped range carries.
    pub(crate) id: &'a str,
    /// The sheet's name, what a sheet-qualified A1 string carries.
    pub(crate) name: &'a str,
}

/// Which sheet a chart's PARAM cells are on (module header, rule 6): what
/// `locateParamCell` (Charts/lib/dataSourceResolver.ts) decides from where the
/// chart is PLACED.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ParamHost<'a> {
    /// Placed on a worksheet: its param cells are on that sheet, and `edited`
    /// says whether that is the sheet the structural edit happened on.
    Worksheet { edited: bool },
    /// Placed on a canvas, which has no cells: its param cells are on the
    /// sheet its data comes from (none, for a pivot or model source). `names`
    /// answers that for a data source that is a defined name.
    Canvas { names: &'a DefinedNameSheets },
}

/// The sheet a defined name's range is on, as `resolveDataSource`
/// (Charts/lib/dataSourceResolver.ts) finds it for a chart whose data is the
/// name: the sheet its definition names (`=Sheet1!$A$1:$C$5`), else -- an
/// unqualified definition -- the sheet the name is scoped to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum NameSheet {
    /// The definition names this sheet (matched by name, case aside).
    Named(String),
    /// An unqualified definition on a sheet-scoped name: this sheet index.
    Scope(usize),
}

/// Every defined name a chart can read as its data, by its registry key (the
/// upper-cased name, what `get_named_range` looks it up by), with the sheet
/// its range is on. A name whose definition is no plain A1 range (a constant,
/// a formula, a whole column -- `resolveDataSource` refuses each) or that is
/// unqualified and workbook-scoped (read on whatever sheet is ACTIVE when the
/// chart draws) is not here: its chart has no data sheet the edit could be on.
pub(crate) type DefinedNameSheets = std::collections::HashMap<String, NameSheet>;

/// [`DefinedNameSheets`] for the workbook's names.
pub(crate) fn defined_name_sheets(
    names: &std::collections::HashMap<String, crate::named_ranges::NamedRange>,
) -> DefinedNameSheets {
    names
        .iter()
        .filter_map(|(key, name)| name_definition_sheet(&name.refers_to, name.sheet_index).map(|s| (key.clone(), s)))
        .collect()
}

/// The sheet one definition is on (`parseRefersToFormula` then
/// `resolveDataSource`). A range deleted whole keeps its qualifier
/// (`=Sheet1!#REF!`), and keeps its sheet here too: like a chart's own range,
/// the param cells' sheet is decided as it was BEFORE the range went (the
/// name has already been rewritten by the time the charts are shifted).
pub(crate) fn name_definition_sheet(refers_to: &str, scope: Option<usize>) -> Option<NameSheet> {
    let body = refers_to.trim();
    let body = body.strip_prefix('=').unwrap_or(body).trim();
    if let Some(head) = body.strip_suffix(REF_ERROR_SOURCE) {
        return match head.strip_suffix('!') {
            Some(qualifier) => unquote_sheet_qualifier(qualifier).map(NameSheet::Named),
            None if head.trim().is_empty() => scope.map(NameSheet::Scope),
            None => None,
        };
    }
    match split_qualified(body) {
        Some((_, sheet, range)) => is_plain_a1(range).then_some(NameSheet::Named(sheet)),
        None if !body.contains('!') && is_plain_a1(body) => scope.map(NameSheet::Scope),
        None => None,
    }
}

/// Does a chart's `data` read a defined name whose range is on the edited
/// sheet? `resolveDataSource` reads a string as an A1 reference FIRST and as a
/// name only when it is none, by the trimmed text as written.
fn defined_name_on_sheet(source: &Value, names: &DefinedNameSheets, sheet: &EditedSheet) -> bool {
    let Some(key) = defined_name_key(source) else { return false };
    match names.get(&key) {
        Some(NameSheet::Named(name)) => sheet.names_sheet(name),
        Some(NameSheet::Scope(index)) => *index == sheet.index,
        None => false,
    }
}

/// The registry key (`name_resolution::name_key`) of the defined name a chart's
/// `data` reads, or `None` when it reads no name: not a string, empty, or an
/// A1 reference -- `resolveDataSource` (Charts/lib/dataSourceResolver.ts)
/// tries the trimmed text as an A1 reference FIRST and as a name only when it
/// is none. Shared with the binding surface's `chart_data_sheet`
/// (`object_bindings/formula.rs`), so a canvas chart's bound title and its
/// param cells agree on the sheet a name-sourced chart reads.
pub(crate) fn defined_name_key(source: &Value) -> Option<String> {
    let Value::String(text) = source else { return None };
    let text = text.trim();
    if text.is_empty() || is_plain_a1(split_qualified(text).map_or(text, |(_, _, range)| range)) {
        return None;
    }
    Some(crate::name_resolution::name_key(text))
}

/// `parseA1Reference`'s range form (Charts/lib/dataSourceResolver.ts): one
/// cell or one `cell:cell` rectangle, `$` anywhere, case aside, rows from 1.
/// Not a whole column (`A:C`), which that reader refuses.
fn is_plain_a1(range: &str) -> bool {
    fn cell(text: &str) -> bool {
        let letters = text.chars().take_while(|c| c.is_ascii_alphabetic()).count();
        let digits = &text[letters..];
        letters > 0
            && !digits.is_empty()
            && digits.chars().all(|c| c.is_ascii_digit())
            && digits.chars().any(|c| c != '0')
    }
    let text: String = range.chars().filter(|c| *c != '$').collect();
    let text = text.trim();
    match text.split_once(':') {
        Some((start, end)) => cell(start) && cell(end),
        None => cell(text),
    }
}

impl EditedSheet<'_> {
    /// Does this DataRangeRef read the edited sheet? By id when it has one --
    /// an index is right only against the sheet list it was written for.
    fn names_ref(&self, range: &Map<String, Value>) -> bool {
        match range.get("sheetId") {
            Some(Value::String(id)) if !id.is_empty() => id == self.id,
            _ => range.get("sheetIndex").and_then(Value::as_u64) == Some(self.index as u64),
        }
    }

    /// Does a sheet qualifier name the edited sheet? Excel compares sheet
    /// names without regard to case.
    fn names_sheet(&self, name: &str) -> bool {
        !self.name.is_empty() && identity::sheet_names_equal(name, &self.name)
    }
}

// ============================================================================
// The rule for one chart range (pure)
// ============================================================================

/// How a chart reads its range: the header row, the series axis, the category
/// line and each series' line (offsets into the range).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SeriesShape {
    pub(crate) has_headers: bool,
    /// Series in columns (`seriesOrientation: "columns"`), or in rows.
    pub(crate) columns: bool,
    pub(crate) category: u32,
    pub(crate) series: Vec<u32>,
}

/// Where a chart range goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RangeShift {
    /// Nothing the chart reads moved.
    Same,
    /// Every cell was deleted: the source becomes [`REF_ERROR_SOURCE`].
    Gone,
    Moved {
        rect: CellRange,
        /// Each series' new offset (in `SeriesShape::series` order); `None`
        /// for one whose line was deleted -- it leaves the chart.
        series: Vec<Option<u32>>,
        category: u32,
        has_headers: bool,
    },
}

/// The rule for ONE chart range (see the module header, rules 1-3).
pub(crate) fn shift_chart_range(r: CellRange, shape: &SeriesShape, band: &BandEdit) -> RangeShift {
    let rows_edit = band.moves_rows();
    // The edit runs along the series axis: it adds or removes series lines.
    let along_series = shape.columns != rows_edit;
    let mut series: Vec<Option<u32>> = shape.series.iter().map(|&k| Some(k)).collect();
    let mut category = shape.category;

    let rect = if along_series {
        let Some(next) = band.shift_reference_range(r) else { return RangeShift::Gone };
        if next == r {
            return RangeShift::Same;
        }
        // Inside the band every line moves as a reference, so each offset is
        // re-pointed; across it only Excel's TRIM can change the range, and
        // that cuts the OTHER axis, so the offsets stand.
        if band.within_band(&r) {
            let (old_start, new_start, width) = if rows_edit {
                (r.start_row, next.start_row, next.end_row - next.start_row + 1)
            } else {
                (r.start_col, next.start_col, next.end_col - next.start_col + 1)
            };
            let remap = |k: u32| -> Option<u32> {
                band.shift_reference_point(old_start.saturating_add(k))
                    .and_then(|abs| abs.checked_sub(new_start))
            };
            series = shape.series.iter().map(|&k| remap(k)).collect();
            category = match remap(shape.category) {
                Some(c) => c,
                None => (0..width)
                    .find(|i| !series.iter().any(|s| *s == Some(*i)))
                    .unwrap_or(0),
            };
        }
        next
    } else {
        // Along the points: each series line is its own reference.
        let (a0, a1, p0, p1) = if rows_edit {
            (r.start_row, r.end_row, r.start_col, r.end_col)
        } else {
            (r.start_col, r.end_col, r.start_row, r.end_row)
        };
        let in_band = |p: u32| p >= band.band_start && p <= band.band_end;
        let lo = p0.max(band.band_start);
        let hi = p1.min(band.band_end);
        let overlap = if lo > hi { 0 } else { hi - lo + 1 };
        let total = p1 - p0 + 1;
        let decided = if overlap == 0 {
            return RangeShift::Same;
        } else if overlap == total {
            band.shift_reference_interval(a0, a1)
        } else {
            let plotted: Vec<u32> = shape
                .series
                .iter()
                .filter_map(|k| p0.checked_add(*k))
                .filter(|p| *p <= p1)
                .collect();
            if !plotted.is_empty() && plotted.iter().all(|p| in_band(*p)) {
                band.shift_reference_interval(a0, a1)
            } else {
                // No series line in the band, or the series lines part ways:
                // one rectangle cannot follow both, so the address stays.
                return RangeShift::Same;
            }
        };
        let Some((n0, n1)) = decided else { return RangeShift::Gone };
        if (n0, n1) == (a0, a1) {
            return RangeShift::Same;
        }
        if rows_edit {
            CellRange { start_row: n0, end_row: n1, ..r }
        } else {
            CellRange { start_col: n0, end_col: n1, ..r }
        }
    };

    // Rule 3: the header row deleted under every surviving series.
    let mut has_headers = shape.has_headers;
    if has_headers {
        let header_cells: Vec<(u32, u32)> = shape
            .series
            .iter()
            .zip(series.iter())
            .filter(|(_, now)| now.is_some())
            .map(|(&k, _)| {
                if shape.columns {
                    (r.start_row, r.start_col.saturating_add(k))
                } else {
                    (r.start_row.saturating_add(k), r.start_col)
                }
            })
            .collect();
        if !header_cells.is_empty() && header_cells.iter().all(|&(row, col)| band.shift_cell(row, col).is_none()) {
            has_headers = false;
        }
    }

    let series_same = series.iter().zip(&shape.series).all(|(now, was)| *now == Some(*was));
    if rect == r && series_same && category == shape.category && has_headers == shape.has_headers {
        return RangeShift::Same;
    }
    RangeShift::Moved { rect, series, category, has_headers }
}

// ============================================================================
// Ranges as the spec stores them
// ============================================================================

fn u32_field(map: &Map<String, Value>, key: &str) -> Option<u32> {
    map.get(key).and_then(Value::as_u64).and_then(|v| u32::try_from(v).ok())
}

/// The cells of a DataRangeRef object (any corner order), or `None` when it is not one.
fn ref_rect(range: &Map<String, Value>) -> Option<CellRange> {
    let (sr, sc, er, ec) = (
        u32_field(range, "startRow")?,
        u32_field(range, "startCol")?,
        u32_field(range, "endRow")?,
        u32_field(range, "endCol")?,
    );
    Some(CellRange { start_row: sr.min(er), end_row: sr.max(er), start_col: sc.min(ec), end_col: sc.max(ec) })
}

fn write_ref_rect(range: &mut Map<String, Value>, r: CellRange) {
    range.insert("startRow".to_string(), Value::from(r.start_row));
    range.insert("startCol".to_string(), Value::from(r.start_col));
    range.insert("endRow".to_string(), Value::from(r.end_row));
    range.insert("endCol".to_string(), Value::from(r.end_col));
}

/// A sheet-qualified A1 string, split: the qualifier text (with its `!`), the
/// sheet name it names, and the range part. `None` for an unqualified string,
/// a defined name or `#REF!`.
fn split_qualified(text: &str) -> Option<(&str, String, &str)> {
    let bang = text.rfind('!')?;
    let (prefix, range) = (&text[..=bang], &text[bang + 1..]);
    let name = unquote_sheet_qualifier(&prefix[..prefix.len() - 1])?;
    if range.trim().is_empty() {
        return None;
    }
    Some((prefix, name, range))
}

/// The sheet name a qualifier (the text before its `!`) names: unquoted, its
/// doubled quotes undone. `None` for an empty one.
fn unquote_sheet_qualifier(qualifier: &str) -> Option<String> {
    let raw = qualifier.trim();
    let name = if raw.len() >= 2 && raw.starts_with('\'') && raw.ends_with('\'') {
        raw[1..raw.len() - 1].replace("''", "'")
    } else {
        raw.to_string()
    };
    (!name.is_empty()).then_some(name)
}

/// The cells an A1 range part names (`A1:C5`, `$A$1:$C$5`, `B2`, `A:C`).
fn parse_a1_rect(range: &str) -> Option<CellRange> {
    let range = range.trim();
    let text = if range.contains(':') { range.to_string() } else { format!("{0}:{0}", range) };
    let ((sr, sc), (er, ec)) = crate::pivot::utils::parse_range(&text).ok()?;
    Some(CellRange { start_row: sr, end_row: er, start_col: sc, end_col: ec })
}

/// An A1 range part for `r`, in the form the original used: absolute when it
/// carried a `$`, whole columns when it named whole columns and still spans
/// every row.
fn format_a1_rect(r: CellRange, original: &str) -> String {
    use crate::pivot::utils::col_index_to_letter as col;
    let abs = if original.contains('$') { "$" } else { "" };
    let whole_columns = !original.chars().any(|c| c.is_ascii_digit());
    if whole_columns && r.start_row == 0 && r.end_row >= engine::EXCEL_MAX_ROW_INDEX {
        return format!("{abs}{}:{abs}{}", col(r.start_col), col(r.end_col));
    }
    if r.start_row == r.end_row && r.start_col == r.end_col && !original.contains(':') {
        return format!("{abs}{}{abs}{}", col(r.start_col), r.start_row + 1);
    }
    format!(
        "{abs}{}{abs}{}:{abs}{}{abs}{}",
        col(r.start_col),
        r.start_row + 1,
        col(r.end_col),
        r.end_row + 1
    )
}

/// A range source the edited sheet holds: a DataRangeRef object naming it, or
/// an A1 string qualified with its name.
enum SourceCells {
    Object(CellRange),
    Text { prefix: String, range: String, rect: CellRange },
}

fn source_cells(source: &Value, sheet: &EditedSheet) -> Option<SourceCells> {
    match source {
        Value::Object(range) => {
            if !range.contains_key("startRow") || !sheet.names_ref(range) {
                return None;
            }
            ref_rect(range).map(SourceCells::Object)
        }
        Value::String(text) => {
            let (prefix, name, range) = split_qualified(text)?;
            if !sheet.names_sheet(&name) {
                return None;
            }
            let rect = parse_a1_rect(range)?;
            Some(SourceCells::Text { prefix: prefix.to_string(), range: range.to_string(), rect })
        }
        _ => None,
    }
}

/// Put the source at `rect` (keeping its form), or `#REF!` for `None`.
fn rewrite_source(slot: &mut Value, cells: &SourceCells, rect: Option<CellRange>) {
    let Some(rect) = rect else {
        *slot = Value::String(REF_ERROR_SOURCE.to_string());
        return;
    };
    match cells {
        SourceCells::Object(_) => {
            if let Value::Object(range) = slot {
                write_ref_rect(range, rect);
            }
        }
        SourceCells::Text { prefix, range, .. } => {
            *slot = Value::String(format!("{}{}", prefix, format_a1_rect(rect, range)));
        }
    }
}

impl SourceCells {
    fn rect(&self) -> CellRange {
        match self {
            SourceCells::Object(r) => *r,
            SourceCells::Text { rect, .. } => *rect,
        }
    }
}

// ============================================================================
// The spec walk
// ============================================================================

/// The (array position, offset) of each series that has a numeric `sourceIndex`.
fn series_offsets(series: Option<&Value>) -> Vec<(usize, u32)> {
    let Some(Value::Array(items)) = series else { return Vec::new() };
    items
        .iter()
        .enumerate()
        .filter_map(|(i, s)| s.as_object().and_then(|o| u32_field(o, "sourceIndex")).map(|k| (i, k)))
        .collect()
}

/// Re-point the series array; returns the array positions that left the chart.
fn apply_series(series: Option<&mut Value>, offsets: &[(usize, u32)], next: &[Option<u32>]) -> Vec<usize> {
    let Some(Value::Array(items)) = series else { return Vec::new() };
    let mut removed = Vec::new();
    for ((pos, _), now) in offsets.iter().zip(next) {
        match now {
            Some(k) => {
                if let Some(Value::Object(s)) = items.get_mut(*pos) {
                    s.insert("sourceIndex".to_string(), Value::from(*k));
                }
            }
            None => removed.push(*pos),
        }
    }
    removed.sort_unstable();
    for pos in removed.iter().rev() {
        if *pos < items.len() {
            items.remove(*pos);
        }
    }
    removed
}

/// Where a series-array index goes once `removed` positions left: `None` when
/// it was one of them.
fn reindex(index: u64, removed: &[usize]) -> Option<u64> {
    if removed.iter().any(|p| *p as u64 == index) {
        return None;
    }
    Some(index - removed.iter().filter(|p| (**p as u64) < index).count() as u64)
}

/// Everything a spec keys by series-ARRAY index follows the removed series out:
/// trendlines and point overrides on a removed series go, later ones step down;
/// hidden-series filters likewise; the per-series SERIES refs stay aligned.
fn reindex_series_keyed(spec: &mut Map<String, Value>, removed: &[usize]) {
    if removed.is_empty() {
        return;
    }
    for key in ["trendlines", "dataPointOverrides"] {
        if let Some(Value::Array(items)) = spec.get_mut(key) {
            items.retain_mut(|item| {
                let Value::Object(o) = item else { return true };
                // A trendline without one applies to series 0.
                let at = o.get("seriesIndex").and_then(Value::as_u64).unwrap_or(0);
                match reindex(at, removed) {
                    Some(n) => {
                        if o.contains_key("seriesIndex") || n != at {
                            o.insert("seriesIndex".to_string(), Value::from(n));
                        }
                        true
                    }
                    None => false,
                }
            });
        }
    }
    if let Some(Value::Object(filters)) = spec.get_mut("filters") {
        if let Some(Value::Array(hidden)) = filters.get_mut("hiddenSeries") {
            let kept: Vec<Value> = hidden
                .iter()
                .filter_map(|v| v.as_u64().and_then(|i| reindex(i, removed)).map(Value::from))
                .collect();
            *hidden = kept;
        }
    }
    if let Some(Value::Array(refs)) = spec.get_mut("seriesRefs") {
        for pos in removed.iter().rev() {
            if *pos < refs.len() {
                refs.remove(*pos);
            }
        }
    }
}

/// Shift a sheet-qualified A1 reference string as a plain reference (the
/// per-series SERIES refs, display only). Returns the new text when it moved.
fn shift_reference_text(text: &str, sheet: &EditedSheet, band: &BandEdit) -> Option<String> {
    let (prefix, name, range) = split_qualified(text)?;
    if !sheet.names_sheet(&name) {
        return None;
    }
    let rect = parse_a1_rect(range)?;
    let next = match band.shift_reference_range(rect) {
        Some(n) if n == rect => return None,
        Some(n) => format!("{}{}", prefix, format_a1_rect(n, range)),
        None => REF_ERROR_SOURCE.to_string(),
    };
    Some(next)
}

/// Shift one PARAM cell (module header, rule 6) as a reference. The text is
/// the one form the param reader accepts (`parseParamCellTarget`,
/// Charts/lib/dataSourceResolver.ts): one unqualified cell, `=B1` or `B1`
/// (`B1:B1` reads as the same cell). Anything else -- a range, a
/// sheet-qualified cell, a defined name, `#REF!` -- is not a cell the reader
/// would use, and is left as it is. Returns the new text when it moved, in its
/// own form (the `=`, and `$` when it carried one); a deleted cell is `#REF!`.
fn shift_param_cell_text(text: &str, band: &BandEdit) -> Option<String> {
    let (eq, rest) = match text.strip_prefix('=') {
        Some(rest) => ("=", rest),
        None => ("", text),
    };
    let body = rest.trim();
    if body.is_empty() || body.contains('!') {
        return None;
    }
    let rect = parse_a1_rect(body)?;
    if rect.start_row != rect.end_row || rect.start_col != rect.end_col {
        return None;
    }
    match band.shift_reference_range(rect) {
        Some(next) if next == rect => None,
        Some(next) => Some(format!("{eq}{}", format_a1_rect(next, body))),
        None => Some(format!("{eq}{REF_ERROR_SOURCE}")),
    }
}

/// Shift the cells of every param this spec declares (`params[].cellRef`,
/// `params[].writeTo`). The caller has decided they are on the edited sheet.
fn shift_param_cells(spec: &mut Map<String, Value>, band: &BandEdit) -> bool {
    let Some(Value::Array(params)) = spec.get_mut("params") else { return false };
    let mut changed = false;
    for param in params.iter_mut() {
        let Value::Object(param) = param else { continue };
        for key in ["cellRef", "writeTo"] {
            let Some(Value::String(text)) = param.get(key) else { continue };
            if let Some(next) = shift_param_cell_text(text, band) {
                param.insert(key.to_string(), Value::String(next));
                changed = true;
            }
        }
    }
    changed
}

fn shift_series_refs(spec: &mut Map<String, Value>, sheet: &EditedSheet, band: &BandEdit) -> bool {
    let Some(Value::Array(refs)) = spec.get_mut("seriesRefs") else { return false };
    let mut changed = false;
    for item in refs.iter_mut() {
        let Value::Object(o) = item else { continue };
        for key in ["nameRef", "catRef", "valRef"] {
            if let Some(Value::String(text)) = o.get(key) {
                if let Some(next) = shift_reference_text(text, sheet, band) {
                    o.insert(key.to_string(), Value::String(next));
                    changed = true;
                }
            }
        }
    }
    changed
}

/// Shift every range one spec reads: `data`, each layer's own `data`, a
/// lookup transform's `from` and the `concat` children, recursively -- the
/// four places `stamp_chart_record_sheet_ids` (chart_commands.rs) walks, and
/// the drift test `the_shift_walk_reaches_every_place_the_stamp_walk_does`
/// holds the two together -- and the spec's PARAM cells when `host` puts them
/// on the edited sheet (rule 6; a `concat` child's own params are read against
/// the child's own data, as `resolveParams(childSpec, chartId)` reads them).
pub(crate) fn shift_chart_spec(
    spec: &mut Value,
    sheet: &EditedSheet,
    band: &BandEdit,
    host: ParamHost,
    depth: usize,
) -> bool {
    let Value::Object(spec) = spec else { return false };
    let mut changed = false;

    // Decided BEFORE the data moves (a deleted range becomes `#REF!`, which
    // names no sheet): on a canvas, the params are where the data is -- a
    // defined name's included, on the sheet its range is on (rev3C#4).
    let params_here = match host {
        ParamHost::Worksheet { edited } => edited,
        ParamHost::Canvas { names } => spec
            .get("data")
            .is_some_and(|d| source_cells(d, sheet).is_some() || defined_name_on_sheet(d, names, sheet)),
    };
    if params_here {
        changed |= shift_param_cells(spec, band);
    }

    let shape = SeriesShape {
        has_headers: spec.get("hasHeaders").and_then(Value::as_bool).unwrap_or(true),
        columns: spec.get("seriesOrientation").and_then(Value::as_str) != Some("rows"),
        category: u32_field(spec, "categoryIndex").unwrap_or(0),
        series: series_offsets(spec.get("series")).into_iter().map(|(_, k)| k).collect(),
    };

    // The chart's own source, and everything it keys by its lines.
    if let Some(cells) = spec.get("data").and_then(|d| source_cells(d, sheet)) {
        let offsets = series_offsets(spec.get("series"));
        match shift_chart_range(cells.rect(), &shape, band) {
            RangeShift::Same => {}
            RangeShift::Gone => {
                if let Some(slot) = spec.get_mut("data") {
                    rewrite_source(slot, &cells, None);
                }
                changed = true;
            }
            RangeShift::Moved { rect, series, category, has_headers } => {
                if let Some(slot) = spec.get_mut("data") {
                    rewrite_source(slot, &cells, Some(rect));
                }
                let removed = apply_series(spec.get_mut("series"), &offsets, &series);
                reindex_series_keyed(spec, &removed);
                spec.insert("categoryIndex".to_string(), Value::from(category));
                spec.insert("hasHeaders".to_string(), Value::Bool(has_headers));
                changed = true;
            }
        }
    }
    changed |= shift_series_refs(spec, sheet, band);

    // A layer with its own source: read with the chart's header row, axis and
    // category, its own series (the chart's when it has none).
    if let Some(Value::Array(layers)) = spec.get_mut("layers") {
        for layer in layers.iter_mut() {
            let Value::Object(layer) = layer else { continue };
            let Some(cells) = layer.get("data").and_then(|d| source_cells(d, sheet)) else { continue };
            let offsets = if layer.contains_key("series") { series_offsets(layer.get("series")) } else { Vec::new() };
            let layer_shape = SeriesShape {
                series: if layer.contains_key("series") { offsets.iter().map(|(_, k)| *k).collect() } else { shape.series.clone() },
                ..shape.clone()
            };
            match shift_chart_range(cells.rect(), &layer_shape, band) {
                RangeShift::Same => {}
                RangeShift::Gone => {
                    if let Some(slot) = layer.get_mut("data") {
                        rewrite_source(slot, &cells, None);
                    }
                    changed = true;
                }
                RangeShift::Moved { rect, series, .. } => {
                    if let Some(slot) = layer.get_mut("data") {
                        rewrite_source(slot, &cells, Some(rect));
                    }
                    if layer.contains_key("series") {
                        apply_series(layer.get_mut("series"), &offsets, &series);
                    }
                    changed = true;
                }
            }
        }
    }

    // A lookup table is a plain reference.
    if let Some(Value::Array(transforms)) = spec.get_mut("transform") {
        for t in transforms.iter_mut() {
            let Value::Object(t) = t else { continue };
            if t.get("type").and_then(Value::as_str) != Some("lookup") {
                continue;
            }
            let Some(cells) = t.get("from").and_then(|d| source_cells(d, sheet)) else { continue };
            let r = cells.rect();
            let next = band.shift_reference_range(r);
            if next == Some(r) {
                continue;
            }
            if let Some(slot) = t.get_mut("from") {
                rewrite_source(slot, &cells, next);
            }
            changed = true;
        }
    }

    if depth < MAX_CONCAT_DEPTH {
        if let Some(Value::Object(concat)) = spec.get_mut("concat") {
            if let Some(Value::Array(children)) = concat.get_mut("charts") {
                for child in children.iter_mut() {
                    changed |= shift_chart_spec(child, sheet, band, host, depth + 1);
                }
            }
        }
    }
    changed
}

/// Shift a chart record AS THE BACKEND STORES IT (`ChartEntry::spec_json`: a
/// ChartDefinition with a nested `spec`, or a bare spec), placed as `host`
/// says. Returns the new text, or `None` when nothing moved (the stored text
/// is then left byte-identical).
pub(crate) fn shift_chart_record(
    spec_json: &str,
    sheet: &EditedSheet,
    band: &BandEdit,
    host: ParamHost,
) -> Option<String> {
    let mut record: Value = serde_json::from_str(spec_json).ok()?;
    let Value::Object(fields) = &mut record else { return None };
    // chartSpecNormalize.ts `storedSpecOf`, as the stamp walk reads it.
    let bare = !matches!(fields.get("spec"), Some(Value::Object(_)))
        && matches!(fields.get("mark"), Some(Value::String(_)));
    let changed = if bare {
        shift_chart_spec(&mut record, sheet, band, host, 0)
    } else {
        match fields.get_mut("spec") {
            Some(spec @ Value::Object(_)) => shift_chart_spec(spec, sheet, band, host, 0),
            _ => false,
        }
    };
    if changed {
        serde_json::to_string(&record).ok()
    } else {
        None
    }
}

// ============================================================================
// Sparklines
// ============================================================================

/// One sparkline: its location cell and the data line it draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Spark {
    pub(crate) cell: (u32, u32),
    pub(crate) line: CellRange,
}

/// The sparklines of a group, as `ungroupSparkline` (Sparklines/store.ts)
/// cuts it: a column location draws one data ROW per cell, a row location one
/// data COLUMN per cell, a single cell the whole data range. `None` for a
/// group whose ranges do not map one line per cell.
pub(crate) fn sparkline_pairs(loc: CellRange, data: CellRange) -> Option<Vec<Spark>> {
    let loc_rows = loc.end_row - loc.start_row + 1;
    let loc_cols = loc.end_col - loc.start_col + 1;
    if loc_rows > 1 && loc_cols > 1 {
        return None;
    }
    if loc_rows == 1 && loc_cols == 1 {
        return Some(vec![Spark { cell: (loc.start_row, loc.start_col), line: data }]);
    }
    if loc_cols == 1 {
        if data.end_row - data.start_row + 1 != loc_rows {
            return None;
        }
        return Some(
            (0..loc_rows)
                .map(|i| Spark {
                    cell: (loc.start_row + i, loc.start_col),
                    line: CellRange { start_row: data.start_row + i, end_row: data.start_row + i, ..data },
                })
                .collect(),
        );
    }
    if data.end_col - data.start_col + 1 != loc_cols {
        return None;
    }
    Some(
        (0..loc_cols)
            .map(|i| Spark {
                cell: (loc.start_row, loc.start_col + i),
                line: CellRange { start_col: data.start_col + i, end_col: data.start_col + i, ..data },
            })
            .collect(),
    )
}

/// The sparklines after the edit: each cell moved as a cell and each line as a
/// reference (a deleted one leaves), plus a copy for every INSERTED cell right
/// after a sparkline cell, its line offset as a copied formula's would be.
pub(crate) fn shift_sparks(sparks: &[Spark], band: &BandEdit) -> Vec<Spark> {
    let rows_edit = band.moves_rows();
    let mut out = Vec::with_capacity(sparks.len());
    for s in sparks {
        let (Some(cell), Some(line)) = (band.shift_cell(s.cell.0, s.cell.1), band.shift_reference_range(s.line)) else {
            continue;
        };
        out.push(Spark { cell, line });
        if !band.inserting() || band.at() == 0 {
            continue;
        }
        let (along, perp) = if rows_edit { s.cell } else { (s.cell.1, s.cell.0) };
        if along + 1 != band.at() || perp < band.band_start || perp > band.band_end {
            continue;
        }
        let max_along = if rows_edit { engine::EXCEL_MAX_ROW_INDEX } else { engine::EXCEL_MAX_COL_INDEX };
        for j in 1..=band.count() {
            let new_along = along as u64 + j as u64;
            let line_end = u64::from(if rows_edit { line.end_row } else { line.end_col }) + u64::from(j);
            if new_along > max_along as u64 || line_end > max_along as u64 {
                break;
            }
            let new_along = new_along as u32;
            let copy = if rows_edit {
                Spark {
                    cell: (new_along, perp),
                    line: CellRange { start_row: line.start_row + j, end_row: line.end_row + j, ..line },
                }
            } else {
                Spark {
                    cell: (perp, new_along),
                    line: CellRange { start_col: line.start_col + j, end_col: line.end_col + j, ..line },
                }
            };
            out.push(copy);
        }
    }
    out
}

/// Pack sparklines back into groups: a run of cells down one column over
/// consecutive data rows (or along one row over consecutive data columns) is
/// one group; anything else stands alone. `column_first` orders the cells
/// down columns (a column group, or a single cell under a row edit).
pub(crate) fn pack_sparks(mut sparks: Vec<Spark>, column_first: bool) -> Vec<(CellRange, CellRange)> {
    if column_first {
        sparks.sort_by_key(|s| (s.cell.1, s.cell.0));
    } else {
        sparks.sort_by_key(|s| (s.cell.0, s.cell.1));
    }
    sparks.dedup_by_key(|s| s.cell);
    #[derive(Clone, Copy, PartialEq)]
    enum Dir {
        Down,
        Across,
    }
    let continues = |last: &Spark, next: &Spark, dir: Dir| -> bool {
        let (l, n) = (last.line, next.line);
        match dir {
            Dir::Down => {
                next.cell.1 == last.cell.1
                    && next.cell.0 == last.cell.0 + 1
                    && l.start_row == l.end_row
                    && n.start_row == n.end_row
                    && n.start_row == l.start_row + 1
                    && (n.start_col, n.end_col) == (l.start_col, l.end_col)
            }
            Dir::Across => {
                next.cell.0 == last.cell.0
                    && next.cell.1 == last.cell.1 + 1
                    && l.start_col == l.end_col
                    && n.start_col == n.end_col
                    && n.start_col == l.start_col + 1
                    && (n.start_row, n.end_row) == (l.start_row, l.end_row)
            }
        }
    };
    let mut runs: Vec<(Vec<Spark>, Option<Dir>)> = Vec::new();
    for s in sparks {
        if let Some((run, dir)) = runs.last_mut() {
            let last = *run.last().expect("a run is never empty");
            let extend = match *dir {
                Some(d) => continues(&last, &s, d).then_some(d),
                None => [Dir::Down, Dir::Across].into_iter().find(|d| continues(&last, &s, *d)),
            };
            if let Some(d) = extend {
                run.push(s);
                *dir = Some(d);
                continue;
            }
        }
        runs.push((vec![s], None));
    }
    runs.into_iter()
        .map(|(run, _)| {
            let first = run[0];
            let last = run[run.len() - 1];
            let loc = CellRange {
                start_row: first.cell.0,
                end_row: last.cell.0,
                start_col: first.cell.1,
                end_col: last.cell.1,
            };
            let data = CellRange {
                start_row: first.line.start_row.min(last.line.start_row),
                end_row: first.line.end_row.max(last.line.end_row),
                start_col: first.line.start_col.min(last.line.start_col),
                end_col: first.line.end_col.max(last.line.end_col),
            };
            (loc, data)
        })
        .collect()
}

/// The groups of ONE group after the edit (empty: it is gone). The first
/// keeps the group's own ranges' slot; a group the edit splits needs more.
fn shift_sparkline_group(loc: CellRange, data: CellRange, band: &BandEdit) -> Vec<(CellRange, CellRange)> {
    match sparkline_pairs(loc, data) {
        Some(sparks) => {
            let column_first = if loc.start_col == loc.end_col && loc.start_row != loc.end_row {
                true
            } else if loc.start_row == loc.end_row && loc.start_col != loc.end_col {
                false
            } else {
                band.moves_rows()
            };
            pack_sparks(shift_sparks(&sparks, band), column_first)
        }
        None => {
            // A group whose ranges do not map one line per cell: move its
            // location as cells and its data as a reference, whole.
            let first = band.shift_cell(loc.start_row, loc.start_col);
            let last = band.shift_cell(loc.end_row, loc.end_col);
            match (first, last, band.shift_reference_range(data)) {
                (Some(a), Some(b), Some(d)) => vec![(
                    CellRange { start_row: a.0.min(b.0), end_row: a.0.max(b.0), start_col: a.1.min(b.1), end_col: a.1.max(b.1) },
                    d,
                )],
                _ => Vec::new(),
            }
        }
    }
}

/// The JSON key of a group's areas after its first (module header, GROUP
/// IDENTITY): `[{ "location": {...}, "dataRange": {...} }, ...]`.
pub(crate) const MORE_AREAS_KEY: &str = "moreAreas";

/// Every area of a group, its own `location` / `dataRange` first, or `None`
/// when any of them is not a readable rectangle (the group is then left as
/// it is).
fn sparkline_group_areas(group: &Map<String, Value>) -> Option<Vec<(CellRange, CellRange)>> {
    let area = |m: &Map<String, Value>| -> Option<(CellRange, CellRange)> {
        let loc = m.get("location").and_then(Value::as_object).and_then(ref_rect)?;
        let data = m.get("dataRange").and_then(Value::as_object).and_then(ref_rect)?;
        Some((loc, data))
    };
    let mut areas = vec![area(group)?];
    match group.get(MORE_AREAS_KEY) {
        None | Some(Value::Null) => {}
        Some(Value::Array(more)) => {
            for m in more {
                areas.push(area(m.as_object()?)?);
            }
        }
        Some(_) => return None,
    }
    Some(areas)
}

/// A `{startRow, startCol, endRow, endCol}` object.
fn ref_rect_value(r: CellRange) -> Value {
    let mut m = Map::new();
    write_ref_rect(&mut m, r);
    Value::Object(m)
}

/// Shift a sheet's stored sparkline groups (`SparklineEntry::groups_json`, a
/// JSON array of SparklineGroup). Returns the new text, or `None` when nothing
/// moved. Each AREA of a group is shifted (`shift_sparkline_group`), and every
/// part the edit leaves stays in the SAME group, under the same id: the first
/// is the group's `location` / `dataRange`, the rest its `moreAreas` (module
/// header, GROUP IDENTITY). A group with no sparkline left is removed.
pub(crate) fn shift_sparkline_groups(groups_json: &str, band: &BandEdit) -> Option<String> {
    let Ok(Value::Array(groups)) = serde_json::from_str::<Value>(groups_json) else { return None };
    let mut changed = false;
    let mut out: Vec<Value> = Vec::with_capacity(groups.len());
    for group in groups {
        let Some(areas) = group.as_object().and_then(sparkline_group_areas) else {
            out.push(group);
            continue;
        };
        let parts: Vec<(CellRange, CellRange)> = areas
            .iter()
            .flat_map(|&(loc, data)| shift_sparkline_group(loc, data, band))
            .collect();
        if parts == areas {
            out.push(group);
            continue;
        }
        changed = true;
        let Some((&(first_loc, first_data), rest)) = parts.split_first() else {
            // Every sparkline of the group was deleted: the group goes.
            continue;
        };
        let mut g = group;
        if let Value::Object(map) = &mut g {
            if let Some(Value::Object(l)) = map.get_mut("location") {
                write_ref_rect(l, first_loc);
            }
            if let Some(Value::Object(d)) = map.get_mut("dataRange") {
                write_ref_rect(d, first_data);
            }
            if rest.is_empty() {
                map.remove(MORE_AREAS_KEY);
            } else {
                let more: Vec<Value> = rest
                    .iter()
                    .map(|&(loc, data)| {
                        let mut area = Map::new();
                        area.insert("location".to_string(), ref_rect_value(loc));
                        area.insert("dataRange".to_string(), ref_rect_value(data));
                        Value::Object(area)
                    })
                    .collect();
                map.insert(MORE_AREAS_KEY.to_string(), Value::Array(more));
            }
        }
        out.push(g);
    }
    if changed {
        serde_json::to_string(&Value::Array(out)).ok()
    } else {
        None
    }
}

// ============================================================================
// The stores
// ============================================================================

/// Shift every chart range that reads `sheet_index` (whatever sheet the chart
/// is ON), every chart PARAM cell on it (rule 6) and the sheet's sparkline
/// groups, recording one `obj_chart` restore
/// per chart and one `obj_sparklines` restore INTO the caller's open structural
/// transaction, through the `undo_stack` guard it holds -- so the edit and the
/// ranges undo as one step. Returns true when anything moved.
///
/// Called by every structural command (`commands/structure.rs` insert/delete
/// rows and columns, the off-sheet path, and Insert/Delete Cells in
/// `structure_cells.rs`) with the whole-line band for a whole-line edit.
pub(crate) fn shift_chart_and_sparkline_ranges(
    state: &AppState,
    effect: &DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    sheet_index: usize,
    sheet_name: &str,
    band: &BandEdit,
) -> bool {
    let sheet_id: String = state
        .sheet_ids
        .read()
        .ok()
        .and_then(|ids| ids.get(sheet_index).map(|id| id.to_string()))
        .unwrap_or_default();
    let sheet = EditedSheet { index: sheet_index, id: &sheet_id, name: sheet_name };
    // Which sheets are canvases, COPIED and released before the chart lock
    // (nothing here nests two stores' locks): a chart's param cells are on its
    // own sheet, or on a canvas on its data's sheet (rule 6).
    let canvas: Vec<bool> = state
        .sheet_kinds
        .read()
        .map(|kinds| kinds.iter().map(|k| k.is_canvas()).collect())
        .unwrap_or_default();
    // The defined names a canvas chart's data may be, with their sheets --
    // also copied and released first. Every caller has already shifted (and
    // released) the names; a row or column edit never moves a name to another
    // sheet, and a name deleted whole keeps its qualifier.
    let names: DefinedNameSheets = if canvas.iter().any(|&c| c) {
        state.named_ranges.read().map(|n| defined_name_sheets(&n)).unwrap_or_default()
    } else {
        DefinedNameSheets::new()
    };
    let mut changed = false;

    match state.charts.write(effect) {
        Ok(mut charts) => {
            for chart in charts.iter_mut() {
                let host = if canvas.get(chart.sheet_index).copied().unwrap_or(false) {
                    ParamHost::Canvas { names: &names }
                } else {
                    ParamHost::Worksheet { edited: chart.sheet_index == sheet_index }
                };
                let Some(next) = shift_chart_record(&chart.spec_json, &sheet, band, host) else { continue };
                let previous = chart.clone();
                chart.spec_json = next;
                undo_stack.record_custom_restore(
                    "obj_chart".to_string(),
                    crate::undo_commands::chart_obj_snapshot_bytes(previous.id, Some(previous)),
                    SHIFT_DESCRIPTION,
                );
                changed = true;
            }
        }
        Err(e) => crate::log_warn!("CHARTS", "the chart store is unreadable ({}); no chart range was shifted", e),
    }

    match state.sparklines.write(effect) {
        Ok(mut sparklines) => {
            if let Some(entry) = sparklines.iter_mut().find(|s| s.sheet_index == sheet_index) {
                if let Some(next) = shift_sparkline_groups(&entry.groups_json, band) {
                    let previous = std::mem::replace(&mut entry.groups_json, next);
                    undo_stack.record_custom_restore(
                        "obj_sparklines".to_string(),
                        crate::undo_commands::sparklines_obj_snapshot_bytes(sheet_index, Some(previous)),
                        SHIFT_DESCRIPTION,
                    );
                    changed = true;
                }
            }
        }
        Err(e) => crate::log_warn!("SPARKLINES", "the sparkline store is unreadable ({}); no sparkline was shifted", e),
    }
    changed
}
