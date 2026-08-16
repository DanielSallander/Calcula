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

/// Strip Excel's "future function" namespace prefixes from a stored formula.
///
/// Excel stores every function added after 2007 with a namespace prefix so that
/// Excel 2007 opens the file without silently computing something else:
/// `_xlfn.` for the function itself, `_xlfn._xlws.` for the worksheet-only
/// dynamic-array functions (FILTER, SORT), and `_xlpm.` for LAMBDA parameter
/// names. The prefixes are a STORAGE detail, not part of the function name --
/// Excel's own UI shows `STDEV.S`, never `_xlfn.STDEV.S`.
///
/// Calcula implements all of these, so the only thing that stood between it and
/// correct import of any modern .xlsx was this strip: the lexer accepts `_` as a
/// start character and `.` as a continuation, so `_xlfn.STDEV.S` lexed as ONE
/// identifier, resolved to no builtin, and every post-2007 function in the file
/// evaluated to `#NAME?`.
///
/// The scan is STRING-LITERAL AWARE. `=CONCAT("_xlfn.NOT_A_FUNC",A1)` is a
/// formula whose text legitimately contains the prefix; rewriting inside the
/// quotes would corrupt the user's data. Doubled quotes (`""`) are Excel's
/// escape for a literal quote inside a string and keep us inside the literal.
///
/// The export side needs no counterpart: `rust_xlsxwriter::Formula::new`
/// re-adds the prefixes from its own table when it writes the formula back.
pub(crate) fn strip_future_function_prefixes(formula: &str) -> String {
    const PREFIXES: [&str; 3] = ["_xlfn._xlws.", "_xlfn.", "_xlpm."];

    let bytes = formula.as_bytes();
    let mut out = String::with_capacity(formula.len());
    let mut i = 0;
    let mut in_string = false;

    while i < bytes.len() {
        let c = bytes[i];

        if in_string {
            out.push(c as char);
            if c == b'"' {
                // `""` inside a literal is an escaped quote, not the end.
                if i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                    out.push('"');
                    i += 2;
                    continue;
                }
                in_string = false;
            }
            i += 1;
            continue;
        }

        if c == b'"' {
            in_string = true;
            out.push('"');
            i += 1;
            continue;
        }

        // Only strip at an identifier BOUNDARY: the prefix must not be the tail
        // of a longer name (a user range named `MY_xlfn.X` is not a prefix).
        let at_boundary = i == 0 || {
            let prev = bytes[i - 1];
            !(prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'.')
        };
        if at_boundary {
            if let Some(p) = PREFIXES
                .iter()
                .find(|p| formula[i..].starts_with(**p))
            {
                i += p.len();
                continue;
            }
        }

        out.push(c as char);
        i += 1;
    }

    out
}

/// Map calamine's error enum onto the literal Excel spells it with.
///
/// This used to be `format!("{:?}", e)`, which wrote calamine's DEBUG names --
/// `Div0`, `NA`, `Ref`, `Name`, `Null`, `Num` -- into the saved value. Nothing
/// reads those back: `CellError::from_literal` matches `#...` literals and falls
/// through to `Value`, so EVERY error cell imported from an .xlsx became
/// `#VALUE!`, changing what `ERROR.TYPE` reports and which branch `IFERROR`
/// takes. It is the same defect `SavedCellValue::from_value` carries a comment
/// about having fixed on the `.cala` side; the xlsx sibling was missed.
fn error_literal(e: &calamine::CellErrorType) -> String {
    use calamine::CellErrorType as E;
    match e {
        E::Div0 => "#DIV/0!",
        E::NA => "#N/A",
        E::Name => "#NAME?",
        E::Null => "#NULL!",
        E::Num => "#NUM!",
        E::Ref => "#REF!",
        E::Value => "#VALUE!",
        // Excel writes this while an external query is still loading. It has no
        // literal of its own in Excel's error set; `#N/A` is what a stale query
        // cell shows once the fetch is abandoned, which is the closest true
        // statement Calcula can make about a value it does not have.
        E::GettingData => "#N/A",
    }
    .to_string()
}

/// Days between the 1900 and 1904 date-system epochs.
///
/// 1904-01-01 is serial 1462 in the 1900 system and serial 0 in the 1904 one,
/// so a 1904 serial becomes a 1900 serial by adding this. Four years and a day:
/// the extra day is Excel's deliberate 1900-02-29, a date that never existed
/// and which Lotus 1-2-3 had, which the 1904 system does not reproduce.
pub(crate) const DATE_SYSTEM_OFFSET: f64 = 1462.0;

/// Should a cell carrying this format have its serial converted from the 1904
/// date system to the 1900 one?
///
/// The conversion is a DATE conversion, and applying it to a number that is
/// not a date corrupts it, so this is deliberately narrow:
///
/// * `Date` — always. This is the case the whole feature exists for.
/// * `Time` — only when the value carries a DATE PART (`>= 1`). A bare time of
///   day (0.5 = noon) is the same number in both systems; adding 1462 to it
///   would still display as noon but would silently turn a duration into an
///   instant in 1904.
/// * `Custom` — when the format string contains an unquoted `y` or `d`, the
///   two tokens that cannot appear in a pure time format (`m` is ambiguous:
///   it is both "month" and "minute"). An ELAPSED format (`[h]`, `[mm]`,
///   `[ss]`) is a DURATION and is never converted, whatever else it contains.
/// * everything else — never.
fn converts_from_1904(format: &engine::style::NumberFormat, value: f64) -> bool {
    use engine::style::NumberFormat;

    /// `[h]`, `[mm]`, `[ss]` — Excel's ELAPSED-time brackets. A cell using one
    /// holds a DURATION, not an instant, and a duration has no epoch: 1.25 is
    /// thirty hours in both date systems. Built-in numFmtId 46 (`[h]:mm:ss`)
    /// parses to `Time`, not `Custom`, so this check has to cover both arms.
    fn is_elapsed(fmt: &str) -> bool {
        fmt.contains("[h") || fmt.contains("[H") || fmt.contains("[m") || fmt.contains("[s")
    }

    match format {
        NumberFormat::Date { format } => !is_elapsed(format),
        NumberFormat::Time { format } => !is_elapsed(format) && value >= 1.0,
        NumberFormat::Custom { format } => {
            if is_elapsed(format) {
                return false;
            }
            let mut in_quotes = false;
            let mut has_date_token = false;
            for ch in format.chars() {
                match ch {
                    '"' => in_quotes = !in_quotes,
                    'y' | 'Y' | 'd' | 'D' if !in_quotes => has_date_token = true,
                    _ => {}
                }
            }
            has_date_token
        }
        _ => false,
    }
}

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
    // `<workbookPr date1904="1">`: every date serial in this file counts from
    // 1904-01-01 and has to be moved onto Calcula's 1900 epoch. See
    // `converts_from_1904` for exactly which cells that is.
    let date1904 = style_data.as_ref().map_or(false, |sd| sd.date1904);

    // Pre-build the CellStyle palette from XLSX XF records.
    // Index 0 in calcula_styles is always the default style.
    // We build a mapping from xlsx_xf_index -> calcula style index.
    let mut calcula_styles: Vec<CellStyle> = vec![CellStyle::new()];
    let mut xf_to_calcula: HashMap<u32, usize> = HashMap::new();

    if let Some(ref sd) = style_data {
        // Index of the one explicit duplicate of the default style (mirrors
        // StyleRegistry::get_or_create_explicit). Created on first need.
        let mut explicit_default: Option<usize> = None;
        for (xf_idx, xf) in sd.cell_xfs.iter().enumerate() {
            let style =
                xf_to_cell_style(xf, &sd.fonts, &sd.fills, &sd.borders, &sd.number_formats);

            if style == CellStyle::new() {
                // xf 0 is the file's Normal: a cell referencing it (or carrying
                // no s= at all) has no explicit format, and 0 — "inherit the
                // row/column tier" — is exactly right for it.
                //
                // Any OTHER xf that parses to the default was explicitly
                // assigned by the author (formatted then cleared, or locked —
                // `locked: true` IS the default). Mapping those to 0 would let
                // a row/column tier override them: an explicitly locked cell in
                // a tier-unlocked column would import as editable on a
                // protected sheet. Give them the explicit duplicate instead.
                if xf_idx == 0 {
                    xf_to_calcula.insert(xf_idx as u32, 0);
                } else {
                    let idx = *explicit_default.get_or_insert_with(|| {
                        let idx = calcula_styles.len();
                        calcula_styles.push(style.clone());
                        idx
                    });
                    xf_to_calcula.insert(xf_idx as u32, idx);
                }
            } else {
                // Deduplicate: check if we already have this style. Skip the
                // explicit-default duplicate — position() would never find it
                // anyway (it only equals the default, handled above).
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
                    Data::Error(e) => SavedCellValue::Error(error_literal(e)),
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

                // ---- THE 1904 DATE SYSTEM (register S10) -------------------
                // A Mac-authored workbook counts from 1904-01-01, and Calcula
                // stores 1900-system serials. Ignoring the flag -- which is
                // what this reader did -- imported EVERY DATE IN THE FILE four
                // years and a day early, with nothing on screen saying so:
                // the numbers are all valid dates, just the wrong ones.
                //
                // The shift needs the resolved FORMAT (only a date-formatted
                // number is a date), which is why it lives here rather than in
                // the value match above.
                let saved_value = if date1904 {
                    match saved_value {
                        SavedCellValue::Number(n)
                            if converts_from_1904(
                                &calcula_styles[style_index].number_format,
                                n,
                            ) =>
                        {
                            SavedCellValue::Number(n + DATE_SYSTEM_OFFSET)
                        }
                        other => other,
                    }
                } else {
                    saved_value
                };

                // Try to get formula if available
                // Convert absolute cell position to formula range's relative coordinates
                let formula = formula_range.as_ref().and_then(|fr| {
                    if actual_row >= formula_start.0 && actual_col >= formula_start.1 {
                        let fr_row = (actual_row - formula_start.0) as usize;
                        let fr_col = (actual_col - formula_start.1) as usize;
                        fr.get((fr_row, fr_col))
                            .filter(|f| !f.is_empty())
                            .map(|f| format!("={}", strip_future_function_prefixes(f)))
                    } else {
                        None
                    }
                });

                // Skip truly empty cells (no value AND default style AND no
                // formula). The formula lookup used to sit BELOW this skip, so a
                // cell written as `<c r="A1"><f>A1*2</f></c>` -- a formula with
                // no cached `<v>`, which LibreOffice and several generators emit
                // whenever the sheet is set to recalculate on load -- was
                // dropped entirely and the formula was lost with it.
                if is_empty && style_index == 0 && formula.is_none() {
                    continue;
                }

                cells.insert(
                    (actual_row, actual_col),
                    SavedCell {
                        value: saved_value,
                        formula,
                        style_index,
                        rich_text: None,
                        // xlsx array formulas are not read as arrays here (see
                        // the `format_version: 0` note below); the host's spill
                        // recovery re-derives the extent by evaluating.
                        spill: None,
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
                                spill: None,
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

        // Tab color, notes, hyperlinks, page setup from the XML parse; sheet
        // visibility from workbook.xml state (hidden sheets stay hidden
        // instead of silently unhiding on import).
        let tab_color = sheet_meta
            .and_then(|m| m.tab_color.clone())
            .unwrap_or_default();
        let visibility = style_data
            .as_ref()
            .and_then(|sd| sd.sheet_visibility.get(&sheet_number).cloned())
            .unwrap_or_else(|| "visible".to_string());
        let notes = sheet_meta.map(|m| m.notes.clone()).unwrap_or_default();
        let hyperlinks = sheet_meta.map(|m| m.hyperlinks.clone()).unwrap_or_default();
        let page_setup = sheet_meta.and_then(|m| m.page_setup.clone());

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
            // Excel writes ONE `hidden="1"` bit with no provenance, and this
            // reader imports no outline structure (`outlines: Vec::new()`
            // below), so nothing in Calcula would re-derive these. Routing them
            // into the USER set is the honest mapping and the only one that
            // survives: `hidden_rows` is a derived cache the app rebuilds from
            // filter+outline at every save, so an import that landed only there
            // came back with every hidden row visible.
            user_hidden_rows: hidden_rows.clone(),
            user_hidden_cols: hidden_cols.clone(),
            hidden_rows,
            hidden_cols,
            tab_color,
            visibility,
            notes,
            hyperlinks,
            page_setup,
            show_gridlines,
            // <sheetView zoomScale="..">, a percent, defaulting to 100 when
            // Excel omitted it. The SPLIT bar is deliberately not imported --
            // see `SheetMeta::zoom_scale` for why its units make a faithful
            // translation impossible without a full layout pass.
            zoom: sheet_meta
                .and_then(|m| m.zoom_scale)
                .map(|z| z as f64)
                .unwrap_or(crate::DEFAULT_SHEET_ZOOM_PERCENT),
            split_row: None,
            split_col: None,
            // The .xlsx reader does not yet map Excel's sheetView display flags
            // (showZeros / showFormulas / view / showRowColHeaders); imports land on
            // the Calcula defaults, same as every other unmapped sheetView attribute.
            display_zeros: true,
            show_formulas: false,
            view_mode: crate::DEFAULT_SHEET_VIEW_MODE.to_string(),
            display_headings: true,
            // <row s=".."> / <col s=".."> translated from RAW xlsx xf indices
            // through the same map the cells use, so a column that Excel styled
            // wholesale stays one entry here instead of becoming a style on
            // every cell. An xf that maps to 0 is the default style, which at
            // the tier level means "no tier" — skip it rather than storing a
            // sentinel the resolver would ignore anyway.
            row_styles: sheet_meta
                .map(|m| {
                    m.row_style_xf
                        .iter()
                        .filter_map(|(&r, xf)| {
                            xf_to_calcula.get(xf).copied().filter(|&i| i != 0).map(|i| (r, i))
                        })
                        .collect()
                })
                .unwrap_or_default(),
            column_styles: sheet_meta
                .map(|m| {
                    m.column_style_xf
                        .iter()
                        .filter_map(|(&c, xf)| {
                            xf_to_calcula.get(xf).copied().filter(|&i| i != 0).map(|i| (c, i))
                        })
                        .collect()
                })
                .unwrap_or_default(),
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
        // The shared authority, not a re-typed literal: an imported xlsx must
        // land on the same grid the app launches with and File > New produces.
        default_row_height: crate::DEFAULT_ROW_HEIGHT_PX,
        default_column_width: crate::DEFAULT_COLUMN_WIDTH_PX,
        // Document properties come off `docProps/core.xml` (S8). This was
        // `WorkbookProperties::default()` while the WRITER emitted title,
        // author, subject, description, keywords and category on every export
        // -- a one-way loss that made a Calcula .xlsx round trip drop the
        // metadata the same Calcula had just written.
        // Document properties come off `docProps/core.xml` (S8). This was
        // `WorkbookProperties::default()` while the WRITER emitted title,
        // author, subject, description, keywords and category on every export
        // -- a one-way loss that made a Calcula .xlsx round trip drop the
        // metadata the same Calcula had just written.
        properties: style_data
            .as_ref()
            .map(|sd| sd.properties.clone())
            .unwrap_or_default(),
        charts: Vec::new(),
        sparklines: Vec::new(),
        floating_ranges: Vec::new(),
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
        media: std::collections::HashMap::new(),
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
        pending_recalc: None,
        // `.xlsx` carries no `.cala` format_version, and this reader does not
        // read xlsx's own array-formula `ref` attributes either (calamine's
        // formula range gives the text, not the `t="array"`/`ref` pair), so an
        // imported dynamic array arrives as an origin formula plus loose
        // literals. `0` puts it below every gate, which is what makes the
        // host's spill recovery run over an import — the same treatment a
        // pre-v7 `.cala` gets, and for the same reason.
        format_version: 0,
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

            // Freshness marker: Calcula appends an orphan part after saving;
            // Excel/LibreOffice drop unreferenced parts on resave. Absent
            // marker = another app resaved this file, so the carry is stale
            // even where the per-sheet chart COUNT happens to match (an Excel
            // edit to an existing chart keeps the count unchanged).
            let marker_present = archive
                .by_name(crate::xlsx_writer::XLSX_FRESHNESS_MARKER)
                .is_ok();

            let mut native_count: HashMap<usize, usize> = HashMap::new();
            for (sheet_idx, _) in &native_entries {
                *native_count.entry(*sheet_idx).or_insert(0) += 1;
            }
            let mut emitted_count: HashMap<usize, usize> = HashMap::new();
            for mc in meta_charts.iter().filter(|mc| mc.native_emitted) {
                *emitted_count.entry(mc.sheet_index).or_insert(0) += 1;
            }

            let sheet_untouched = |idx: usize| -> bool {
                marker_present
                    && native_count.get(&idx).copied().unwrap_or(0)
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
                // Excel built-ins: Print_Area / Print_Titles feed the sheet's
                // page setup (they are sheet-scoped); the rest are internal.
                if name.starts_with("_xlnm.") {
                    if name == "_xlnm.Print_Area" || name == "_xlnm.Print_Titles" {
                        apply_print_defined_name(&mut wb, &sheet_names, &name, &refers_to, local_idx);
                    }
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

/// Apply an Excel `_xlnm.Print_Area` / `_xlnm.Print_Titles` defined name to
/// its sheet's page setup. Multi-range areas (comma-separated) and column
/// titles are skipped — Calcula models a single print area and repeat-rows.
fn apply_print_defined_name(
    wb: &mut Workbook,
    sheet_names: &[String],
    name: &str,
    refers_to: &str,
    local_idx: Option<usize>,
) {
    let Some(i) = local_idx else { return };
    let Some(nm) = sheet_names.get(i) else { return };
    let Some(sheet) = wb.sheets.iter_mut().find(|s| &s.name == nm) else {
        return;
    };
    // "Sheet1!$A$1:$F$20" -> "A1:F20"; "'My Sheet'!$1:$2" -> "1:2".
    let strip = |part: &str| -> String {
        let range = part.rsplit_once('!').map(|(_, r)| r).unwrap_or(part);
        range.replace('$', "")
    };
    if refers_to.contains(',') {
        return; // multi-range: unsupported, keep whatever is already set
    }
    let value = strip(refers_to.trim());
    if value.is_empty() {
        return;
    }
    let ps = sheet
        .page_setup
        .get_or_insert_with(crate::xlsx_style_reader::default_page_setup);
    if name == "_xlnm.Print_Area" {
        ps.print_area = value;
    } else {
        // Print_Titles: only a pure row range ("1:2") maps to repeat-rows.
        let is_row_range = value
            .split(':')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
        if is_row_range {
            ps.print_titles_rows = value;
        }
    }
}
