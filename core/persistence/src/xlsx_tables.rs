//! FILENAME: core/persistence/src/xlsx_tables.rs
//!
//! Excel tables (ListObjects) in an .xlsx file: Calcula's table store written
//! as Excel's own table parts, and an Excel table read back into it.
//!
//! WHAT EXCEL WRITES ([LIVE] Excel 16, a table saved from a fresh instance):
//! one `xl/tables/tableN.xml` per table, linked from its sheet by a
//! `<tableParts><tablePart r:id=".."/></tableParts>` element and a
//! `.../relationships/table` relationship in the sheet's rels, with a
//! `spreadsheetml.table+xml` content type. The part reads
//!
//! ```text
//! <table id="1" name="Sales" displayName="Sales" ref="B2:D6" totalsRowCount="1">
//!   <autoFilter ref="B2:D5"/>
//!   <tableColumns count="3">
//!     <tableColumn id="1" name="Name" totalsRowLabel="Total"/>
//!     <tableColumn id="2" name="Qty" totalsRowFunction="sum"/>
//!     <tableColumn id="3" name="My Col" totalsRowFunction="average">
//!       <calculatedColumnFormula>Sales[[#This Row],[Qty]]*2</calculatedColumnFormula>
//!     </tableColumn>
//!   </tableColumns>
//!   <tableStyleInfo name="TableStyleMedium9" showFirstColumn="0" showLastColumn="0"
//!                   showRowStripes="1" showColumnStripes="0"/>
//! </table>
//! ```
//!
//! and every structured reference in the sheet's cells is QUALIFIED with the
//! table's name, inside the table too (`Sales[[#This Row],[Qty]]*2` in D3,
//! `SUBTOTAL(109,Sales[Qty])` in the totals row), while Excel's own formula
//! bar shows the reference to the cell's own table unqualified (`=[@Qty]*2`,
//! `=SUBTOTAL(109,[Qty])`). Calcula holds the unqualified form, as Excel shows
//! it, so the export qualifies ([`qualify_structured_refs`]) and the import
//! unqualifies ([`unqualify_structured_refs`]). The table's name is written
//! as the table declares it, never as Calcula's lexer folded it
//! ([`respell_table_names`]): Excel refused a file that read `DATA[Q]` for a
//! table called Data.
//!
//! THE PART IS THE ONE SOURCE OF TRUTH. The tables used to ride only the
//! hidden `_calcula_meta` sheet: Excel had no table, so every structured
//! reference in an export showed `#REF!` (BUG-0644), and the carry did not
//! even come back to Calcula -- it named each table's sheet by a `SheetId`
//! the reader re-mints. Tables are no longer in the carry at all.
//!
//! The parts themselves come from rust_xlsxwriter's `Table` API, which writes
//! them, the rels and the content type as Excel does. The API also WRITES
//! CELLS (the header captions, the totals-row formulas, the calculated
//! column's formula into every data row), so [`TableParts::add_to_sheet`]
//! runs before the sheet's own cells are written, and clears what the
//! library wrote where the workbook holds nothing: the sheet's real content
//! then lands over the library's placeholders, as merged regions do.

use crate::xlsx_writer::XlsxExportLosses;
use crate::{
    SavedCell, SavedCellValue, SavedTable, SavedTableColumn, SavedTableStyleOptions, Sheet,
    Workbook, META_SHEET_NAME,
};
use identity::{EntityId, SheetId};
use rust_xlsxwriter::{Table, TableColumn, TableFunction, TableStyle, Worksheet};
use std::collections::HashSet;

// ============================================================================
// WRITE
// ============================================================================

/// The workbook's tables that can be written as Excel table parts, decided
/// once for the whole workbook (a table name is unique across it).
pub(crate) struct TableParts<'a> {
    tables: Vec<&'a SavedTable>,
    /// The workbook's defined names, for the table-level formulas' file text
    /// (`excel_formula_text_with_names`).
    defined: crate::xlsx_formula_text::DefinedNames,
}

impl<'a> TableParts<'a> {
    /// Every table Excel can hold. One it cannot -- a second table of the
    /// same name, one overlapping another, one whose geometry or column list
    /// does not describe its range -- is left out (its cells are still
    /// written) and reported in `losses.tables`: rust_xlsxwriter would refuse
    /// the whole save for a reused name, and Excel repairs a file whose
    /// tables overlap by deleting them.
    pub(crate) fn new(workbook: &'a Workbook, losses: &mut XlsxExportLosses) -> Self {
        let mut ordered: Vec<&SavedTable> = workbook
            .tables
            .iter()
            .filter(|t| workbook.sheets.iter().any(|s| s.id == t.sheet_id))
            .collect();
        // Deterministic output: the store is a map at runtime.
        ordered.sort_by_key(|t| {
            let sheet = workbook.sheets.iter().position(|s| s.id == t.sheet_id).unwrap_or(usize::MAX);
            (sheet, t.start_row, t.start_col)
        });
        let mut names: HashSet<String> = HashSet::new();
        let mut kept: Vec<&SavedTable> = Vec::new();
        for table in ordered {
            let width = table.end_col.checked_sub(table.start_col).map(|w| w as usize + 1);
            let rows = table.end_row.checked_sub(table.start_row).map(|h| h + 1);
            let min_rows = 1 + u32::from(table.style_options.header_row) + u32::from(table.style_options.total_row);
            let shaped = matches!((width, rows), (Some(w), Some(h)) if w == table.columns.len() && h >= min_rows)
                && table.end_row < 1_048_576
                && table.end_col < 16_384;
            let overlaps = kept.iter().any(|k| {
                k.sheet_id == table.sheet_id
                    && k.start_row <= table.end_row
                    && table.start_row <= k.end_row
                    && k.start_col <= table.end_col
                    && table.start_col <= k.end_col
            });
            let mut column_names: HashSet<String> = HashSet::new();
            let columns_unique = table
                .columns
                .iter()
                .all(|c| !c.name.is_empty() && column_names.insert(identity::defined_name_key(&c.name)));
            let named = !table.name.is_empty() && names.insert(identity::defined_name_key(&table.name));
            if shaped && !overlaps && columns_unique && named {
                kept.push(table);
            } else {
                eprintln!("[WARN] xlsx save: table '{}' cannot be written as an Excel table", table.name);
                losses.tables.push(table.name.clone());
            }
        }
        Self { tables: kept, defined: crate::xlsx_formula_text::DefinedNames::of(workbook) }
    }

    fn on_sheet(&self, sheet: SheetId) -> impl Iterator<Item = &&'a SavedTable> {
        self.tables.iter().filter(move |t| t.sheet_id == sheet)
    }

    /// The table names, as each table declares its own.
    fn names(&self) -> Vec<&'a str> {
        self.tables.iter().map(|t| t.name.as_str()).collect()
    }

    /// The sheet as its cells must be written beside its tables, or `None`
    /// when it already is: every structured reference inside a table
    /// qualified with that table's name, every table name spelled as the
    /// table declares it ([`respell_table_names`]), and every header cell
    /// holding its column's name as text ([LIVE] Excel 16 stores a header
    /// typed as the number 2024 as the string "2024", `<c r="E2" t="s">`, and
    /// names the column "2024"; a header cell that is not its column's name
    /// is a file Excel repairs).
    pub(crate) fn export_sheet(&self, sheet: &Sheet) -> Option<Sheet> {
        let mut out: Option<Sheet> = None;
        let names = self.names();
        if !names.is_empty() {
            for (&(row, col), cell) in &sheet.cells {
                let Some(formula) = cell.formula.as_deref() else { continue };
                let own = self.on_sheet(sheet.id).find(|t| {
                    let body_start = if t.style_options.header_row { t.start_row + 1 } else { t.start_row };
                    row >= body_start && row <= t.end_row && col >= t.start_col && col <= t.end_col
                });
                let qualified = own.and_then(|t| qualify_structured_refs(formula, &t.name));
                let text = qualified.as_deref().unwrap_or(formula);
                let written = respell_table_names(text, &names).or(qualified);
                if let Some(written) = written {
                    let target = out.get_or_insert_with(|| sheet.clone());
                    if let Some(c) = target.cells.get_mut(&(row, col)) {
                        c.formula = Some(written);
                    }
                }
            }
        }
        for table in self.on_sheet(sheet.id) {
            if table.style_options.header_row {
                for (i, column) in table.columns.iter().enumerate() {
                    let at = (table.start_row, table.start_col + i as u32);
                    let Some(cell) = sheet.cells.get(&at) else { continue };
                    let is_name = cell.formula.is_none()
                        && cell.rich_text.is_none()
                        && matches!(&cell.value, SavedCellValue::Text(t) if *t == column.name);
                    if !is_name {
                        let target = out.get_or_insert_with(|| sheet.clone());
                        let header = SavedCell {
                            value: SavedCellValue::Text(column.name.clone()),
                            formula: None,
                            style_index: cell.style_index,
                            rich_text: None,
                            spill: None,
                        };
                        target.cells.insert(at, header);
                    }
                }
            }
        }
        out
    }

    /// Add the sheet's tables to its worksheet. MUST run before anything else
    /// writes the sheet's cells (see the module doc): the library writes the
    /// header captions, totals-row formulas and calculated-column formulas
    /// into the cells, and what it writes where `sheet` holds nothing is
    /// cleared again, so the file holds exactly the sheet's content.
    ///
    /// `sheet` is the sheet as [`Self::export_sheet`] gave it.
    pub(crate) fn add_to_sheet(
        &self,
        worksheet: &mut Worksheet,
        sheet: &Sheet,
        losses: &mut XlsxExportLosses,
    ) {
        let names = self.names();
        for table in self.on_sheet(sheet.id) {
            let options = &table.style_options;
            let first_data_row = if options.header_row { table.start_row + 1 } else { table.start_row };
            let columns: Vec<TableColumn> = table
                .columns
                .iter()
                .enumerate()
                .map(|(i, column)| {
                    let col = table.start_col + i as u32;
                    let mut out = TableColumn::new().set_header(column.name.clone());
                    if options.total_row {
                        match total_function(column, &table.name, &names, &self.defined, (table.end_row, col)) {
                            Some(function) => out = out.set_total_function(function),
                            // A custom total Excel cannot hold (or Calcula
                            // cannot read) is left out of the part, and said.
                            None if column.totals_row_function == "custom" => {
                                losses.formulas.push(format!("{}[[#Totals],[{}]]", table.name, column.name));
                            }
                            // A totals cell holding text is Excel's totals-row
                            // LABEL ([LIVE] `totalsRowLabel="Total"` on the
                            // first column of every new totals row).
                            None => {
                                if let Some(SavedCell { value: SavedCellValue::Text(label), formula: None, .. }) =
                                    sheet.cells.get(&(table.end_row, col))
                                {
                                    if !label.is_empty() {
                                        out = out.set_total_label(label.clone());
                                    }
                                }
                            }
                        }
                    } else if let Some(label) = column.totals_row_label.as_deref().filter(|l| !l.is_empty()) {
                        // A HIDDEN totals row keeps the constant a column with
                        // no function showed there: Excel saves it as
                        // `totalsRowLabel="7"` on a table with
                        // `totalsRowShown="0"` ([LIVE] cfdv/probe2.ps1), and
                        // the library writes the attribute alone (no cell)
                        // while the row is hidden (NEW-totals-label-persist).
                        if column.totals_row_function == "none" {
                            out = out.set_total_label(label.to_string());
                        }
                    }
                    match self.calculated_text(table, i, &names) {
                        Some(text) => out = out.set_formula(crate::xlsx_formula_text::library_formula(&text)),
                        // The calculated column Excel cannot hold: its cells
                        // are written (value-only where they cannot be held
                        // either), the column formula is left out, and said.
                        None if column.calculated_formula.is_some() => {
                            losses.formulas.push(format!("{}[{}]", table.name, column.name));
                        }
                        None => {}
                    }
                    out
                })
                .collect();
            let part = Table::new()
                .set_name(table.name.clone())
                .set_header_row(options.header_row)
                .set_total_row(options.total_row)
                .set_banded_rows(options.banded_rows)
                .set_banded_columns(options.banded_columns)
                .set_first_column(options.first_column)
                .set_last_column(options.last_column)
                .set_autofilter(options.show_filter_button)
                .set_style(table_style(&table.style_name))
                .set_columns(&columns);
            if let Err(e) = worksheet.add_table(
                table.start_row,
                table.start_col as u16,
                table.end_row,
                table.end_col as u16,
                &part,
            ) {
                eprintln!("[WARN] xlsx save: table '{}' skipped: {}", table.name, e);
                losses.tables.push(table.name.clone());
                continue;
            }
            // What the library wrote where the sheet holds nothing: a
            // calculated column's data rows and the totals row. The header row
            // keeps the library's caption: a header cell must hold its
            // column's name.
            for (i, column) in table.columns.iter().enumerate() {
                let col = table.start_col + i as u32;
                let rows = if column.calculated_formula.is_some() { first_data_row } else { table.end_row };
                for row in rows..=table.end_row {
                    let written = (row == table.end_row && options.total_row) || column.calculated_formula.is_some();
                    if written && !sheet.cells.contains_key(&(row, col)) {
                        worksheet.clear_cell(row, col as u16);
                    }
                }
            }
        }
    }

    /// Column `index`'s calculated-column formula in its file text, for the
    /// table's first data row, or `None` when the column has none (or it does
    /// not parse). The ONE derivation [`Self::add_to_sheet`] hands the library
    /// and [`Self::finish_archive`] restores.
    fn calculated_text(&self, table: &SavedTable, index: usize, names: &[&str]) -> Option<String> {
        let first_data_row = if table.style_options.header_row { table.start_row + 1 } else { table.start_row };
        let formula = table.columns.get(index)?.calculated_formula.as_deref()?;
        table_formula_text(formula, &table.name, names, &self.defined, (first_data_row, table.start_col + index as u32))
    }

    /// The written archive with every table part's `<calculatedColumnFormula>`
    /// as the file must carry it, or `None` when nothing needs it (the archive
    /// is kept byte for byte -- every workbook whose calculated columns hold no
    /// `@`).
    ///
    /// rust_xlsxwriter's `TableColumn::set_formula` rewrites EVERY `@` outside
    /// a double-quoted string to `[#This Row],` (`escape_table_functions`,
    /// 0.79.4: the Excel 2010 short form it expects to be handed). A file text
    /// never holds that form -- the this-row reference is already the long
    /// `[[#This Row],[Col]]` -- so the only `@` left is a NAME's, and the rewrite
    /// garbles it: a column called `a@b` came out
    /// `TH[[#This Row],[a[#This Row],b]]*2`. [LIVE, Excel 16, 2026-11-05,
    /// tablefix-probe/probe5.ps1] Excel saves `=[@[a'@b]]*2` (as its formula
    /// bar shows it) as `<calculatedColumnFormula>TH[[#This Row],[a@b]]*2`, the
    /// `@` unescaped, and so does the cell. The library offers no way past the
    /// rewrite, so each garbled element is put back after it wrote the part.
    pub(crate) fn finish_archive(&self, xlsx: &[u8]) -> Result<Option<Vec<u8>>, crate::PersistenceError> {
        use std::io::{Read, Write};
        let names = self.names();
        let mut restore: Vec<(String, String)> = Vec::new();
        for table in &self.tables {
            for index in 0..table.columns.len() {
                let Some(text) = self.calculated_text(table, index, &names) else { continue };
                let file = crate::xlsx_formula_text::escape_future_functions(&text);
                let garbled = library_table_rewrite(&file);
                if garbled != file {
                    let element = |f: &str| format!("<calculatedColumnFormula>{}</calculatedColumnFormula>", xml_text(f));
                    restore.push((element(&garbled), element(&file)));
                }
            }
        }
        if restore.is_empty() {
            return Ok(None);
        }
        let invalid = |e: zip::result::ZipError| crate::PersistenceError::InvalidFormat(format!("xlsx table parts: {}", e));
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(xlsx)).map_err(invalid)?;
        let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let deflated = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(invalid)?;
            let name = entry.name().to_string();
            if !(name.starts_with("xl/tables/") && name.ends_with(".xml")) {
                out.raw_copy_file(entry).map_err(invalid)?;
                continue;
            }
            let mut xml = String::new();
            entry.read_to_string(&mut xml)?;
            drop(entry);
            for (garbled, file) in &restore {
                if xml.contains(garbled.as_str()) {
                    xml = xml.replace(garbled.as_str(), file);
                }
            }
            out.start_file(name, deflated).map_err(invalid)?;
            out.write_all(xml.as_bytes())?;
        }
        Ok(Some(out.finish().map_err(invalid)?.into_inner()))
    }
}

/// What rust_xlsxwriter's `Formula::escape_table_functions` (0.79.4) makes of
/// a calculated-column formula: every `@` outside a double-quoted string
/// becomes `[#This Row],` (see [`TableParts::finish_archive`]).
fn library_table_rewrite(formula: &str) -> String {
    let mut in_string = false;
    let mut out = String::with_capacity(formula.len());
    for c in formula.chars() {
        if c == '"' {
            in_string = !in_string;
        }
        if c == '@' && !in_string {
            out.push_str("[#This Row],");
        } else {
            out.push(c);
        }
    }
    out
}

/// An element's text escaped as rust_xlsxwriter writes it (`&`, `<`, `>`).
fn xml_text(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// A table-level formula (a calculated column's, a custom total's) as an
/// .xlsx part carries it: canonicalised through the parser the way a cell's
/// formula is (`SavedCell::from_cell`), its structured references qualified,
/// and in Excel's file spelling for the cell `anchor`, with the workbook's
/// defined names (`excel_formula_text_with_names`: [LIVE] Excel saves
/// `=[@V]*Rate`, `Rate` a defined name, as `TJ[[#This Row],[V]]*Rate`, where
/// the name-blind spelling made `Rate` the function value `_xleta.RATE`).
/// `None` when it does not parse, or when Excel could not hold it
/// (`unwritable_reason`): Excel cannot be handed a formula Calcula itself
/// cannot read, and refuses a file whose part holds one it cannot.
fn table_formula_text(
    formula: &str,
    table: &str,
    names: &[&str],
    defined: &crate::xlsx_formula_text::DefinedNames,
    anchor: (u32, u32),
) -> Option<String> {
    let typed = if formula.starts_with('=') { formula.to_string() } else { format!("={}", formula) };
    let canonical = SavedCell::from_cell(&engine::Cell::new_formula(typed)).formula?;
    let qualified = qualify_structured_refs(&canonical, table).unwrap_or(canonical);
    let qualified = respell_table_names(&qualified, names).unwrap_or(qualified);
    // A formula Excel cannot hold is no part of the part: [LIVE] Excel 16
    // refused the WHOLE file whose calculated column was `=ROUND([@Qty])`
    // (rev-xlsx-2) -- the cells already went value-only, the part kept it.
    if crate::xlsx_formula_text::unwritable_reason(&qualified, Some(anchor)).is_some() {
        return None;
    }
    Some(crate::xlsx_formula_text::excel_formula_text_with_names(&qualified, Some(anchor), defined))
}

/// A column's totals-row function as the library spells it, or `None` for no
/// function. Calcula's names are Excel's `ST_TotalsRowFunction` except
/// `countNumbers`, which Excel calls `countNums` ([LIVE] Count Numbers is
/// `totalsRowFunction="countNums"` with `SUBTOTAL(102,..)`; Count is
/// `"count"` with `SUBTOTAL(103,..)`).
fn total_function(
    column: &SavedTableColumn,
    table: &str,
    names: &[&str],
    defined: &crate::xlsx_formula_text::DefinedNames,
    anchor: (u32, u32),
) -> Option<TableFunction> {
    Some(match column.totals_row_function.as_str() {
        "average" => TableFunction::Average,
        "count" => TableFunction::Count,
        "countNumbers" => TableFunction::CountNumbers,
        "max" => TableFunction::Max,
        "min" => TableFunction::Min,
        "sum" => TableFunction::Sum,
        "stdDev" => TableFunction::StdDev,
        "var" => TableFunction::Var,
        "custom" => {
            let text = table_formula_text(column.totals_row_formula.as_deref()?, table, names, defined, anchor)?;
            TableFunction::Custom(crate::xlsx_formula_text::library_formula(&text))
        }
        _ => return None,
    })
}

/// Every built-in table style, in the library's spelling. A style name the
/// list does not hold -- "" (Calcula's "None") or a custom style -- is written
/// with no style name, which is how Excel saves a table styled None ([LIVE]
/// `<tableStyleInfo showFirstColumn="0" .. />` with no `name`).
const TABLE_STYLES: [TableStyle; 60] = [
    TableStyle::Light1, TableStyle::Light2, TableStyle::Light3, TableStyle::Light4,
    TableStyle::Light5, TableStyle::Light6, TableStyle::Light7, TableStyle::Light8,
    TableStyle::Light9, TableStyle::Light10, TableStyle::Light11, TableStyle::Light12,
    TableStyle::Light13, TableStyle::Light14, TableStyle::Light15, TableStyle::Light16,
    TableStyle::Light17, TableStyle::Light18, TableStyle::Light19, TableStyle::Light20,
    TableStyle::Light21,
    TableStyle::Medium1, TableStyle::Medium2, TableStyle::Medium3, TableStyle::Medium4,
    TableStyle::Medium5, TableStyle::Medium6, TableStyle::Medium7, TableStyle::Medium8,
    TableStyle::Medium9, TableStyle::Medium10, TableStyle::Medium11, TableStyle::Medium12,
    TableStyle::Medium13, TableStyle::Medium14, TableStyle::Medium15, TableStyle::Medium16,
    TableStyle::Medium17, TableStyle::Medium18, TableStyle::Medium19, TableStyle::Medium20,
    TableStyle::Medium21, TableStyle::Medium22, TableStyle::Medium23, TableStyle::Medium24,
    TableStyle::Medium25, TableStyle::Medium26, TableStyle::Medium27, TableStyle::Medium28,
    TableStyle::Dark1, TableStyle::Dark2, TableStyle::Dark3, TableStyle::Dark4,
    TableStyle::Dark5, TableStyle::Dark6, TableStyle::Dark7, TableStyle::Dark8,
    TableStyle::Dark9, TableStyle::Dark10, TableStyle::Dark11,
];

fn table_style(name: &str) -> TableStyle {
    let name = name.trim();
    TABLE_STYLES
        .iter()
        .find(|s| s.to_string().eq_ignore_ascii_case(name))
        .cloned()
        .unwrap_or(TableStyle::None)
}

// ============================================================================
// STRUCTURED-REFERENCE QUALIFICATION
// ============================================================================

/// Whether `c`, as the last character before a `[`, ends an operand -- a name
/// (`Sales[`, `A1[` a subscript), a call or group (`)[`), a reference or an
/// error (`]`, `!`, `#`), a string or a quoted sheet. A `[` after anything
/// else (an operator, `(`, `,`, the leading `=`, nothing) opens an
/// UNQUALIFIED structured reference, exactly where Calcula's parser reads one
/// (`parse_primary`'s `Token::LBracket` / `Token::At` arms).
fn ends_operand(c: char) -> bool {
    c.is_alphanumeric()
        || matches!(c, '_' | '.' | '\\' | '?' | ')' | ']' | '}' | '"' | '\'' | '!' | '#' | '%' | '$')
}

/// Whether `c` continues a name, as Calcula's lexer reads one.
fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '.' | '\\' | '?')
}

/// Copy a quoted run (`"..."` with `""`, `'...'` with `''`) starting at
/// `chars[i]`; returns the index after it.
fn copy_quoted(chars: &[char], mut i: usize, out: &mut String) -> usize {
    let quote = chars[i];
    out.push(quote);
    i += 1;
    while i < chars.len() {
        let c = chars[i];
        out.push(c);
        i += 1;
        if c == quote {
            if chars.get(i) == Some(&quote) {
                out.push(quote);
                i += 1;
                continue;
            }
            break;
        }
    }
    i
}

/// Copy a bracketed structured-reference body starting at the `[` at
/// `chars[i]`, nested brackets and the `'` escape included (the lexer's
/// `scan_bracket_body`); returns the index after its closing `]`.
fn copy_bracket(chars: &[char], mut i: usize, out: &mut String) -> usize {
    let mut depth = 0usize;
    while i < chars.len() {
        let c = chars[i];
        out.push(c);
        i += 1;
        match c {
            '\'' => {
                if let Some(&next) = chars.get(i) {
                    out.push(next);
                    i += 1;
                }
            }
            '[' => depth += 1,
            ']' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
    }
    i
}

/// `formula` with every UNQUALIFIED structured reference (`[@Qty]`, `[Qty]`,
/// `[[#Totals],[Qty]]`, `@[Qty]`) qualified with `table`, as Excel's file
/// spells a reference to the cell's own table ([LIVE] `[@Qty]*2` in a table
/// called Sales is saved `Sales[[#This Row],[Qty]]*2`). `None` when there is
/// nothing to qualify. Strings, quoted sheet names and bracket bodies are
/// copied as they are.
pub(crate) fn qualify_structured_refs(formula: &str, table: &str) -> Option<String> {
    let chars: Vec<char> = formula.chars().collect();
    let mut out = String::with_capacity(formula.len() + table.len() * 2);
    let mut changed = false;
    let mut prev: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '"' | '\'' => {
                i = copy_quoted(&chars, i, &mut out);
                prev = Some(c);
            }
            '[' => {
                if !prev.is_some_and(ends_operand) {
                    out.push_str(table);
                    changed = true;
                }
                i = copy_bracket(&chars, i, &mut out);
                prev = Some(']');
            }
            c if c.is_whitespace() => {
                out.push(c);
                i += 1;
            }
            _ => {
                out.push(c);
                prev = Some(c);
                i += 1;
            }
        }
    }
    changed.then_some(out)
}

/// The inverse of [`qualify_structured_refs`] for a cell inside `table`: a
/// structured reference that names `table` itself loses the name, as Excel's
/// formula bar shows it ([LIVE] `=SUM(Data[P])` typed into Data's own cell
/// reads back `=SUM([P])`, `=COUNTA(Sales[Name])&"x"` in Sales' totals row
/// `=COUNTA([Name])&"x"`). A reference to another table, or a name that only
/// contains the table's (`Sales2[`, `x.Sales[`, `Sheet1!Sales[`), is kept.
pub(crate) fn unqualify_structured_refs(formula: &str, table: &str) -> Option<String> {
    let chars: Vec<char> = formula.chars().collect();
    let mut out = String::with_capacity(formula.len());
    let mut changed = false;
    let mut prev: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '"' | '\'' => {
                i = copy_quoted(&chars, i, &mut out);
                prev = Some(c);
            }
            '[' => {
                i = copy_bracket(&chars, i, &mut out);
                prev = Some(']');
            }
            c if is_name_char(c) => {
                let start = i;
                while i < chars.len() && is_name_char(chars[i]) {
                    i += 1;
                }
                let name: String = chars[start..i].iter().collect();
                let standalone = !prev.is_some_and(ends_operand);
                if standalone && chars.get(i) == Some(&'[') && identity::defined_names_equal(&name, table) {
                    changed = true;
                } else {
                    out.push_str(&name);
                }
                prev = chars.get(i.saturating_sub(1)).copied();
            }
            c if c.is_whitespace() => {
                out.push(c);
                i += 1;
            }
            _ => {
                out.push(c);
                prev = Some(c);
                i += 1;
            }
        }
    }
    changed.then_some(out)
}

/// `formula` with every table name before a structured reference spelled as
/// the table declares it, or `None` when each already is. Calcula's lexer
/// folds a name to upper case, so the stored text reads `SUM(DATA[Q])` for a
/// table called Data; Excel writes the declared spelling, and [LIVE] Excel 16
/// REFUSED the whole workbook ("Unable to get the Open property") when a
/// totals row read `SUBTOTAL(103,DATA[Q])` for that table -- the same file
/// with `Data[Q]` opened and calculated. `names` are the declared names.
pub(crate) fn respell_table_names(formula: &str, names: &[&str]) -> Option<String> {
    let chars: Vec<char> = formula.chars().collect();
    let mut out = String::with_capacity(formula.len());
    let mut changed = false;
    let mut prev: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '"' | '\'' => {
                i = copy_quoted(&chars, i, &mut out);
                prev = Some(c);
            }
            '[' => {
                i = copy_bracket(&chars, i, &mut out);
                prev = Some(']');
            }
            c if is_name_char(c) => {
                let start = i;
                while i < chars.len() && is_name_char(chars[i]) {
                    i += 1;
                }
                let name: String = chars[start..i].iter().collect();
                let declared = (!prev.is_some_and(ends_operand) && chars.get(i) == Some(&'['))
                    .then(|| names.iter().find(|n| identity::defined_names_equal(n, &name)))
                    .flatten();
                match declared {
                    Some(declared) if **declared != name => {
                        out.push_str(declared);
                        changed = true;
                    }
                    _ => out.push_str(&name),
                }
                prev = chars.get(i.saturating_sub(1)).copied();
            }
            c if c.is_whitespace() => {
                out.push(c);
                i += 1;
            }
            _ => {
                out.push(c);
                prev = Some(c);
                i += 1;
            }
        }
    }
    changed.then_some(out)
}

// ============================================================================
// READ
// ============================================================================

/// Every Excel table in the archive, into the workbook's table store, keyed
/// to the sheets `load_xlsx` built (by their re-minted `SheetId`s). A cell
/// inside a table gets the reference to its own table back in the
/// unqualified form Calcula holds (see the module doc). `sheet_paths` is
/// `build_sheet_path_mapping`'s (1-based position in workbook.xml -> sheet
/// part), `sheet_names` the workbook.xml order (calamine's `sheet_names`).
pub(crate) fn read_table_parts<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    sheet_paths: &[(usize, String)],
    sheet_names: &[String],
    wb: &mut Workbook,
) {
    let mut tables: Vec<SavedTable> = Vec::new();
    for (position, sheet_path) in sheet_paths {
        let Some(sheet_name) = position.checked_sub(1).and_then(|p| sheet_names.get(p)) else { continue };
        if sheet_name == META_SHEET_NAME {
            continue;
        }
        let Some(sheet_index) = wb.sheets.iter().position(|s| &s.name == sheet_name) else { continue };
        let sheet_id = wb.sheets[sheet_index].id;
        let Some(rels) = read_entry(archive, &rels_path_of(sheet_path)) else { continue };
        for target in table_targets(&rels) {
            let part = resolve_target(sheet_path, &target);
            let Some(xml) = read_entry(archive, &part) else { continue };
            let Some(table) = parse_table_part(&xml, sheet_id) else { continue };
            let sheet = &mut wb.sheets[sheet_index];
            for (&(row, col), cell) in sheet.cells.iter_mut() {
                if row < table.start_row || row > table.end_row || col < table.start_col || col > table.end_col {
                    continue;
                }
                if let Some(short) = cell.formula.as_deref().and_then(|f| unqualify_structured_refs(f, &table.name)) {
                    cell.formula = Some(short);
                }
            }
            tables.push(table);
        }
    }
    wb.tables = tables;
}

fn read_entry<R: std::io::Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>, name: &str) -> Option<String> {
    use std::io::Read;
    let mut entry = archive.by_name(name).ok()?;
    let mut text = String::new();
    entry.read_to_string(&mut text).ok()?;
    Some(text)
}

/// `xl/worksheets/sheet1.xml` -> `xl/worksheets/_rels/sheet1.xml.rels`.
fn rels_path_of(part: &str) -> String {
    match part.rfind('/') {
        Some(at) => format!("{}/_rels/{}.rels", &part[..at], &part[at + 1..]),
        None => format!("_rels/{}.rels", part),
    }
}

/// A relationship target relative to the part that holds it
/// (`../tables/table1.xml` from `xl/worksheets/sheet1.xml` is
/// `xl/tables/table1.xml`); an absolute target (`/xl/tables/table1.xml`) is
/// from the package root.
fn resolve_target(part: &str, target: &str) -> String {
    if let Some(absolute) = target.strip_prefix('/') {
        return absolute.to_string();
    }
    let mut segments: Vec<&str> = part.split('/').collect();
    segments.pop();
    for piece in target.split('/') {
        match piece {
            ".." => {
                segments.pop();
            }
            "." | "" => {}
            other => segments.push(other),
        }
    }
    segments.join("/")
}

fn attributes_of(e: &quick_xml::events::BytesStart) -> Vec<(String, String)> {
    e.attributes()
        .flatten()
        .map(|a| {
            let key = String::from_utf8_lossy(a.key.local_name().as_ref()).into_owned();
            let raw = String::from_utf8_lossy(&a.value).into_owned();
            let value = quick_xml::escape::unescape(&raw).map(|v| v.into_owned()).unwrap_or(raw.clone());
            (key, value)
        })
        .collect()
}

fn attribute<'b>(attributes: &'b [(String, String)], name: &str) -> Option<&'b str> {
    attributes.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

/// The targets of a sheet's TABLE relationships.
fn table_targets(rels: &str) -> Vec<String> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(rels);
    let mut out = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == b"Relationship" => {
                let attrs = attributes_of(&e);
                let table = attribute(&attrs, "Type").is_some_and(|t| t.ends_with("/relationships/table"));
                if let (true, Some(target)) = (table, attribute(&attrs, "Target")) {
                    out.push(target.to_string());
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

/// Excel's `_xHHHH_` escape of a character XML cannot hold in a name (a line
/// break in a column caption is `_x000a_`), decoded.
fn decode_ooxml_escapes(s: &str) -> String {
    if !s.contains("_x") {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find("_x") {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let decoded = tail
            .get(2..6)
            .filter(|hex| hex.chars().all(|c| c.is_ascii_hexdigit()))
            .filter(|_| tail.get(6..7) == Some("_"))
            .and_then(|hex| u32::from_str_radix(hex, 16).ok())
            .and_then(char::from_u32);
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &tail[7..];
            }
            None => {
                out.push_str("_x");
                rest = &tail[2..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `B2:D6` (or one cell) as 0-based `(start_row, start_col, end_row, end_col)`.
fn parse_ref(range: &str) -> Option<(u32, u32, u32, u32)> {
    fn cell(a1: &str) -> Option<(u32, u32)> {
        let a1 = a1.replace('$', "");
        let split = a1.find(|c: char| c.is_ascii_digit())?;
        let (letters, digits) = a1.split_at(split);
        if letters.is_empty() || !letters.chars().all(|c| c.is_ascii_alphabetic()) {
            return None;
        }
        let col = letters
            .chars()
            .try_fold(0u32, |acc, c| acc.checked_mul(26)?.checked_add(c.to_ascii_uppercase() as u32 - 'A' as u32 + 1))?;
        let row: u32 = digits.parse().ok()?;
        Some((row.checked_sub(1)?, col.checked_sub(1)?))
    }
    let (first, last) = match range.split_once(':') {
        Some((a, b)) => (cell(a)?, cell(b)?),
        None => {
            let one = cell(range)?;
            (one, one)
        }
    };
    Some((first.0.min(last.0), first.1.min(last.1), first.0.max(last.0), first.1.max(last.1)))
}

/// A table-level formula from the part (`calculatedColumnFormula`,
/// `totalsRowFormula`) as Calcula holds it: Calcula's syntax, the reference
/// to the table's own columns unqualified, with its `=`.
fn calcula_table_formula(file: &str, table: &str) -> String {
    let text = crate::xlsx_formula_text::calcula_formula_text(file.trim());
    let short = unqualify_structured_refs(&text, table).unwrap_or(text);
    format!("={}", short)
}

/// One `xl/tables/tableN.xml` as a table of the sheet `sheet_id`. The name is
/// the `displayName`, the one formulas use ([LIVE] Excel 16 saved a table it
/// shows as `Tbl2_` with `name="Tbl2" displayName="Tbl2_"`).
pub(crate) fn parse_table_part(xml: &str, sheet_id: SheetId) -> Option<SavedTable> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut name: Option<String> = None;
    let mut range: Option<(u32, u32, u32, u32)> = None;
    let mut header_row = true;
    let mut total_row = false;
    let mut auto_filter = false;
    let mut style_name = String::new();
    let mut options = SavedTableStyleOptions {
        banded_rows: false,
        banded_columns: false,
        header_row: true,
        total_row: false,
        first_column: false,
        last_column: false,
        show_filter_button: false,
    };
    let mut columns: Vec<SavedTableColumn> = Vec::new();
    // The column whose element is open, and which formula element is.
    let mut open_column: Option<SavedTableColumn> = None;
    let mut in_formula: Option<&'static str> = None;
    let mut formula_text = String::new();

    let column_of = |attrs: &[(String, String)]| SavedTableColumn {
        id: EntityId::from_bytes(identity::generate_uuid_v7()),
        name: decode_ooxml_escapes(attribute(attrs, "name").unwrap_or_default()),
        totals_row_function: match attribute(attrs, "totalsRowFunction").unwrap_or("none") {
            "countNums" => "countNumbers".to_string(),
            f @ ("sum" | "min" | "max" | "average" | "count" | "stdDev" | "var" | "custom") => f.to_string(),
            _ => "none".to_string(),
        },
        totals_row_formula: None,
        calculated_formula: None,
        // Kept only while the totals row is hidden (cleared below when it
        // shows: the cell is the truth then). NEW-totals-label-persist.
        totals_row_label: attribute(attrs, "totalsRowLabel")
            .filter(|_| attribute(attrs, "totalsRowFunction").is_none())
            .map(|l| decode_ooxml_escapes(l))
            .filter(|l| !l.is_empty()),
    };

    loop {
        let event = match reader.read_event() {
            Ok(e) => e,
            Err(_) => return None,
        };
        match event {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"table" => {
                let attrs = attributes_of(&e);
                name = attribute(&attrs, "displayName").or_else(|| attribute(&attrs, "name")).map(str::to_string);
                range = attribute(&attrs, "ref").and_then(parse_ref);
                header_row = attribute(&attrs, "headerRowCount").map_or(true, |v| v != "0");
                total_row = attribute(&attrs, "totalsRowCount").is_some_and(|v| v != "0");
            }
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"autoFilter" => {
                auto_filter = true;
            }
            Event::Empty(e) if e.local_name().as_ref() == b"tableColumn" => {
                columns.push(column_of(&attributes_of(&e)));
            }
            Event::Start(e) if e.local_name().as_ref() == b"tableColumn" => {
                open_column = Some(column_of(&attributes_of(&e)));
            }
            Event::Start(e) if open_column.is_some() && e.local_name().as_ref() == b"calculatedColumnFormula" => {
                in_formula = Some("calculated");
                formula_text.clear();
            }
            Event::Start(e) if open_column.is_some() && e.local_name().as_ref() == b"totalsRowFormula" => {
                in_formula = Some("totals");
                formula_text.clear();
            }
            Event::Text(t) if in_formula.is_some() => {
                if let Ok(text) = t.unescape() {
                    formula_text.push_str(&text);
                }
            }
            Event::CData(t) if in_formula.is_some() => {
                formula_text.push_str(&String::from_utf8_lossy(&t));
            }
            Event::End(e) if e.local_name().as_ref() == b"calculatedColumnFormula" || e.local_name().as_ref() == b"totalsRowFormula" => {
                if let (Some(which), Some(column)) = (in_formula.take(), open_column.as_mut()) {
                    let table = name.clone().unwrap_or_default();
                    let formula = calcula_table_formula(&formula_text, &table);
                    match which {
                        "calculated" => column.calculated_formula = Some(formula),
                        _ => column.totals_row_formula = Some(formula),
                    }
                }
            }
            Event::End(e) if e.local_name().as_ref() == b"tableColumn" => {
                if let Some(column) = open_column.take() {
                    columns.push(column);
                }
            }
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"tableStyleInfo" => {
                let attrs = attributes_of(&e);
                style_name = attribute(&attrs, "name").unwrap_or_default().to_string();
                let flag = |key: &str| attribute(&attrs, key).is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
                options.first_column = flag("showFirstColumn");
                options.last_column = flag("showLastColumn");
                options.banded_rows = flag("showRowStripes");
                options.banded_columns = flag("showColumnStripes");
            }
            Event::Eof => break,
            _ => {}
        }
    }

    let name = name.filter(|n| !n.is_empty())?;
    let (start_row, start_col, end_row, end_col) = range?;
    if columns.len() != (end_col - start_col + 1) as usize {
        return None;
    }
    options.header_row = header_row;
    options.total_row = total_row;
    options.show_filter_button = auto_filter;
    if total_row {
        // The totals row SHOWS: its cell holds the label, as Calcula keeps it.
        for column in &mut columns {
            column.totals_row_label = None;
        }
    }
    Some(SavedTable {
        id: EntityId::from_bytes(identity::generate_uuid_v7()),
        name,
        sheet_id,
        start_row,
        start_col,
        end_row,
        end_col,
        columns,
        style_options: options,
        style_name,
    })
}

#[cfg(test)]
#[path = "xlsx_tables_tests.rs"]
mod tests;
