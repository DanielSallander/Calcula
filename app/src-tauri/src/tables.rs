//! FILENAME: app/src-tauri/src/tables.rs
//! PURPOSE: Backend storage and management for Excel-style tables (structured references).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

use crate::AppState;
use crate::autofilter::AutoFilter;
use crate::persistence::UserFilesState;

// ============================================================================
// TOTALS ROW FUNCTIONS
// ============================================================================

/// Function to use in a table's totals row
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TotalsRowFunction {
    /// No function (empty)
    None,
    /// Average of values
    Average,
    /// Count of non-empty cells
    Count,
    /// Count of numeric values
    CountNumbers,
    /// Maximum value
    Max,
    /// Minimum value
    Min,
    /// Sum of values
    Sum,
    /// Standard deviation
    StdDev,
    /// Variance
    Var,
    /// Custom formula
    Custom,
}

impl Default for TotalsRowFunction {
    fn default() -> Self {
        TotalsRowFunction::None
    }
}

// ============================================================================
// TABLE STYLE OPTIONS
// ============================================================================

/// Style options for table formatting
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStyleOptions {
    /// Show alternating row colors
    pub banded_rows: bool,
    /// Show alternating column colors
    pub banded_columns: bool,
    /// Show header row
    pub header_row: bool,
    /// Show total row
    pub total_row: bool,
    /// Highlight first column
    pub first_column: bool,
    /// Highlight last column
    pub last_column: bool,
    /// Show filter dropdown buttons in header
    pub show_filter_button: bool,
}

impl Default for TableStyleOptions {
    fn default() -> Self {
        Self {
            banded_rows: true,
            banded_columns: false,
            header_row: true,
            total_row: false,
            first_column: false,
            last_column: false,
            show_filter_button: true,
        }
    }
}

// ============================================================================
// TABLE COLUMN
// ============================================================================

/// A column in a table
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableColumn {
    /// Column ID (unique within table)
    pub id: identity::EntityId,
    /// Column name (header text)
    pub name: String,
    /// Function for totals row
    pub totals_row_function: TotalsRowFunction,
    /// Custom formula for totals row (if function is Custom)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub totals_row_formula: Option<String>,
    /// Calculated column formula (applied to all data rows)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calculated_formula: Option<String>,
    /// Excel's `totalsRowLabel`: the CONSTANT a column with no totals function
    /// showed in the totals row when the row was last hidden, put back when it
    /// is shown again (NEW-totals-constant-none). [LIVE, Excel 16, 2026-11-05,
    /// cfdv/probe2.ps1] a typed `7` and a typed `Label` come back after Total
    /// Row off and on, and the saved table part carries `totalsRowLabel="7"`.
    /// Captured when the row is hidden (the cell is the truth while it shows),
    /// and saved with the column in `.cala` (feature id
    /// `table_totals_row_label`) and `.xlsx` (`totalsRowLabel`), so a workbook
    /// saved with the row hidden keeps it (NEW-totals-label-persist).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totals_row_label: Option<String>,
}

impl TableColumn {
    pub fn new(id: identity::EntityId, name: String) -> Self {
        Self {
            id,
            name,
            totals_row_function: TotalsRowFunction::None,
            totals_row_formula: None,
            calculated_formula: None,
            totals_row_label: None,
        }
    }
}

// ============================================================================
// TABLE
// ============================================================================

/// A table definition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    /// Unique table ID
    pub id: identity::EntityId,
    /// Table name (must be unique across workbook)
    pub name: String,
    /// Sheet where the table is located
    pub sheet_index: usize,
    /// Start row (including header if present)
    pub start_row: u32,
    /// Start column
    pub start_col: u32,
    /// End row (including totals row if present)
    pub end_row: u32,
    /// End column
    pub end_col: u32,
    /// Table columns
    pub columns: Vec<TableColumn>,
    /// Style options
    pub style_options: TableStyleOptions,
    /// Style name (e.g., "TableStyleMedium2")
    pub style_name: String,
    /// Associated AutoFilter ID (if show_filter_button is true)
    #[serde(skip_serializing_if = "Option::is_none")]
    /// The [`crate::autofilter::AutoFilter`] this table owns, by its stable id.
    ///
    /// Was the sheet INDEX, which every filter-bearing table on a sheet shares
    /// — so it could never answer "is the sheet's filter mine?". Not persisted
    /// directly; reconstructed at load by matching the filter's geometry to a
    /// single table (see persistence.rs).
    #[serde(default)]
    pub auto_filter_id: Option<identity::EntityId>,
}

impl Table {
    /// Get the data start row (after header if present)
    pub fn data_start_row(&self) -> u32 {
        if self.style_options.header_row {
            self.start_row + 1
        } else {
            self.start_row
        }
    }

    /// Get the data end row (before totals if present)
    pub fn data_end_row(&self) -> u32 {
        if self.style_options.total_row {
            self.end_row - 1
        } else {
            self.end_row
        }
    }

    /// The last row of the table's AutoFilter: the data end, never the totals
    /// row. [LIVE, Excel 16, 2026-11-05, tablefix-probe/probe1.ps1] a table on
    /// B2:D6 with a totals row saves `<autoFilter ref="B2:D5"/>`, and filtering
    /// it hides data rows but never the totals row. A filter over the totals
    /// row judged the totals cells against the criterion -- the "Total" label
    /// failing `= a` hid the totals row (NEW-table-filter-seed-totals).
    pub fn filter_end_row(&self) -> u32 {
        self.data_end_row()
    }

    /// Get column count
    pub fn column_count(&self) -> u32 {
        (self.end_col - self.start_col + 1) as u32
    }

    /// Get row count (data rows only)
    pub fn row_count(&self) -> u32 {
        let data_start = self.data_start_row();
        let data_end = self.data_end_row();
        if data_end >= data_start {
            data_end - data_start + 1
        } else {
            0
        }
    }

    /// Check if a cell is within the table
    pub fn contains(&self, row: u32, col: u32) -> bool {
        row >= self.start_row
            && row <= self.end_row
            && col >= self.start_col
            && col <= self.end_col
    }

    /// Check if a cell is in the header row
    pub fn is_header(&self, row: u32) -> bool {
        self.style_options.header_row && row == self.start_row
    }

    /// Check if a cell is in the totals row
    pub fn is_totals(&self, row: u32) -> bool {
        self.style_options.total_row && row == self.end_row
    }

    /// Check if a cell is in the data area
    pub fn is_data(&self, row: u32) -> bool {
        row >= self.data_start_row() && row <= self.data_end_row()
    }

    /// Get column by name (case-insensitive)
    pub fn get_column_by_name(&self, name: &str) -> Option<&TableColumn> {
        let lower = name.to_lowercase();
        self.columns.iter().find(|c| c.name.to_lowercase() == lower)
    }

    /// Get column index by name (0-based within table)
    pub fn get_column_index(&self, name: &str) -> Option<usize> {
        let lower = name.to_lowercase();
        self.columns
            .iter()
            .position(|c| c.name.to_lowercase() == lower)
    }
}

// ============================================================================
// STORAGE
// ============================================================================

/// Storage: sheet_index -> table_id -> Table
pub type TableStorage = HashMap<usize, HashMap<identity::EntityId, Table>>;

/// Name registry: [`table_name_key`] -> (sheet_index, table_id)
pub type TableNameRegistry = HashMap<String, (usize, identity::EntityId)>;

/// The key a TABLE name is registered and looked up by: Excel's DEFINED-NAME
/// rule, never Rust's `to_uppercase`. Excel [LIVE, Excel 16, 2026-10-31,
/// relocref/probe-tables.ps1: `ListObjects(..).Name` set to each spelling]
/// treats `Straße` / `STRASSE`, `Ärende` / `ärende`, `qæ` / `qae`, `qþ` / `qth`
/// and `q<KELVIN SIGN>` / `qk` as ONE table name -- the second is refused, and
/// `=SUM(STRASSE[H])` reads the table named `Straße` -- while `qµ` / `qμ`,
/// `qı` / `qI` and `qſ` / `qs` are two. That is `identity::defined_name_key`
/// exactly, and a defined name of either spelling is refused beside the table
/// (one namespace). `to_uppercase` also missed the lexer's own fold: a formula
/// `=SUM(Straße[H])` reaches the lookup as `STRAẞE`, which no `to_uppercase`
/// key ever equalled.
pub fn table_name_key(name: &str) -> String {
    identity::defined_name_key(name)
}

// ============================================================================
// RESULT TYPES
// ============================================================================

/// Lightweight cell update info returned by set_calculated_column
/// so the frontend can push values into the canvas without a full viewport re-fetch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputedCell {
    pub row: u32,
    pub col: u32,
    pub display: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
}

/// Result of a table operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<Table>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Computed cell values from set_calculated_column, for direct canvas update.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub computed_cells: Option<Vec<ComputedCell>>,
}

impl TableResult {
    pub fn ok(table: Table) -> Self {
        Self {
            success: true,
            table: Some(table),
            error: None,
            computed_cells: None,
        }
    }

    pub fn ok_empty() -> Self {
        Self {
            success: true,
            table: None,
            error: None,
            computed_cells: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            success: false,
            table: None,
            error: Some(message.into()),
            computed_cells: None,
        }
    }
}

/// Resolved structured reference
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedStructuredRef {
    pub sheet_index: usize,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// Result of resolving a structured reference
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredRefResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved: Option<ResolvedStructuredRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl StructuredRefResult {
    pub fn ok(resolved: ResolvedStructuredRef) -> Self {
        Self {
            success: true,
            resolved: Some(resolved),
            error: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            success: false,
            resolved: None,
            error: Some(message.into()),
        }
    }
}

// ============================================================================
// PARAMS
// ============================================================================

/// Parameters for creating a table
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableParams {
    pub name: String,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    #[serde(default)]
    pub has_headers: bool,
    #[serde(default)]
    pub style_options: Option<TableStyleOptions>,
    #[serde(default)]
    pub style_name: Option<String>,
}

/// Parameters for resizing a table
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeTableParams {
    pub table_id: identity::EntityId,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// Parameters for updating table style
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTableStyleParams {
    pub table_id: identity::EntityId,
    #[serde(default)]
    pub style_options: Option<TableStyleOptions>,
    #[serde(default)]
    pub style_name: Option<String>,
}

/// Parameters for setting totals row function
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTotalsRowFunctionParams {
    pub table_id: identity::EntityId,
    pub column_name: String,
    pub function: TotalsRowFunction,
    #[serde(default)]
    pub custom_formula: Option<String>,
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Generate a unique table name: the first `TableN` that neither another
/// table nor a DEFINED NAME holds (`taken_by_defined_name`), because the two
/// share one namespace. [LIVE, Excel 16, 2026-11-04,
/// calpdec-probe/genname.ps1: with a defined name `Table1` in the workbook, a
/// new table with no name given is `Table2`.]
fn generate_table_name(existing_names: &TableNameRegistry, taken_by_defined_name: impl Fn(&str) -> bool) -> String {
    let mut i = 1;
    loop {
        let name = format!("Table{}", i);
        if !existing_names.contains_key(&table_name_key(&name)) && !taken_by_defined_name(&name) {
            return name;
        }
        i += 1;
    }
}

/// Ensure all header names are unique. Appends incrementing digit for duplicates.
/// E.g., ["Revenue", "Cost", "Revenue"] -> ["Revenue", "Cost", "Revenue2"]
fn ensure_unique_headers(names: &[String]) -> Vec<String> {
    let mut result: Vec<String> = Vec::with_capacity(names.len());
    for name in names {
        let unique = ensure_unique_header(name, &result);
        result.push(unique);
    }
    result
}

/// Returns a unique header name by appending a digit if the name already exists.
/// Empty names are replaced with "Column{N}" where N is the count + 1.
fn ensure_unique_header(name: &str, existing: &[String]) -> String {
    let base = if name.trim().is_empty() {
        format!("Column{}", existing.len() + 1)
    } else {
        name.to_string()
    };

    let lower = base.to_lowercase();
    let has_conflict = existing.iter().any(|n| n.to_lowercase() == lower);
    if !has_conflict {
        return base;
    }

    // Append incrementing digit
    let mut counter = 2;
    loop {
        let candidate = format!("{}{}", base, counter);
        let cand_lower = candidate.to_lowercase();
        if !existing.iter().any(|n| n.to_lowercase() == cand_lower) {
            return candidate;
        }
        counter += 1;
    }
}

/// Build a SUBTOTAL formula for a totals row cell.
/// Uses the 100-series function numbers which ignore hidden/filtered rows.
/// Returns None for TotalsRowFunction::None.
///
/// The numbers are Excel's own [LIVE, Excel 16, 2026-11-05,
/// tablefix-probe/probe1.ps1, `ListColumn.TotalsCalculation` 1..8 read back
/// from the totals cell]: Sum 109, Average 101, Count 103 (COUNTA -- the
/// non-empty cells), Count Numbers 102 (COUNT), Min 105, Max 104, StdDev 107,
/// Var 110. Count and Count Numbers were swapped here (NEW-table-totals-count-swap):
/// "Count" over a text column counted no cells.
pub(crate) fn build_subtotal_formula(
    function: &TotalsRowFunction,
    table_name: &str,
    column_name: &str,
) -> Option<String> {
    let code = match function {
        TotalsRowFunction::None => return None,
        TotalsRowFunction::Average => 101,
        TotalsRowFunction::Count => 103,
        TotalsRowFunction::CountNumbers => 102,
        TotalsRowFunction::Max => 104,
        TotalsRowFunction::Min => 105,
        TotalsRowFunction::Sum => 109,
        TotalsRowFunction::StdDev => 107,
        TotalsRowFunction::Var => 110,
        TotalsRowFunction::Custom => return None, // Custom uses custom_formula directly
    };

    // The column is spelled through the structured-reference RENDERER's own
    // escaping (NEW-subtotal-escaping): a raw `[{}]` turned a column named
    // `a[1]`, `#x` or `it's` into a formula that re-parsed as something else
    // or not at all -- `[a[1]]` is a nested specifier, `[#x]` a special item.
    // [LIVE, Excel 16, 2026-11-05, tablec/probe1.ps1] Excel escapes them with
    // `'` the same way: `[a'[1']]`, `['#x]`, `[it''s]`.
    let specifier = engine::ast_render::render_table_specifier(&parser::ast::TableSpecifier::Column(
        column_name.to_string(),
    ));
    Some(format!("=SUBTOTAL({},{}{})", code, table_name, specifier))
}

/// What a cell TYPED into a table's totals row makes that column's totals
/// function (NEW-totals-constant-none). [LIVE, Excel 16, 2026-11-05,
/// cfdv/probe1.ps1 T1-T10 and probe2.ps1 P5] after a write into the totals
/// cell, `ListColumn.TotalsCalculation` reads:
///   * a constant -- number or text -- or a cleared cell: None (0), and the
///     constant is the column's label (`totalsRowLabel`);
///   * `=SUBTOTAL(n,[Col])` or `=SUBTOTAL(n,Table[Col])` naming THIS column
///     with one of the eight codes the totals menu writes: that function
///     (`SUBTOTAL(101,[H2])` -> Average, 2);
///   * any other formula -- `SUBTOTAL(9,[H2])`, `SUM([H2])`, another
///     column's subtotal, `=7`, `=1+1`: Custom (9), the formula kept as its
///     `totalsRowFormula`.
/// Calcula kept the stored function, so the next Total Row toggle (or the
/// function menu) wrote the subtotal back over the user's value.
pub(crate) fn typed_totals_function(
    table_name: &str,
    column_name: &str,
    cell: Option<&engine::Cell>,
) -> (TotalsRowFunction, Option<String>) {
    let Some(cell) = cell else { return (TotalsRowFunction::None, None) };
    let Some(ast) = cell.get_ast() else { return (TotalsRowFunction::None, None) };
    if let engine::Expression::FunctionCall { func: engine::BuiltinFunction::Subtotal, args, .. } = ast {
        if let [engine::Expression::Literal(engine::Value::Number(code)), engine::Expression::TableRef {
            table_name: named,
            specifier: engine::TableSpecifier::Column(column),
            ..
        }] = args.as_slice()
        {
            let names_this_table = named.is_empty() || table_name_key(named) == table_name_key(table_name);
            if names_this_table && table_name_key(column) == table_name_key(column_name) {
                let function = match *code as i64 {
                    _ if code.fract() != 0.0 => None,
                    101 => Some(TotalsRowFunction::Average),
                    102 => Some(TotalsRowFunction::CountNumbers),
                    103 => Some(TotalsRowFunction::Count),
                    104 => Some(TotalsRowFunction::Max),
                    105 => Some(TotalsRowFunction::Min),
                    107 => Some(TotalsRowFunction::StdDev),
                    109 => Some(TotalsRowFunction::Sum),
                    110 => Some(TotalsRowFunction::Var),
                    _ => None,
                };
                if let Some(function) = function {
                    return (function, None);
                }
            }
        }
    }
    // Stored with its `=`, as `build_subtotal_formula` spells a total and
    // `write_table_formula_cell` reads one back (`formula_string` has none).
    (TotalsRowFunction::Custom, cell.formula_string().map(|f| format!("={}", f)))
}

/// The CONSTANT a totals cell shows, as a column's `totals_row_label`, or
/// `None` for an empty cell or a formula. A number is spelled so that
/// [`totals_label_cell`] gives the same number back.
fn totals_label_of(cell: Option<&engine::Cell>) -> Option<String> {
    let cell = cell?;
    if cell.get_ast().is_some() {
        return None;
    }
    match &cell.value {
        engine::CellValue::Number(n) => Some(n.to_string()),
        engine::CellValue::Text(s) if !s.is_empty() => Some(s.clone()),
        engine::CellValue::Boolean(b) => Some(if *b { "TRUE" } else { "FALSE" }.to_string()),
        _ => None,
    }
}

/// Whether no column has a totals function and none remembers a non-empty
/// label: the totals row shows nothing (an emptied one, or one never shown).
fn table_totals_all_empty(columns: &[TableColumn]) -> bool {
    columns
        .iter()
        .all(|c| c.totals_row_function == TotalsRowFunction::None && c.totals_row_label.as_deref().map_or(true, str::is_empty))
}

/// The cell a remembered totals label is written back as: a number when the
/// label is exactly a number's own spelling (what [`totals_label_of`] wrote),
/// text otherwise.
fn totals_label_cell(label: &str) -> engine::Cell {
    match label.parse::<f64>() {
        Ok(n) if n.to_string() == label => engine::Cell::new_number(n),
        _ => engine::Cell::new_text(label.to_string()),
    }
}

/// Whether Excel's default totals function for the column `col` over the data
/// rows `first..=last` is Sum rather than Count: every non-empty data cell is
/// a NUMBER whose number format is no date or time, and there is at least
/// one. [LIVE, Excel 16, 2026-11-05, tablefix-probe/probe5.ps1] numbers with
/// blanks among them (either end) -> `SUBTOTAL(109,..)`; a number column with
/// one text cell, text, booleans, `yyyy-mm-dd` dates, text formulas or an
/// empty column -> `SUBTOTAL(103,..)`; numeric FORMULAS -> 109 (the value
/// decides, not the cell's kind).
pub(crate) fn totals_default_is_sum(
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    first: u32,
    last: u32,
    col: u32,
) -> bool {
    let mut numbers = 0usize;
    for row in first..=last {
        let Some(cell) = grid.get_cell(row, col) else { continue };
        match &cell.value {
            engine::CellValue::Empty => {}
            engine::CellValue::Number(_) => {
                let dated = matches!(
                    styles.get(cell.style_index).number_format,
                    engine::NumberFormat::Date { .. } | engine::NumberFormat::Time { .. }
                );
                if dated {
                    return false;
                }
                numbers += 1;
            }
            _ => return false,
        }
    }
    numbers > 0
}

/// Validate table name
/// Re-link one sheet's tables to that sheet's AutoFilter, by identity.
///
/// A sheet holds at most one AutoFilter, and exactly one table may own it.
/// `Table.auto_filter_id` is NOT persisted and is invalidated by ordinary
/// operations — Data ▸ Filter off/on removes the filter and mints a fresh one,
/// which would otherwise leave every table pointing at a filter that no longer
/// exists. So ownership is treated as derived state and recomputed wherever the
/// sheet's filter is created, replaced or removed, rather than maintained
/// incrementally at each site.
///
/// `af = None` clears every link on the sheet. Otherwise the owner is the
/// filter-button table whose rows contain the filter's header row and whose
/// columns overlap it, tie-broken by lowest (start_row, start_col).
pub(crate) fn relink_autofilter_owner(
    sheet_tables: &mut HashMap<identity::EntityId, Table>,
    af: Option<&crate::autofilter::AutoFilter>,
) {
    for table in sheet_tables.values_mut() {
        table.auto_filter_id = None;
    }
    let Some(af) = af else {
        return;
    };
    let owner = sheet_tables
        .values()
        .filter(|t| t.style_options.show_filter_button)
        .filter(|t| {
            af.start_row >= t.start_row
                && af.start_row <= t.end_row
                && af.start_col <= t.end_col
                && af.end_col >= t.start_col
        })
        .min_by_key(|t| (t.start_row, t.start_col))
        .map(|t| t.id);
    if let Some(owner_id) = owner {
        if let Some(t) = sheet_tables.get_mut(&owner_id) {
            t.auto_filter_id = Some(af.id);
        }
    }
}

/// Whether a defined name (named range) already claims this identifier.
///
/// Tables and defined names resolve out of two unrelated registries into ONE
/// formula namespace, with names resolved first at every call site. A table
/// sharing a name with a defined name is therefore permanently unreachable by
/// name — so refuse the collision instead of creating the ambiguity. "Shares a
/// name" is Excel's defined-name rule (`identity::defined_name_key`, the key
/// the name map is built from): a defined name `Pæresalg` refuses a table
/// `pæresalg` or `PAERESALG`.
///
/// [LIVE, Excel 16, 2026-10-31, namekey/probe2.ps1] Excel's own gate is
/// one-way over COM: `Names.Add` beside a table of the same name is refused
/// ("A table with that name already exists"), but `ListObject.Name` set to an
/// existing defined name's spelling is accepted and the name then wins in
/// formulas -- the unreachable table this gate exists to prevent. Calcula
/// refuses both directions.
///
/// OWNER DECISION (2026-11-04, BUG-0616 note (d)): a DELIBERATE difference
/// from Excel. Calcula keeps refusing BOTH directions -- a table created or
/// renamed onto a defined name (this gate: `create_table_core`,
/// `rename_table_core`, the JSON view's `table` arm through the latter) and a
/// defined name created or renamed onto a table (`create_named_range_impl`,
/// `rename_named_range_impl`) -- because Excel's one-way gate leaves a table
/// that no formula can reach by name. [LIVE, 2026-11-04,
/// calpdec-probe/genname.ps1: Excel's COM `Name.Name` also accepts a defined
/// name RENAMED onto a table's name; Calcula refuses that too.] A generated
/// name (`Table1`, `Table2`, ...) skips a defined name, as Excel's does.
/// Pinned in both directions by
/// `defined_name_key_tests::tables_and_defined_names_refuse_each_other_in_both_directions_through_every_door`;
/// listed with the other deliberate differences from Excel in
/// docs/design/open-items.md ("Deliberate differences from Excel (still)").
pub(crate) fn name_collides_with_defined_name(state: &AppState, name: &str) -> bool {
    state
        .named_ranges
        .read()
        .map(|names| names.contains_key(&identity::defined_name_key(name)))
        .unwrap_or(false)
}

/// The name a COPIED table gets: its own name followed by a number, the
/// first `N` from (tables in the workbook + 2 + `ordinal`) up that no table
/// and no defined name holds. [LIVE, Excel 16, 2026-11-05, tablec/probe1.ps1 +
/// probe3.ps1, fresh workbooks] one table `Table1`, copy the sheet -> `Table13`,
/// again -> `Table14`; `Sales` -> `Sales3`, `Sales4`; `Q4x9` -> `Q4x93`; two
/// tables `Table1`, `Table2` -> `Table14`, `Table25`, again -> `Table16`,
/// `Table27`. Excel's number is a hidden per-workbook counter; the table count
/// plus two reproduces every measured case, and the uniqueness walk is the
/// rule a counter guarantees.
fn copied_table_name(
    base: &str,
    tables_in_workbook: usize,
    ordinal: usize,
    taken: &dyn Fn(&str) -> bool,
) -> String {
    let mut n = tables_in_workbook + 2 + ordinal;
    loop {
        let candidate = format!("{}{}", base, n);
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// COPY SHEET COPIES ITS TABLES (NEW-copy-sheet-tables). [LIVE, Excel 16,
/// tablec/probe1.ps1 + probe3.ps1] Excel's `Worksheet.Copy` gives the copy a
/// table for every table on the source, under a new name
/// ([`copied_table_name`]), with the same rectangle, columns, style, totals
/// and filter buttons, and rewrites the copy's references to a copied table
/// to the new name (`=SUM(Table1[H1])` -> `=SUM(Table13[H1])`); a bare
/// `[@H1]` stays bare, a reference to a table on ANOTHER sheet stays as it
/// was, and the source's formulas are untouched. `copy_sheet` used to copy no
/// table at all: the copy's cells kept reading the SOURCE's tables.
///
/// `dest_grids` are the copy's grid in the per-sheet vector and, when the
/// copy is the active sheet, the grid mirror -- the caller holds both (grid,
/// grids, then `tables`: the canonical order); `defined_name_keys` is the
/// defined names' keys, read by the caller before it took any lock (a table
/// and a name share one namespace). The copy's AutoFilter, when a
/// copied table owned the source's, is copied with it under a fresh id.
pub(crate) fn copy_tables_to_copied_sheet(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    source: usize,
    dest: usize,
    dest_grids: &mut [&mut engine::Grid],
    defined_name_keys: &std::collections::HashSet<String>,
) {
    let mut tables = state.tables.write(effect).unwrap();
    let mut table_names = state.table_names.write(effect).unwrap();
    let mut originals: Vec<Table> = tables.get(&source).map(|st| st.values().cloned().collect()).unwrap_or_default();
    if originals.is_empty() {
        return;
    }
    originals.sort_by_key(|t| (t.start_row, t.start_col));
    let in_workbook: usize = tables.values().map(|st| st.len()).sum();
    let source_filter: Option<crate::autofilter::AutoFilter> =
        state.auto_filters.read().unwrap().get(&source).cloned();

    // (old key, new name) for every copied table, decided first so a copied
    // table's own formulas can name another copied table.
    let mut renames: Vec<(String, String)> = Vec::new();
    let mut copies: Vec<Table> = Vec::new();
    for (ordinal, original) in originals.iter().enumerate() {
        let name = copied_table_name(&original.name, in_workbook, ordinal, &|candidate| {
            table_names.contains_key(&table_name_key(candidate))
                || renames.iter().any(|(_, n)| table_name_key(n) == table_name_key(candidate))
                || defined_name_keys.contains(&identity::defined_name_key(candidate))
        });
        renames.push((table_name_key(&original.name), name.clone()));
        let mut copy = original.clone();
        copy.id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        copy.name = name;
        copy.sheet_index = dest;
        copy.auto_filter_id = None;
        for column in copy.columns.iter_mut() {
            column.id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        }
        copies.push(copy);
    }

    for (copy, original) in copies.iter_mut().zip(&originals) {
        // The copy's own stored formulas name the copied tables.
        for column in copy.columns.iter_mut() {
            for slot in [&mut column.calculated_formula, &mut column.totals_row_formula] {
                for (old_key, new_name) in &renames {
                    if let Some(f) = slot.as_deref().and_then(|f| rename_table_refs_in_formula_text(f, old_key, new_name)) {
                        *slot = Some(f);
                    }
                }
            }
        }
        // The copy owns a copy of the filter its original owned.
        if let Some(af) = source_filter.as_ref().filter(|af| original.auto_filter_id == Some(af.id)) {
            let mut filter = af.clone();
            filter.id = crate::autofilter::AutoFilter::new(af.start_row, af.start_col, af.end_row, af.end_col).id;
            copy.auto_filter_id = Some(filter.id);
            state.auto_filters.write(effect).unwrap().insert(dest, filter);
        }
    }

    // The copy's cells name the copied tables (both grids the caller holds).
    for grid in dest_grids.iter_mut() {
        let candidates: Vec<(u32, u32)> = grid
            .cells
            .iter()
            .filter(|(_, cell)| cell.get_ast().is_some_and(crate::ast_has_table_refs))
            .map(|(&coord, _)| coord)
            .collect();
        for (row, col) in candidates {
            let Some(cell) = grid.get_cell(row, col) else { continue };
            let Some(ast) = cell.get_ast() else { continue };
            let mut current = ast.clone();
            let mut changed = false;
            for (old_key, new_name) in &renames {
                let (renamed, did) = crate::rename_table_refs_in_ast(&current, old_key, new_name);
                if did {
                    current = renamed;
                    changed = true;
                }
            }
            if changed {
                let mut updated = cell.clone();
                updated.ast = Some(Box::new(current));
                grid.set_cell(row, col, updated);
            }
        }
    }

    for copy in copies {
        table_names.insert(table_name_key(&copy.name), (dest, copy.id));
        tables.entry(dest).or_default().insert(copy.id, copy);
    }
}

/// Excel's own refusal of a table over a multi-cell array -- a data table
/// (`TABLE(..)`) is one.
pub(crate) const TABLE_OVER_ARRAY_MESSAGE: &str = "Multi-cell array formulas aren't allowed in tables.";

/// Whether the rectangle touches a data table on `grid` (the sheet's). [LIVE,
/// Excel 16, review rev-xlsx] `ListObjects.Add` over a data table is refused
/// "Multi-cell array formulas aren't allowed in tables.", and a workbook
/// holding a data table inside a table is a file Excel refuses to open. So
/// creating, resizing or auto-expanding a table onto one is refused (the
/// opposite door, a data table made inside a table, is `create_data_table`'s).
pub(crate) fn overlaps_data_table(grid: &engine::Grid, start_row: u32, start_col: u32, end_row: u32, end_col: u32) -> bool {
    engine::data_table::has_data_tables(grid)
        && engine::data_table::data_tables_in(grid)
            .iter()
            .any(|t| t.overlaps(start_row, start_col, end_row, end_col))
}

/// Excel's own refusal of a table feature on a protected sheet.
pub(crate) const TABLE_PROTECTED_MESSAGE: &str =
    "Table features aren't available because the sheet is protected.";

/// THE ONE PROTECTION GATE OF EVERY TABLE MUTATION: refused while the sheet is
/// protected, with Excel's message. [LIVE, Excel 16, 2026-11-05,
/// tablefix-probe/probe4.ps1: on a sheet protected with the defaults AND with
/// every Allow option on, `ListObjects.Add`, `Resize`, `ShowTotals`, `Name`,
/// `ListColumns.Add`, `ListColumn.Delete`, `ListRows.Add`, `TotalsCalculation`
/// and `Delete` are each refused "Table features aren't available because the
/// sheet is protected."; a `ListColumn.Name` write is silently ignored.] An
/// edit of an UNLOCKED header cell is not a table feature: it is a cell edit,
/// and Excel renames the column with it (`enforce_table_header` follows).
/// The question "is the sheet protected" stays
/// `protection::require_sheet_unprotected`'s.
pub(crate) fn require_table_sheet_unprotected(state: &AppState, sheet_index: usize) -> Result<(), String> {
    crate::protection::require_sheet_unprotected(state, sheet_index, "the table")
        .map_err(|_| TABLE_PROTECTED_MESSAGE.to_string())
}

/// A table name is valid exactly when Excel's table rule takes it
/// (`identity::is_valid_table_name`): the DEFINED NAME's rule -- the two share
/// one namespace in Excel (rev-xlsx-4) -- less its refusal of a two-character
/// name that begins with a backslash, which a table may have [LIVE, Excel 16,
/// 2026-11-06, lane names q4.ps1: `ListObject.Name = "\a"` stands]. This used
/// to be a looser copy that let `R`, `C` and cell-shaped names (`Q1`) through,
/// and [LIVE] Excel 16 refused the exported file whose table part was named
/// so. Delegated rather than copied, so the rules cannot drift.
pub(crate) fn is_valid_table_name(name: &str) -> bool {
    identity::is_valid_table_name(name)
}

// ============================================================================
// A TABLE CHANGE IS A VALUE CHANGE  (§2aj — Excel parity)
// ============================================================================

/// Recalculate everything that reads the tables in `changed`.
///
/// A formula now STORES its structured references and resolves them while
/// calculating (see `table_deps`), which is what makes `Sales[Amount]` a live
/// reference rather than a one-shot typing macro — and which makes creating,
/// growing, shrinking, resizing, renaming, re-columning or deleting a table
/// **a value change for every formula that reads it**. A table is not a cell,
/// so no cell seed can describe that; `table_dependents` is the edge that can.
///
/// THREE STEPS, and the first one is the half the name case does not need.
///
/// 1. **The cell-level edges are rebuilt first.** Repointing a defined name
///    changes which cells a formula reads, and so does moving a table's
///    boundary — `=SUM(Sales[Amount])` covered `A2:A4` a moment ago and covers
///    `A2:A5` now. `rebuild_all_dependencies` re-extracts every active-sheet
///    formula's references THROUGH `eval_ast`, so the new row becomes a
///    precedent. Without it the total would pick the new row up once and then
///    never notice an edit to it, which is a worse bug than the one being
///    fixed: silently right, then silently wrong.
/// 2. **The OFF-SHEET readers** are found by asking each grid whether any of
///    its formulas mentions a changed table, and only those sheets go through
///    `recalc_after_off_sheet_write`. The per-sheet dependency maps are
///    active-sheet-only, so there is no seed vocabulary for them.
/// 3. **The ACTIVE sheet's readers** seed `recalc_after_active_sheet_bulk_rewrite`,
///    which orders them topologically among themselves and continues into their
///    own dependents and across sheet boundaries.
///
/// [`crate::table_deps::BARE_TABLE_KEY`] is always in the seed set: a bare
/// `[@Amount]` names no table, so it is registered under that bucket and any
/// table change may be its table's.
///
/// CALLERS MUST HOLD NO `AppState` LOCKS: all three steps take their own. This
/// is the second lock phase, exactly as in `recalc_after_name_change`.
pub(crate) fn recalc_after_table_change(
    state: &AppState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    changed: &[String],
    extra_seeds: &[(u32, u32)],
) {
    if changed.is_empty() && extra_seeds.is_empty() {
        return;
    }
    // MANUAL CALCULATION: the user asked for stale values until F9, and a table
    // change is a value change like any other. Gated HERE for the reason
    // `recalc_after_name_change` gives — only one of the two helpers honours the
    // mode, and half a recalculation is worse than none.
    //
    // The EDGE REBUILD still runs: an edge is not a value, and leaving the
    // dependency maps describing a table extent the document no longer has
    // would make the eventual F9 wrong as well.
    let automatic = state
        .calculation_mode
        .lock()
        .map(|m| *m == "automatic")
        .unwrap_or(true);

    let mut changed_keys: std::collections::HashSet<String> =
        changed.iter().map(|n| table_name_key(n)).collect();
    if !changed.is_empty() {
        changed_keys.insert(crate::table_deps::BARE_TABLE_KEY.to_string());
    }

    // NAMES THAT MEDIATE. A formula can reach a table through a DEFINED NAME —
    // `MyRange` = `=Table1[Amount]`, then `=SUM(MyRange)` — and that cell's own
    // AST says only `MyRange`, so it is in no table bucket and
    // `cell_reads_any_table` answers false for it. Both halves below would miss
    // it. The name table is small and its `refers_to` strings are short, so the
    // honest answer is cheap: parse each definition and ask whether IT reads a
    // changed table.
    let mediating_names: crate::name_resolution::NameSet = {
        let mut out = crate::name_resolution::NameSet::default();
        if let Ok(named_ranges) = state.named_ranges.read() {
            for (key, nr) in named_ranges.iter() {
                let text = nr.refers_to.trim_start_matches('=');
                let Ok(ast) = parser::parse(text) else { continue };
                let mut reads = crate::table_deps::TableSet::default();
                crate::table_deps::collect_table_names(&ast, &mut reads);
                if reads.iter().any(|t| changed_keys.contains(t)) {
                    // The NAME key the edges are filed by (a sheet's own
                    // name is held under `"{sheet}!{key}"`, BUG-0744).
                    out.insert(crate::named_ranges::name_part_of_registry_key(key).to_string());
                }
            }
        }
        // NOT a mediating key: a bare table name typed BEFORE its table
        // existed. Excel leaves that cell `#NAME?` when the table is made --
        // after Calculate and CalculateFull too [LIVE, Excel 16, 2026-11-06,
        // lane names q6.ps1 / q7.ps1: `=ROWS(Tbl)` in J1, then
        // `ListObjects.Add` named `Tbl` -> J1 `#NAME?`, on another sheet too]
        // -- so the table's creation is no value change for it (BUG-0749).
        out
    };

    // THE READERS, on the active sheet: whatever the command wrote itself (a
    // totals row's SUBTOTAL, a generated header), every formula holding a
    // structured reference to a changed table, and every formula reading one of
    // those through a name.
    let seeds: Vec<(u32, u32)> = {
        let table_dependents = state.table_dependents.lock().unwrap();
        let name_dependents = state.name_dependents.lock().unwrap();
        let mut seen: crate::CoordSet = crate::CoordSet::default();
        let mut out: Vec<(u32, u32)> = Vec::new();
        let push = |coord: (u32, u32), seen: &mut crate::CoordSet, out: &mut Vec<(u32, u32)>| {
            if seen.insert(coord) {
                out.push(coord);
            }
        };
        for &coord in extra_seeds {
            push(coord, &mut seen, &mut out);
        }
        for key in &changed_keys {
            if let Some(cells) = table_dependents.get(key) {
                for &coord in cells {
                    push(coord, &mut seen, &mut out);
                }
            }
        }
        for key in &mediating_names {
            if let Some(cells) = name_dependents.get(key) {
                for &coord in cells {
                    push(coord, &mut seen, &mut out);
                }
            }
        }
        // Deterministic: the maps are hash sets and seed ORDER reaches values
        // through the topological pass.
        out.sort_unstable();
        out
    };

    // THE EDGE REFRESH, and it is the half the defined-name case does not need.
    //
    // Repointing a name changes which cells a formula reads, and so does moving
    // a table's boundary: `=SUM(Sales[Amount])` covered `A2:A4` a moment ago and
    // covers `A2:A5` now. The reader's CELL-level edges are stale the instant
    // the extent moves, so re-deriving them is not optional — without it the
    // total would follow the resize once and then never notice an edit to the
    // row it gained, which is silently-right-then-silently-wrong.
    //
    // TARGETED, not a whole-sheet `rebuild_all_dependencies`. The readers ARE
    // the population whose edges can have moved, and this runs on a gesture as
    // ordinary as typing one row under a table (`check_table_auto_expand`); a
    // full rebuild there would re-extract every formula on the sheet on every
    // typed row. It runs even in MANUAL calculation mode, because an edge is not
    // a value: leaving the maps describing an extent the document no longer has
    // would make the eventual F9 wrong too.
    crate::table_deps::refresh_reader_edges(state, &seeds);

    if !automatic {
        return;
    }

    // OFF-SHEET half first, mirroring `recalc_after_name_change`: the
    // active-sheet cascade below then reads values the other sheets have
    // already settled on.
    let active_sheet = *state.active_sheet.read().unwrap();
    let off_sheet: Vec<usize> = {
        let grids = state.grids.read().unwrap();
        grids
            .iter()
            .enumerate()
            .filter(|(idx, grid)| {
                *idx != active_sheet
                    && grid.cells.values().any(|cell| {
                        crate::table_deps::cell_reads_any_table(cell, &changed_keys)
                            || crate::name_resolution::cell_reads_any_name(cell, &mediating_names)
                    })
            })
            .map(|(idx, _)| idx)
            .collect()
    };
    if !off_sheet.is_empty() {
        crate::commands::data::recalc_after_off_sheet_write(
            state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &off_sheet,
        );
    }

    // ACTIVE-sheet half. ONE cascade over the union of the seed populations, not
    // two in sequence: they feed each other — a formula may read the totals cell
    // the same command just wrote — and two passes would order that by luck.
    if seeds.is_empty() {
        return;
    }
    let mut updated_cells: Vec<crate::api_types::CellData> = Vec::new();
    crate::commands::data::recalc_after_active_sheet_bulk_rewrite(
        state,
        user_files_state,
        pane_control_state,
        ribbon_filter_state,
        &seeds,
        &mut updated_cells,
    );
    // The cells are not returned: every table command returns a `TableResult`,
    // and the Table extension repaints the grid from the backend afterwards —
    // the same reason `recalc_after_name_change` discards its own.
}

// ============================================================================
// COMMANDS
// ============================================================================

/// Create a new table
#[tauri::command]
pub fn create_table(
    file_state: State<'_, crate::persistence::FileState>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: CreateTableParams,
) -> TableResult {
    create_table_core(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        params,
    )
}

/// The body of [`create_table`] over borrowed state, so the gates are
/// unit-testable without a Tauri `State`. Gates, in order, before any effect:
/// the active sheet is not a canvas; then -- under the held `tables` and
/// `table_names` guards (`lock_pending`) -- a valid name, no other table of
/// that name, no DEFINED NAME of that name
/// ([`name_collides_with_defined_name`]) and no overlap with another table.
/// Only then is the document dirtied, in the same critical section, so a
/// refused create leaves the document clean (it used to dirty first).
pub(crate) fn create_table_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    params: CreateTableParams,
) -> TableResult {
    let active_sheet = *state.active_sheet.read().unwrap();
    // A table is a block of CELLS; a canvas sheet shows none. Refused before
    // the effect so the refusal leaves the document clean.
    if let Err(e) = crate::sheets::ensure_not_canvas_in_state(state, active_sheet, "create a table") {
        return TableResult::err(e);
    }
    // Nor on a protected sheet (rev-backend-1): [LIVE] Excel 16 refuses
    // `ListObjects.Add` there even with every Allow option on. Without this
    // gate a table appeared on a protected sheet through Insert Table, the
    // AI's and MCP's `create_table` and a script's `api.createTable`, all of
    // which reach this function -- and its AutoFilter replaced the sheet's,
    // taking another table's filter ownership with it.
    if let Err(e) = require_table_sheet_unprotected(state, active_sheet) {
        return TableResult::err(e);
    }
    // The DEFINED NAMES a table name must not collide with (one namespace),
    // copied out BEFORE any table guard is taken: holding `tables` /
    // `table_names` and then reading `named_ranges` is the reverse of
    // `restamp_workbook_name_casing`'s order (named_ranges, tables,
    // table_names) -- an ABBA pair (lane gatesc, 2026-11-05). Pinned by
    // `tablec_tests::create_table_reads_the_defined_names_before_the_table_guards`.
    let defined_name_keys: std::collections::HashSet<String> = state
        .named_ranges
        .read()
        .map(|names| names.keys().cloned().collect())
        .unwrap_or_default();
    let collides = |candidate: &str| defined_name_keys.contains(&identity::defined_name_key(candidate));
    // CANONICAL LOCK ORDER: the grid mirror first (see `delete_table`). It is
    // read further down to pick up the header text; taken there, it was taken
    // while `tables` and `table_names` were still held, which is the inverted
    // order. Hoisted rather than deferred because the read has to happen inside
    // the same critical section that decides the table's shape.
    let grid = state.grid.read().unwrap();
    // PENDING across the refusals below: the effect is minted only once every
    // one of them has passed, under these same guards.
    let tables_pending = state.tables.lock_pending().unwrap();
    let table_names_pending = state.table_names.lock_pending().unwrap();

    // Validate or generate name
    let name = if params.name.is_empty() {
        generate_table_name(&table_names_pending, |candidate| collides(candidate))
    } else if !is_valid_table_name(&params.name) {
        return TableResult::err("Invalid table name");
    } else if table_names_pending.contains_key(&table_name_key(&params.name)) {
        return TableResult::err("Table name already exists");
    } else if collides(&params.name) {
        return TableResult::err(
            "A defined name with this name already exists. Names and tables share one namespace — pick a different name.",
        );
    } else {
        params.name
    };

    // Normalize range
    let min_row = params.start_row.min(params.end_row);
    let max_row = params.start_row.max(params.end_row);
    let min_col = params.start_col.min(params.end_col);
    let max_col = params.start_col.max(params.end_col);

    // Check for overlapping tables
    if let Some(sheet_tables) = tables_pending.get(&active_sheet) {
        for existing in sheet_tables.values() {
            if ranges_overlap(
                min_row, min_col, max_row, max_col,
                existing.start_row, existing.start_col, existing.end_row, existing.end_col,
            ) {
                return TableResult::err("Table overlaps with existing table");
            }
        }
    }
    // Nor over a data table (rev-xlsx-1, `overlaps_data_table`).
    if overlaps_data_table(&grid, min_row, min_col, max_row, max_col) {
        return TableResult::err(TABLE_OVER_ARRAY_MESSAGE);
    }

    // Every refusal has passed: the create commits.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut tables = tables_pending.authorize(&effect);
    let mut table_names = table_names_pending.authorize(&effect);

    // Read header text from grid cells (or generate generic names). `grid` was
    // acquired at the top of the function -- see the lock-order note there.
    let col_count = (max_col - min_col + 1) as usize;
    let mut header_names: Vec<String> = Vec::with_capacity(col_count);

    for i in 0..col_count {
        let col_idx = min_col + i as u32;
        let raw_name = if params.has_headers {
            grid.get_cell(min_row, col_idx)
                .and_then(|c| match &c.value {
                    engine::CellValue::Text(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
                    engine::CellValue::Number(n) => Some(format!("{}", n)),
                    engine::CellValue::Boolean(b) => Some(if *b { "TRUE".to_string() } else { "FALSE".to_string() }),
                    _ => None,
                })
                .unwrap_or_else(|| format!("Column{}", i + 1))
        } else {
            format!("Column{}", i + 1)
        };
        header_names.push(raw_name);
    }

    // Enforce header uniqueness: append incrementing digit for duplicates
    let unique_names = ensure_unique_headers(&header_names);
    let columns: Vec<TableColumn> = unique_names
        .into_iter()
        .map(|name| TableColumn::new(identity::EntityId::from_bytes(identity::generate_uuid_v7()), name))
        .collect();
    drop(grid);

    // Create style options
    let style_options = params.style_options.unwrap_or(TableStyleOptions {
        header_row: params.has_headers,
        ..Default::default()
    });

    // Create table
    let mut table = Table {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: name.clone(),
        sheet_index: active_sheet,
        start_row: min_row,
        start_col: min_col,
        end_row: max_row,
        end_col: max_col,
        columns,
        style_options,
        style_name: params.style_name.unwrap_or_else(|| "TableStyleMedium2".to_string()),
        auto_filter_id: None,
    };

    // Create an AutoFilter for the table range if show_filter_button is enabled
    let mut autofilter_prev: Option<Option<AutoFilter>> = None;
    if table.style_options.show_filter_button {
        let mut auto_filters = state.auto_filters.write(&effect).unwrap();
        autofilter_prev = Some(auto_filters.get(&active_sheet).cloned());
        let auto_filter = AutoFilter::new(min_row, min_col, max_row, max_col);
        // Record the filter's OWN id, so this table (and only this table) can
        // later prove the sheet's filter belongs to it. Note the insert below
        // replaces any filter another table on this sheet owned — storage is
        // still one-per-sheet — but that table's stale id will no longer match,
        // so it correctly stops claiming ownership.
        table.auto_filter_id = Some(auto_filter.id);
        auto_filters.insert(active_sheet, auto_filter);
    }

    // Store table
    table_names.insert(table_name_key(&name), (active_sheet, table.id));
    tables
        .entry(active_sheet)
        .or_insert_with(HashMap::new)
        .insert(table.id, table.clone());

    // Record undo (BUG-0006: table creation bypassed the undo system).
    // One transaction covers both the table and the autofilter it created.
    // Drop storage locks first; the recorder takes the undo-stack lock.
    drop(tables);
    drop(table_names);
    let opened_transaction = {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        let opened = !undo_stack.has_open_transaction();
        if opened {
            undo_stack.begin_transaction("Create table".to_string());
        }
        opened
    };
    crate::undo_commands::record_table_undo(&state, active_sheet, table.id, None, "Create table");
    if let Some(prev) = autofilter_prev {
        crate::undo_commands::record_autofilter_undo(&state, active_sheet, prev, "Create table");
    }
    if opened_transaction {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.commit_transaction();
    }

    // PHASE B -- every guard above is released. CREATING a table is a value
    // change: `=SUM(Sales[Amount])` typed before `Sales` existed is a `#NAME?`
    // cell, and Excel turns it into a number the moment the table appears.
    // `collect_table_names` records edges for tables that do not exist yet
    // precisely so this works (§2aj).
    recalc_after_table_change(
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &[table.name.clone()],
        &[],
    );

    TableResult::ok(table)
}

/// Delete a table -- Excel's `ListObject.Delete`: the table AND ITS CELLS go
/// (contents and formats; nothing around them moves), and every reference to
/// it becomes `#REF!`, in any cell, in another table's stored formulas and in
/// a defined name ([LIVE, Excel 16, tablefix-probe/probe6.ps1 +
/// tablec/probe1.ps1]). It used to keep the cells and flatten the references
/// to ranges -- Convert to Range under another name, which no Excel gesture
/// does -- and it skipped every formula that also named another table. The
/// AutoFilter the table installed is removed. See [`retire_table_core`].
///
/// AND ITS SLICERS GO WITH IT (§3bn). This was the third dependent, and the one
/// that survived: a slicer kept its `cacheSourceId` pointing at the dead table,
/// answered `"Table {id} not found"` on every item fetch, and went on claiming
/// its rectangle so clicks landing there could never reach the grid. Excel
/// removes a table's slicers with the table; a slicer with a live Report
/// Connection left is repointed instead. Both are [`crate::object_deps`].
#[tauri::command]
pub fn delete_table(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    timeline_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    table_id: identity::EntityId,
) -> TableResult {
    retire_table_core(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &slicer_state,
        &timeline_state,
        table_id,
        RetiredTableRefs::ToRefError,
    )
}

/// Rename a table
#[tauri::command]
pub fn rename_table(
    file_state: State<'_, crate::persistence::FileState>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    table_id: identity::EntityId,
    new_name: String,
) -> TableResult {
    let active_sheet = *state.active_sheet.read().unwrap();
    rename_table_core(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        active_sheet,
        table_id,
        new_name,
    )
}

/// The body of [`rename_table`] for the table `table_id` on `sheet`: the ONE
/// route by which a table's name changes (the Rename box, MCP's
/// `update_table`, and the JSON view's `table` arm all come here). Gates, in
/// order, before any effect: a valid table name, no defined name of that
/// name, the sheet unprotected, then -- under the held grid and table guards
/// -- no OTHER table of that name and the table present. Only then is the
/// document dirtied. Carries every `Old[...]` reference over to the new name
/// as ONE undo step, and re-seeds the name-keyed table dependents.
#[allow(clippy::too_many_arguments)]
pub(crate) fn rename_table_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    table_sheet: usize,
    table_id: identity::EntityId,
    new_name: String,
) -> TableResult {
    if !is_valid_table_name(&new_name) {
        return TableResult::err("Invalid table name");
    }
    if name_collides_with_defined_name(state, &new_name) {
        return TableResult::err(
            "A defined name with this name already exists. Names and tables share one namespace — pick a different name.",
        );
    }

    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = require_table_sheet_unprotected(state, table_sheet) {
        return TableResult::err(&e);
    }
    // The sheet the `grid` mirror shows, so a rewritten formula on it is
    // mirrored there too (the table may live on another sheet).
    let active_sheet = *state.active_sheet.read().unwrap();
    // CANONICAL LOCK ORDER: both grid locks first (see `delete_table`). Held
    // PENDING across the refusals below, so the document is dirtied only
    // after every one of them has passed, in the same critical section.
    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let tables = state.tables.lock_pending().unwrap();
    let table_names = state.table_names.lock_pending().unwrap();

    // Check if new name already exists
    let upper_new = table_name_key(&new_name);
    if let Some(&(sheet, id)) = table_names.get(&upper_new) {
        if sheet != table_sheet || id != table_id {
            return TableResult::err("Table name already exists");
        }
    }
    match tables.get(&table_sheet) {
        None => return TableResult::err("No tables on this sheet"),
        Some(sheet_tables) if !sheet_tables.contains_key(&table_id) => {
            return TableResult::err("Table not found");
        }
        Some(_) => {}
    }

    // Every gate has passed: the rename changes the document.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut tables = tables.authorize(&effect);
    let mut table_names = table_names.authorize(&effect);
    let Some(table) = tables.get_mut(&table_sheet).and_then(|t| t.get_mut(&table_id)) else {
        return TableResult::err("Table not found");
    };

    // Snapshot BEFORE mutating so Ctrl+Z restores the old name (and with it the
    // name-registry entry, which the obj_table restore re-keys).
    let previous = table.clone();
    let upper_old = table_name_key(&table.name);

    // Remove old name, add new name
    table_names.remove(&upper_old);
    table_names.insert(upper_new, (table_sheet, table_id));
    table.name = new_name.clone();

    // rev-xlsx-3: the STORED formulas follow the rename too -- every table's
    // calculated columns and custom totals (this table's own included), not
    // only the grid's cells. [LIVE] Excel 16 rewrites all of them; left stale,
    // an auto-expand copied `Old[..]` into new cells, and live Excel's COM
    // server died opening the export (review rev-xlsx, 0x800706BE). The
    // renamed table's own previous state is `previous`; every OTHER table
    // whose formulas changed is snapshotted for the undo step here.
    let mut other_tables_before: Vec<(usize, identity::EntityId, Table)> = Vec::new();
    for sheet_tables in tables.values_mut() {
        for t in sheet_tables.values_mut() {
            let before = t.clone();
            if rename_table_refs_in_stored_formulas(t, &upper_old, &new_name) && t.id != table_id {
                other_tables_before.push((t.sheet_index, t.id, before));
            }
        }
    }
    let Some(updated) = tables.get(&table_sheet).and_then(|t| t.get(&table_id)).cloned() else {
        return TableResult::err("Table not found");
    };

    // Carry every dependent structured reference over to the new name.
    // Without this the rename silently broke them: `=SUM(Old[Amount])` no
    // longer resolves, an unresolvable table ref becomes a NamedRef, and the
    // evaluator renders that as #NAME? — including the totals-row SUBTOTAL
    // formulas this module writes itself.
    let renamed_cells = rename_table_refs_in_formulas(
        &mut grids,
        &mut grid,
        active_sheet,
        &upper_old,
        &new_name,
    );

    drop(tables);
    drop(table_names);
    drop(grids);
    drop(grid);

    // DEFINED NAMES follow the rename too (rev-xlsx-3): `=SUM(Old[Amount])`
    // as a name's formula. Taken after every table guard is released -- the
    // name commands read `table_names` while holding `named_ranges`, so
    // nesting the other way round would invert their order. Still inside
    // this command and its one undo step below.
    let names_before: Option<Vec<(String, crate::named_ranges::NamedRange)>> = {
        let mut names = state.named_ranges.write(&effect).unwrap();
        let snapshot: Vec<(String, crate::named_ranges::NamedRange)> =
            names.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut changed = false;
        for nr in names.values_mut() {
            if let Some(f) = rename_table_refs_in_formula_text(&nr.refers_to, &upper_old, &new_name) {
                nr.refers_to = f;
                changed = true;
            }
        }
        changed.then_some(snapshot)
    };

    // ONE transaction covering the rename AND the rewritten cells. Recording
    // only the table meant Ctrl+Z put the old name back on the registry while
    // every dependent formula kept saying the NEW name — so undoing a rename
    // produced #NAME? everywhere. Cells are recorded first so they restore last
    // (undo replays a transaction in reverse), i.e. after the table is back.
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        let owned_txn = undo_stack.begin_owned_transaction("Rename table".to_string());
        let mut by_sheet: std::collections::HashMap<usize, Vec<(u32, u32, Option<engine::Cell>)>> =
            std::collections::HashMap::new();
        for (sheet_idx, row, col, before) in renamed_cells {
            by_sheet.entry(sheet_idx).or_default().push((row, col, before));
        }
        let cell_count: usize = by_sheet.values().map(|v| v.len()).sum();
        for (sheet_index, cells) in by_sheet {
            undo_stack.record_custom_restore(
                "script_grid_cells".to_string(),
                crate::undo_commands::script_grid_cells_snapshot_bytes(sheet_index, cells),
                "Restore table references",
            );
        }
        for (sheet, id, before) in other_tables_before {
            undo_stack.record_custom_restore(
                "obj_table".to_string(),
                crate::undo_commands::table_snapshot_bytes(sheet, id, Some(before)),
                "Restore table references",
            );
        }
        if let Some(previous_names) = names_before {
            undo_stack.record_custom_restore(
                "obj_named_ranges".to_string(),
                crate::undo_commands::named_ranges_snapshot_bytes(previous_names),
                "Restore table references",
            );
        }
        undo_stack.record_custom_restore(
            "obj_table".to_string(),
            crate::undo_commands::table_snapshot_bytes(table_sheet, table_id, Some(previous)),
            "Rename table",
        );
        undo_stack.commit_owned(owned_txn);

        if cell_count > 0 {
            crate::log_info!(
                "TABLES",
                "Rename updated {} dependent formula cell(s) to '{}'",
                cell_count,
                new_name
            );
        }
    }

    // PHASE B. The VALUE cannot move -- the same table under a new name covers
    // the same cells -- but `table_dependents` is keyed BY NAME, so every edge
    // is filed under a name the workbook no longer has. Both spellings are
    // named so the rebuild drops the old bucket and the new one is seeded.
    recalc_after_table_change(
        state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        &[upper_old.clone(), new_name.clone()],
        &[],
    );

    TableResult::ok(updated)
}

/// A formula held as TEXT (a table's calculated column or custom total, a
/// defined name's `refers_to`) with every `OldName[...]` pointed at
/// `new_name`, through the same AST rewrite the cells take; `None` when it
/// names no such table (or does not parse, and is then left as it is).
pub(crate) fn rename_table_refs_in_formula_text(formula: &str, old_name_upper: &str, new_name: &str) -> Option<String> {
    if !table_name_key(formula).contains(old_name_upper) {
        return None;
    }
    let parsed = parser::parse(formula).ok()?;
    let (renamed, changed) = crate::rename_table_refs_in_ast(&parsed, old_name_upper, new_name);
    changed.then(|| format!("={}", engine::ast_render::render_formula_raw(&renamed)))
}

/// [`rename_table_refs_in_formula_text`] over one table's stored formulas;
/// whether any changed.
fn rename_table_refs_in_stored_formulas(table: &mut Table, old_name_upper: &str, new_name: &str) -> bool {
    let mut changed = false;
    for column in table.columns.iter_mut() {
        for slot in [&mut column.calculated_formula, &mut column.totals_row_formula] {
            if let Some(renamed) = slot.as_deref().and_then(|f| rename_table_refs_in_formula_text(f, old_name_upper, new_name)) {
                *slot = Some(renamed);
                changed = true;
            }
        }
    }
    changed
}

/// Point every `OldName[...]` structured reference at `new_name`, across all
/// sheets. Returns the PRE-mutation cells so the caller can make it undoable.
///
/// Operates on the AST directly rather than round-tripping through formula
/// text: the stored form IS the AST, so there is no re-parse that could fail
/// and silently demote a formula cell to a value cell. Refs to other tables and
/// bare this-row refs (`[@Col]`) are left untouched.
fn rename_table_refs_in_formulas(
    grids: &mut [engine::Grid],
    grid: &mut engine::Grid,
    active_sheet: usize,
    old_name_upper: &str,
    new_name: &str,
) -> Vec<(usize, u32, u32, Option<engine::Cell>)> {
    let mut touched: Vec<(usize, u32, u32, Option<engine::Cell>)> = Vec::new();

    for (sheet_idx, sheet_grid) in grids.iter_mut().enumerate() {
        // Cheap text prefilter before parsing. A cell can only reference the
        // old name if its formula text mentions it.
        let candidates: Vec<(u32, u32, String)> = sheet_grid
            .cells
            .iter()
            .filter_map(|(&(row, col), cell)| {
                // RAW, not the display form: `formula_string()` collapses a
                // named LAMBDA's `__INVOKE__` marker, and the rewrite below
                // stores what this text re-parses to -- so renaming a table
                // destroyed every named-function call that mentioned it.
                cell.formula_string_raw().and_then(|f| {
                    if table_name_key(&f).contains(old_name_upper) {
                        Some((row, col, f))
                    } else {
                        None
                    }
                })
            })
            .collect();

        for (row, col, formula_str) in candidates {
            let Ok(parsed) = parser::parse(&formula_str) else {
                continue; // Unparseable — leave exactly as-is.
            };
            let (renamed, changed) =
                crate::rename_table_refs_in_ast(&parsed, old_name_upper, new_name);
            if !changed {
                continue; // The name appeared in a string literal, not a ref.
            }
            if let Some(cell) = sheet_grid.get_cell(row, col) {
                let before = cell.clone();
                let mut updated_cell = before.clone();
                updated_cell.ast = Some(Box::new(renamed));
                sheet_grid.set_cell(row, col, updated_cell.clone());
                if sheet_idx == active_sheet {
                    grid.set_cell(row, col, updated_cell);
                }
                touched.push((sheet_idx, row, col, Some(before)));
            }
        }
    }

    touched
}

/// Update table style options
#[tauri::command]
pub fn update_table_style(
    file_state: State<'_, crate::persistence::FileState>,
    state: State<AppState>,
    params: UpdateTableStyleParams,
) -> TableResult {
    let active_sheet = *state.active_sheet.read().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = require_table_sheet_unprotected(&state, active_sheet) {
        return TableResult::err(&e);
    }
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
        let mut tables = state.tables.write(&effect).unwrap();

    let sheet_tables = match tables.get_mut(&active_sheet) {
        Some(t) => t,
        None => return TableResult::err("No tables on this sheet"),
    };

    let table = match sheet_tables.get_mut(&params.table_id) {
        Some(t) => t,
        None => return TableResult::err("Table not found"),
    };

    if let Some(options) = params.style_options {
        table.style_options = options;
    }
    if let Some(name) = params.style_name {
        table.style_name = name;
    }

    TableResult::ok(table.clone())
}

/// Add a column to a table
#[tauri::command]
pub fn add_table_column(
    file_state: State<'_, crate::persistence::FileState>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    table_id: identity::EntityId,
    column_name: String,
    position: Option<usize>,
) -> TableResult {
    let active_sheet = *state.active_sheet.read().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = require_table_sheet_unprotected(&state, active_sheet) {
        return TableResult::err(&e);
    }
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
        let mut tables = state.tables.write(&effect).unwrap();

    let sheet_tables = match tables.get_mut(&active_sheet) {
        Some(t) => t,
        None => return TableResult::err("No tables on this sheet"),
    };

    let table = match sheet_tables.get_mut(&table_id) {
        Some(t) => t,
        None => return TableResult::err("Table not found"),
    };

    // Check for duplicate name
    if table.get_column_by_name(&column_name).is_some() {
        return TableResult::err("Column name already exists");
    }

    // Generate new column ID
    let new_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let new_column = TableColumn::new(new_id, column_name);

    // Insert at position or end
    let pos = position.unwrap_or(table.columns.len());
    if pos > table.columns.len() {
        table.columns.push(new_column);
    } else {
        table.columns.insert(pos, new_column);
    }

    // Expand table range
    table.end_col += 1;

    let result = table.clone();
    let table_name = result.name.clone();
    drop(tables);

    // PHASE B. A wider table moves `Sales[#All]` and `Sales[#Headers]`, and it
    // moves nothing else -- but the cell edges of every reader still have to be
    // re-derived, which is the rebuild's job (§2aj).
    recalc_after_table_change(
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &[table_name],
        &[],
    );

    TableResult::ok(result)
}

/// Remove a column from a table
#[tauri::command]
pub fn remove_table_column(
    file_state: State<'_, crate::persistence::FileState>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    table_id: identity::EntityId,
    column_name: String,
) -> TableResult {
    let active_sheet = *state.active_sheet.read().unwrap();
    // [LIVE] Excel 16 refuses `ListColumn.Delete` on a protected sheet.
    if let Err(e) = require_table_sheet_unprotected(&state, active_sheet) {
        return TableResult::err(e);
    }
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
        let mut tables = state.tables.write(&effect).unwrap();

    let sheet_tables = match tables.get_mut(&active_sheet) {
        Some(t) => t,
        None => return TableResult::err("No tables on this sheet"),
    };

    let table = match sheet_tables.get_mut(&table_id) {
        Some(t) => t,
        None => return TableResult::err("Table not found"),
    };

    // Can't remove last column
    if table.columns.len() <= 1 {
        return TableResult::err("Cannot remove last column");
    }

    let idx = match table.get_column_index(&column_name) {
        Some(i) => i,
        None => return TableResult::err("Column not found"),
    };

    table.columns.remove(idx);
    table.end_col -= 1;

    let result = table.clone();
    let table_name = result.name.clone();
    drop(tables);

    // PHASE B. A reference to the removed column no longer resolves, and in
    // Excel it becomes `#REF!` immediately rather than at the next unrelated
    // edit. Recalculating the readers is what makes that visible now.
    recalc_after_table_change(
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &[table_name],
        &[],
    );

    TableResult::ok(result)
}

/// Rename a table column
#[tauri::command]
pub fn rename_table_column(
    file_state: State<'_, crate::persistence::FileState>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    table_id: identity::EntityId,
    old_name: String,
    new_name: String,
) -> TableResult {
    rename_table_column_core(
        &file_state,
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        table_id,
        old_name,
        new_name,
    )
}

/// The body of [`rename_table_column`] over borrowed state, so it is testable
/// without a Tauri `State`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn rename_table_column_core(
    file_state: &crate::persistence::FileState,
    state: &AppState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    table_id: identity::EntityId,
    old_name: String,
    new_name: String,
) -> TableResult {
    let active_sheet = *state.active_sheet.read().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = require_table_sheet_unprotected(&state, active_sheet) {
        return TableResult::err(&e);
    }
    // PENDING across the not-found refusals, so a refused rename leaves the
    // document clean (it used to dirty first).
    let tables = state.tables.lock_pending().unwrap();
    let Some(table) = tables.get(&active_sheet).and_then(|st| st.get(&table_id)) else {
        return if tables.contains_key(&active_sheet) {
            TableResult::err("Table not found")
        } else {
            TableResult::err("No tables on this sheet")
        };
    };
    let Some(idx) = table.get_column_index(&old_name) else {
        return TableResult::err("Column not found");
    };
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut tables = tables.authorize(&effect);
    let Some(table) = tables.get_mut(&active_sheet).and_then(|st| st.get_mut(&table_id)) else {
        return TableResult::err("Table not found");
    };
    let previous = table.clone();

    // Collect existing names excluding the column being renamed
    let existing: Vec<String> = table.columns.iter()
        .enumerate()
        .filter(|(i, _)| *i != idx)
        .map(|(_, c)| c.name.clone())
        .collect();

    // Enforce non-empty and uniqueness
    let final_name = ensure_unique_header(&new_name, &existing);
    table.columns[idx].name = final_name.clone();

    let result = table.clone();
    let table_name_upper = table_name_key(&result.name);
    drop(tables);

    // Carry every dependent structured reference over to the new COLUMN name.
    //
    // NEW, AND NOT OPTIONAL. While a specifier was flattened at entry, renaming
    // a column could not break a formula -- the formula held `$A$2:$A$4` and had
    // forgotten the column ever had a name. Now that the cell KEEPS
    // `Sales[Amount]` (§2aj), retyping that header would leave every reader
    // naming a column the table no longer has, and an unresolvable specifier
    // degrades to a `NamedRef` the evaluator renders as `#NAME?`. Excel updates
    // them; so does this. It is the exact argument `rename_table_refs_in_formulas`
    // makes one level up, for the table's own name.
    carry_column_rename(
        &state,
        &effect,
        previous,
        &table_name_upper,
        &old_name,
        &final_name,
        "Rename table column",
    );

    recalc_after_table_change(
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &[table_name_upper],
        &[],
    );

    TableResult::ok(result)
}

/// Point every `Table[OldColumn]` specifier at `new_name`, across all sheets.
/// Returns the PRE-mutation cells so the caller can make it undoable.
///
/// `table_bounds` decides which BARE `[@OldColumn]` references are rewritten:
/// only a cell physically inside the table means "this table's column", so a
/// bare reference in some other table's calculated column is left alone.
///
/// Operates on the AST directly rather than round-tripping through formula
/// text, for the reason `rename_table_refs_in_formulas` gives: the stored form
/// IS the AST, so there is no re-parse that could fail and silently demote a
/// formula cell to a value cell.
fn rename_table_column_in_formulas(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    table_name_upper: &str,
    table_bounds: (u32, u32, u32, u32),
    old_name: &str,
    new_name: &str,
) -> Vec<(usize, u32, u32, Option<engine::Cell>)> {
    let active_sheet = *state.active_sheet.read().unwrap();
    let mut grid = state.grid.write(effect).unwrap();
    let mut grids = state.grids.write(effect).unwrap();
    let (t_start_row, t_start_col, t_end_row, t_end_col) = table_bounds;

    let mut touched: Vec<(usize, u32, u32, Option<engine::Cell>)> = Vec::new();
    for (sheet_idx, sheet_grid) in grids.iter_mut().enumerate() {
        let candidates: Vec<(u32, u32)> = sheet_grid
            .cells
            .iter()
            .filter(|(_, cell)| {
                cell.get_ast().is_some_and(crate::ast_has_table_refs)
            })
            .map(|(&coord, _)| coord)
            .collect();

        for (row, col) in candidates {
            // A bare `[@Col]` belongs to this table only when the cell is
            // inside it -- and a table lives on exactly one sheet.
            let inside = sheet_idx == active_sheet
                && row >= t_start_row
                && row <= t_end_row
                && col >= t_start_col
                && col <= t_end_col;
            let Some(cell) = sheet_grid.get_cell(row, col) else { continue };
            let Some(ast) = cell.get_ast() else { continue };
            let (renamed, changed) = crate::table_deps::rename_table_column_in_ast(
                ast,
                table_name_upper,
                old_name,
                new_name,
                inside,
            );
            if !changed {
                continue;
            }
            let before = cell.clone();
            let mut updated_cell = before.clone();
            updated_cell.ast = Some(Box::new(renamed));
            sheet_grid.set_cell(row, col, updated_cell.clone());
            if sheet_idx == active_sheet {
                grid.set_cell(row, col, updated_cell);
            }
            touched.push((sheet_idx, row, col, Some(before)));
        }
    }
    touched
}

/// A formula held as TEXT with every `Table[Old]` (and, when `include_bare`,
/// every bare `[@Old]`) pointed at the new column name, through the same AST
/// rewrite the cells take; `None` when nothing changed or it does not parse.
fn rename_table_column_in_text(
    formula: &str,
    table_name_upper: &str,
    old_name: &str,
    new_name: &str,
    include_bare: bool,
) -> Option<String> {
    let parsed = parser::parse(formula).ok()?;
    let (renamed, changed) =
        crate::table_deps::rename_table_column_in_ast(&parsed, table_name_upper, old_name, new_name, include_bare);
    changed.then(|| format!("={}", engine::ast_render::render_formula_raw(&renamed)))
}

/// Carry a column rename of the table `previous` (as it was BEFORE the
/// rename; the caller has already renamed the column in the store) over to
/// every formula that names the column, as ONE undo step together with the
/// rename itself (NEW-rename-column-stale).
///
/// [LIVE, Excel 16, 2026-11-05, tablec/probe1.ps1] `ListColumn.Name` and an
/// edit of the header cell both rewrite the cells, another table's calculated
/// column (`[@P]+SUM(OldC[A])` -> `..OldC[Z]`), its custom total and a defined
/// name. Only the cells used to follow, so an auto-expand copied the stale
/// `OldC[A]` into the next row and the name became `#REF!`-bound. The table's
/// OWN calculated columns follow too, bare `[@Old]` included; another table's
/// bare references are its own columns and are left alone. Ctrl+Z used to put
/// the cells back but not the column's name, leaving every one of them naming
/// a column the table no longer had: the table snapshot is now in the step.
///
/// LOCKING: the caller holds no `AppState` lock.
fn carry_column_rename(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    previous: Table,
    table_name_upper: &str,
    old_name: &str,
    new_name: &str,
    description: &str,
) {
    let bounds = (previous.start_row, previous.start_col, previous.end_row, previous.end_col);
    let cells = rename_table_column_in_formulas(state, effect, table_name_upper, bounds, old_name, new_name);

    // Every table's stored formulas: the renamed table's own (bare refs are
    // its columns) and every other table's (only `Table[Old]`).
    let mut other_tables_before: Vec<(usize, identity::EntityId, Table)> = Vec::new();
    {
        let mut tables = state.tables.write(effect).unwrap();
        for sheet_tables in tables.values_mut() {
            for t in sheet_tables.values_mut() {
                let own = t.id == previous.id;
                let before = t.clone();
                let mut changed = false;
                for column in t.columns.iter_mut() {
                    for slot in [&mut column.calculated_formula, &mut column.totals_row_formula] {
                        if let Some(f) = slot
                            .as_deref()
                            .and_then(|f| rename_table_column_in_text(f, table_name_upper, old_name, new_name, own))
                        {
                            *slot = Some(f);
                            changed = true;
                        }
                    }
                }
                if changed && !own {
                    other_tables_before.push((t.sheet_index, t.id, before));
                }
            }
        }
    }

    // Defined names. Taken after `tables` is released (the name commands read
    // `table_names` while holding `named_ranges`).
    let names_before: Option<Vec<(String, crate::named_ranges::NamedRange)>> = {
        let mut names = state.named_ranges.write(effect).unwrap();
        let snapshot: Vec<(String, crate::named_ranges::NamedRange)> =
            names.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut changed = false;
        for nr in names.values_mut() {
            if let Some(f) = rename_table_column_in_text(&nr.refers_to, table_name_upper, old_name, new_name, false) {
                nr.refers_to = f;
                changed = true;
            }
        }
        changed.then_some(snapshot)
    };

    // ONE step (joining a caller's open one). Cells first so they restore
    // LAST, after the table object is back under its old column name.
    let mut by_sheet: std::collections::BTreeMap<usize, Vec<(u32, u32, Option<engine::Cell>)>> =
        std::collections::BTreeMap::new();
    for (sheet_idx, row, col, before) in cells {
        by_sheet.entry(sheet_idx).or_default().push((row, col, before));
    }
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let owned_txn = undo_stack.begin_owned_transaction(description.to_string());
    for (sheet_index, sheet_cells) in by_sheet {
        undo_stack.record_custom_restore(
            "script_grid_cells".to_string(),
            crate::undo_commands::script_grid_cells_snapshot_bytes(sheet_index, sheet_cells),
            "Restore table references",
        );
    }
    for (sheet, id, before) in other_tables_before {
        undo_stack.record_custom_restore(
            "obj_table".to_string(),
            crate::undo_commands::table_snapshot_bytes(sheet, id, Some(before)),
            "Restore table references",
        );
    }
    if let Some(previous_names) = names_before {
        undo_stack.record_custom_restore(
            "obj_named_ranges".to_string(),
            crate::undo_commands::named_ranges_snapshot_bytes(previous_names),
            "Restore table references",
        );
    }
    let (sheet, id) = (previous.sheet_index, previous.id);
    undo_stack.record_custom_restore(
        "obj_table".to_string(),
        crate::undo_commands::table_snapshot_bytes(sheet, id, Some(previous)),
        description,
    );
    undo_stack.commit_owned(owned_txn);
}

// ============================================================================
// D3 — TABLE WRITES SEED THE ONE SHARED CASCADE
// ============================================================================

/// Write (or clear) a totals-row cell, storing the STRUCTURED AST, then record its
/// dependency edges.
///
/// THE SECOND DEFECT D3 UNCOVERED, found live in `tables.spec.ts`.
///
/// `set_totals_row_function` and `toggle_totals_row` wrote the totals cell with
/// `engine::Cell::new_formula`, which stores the RAW parse. But
/// `reevaluate_formula_cell` evaluates a cell's cached AST directly and resolves
/// only NAMES: the crate's standing contract is that a stored AST already
/// carries its structured-reference resolution, which is exactly what
/// `update_cell_impl` and `set_calculated_column` store. So the totals cell held
/// an unresolved `SUBTOTAL(109,Table1[Amount])`.
///
/// That had been latent because nothing ever asked the cell for a value — it
/// rendered blank. The moment D3's cascade made it evaluate, it evaluated to
/// **0**: the totals row had been writing a formula the engine could never
/// compute. Storing the resolved form is what makes the totals row show a
/// total, which is the whole point of the feature and what Excel does.
///
/// `formula` is `None` when the command CLEARED the cell (totals function set
/// back to "None"); the edge-dropping half must still run, so the removed
/// formula's stale precedents do not keep it in the graph.
///
/// LOCKING: the caller holds `tables` + `grid` + `grids`; the edge registration
/// takes the dependency maps, which sit AFTER those in the canonical order.
#[allow(clippy::too_many_arguments)]
fn write_table_formula_cell(
    state: &AppState,
    grid: &mut engine::Grid,
    grids: &mut [engine::Grid],
    tables: &TableStorage,
    table_names: &TableNameRegistry,
    sheet_names: &[String],
    active_sheet: usize,
    row: u32,
    col: u32,
    formula: Option<&str>,
) {
    // TWO forms, exactly as `split_entered_formula` produces for a typed one.
    // `stored` keeps the specifier the totals row is written IN
    // (`SUBTOTAL(109,Sales[Amount])`), re-spelled from the table's own
    // capitalisation; `resolved` is the rectangle it names right now, and is
    // only used to derive this cell's precedent edges.
    let stored = formula.and_then(|f| {
        parser::parse(f).ok().map(|mut ast| {
            crate::table_deps::restamp_table_casing(&mut ast, tables, table_names);
            ast
        })
    });
    let resolved = stored.as_ref().map(|ast| {
        if crate::ast_has_table_refs(ast) {
            let ctx = crate::TableRefContext {
                tables,
                table_names,
                sheet_names: sheet_names,
                current_sheet_index: active_sheet,
                current_row: row,
                current_col: col,
            };
            crate::resolve_table_refs_in_ast(ast, &ctx)
        } else {
            ast.clone()
        }
    });

    match formula {
        Some(text) => {
            let mut cell = engine::Cell::new_formula(text.to_string());
            // THE STORED FORM KEEPS THE SPECIFIER (§2aj). It used to be the
            // resolved rectangle, which froze the totals row to the extent the
            // table had at the moment the function was chosen: adding a row
            // under `Sales` left `SUBTOTAL(109,$A$2:$A$4)` summing four cells of
            // five. `eval_ast` now resolves it on every evaluation instead.
            //
            // `new_formula` already stores an UNPARSEABLE formula as TEXT, which
            // is what a bad CUSTOM totals formula did before and must keep doing
            // — overwriting that with a clear would silently discard the user's
            // input. The VALUE is left to the cascade this command seeds: it
            // re-evaluates its own seeds.
            if let Some(ast) = &stored {
                cell.set_cached_ast(crate::convert_expr(ast));
            }
            grid.set_cell(row, col, cell.clone());
            if active_sheet < grids.len() {
                grids[active_sheet].set_cell(row, col, cell);
            }
        }
        None => {
            grid.clear_cell(row, col);
            if active_sheet < grids.len() {
                grids[active_sheet].clear_cell(row, col);
            }
        }
    }

    register_table_formula_dependencies(
        state,
        grid,
        sheet_names,
        active_sheet,
        row,
        col,
        resolved.as_ref(),
        stored.as_ref(),
    );
}

/// Register the dependency edges for a formula cell a table command just wrote,
/// exactly as the ordinary edit path does for a typed formula.
///
/// THE GAP THIS CLOSES. `set_totals_row_function`, `toggle_totals_row` and
/// `set_calculated_column` wrote SUBTOTAL and calculated-column formulas
/// straight into the grid and recorded NO edges at all. Two silent
/// consequences: editing the data underneath a totals row left the total
/// showing its previous number (Excel updates it), and a calculated column
/// reading ANOTHER calculated column was invisible to the cascade these
/// commands now seed — seeding cannot reach a dependent along an edge nobody
/// ever recorded.
///
/// Takes the RESOLVED ast, not the formula text: both callers have already
/// resolved it (the totals writer to store it on the cell, the calculated
/// column to evaluate the row), and structured-reference resolution is per-ROW,
/// so doing it twice is pure duplicated work over a whole column.
///
/// `resolved` is `None` when the command CLEARED the cell (totals function set
/// back to "None"), which must still run: it drops the stale outgoing edges the
/// removed formula owned. `stored` is the tree the CELL keeps, and it is a
/// separate argument because the two answer different questions: the cell edges
/// come from the coordinates in `resolved`, the TABLE edge (§2aj) from the
/// specifier that only `stored` still has.
///
/// LOCKING: the caller holds `tables` + `grid` + `grids`; this takes the
/// dependency maps, which sit AFTER those in the canonical order.
#[allow(clippy::too_many_arguments)]
fn register_table_formula_dependencies(
    state: &AppState,
    grid: &engine::Grid,
    sheet_names: &[String],
    active_sheet: usize,
    row: u32,
    col: u32,
    resolved: Option<&engine::Expression>,
    stored: Option<&engine::Expression>,
) {
    let refs = resolved
        .map(|ast| crate::extract_all_references(ast, grid))
        .unwrap_or_else(crate::ExtractedRefs::new);

    {
        let mut table_dependencies = state.table_dependencies.lock().unwrap();
        let mut table_dependents = state.table_dependents.lock().unwrap();
        let mut read_tables = crate::table_deps::TableSet::default();
        if let Some(ast) = stored {
            crate::table_deps::collect_table_names(ast, &mut read_tables);
        }
        crate::table_deps::update_table_dependencies(
            (row, col),
            read_tables,
            &mut table_dependencies,
            &mut table_dependents,
        );
    }

    {
        let mut dependencies = state.dependencies.lock().unwrap();
        let mut dependents = state.dependents.lock().unwrap();
        crate::update_dependencies((row, col), refs.cells, &mut dependencies, &mut dependents);
    }
    {
        let mut column_dependencies = state.column_dependencies.lock().unwrap();
        let mut column_dependents = state.column_dependents.lock().unwrap();
        crate::update_column_dependencies(
            (row, col),
            refs.columns,
            &mut column_dependencies,
            &mut column_dependents,
        );
    }
    {
        let mut row_dependencies = state.row_dependencies.lock().unwrap();
        let mut row_dependents = state.row_dependents.lock().unwrap();
        crate::update_row_dependencies(
            (row, col),
            refs.rows,
            &mut row_dependencies,
            &mut row_dependents,
        );
    }
    {
        let mut cross_sheet_dependencies = state.cross_sheet_dependencies.lock().unwrap();
        let mut cross_sheet_dependents = state.cross_sheet_dependents.lock().unwrap();
        crate::update_cross_sheet_dependencies(
            (active_sheet, row, col),
            crate::normalize_cross_sheet_refs(&refs.cross_sheet_cells, sheet_names),
            &mut cross_sheet_dependencies,
            &mut cross_sheet_dependents,
        );
    }
}

// PHASE B for every table command below is written out at each call site rather
// than wrapped in a local helper ON PURPOSE. The census
// (`every_cell_writing_function_either_recalculates_or_is_exempt_with_a_reason`)
// reads SOURCE and looks for the shared entry point BY NAME, so a local
// forwarding wrapper would silently blind it — and a blinded census is exactly
// how this defect class kept recurring. The updated cells are discarded for the
// same reason `clear_cell` discards them: these commands return a `Table`, and
// the Table extension repaints the grid from the backend afterwards.

/// Set totals row function for a column.
/// Also writes the corresponding SUBTOTAL formula into the totals row cell.
///
/// DEPENDENTS RECALCULATE (D3): the totals cell it writes is a seed for the ONE
/// shared cascade, so a formula reading the total updates with it, as in Excel.
#[tauri::command]
pub fn set_totals_row_function(
    file_state: State<'_, crate::persistence::FileState>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: SetTotalsRowFunctionParams,
) -> TableResult {
    set_totals_row_function_core(
        &file_state,
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        params,
    )
}

/// The body of [`set_totals_row_function`] over borrowed state, so it is testable
/// without a Tauri `State`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn set_totals_row_function_core(
    file_state: &crate::persistence::FileState,
    state: &AppState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    params: SetTotalsRowFunctionParams,
) -> TableResult {
    let active_sheet = *state.active_sheet.read().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = require_table_sheet_unprotected(&state, active_sheet) {
        return TableResult::err(&e);
    }
    // CANONICAL LOCK ORDER: both grid locks first, then `sheet_names`, then
    // `tables` (see `delete_table` and BUG-0045). PENDING across the
    // not-found refusals, so a refused call leaves the document clean.
    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let totals_sheet_names = state.sheet_names.read().unwrap().clone();
    let tables = state.tables.lock_pending().unwrap();
    let Some(current) = tables.get(&active_sheet).and_then(|st| st.get(&params.table_id)) else {
        return if tables.contains_key(&active_sheet) {
            TableResult::err("Table not found")
        } else {
            TableResult::err("No tables on this sheet")
        };
    };
    let Some(idx) = current.get_column_index(&params.column_name) else {
        return TableResult::err("Column not found");
    };
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut tables = tables.authorize(&effect);
    let Some(table) = tables.get_mut(&active_sheet).and_then(|st| st.get_mut(&params.table_id)) else {
        return TableResult::err("Table not found");
    };
    // NEW-totals-function-undo: the step recorded no undo at all, so Ctrl+Z
    // left the chosen function in place. The table and the totals cell as
    // they were go into ONE step below.
    let previous = table.clone();

    table.columns[idx].totals_row_function = params.function.clone();
    table.columns[idx].totals_row_formula = params.custom_formula.clone();

    // DECIDE what the totals cell must hold. The grid write happens after the
    // `table` borrow ends, because resolving the structured reference needs
    // `&tables` and `table` is a mutable borrow of it.
    let written: Option<(u32, u32, Option<String>)> = if table.style_options.total_row {
        let totals_row = table.end_row;
        let cell_col = table.start_col + idx as u32;
        let table_name = table.name.clone();
        let col_name = table.columns[idx].name.clone();

        // `None` here means the function is "None" -> clear the cell.
        let formula = if params.function == TotalsRowFunction::Custom {
            params.custom_formula.clone()
        } else {
            build_subtotal_formula(&params.function, &table_name, &col_name)
        };
        Some((totals_row, cell_col, formula))
    } else {
        None
    };

    let result = table.clone();

    let mut seeds: Vec<(u32, u32)> = Vec::new();
    let cell_before: Option<(u32, u32, Option<engine::Cell>)> =
        written.as_ref().map(|(row, col, _)| (*row, *col, grid.get_cell(*row, *col).cloned()));
    if let Some((row, col, formula)) = written {
        let table_names = state.table_names.read().unwrap();
        write_table_formula_cell(
            &state,
            &mut grid,
            &mut grids,
            &tables,
            &table_names,
            &totals_sheet_names,
            active_sheet,
            row,
            col,
            formula.as_deref(),
        );
        seeds.push((row, col));
    }

    // PHASE B — after every guard above is released.
    //
    // ONE cascade over the union of two seed populations, not two in sequence:
    // the totals cells this command wrote, AND every formula that reads the
    // table through a structured reference (§2aj). They feed each other — a
    // formula may read the totals cell — so ordering them by luck is exactly
    // what `recalc_after_table_change` exists to prevent.
    drop(grids);
    drop(grid);
    drop(tables);
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        let owned_txn = undo_stack.begin_owned_transaction("Totals row function".to_string());
        if let Some((row, col, cell)) = cell_before {
            undo_stack.record_custom_restore(
                "script_grid_cells".to_string(),
                crate::undo_commands::script_grid_cells_snapshot_bytes(active_sheet, vec![(row, col, cell)]),
                "Totals row function",
            );
        }
        undo_stack.record_custom_restore(
            "obj_table".to_string(),
            crate::undo_commands::table_snapshot_bytes(active_sheet, params.table_id, Some(previous)),
            "Totals row function",
        );
        undo_stack.commit_owned(owned_txn);
    }
    recalc_after_table_change(
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &[result.name.clone()],
        &seeds,
    );

    TableResult::ok(result)
}

/// Toggle totals row visibility.
/// When enabling, expands the table and writes SUBTOTAL formulas into the totals row cells.
/// When disabling, clears the totals row cells and shrinks the table.
///
/// DEPENDENTS RECALCULATE (D3). Every totals cell written OR cleared is a seed
/// for the ONE shared cascade. The CLEAR half matters as much as the write:
/// hiding a totals row erases cells a formula may be reading, and in Excel that
/// formula drops to 0 immediately instead of holding the vanished total.
#[tauri::command]
pub fn toggle_totals_row(
    file_state: State<'_, crate::persistence::FileState>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    timeline_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    table_id: identity::EntityId,
    show: bool,
) -> TableResult {
    toggle_totals_row_shifting(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &slicer_state,
        &timeline_state,
        table_id,
        show,
    )
}

/// [`toggle_totals_row_core`], making room first where the totals row would
/// land on ANOTHER table: [LIVE, Excel 16, 2026-11-06, lane tabxlsx probe1]
/// `ShowTotals` on A1:B4 with A5 filled and a table on A6:B7 (D6 filled)
/// gives A1:B6 and moves the other table to A7:B8 -- Insert Cells, shift
/// down, over the table's columns at the row it met (D6 stays); with the
/// other table directly below (A5:B6) it moves to A6:B7. Where that insert
/// would cut a table (one wider than this one, or offset from it) Excel
/// refuses, and so does Insert Cells here (`shift_cells_impl`). The insert
/// and the totals row are ONE undo step. Calcula refused every such case.
#[allow(clippy::too_many_arguments)]
pub(crate) fn toggle_totals_row_shifting(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    slicer_state: &crate::slicer::SlicerState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    table_id: identity::EntityId,
    show: bool,
) -> TableResult {
    let active_sheet = *state.active_sheet.read().unwrap();
    let blocked = if show { totals_row_blocked_at(state, active_sheet, table_id) } else { None };
    let Some((row, start_col, end_col)) = blocked else {
        return toggle_totals_row_core(
            state, file_state, user_files_state, pivot_state, pane_control_state, ribbon_filter_state, table_id, show,
        );
    };
    if let Err(e) = require_table_sheet_unprotected(state, active_sheet) {
        return TableResult::err(&e);
    }
    let owned_txn = state.undo_stack.lock().unwrap().begin_owned_transaction("Show totals row".to_string());
    let shifted = crate::commands::structure::structure_cells::shift_cells_impl(
        state,
        file_state,
        pivot_state,
        user_files_state,
        pane_control_state,
        ribbon_filter_state,
        slicer_state,
        timeline_state,
        row,
        start_col,
        row,
        end_col,
        crate::commands::structure::structure_cells::CellShift::Down,
        false,
    );
    let refusal = match shifted {
        Err(e) => Some(e),
        Ok(r) if !r.applied => Some(r.confirm.unwrap_or_else(|| TOTALS_ROW_OVER_TABLE_MESSAGE.to_string())),
        Ok(_) => None,
    };
    if let Some(e) = refusal {
        state.undo_stack.lock().unwrap().cancel_owned(owned_txn);
        return TableResult::err(e);
    }
    let after_shift = state.undo_stack.lock().unwrap().current_transaction_mut().map_or(0, |t| t.changes.len());
    let result = toggle_totals_row_core(
        state, file_state, user_files_state, pivot_state, pane_control_state, ribbon_filter_state, table_id, show,
    );
    // The insert landed: the step is committed whatever the toggle said.
    let mut undo = state.undo_stack.lock().unwrap();
    if let Some(open) = undo.current_transaction_mut() {
        // The toggle's cell snapshot is a DEFERRED restore, which runs after
        // the insert's inline ones are undone and would put the inserted
        // (empty) row back over what the insert's undo restored. Recorded as
        // inline cell changes in its own place, the step undoes in order.
        inline_grid_cell_snapshots(open, after_shift);
    }
    undo.commit_owned(owned_txn);
    result
}

/// Every `script_grid_cells` snapshot recorded in `transaction` from change
/// `from` on, replaced in place by the equivalent inline `SetCell` changes
/// (the snapshot carries each cell's full prior state, as `SetCell` does).
fn inline_grid_cell_snapshots(transaction: &mut engine::Transaction, from: usize) {
    let mut out: Vec<engine::CellChange> = Vec::with_capacity(transaction.changes.len());
    for (i, change) in std::mem::take(&mut transaction.changes).into_iter().enumerate() {
        match change {
            engine::CellChange::CustomRestore { kind, data } if i >= from && kind == "script_grid_cells" => {
                match serde_json::from_slice::<crate::undo_commands::ScriptGridCellsSnapshot>(&data) {
                    Ok(snapshot) => out.extend(snapshot.cells.into_iter().map(|(row, col, previous)| engine::CellChange::SetCell {
                        sheet: snapshot.sheet_index,
                        row,
                        col,
                        previous,
                    })),
                    Err(_) => out.push(engine::CellChange::CustomRestore { kind, data }),
                }
            }
            other => out.push(other),
        }
    }
    transaction.changes = out;
}

/// The row where turning the totals row on would meet ANOTHER table (see
/// [`totals_row_landing`]), with the table's columns; `None` when it lands
/// without meeting one. Read and released.
fn totals_row_blocked_at(state: &AppState, sheet: usize, table_id: identity::EntityId) -> Option<(u32, u32, u32)> {
    let grid = state.grid.read().ok()?;
    let tables = state.tables.read().ok()?;
    let table = tables.get(&sheet)?.get(&table_id)?;
    if table.style_options.total_row {
        return None;
    }
    let mut row = table.end_row + 1;
    while row <= engine::EXCEL_MAX_ROW_INDEX {
        let blocked_by_table = tables.get(&sheet).is_some_and(|st| {
            st.values().any(|t| {
                t.id != table.id
                    && ranges_overlap(row, table.start_col, row, table.end_col, t.start_row, t.start_col, t.end_row, t.end_col)
            })
        });
        if blocked_by_table {
            return Some((row, table.start_col, table.end_col));
        }
        let occupied = (table.start_col..=table.end_col).any(|col| {
            grid.get_cell(row, col).is_some_and(|cell| {
                cell.ast.is_some() || !matches!(cell.value, engine::CellValue::Empty) || cell.style_index != 0
            })
        });
        if !occupied || overlaps_data_table(&grid, row, table.start_col, row, table.end_col) {
            return None;
        }
        row += 1;
    }
    None
}

/// The body of [`toggle_totals_row`] over borrowed state, so it is testable
/// without a Tauri `State`.
pub(crate) fn toggle_totals_row_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    table_id: identity::EntityId,
    show: bool,
) -> TableResult {
    let active_sheet = *state.active_sheet.read().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = require_table_sheet_unprotected(&state, active_sheet) {
        return TableResult::err(&e);
    }
    // CANONICAL LOCK ORDER: both grid locks first, then `sheet_names`, then
    // `tables` (see `delete_table` and BUG-0045). PENDING across the
    // refusals below, so a refused toggle leaves the document clean.
    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let toggle_sheet_names = state.sheet_names.read().unwrap().clone();
    let tables = state.tables.lock_pending().unwrap();
    let Some(current) = tables.get(&active_sheet).and_then(|st| st.get(&table_id)) else {
        return if tables.contains_key(&active_sheet) {
            TableResult::err("Table not found")
        } else {
            TableResult::err("No tables on this sheet")
        };
    };
    // Where the totals row lands when it is turned on (`totals_row_landing`).
    let totals_at: Option<u32> = if show && !current.style_options.total_row {
        match totals_row_landing(&grid, &tables, active_sheet, current) {
            Ok(row) => Some(row),
            Err(e) => return TableResult::err(e),
        }
    } else {
        None
    };
    // Turning on a shown totals row, or off a hidden one, changes nothing.
    if totals_at.is_none() && !(!show && current.style_options.total_row) {
        return TableResult::ok(current.clone());
    }
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut tables = tables.authorize(&effect);

    let Some(table) = tables.get_mut(&active_sheet).and_then(|st| st.get_mut(&table_id)) else {
        return TableResult::err("Table not found");
    };
    // The step's undo (it recorded none): the table as it was.
    let previous = table.clone();

    let was_shown = table.style_options.total_row;
    // (row, col, formula) for every totals cell this call writes or clears.
    let mut written: Vec<(u32, u32, Option<String>)> = Vec::new();
    // The totals-row LABEL cell, when one is written.
    let mut label_at: Option<(u32, u32)> = None;
    // (row, col, label) for every remembered constant written back.
    let mut labels: Vec<(u32, u32, String)> = Vec::new();

    if let Some(totals_row) = totals_at {
        // Adding the totals row: the rows the landing absorbed become data
        // rows (NEW-totals-row-overwrite).
        table.end_row = totals_row;
        table.style_options.total_row = true;

        // EXCEL'S DEFAULTS (NEW-totals-row-defaults). [LIVE, Excel 16,
        // 2026-11-05, tablefix-probe/probe1.ps1 + probe5.ps1] Turning the
        // totals row on puts the label "Total" under the FIRST column and a
        // function under the LAST: Sum (109) when that column's data are
        // numbers (blanks allowed, at least one number), Count (103) when it
        // holds text, booleans or dates, or nothing at all; a ONE-column table
        // gets only the function. Turned off and on again, Excel keeps the
        // functions the user chose, so the defaults apply only while no column
        // has one -- the table's first totals row, in practice.
        //
        // A remembered LABEL is the user's choice too (NEW-totals-constant-none):
        // a `7` typed over the total sets the column to None, and [LIVE,
        // cfdv/probe2.ps1 P1/P4] Excel shows the `7` again after off and on --
        // never the default Sum the "no column has a function" test gave it.
        // (An EMPTY remembered label is a totals row the user emptied: not a
        // first show, BUG-0742.)
        let first_show = table_totals_all_empty(&table.columns)
            && table.columns.iter().all(|c| c.totals_row_label.is_none());
        if first_show {
            if let Some(last) = table.columns.len().checked_sub(1) {
                let last_col = table.start_col + last as u32;
                let sum = {
                    let styles = state.style_registry.read().unwrap();
                    totals_default_is_sum(&grid, &styles, table.data_start_row(), table.data_end_row(), last_col)
                };
                table.columns[last].totals_row_function =
                    if sum { TotalsRowFunction::Sum } else { TotalsRowFunction::Count };
            }
        }
        if first_show && table.columns.len() > 1 && table.columns[0].totals_row_function == TotalsRowFunction::None {
            label_at = Some((table.end_row, table.start_col));
        }

        // Write SUBTOTAL formulas for columns that have a function set
        let totals_row = table.end_row;
        let table_name = table.name.clone();
        for (i, col) in table.columns.iter().enumerate() {
            let cell_col = table.start_col + i as u32;
            if col.totals_row_function != TotalsRowFunction::None {
                let formula = if col.totals_row_function == TotalsRowFunction::Custom {
                    col.totals_row_formula.clone()
                } else {
                    build_subtotal_formula(&col.totals_row_function, &table_name, &col.name)
                };
                if let Some(formula_str) = formula {
                    written.push((totals_row, cell_col, Some(formula_str)));
                }
            } else if let Some(label) = col.totals_row_label.as_ref().filter(|l| !l.is_empty()) {
                labels.push((totals_row, cell_col, label.clone()));
            }
        }
    } else if !show && was_shown {
        // Removing totals row - the cells are CLEARED below, then the range
        // shrinks. A column with no function first REMEMBERS the constant its
        // totals cell shows (Excel's `totalsRowLabel`), so showing the row
        // again puts it back (NEW-totals-constant-none).
        let totals_row = table.end_row;
        for (i, column) in table.columns.iter_mut().enumerate() {
            let cell_col = table.start_col + i as u32;
            column.totals_row_label = if column.totals_row_function == TotalsRowFunction::None {
                totals_label_of(grid.get_cell(totals_row, cell_col))
            } else {
                None
            };
            written.push((totals_row, cell_col, None));
        }
        // A totals row the user EMPTIED -- every function None, every label
        // cleared -- is remembered as empty, never as "not yet shown": [LIVE,
        // Excel 16, 2026-11-06, lane tabxlsx probe1 S2b/S2c] with the Sum set
        // to None and the "Total" label cleared, `ShowTotals` off and on
        // shows an empty row, no default Sum or label (BUG-0742). The memory
        // is an EMPTY remembered label on the first column, which shows as
        // nothing and rides `totals_row_label` like any other.
        if table_totals_all_empty(&table.columns) {
            if let Some(first) = table.columns.first_mut() {
                first.totals_row_label = Some(String::new());
            }
        }
        table.end_row -= 1;
        table.style_options.total_row = false;
    }

    let result = table.clone();

    // The cells this step writes or clears, as they were, for its undo.
    let cells_before: Vec<(u32, u32, Option<engine::Cell>)> = written
        .iter()
        .map(|(r, c, _)| (*r, *c))
        .chain(label_at)
        .chain(labels.iter().map(|(r, c, _)| (*r, *c)))
        .map(|(r, c)| (r, c, grid.get_cell(r, c).cloned()))
        .collect();

    // WRITE, after the `table` borrow ends: resolving the structured reference
    // needs `&tables`, and `table` is a mutable borrow of it.
    if !written.is_empty() {
        let table_names = state.table_names.read().unwrap();
        for (row, col, formula) in &written {
            write_table_formula_cell(
                &state,
                &mut grid,
                &mut grids,
                &tables,
                &table_names,
                &toggle_sheet_names,
                active_sheet,
                *row,
                *col,
                formula.as_deref(),
            );
        }
    }
    // The label is TEXT in the totals cell, as Excel's is (`totalsRowLabel` in
    // the file; `xlsx_tables` writes a text totals cell as that label).
    if let Some((row, col)) = label_at {
        let label = engine::Cell::new_text("Total".to_string());
        grid.set_cell(row, col, label.clone());
        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(row, col, label);
        }
    }
    for (row, col, label) in &labels {
        let cell = totals_label_cell(label);
        grid.set_cell(*row, *col, cell.clone());
        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(*row, *col, cell);
        }
    }
    let mut seeds: Vec<(u32, u32)> = written.iter().map(|(r, c, _)| (*r, *c)).collect();
    seeds.extend(label_at);
    seeds.extend(labels.iter().map(|(r, c, _)| (*r, *c)));

    // PHASE B — after every guard above is released.
    //
    // ONE cascade over the union of two seed populations, not two in sequence:
    // the totals cells this command wrote, AND every formula that reads the
    // table through a structured reference (§2aj). They feed each other — a
    // formula may read the totals cell — so ordering them by luck is exactly
    // what `recalc_after_table_change` exists to prevent.
    //
    // Showing or hiding a totals row also moves `data_end_row`, so every
    // `Table[Column]` in the workbook covers a different number of rows than it
    // did a moment ago. That is a value change for the readers, not only for the
    // totals cells.
    drop(grids);
    drop(grid);
    drop(tables);

    // The table's AutoFilter stops above the totals row and covers every data
    // row -- the rows the landing absorbed included (`filter_end_row`). Only
    // the filter this table owns.
    let mut filter_before: Option<crate::autofilter::AutoFilter> = None;
    if result.style_options.show_filter_button {
        let mut auto_filters = state.auto_filters.write(&effect).unwrap();
        if let Some(af) = auto_filters.get_mut(&active_sheet) {
            if result.auto_filter_id == Some(af.id) && af.end_row != result.filter_end_row() {
                filter_before = Some(af.clone());
                af.end_row = result.filter_end_row();
            }
        }
    }

    // ONE undo step (it recorded none, so Ctrl+Z left the totals row on and
    // its formulas in place): the cells first so they restore LAST, then the
    // filter, then the table.
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        let label = if show { "Show totals row" } else { "Hide totals row" };
        let owned_txn = undo_stack.begin_owned_transaction(label.to_string());
        if !cells_before.is_empty() {
            undo_stack.record_custom_restore(
                "script_grid_cells".to_string(),
                crate::undo_commands::script_grid_cells_snapshot_bytes(active_sheet, cells_before),
                label,
            );
        }
        if let Some(af) = filter_before {
            undo_stack.record_custom_restore(
                "obj_autofilter".to_string(),
                crate::undo_commands::autofilter_snapshot_bytes(active_sheet, Some(af)),
                label,
            );
        }
        undo_stack.record_custom_restore(
            "obj_table".to_string(),
            crate::undo_commands::table_snapshot_bytes(active_sheet, table_id, Some(previous)),
            label,
        );
        undo_stack.commit_owned(owned_txn);
    }

    recalc_after_table_change(
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &[result.name.clone()],
        &seeds,
    );

    TableResult::ok(result)
}

/// The refusal for a totals row that would land on another table when no
/// room was made for it. [LIVE, Excel 16, tablec/probe3.ps1] Excel SHIFTS
/// the table below down to make room, and so does the command
/// ([`toggle_totals_row_shifting`], BUG-0742); the bare
/// [`toggle_totals_row_core`] still refuses.
pub(crate) const TOTALS_ROW_OVER_TABLE_MESSAGE: &str =
    "The totals row would land on another table. Move that table down first.";

/// The row a totals row lands on when it is turned on: the first row below
/// the table whose cells, across the table's columns, hold nothing -- no
/// value, no formula, no format. Every occupied row before it is absorbed
/// into the table as a data row. [LIVE, Excel 16, 2026-11-05,
/// tablec/probe1.ps1 + probe3.ps1] `ShowTotals` on A1:B4 with A5 and B6
/// filled gives A1:B7 (data to row 6, the totals row 7, nothing moved); A5
/// filled, row 6 empty, A7 filled gives A1:B6; a cell beside the table's
/// columns (C5) is not in the way; a FORMATTED empty cell is (A1:B7). The
/// totals row used to be written over row 5, destroying what was there
/// (NEW-totals-row-overwrite).
fn totals_row_landing(
    grid: &engine::Grid,
    tables: &TableStorage,
    sheet: usize,
    table: &Table,
) -> Result<u32, String> {
    let mut row = table.end_row + 1;
    loop {
        if row > engine::EXCEL_MAX_ROW_INDEX {
            return Err("The totals row would fall off the bottom of the sheet.".to_string());
        }
        let blocked_by_table = tables.get(&sheet).is_some_and(|st| {
            st.values().any(|t| {
                t.id != table.id
                    && ranges_overlap(row, table.start_col, row, table.end_col, t.start_row, t.start_col, t.end_row, t.end_col)
            })
        });
        if blocked_by_table {
            return Err(TOTALS_ROW_OVER_TABLE_MESSAGE.to_string());
        }
        if overlaps_data_table(grid, row, table.start_col, row, table.end_col) {
            return Err(TABLE_OVER_ARRAY_MESSAGE.to_string());
        }
        let occupied = (table.start_col..=table.end_col).any(|col| {
            grid.get_cell(row, col).is_some_and(|cell| {
                cell.ast.is_some() || !matches!(cell.value, engine::CellValue::Empty) || cell.style_index != 0
            })
        });
        if !occupied {
            return Ok(row);
        }
        row += 1;
    }
}

/// Resize a table
#[tauri::command]
pub fn resize_table(
    file_state: State<'_, crate::persistence::FileState>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: ResizeTableParams,
) -> TableResult {
    let active_sheet = *state.active_sheet.read().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = require_table_sheet_unprotected(&state, active_sheet) {
        return TableResult::err(&e);
    }
    // Nor over a data table (rev-xlsx-1, `overlaps_data_table`). The grid is
    // read and released before `tables` is taken (canonical order).
    if overlaps_data_table(
        &state.grid.read().unwrap(),
        params.start_row.min(params.end_row),
        params.start_col.min(params.end_col),
        params.start_row.max(params.end_row),
        params.start_col.max(params.end_col),
    ) {
        return TableResult::err(TABLE_OVER_ARRAY_MESSAGE);
    }
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
        let mut tables = state.tables.write(&effect).unwrap();

    let sheet_tables = match tables.get_mut(&active_sheet) {
        Some(t) => t,
        None => return TableResult::err("No tables on this sheet"),
    };

    // Check for overlapping tables
    for (id, existing) in sheet_tables.iter() {
        if *id != params.table_id {
            if ranges_overlap(
                params.start_row, params.start_col, params.end_row, params.end_col,
                existing.start_row, existing.start_col, existing.end_row, existing.end_col,
            ) {
                return TableResult::err("Resized table would overlap with existing table");
            }
        }
    }

    let table = match sheet_tables.get_mut(&params.table_id) {
        Some(t) => t,
        None => return TableResult::err("Table not found"),
    };

    // Snapshot BEFORE mutating: a resize can also add or truncate COLUMNS, so
    // undo has to restore the whole table object, not just the boundaries.
    let previous = table.clone();

    let min_row = params.start_row.min(params.end_row);
    let max_row = params.start_row.max(params.end_row);
    let min_col = params.start_col.min(params.end_col);
    let max_col = params.start_col.max(params.end_col);

    // Re-align columns by ABSOLUTE grid position, not by list position.
    //
    // Push/truncate-at-the-tail is only correct when start_col is unchanged.
    // Extend a C:E table leftwards to A:E and the tail logic keeps [X, Y, Z]
    // and appends two — so column A silently inherits X's name, identity and
    // calculated-column formula, and the two brand-new columns land on D and E
    // where Y and Z actually are. Every structured reference into the table then
    // points at the wrong physical column.
    //
    // Mapping each new absolute column back to the old table preserves column
    // identity (EntityId), name and formula wherever the ranges overlap, and
    // mints a fresh column only where there was none.
    let old_start_col = table.start_col;
    let old_columns = std::mem::take(&mut table.columns);

    // Resolve what carries over FIRST, so generated names can avoid colliding
    // with a carried name that appears later in the range (a table whose column
    // is literally called "Column1" would otherwise get a duplicate).
    let carried: Vec<Option<TableColumn>> = (min_col..=max_col)
        .map(|abs_col| {
            if abs_col >= old_start_col {
                old_columns.get((abs_col - old_start_col) as usize).cloned()
            } else {
                None
            }
        })
        .collect();

    let mut used_names: std::collections::HashSet<String> = carried
        .iter()
        .flatten()
        .map(|c| c.name.to_uppercase())
        .collect();

    let mut rebuilt: Vec<TableColumn> = Vec::with_capacity(carried.len());
    for slot in carried {
        match slot {
            Some(existing) => rebuilt.push(existing),
            None => {
                // Fresh column: first ColumnN not taken by any carried or
                // previously generated name.
                let mut n = rebuilt.len() + 1;
                let mut name = format!("Column{}", n);
                while used_names.contains(&name.to_uppercase()) {
                    n += 1;
                    name = format!("Column{}", n);
                }
                used_names.insert(name.to_uppercase());
                let new_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
                rebuilt.push(TableColumn::new(new_id, name));
            }
        }
    }
    table.columns = rebuilt;

    table.start_row = min_row;
    table.start_col = min_col;
    table.end_row = max_row;
    table.end_col = max_col;

    let updated = table.clone();
    let table_id = params.table_id;
    let claims_filter = table.auto_filter_id.is_some() && table.style_options.show_filter_button;
    drop(tables);

    // Keep the table's AutoFilter on the table. `check_table_auto_expand`
    // already does this for growth; a resize moved the table out from under its
    // filter, which left the chevrons on the old header row.
    //
    // OWNERSHIP is now an exact id match: a sheet holds one AutoFilter, and
    // only the table whose `auto_filter_id` equals that filter's own id owns
    // it. Previously this had to be inferred from geometry, which quietly let
    // one table drag another table's filter (and its criteria) onto itself.
    let mut filter_undo: Option<crate::autofilter::AutoFilter> = None;
    if claims_filter {
        if let Ok(mut auto_filters) = state.auto_filters.write(&effect) {
            if let Some(af) = auto_filters.get_mut(&active_sheet) {
                let is_ours = previous.auto_filter_id == Some(af.id);
                if is_ours {
                    filter_undo = Some(af.clone());

                    let old_start = af.start_col;
                    af.start_row = updated.start_row;
                    // The filter stops above the totals row (`filter_end_row`).
                    af.end_row = updated.filter_end_row();
                    af.start_col = updated.start_col;
                    af.end_col = updated.end_col;
                    // `column_filters` and the remembered sort are keyed
                    // RELATIVE to start_col. Moving start_col without re-keying
                    // would leave every criterion and sort level pointing at a
                    // different physical column -- filtering (and Reapply
                    // sorting) the wrong data with no visible change. A resize
                    // moves no cells, so each column stays where it is; keys for
                    // columns the resize cut are dropped.
                    af.rekey_columns(old_start, Some);
                }
            }
        }
    }

    // ONE transaction: undoing the resize must also put the filter back where
    // it was, criteria and all. Recording only the table left Ctrl+Z restoring
    // the old bounds while the filter stayed on the resized range.
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        let owned_txn = undo_stack.begin_owned_transaction("Resize table".to_string());
        if let Some(af_previous) = filter_undo {
            undo_stack.record_custom_restore(
                "obj_autofilter".to_string(),
                crate::undo_commands::autofilter_snapshot_bytes(active_sheet, Some(af_previous)),
                "Restore table filter",
            );
        }
        undo_stack.record_custom_restore(
            "obj_table".to_string(),
            crate::undo_commands::table_snapshot_bytes(active_sheet, table_id, Some(previous)),
            "Resize table",
        );
        undo_stack.commit_owned(owned_txn);
    }

    // PHASE B. THE reason §2aj exists: a resize is what a structured reference
    // is FOR. `=SUM(Sales[Amount])` covered `A2:A4` a moment ago and covers
    // whatever the new boundary says now, so every reader is a value change --
    // and every reader's CELL edges have to be re-derived too, or the total
    // would follow the resize once and then stop noticing edits to the rows it
    // gained. Both are `recalc_after_table_change`'s job.
    recalc_after_table_change(
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &[updated.name.clone()],
        &[],
    );

    TableResult::ok(updated)
}

/// What becomes of every reference to a table that stops being one.
///
/// [LIVE, Excel 16, 2026-11-05, tablefix-probe/probe6.ps1 + tablec/probe3.ps1]
/// `ListObject.Unlist` (Convert to Range) rewrites each reference into the
/// rectangle it named, ABSOLUTE and SHEET-QUALIFIED even on the table's own
/// sheet -- `SUM(T[A])` -> `SUM(Sheet3!$A$2:$A$4)`, `T[#All]` ->
/// `Sheet3!$A$1:$C$5`, `T[[#Headers],[A]]` -> `Sheet3!$A$1` -- and a this-row
/// reference into a ROW-relative one (`[@A]*2` -> `Sheet3!$A2*2`).
/// `ListObject.Delete` clears the table's cells and every reference to it
/// becomes `#REF!` (`SUM(T[A])` -> `SUM(#REF!)`). Either way a reference to
/// ANOTHER table in the same formula is kept: `[@P]+SUM(T[A])` keeps `[@P]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetiredTableRefs {
    /// Convert to Range.
    ToRange,
    /// Delete.
    ToRefError,
}

/// Every `TableRef` node of `ast` handed to `f`, which returns its
/// replacement (or `None` to keep it); every other node is rebuilt as it was.
fn map_table_refs(ast: &parser::ast::Expression, f: &mut dyn FnMut(&parser::ast::Expression) -> Option<parser::ast::Expression>) -> parser::ast::Expression {
    use parser::ast::Expression as E;
    match ast {
        E::TableRef { .. } => f(ast).unwrap_or_else(|| ast.clone()),
        E::Literal(_) | E::CellRef { .. } | E::ColumnRef { .. } | E::RowRef { .. } | E::NamedRef { .. } => ast.clone(),
        E::BinaryOp { left, op, right } => E::BinaryOp {
            left: Box::new(map_table_refs(left, f)),
            op: *op,
            right: Box::new(map_table_refs(right, f)),
        },
        E::UnaryOp { op, operand } => E::UnaryOp { op: *op, operand: Box::new(map_table_refs(operand, f)) },
        E::FunctionCall { func, args, ref_site_id } => E::FunctionCall {
            func: func.clone(),
            args: args.iter().map(|a| map_table_refs(a, f)).collect(),
            ref_site_id: *ref_site_id,
        },
        E::Range { sheet, start, end, ref_site_id } => E::Range {
            sheet: sheet.clone(),
            start: Box::new(map_table_refs(start, f)),
            end: Box::new(map_table_refs(end, f)),
            ref_site_id: *ref_site_id,
        },
        E::Sheet3DRef { start_sheet, end_sheet, reference, ref_site_id } => E::Sheet3DRef {
            start_sheet: start_sheet.clone(),
            end_sheet: end_sheet.clone(),
            reference: Box::new(map_table_refs(reference, f)),
            ref_site_id: *ref_site_id,
        },
        E::IndexAccess { target, index } => E::IndexAccess {
            target: Box::new(map_table_refs(target, f)),
            index: Box::new(map_table_refs(index, f)),
        },
        E::ArrayLiteral { rows } => E::ArrayLiteral {
            rows: rows.iter().map(|r| r.iter().map(|e| map_table_refs(e, f)).collect()).collect(),
        },
        E::ListLiteral { elements } => E::ListLiteral { elements: elements.iter().map(|e| map_table_refs(e, f)).collect() },
        E::DictLiteral { entries } => E::DictLiteral {
            entries: entries.iter().map(|(k, v)| (map_table_refs(k, f), map_table_refs(v, f))).collect(),
        },
        E::SpillRef { cell, ref_site_id } => E::SpillRef { cell: Box::new(map_table_refs(cell, f)), ref_site_id: *ref_site_id },
        E::ImplicitIntersection { operand } => E::ImplicitIntersection { operand: Box::new(map_table_refs(operand, f)) },
    }
}

/// A resolved rectangle as Excel's Unlist spells it: qualified with the
/// table's sheet when it is not already, and with the ROW relative when it
/// came from a this-row reference.
fn qualify_unlisted(expr: parser::ast::Expression, sheet_name: &str, this_row: bool) -> parser::ast::Expression {
    use parser::ast::Expression as E;
    fn relative_row(e: &mut E) {
        if let E::CellRef { row_absolute, .. } = e {
            *row_absolute = false;
        }
    }
    match expr {
        E::CellRef { sheet, col, row, col_absolute, row_absolute, ref_site_id } => E::CellRef {
            sheet: sheet.or_else(|| Some(sheet_name.to_string())),
            col,
            row,
            col_absolute,
            row_absolute: row_absolute && !this_row,
            ref_site_id,
        },
        E::Range { sheet, mut start, mut end, ref_site_id } => {
            if this_row {
                relative_row(&mut start);
                relative_row(&mut end);
            }
            E::Range { sheet: sheet.or_else(|| Some(sheet_name.to_string())), start, end, ref_site_id }
        }
        other => other,
    }
}

/// `ast` with every reference to the retiring table rewritten per `fate`;
/// `None` when it names the table nowhere.
///
/// A NAMED reference is the table's when its name is the table's (Excel's
/// name rule, `table_name_key`). A BARE one (`[@A]`) means "the table this
/// formula is in", so it is the table's only when `bare_is_target` -- a cell
/// inside the table on its sheet. A stored formula of ANOTHER table, or a
/// defined name, passes false. ONLY the target's nodes change: the grid's
/// general resolver flattens every table a formula names, which is why a
/// mixed `[@P]+SUM(Old[A])` used to be skipped altogether and left reading a
/// table that no longer existed (rev-xlsx-3).
#[allow(clippy::too_many_arguments)]
fn retire_table_refs_in_ast(
    ast: &parser::ast::Expression,
    target_key: &str,
    target_sheet_name: &str,
    fate: RetiredTableRefs,
    ctx: &crate::TableRefContext,
    bare_is_target: bool,
) -> Option<parser::ast::Expression> {
    use parser::ast::{Expression as E, TableSpecifier as S};
    let mut changed = false;
    let out = map_table_refs(ast, &mut |node| {
        let E::TableRef { table_name, specifier, .. } = node else { return None };
        let ours = if table_name.is_empty() { bare_is_target } else { table_name_key(table_name) == target_key };
        if !ours {
            return None;
        }
        changed = true;
        Some(match fate {
            RetiredTableRefs::ToRefError => E::Literal(parser::ast::Value::Error("#REF!".to_string())),
            RetiredTableRefs::ToRange => {
                let this_row = matches!(specifier, S::ThisRow(_) | S::ThisRowRange(_, _));
                qualify_unlisted(crate::resolve_table_refs_in_ast(node, ctx), target_sheet_name, this_row)
            }
        })
    });
    changed.then_some(out)
}

/// `formula` with every structured reference NAMING one of `table_keys`
/// (`table_name_key`) -- the tables of a sheet being DELETED -- rewritten to
/// `#REF!`, or `None` when it names none of them (or does not parse).
///
/// [LIVE, Excel 16, 2026-11-06, lane tabxlsx probe1] with a table `TT` on a
/// sheet that is then deleted, `=SUM(TT[H2])` becomes `=SUM(#REF!)`,
/// `=SUM(TT[[#Headers],[H1]:[H2]])` `=SUM(#REF!)`, `=TT[[#This Row],[H1]]`
/// `=#REF!`, `=COUNTA(TT[#All])` `=COUNTA(#REF!)` and
/// `=IFERROR(SUM(TT[H1]),-1)` `=IFERROR(SUM(#REF!),-1)` (shows -1) -- the
/// rule Delete Table already follows (`RetiredTableRefs::ToRefError`). Before
/// (BUG-0750) the reference kept `TT[H2]`, naming a table that no longer
/// existed. A bare reference (`[@H1]`) is the formula's OWN table, never one
/// on the deleted sheet, and is kept.
pub(crate) fn retire_deleted_sheet_table_refs(formula: &str, table_keys: &[String]) -> Option<String> {
    if table_keys.is_empty() {
        return None;
    }
    let folded = table_name_key(formula);
    if !table_keys.iter().any(|k| folded.contains(k.as_str())) {
        return None;
    }
    let parsed = parser::parse(formula).ok()?;
    let mut changed = false;
    let out = map_table_refs(&parsed, &mut |node| {
        let parser::ast::Expression::TableRef { table_name, .. } = node else { return None };
        if table_name.is_empty() || !table_keys.iter().any(|k| *k == table_name_key(table_name)) {
            return None;
        }
        changed = true;
        Some(parser::ast::Expression::Literal(parser::ast::Value::Error("#REF!".to_string())))
    });
    changed.then(|| format!("={}", engine::ast_render::render_formula_raw(&out)))
}

/// [`retire_table_refs_in_ast`] over a formula held as TEXT (another table's
/// calculated column or custom total, a defined name's `refers_to`): bare
/// references there are never the retiring table's. `None` when nothing
/// changed or the text does not parse (it is then left as it is).
fn retire_table_refs_in_text(
    formula: &str,
    target_key: &str,
    target_sheet_name: &str,
    fate: RetiredTableRefs,
    ctx: &crate::TableRefContext,
) -> Option<String> {
    if !table_name_key(formula).contains(target_key) {
        return None;
    }
    let parsed = parser::parse(formula).ok()?;
    let out = retire_table_refs_in_ast(&parsed, target_key, target_sheet_name, fate, ctx, false)?;
    Some(format!("={}", engine::ast_render::render_formula_raw(&out)))
}

/// THE ONE BODY OF `delete_table` AND `convert_to_range`: the table `table_id`
/// on the active sheet stops being a table, and every reference to it --
/// in any cell of any sheet, in every OTHER table's calculated columns and
/// custom totals, and in every defined name -- is rewritten per `fate`, as ONE
/// undo step together with the table, its AutoFilter, its object scripts and
/// its slicers (§3bn). `ToRefError` (Delete) also CLEARS the table's cells,
/// contents and formats: [LIVE, Excel 16, tablec/probe1.ps1] after
/// `ListObject.Delete` the cells are empty and unformatted and nothing below
/// or beside them moves. Excel's CF and DV rules cannot hold a structured
/// reference at all ([LIVE] both refused), so there is nothing there to
/// rewrite.
///
/// Gates before any effect: the sheet unprotected, then -- under the held
/// grid and table guards -- the table present on the active sheet.
#[allow(clippy::too_many_arguments)]
pub(crate) fn retire_table_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    slicer_state: &crate::slicer::SlicerState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    table_id: identity::EntityId,
    fate: RetiredTableRefs,
) -> TableResult {
    let label = match fate {
        RetiredTableRefs::ToRange => "Convert to range",
        RetiredTableRefs::ToRefError => "Delete table",
    };
    let active_sheet = *state.active_sheet.read().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = require_table_sheet_unprotected(state, active_sheet) {
        return TableResult::err(&e);
    }
    // CANONICAL LOCK ORDER: `grid`, `grids`, then everything else. The
    // recalculation pass holds both grid locks and then takes `tables` /
    // `table_names`, and it runs on a background thread, so taking them the
    // other way round closes a cycle that hangs the app (see
    // `no_lock_is_held_while_a_grid_lock_is_acquired`). `sheet_names` is
    // cloned BEFORE `tables` (BUG-0045). PENDING across the not-found refusal,
    // so a refused call leaves the document clean.
    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let sheet_names = state.sheet_names.read().unwrap().clone();
    let tables = state.tables.lock_pending().unwrap();
    let table_names = state.table_names.lock_pending().unwrap();
    // Cloned before removal: the rewrite resolves the table's references
    // through the registry, so it must still be there.
    let table = match tables.get(&active_sheet).and_then(|st| st.get(&table_id)) {
        Some(t) => t.clone(),
        None => {
            return if tables.contains_key(&active_sheet) {
                TableResult::err("Table not found")
            } else {
                TableResult::err("No tables on this sheet")
            }
        }
    };
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut tables = tables.authorize(&effect);
    let mut table_names = table_names.authorize(&effect);

    let target_key = table_name_key(&table.name);
    let target_sheet_name = sheet_names.get(table.sheet_index).cloned().unwrap_or_default();
    // The grid mirror is the active sheet's live copy; the per-sheet vector is
    // brought level with it first, so the walk below sees what the user sees.
    if active_sheet < grids.len() {
        grids[active_sheet] = grid.clone();
    }

    // (sheet, row, col) -> the cell as it was, recorded ONCE however many of
    // the steps below touch it.
    let mut before: std::collections::BTreeMap<(usize, u32, u32), Option<engine::Cell>> =
        std::collections::BTreeMap::new();

    // 1. CELLS, on every sheet.
    for sheet_idx in 0..grids.len() {
        let candidates: Vec<(u32, u32)> = grids[sheet_idx]
            .cells
            .iter()
            .filter(|(_, cell)| cell.get_ast().is_some_and(crate::ast_has_table_refs))
            .map(|(&coord, _)| coord)
            .collect();
        for (row, col) in candidates {
            let inside = sheet_idx == table.sheet_index && table.contains(row, col);
            if inside && fate == RetiredTableRefs::ToRefError {
                continue; // cleared below
            }
            let ctx = crate::TableRefContext {
                tables: &tables,
                table_names: &table_names,
                sheet_names: &sheet_names,
                current_sheet_index: sheet_idx,
                current_row: row,
                current_col: col,
            };
            let Some(cell) = grids[sheet_idx].get_cell(row, col) else { continue };
            let Some(ast) = cell.get_ast() else { continue };
            let Some(rewritten) = retire_table_refs_in_ast(ast, &target_key, &target_sheet_name, fate, &ctx, inside) else {
                continue;
            };
            let previous = cell.clone();
            let mut updated = previous.clone();
            updated.ast = Some(Box::new(rewritten));
            before.entry((sheet_idx, row, col)).or_insert(Some(previous));
            grids[sheet_idx].set_cell(row, col, updated.clone());
            if sheet_idx == active_sheet {
                grid.set_cell(row, col, updated);
            }
        }
    }

    // 2. DELETE CLEARS THE TABLE'S CELLS, contents and formats.
    let mut cleared: Vec<(u32, u32)> = Vec::new();
    if fate == RetiredTableRefs::ToRefError && table.sheet_index < grids.len() {
        let stored: Vec<(u32, u32)> = grids[table.sheet_index]
            .cells
            .keys()
            .copied()
            .filter(|&(r, c)| table.contains(r, c))
            .collect();
        for (row, col) in stored {
            let previous = grids[table.sheet_index].get_cell(row, col).cloned();
            before.entry((table.sheet_index, row, col)).or_insert(previous);
            grids[table.sheet_index].clear_cell(row, col);
            if table.sheet_index == active_sheet {
                grid.clear_cell(row, col);
            }
            cleared.push((row, col));
        }
    }

    // 3. OTHER TABLES' STORED FORMULAS (calculated columns, custom totals).
    let mut other_tables_before: Vec<(usize, identity::EntityId, Table)> = Vec::new();
    {
        let ctx = crate::TableRefContext {
            tables: &tables,
            table_names: &table_names,
            sheet_names: &sheet_names,
            current_sheet_index: table.sheet_index,
            current_row: 0,
            current_col: 0,
        };
        let mut rewrites: Vec<(usize, identity::EntityId, usize, Option<String>, Option<String>)> = Vec::new();
        for sheet_tables in tables.values() {
            for t in sheet_tables.values() {
                if t.id == table_id {
                    continue;
                }
                for (i, column) in t.columns.iter().enumerate() {
                    let calc = column
                        .calculated_formula
                        .as_deref()
                        .and_then(|f| retire_table_refs_in_text(f, &target_key, &target_sheet_name, fate, &ctx));
                    let total = column
                        .totals_row_formula
                        .as_deref()
                        .and_then(|f| retire_table_refs_in_text(f, &target_key, &target_sheet_name, fate, &ctx));
                    if calc.is_some() || total.is_some() {
                        rewrites.push((t.sheet_index, t.id, i, calc, total));
                    }
                }
            }
        }
        for (sheet, id, i, calc, total) in rewrites {
            let Some(t) = tables.get_mut(&sheet).and_then(|st| st.get_mut(&id)) else { continue };
            if !other_tables_before.iter().any(|(_, seen, _)| *seen == id) {
                other_tables_before.push((sheet, id, t.clone()));
            }
            if let Some(f) = calc {
                t.columns[i].calculated_formula = Some(f);
            }
            if let Some(f) = total {
                t.columns[i].totals_row_formula = Some(f);
            }
        }
    }

    // 4. DEFINED NAMES. Their rewrite needs the table still registered, so the
    // new texts are decided here, under the table guards, and written after
    // they are released (the name commands read `table_names` while holding
    // `named_ranges`, so nesting the other way round would invert the order).
    let name_rewrites: Vec<(String, String)> = {
        let ctx = crate::TableRefContext {
            tables: &tables,
            table_names: &table_names,
            sheet_names: &sheet_names,
            current_sheet_index: table.sheet_index,
            current_row: 0,
            current_col: 0,
        };
        let names = state.named_ranges.read().unwrap();
        names
            .iter()
            .filter_map(|(key, nr)| {
                retire_table_refs_in_text(&nr.refers_to, &target_key, &target_sheet_name, fate, &ctx)
                    .map(|f| (key.clone(), f))
            })
            .collect()
    };

    // 5. The table leaves the registry.
    if let Some(sheet_tables) = tables.get_mut(&active_sheet) {
        sheet_tables.remove(&table_id);
    }
    table_names.remove(&target_key);

    drop(tables);
    drop(table_names);
    drop(grids);
    drop(grid);

    let names_before: Option<Vec<(String, crate::named_ranges::NamedRange)>> = if name_rewrites.is_empty() {
        None
    } else {
        let mut names = state.named_ranges.write(&effect).unwrap();
        let snapshot: Vec<(String, crate::named_ranges::NamedRange)> =
            names.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (key, refers_to) in name_rewrites {
            if let Some(nr) = names.get_mut(&key) {
                nr.refers_to = refers_to;
            }
        }
        Some(snapshot)
    };

    let removed_filter = clear_table_auto_filter(state, &effect, &table, active_sheet);

    // C10 cleanup: prune any object scripts attached to this table so a
    // retired table leaves no dangling scripts behind (instanceId == the
    // table id). What the prune took -- and only that -- is kept for the
    // undo, BY ID: a whole-list snapshot put back every OTHER script as this
    // step found it.
    let table_id_str = table_id.to_string();
    let pruned_scripts = match state.object_scripts.write(&effect) {
        Ok(mut scripts) => crate::undo_commands::take_object_scripts(&mut scripts, |s| {
            s.object_type == persistence::ScriptableObjectType::Table
                && s.instance_id.as_deref() == Some(table_id_str.as_str())
        }),
        Err(_) => Vec::new(),
    };

    // §3bn: the table is out of its store, so anything BOUND to it is now
    // pointing at nothing. Runs here, before the transaction opens, because it
    // takes the slicer/timeline/filter locks and the undo lock must never be
    // held across a store lock.
    let cascade = crate::object_deps::cascade_deleted_sources(
        state,
        slicer_state,
        timeline_state,
        ribbon_filter_state,
        &effect,
        &[crate::object_deps::DeletedSource::table(table_id)],
    );
    if !cascade.is_empty() {
        crate::log_info!("TABLE", "{} {} cascaded: {}", label, table.name, cascade.describe());
    }

    // ONE undo transaction covering EVERY side effect. Undo replays a
    // transaction's changes in REVERSE record order, so the cells are recorded
    // FIRST and restore LAST -- after the table object exists again, which is
    // what their restored structured references need in order to resolve.
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        let owned_txn = undo_stack.begin_owned_transaction(label.to_string());
        let mut by_sheet: std::collections::BTreeMap<usize, Vec<(u32, u32, Option<engine::Cell>)>> =
            std::collections::BTreeMap::new();
        for ((sheet_idx, row, col), cell) in before {
            by_sheet.entry(sheet_idx).or_default().push((row, col, cell));
        }
        for (sheet_index, cells) in by_sheet {
            undo_stack.record_custom_restore(
                "script_grid_cells".to_string(),
                crate::undo_commands::script_grid_cells_snapshot_bytes(sheet_index, cells),
                "Restore table references",
            );
        }
        for (sheet, id, previous) in other_tables_before {
            undo_stack.record_custom_restore(
                "obj_table".to_string(),
                crate::undo_commands::table_snapshot_bytes(sheet, id, Some(previous)),
                "Restore table references",
            );
        }
        if let Some(previous_names) = names_before {
            undo_stack.record_custom_restore(
                "obj_named_ranges".to_string(),
                crate::undo_commands::named_ranges_snapshot_bytes(previous_names),
                "Restore table references",
            );
        }
        if let Some(previous) = removed_filter {
            undo_stack.record_custom_restore(
                "obj_autofilter".to_string(),
                crate::undo_commands::autofilter_snapshot_bytes(active_sheet, Some(previous)),
                "Restore table filter",
            );
        }
        if !pruned_scripts.is_empty() {
            undo_stack.record_custom_restore(
                crate::undo_commands::OBJECT_SCRIPTS_BY_ID_RESTORE_KIND.to_string(),
                crate::undo_commands::object_scripts_pruned_bytes(pruned_scripts),
                "Restore table scripts",
            );
        }
        // The cascade's restores go in BEFORE the table's, so the reverse
        // replay puts the table back FIRST and the slicers back onto a table
        // that exists. `record_source_cascade_undo` takes this same lock, so
        // it is released across the call -- the transaction stays open
        // either way, which is what makes this one Ctrl+Z.
        drop(undo_stack);
        crate::object_deps::record_source_cascade_undo(state, &cascade);
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.record_custom_restore(
            "obj_table".to_string(),
            crate::undo_commands::table_snapshot_bytes(active_sheet, table_id, Some(table)),
            label,
        );
        undo_stack.commit_owned(owned_txn);
    }

    // PHASE B. Convert froze every reference into the rectangle it named at
    // this instant, so the VALUES do not move -- but the EDGES do: those cells
    // no longer read a table. Delete turned them into `#REF!` and emptied the
    // table's own cells, which every reader of those cells must see now; the
    // cleared cells are seeds for that. A rewritten formula on another sheet
    // recalculates there; a rewritten name's readers through the name.
    recalc_after_table_change(
        state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        &[target_key.clone()],
        &cleared,
    );
    let automatic = state.calculation_mode.lock().map(|m| *m == "automatic").unwrap_or(true);
    if fate == RetiredTableRefs::ToRefError && automatic {
        // `#REF!` is a value change for every rewritten cell, on any sheet,
        // and for every reader of a rewritten name -- and once rewritten none
        // of them names the table any more, so the table seeds above cannot
        // find the off-sheet ones. The whole workbook is the honest seed, the
        // way an undo of the names store treats it.
        crate::commands::data::recalc_after_off_sheet_write(
            state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &(0..sheet_names.len()).collect::<Vec<_>>(),
        );
    }

    TableResult::ok_empty()
}

/// Drop the sheet AutoFilter a table installed for its header row.
///
/// A table with `show_filter_button` creates an AutoFilter on its sheet
/// (`create_table`). Removing the table without removing that filter left a
/// sheet-level filter nobody could see the origin of — with rows still hidden
/// by it and no UI to clear them.
/// Returns the removed filter so the caller can make the removal undoable.
fn clear_table_auto_filter(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    table: &Table,
    sheet_index: usize,
) -> Option<crate::autofilter::AutoFilter> {
    let af_id = table.auto_filter_id?;
    let Ok(mut auto_filters) = state.auto_filters.write(&effect) else {
        return None;
    };
    // Exact ownership: clear the sheet's filter only when it is the very filter
    // this table created. The previous geometry heuristic could not distinguish
    // two filter-bearing tables on one sheet, so deleting either would remove
    // whichever filter happened to be there.
    let matches_table = auto_filters
        .get(&sheet_index)
        .map(|af| af.id == af_id)
        .unwrap_or(false);
    if matches_table {
        return auto_filters.remove(&sheet_index);
    }
    None
}

/// Convert table to range (Excel's `Unlist`): every reference to this table --
/// in any cell, in another table's stored formulas, in a defined name, and
/// only ITS references in a formula that also names another table -- becomes
/// the sheet-qualified absolute rectangle it named, then the table leaves the
/// registry. Cell data and formatting are preserved. See [`retire_table_core`].
///
/// THE TABLE OBJECT IS DESTROYED HERE, so this is a delete as far as every
/// dependent is concerned and it carries the identical cascade to `delete_table`
/// (§3bn): the slicers go, the AutoFilter goes, the object scripts go. Excel
/// agrees — Convert to Range removes the table's slicers.
///
/// It also gained the undo transaction it never had. Before this, Convert to
/// Range recorded NOTHING: it rewrote every dependent formula in the workbook,
/// dropped the AutoFilter and removed the table, and Ctrl+Z did not bring back
/// any of it. That is the same class of half-finished bookkeeping BUG-0006 was
/// on `delete_table`, and it is recorded in the same order for the same reason
/// (cells first so they restore last, onto a table that exists again).
#[tauri::command]
pub fn convert_to_range(
    file_state: State<'_, crate::persistence::FileState>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    timeline_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    table_id: identity::EntityId,
) -> TableResult {
    retire_table_core(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &slicer_state,
        &timeline_state,
        table_id,
        RetiredTableRefs::ToRange,
    )
}

/// Write and evaluate every CALCULATED COLUMN of one table across `rows`.
///
/// EXISTS BECAUSE A NEW ROW USED TO COME UP EMPTY. `set_calculated_column`
/// materialises the column over the data range that exists AT CALL TIME, and it
/// is the only writer of `calculated_formula`. `check_table_auto_expand` and
/// `add_table_row` both advance `end_row` and the AutoFilter and then never
/// re-apply it — so typing a VALUE in the row under a table grew the table and
/// left its calculated columns BLANK in that row, while
/// "fill-to-all-existing-rows" worked. That is the one advantage of an Excel
/// Table that a user notices missing, because Excel fills the new row before
/// they have finished typing.
///
/// ONE RECIPE, THREE CALLERS. The per-row work is not a loop over cells — it is
/// a per-row RE-RESOLUTION of the table reference (`[@Price]` is a different
/// cell on every row), a stored tree that keeps the specifier rather than the
/// flattened coordinates (§2aj), the table's own capitalisation restamped onto
/// it, a style preserved, a display string formatted against the row/column
/// style tiers, and per-row dependency edges. Seventeen lines of that copied
/// into the growth paths would be a second source of truth for all of it.
///
/// The caller owns the guards, in the canonical order, and is responsible for
/// dropping them before Phase B — this function only writes cells and collects
/// seeds.
#[allow(clippy::too_many_arguments)]
fn fill_calculated_columns(
    state: &AppState,
    grid: &mut engine::Grid,
    grids: &mut [engine::Grid],
    tables: &TableStorage,
    table_names: &TableNameRegistry,
    sheet_names: &[String],
    styles: &engine::StyleRegistry,
    locale: &engine::LocaleSettings,
    user_files: &HashMap<String, Vec<u8>>,
    control_values: &std::sync::Arc<crate::control_values::ControlValuesMap>,
    // `table_sheet` is the sheet the TABLE lives on, not necessarily the active
    // one: a script can call `table.addRow()` on a table the user is not looking
    // at, and the formula must resolve and evaluate against ITS sheet.
    // `active_sheet` is the sheet mirrored into `grid`; the write goes to
    // `grids[table_sheet]` always and to `grid` only when the two are the same,
    // because `grid` IS the active sheet's copy.
    table_sheet: usize,
    active_sheet: usize,
    table: &Table,
    rows: &[u32],
    computed: &mut Vec<ComputedCell>,
    seeds: &mut Vec<(u32, u32)>,
) {
    if rows.is_empty() {
        return;
    }
    for (col_idx, column) in table.columns.iter().enumerate() {
        let Some(formula) = column.calculated_formula.clone() else {
            continue;
        };
        if formula.is_empty() {
            continue;
        }
        // A formula that does not parse is stored but not evaluated, the same
        // decision `set_calculated_column` makes: refusing the whole growth
        // because one column's formula is malformed would be worse than a blank
        // cell in it.
        let Ok(parsed) = parser::parse(&formula) else {
            continue;
        };
        let abs_col = table.start_col + col_idx as u32;

        // The form every row STORES: re-spelled from the table's own
        // capitalisation, because the lexer shouts both the table name and the
        // column (§2t for tables).
        let mut stored_ast = parsed.clone();
        crate::table_deps::restamp_table_casing(&mut stored_ast, tables, table_names);

        for &row in rows {
            let resolved = if crate::ast_has_table_refs(&parsed) {
                let ctx = crate::TableRefContext {
                    tables,
                    table_names,
                    sheet_names,
                    current_sheet_index: table_sheet,
                    current_row: row,
                    current_col: abs_col,
                };
                crate::resolve_table_refs_in_ast(&parsed, &ctx)
            } else {
                parsed.clone()
            };

            let engine_ast = crate::convert_expr(&resolved);
            let eval_ctx = engine::EvalContext {
                cube_prefetch: None,
                current_row: Some(row),
                current_col: Some(abs_col),
                row_heights: None,
                column_widths: None,
                hidden_rows: None,
                control_values: Some(control_values.clone()),
            };
            let result = crate::evaluate_formula_raw_with_files(
                grids,
                sheet_names,
                table_sheet,
                &engine_ast,
                eval_ctx,
                Some(styles),
                user_files,
            );

            let mut cell = engine::Cell::new_formula(formula.clone());
            cell.value = result.to_cell_value();
            cell.set_cached_ast(crate::convert_expr(&stored_ast));
            let existing_style = if table_sheet == active_sheet {
                grid.get_cell(row, abs_col).map(|c| c.style_index)
            } else {
                grids.get(table_sheet).and_then(|g| g.get_cell(row, abs_col)).map(|c| c.style_index)
            };
            if let Some(idx) = existing_style {
                cell.style_index = idx;
            }

            let style = styles.get(if table_sheet == active_sheet {
                grid.effective_style_index(row, abs_col)
            } else {
                grids[table_sheet].effective_style_index(row, abs_col)
            });
            let display = crate::format_cell_value(&cell.value, style, locale);
            computed.push(ComputedCell {
                row,
                col: abs_col,
                display,
                formula: Some(formula.clone()),
            });

            if table_sheet < grids.len() {
                grids[table_sheet].set_cell(row, abs_col, cell.clone());
            }
            if table_sheet == active_sheet {
                grid.set_cell(row, abs_col, cell);

                // EDGES ARE ACTIVE-SHEET-SCOPED, like every other cell-level
                // dependency map in this crate (`dependents`,
                // `column_dependents`, ... are keyed by `(row, col)` with no
                // sheet dimension and rebuilt on every sheet switch). A table on
                // another sheet gets its cells and its VALUE; its edges are
                // rebuilt when that sheet is next made active, which is the same
                // contract every off-sheet write in the crate has.
                register_table_formula_dependencies(
                    state,
                    grid,
                    sheet_names,
                    active_sheet,
                    row,
                    abs_col,
                    Some(&resolved),
                    Some(&stored_ast),
                );
                seeds.push((row, abs_col));
            }
        }
    }
}

/// Check if a cell edit should trigger table auto-expansion.
/// Returns Some(table) with updated boundaries if expansion occurred, None otherwise.
///
/// DEPENDENTS RECALCULATE (D3). The column branch WRITES a generated header
/// into the grid, and a header cell is ordinary readable content: `=D1&" total"`
/// beside the table showed the old text until an unrelated edit swept it up.
/// The written header is therefore a seed for the ONE shared cascade.
#[tauri::command]
pub fn check_table_auto_expand(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    row: u32,
    col: u32,
) -> Option<Table> {
    check_table_auto_expand_core(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        row,
        col,
    )
}

/// Record a totals-function change that a TYPED totals cell caused into the
/// cell edit's own undo step (NEW-totals-typing-undo), so one Ctrl+Z puts back
/// the cell and the function together. The edit has already landed by the time
/// the frontend asks `check_table_auto_expand`, so:
///   * a transaction still OPEN (a script batch, a paste) holds the edit --
///     the restore joins it;
///   * otherwise the step on TOP is amended when it is the edit of this very
///     cell (a `SetCell` at `row`/`col` on `sheet`), keeping its id;
///   * otherwise (nothing recorded the edit) the restore is a step of its own.
/// Call holding no store guard (the undo stack is taken here).
fn join_totals_change_to_cell_edit(
    state: &AppState,
    sheet: usize,
    row: u32,
    col: u32,
    table_id: identity::EntityId,
    previous: Table,
) {
    let kind = "obj_table".to_string();
    let data = crate::undo_commands::table_snapshot_bytes(sheet, table_id, Some(previous));
    let Ok(mut undo_stack) = state.undo_stack.lock() else { return };
    if undo_stack.has_open_transaction() {
        undo_stack.record_custom_restore(kind, data, "Edit totals");
        return;
    }
    if let Some(mut top) = undo_stack.pop_undo() {
        let is_this_edit = top.changes.iter().any(|change| {
            matches!(change, engine::undo::CellChange::SetCell { sheet: s, row: r, col: c, .. }
                if *s == sheet && *r == row && *c == col)
        });
        if is_this_edit {
            top.add_change(engine::undo::CellChange::CustomRestore { kind, data });
            // Back where it was, with its id; the redo stack is untouched
            // (the edit already cleared it).
            undo_stack.push_undo_for_redo(top);
            return;
        }
        undo_stack.push_undo_for_redo(top);
    }
    undo_stack.record_custom_restore(kind, data, "Edit totals");
}

/// The body of [`check_table_auto_expand`] over borrowed state, so it is testable
/// without a Tauri `State`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn check_table_auto_expand_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    row: u32,
    col: u32,
) -> Option<Table> {
    let active_sheet = *state.active_sheet.read().unwrap();
    // GET.CONTROLVALUE snapshot, built BEFORE any table/grid lock — the same
    // ordering `set_calculated_column` uses, and for the same reason: building
    // it reads the control stores and the grid.
    let control_values = crate::control_values::build_control_values(
        &state, &pane_control_state, &ribbon_filter_state,
    );
    // A protected sheet's tables never grow: growing is a resize, and [LIVE]
    // Excel 16 refuses `ListObject.Resize` there (a value typed into an
    // unlocked cell under the table stays outside it). No table, no effect.
    if require_table_sheet_unprotected(&state, active_sheet).is_err() {
        return None;
    }
    // CONDITIONAL MUTATION. This is the tail of a cell edit the user just made:
    // `update_cell` has already marked the document dirty, so the token here adds no
    // dirtiness the edit did not already imply -- but the paths below DO rewrite the
    // persisted table, so the write must still be authorised rather than skipped.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    // CANONICAL LOCK ORDER: both grid locks first (see `delete_table`).
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    // `sheet_names` BEFORE `tables` (BUG-0045), which is why it is cloned here
    // rather than taken inside the growth branch below where it is used.
    let expand_sheet_names = state.sheet_names.read().unwrap().clone();
    let mut tables = state.tables.write(&effect).unwrap();

    let sheet_tables = tables.get_mut(&active_sheet)?;

    // A TOTALS CELL WAS TYPED INTO (NEW-totals-constant-none): the column's
    // totals function follows what is now in the cell, as Excel's does
    // (`typed_totals_function`) -- a constant sets it to None, so a later
    // Total Row toggle cannot write the subtotal back over the user's value.
    // The table keeps its size; nothing to recalculate beyond the edit itself.
    let totals_hit = sheet_tables.iter().find_map(|(id, t)| {
        (t.style_options.total_row && row == t.end_row && col >= t.start_col && col <= t.end_col)
            .then(|| (*id, (col - t.start_col) as usize))
    });
    if let Some((id, index)) = totals_hit {
        let table = sheet_tables.get_mut(&id)?;
        let previous = table.clone();
        let table_name = table.name.clone();
        let column = table.columns.get_mut(index)?;
        let (function, formula) = typed_totals_function(&table_name, &column.name, grid.get_cell(row, col));
        if column.totals_row_function == function && column.totals_row_formula == formula {
            return None;
        }
        column.totals_row_function = function;
        column.totals_row_formula = formula;
        let result = table.clone();
        // ONE Ctrl+Z restores the cell AND the function (NEW-totals-typing-undo):
        // the table's previous state joins the cell edit's own undo step. The
        // undo stack is taken only after every store guard is released.
        drop(tables);
        drop(grids);
        drop(grid);
        join_totals_change_to_cell_edit(state, active_sheet, row, col, id, previous);
        return Some(result);
    }

    // Find a table adjacent to this cell
    let table_id = {
        let mut found = None;
        for (id, table) in sheet_tables.iter() {
            // Row expansion: the cell is one row below the TABLE, within its
            // columns -- and only while it has no totals row (NEW-totals-row-
            // autoexpand). [LIVE, Excel 16, 2026-11-05, tablec/probe1.ps1]
            // with a totals row, a value typed into the totals row edits the
            // total and the table keeps its rows, and one typed into the row
            // BELOW the totals row stays outside the table. This asked for
            // `data_end + 1`, which with a totals row IS the totals row, so
            // typing a total grew the table over it.
            if !table.style_options.total_row
                && row == table.end_row + 1
                && col >= table.start_col
                && col <= table.end_col
            {
                found = Some((*id, "row"));
                break;
            }
            // Column expansion: cell is one column right of the table, within row range
            if col == table.end_col + 1
                && row >= table.start_row
                && row <= table.end_row
            {
                found = Some((*id, "col"));
                break;
            }
        }
        found
    };

    let (table_id, expand_type) = table_id?;
    // A table never grows onto a data table (rev-xlsx-1, `overlaps_data_table`):
    // the typed cell stays outside it.
    {
        let t = sheet_tables.get(&table_id)?;
        let (end_row, end_col) = if expand_type == "row" { (t.end_row + 1, t.end_col) } else { (t.end_row, t.end_col + 1) };
        if overlaps_data_table(&grid, t.start_row, t.start_col, end_row, end_col) {
            return None;
        }
    }
    let table = sheet_tables.get_mut(&table_id)?;
    // The header cell the column branch writes, if it writes one.
    let mut seeds: Vec<(u32, u32)> = Vec::new();

    match expand_type {
        "row" => {
            table.end_row += 1;

            // Grow the AutoFilter with the table — but only if the sheet's
            // filter is actually THIS table's. With two filter-bearing tables
            // on a sheet, auto-expanding one would otherwise stretch the
            // other's filter over rows it does not own.
            if table.style_options.show_filter_button {
                let owned = table.auto_filter_id;
                let mut auto_filters = state.auto_filters.write(&effect).unwrap();
                if let Some(af) = auto_filters.get_mut(&active_sheet) {
                    if owned == Some(af.id) {
                        af.end_row = table.filter_end_row();
                    }
                }
            }
        }
        "col" => {
            let new_col_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
            let existing_names: Vec<String> = table.columns.iter().map(|c| c.name.clone()).collect();

            // Try to read the header cell text from the grid for the new column
            let header_text = if table.style_options.header_row {
                grid.get_cell(table.start_row, col)
                    .and_then(|c| match &c.value {
                        engine::CellValue::Text(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
                        engine::CellValue::Number(n) => Some(format!("{}", n)),
                        _ => None,
                    })
                    .unwrap_or_else(|| format!("Column{}", table.columns.len() + 1))
            } else {
                format!("Column{}", table.columns.len() + 1)
            };

            let new_name = ensure_unique_header(&header_text, &existing_names);

            // If the header cell is empty, write the generated column name
            // so it displays with table styling.
            if table.style_options.header_row {
                let needs_header = match grid.get_cell(table.start_row, col) {
                    None => true,
                    Some(c) => matches!(c.value, engine::CellValue::Empty),
                };
                if needs_header {
                    let cell = engine::Cell::new_text(new_name.clone());
                    grid.set_cell(table.start_row, col, cell.clone());
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(table.start_row, col, cell);
                    }
                    seeds.push((table.start_row, col));
                }
            }

            table.columns.push(TableColumn::new(new_col_id, new_name));
            table.end_col += 1;

            // Same ownership rule as the row branch above.
            if table.style_options.show_filter_button {
                let owned = table.auto_filter_id;
                let mut auto_filters = state.auto_filters.write(&effect).unwrap();
                if let Some(af) = auto_filters.get_mut(&active_sheet) {
                    if owned == Some(af.id) {
                        af.end_col = table.end_col;
                    }
                }
            }
        }
        _ => return None,
    }

    let result = table.clone();

    // THE NEW ROW INHERITS THE COLUMN'S FORMULA, which is the advantage of a
    // Table that a user notices missing: Excel fills a calculated column in the
    // row you are still typing in. Only on ROW growth — a new COLUMN has no
    // calculated formula of its own yet, and the existing columns' rows are
    // untouched by it.
    //
    // `table` is borrowed mutably from `tables` above, so the helper is handed
    // the CLONE (`result`) and an immutable view of the storage.
    let mut computed: Vec<ComputedCell> = Vec::new();
    if expand_type == "row" {
        // The cell writers' order: files, style_registry and locale BEFORE the
        // name stores (`table_names` is one), never after.
        let user_files = user_files_state.files.lock().unwrap();
        let styles = state.style_registry.read().unwrap();
        let locale = state.locale.lock().unwrap();
        let table_names = state.table_names.read().unwrap();
        let new_row = result.data_end_row();
        fill_calculated_columns(
            &state,
            &mut grid,
            &mut grids,
            &tables,
            &table_names,
            &expand_sheet_names,
            &styles,
            &locale,
            &user_files,
            &control_values,
            active_sheet,
            active_sheet,
            &result,
            &[new_row],
            &mut computed,
            &mut seeds,
        );
    }

    // PHASE B — after every guard above is released. A generated header is a
    // literal, so it owns no outgoing edges to record; it only needs to be a
    // seed for whatever already reads it.
    //
    // THE TABLE ITSELF JUST GREW, and that is the gesture §2aj is about: typing
    // one row under `Sales` makes `=SUM(Sales[Amount])` cover it, exactly as in
    // Excel. `recalc_after_table_change` rebuilds the readers' cell edges (so
    // the NEXT edit to the new row reaches the total too) and seeds them
    // alongside any header this command wrote.
    drop(grids);
    drop(grid);
    drop(tables);
    recalc_after_table_change(
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &[result.name.clone()],
        &seeds,
    );

    Some(result)
}

/// Validate and enforce header uniqueness after a cell edit on a header row.
/// If the header name was cleared, auto-fills with a placeholder.
/// If the name conflicts with another column, auto-appends a digit.
/// Returns the final (possibly corrected) header name and the updated table.
#[tauri::command]
pub fn enforce_table_header(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    table_id: identity::EntityId,
    column_index: u32,
    new_value: String,
) -> TableResult {
    enforce_table_header_core(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        table_id,
        column_index,
        new_value,
    )
}

/// The body of [`enforce_table_header`] over borrowed state (testable).
#[allow(clippy::too_many_arguments)]
pub(crate) fn enforce_table_header_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    table_id: identity::EntityId,
    column_index: u32,
    new_value: String,
) -> TableResult {
    let active_sheet = *state.active_sheet.read().unwrap();
    // CONDITIONAL MUTATION. This is the tail of a cell edit the user just made:
    // `update_cell` has already marked the document dirty, so the token here adds no
    // dirtiness the edit did not already imply -- but the paths below DO rewrite the
    // persisted table, so the write must still be authorised rather than skipped.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut tables = state.tables.write(&effect).unwrap();

    let sheet_tables = match tables.get_mut(&active_sheet) {
        Some(t) => t,
        None => return TableResult::err("No tables on this sheet"),
    };

    let table = match sheet_tables.get_mut(&table_id) {
        Some(t) => t,
        None => return TableResult::err("Table not found"),
    };

    let col_relative = column_index as usize;
    if col_relative >= table.columns.len() {
        return TableResult::err("Column index out of range");
    }

    // Collect existing names excluding this column
    let existing: Vec<String> = table.columns.iter()
        .enumerate()
        .filter(|(i, _)| *i != col_relative)
        .map(|(_, c)| c.name.clone())
        .collect();

    let final_name = ensure_unique_header(&new_value, &existing);
    let previous_table = table.clone();
    let previous_name = std::mem::replace(&mut table.columns[col_relative].name, final_name.clone());

    let result = table.clone();
    let table_name_upper = table_name_key(&result.name);
    drop(tables);

    // RETYPING A HEADER IS A COLUMN RENAME, and it is the route a user actually
    // takes -- `rename_table_column` is the dialog, this is the grid. Now that a
    // cell KEEPS `Sales[Amount]` (§2aj), a header edit that did not carry its
    // readers over would turn every one of them into `#NAME?`. Excel renames
    // them; so does this, through the same helper the dialog uses.
    if previous_name != final_name {
        // ONE UNDO STEP with the typing that renamed the column (BUG-0742):
        // Excel's Ctrl+Z takes the header text AND the rename back together.
        // The edit was committed as its own step a moment ago; it is reopened
        // here so the rename joins it.
        let header = (active_sheet, result.start_row, result.start_col + column_index);
        let reopened = reopen_header_edit_step(&state, header);
        carry_column_rename(
            &state,
            &effect,
            previous_table,
            &table_name_upper,
            &previous_name,
            &final_name,
            "Rename table column",
        );
        if let Some(token) = reopened {
            state.undo_stack.lock().unwrap().commit_owned(token);
        }
        recalc_after_table_change(
            &state,
            &user_files_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
            &[table_name_upper],
            &[],
        );
    }

    TableResult::ok(result)
}

/// The undo step of the cell edit that typed a table HEADER at `header`
/// (sheet, row, col), reopened as the open transaction so the column rename
/// that follows joins it; `None` when the newest step is not that edit or a
/// step is already open (the rename then joins the open one by itself). A
/// step that is not the edit is put back as it was, id included.
pub(crate) fn reopen_header_edit_step(state: &AppState, header: (usize, u32, u32)) -> Option<engine::undo::OwnedTransaction> {
    let mut undo = state.undo_stack.lock().unwrap();
    if undo.has_open_transaction() {
        return None;
    }
    let top = undo.pop_undo()?;
    let is_the_edit = top.changes.iter().any(|c| {
        matches!(c, engine::undo::CellChange::SetCell { sheet, row, col, .. } if (*sheet, *row, *col) == header)
    });
    if !is_the_edit {
        undo.push_undo_for_redo(top);
        return None;
    }
    let token = undo.begin_owned_transaction(top.description.clone());
    if let Some(open) = undo.current_transaction_mut() {
        open.changes = top.changes;
        open.seq = top.seq;
    }
    Some(token)
}

/// Get a table by ID
#[tauri::command]
pub fn get_table(
    state: State<AppState>,
    table_id: identity::EntityId,
) -> Option<Table> {
    let active_sheet = *state.active_sheet.read().unwrap();
    let tables = state.tables.read().unwrap();

    tables
        .get(&active_sheet)
        .and_then(|sheet_tables| sheet_tables.get(&table_id).cloned())
}

/// Get a table by ID across ALL sheets (not just the active sheet).
/// Used by object scripts, which pin the table by id and may run while a
/// different sheet is active.
#[tauri::command]
pub fn get_table_by_id(
    state: State<AppState>,
    table_id: identity::EntityId,
) -> Option<Table> {
    let tables = state.tables.read().unwrap();
    for sheet_tables in tables.values() {
        if let Some(table) = sheet_tables.get(&table_id) {
            return Some(table.clone());
        }
    }
    None
}

/// Append one data row to a table -- Excel's `ListRows.Add`. The host writes
/// the new row's cells via the cell ops (recalc + undo) and emits the
/// dataChanged event; this command makes the room.
///
/// [LIVE, Excel 16, 2026-11-05, tablec/probe1.ps1 + probe3.ps1] the row is
/// INSERTED: the cells under the table, across its columns only, shift down
/// one row (A7 -> A8; a cell beside the table stays), and with a totals row
/// the totals row moves down with its formulas and the new data row opens
/// above it. This only advanced `end_row`, so with a totals row the old
/// totals row became a data row still holding its SUBTOTALs and the new
/// totals row was empty (NEW-totals-row-overwrite), and without one the row
/// under the table was swallowed into it. On the ACTIVE sheet the room is made
/// by Excel's own Insert Cells (`shift_cells_impl`), which moves the cells,
/// their references, merges and every table in the band; a table on another
/// sheet is grown in place as before, and one with a totals row there is
/// refused (Insert Cells acts on the active sheet only).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn add_table_row(
    file_state: State<'_, crate::persistence::FileState>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    timeline_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    table_id: identity::EntityId,
) -> Result<(), String> {
    add_table_row_core(
        &file_state,
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &slicer_state,
        &timeline_state,
        table_id,
    )
}

/// A table with a totals row on another sheet cannot take a row: the totals
/// row has to move, and Insert Cells acts on the active sheet only.
pub(crate) const ADD_ROW_OFF_SHEET_TOTALS_MESSAGE: &str =
    "Switch to the table's sheet to add a row to a table that has a totals row.";

/// The body of [`add_table_row`] over borrowed state, so it is testable
/// without a Tauri `State`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn add_table_row_core(
    file_state: &crate::persistence::FileState,
    state: &AppState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    slicer_state: &crate::slicer::SlicerState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    table_id: identity::EntityId,
) -> Result<(), String> {
    // GET.CONTROLVALUE snapshot, before any lock (see `set_calculated_column`).
    let control_values = crate::control_values::build_control_values(
        state, pane_control_state, ribbon_filter_state,
    );
    // [LIVE] Excel 16 refuses `ListRows.Add` on a protected sheet -- the
    // TABLE's sheet, which need not be the active one. Read and released
    // before any grid lock (canonical order); the write below finds the table
    // again by id.
    let Some(planned) = state
        .tables
        .read()
        .unwrap()
        .values()
        .find_map(|sheet_tables| sheet_tables.get(&table_id).cloned())
    else {
        return Err("Table not found".to_string());
    };
    require_table_sheet_unprotected(state, planned.sheet_index)?;
    let active_sheet = *state.active_sheet.read().unwrap();
    let on_active = planned.sheet_index == active_sheet;
    if !on_active && planned.style_options.total_row {
        return Err(ADD_ROW_OFF_SHEET_TOTALS_MESSAGE.to_string());
    }

    // ONE undo step for the insert and the growth (the command recorded none:
    // Ctrl+Z left the table a row longer). Joins a caller's open step.
    let owned_txn = {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_owned_transaction("Add table row".to_string())
    };

    // THE ROOM, on the active sheet: Insert Cells over the table's columns,
    // shift down -- at the totals row (inside the table, so Insert Cells grows
    // the table and moves the totals row down) or under the table (outside it,
    // so the growth below takes the new empty row).
    if on_active {
        let at = if planned.style_options.total_row { planned.end_row } else { planned.end_row + 1 };
        let shifted = crate::commands::structure::structure_cells::shift_cells_impl(
            state,
            file_state,
            pivot_state,
            user_files_state,
            pane_control_state,
            ribbon_filter_state,
            slicer_state,
            timeline_state,
            at,
            planned.start_col,
            at,
            planned.end_col,
            crate::commands::structure::structure_cells::CellShift::Down,
            false,
        );
        let refusal = match shifted {
            Err(e) => Some(e),
            Ok(r) if !r.applied => Some(r.confirm.unwrap_or_else(|| "The row could not be inserted.".to_string())),
            Ok(_) => None,
        };
        if let Some(e) = refusal {
            let mut undo_stack = state.undo_stack.lock().unwrap();
            undo_stack.cancel_owned(owned_txn);
            return Err(e);
        }
    }

    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    // The growth, under the guards (released at the end of this block, before
    // the undo stack and Phase B): the table as it was, as it is now, the
    // filter as it was, and the seeds of the filled row. `None` when the table
    // went away meanwhile.
    let grew: Option<(Table, Table, Option<crate::autofilter::AutoFilter>, Vec<(u32, u32)>)> = {
        // CANONICAL LOCK ORDER (both grid locks, then `sheet_names`, then
        // `tables`; BUG-0045).
        let mut grid = state.grid.write(&effect).unwrap();
        let mut grids = state.grids.write(&effect).unwrap();
        let add_sheet_names = state.sheet_names.read().unwrap().clone();
        let mut tables = state.tables.write(&effect).unwrap();
        let mut filter_before: Option<crate::autofilter::AutoFilter> = None;
        let found = match tables.get_mut(&planned.sheet_index).and_then(|st| st.get_mut(&table_id)) {
            None => None,
            Some(table) => {
                let previous = table.clone();
                // A totals row was moved down by the insert, which grew the
                // table; without one the table takes the row the insert opened
                // under it.
                if !planned.style_options.total_row {
                    table.end_row += 1;
                }
                // Keep the AutoFilter range in sync — but only the filter this
                // table owns. Same ownership rule as resize/delete/auto-expand;
                // without it, adding a row to one table stretches whichever
                // filter happens to be on the sheet, including another table's.
                if table.style_options.show_filter_button {
                    let new_end = table.filter_end_row();
                    let owned = table.auto_filter_id;
                    let mut auto_filters = state.auto_filters.write(&effect).unwrap();
                    if let Some(af) = auto_filters.get_mut(&table.sheet_index) {
                        if owned == Some(af.id) && af.end_row != new_end {
                            filter_before = Some(af.clone());
                            af.end_row = new_end;
                        }
                    }
                }
                Some((previous, table.clone()))
            }
        };
        match found {
            None => None,
            Some((previous, grown)) => {
                // THE NEW ROW INHERITS EVERY CALCULATED COLUMN'S FORMULA, the
                // same as when the user types under the table. A script's
                // `table.addRow()` and a typed row must not disagree about
                // whether the column fills.
                let mut computed: Vec<ComputedCell> = Vec::new();
                let mut seeds: Vec<(u32, u32)> = Vec::new();
                let table_names = state.table_names.read().unwrap();
                let user_files = user_files_state.files.lock().unwrap();
                let styles = state.style_registry.read().unwrap();
                let locale = state.locale.lock().unwrap();
                let new_row = grown.data_end_row();
                fill_calculated_columns(
                    state,
                    &mut grid,
                    &mut grids,
                    &tables,
                    &table_names,
                    &add_sheet_names,
                    &styles,
                    &locale,
                    &user_files,
                    &control_values,
                    grown.sheet_index,
                    active_sheet,
                    &grown,
                    &[new_row],
                    &mut computed,
                    &mut seeds,
                );
                Some((previous, grown, filter_before, seeds))
            }
        }
    };

    // Every guard above is released: the step closes, then Phase B.
    let Some((previous, grown, filter_before, seeds)) = grew else {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.commit_owned(owned_txn);
        return Err("Table not found".to_string());
    };
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        if let Some(af) = filter_before {
            undo_stack.record_custom_restore(
                "obj_autofilter".to_string(),
                crate::undo_commands::autofilter_snapshot_bytes(grown.sheet_index, Some(af)),
                "Add table row",
            );
        }
        if !planned.style_options.total_row {
            undo_stack.record_custom_restore(
                "obj_table".to_string(),
                crate::undo_commands::table_snapshot_bytes(grown.sheet_index, table_id, Some(previous)),
                "Add table row",
            );
        }
        undo_stack.commit_owned(owned_txn);
    }
    // PHASE B: one more data row is one more row inside every
    // `Table[Column]` (§2aj), plus whatever the filled cells feed.
    recalc_after_table_change(
        state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        &[grown.name.clone()],
        &seeds,
    );
    Ok(())
}

/// Get a table by name
#[tauri::command]
pub fn get_table_by_name(
    state: State<AppState>,
    name: String,
) -> Option<Table> {
    let tables = state.tables.read().unwrap();
    let table_names = state.table_names.read().unwrap();

    let (sheet_index, table_id) = table_names.get(&table_name_key(&name))?;
    tables
        .get(sheet_index)
        .and_then(|sheet_tables| sheet_tables.get(table_id).cloned())
}

/// Get table at a specific cell
#[tauri::command]
pub fn get_table_at_cell(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Option<Table> {
    let active_sheet = *state.active_sheet.read().unwrap();
    let tables = state.tables.read().unwrap();

    tables.get(&active_sheet).and_then(|sheet_tables| {
        sheet_tables
            .values()
            .find(|t| t.contains(row, col))
            .cloned()
    })
}

/// Get all tables on the current sheet
#[tauri::command]
pub fn get_all_tables(
    state: State<AppState>,
) -> Vec<Table> {
    let active_sheet = *state.active_sheet.read().unwrap();
    let tables = state.tables.read().unwrap();

    tables
        .get(&active_sheet)
        .map(|sheet_tables| sheet_tables.values().cloned().collect())
        .unwrap_or_default()
}

/// Get all tables on a SPECIFIC sheet, regardless of which sheet is active.
///
/// [`get_all_tables`] reads the active sheet only, which is why every consumer
/// that wants a named sheet's tables had to switch sheets first or go without.
/// Results are ordered by name so a caller can render a stable list.
#[tauri::command]
pub fn get_tables_for_sheet(
    state: State<AppState>,
    sheet_index: usize,
) -> Vec<Table> {
    let tables = state.tables.read().unwrap();
    let mut out: Vec<Table> = tables
        .get(&sheet_index)
        .map(|sheet_tables| sheet_tables.values().cloned().collect())
        .unwrap_or_default();
    out.sort_by(|a, b| a.name.to_uppercase().cmp(&b.name.to_uppercase()));
    out
}

/// Every table in the WORKBOOK, across all sheets.
///
/// Each [`Table`] carries its own `sheet_index`, so the flat list is
/// self-describing. Ordered by (sheet, name) for a stable render.
#[tauri::command]
pub fn get_tables_all_sheets(
    state: State<AppState>,
) -> Vec<Table> {
    let tables = state.tables.read().unwrap();
    let mut out: Vec<Table> = tables
        .values()
        .flat_map(|sheet_tables| sheet_tables.values().cloned())
        .collect();
    out.sort_by(|a, b| {
        a.sheet_index
            .cmp(&b.sheet_index)
            .then_with(|| a.name.to_uppercase().cmp(&b.name.to_uppercase()))
    });
    out
}

/// Resolve a structured reference (e.g., "Table1[Column1]")
#[tauri::command]
pub fn resolve_structured_reference(
    state: State<AppState>,
    reference: String,
) -> StructuredRefResult {
    let tables = state.tables.read().unwrap();
    let table_names = state.table_names.read().unwrap();

    // Parse reference: TableName[ColumnName] or TableName[[#Specifier],[Column]]
    let (table_name, specifier) = match parse_structured_ref(&reference) {
        Some(r) => r,
        None => return StructuredRefResult::err("Invalid structured reference syntax"),
    };

    // Find table
    let (sheet_index, table_id) = match table_names.get(&table_name_key(&table_name)) {
        Some(t) => t,
        None => return StructuredRefResult::err("Table not found"),
    };

    let table = match tables.get(sheet_index).and_then(|t| t.get(table_id)) {
        Some(t) => t,
        None => return StructuredRefResult::err("Table not found"),
    };

    // Resolve specifier
    match resolve_specifier(table, &specifier) {
        Some(resolved) => StructuredRefResult::ok(resolved),
        None => StructuredRefResult::err("Invalid column or specifier"),
    }
}

/// Set a calculated column formula that auto-fills to all data rows.
/// When a user enters a formula in one data cell of a table column,
/// this propagates it to all other data rows in that column.
/// The formula is parsed, table references resolved per-row, evaluated,
/// and the computed value is written to each data cell.
///
/// DEPENDENTS RECALCULATE (D3). This evaluates every cell it writes, but it
/// evaluated NOTHING downstream of them: `=SUM(Table1[Margin])` beside a table
/// whose Margin column had just been (re)defined kept its previous total. Each
/// written cell is a seed for the ONE shared cascade, and each now records its
/// own edges so a later edit to the columns it reads re-derives it.
#[tauri::command]
pub fn set_calculated_column(
    file_state: State<'_, crate::persistence::FileState>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    table_id: identity::EntityId,
    column_name: String,
    formula: String,
) -> TableResult {
    // A calculated column fills every row of the table with an evaluated
    // formula and PERSISTS the results — Interactive ceiling, and cancellable
    // because a calculated column over a large table is one of the longer
    // single operations in the product.
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Interactive,
        &state.calc_cancel,
    );
    // GET.CONTROLVALUE snapshot: built BEFORE the table/grid locks below.
    let control_values = crate::control_values::build_control_values(
        &state, &pane_control_state, &ribbon_filter_state,
    );
    let active_sheet = *state.active_sheet.read().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = require_table_sheet_unprotected(&state, active_sheet) {
        return TableResult::err(&e);
    }
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    // CANONICAL LOCK ORDER: both grid locks first (see `delete_table`). They are
    // used only inside the `if !formula.is_empty()` block below, where they used
    // to be taken while `tables` was still held -- the inverted order. Hoisting
    // them here costs an unconditional acquisition of two locks this command was
    // going to take in every case that does any work.
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    // `sheet_names` BEFORE `tables`, for the same reason and by the same rule:
    // it too was taken inside the block below with `tables` alive (BUG-0045).
    let calc_sheet_names = state.sheet_names.read().unwrap().clone();
    let mut tables = state.tables.write(&effect).unwrap();

    let table = match tables.get_mut(&active_sheet).and_then(|t| t.get_mut(&table_id)) {
        Some(t) => t,
        None => return TableResult::err("Table not found"),
    };

    // Find the column
    let col_idx = match table.get_column_index(&column_name) {
        Some(idx) => idx,
        None => return TableResult::err("Column not found"),
    };

    // Store the formula on the column definition
    table.columns[col_idx].calculated_formula = if formula.is_empty() {
        None
    } else {
        Some(formula.clone())
    };

    let table_clone = table.clone();

    let mut computed: Vec<ComputedCell> = Vec::new();
    let mut seeds: Vec<(u32, u32)> = Vec::new();

    if !formula.is_empty() {
        // `calc_sheet_names` and both grid guards were acquired at the top of
        // the function -- see the lock-order note there.
        let table_names = state.table_names.read().unwrap();
        let user_files = user_files_state.files.lock().unwrap();
        let styles = state.style_registry.read().unwrap();
        let locale = state.locale.lock().unwrap();

        // ONE RECIPE, shared with the two GROWTH paths. This loop used to live
        // here inline, which is why a table that grew came up BLANK in its
        // calculated columns: the growth paths had no way to run it without
        // copying seventeen lines of per-row resolution, restamping, styling and
        // edge registration. See `fill_calculated_columns`.
        let rows: Vec<u32> =
            (table_clone.data_start_row()..=table_clone.data_end_row()).collect();
        fill_calculated_columns(
            &state,
            &mut grid,
            &mut grids,
            &tables,
            &table_names,
            &calc_sheet_names,
            &styles,
            &locale,
            &user_files,
            &control_values,
            active_sheet,
            active_sheet,
            &table_clone,
            &rows,
            &mut computed,
            &mut seeds,
        );
    }

    // PHASE B — after every guard above is released. The user-files guard is
    // scoped to the block above; `tables` and BOTH GRID GUARDS are not, so they
    // are dropped here. The grid guards are function-scoped because the
    // canonical lock order needs them taken before `tables` (see the note at the
    // top); dropping them here is not tidiness but a REQUIREMENT --
    // `recalc_after_active_sheet_bulk_rewrite` takes both itself, and
    // `Persisted<T>` is a `std::sync::Mutex`, which is not re-entrant. Holding
    // them across this call self-deadlocks the calling thread, and if that
    // thread is the main one the whole window stops answering.
    drop(tables);
    drop(grids);
    drop(grid);
    let mut recalculated = Vec::new();
    crate::commands::data::recalc_after_active_sheet_bulk_rewrite(
        &state,
        &user_files_state,
        &pane_control_state,
        &ribbon_filter_state,
        &seeds,
        &mut recalculated,
    );

    TableResult {
        success: true,
        table: Some(table_clone),
        error: None,
        computed_cells: if computed.is_empty() { None } else { Some(computed) },
    }
}

/// Convert cell references in a formula to structured table references.
/// When a user enters a formula in a table data cell, same-row cell references
/// that fall within the table's column range are converted to [@ColumnName] syntax.
/// E.g., "=B2+C2" in row 2 of a table with columns B="Price", C="Qty" becomes
/// "=[@Price]+[@Qty]".
#[tauri::command]
pub fn convert_formula_to_table_refs(
    state: State<AppState>,
    table_id: identity::EntityId,
    formula: String,
    formula_row: u32,
) -> String {
    let active_sheet = *state.active_sheet.read().unwrap();
    let tables = state.tables.read().unwrap();

    let table = match tables
        .get(&active_sheet)
        .and_then(|st| st.get(&table_id))
    {
        Some(t) => t,
        None => return formula,
    };

    // Only convert if the formula row is within the table data area
    let data_start = table.data_start_row();
    let data_end = table.data_end_row();
    if formula_row < data_start || formula_row > data_end {
        return formula;
    }

    // Parse the formula
    let parsed = match parser::parse(&formula) {
        Ok(ast) => ast,
        Err(_) => return formula,
    };

    // Recursively replace cell references that point to the same row and are
    // within the table column range with [@ColumnName] references.
    let converted = convert_cell_refs_to_table_refs(&parsed, table, formula_row);

    // Serialize back to formula string
    format!("={}", crate::expression_to_formula(&converted))
}

/// Convert column letters (e.g., "A", "B", "AA") to 0-based column index.
fn col_letters_to_index(col: &str) -> u32 {
    let mut result: u32 = 0;
    for c in col.chars() {
        result = result * 26 + (c.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
    }
    result.saturating_sub(1)
}

/// Recursively walk the AST and replace matching CellRef nodes with TableRef nodes.
fn convert_cell_refs_to_table_refs(
    expr: &parser::Expression,
    table: &Table,
    formula_row: u32,
) -> parser::Expression {
    use parser::Expression;
    use parser::ast::TableSpecifier;

    match expr {
        Expression::CellRef { sheet, col, row, .. } => {
            // Only convert same-sheet references (no sheet prefix) on the same row
            if sheet.is_none() && *row == formula_row + 1 {
                let col_idx = col_letters_to_index(col);
                if col_idx >= table.start_col && col_idx <= table.end_col {
                    let relative = (col_idx - table.start_col) as usize;
                    if relative < table.columns.len() {
                        let col_name = &table.columns[relative].name;
                        return Expression::TableRef {
                            table_name: String::new(), // Empty = inferred from context
                            specifier: TableSpecifier::ThisRow(col_name.clone()),
                            ref_site_id: Default::default(),
                        };
                    }
                }
            }
            expr.clone()
        }
        Expression::BinaryOp { op, left, right } => {
            Expression::BinaryOp {
                op: op.clone(),
                left: Box::new(convert_cell_refs_to_table_refs(left, table, formula_row)),
                right: Box::new(convert_cell_refs_to_table_refs(right, table, formula_row)),
            }
        }
        Expression::UnaryOp { op, operand } => {
            Expression::UnaryOp {
                op: op.clone(),
                operand: Box::new(convert_cell_refs_to_table_refs(operand, table, formula_row)),
            }
        }
        Expression::FunctionCall { func, args, .. } => {
            Expression::FunctionCall {
                func: func.clone(),
                args: args.iter().map(|a| convert_cell_refs_to_table_refs(a, table, formula_row)).collect(),
                ref_site_id: Default::default(),
            }
        }
        // Leave everything else unchanged (Literal, Range, TableRef, etc.)
        _ => expr.clone(),
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Check if two ranges overlap
fn ranges_overlap(
    r1_start_row: u32, r1_start_col: u32, r1_end_row: u32, r1_end_col: u32,
    r2_start_row: u32, r2_start_col: u32, r2_end_row: u32, r2_end_col: u32,
) -> bool {
    let r1_min_row = r1_start_row.min(r1_end_row);
    let r1_max_row = r1_start_row.max(r1_end_row);
    let r1_min_col = r1_start_col.min(r1_end_col);
    let r1_max_col = r1_start_col.max(r1_end_col);

    let r2_min_row = r2_start_row.min(r2_end_row);
    let r2_max_row = r2_start_row.max(r2_end_row);
    let r2_min_col = r2_start_col.min(r2_end_col);
    let r2_max_col = r2_start_col.max(r2_end_col);

    r1_min_row <= r2_max_row
        && r1_max_row >= r2_min_row
        && r1_min_col <= r2_max_col
        && r1_max_col >= r2_min_col
}

/// Parse a structured reference string
///
/// A BARE TABLE NAME IS A REFERENCE. `Table1` on its own means the table's DATA
/// BODY in Excel -- `Table1[#Data]` -- which is why `=ROWS(Table1)` and
/// `=COLUMNS(Table1)` are the first two structured-reference examples anyone
/// meets. Requiring the '[' made both of them "Invalid structured reference
/// syntax" here, so it is expanded to the specifier it stands for rather than
/// given a second resolution path of its own.
///
/// `Table1[]` IS THE SAME REFERENCE (NEW-parse-structured-ref-empty): the
/// formula parser reads the empty brackets as the whole table, the data body
/// (`TableSpecifier::Whole`) -- [LIVE, Excel 16, lane formd / namese]
/// `=ROWS(Tbl[])` is 3 for a 3-row table and shows `=ROWS(Tbl)` -- so the
/// two readers of one reference agree. This used to answer "Invalid column or
/// specifier" for the empty brackets.
fn parse_structured_ref(reference: &str) -> Option<(String, String)> {
    let trimmed = reference.trim();

    // Format: TableName[Specifier]
    let Some(bracket_start) = trimmed.find('[') else {
        return is_valid_table_name(trimmed)
            .then(|| (trimmed.to_string(), "#Data".to_string()));
    };
    let bracket_end = trimmed.rfind(']')?;

    if bracket_end <= bracket_start {
        return None;
    }

    let table_name = trimmed[..bracket_start].trim().to_string();
    let specifier = trimmed[bracket_start + 1..bracket_end].trim().to_string();

    if table_name.is_empty() {
        return None;
    }

    if specifier.is_empty() {
        return Some((table_name, "#Data".to_string()));
    }

    Some((table_name, specifier))
}

/// Resolve a structured reference specifier
fn resolve_specifier(table: &Table, specifier: &str) -> Option<ResolvedStructuredRef> {
    let spec = specifier.trim();

    // Handle special specifiers
    if spec.starts_with('#') || spec.starts_with("[#") {
        // Parse [#All], [#Data], [#Headers], [#Totals], [#This Row]
        let special = if spec.starts_with("[#") {
            &spec[2..spec.len() - 1]
        } else {
            &spec[1..]
        };

        match special.to_lowercase().as_str() {
            "all" => {
                return Some(ResolvedStructuredRef {
                    sheet_index: table.sheet_index,
                    start_row: table.start_row,
                    start_col: table.start_col,
                    end_row: table.end_row,
                    end_col: table.end_col,
                });
            }
            "data" => {
                return Some(ResolvedStructuredRef {
                    sheet_index: table.sheet_index,
                    start_row: table.data_start_row(),
                    start_col: table.start_col,
                    end_row: table.data_end_row(),
                    end_col: table.end_col,
                });
            }
            "headers" => {
                if !table.style_options.header_row {
                    return None;
                }
                return Some(ResolvedStructuredRef {
                    sheet_index: table.sheet_index,
                    start_row: table.start_row,
                    start_col: table.start_col,
                    end_row: table.start_row,
                    end_col: table.end_col,
                });
            }
            "totals" => {
                if !table.style_options.total_row {
                    return None;
                }
                return Some(ResolvedStructuredRef {
                    sheet_index: table.sheet_index,
                    start_row: table.end_row,
                    start_col: table.start_col,
                    end_row: table.end_row,
                    end_col: table.end_col,
                });
            }
            _ => return None,
        }
    }

    // Column reference
    let col_idx = table.get_column_index(spec)?;
    let col = table.start_col + col_idx as u32;

    Some(ResolvedStructuredRef {
        sheet_index: table.sheet_index,
        start_row: table.data_start_row(),
        start_col: col,
        end_row: table.data_end_row(),
        end_col: col,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_id() -> identity::EntityId {
        identity::EntityId::from_bytes(identity::generate_uuid_v7())
    }

    #[test]
    fn test_totals_row_function_default() {
        assert_eq!(TotalsRowFunction::default(), TotalsRowFunction::None);
    }

    /// EVERY PATH THAT GROWS A TABLE BY A ROW MUST FILL ITS CALCULATED COLUMNS.
    ///
    /// This is a source-level guard, in the shape of
    /// `every_cell_writing_function_either_recalculates_or_is_exempt_with_a_reason`,
    /// and it exists because the defect it protects against is exactly a path
    /// that FORGETS. `set_calculated_column` materialises the column over the
    /// data range that exists at call time and is the only writer of
    /// `calculated_formula`; `check_table_auto_expand` and `add_table_row` each
    /// advanced `end_row` and the AutoFilter and never re-applied it, so typing
    /// a value under a table left the calculated column BLANK in the new row
    /// while fill-to-all-existing-rows worked. Nothing failed; the cell was just
    /// empty.
    ///
    /// A fourth growth path added later would reintroduce it silently, which is
    /// what this asserts against. Counting is crude, and it is the only check
    /// that fails when somebody adds one.
    #[test]
    fn every_row_growth_path_fills_the_calculated_columns() {
        // BOUNDED AT `#[cfg(test)]`, or the guard counts its own string
        // literals: this test names `fill_calculated_columns` three times, which
        // would satisfy every assertion below without a line of product code.
        let whole = include_str!("tables.rs");
        let src = &whole[..whole
            .find("#[cfg(test)]")
            .expect("this file has a test module")];

        // The functions that advance `end_row` by one data row.
        for grower in ["pub fn check_table_auto_expand", "pub fn add_table_row"] {
            let start = src
                .find(grower)
                .unwrap_or_else(|| panic!("`{}` has been renamed; update this guard", grower));
            // Bound the search at the next top-level `pub fn`, so a call in a
            // LATER function cannot satisfy an earlier one.
            let rest = &src[start + grower.len()..];
            let end = rest.find("\npub fn ").unwrap_or(rest.len());
            let body = &rest[..end];
            assert!(
                body.contains("fill_calculated_columns("),
                "`{}` grows a table by a row and does not fill its calculated \
                 columns. Excel fills the new row while the user is still typing \
                 in it; a growth path that skips this leaves the column blank in \
                 that row with no error. Call `fill_calculated_columns` (it owns \
                 the whole per-row recipe -- resolution, restamping, style, \
                 display and edges) or state here why this path needs no fill.",
                grower
            );
        }

        // ...and the recipe itself must exist in exactly ONE place. Three
        // callers, one definition.
        assert_eq!(
            src.matches("fn fill_calculated_columns(").count(),
            1,
            "there must be exactly one `fill_calculated_columns`; a second \
             definition is a second source of truth for the per-row recipe, \
             which is what this refactor removed"
        );
        // One definition, three call sites: the two growers above and
        // `set_calculated_column`.
        assert_eq!(
            src.matches("fill_calculated_columns(").count(),
            4,
            "expected one definition and three call sites (the two row-growth \
             paths and set_calculated_column); if a fourth caller is legitimate, \
             raise this and say what it is"
        );
    }

    // --- Rename: dependent structured references must follow the table ---

    fn rename_formula(formula: &str, old_upper: &str, new_name: &str) -> Option<String> {
        let ast = parser::parse(formula).ok()?;
        let (renamed, changed) = crate::rename_table_refs_in_ast(&ast, old_upper, new_name);
        if !changed {
            return None;
        }
        Some(format!("={}", crate::expression_to_formula(&renamed)))
    }

    #[test]
    fn rename_rewrites_refs_to_the_renamed_table() {
        let out = rename_formula("=SUM(Sales[Amount])", "SALES", "Revenue")
            .expect("the ref should have been rewritten");
        assert!(out.to_uppercase().contains("REVENUE["), "{}", out);
        assert!(!out.to_uppercase().contains("SALES["), "{}", out);
    }

    #[test]
    fn rename_leaves_other_tables_alone() {
        let out = rename_formula("=SUM(Sales[Amount])+SUM(Costs[Amount])", "SALES", "Revenue")
            .expect("changed");
        let upper = out.to_uppercase();
        assert!(upper.contains("REVENUE["), "{}", out);
        // The untouched table keeps its STRUCTURED form — the rename must not
        // flatten it to a range the way convert-to-range would.
        assert!(upper.contains("COSTS["), "{}", out);
    }

    #[test]
    fn rename_is_case_insensitive_on_the_old_name() {
        assert!(rename_formula("=SUM(sAlEs[Amount])", "SALES", "Revenue").is_some());
    }

    #[test]
    fn rename_ignores_unrelated_tables_and_reports_no_change() {
        assert!(
            rename_formula("=SUM(Costs[Amount])", "SALES", "Revenue").is_none(),
            "a formula naming no matching table must report unchanged"
        );
    }

    #[test]
    fn rename_does_not_touch_bare_this_row_refs() {
        // `[@Col]` carries no table name; it resolves via the containing table,
        // which a rename does not move.
        assert!(rename_formula("=[@Price]*2", "SALES", "Revenue").is_none());
    }

    #[test]
    fn rename_does_not_touch_string_literals() {
        // The prefilter is text-based, so a literal mentioning the name reaches
        // the walker — which must leave it alone and report no change.
        assert!(
            rename_formula("=\"Sales[Amount]\"", "SALES", "Revenue").is_none(),
            "a string literal is not a reference"
        );
    }

    // --- Resize: columns re-align by ABSOLUTE position ---

    /// Mirrors the column re-alignment in `resize_table` so the mapping can be
    /// tested without standing up a full AppState.
    fn realign(
        old_start_col: u32,
        old_names: &[&str],
        min_col: u32,
        max_col: u32,
    ) -> Vec<String> {
        let old_columns: Vec<TableColumn> = old_names
            .iter()
            .map(|n| TableColumn::new(test_id(), n.to_string()))
            .collect();
        let carried: Vec<Option<TableColumn>> = (min_col..=max_col)
            .map(|abs_col| {
                if abs_col >= old_start_col {
                    old_columns.get((abs_col - old_start_col) as usize).cloned()
                } else {
                    None
                }
            })
            .collect();
        let mut used: std::collections::HashSet<String> = carried
            .iter()
            .flatten()
            .map(|c| c.name.to_uppercase())
            .collect();
        let mut rebuilt: Vec<String> = Vec::new();
        for slot in carried {
            match slot {
                Some(existing) => rebuilt.push(existing.name),
                None => {
                    let mut n = rebuilt.len() + 1;
                    let mut name = format!("Column{}", n);
                    while used.contains(&name.to_uppercase()) {
                        n += 1;
                        name = format!("Column{}", n);
                    }
                    used.insert(name.to_uppercase());
                    rebuilt.push(name);
                }
            }
        }
        rebuilt
    }

    #[test]
    fn resize_growing_left_keeps_existing_columns_on_their_own_cells() {
        // C:E [X,Y,Z] widened to A:E. The tail-append logic used to produce
        // [X,Y,Z,Column4,Column5] — silently moving X onto column A.
        let cols = realign(2, &["X", "Y", "Z"], 0, 4);
        assert_eq!(cols, vec!["Column1", "Column2", "X", "Y", "Z"]);
    }

    #[test]
    fn resize_growing_right_appends() {
        let cols = realign(0, &["X", "Y"], 0, 3);
        assert_eq!(cols, vec!["X", "Y", "Column3", "Column4"]);
    }

    #[test]
    fn resize_shrinking_from_the_left_drops_the_left_columns() {
        let cols = realign(0, &["X", "Y", "Z"], 1, 2);
        assert_eq!(cols, vec!["Y", "Z"]);
    }

    // --- AutoFilter ownership is an exact id match ---

    #[test]
    fn autofilter_ids_are_unique_per_filter() {
        let a = crate::autofilter::AutoFilter::new(0, 0, 10, 3);
        let b = crate::autofilter::AutoFilter::new(0, 0, 10, 3);
        assert_ne!(a.id, b.id, "each filter needs its own identity");
    }

    #[test]
    fn only_the_owning_table_matches_the_sheet_filter() {
        // Two filter-bearing tables on one sheet; storage holds ONE filter.
        // Before ids, both claimed it (auto_filter_id == sheet index) and either
        // could move or delete the other's.
        let af = crate::autofilter::AutoFilter::new(0, 0, 10, 3);
        let owner_link = Some(af.id);
        let other_link = Some(crate::autofilter::AutoFilter::new(20, 0, 30, 3).id);

        assert_eq!(owner_link, Some(af.id));
        assert_ne!(other_link, Some(af.id));
    }

    #[test]
    fn autofilter_id_survives_serde_roundtrip() {
        // The id lives in autofilters.json; losing it on load would silently
        // orphan every table link.
        let af = crate::autofilter::AutoFilter::new(1, 2, 9, 5);
        let json = serde_json::to_string(&af).unwrap();
        let back: crate::autofilter::AutoFilter = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, af.id);
    }

    #[test]
    fn autofilter_without_an_id_field_gets_one_on_load() {
        // Workbooks saved before the field existed must still deserialize.
        // AutoFilter is `rename_all = "camelCase"` over the wire and on disk.
        let json = r#"{
            "startRow": 0, "startCol": 0, "endRow": 5, "endCol": 2,
            "columnFilters": {}, "enabled": true
        }"#;
        let af: crate::autofilter::AutoFilter =
            serde_json::from_str(json).expect("legacy filter must load");
        assert_eq!(af.end_row, 5);
        // A fresh id is minted; the table re-link reconstructs the association.
        let again: crate::autofilter::AutoFilter = serde_json::from_str(json).unwrap();
        assert_ne!(af.id, again.id);
    }

    // --- Resize: AutoFilter criteria re-key with a moved start_col ---

    /// The `column_filters` re-key `resize_table` runs (`AutoFilter::rekey_columns`
    /// with every column staying put). Keys are RELATIVE to the filter's
    /// start_col, so a moved origin must re-key them or every criterion
    /// silently filters a different physical column.
    fn remap_filter_keys(
        old_start: u32,
        keys: &[u32],
        new_start: u32,
        new_end: u32,
    ) -> Vec<u32> {
        let mut af = crate::autofilter::AutoFilter::new(0, old_start, 5, old_start + 20);
        for &rel in keys {
            af.column_filters.insert(
                rel,
                crate::autofilter::ColumnFilter { column_index: rel, criteria: Default::default() },
            );
        }
        af.start_col = new_start;
        af.end_col = new_end;
        af.rekey_columns(old_start, Some);
        af.column_keys().0
    }

    #[test]
    fn resize_rekeys_filter_criteria_when_origin_moves_left() {
        // Filter at col 2 with criteria on relative 0 and 1 (abs 2 and 3).
        // Table widens to start at col 0, so those become relative 2 and 3.
        assert_eq!(remap_filter_keys(2, &[0, 1], 0, 4), vec![2, 3]);
    }

    #[test]
    fn resize_rekeys_filter_criteria_when_origin_moves_right() {
        // Filter at col 0, criteria on abs 1 and 2; table now starts at 1.
        assert_eq!(remap_filter_keys(0, &[1, 2], 1, 3), vec![0, 1]);
    }

    #[test]
    fn resize_drops_criteria_for_columns_that_left_the_table() {
        // abs 0 and 5; new range is cols 1..=3, so both fall outside.
        assert!(remap_filter_keys(0, &[0, 5], 1, 3).is_empty());
        // abs 2 survives, abs 9 does not.
        assert_eq!(remap_filter_keys(0, &[2, 9], 0, 4), vec![2]);
    }

    #[test]
    fn resize_generated_names_do_not_collide_with_carried_ones() {
        // A carried column literally called "Column1" must not be duplicated.
        let cols = realign(1, &["Column1"], 0, 1);
        assert_eq!(cols, vec!["Column2", "Column1"]);
    }

    #[test]
    fn test_table_style_options_default() {
        let options = TableStyleOptions::default();
        assert!(options.banded_rows);
        assert!(!options.banded_columns);
        assert!(options.header_row);
        assert!(!options.total_row);
        assert!(options.show_filter_button);
    }

    #[test]
    fn test_table_column_new() {
        let id = test_id();
        let col = TableColumn::new(id, "Sales".to_string());
        assert_eq!(col.id, id);
        assert_eq!(col.name, "Sales");
        assert_eq!(col.totals_row_function, TotalsRowFunction::None);
    }

    #[test]
    fn test_table_contains() {
        let table = Table {
            id: test_id(),
            name: "Table1".to_string(),
            sheet_index: 0,
            start_row: 5,
            start_col: 2,
            end_row: 10,
            end_col: 5,
            columns: vec![],
            style_options: TableStyleOptions::default(),
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        };

        assert!(table.contains(5, 2));
        assert!(table.contains(7, 3));
        assert!(table.contains(10, 5));
        assert!(!table.contains(4, 2));
        assert!(!table.contains(5, 1));
    }

    #[test]
    fn test_table_data_rows() {
        let table = Table {
            id: test_id(),
            name: "Table1".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 10,
            end_col: 5,
            columns: vec![],
            style_options: TableStyleOptions {
                header_row: true,
                total_row: true,
                ..Default::default()
            },
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        };

        assert_eq!(table.data_start_row(), 1);
        assert_eq!(table.data_end_row(), 9);
        assert_eq!(table.row_count(), 9);
    }

    #[test]
    fn test_parse_structured_ref() {
        let result = parse_structured_ref("Table1[Column1]");
        assert!(result.is_some());
        let (table, spec) = result.unwrap();
        assert_eq!(table, "Table1");
        assert_eq!(spec, "Column1");

        let result2 = parse_structured_ref("  Sales  [  Amount  ]  ");
        assert!(result2.is_some());
        let (table2, spec2) = result2.unwrap();
        assert_eq!(table2, "Sales");
        assert_eq!(spec2, "Amount");
    }

    /// A BARE TABLE NAME RESOLVES TO THE DATA BODY.
    ///
    /// `Table1` with no bracket is Excel's `Table1[#Data]` -- the rows without
    /// the header and without the totals row -- and it is what makes
    /// `=ROWS(Table1)` and `=COLUMNS(Table1)` mean anything. The '[' was
    /// mandatory, so the whole reference was rejected as "Invalid structured
    /// reference syntax".
    #[test]
    fn a_bare_table_name_means_the_data_body() {
        let (name, spec) = parse_structured_ref("Table1").expect("a bare table name is a reference");
        assert_eq!(name, "Table1");
        assert_eq!(spec, "#Data", "a bare name must expand to the data-body specifier");

        let table = Table {
            id: test_id(),
            name: "Table1".to_string(),
            sheet_index: 0,
            start_row: 2,
            start_col: 1,
            end_row: 8,
            end_col: 3,
            columns: vec![
                TableColumn::new(test_id(), "Name".to_string()),
                TableColumn::new(test_id(), "Amount".to_string()),
                TableColumn::new(test_id(), "Total".to_string()),
            ],
            style_options: TableStyleOptions {
                header_row: true,
                total_row: true,
                ..Default::default()
            },
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        };

        let resolved = resolve_specifier(&table, &spec).expect("#Data resolves");
        assert_eq!(resolved.start_row, table.data_start_row(), "header row leaked in");
        assert_eq!(resolved.end_row, table.data_end_row(), "totals row leaked in");
        assert_eq!(resolved.start_col, table.start_col);
        assert_eq!(resolved.end_col, table.end_col);

        // `Table1[]` (and `Table1[ ]`) IS the whole table, as the formula
        // parser reads it (NEW-parse-structured-ref-empty; [LIVE] Excel 16:
        // `=ROWS(Tbl[])` 3). This pinned the opposite -- an error -- until the
        // two readers were aligned.
        for empty in ["Table1[]", "Table1[ ]"] {
            let (name, empty_spec) = parse_structured_ref(empty).expect("the whole table parses");
            assert_eq!(name, "Table1", "{}", empty);
            assert_eq!(empty_spec, "#Data", "{}: the empty brackets are the data body", empty);
            let resolved = resolve_specifier(&table, &empty_spec).expect("the whole table resolves");
            assert_eq!(
                (resolved.start_row, resolved.end_row, resolved.start_col, resolved.end_col),
                (table.data_start_row(), table.data_end_row(), table.start_col, table.end_col),
                "{}",
                empty
            );
        }
    }

    /// The bare-name arm must not turn `parse_structured_ref` into a function
    /// that accepts anything. It is reached only when there is no '[' at all,
    /// and only for text that could be a table name.
    #[test]
    fn a_bracketless_non_name_is_still_rejected() {
        assert!(parse_structured_ref("").is_none());
        assert!(parse_structured_ref("   ").is_none());
        assert!(parse_structured_ref("1Table").is_none(), "not a legal table name");
        assert!(parse_structured_ref("Two Words").is_none(), "not a legal table name");
    }

    #[test]
    fn test_is_valid_table_name() {
        assert!(is_valid_table_name("Table1"));
        assert!(is_valid_table_name("_MyTable"));
        assert!(is_valid_table_name("Sales_2023"));
        assert!(!is_valid_table_name(""));
        assert!(!is_valid_table_name("123Table"));
        assert!(!is_valid_table_name("Table Name"));
        // rev-xlsx-4: the defined-name rule -- R1C1-shaped and cell-shaped
        // names are refused (Excel refused a file holding such a table).
        // SABOTAGE (tablefix-tname): `is_valid_table_name` back to its own
        // character check.
        for refused in ["R", "C", "rc", "Q1", "XFD1048576", "R1C1", "TRUE"] {
            assert!(!is_valid_table_name(refused), "{} must be refused as a table name", refused);
        }
        assert!(is_valid_table_name("Q1x") && is_valid_table_name("Sales.2024"));
    }

    #[test]
    fn test_ranges_overlap() {
        // Overlapping
        assert!(ranges_overlap(0, 0, 5, 5, 3, 3, 8, 8));
        // Contained
        assert!(ranges_overlap(0, 0, 10, 10, 2, 2, 5, 5));
        // Adjacent (no overlap)
        assert!(!ranges_overlap(0, 0, 5, 5, 6, 0, 10, 5));
        // Separate
        assert!(!ranges_overlap(0, 0, 2, 2, 10, 10, 15, 15));
    }

    #[test]
    fn test_table_get_column_by_name() {
        let table = Table {
            id: test_id(),
            name: "Table1".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 10,
            end_col: 2,
            columns: vec![
                TableColumn::new(test_id(), "Name".to_string()),
                TableColumn::new(test_id(), "Amount".to_string()),
                TableColumn::new(test_id(), "Total".to_string()),
            ],
            style_options: TableStyleOptions::default(),
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        };

        assert!(table.get_column_by_name("Name").is_some());
        assert!(table.get_column_by_name("name").is_some()); // Case insensitive
        assert!(table.get_column_by_name("AMOUNT").is_some());
        assert!(table.get_column_by_name("Missing").is_none());
    }

    /// NEW-table-totals-count-swap: the totals row's SUBTOTAL numbers are
    /// Excel's ([LIVE] probe1.ps1, `TotalsCalculation` 1..8): Count is 103
    /// (COUNTA), Count Numbers 102 (COUNT), and the rest as listed.
    /// SABOTAGE (tablefix-swap): Count and Count Numbers swapped back.
    #[test]
    fn totals_functions_use_excels_subtotal_numbers() {
        let code = |f: TotalsRowFunction| build_subtotal_formula(&f, "T", "C").unwrap();
        for (f, n) in [
            (TotalsRowFunction::Sum, 109),
            (TotalsRowFunction::Average, 101),
            (TotalsRowFunction::Count, 103),
            (TotalsRowFunction::CountNumbers, 102),
            (TotalsRowFunction::Min, 105),
            (TotalsRowFunction::Max, 104),
            (TotalsRowFunction::StdDev, 107),
            (TotalsRowFunction::Var, 110),
        ] {
            assert_eq!(code(f), format!("=SUBTOTAL({},T[C])", n), "{:?}", f);
        }
        assert_eq!(build_subtotal_formula(&TotalsRowFunction::None, "T", "C"), None);
    }

    /// NEW-table-filter-seed-totals: a table's AutoFilter stops above its
    /// totals row ([LIVE] `<autoFilter ref="B2:D5"/>` for a table on B2:D6),
    /// at every place a table sets its filter's last row -- resize,
    /// auto-expand, add-row, and the filter seeded on load (persistence.rs).
    /// SABOTAGE (tablefix-seed): the load seed back to `seed.end_row`.
    #[test]
    fn a_tables_filter_never_covers_its_totals_row() {
        let mut table = Table {
            id: test_id(),
            name: "T".to_string(),
            sheet_index: 0,
            start_row: 1,
            start_col: 1,
            end_row: 5,
            end_col: 3,
            columns: vec![],
            style_options: TableStyleOptions { total_row: true, ..Default::default() },
            style_name: String::new(),
            auto_filter_id: None,
        };
        assert_eq!(table.filter_end_row(), 4);
        table.style_options.total_row = false;
        assert_eq!(table.filter_end_row(), 5);

        let bounded = |whole: &'static str| &whole[..whole.find("#[cfg(test)]").unwrap_or(whole.len())];
        let tables_src = bounded(include_str!("tables.rs"));
        let setters: Vec<&str> = tables_src.lines().filter(|l| l.contains("af.end_row =")).collect();
        assert!(setters.len() >= 3, "the census lost the filter setters: {:?}", setters);
        for line in setters {
            // `new_end` is add_table_row's `table.filter_end_row()`, pinned below.
            assert!(
                line.contains("filter_end_row()") || line.trim() == "af.end_row = new_end;",
                "a table sets its filter's last row past the data: {}",
                line.trim()
            );
        }
        assert!(tables_src.contains("let new_end = table.filter_end_row();"), "add_table_row's filter end moved");
        // persistence.rs has test items near its top, so it is read whole; the
        // anchor is the seed's own call, which no test there spells.
        let persistence = include_str!("persistence.rs");
        let seed_at = persistence
            .find("crate::autofilter::AutoFilter::new(\n                            seed.start_row,")
            .expect("the load-time filter seed moved; update this census");
        let seed = &persistence[seed_at..seed_at + 300];
        assert!(seed.contains("seed.filter_end_row()"), "the load-time seed covers the totals row: {}", seed);
    }
}

#[cfg(test)]
#[path = "tables_protection_tests.rs"]
mod protection_tests;

#[cfg(test)]
#[path = "tables_tablec_tests.rs"]
mod tablec_tests;

#[cfg(test)]
#[path = "tables_cfdv_tests.rs"]
mod cfdv_tests;

#[cfg(test)]
#[path = "tables_cfeval_tests.rs"]
mod cfeval_tests;
