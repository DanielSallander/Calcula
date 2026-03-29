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
    pub id: u32,
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
}

impl TableColumn {
    pub fn new(id: u32, name: String) -> Self {
        Self {
            id,
            name,
            totals_row_function: TotalsRowFunction::None,
            totals_row_formula: None,
            calculated_formula: None,
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
    pub id: u64,
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
    pub auto_filter_id: Option<u64>,
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
pub type TableStorage = HashMap<usize, HashMap<u64, Table>>;

/// Name registry: table_name (uppercase) -> (sheet_index, table_id)
pub type TableNameRegistry = HashMap<String, (usize, u64)>;

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
    pub table_id: u64,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// Parameters for updating table style
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTableStyleParams {
    pub table_id: u64,
    #[serde(default)]
    pub style_options: Option<TableStyleOptions>,
    #[serde(default)]
    pub style_name: Option<String>,
}

/// Parameters for setting totals row function
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTotalsRowFunctionParams {
    pub table_id: u64,
    pub column_name: String,
    pub function: TotalsRowFunction,
    #[serde(default)]
    pub custom_formula: Option<String>,
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Generate a unique table name
fn generate_table_name(existing_names: &TableNameRegistry) -> String {
    let mut i = 1;
    loop {
        let name = format!("Table{}", i);
        if !existing_names.contains_key(&name.to_uppercase()) {
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
fn build_subtotal_formula(
    function: &TotalsRowFunction,
    table_name: &str,
    column_name: &str,
) -> Option<String> {
    let code = match function {
        TotalsRowFunction::None => return None,
        TotalsRowFunction::Average => 101,
        TotalsRowFunction::Count => 102,
        TotalsRowFunction::CountNumbers => 103,
        TotalsRowFunction::Max => 104,
        TotalsRowFunction::Min => 105,
        TotalsRowFunction::Sum => 109,
        TotalsRowFunction::StdDev => 107,
        TotalsRowFunction::Var => 110,
        TotalsRowFunction::Custom => return None, // Custom uses custom_formula directly
    };

    // For now, use A1-style range references until structured references are in the formula engine.
    // The formula text stores the structured reference for display purposes.
    Some(format!("=SUBTOTAL({},{}[{}])", code, table_name, column_name))
}

/// Validate table name
fn is_valid_table_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 255 {
        return false;
    }

    let first = name.chars().next().unwrap();
    if !first.is_alphabetic() && first != '_' && first != '\\' {
        return false;
    }

    // Table names cannot contain certain characters
    for c in name.chars() {
        if !c.is_alphanumeric() && c != '_' && c != '.' {
            return false;
        }
    }

    true
}

// ============================================================================
// COMMANDS
// ============================================================================

/// Create a new table
#[tauri::command]
pub fn create_table(
    state: State<AppState>,
    params: CreateTableParams,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();
    let mut table_names = state.table_names.lock().unwrap();
    let mut next_id = state.next_table_id.lock().unwrap();

    // Validate or generate name
    let name = if params.name.is_empty() {
        generate_table_name(&table_names)
    } else if !is_valid_table_name(&params.name) {
        return TableResult::err("Invalid table name");
    } else if table_names.contains_key(&params.name.to_uppercase()) {
        return TableResult::err("Table name already exists");
    } else {
        params.name
    };

    // Normalize range
    let min_row = params.start_row.min(params.end_row);
    let max_row = params.start_row.max(params.end_row);
    let min_col = params.start_col.min(params.end_col);
    let max_col = params.start_col.max(params.end_col);

    // Check for overlapping tables
    if let Some(sheet_tables) = tables.get(&active_sheet) {
        for existing in sheet_tables.values() {
            if ranges_overlap(
                min_row, min_col, max_row, max_col,
                existing.start_row, existing.start_col, existing.end_row, existing.end_col,
            ) {
                return TableResult::err("Table overlaps with existing table");
            }
        }
    }

    // Read header text from grid cells (or generate generic names)
    let grid = state.grid.lock().unwrap();
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
        .enumerate()
        .map(|(i, name)| TableColumn::new(i as u32, name))
        .collect();
    drop(grid);

    // Create style options
    let style_options = params.style_options.unwrap_or(TableStyleOptions {
        header_row: params.has_headers,
        ..Default::default()
    });

    // Create table
    let mut table = Table {
        id: *next_id,
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

    *next_id += 1;

    // Create an AutoFilter for the table range if show_filter_button is enabled
    if table.style_options.show_filter_button {
        let mut auto_filters = state.auto_filters.lock().unwrap();
        let auto_filter = AutoFilter::new(min_row, min_col, max_row, max_col);
        auto_filters.insert(active_sheet, auto_filter);
        // Store a reference ID (using the sheet index as the AutoFilter is per-sheet)
        table.auto_filter_id = Some(active_sheet as u64);
    }

    // Store table
    table_names.insert(name.to_uppercase(), (active_sheet, table.id));
    tables
        .entry(active_sheet)
        .or_insert_with(HashMap::new)
        .insert(table.id, table.clone());

    TableResult::ok(table)
}

/// Delete a table
#[tauri::command]
pub fn delete_table(
    state: State<AppState>,
    table_id: u64,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();
    let mut table_names = state.table_names.lock().unwrap();

    let sheet_tables = match tables.get_mut(&active_sheet) {
        Some(t) => t,
        None => return TableResult::err("No tables on this sheet"),
    };

    let table = match sheet_tables.remove(&table_id) {
        Some(t) => t,
        None => return TableResult::err("Table not found"),
    };

    // Remove from name registry
    table_names.remove(&table.name.to_uppercase());

    TableResult::ok_empty()
}

/// Rename a table
#[tauri::command]
pub fn rename_table(
    state: State<AppState>,
    table_id: u64,
    new_name: String,
) -> TableResult {
    if !is_valid_table_name(&new_name) {
        return TableResult::err("Invalid table name");
    }

    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();
    let mut table_names = state.table_names.lock().unwrap();

    // Check if new name already exists
    let upper_new = new_name.to_uppercase();
    if let Some(&(sheet, id)) = table_names.get(&upper_new) {
        if sheet != active_sheet || id != table_id {
            return TableResult::err("Table name already exists");
        }
    }

    let sheet_tables = match tables.get_mut(&active_sheet) {
        Some(t) => t,
        None => return TableResult::err("No tables on this sheet"),
    };

    let table = match sheet_tables.get_mut(&table_id) {
        Some(t) => t,
        None => return TableResult::err("Table not found"),
    };

    // Remove old name, add new name
    table_names.remove(&table.name.to_uppercase());
    table_names.insert(upper_new, (active_sheet, table_id));
    table.name = new_name;

    TableResult::ok(table.clone())
}

/// Update table style options
#[tauri::command]
pub fn update_table_style(
    state: State<AppState>,
    params: UpdateTableStyleParams,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();

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
    state: State<AppState>,
    table_id: u64,
    column_name: String,
    position: Option<usize>,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();

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
    let new_id = table.columns.iter().map(|c| c.id).max().unwrap_or(0) + 1;
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

    TableResult::ok(table.clone())
}

/// Remove a column from a table
#[tauri::command]
pub fn remove_table_column(
    state: State<AppState>,
    table_id: u64,
    column_name: String,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();

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

    TableResult::ok(table.clone())
}

/// Rename a table column
#[tauri::command]
pub fn rename_table_column(
    state: State<AppState>,
    table_id: u64,
    old_name: String,
    new_name: String,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();

    let sheet_tables = match tables.get_mut(&active_sheet) {
        Some(t) => t,
        None => return TableResult::err("No tables on this sheet"),
    };

    let table = match sheet_tables.get_mut(&table_id) {
        Some(t) => t,
        None => return TableResult::err("Table not found"),
    };

    let idx = match table.get_column_index(&old_name) {
        Some(i) => i,
        None => return TableResult::err("Column not found"),
    };

    // Collect existing names excluding the column being renamed
    let existing: Vec<String> = table.columns.iter()
        .enumerate()
        .filter(|(i, _)| *i != idx)
        .map(|(_, c)| c.name.clone())
        .collect();

    // Enforce non-empty and uniqueness
    let final_name = ensure_unique_header(&new_name, &existing);
    table.columns[idx].name = final_name;

    TableResult::ok(table.clone())
}

/// Set totals row function for a column.
/// Also writes the corresponding SUBTOTAL formula into the totals row cell.
#[tauri::command]
pub fn set_totals_row_function(
    state: State<AppState>,
    params: SetTotalsRowFunctionParams,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();

    let sheet_tables = match tables.get_mut(&active_sheet) {
        Some(t) => t,
        None => return TableResult::err("No tables on this sheet"),
    };

    let table = match sheet_tables.get_mut(&params.table_id) {
        Some(t) => t,
        None => return TableResult::err("Table not found"),
    };

    let idx = match table.get_column_index(&params.column_name) {
        Some(i) => i,
        None => return TableResult::err("Column not found"),
    };

    table.columns[idx].totals_row_function = params.function.clone();
    table.columns[idx].totals_row_formula = params.custom_formula.clone();

    // Write formula into the totals row cell (if totals row is visible)
    if table.style_options.total_row {
        let totals_row = table.end_row;
        let cell_col = table.start_col + idx as u32;
        let table_name = table.name.clone();
        let col_name = table.columns[idx].name.clone();

        let formula = if params.function == TotalsRowFunction::Custom {
            params.custom_formula.clone()
        } else {
            build_subtotal_formula(&params.function, &table_name, &col_name)
        };

        match formula {
            Some(formula_str) => {
                let cell = engine::Cell::new_formula(formula_str);
                grid.set_cell(totals_row, cell_col, cell.clone());
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(totals_row, cell_col, cell);
                }
            }
            None => {
                // Function is "None" - clear the cell
                grid.clear_cell(totals_row, cell_col);
                if active_sheet < grids.len() {
                    grids[active_sheet].clear_cell(totals_row, cell_col);
                }
            }
        }
    }

    TableResult::ok(table.clone())
}

/// Toggle totals row visibility.
/// When enabling, expands the table and writes SUBTOTAL formulas into the totals row cells.
/// When disabling, clears the totals row cells and shrinks the table.
#[tauri::command]
pub fn toggle_totals_row(
    state: State<AppState>,
    table_id: u64,
    show: bool,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();

    let sheet_tables = match tables.get_mut(&active_sheet) {
        Some(t) => t,
        None => return TableResult::err("No tables on this sheet"),
    };

    let table = match sheet_tables.get_mut(&table_id) {
        Some(t) => t,
        None => return TableResult::err("Table not found"),
    };

    let was_shown = table.style_options.total_row;

    if show && !was_shown {
        // Adding totals row - expand range
        table.end_row += 1;
        table.style_options.total_row = true;

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
                    let cell = engine::Cell::new_formula(formula_str);
                    grid.set_cell(totals_row, cell_col, cell.clone());
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(totals_row, cell_col, cell);
                    }
                }
            }
        }
    } else if !show && was_shown {
        // Removing totals row - clear cells first, then shrink range
        let totals_row = table.end_row;
        for i in 0..table.columns.len() {
            let cell_col = table.start_col + i as u32;
            grid.clear_cell(totals_row, cell_col);
            if active_sheet < grids.len() {
                grids[active_sheet].clear_cell(totals_row, cell_col);
            }
        }
        table.end_row -= 1;
        table.style_options.total_row = false;
    }

    TableResult::ok(table.clone())
}

/// Resize a table
#[tauri::command]
pub fn resize_table(
    state: State<AppState>,
    params: ResizeTableParams,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();

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

    let min_row = params.start_row.min(params.end_row);
    let max_row = params.start_row.max(params.end_row);
    let min_col = params.start_col.min(params.end_col);
    let max_col = params.start_col.max(params.end_col);

    let new_col_count = (max_col - min_col + 1) as usize;
    let old_col_count = table.columns.len();

    // Adjust columns if needed
    if new_col_count > old_col_count {
        // Add columns
        for i in old_col_count..new_col_count {
            let new_id = table.columns.iter().map(|c| c.id).max().unwrap_or(0) + 1;
            table.columns.push(TableColumn::new(new_id, format!("Column{}", i + 1)));
        }
    } else if new_col_count < old_col_count {
        // Remove columns from end
        table.columns.truncate(new_col_count);
    }

    table.start_row = min_row;
    table.start_col = min_col;
    table.end_row = max_row;
    table.end_col = max_col;

    TableResult::ok(table.clone())
}

/// Convert table to range: rewrite all structured references that mention this
/// table into absolute A1 references, then remove the table from the registry.
/// Cell data and formatting are preserved.
#[tauri::command]
pub fn convert_to_range(
    state: State<AppState>,
    table_id: u64,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();
    let mut table_names = state.table_names.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();

    // Find the table
    let table = match tables
        .get(&active_sheet)
        .and_then(|st| st.get(&table_id))
    {
        Some(t) => t.clone(),
        None => return TableResult::err("Table not found"),
    };

    let table_name_upper = table.name.to_uppercase();

    // Scan ALL cells in ALL sheets for formulas that reference this table.
    // We check the formula text for the table name (case-insensitive) as a
    // fast filter before parsing.
    for (sheet_idx, sheet_grid) in grids.iter_mut().enumerate() {
        // Collect cells that need formula rewriting
        let formula_cells: Vec<(u32, u32, String)> = sheet_grid
            .cells
            .iter()
            .filter_map(|(&(row, col), cell)| {
                cell.formula.as_ref().and_then(|f| {
                    let f_upper = f.to_uppercase();
                    // Check if formula mentions the table name or uses standalone @ refs
                    if f_upper.contains(&table_name_upper) || f_upper.contains("[@") {
                        Some((row, col, f.clone()))
                    } else {
                        None
                    }
                })
            })
            .collect();

        for (row, col, formula_str) in formula_cells {
            // Parse the formula
            let parsed = match parser::parse(&formula_str) {
                Ok(ast) => ast,
                Err(_) => continue, // Can't parse — leave as-is
            };

            // Check if the AST actually contains table refs
            if !crate::ast_has_table_refs(&parsed) {
                continue;
            }

            // Build a context for resolution — using the formula cell's row
            let ctx = crate::TableRefContext {
                tables: &tables,
                table_names: &table_names,
                current_sheet_index: sheet_idx,
                current_row: row,
            };

            // Resolve table refs → CellRef/Range nodes
            let resolved = crate::resolve_table_refs_in_ast(&parsed, &ctx);

            // Serialize back to formula string
            let new_formula = format!("={}", crate::expression_to_formula(&resolved));

            // Update the cell's formula (keep existing value/style)
            if let Some(cell) = sheet_grid.get_cell(row, col) {
                let mut updated = cell.clone();
                updated.formula = Some(new_formula.clone());
                sheet_grid.set_cell(row, col, updated.clone());

                // Also update the primary grid if this is the active sheet
                if sheet_idx == active_sheet {
                    grid.set_cell(row, col, updated);
                }
            }
        }
    }

    // Remove the table from the registry
    if let Some(sheet_tables) = tables.get_mut(&active_sheet) {
        sheet_tables.remove(&table_id);
    }
    table_names.remove(&table_name_upper);

    TableResult::ok_empty()
}

/// Check if a cell edit should trigger table auto-expansion.
/// Returns Some(table) with updated boundaries if expansion occurred, None otherwise.
#[tauri::command]
pub fn check_table_auto_expand(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Option<Table> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();

    let sheet_tables = tables.get_mut(&active_sheet)?;

    // Find a table adjacent to this cell
    let table_id = {
        let mut found = None;
        for (id, table) in sheet_tables.iter() {
            let data_end = table.data_end_row();
            // Row expansion: cell is one row below the data area, within column range
            if row == data_end + 1
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
    let table = sheet_tables.get_mut(&table_id)?;

    match expand_type {
        "row" => {
            table.end_row += 1;

            // Update AutoFilter range if the table has filters
            if table.style_options.show_filter_button {
                let mut auto_filters = state.auto_filters.lock().unwrap();
                if let Some(af) = auto_filters.get_mut(&active_sheet) {
                    af.end_row = table.end_row;
                }
            }
        }
        "col" => {
            let new_col_id = table.columns.iter().map(|c| c.id).max().unwrap_or(0) + 1;
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
                }
            }

            table.columns.push(TableColumn::new(new_col_id, new_name));
            table.end_col += 1;

            // Update AutoFilter range if the table has filters
            if table.style_options.show_filter_button {
                let mut auto_filters = state.auto_filters.lock().unwrap();
                if let Some(af) = auto_filters.get_mut(&active_sheet) {
                    af.end_col = table.end_col;
                }
            }
        }
        _ => return None,
    }

    Some(table.clone())
}

/// Validate and enforce header uniqueness after a cell edit on a header row.
/// If the header name was cleared, auto-fills with a placeholder.
/// If the name conflicts with another column, auto-appends a digit.
/// Returns the final (possibly corrected) header name and the updated table.
#[tauri::command]
pub fn enforce_table_header(
    state: State<AppState>,
    table_id: u64,
    column_index: u32,
    new_value: String,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();

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
    table.columns[col_relative].name = final_name;

    TableResult::ok(table.clone())
}

/// Get a table by ID
#[tauri::command]
pub fn get_table(
    state: State<AppState>,
    table_id: u64,
) -> Option<Table> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let tables = state.tables.lock().unwrap();

    tables
        .get(&active_sheet)
        .and_then(|sheet_tables| sheet_tables.get(&table_id).cloned())
}

/// Get a table by name
#[tauri::command]
pub fn get_table_by_name(
    state: State<AppState>,
    name: String,
) -> Option<Table> {
    let tables = state.tables.lock().unwrap();
    let table_names = state.table_names.lock().unwrap();

    let (sheet_index, table_id) = table_names.get(&name.to_uppercase())?;
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
    let active_sheet = *state.active_sheet.lock().unwrap();
    let tables = state.tables.lock().unwrap();

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
    let active_sheet = *state.active_sheet.lock().unwrap();
    let tables = state.tables.lock().unwrap();

    tables
        .get(&active_sheet)
        .map(|sheet_tables| sheet_tables.values().cloned().collect())
        .unwrap_or_default()
}

/// Resolve a structured reference (e.g., "Table1[Column1]")
#[tauri::command]
pub fn resolve_structured_reference(
    state: State<AppState>,
    reference: String,
) -> StructuredRefResult {
    let tables = state.tables.lock().unwrap();
    let table_names = state.table_names.lock().unwrap();

    // Parse reference: TableName[ColumnName] or TableName[[#Specifier],[Column]]
    let (table_name, specifier) = match parse_structured_ref(&reference) {
        Some(r) => r,
        None => return StructuredRefResult::err("Invalid structured reference syntax"),
    };

    // Find table
    let (sheet_index, table_id) = match table_names.get(&table_name.to_uppercase()) {
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
#[tauri::command]
pub fn set_calculated_column(
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    table_id: u64,
    column_name: String,
    formula: String,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();

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

    let abs_col = table.start_col + col_idx as u32;
    let data_start = table.data_start_row();
    let data_end = table.data_end_row();
    let table_clone = table.clone();

    // Write formulas to all data rows and evaluate them
    let mut computed = Vec::new();

    if !formula.is_empty() {
        // Parse the formula once
        let parsed = match parser::parse(&formula) {
            Ok(ast) => ast,
            Err(_) => {
                // If formula doesn't parse, still store it but skip evaluation
                return TableResult::ok(table_clone);
            }
        };

        let mut grid = state.grid.lock().unwrap();
        let mut grids = state.grids.lock().unwrap();
        let sheet_names = state.sheet_names.lock().unwrap();
        let table_names = state.table_names.lock().unwrap();
        let user_files = user_files_state.files.lock().unwrap();
        let styles = state.style_registry.lock().unwrap();

        for row in data_start..=data_end {
            // Resolve table references for this specific row
            let resolved = if crate::ast_has_table_refs(&parsed) {
                let ctx = crate::TableRefContext {
                    tables: &tables,
                    table_names: &table_names,
                    current_sheet_index: active_sheet,
                    current_row: row,
                };
                crate::resolve_table_refs_in_ast(&parsed, &ctx)
            } else {
                parsed.clone()
            };

            // Convert to engine AST and evaluate
            let engine_ast = crate::convert_expr(&resolved);
            let eval_ctx = engine::EvalContext {
                current_row: Some(row),
                current_col: Some(abs_col),
                row_heights: None,
                column_widths: None,
                hidden_rows: None,
            };
            let result = crate::evaluate_formula_raw_with_files(
                &grids,
                &sheet_names,
                active_sheet,
                &engine_ast,
                eval_ctx,
                Some(&styles),
                &user_files,
            );

            // Create cell with formula and evaluated value
            let mut cell = engine::Cell::new_formula(formula.clone());
            cell.value = result.to_cell_value();
            cell.set_cached_ast(engine_ast);

            // Preserve existing style
            if let Some(existing) = grid.get_cell(row, abs_col) {
                cell.style_index = existing.style_index;
            }

            // Format display value for frontend
            let style = styles.get(cell.style_index);
            let display = crate::format_cell_value(&cell.value, style);

            computed.push(ComputedCell {
                row,
                col: abs_col,
                display,
                formula: Some(formula.clone()),
            });

            grid.set_cell(row, abs_col, cell.clone());
            if active_sheet < grids.len() {
                grids[active_sheet].set_cell(row, abs_col, cell);
            }
        }
    }

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
    table_id: u64,
    formula: String,
    formula_row: u32,
) -> String {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let tables = state.tables.lock().unwrap();

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
        Expression::CellRef { sheet, col, row, col_absolute: _, row_absolute: _ } => {
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
        Expression::FunctionCall { func, args } => {
            Expression::FunctionCall {
                func: func.clone(),
                args: args.iter().map(|a| convert_cell_refs_to_table_refs(a, table, formula_row)).collect(),
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
fn parse_structured_ref(reference: &str) -> Option<(String, String)> {
    let trimmed = reference.trim();

    // Format: TableName[Specifier]
    let bracket_start = trimmed.find('[')?;
    let bracket_end = trimmed.rfind(']')?;

    if bracket_end <= bracket_start {
        return None;
    }

    let table_name = trimmed[..bracket_start].trim().to_string();
    let specifier = trimmed[bracket_start + 1..bracket_end].trim().to_string();

    if table_name.is_empty() {
        return None;
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

    #[test]
    fn test_totals_row_function_default() {
        assert_eq!(TotalsRowFunction::default(), TotalsRowFunction::None);
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
        let col = TableColumn::new(1, "Sales".to_string());
        assert_eq!(col.id, 1);
        assert_eq!(col.name, "Sales");
        assert_eq!(col.totals_row_function, TotalsRowFunction::None);
    }

    #[test]
    fn test_table_contains() {
        let table = Table {
            id: 1,
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
            id: 1,
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

    #[test]
    fn test_is_valid_table_name() {
        assert!(is_valid_table_name("Table1"));
        assert!(is_valid_table_name("_MyTable"));
        assert!(is_valid_table_name("Sales_2023"));
        assert!(!is_valid_table_name(""));
        assert!(!is_valid_table_name("123Table"));
        assert!(!is_valid_table_name("Table Name"));
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
            id: 1,
            name: "Table1".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 10,
            end_col: 2,
            columns: vec![
                TableColumn::new(0, "Name".to_string()),
                TableColumn::new(1, "Amount".to_string()),
                TableColumn::new(2, "Total".to_string()),
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
}
