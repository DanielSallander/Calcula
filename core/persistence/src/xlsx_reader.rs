//! FILENAME: core/persistence/src/xlsx_reader.rs
//!
//! Reads XLSX files using calamine for cell values/formulas and a custom
//! XML parser (xlsx_style_reader) for styles, merged cells, column widths,
//! row heights, and freeze panes.

use crate::xlsx_style_reader::{parse_xlsx_styles, xf_to_cell_style};
use crate::{
    CalculaMeta, PersistenceError, SavedCell, SavedCellValue, SavedMergedRegion, Sheet, Workbook,
    META_SHEET_NAME,
};
use calamine::{open_workbook, Data, Reader, Xlsx};
use engine::style::CellStyle;
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub fn load_xlsx(path: &Path) -> Result<Workbook, PersistenceError> {
    let mut workbook: Xlsx<_> = open_workbook(path)?;
    let sheet_names = workbook.sheet_names().to_vec();

    if sheet_names.is_empty() {
        return Err(PersistenceError::InvalidFormat(
            "Workbook contains no sheets".to_string(),
        ));
    }

    // ---------- Second pass: parse styles and sheet metadata from raw XML ----------
    let style_data = parse_xlsx_styles(path);

    // Pre-build the CellStyle palette from XLSX XF records.
    // Index 0 in calcula_styles is always the default style.
    // We build a mapping from xlsx_xf_index -> calcula style index.
    let mut calcula_styles: Vec<CellStyle> = vec![CellStyle::new()];
    let mut xf_to_calcula: HashMap<u32, usize> = HashMap::new();

    if let Some(ref sd) = style_data {
        for (xf_idx, xf) in sd.cell_xfs.iter().enumerate() {
            let style =
                xf_to_cell_style(xf, &sd.fonts, &sd.fills, &sd.borders, &sd.number_formats);

            // Check if this style is the default; if so, map to index 0
            if style == CellStyle::new() {
                xf_to_calcula.insert(xf_idx as u32, 0);
            } else {
                // Deduplicate: check if we already have this style
                let existing = calcula_styles.iter().position(|s| s == &style);
                if let Some(idx) = existing {
                    xf_to_calcula.insert(xf_idx as u32, idx);
                } else {
                    let idx = calcula_styles.len();
                    calcula_styles.push(style);
                    xf_to_calcula.insert(xf_idx as u32, idx);
                }
            }
        }
    }

    // ---------- First pass: calamine reads cell values ----------
    let mut sheets = Vec::new();
    let mut tables = Vec::new();
    let mut meta_charts: Vec<crate::MetaChart> = Vec::new();
    let mut meta_sparklines: Vec<crate::MetaSparkline> = Vec::new();

    // Track 1-based sheet index (matching xl/worksheets/sheetN.xml numbering)
    let mut sheet_number: usize = 0;

    for sheet_name in &sheet_names {
        sheet_number += 1;

        // Check if this is the Calcula metadata sheet
        if sheet_name == META_SHEET_NAME {
            // Extract metadata (tables, charts, sparklines) from the hidden
            // sheet. The JSON may be CHUNKED across row 0 (A1, B1, C1, ...)
            // to stay under Excel's 32,767-char cell limit — concatenate all
            // string cells of row 0 in order (a single-cell legacy meta is
            // just a one-chunk concat).
            if let Ok(range) = workbook.worksheet_range(sheet_name) {
                if let Some(row) = range.rows().next() {
                    let json: String = row
                        .iter()
                        .filter_map(|c| match c {
                            Data::String(s) => Some(s.as_str()),
                            _ => None,
                        })
                        .collect();
                    if let Some(meta) = CalculaMeta::from_json(&json) {
                        tables = meta.tables;
                        meta_charts = meta.charts;
                        meta_sparklines = meta.sparklines;
                    }
                }
            }
            // Don't add metadata sheet to the visible sheets list
            continue;
        }

        let range = workbook
            .worksheet_range(sheet_name)
            .map_err(|e| PersistenceError::InvalidFormat(e.to_string()))?;

        // Get sheet metadata from the style parser
        let sheet_meta = style_data
            .as_ref()
            .and_then(|sd| sd.sheet_meta.get(&sheet_number));

        let mut cells = HashMap::new();

        // Calamine Range may not start at (0,0) — get the offset
        let range_start = range.start().unwrap_or((0, 0));
        let start_row_offset = range_start.0;
        let start_col_offset = range_start.1;

        // Pre-load formula range: it may have a different start/size than data range
        let formula_range = workbook.worksheet_formula(sheet_name).ok();
        let formula_start = formula_range.as_ref().and_then(|fr| fr.start()).unwrap_or((0, 0));

        for (row_idx, row) in range.rows().enumerate() {
            let actual_row = start_row_offset + row_idx as u32;
            for (col_idx, cell) in row.iter().enumerate() {
                let actual_col = start_col_offset + col_idx as u32;

                let is_empty = matches!(cell, Data::Empty);
                let saved_value = match cell {
                    Data::Empty => SavedCellValue::Text(String::new()),
                    Data::String(s) => SavedCellValue::Text(s.clone()),
                    Data::Float(f) => SavedCellValue::Number(*f),
                    Data::Int(i) => SavedCellValue::Number(*i as f64),
                    Data::Bool(b) => SavedCellValue::Boolean(*b),
                    Data::Error(e) => SavedCellValue::Error(format!("{:?}", e)),
                    Data::DateTime(dt) => SavedCellValue::Number(dt.as_f64()),
                    Data::DateTimeIso(s) => SavedCellValue::Text(s.clone()),
                    Data::DurationIso(s) => SavedCellValue::Text(s.clone()),
                };

                // Look up the XLSX style index for this cell (using absolute coords
                // since the XML parser stores absolute positions)
                let style_index = sheet_meta
                    .and_then(|m| m.cell_styles.get(&(actual_row, actual_col)))
                    .and_then(|xlsx_xf| xf_to_calcula.get(xlsx_xf))
                    .copied()
                    .unwrap_or(0);

                // Skip truly empty cells (no value AND default style)
                if is_empty && style_index == 0 {
                    continue;
                }

                // Try to get formula if available
                // Convert absolute cell position to formula range's relative coordinates
                let formula = formula_range.as_ref().and_then(|fr| {
                    if actual_row >= formula_start.0 && actual_col >= formula_start.1 {
                        let fr_row = (actual_row - formula_start.0) as usize;
                        let fr_col = (actual_col - formula_start.1) as usize;
                        fr.get((fr_row, fr_col))
                            .filter(|f| !f.is_empty())
                            .map(|f| format!("={}", f))
                    } else {
                        None
                    }
                });

                cells.insert(
                    (actual_row, actual_col),
                    SavedCell {
                        value: saved_value,
                        formula,
                        style_index,
                        rich_text: None,
                    },
                );
            }
        }

        // Add styled empty cells that calamine didn't return.
        // The sheet XML may have cells with style attributes but no value;
        // calamine skips these, but they need to render backgrounds/borders.
        if let Some(meta) = sheet_meta {
            for ((r, c), xlsx_xf) in &meta.cell_styles {
                if cells.contains_key(&(*r, *c)) {
                    continue; // Already have this cell from calamine
                }
                if let Some(&calcula_idx) = xf_to_calcula.get(xlsx_xf) {
                    if calcula_idx != 0 {
                        cells.insert(
                            (*r, *c),
                            SavedCell {
                                value: SavedCellValue::Text(String::new()),
                                formula: None,
                                style_index: calcula_idx,
                                rich_text: None,
                            },
                        );
                    }
                }
            }
        }

        // Column widths from XLSX metadata
        let column_widths = sheet_meta
            .map(|m| m.column_widths.clone())
            .unwrap_or_default();

        // Row heights from XLSX metadata
        let row_heights = sheet_meta
            .map(|m| m.row_heights.clone())
            .unwrap_or_default();

        // Merged regions
        let merged_regions = sheet_meta
            .map(|m| {
                m.merge_cells
                    .iter()
                    .map(|(sr, sc, er, ec)| SavedMergedRegion {
                        start_row: *sr,
                        start_col: *sc,
                        end_row: *er,
                        end_col: *ec,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        // Freeze panes
        let (freeze_row, freeze_col) = sheet_meta
            .and_then(|m| m.freeze_pane)
            .map(|(r, c)| {
                (
                    if r > 0 { Some(r) } else { None },
                    if c > 0 { Some(c) } else { None },
                )
            })
            .unwrap_or((None, None));

        // Hidden rows/columns
        let hidden_rows: HashSet<u32> = sheet_meta
            .map(|m| m.hidden_rows.iter().copied().collect())
            .unwrap_or_default();
        let hidden_cols: HashSet<u32> = sheet_meta
            .map(|m| m.hidden_columns.iter().copied().collect())
            .unwrap_or_default();

        // Show gridlines setting
        let show_gridlines = sheet_meta
            .map(|m| m.show_gridlines)
            .unwrap_or(true);

        sheets.push(Sheet {
            id: identity::SheetId::from_bytes(identity::generate_uuid_v7()),
            name: sheet_name.clone(),
            cells,
            column_widths,
            row_heights,
            styles: calcula_styles.clone(),
            merged_regions,
            freeze_row,
            freeze_col,
            hidden_rows,
            hidden_cols,
            tab_color: String::new(),
            visibility: "visible".to_string(),
            notes: Vec::new(),
            hyperlinks: Vec::new(),
            page_setup: None,
            show_gridlines,
        });
    }

    let mut wb = Workbook {
        sheets,
        active_sheet: 0,
        tables,
        slicers: Vec::new(),
        user_files: HashMap::new(),
        theme: engine::theme::ThemeDefinition::default(),
        scripts: Vec::new(),
        notebooks: Vec::new(),
        default_row_height: 24.0,
        default_column_width: 100.0,
        properties: crate::WorkbookProperties::default(),
        charts: Vec::new(),
        sparklines: Vec::new(),
        named_ranges: Vec::new(),
        ribbon_filters: Vec::new(),
        pane_controls: Vec::new(),
        pivot_layouts: Vec::new(),
        pivot_definitions: Vec::new(),
        bi_pivot_metadata: Vec::new(),
        object_scripts: Vec::new(),
        bi_connection_roles: Vec::new(),
        bi_connections: Vec::new(),
        bi_connection_caches: std::collections::HashMap::new(),
        extension_data: Default::default(),
        conditional_formats: Vec::new(),
        data_validations: Vec::new(),
        controls: Vec::new(),
        cell_types: Vec::new(),
        cell_behaviors: Vec::new(),
        comments: Vec::new(),
        scenarios: Vec::new(),
        outlines: Vec::new(),
        sheet_protections: Vec::new(),
        workbook_protection: None,
    };

    // Sparklines have no native xlsx form — the meta carry is the only source.
    for ms in &meta_sparklines {
        if ms.sheet_index >= wb.sheets.len() {
            continue;
        }
        wb.sparklines.push(crate::SavedSparkline {
            sheet_id: wb.sheets[ms.sheet_index].id,
            groups_json: ms.groups_json.clone(),
        });
    }

    // Second ZIP pass: native charts + defined names.
    if let Ok(file) = std::fs::File::open(path) {
        if let Ok(mut archive) = zip::ZipArchive::new(file) {
            // Charts come from TWO sources that must be reconciled:
            // - the native OOXML charts in the file (what Excel sees/edits),
            // - the _calcula_meta carry (lossless ChartDefinitions, but STALE
            //   the moment Excel edits/adds/removes charts — Excel preserves
            //   the hidden meta sheet verbatim).
            // Per sheet: if the native chart count matches the number of
            // charts the carry says Calcula emitted natively, the file is
            // untouched -> the lossless carry wins. On ANY mismatch (chart
            // added/removed in Excel, sheets reordered) the NATIVE charts win
            // for that sheet, plus carried charts that never had a native
            // form (non-mappable marks Excel could not have edited).
            let sheet_paths = crate::xlsx_style_reader::build_sheet_path_mapping(&mut archive);
            let native_entries =
                crate::xlsx_chart_reader::parse_xlsx_charts(&mut archive, &sheet_paths);

            let mut native_count: HashMap<usize, usize> = HashMap::new();
            for (sheet_idx, _) in &native_entries {
                *native_count.entry(*sheet_idx).or_insert(0) += 1;
            }
            let mut emitted_count: HashMap<usize, usize> = HashMap::new();
            for mc in meta_charts.iter().filter(|mc| mc.native_emitted) {
                *emitted_count.entry(mc.sheet_index).or_insert(0) += 1;
            }

            let sheet_untouched = |idx: usize| -> bool {
                native_count.get(&idx).copied().unwrap_or(0)
                    == emitted_count.get(&idx).copied().unwrap_or(0)
            };

            // Carried charts: on an untouched sheet all of them restore
            // losslessly; on a touched sheet only the never-emitted ones do.
            for mc in &meta_charts {
                if mc.sheet_index >= wb.sheets.len() {
                    continue;
                }
                if !sheet_untouched(mc.sheet_index) && mc.native_emitted {
                    continue; // superseded by the Excel-edited native charts
                }
                // Keep the original chart identity when the carried spec has
                // one, so a round-trip preserves chart ids.
                let id = serde_json::from_str::<serde_json::Value>(&mc.spec_json)
                    .ok()
                    .and_then(|def| {
                        def.get("chartId")
                            .and_then(|v| v.as_str())
                            .and_then(identity::EntityId::parse)
                    })
                    .unwrap_or_else(|| {
                        identity::EntityId::from_bytes(identity::generate_uuid_v7())
                    });
                wb.charts.push(crate::SavedChart {
                    id,
                    sheet_id: wb.sheets[mc.sheet_index].id,
                    spec_json: mc.spec_json.clone(),
                });
            }

            // Native charts: only from sheets where the carry is stale (or
            // absent — an Excel-authored file has no carry at all).
            for (sheet_idx, mut chart) in native_entries {
                // A native entry on an "untouched" sheet implies matching
                // emitted-carry entries exist there — the carry restored them.
                if sheet_untouched(sheet_idx) {
                    continue;
                }
                // Resolve the positional sheet index to the sheet's stable SheetId
                if sheet_idx < wb.sheets.len() {
                    chart.sheet_id = wb.sheets[sheet_idx].id;
                }
                // Update the sheetIndex inside the JSON spec (positional, for rendering)
                chart.spec_json = chart.spec_json.replacen(
                    "\"sheetIndex\":0",
                    &format!("\"sheetIndex\":{}", sheet_idx),
                    1,
                );
                // Mint unique chart ID
                chart.id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
                // Also update chartId in spec JSON
                chart.spec_json = chart.spec_json.replacen(
                    "\"chartId\":0",
                    &format!("\"chartId\":\"{}\"", chart.id),
                    1,
                );
                wb.charts.push(chart);
            }

            // Defined names -> named ranges. localSheetId indexes the FULL
            // workbook.xml sheet order (calamine's sheet_names order, which
            // includes _calcula_meta), so resolve through sheet_names first.
            //
            // Calcula's runtime name map is keyed by UPPERCASE NAME ONLY, so
            // Excel's same-name-different-scope pattern (a "Total" per sheet)
            // cannot be represented: keep ONE entry per name, preferring the
            // workbook-scoped one (usable from every sheet), else the first
            // seen — and warn instead of letting a later insert silently win.
            let defined = crate::xlsx_style_reader::parse_defined_names(&mut archive);
            let mut by_name: HashMap<String, usize> = HashMap::new();
            for (name, refers_to, local_idx) in defined {
                // Excel built-ins (_xlnm.Print_Area etc.) are not user names.
                if name.starts_with("_xlnm.") {
                    continue;
                }
                let sheet_id = match local_idx {
                    Some(i) => {
                        let Some(nm) = sheet_names.get(i) else { continue };
                        if nm == META_SHEET_NAME {
                            continue;
                        }
                        match wb.sheets.iter().find(|s| &s.name == nm) {
                            Some(s) => Some(s.id),
                            None => continue,
                        }
                    }
                    None => None,
                };
                let refers_to = if refers_to.starts_with('=') {
                    refers_to
                } else {
                    format!("={}", refers_to)
                };
                let key = name.trim().to_uppercase();
                if let Some(&existing_idx) = by_name.get(&key) {
                    let existing_is_global = wb.named_ranges[existing_idx].sheet_id.is_none();
                    if !existing_is_global && sheet_id.is_none() {
                        // Workbook scope supersedes a sheet-scoped duplicate.
                        eprintln!(
                            "[WARN] xlsx open: defined name '{}' exists in multiple scopes; keeping the workbook-scoped one",
                            name
                        );
                        wb.named_ranges[existing_idx] = crate::SavedNamedRange {
                            name,
                            refers_to,
                            sheet_id,
                            comment: None,
                            folder: None,
                        };
                    } else {
                        eprintln!(
                            "[WARN] xlsx open: defined name '{}' exists in multiple scopes; keeping the first imported",
                            name
                        );
                    }
                    continue;
                }
                by_name.insert(key, wb.named_ranges.len());
                wb.named_ranges.push(crate::SavedNamedRange {
                    name,
                    refers_to,
                    sheet_id,
                    comment: None,
                    folder: None,
                });
            }
        }
    }

    Ok(wb)
}
