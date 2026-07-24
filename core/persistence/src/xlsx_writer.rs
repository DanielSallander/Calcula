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
        worksheet.set_name(&sheet.name)?;

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

        // ---- Column widths ----
        for (col, width) in &sheet.column_widths {
            // Inverse of the reader's px = w * 7.0 + 5.0 (xlsx_style_reader) so
            // widths don't inflate by 5px per round-trip.
            let excel_width = ((*width - 5.0) / 7.0).max(0.0);
            worksheet.set_column_width(*col as u16, excel_width)?;
        }

        // ---- Row heights ----
        for (row, height) in &sheet.row_heights {
            worksheet.set_row_height(*row, *height)?;
        }

        // ---- Hidden rows ----
        for row in &sheet.hidden_rows {
            worksheet.set_row_hidden(*row)?;
        }

        // ---- Hidden columns ----
        for col in &sheet.hidden_cols {
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

        // ---- Write cells ----
        for ((row, col), cell) in &sheet.cells {
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

    xlsx.save(path)?;
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
