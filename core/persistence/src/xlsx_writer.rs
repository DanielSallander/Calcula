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

/// The literal a reader that does NOT recalculate should see for a cached cell
/// value — the `<v>` an array origin carries alongside its formula.
///
/// `rust_xlsxwriter` defaults an array formula's result to `"0"`, which would
/// hand a non-calculating viewer a zero where the workbook shows the array's
/// first value. Excel writes the real cached result; so does this.
fn cached_result_literal(value: &SavedCellValue) -> String {
    match value {
        SavedCellValue::Number(n) => n.to_string(),
        SavedCellValue::Text(s) => s.clone(),
        SavedCellValue::Boolean(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        // An error or a structured value has no meaningful `<v>` literal; the
        // library's default is as good an answer as any, and Excel recalculates.
        _ => "0".to_string(),
    }
}

pub fn save_xlsx(workbook: &Workbook, path: &Path) -> Result<(), PersistenceError> {
    let mut xlsx = XlsxWorkbook::new();
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

    // ========================================================================
    // Sheets
    // ========================================================================
    for sheet in &workbook.sheets {
        let worksheet = xlsx.add_worksheet();
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
            // Inverse of the reader's px = w * 7.0 + 5.0 (xlsx_style_reader) so
            // widths don't inflate by 5px per round-trip.
            let excel_width = ((*width - 5.0) / 7.0).max(0.0);
            worksheet.set_column_width(*col as u16, excel_width)?;
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
                let format = convert_style_to_format(style);
                worksheet.set_column_format(*col as u16, &format)?;
            }
        }
        for (row, style_index) in &sheet.row_styles {
            if let Some(style) = sheet.styles.get(*style_index) {
                let format = convert_style_to_format(style);
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
        // the cell loop and lands as a formula, so Excel's `#SPILL!` is still
        // available for the case where it is the right answer.
        let mut array_origins: Vec<(u32, u32)> = sheet
            .cells
            .iter()
            .filter_map(|(&(row, col), cell)| {
                let (end_row, end_col) = cell.spill?;
                cell.formula.as_ref()?;
                if end_row < row || end_col < col || (end_row == row && end_col == col) {
                    return None;
                }
                Some((row, col))
            })
            .collect();
        // Deterministic output: the sheet's cells live in a HashMap.
        array_origins.sort_unstable();

        for (row, col) in &array_origins {
            let cell = &sheet.cells[&(*row, *col)];
            let (end_row, end_col) = cell.spill.expect("filtered above");
            let formula_text = cell.formula.as_ref().expect("filtered above");
            let clean_formula = formula_text.strip_prefix('=').unwrap_or(formula_text);
            // The origin's own cached result, so a reader that does NOT
            // recalculate still shows the array's first value rather than the
            // library's `0` placeholder.
            let formula = rust_xlsxwriter::Formula::new(clean_formula)
                .set_result(cached_result_literal(&cell.value));
            let format = if cell.style_index > 0 && cell.style_index < sheet.styles.len() {
                Some(convert_style_to_format(&sheet.styles[cell.style_index]))
            } else {
                None
            };
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
        for ((row, col), cell) in &sheet.cells {
            // Already written above, with its extent. Writing it again as an
            // ordinary formula would drop the `ref` and re-create the defect.
            if array_origin_set.contains(&(*row, *col)) {
                continue;
            }

            let format = if cell.style_index > 0 && cell.style_index < sheet.styles.len() {
                Some(convert_style_to_format(&sheet.styles[cell.style_index]))
            } else {
                None
            };

            match &cell.value {
                SavedCellValue::Empty => {
                    // A formula whose current value is Empty must still write
                    // the formula — skipping it deletes the formula from the file.
                    if let Some(ref formula) = cell.formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        if let Some(fmt) = format {
                            worksheet.write_formula_with_format(*row, *col as u16, clean_formula, &fmt)?;
                        } else {
                            worksheet.write_formula(*row, *col as u16, clean_formula)?;
                        }
                    }
                }
                SavedCellValue::Number(n) => {
                    if let Some(ref formula) = cell.formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        if let Some(fmt) = format {
                            worksheet.write_formula_with_format(*row, *col as u16, clean_formula, &fmt)?;
                        } else {
                            worksheet.write_formula(*row, *col as u16, clean_formula)?;
                        }
                    } else if let Some(fmt) = format {
                        worksheet.write_number_with_format(*row, *col as u16, *n, &fmt)?;
                    } else {
                        worksheet.write_number(*row, *col as u16, *n)?;
                    }
                }
                SavedCellValue::Text(s) => {
                    if let Some(ref formula) = cell.formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        if let Some(fmt) = format {
                            worksheet.write_formula_with_format(*row, *col as u16, clean_formula, &fmt)?;
                        } else {
                            worksheet.write_formula(*row, *col as u16, clean_formula)?;
                        }
                    } else if let Some(fmt) = format {
                        worksheet.write_string_with_format(*row, *col as u16, s, &fmt)?;
                    } else {
                        worksheet.write_string(*row, *col as u16, s)?;
                    }
                }
                SavedCellValue::Boolean(b) => {
                    if let Some(ref formula) = cell.formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        if let Some(fmt) = format {
                            worksheet.write_formula_with_format(*row, *col as u16, clean_formula, &fmt)?;
                        } else {
                            worksheet.write_formula(*row, *col as u16, clean_formula)?;
                        }
                    } else if let Some(fmt) = format {
                        worksheet.write_boolean_with_format(*row, *col as u16, *b, &fmt)?;
                    } else {
                        worksheet.write_boolean(*row, *col as u16, *b)?;
                    }
                }
                SavedCellValue::Error(err) => {
                    // A formula currently in error keeps its FORMULA (Excel
                    // recalculates on open); only a static error cell falls back
                    // to the specific error literal (e.g. "#DIV/0!"), never a
                    // generic "#ERROR!" placeholder.
                    if let Some(ref formula) = cell.formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        if let Some(fmt) = format {
                            worksheet.write_formula_with_format(*row, *col as u16, clean_formula, &fmt)?;
                        } else {
                            worksheet.write_formula(*row, *col as u16, clean_formula)?;
                        }
                    } else if let Some(fmt) = format {
                        worksheet.write_string_with_format(*row, *col as u16, err, &fmt)?;
                    } else {
                        worksheet.write_string(*row, *col as u16, err)?;
                    }
                }
                SavedCellValue::List(items) => {
                    if let Some(ref formula) = cell.formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        if let Some(fmt) = format {
                            worksheet.write_formula_with_format(*row, *col as u16, clean_formula, &fmt)?;
                        } else {
                            worksheet.write_formula(*row, *col as u16, clean_formula)?;
                        }
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
                    if let Some(ref formula) = cell.formula {
                        let clean_formula = formula.strip_prefix('=').unwrap_or(formula);
                        if let Some(fmt) = format {
                            worksheet.write_formula_with_format(*row, *col as u16, clean_formula, &fmt)?;
                        } else {
                            worksheet.write_formula(*row, *col as u16, clean_formula)?;
                        }
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

        // ---- Notes / Comments ----
        for note in &sheet.notes {
            let xlsx_note = Note::new(&note.text);
            worksheet.insert_note(note.row, note.col as u16, &xlsx_note)?;
        }

        // ---- Hyperlinks ----
        for link in &sheet.hyperlinks {
            if let Some(ref display) = link.display_text {
                worksheet.write_url_with_text(
                    link.row,
                    link.col as u16,
                    link.target.as_str(),
                    display,
                )?;
            } else {
                worksheet.write_url(link.row, link.col as u16, link.target.as_str())?;
            }
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
            let Ok(def) = serde_json::from_str::<serde_json::Value>(&chart_entry.spec_json) else {
                continue;
            };
            if let Some((chart, row, col)) = build_native_chart(&def, &sheet.name) {
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
    for nr in &workbook.named_ranges {
        // rust_xlsxwriter define_name expects the formula with sheet reference
        // For sheet-scoped names, prefix with "SheetName!"
        let full_name = if let Some(sid) = nr.sheet_id {
            // Find the sheet's position by its stable SheetId
            if let Some(sheet) = workbook.sheets.iter().find(|s| s.id == sid) {
                format!("'{}'!{}", sheet.name, nr.name)
            } else {
                nr.name.clone()
            }
        } else {
            nr.name.clone()
        };
        // The refers_to should already include sheet references like "Sheet1!$A$1:$B$5"
        let formula = if nr.refers_to.starts_with('=') {
            nr.refers_to.clone()
        } else {
            format!("={}", nr.refers_to)
        };
        if let Err(e) = xlsx.define_name(&full_name, &formula) {
            // Name loss must at least be observable; a bad refers_to must not
            // abort the whole save.
            eprintln!("[WARN] xlsx save: defined name '{}' skipped: {}", full_name, e);
        }
    }

    // ========================================================================
    // Calcula metadata sheet (tables + full-fidelity charts/sparklines)
    // ========================================================================
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
                    spec_json: c.spec_json.clone(),
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
    if !workbook.tables.is_empty() || !meta_charts.is_empty() || !meta_sparklines.is_empty() {
        let mut meta = CalculaMeta::new(workbook.tables.clone());
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
    xlsx.save(path)?;

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
    Ok(())
}

/// The orphan-part path checked by the reader (see save_xlsx).
pub const XLSX_FRESHNESS_MARKER: &str = "calculaMeta/marker.xml";

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

fn convert_style_to_format(style: &CellStyle) -> Format {
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

    format = format.set_font_size(style.font.size as f64);
    format = format.set_font_name(&style.font.family);

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

    // Text rotation
    match style.text_rotation {
        TextRotation::None => {}
        TextRotation::Rotate90 => {
            format = format.set_rotation(90);
        }
        TextRotation::Rotate270 => {
            format = format.set_rotation(270);
        }
        TextRotation::Custom(angle) => {
            format = format.set_rotation(angle as i16);
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
        NumberFormat::Currency { decimal_places, symbol, symbol_position: _ } => {
            let decimal_part = if *decimal_places > 0 {
                format!(".{}", "0".repeat(*decimal_places as usize))
            } else {
                String::new()
            };
            format!("{}#,##0{}", symbol, decimal_part)
        }
        NumberFormat::Accounting { decimal_places, symbol, symbol_position } => {
            let decimal_part = if *decimal_places > 0 {
                format!(".{}", "0".repeat(*decimal_places as usize))
            } else {
                String::new()
            };
            let num_fmt = format!("#,##0{}", decimal_part);
            let dash = if *decimal_places > 0 {
                format!("\"-\"{}",  "?".repeat(*decimal_places as usize))
            } else {
                "\"-\"".to_string()
            };
            match symbol_position {
                engine::style::CurrencyPosition::Before => {
                    format!(
                        "_(\"{symbol}\"* {num_fmt}_);_(\"{symbol}\"* ({num_fmt});_(\"{symbol}\"* {dash}_);_(@_)"
                    )
                }
                engine::style::CurrencyPosition::After => {
                    format!(
                        "_(* {num_fmt}\" {symbol}\"_);_(* ({num_fmt})\" {symbol}\";_(* {dash}\" {symbol}\"_);_(@_)"
                    )
                }
            }
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
    /// `#SPILL!` remains available for the case it is the right answer.
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
        workbook.sheets.push(sheet);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blocked.xlsx");
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
        assert!(
            xml.contains("11*9"),
            "a cell with its own formula inside the footprint must not be              swallowed by the array; sheet1.xml was:
{}",
            xml
        );
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
        ] {
            assert_eq!(
                strip_future_function_prefixes(stored),
                expected,
                "stripping {:?}",
                stored
            );
        }
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

}
