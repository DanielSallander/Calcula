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

    // Track 1-based sheet index (matching xl/worksheets/sheetN.xml numbering)
    let mut sheet_number: usize = 0;

    for sheet_name in &sheet_names {
        sheet_number += 1;

        // Check if this is the Calcula metadata sheet
        if sheet_name == META_SHEET_NAME {
            // Extract metadata (tables, etc.) from the hidden sheet
            if let Ok(range) = workbook.worksheet_range(sheet_name) {
                if let Some(row) = range.rows().next() {
                    if let Some(Data::String(json)) = row.first() {
                        if let Some(meta) = CalculaMeta::from_json(json) {
                            tables = meta.tables;
                        }
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
        let start_row_offset = range_start.0 as u32;
        let start_col_offset = range_start.1 as u32;

        for (row_idx, row) in range.rows().enumerate() {
            let actual_row = start_row_offset + row_idx as u32;
            for (col_idx, cell) in row.iter().enumerate() {
                let actual_col = start_col_offset + col_idx as u32;

                let saved_value = match cell {
                    Data::Empty => continue,
                    Data::String(s) => SavedCellValue::Text(s.clone()),
                    Data::Float(f) => SavedCellValue::Number(*f),
                    Data::Int(i) => SavedCellValue::Number(*i as f64),
                    Data::Bool(b) => SavedCellValue::Boolean(*b),
                    Data::Error(e) => SavedCellValue::Error(format!("{:?}", e)),
                    Data::DateTime(dt) => SavedCellValue::Number(dt.as_f64()),
                    Data::DateTimeIso(s) => SavedCellValue::Text(s.clone()),
                    Data::DurationIso(s) => SavedCellValue::Text(s.clone()),
                };

                // Try to get formula if available
                // Range::get() uses relative (0-based) coordinates
                let formula = workbook
                    .worksheet_formula(sheet_name)
                    .ok()
                    .and_then(|formulas| {
                        formulas
                            .get((row_idx, col_idx))
                            .map(|f| format!("={}", f))
                    });

                // Look up the XLSX style index for this cell (using absolute coords
                // since the XML parser stores absolute positions)
                let style_index = sheet_meta
                    .and_then(|m| m.cell_styles.get(&(actual_row, actual_col)))
                    .and_then(|xlsx_xf| xf_to_calcula.get(xlsx_xf))
                    .copied()
                    .unwrap_or(0);

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

        sheets.push(Sheet {
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
        });
    }

    Ok(Workbook {
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
        named_ranges: Vec::new(),
    })
}
