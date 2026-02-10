//! FILENAME: app/src-tauri/src/tables.rs
//! PURPOSE: Backend storage and management for Excel-style tables (structured references).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

use crate::AppState;

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

/// Result of a table operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<Table>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TableResult {
    pub fn ok(table: Table) -> Self {
        Self {
            success: true,
            table: Some(table),
            error: None,
        }
    }

    pub fn ok_empty() -> Self {
        Self {
            success: true,
            table: None,
            error: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            success: false,
            table: None,
            error: Some(message.into()),
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

    // Create columns from range
    let col_count = (max_col - min_col + 1) as usize;
    let columns: Vec<TableColumn> = (0..col_count)
        .map(|i| {
            let name = if params.has_headers {
                // In a real implementation, we'd read header from grid
                format!("Column{}", i + 1)
            } else {
                format!("Column{}", i + 1)
            };
            TableColumn::new(i as u32, name)
        })
        .collect();

    // Create style options
    let style_options = params.style_options.unwrap_or(TableStyleOptions {
        header_row: params.has_headers,
        ..Default::default()
    });

    // Create table
    let table = Table {
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

    // Check for duplicate name
    if table.get_column_by_name(&new_name).is_some() {
        return TableResult::err("Column name already exists");
    }

    let idx = match table.get_column_index(&old_name) {
        Some(i) => i,
        None => return TableResult::err("Column not found"),
    };

    table.columns[idx].name = new_name;

    TableResult::ok(table.clone())
}

/// Set totals row function for a column
#[tauri::command]
pub fn set_totals_row_function(
    state: State<AppState>,
    params: SetTotalsRowFunctionParams,
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

    let idx = match table.get_column_index(&params.column_name) {
        Some(i) => i,
        None => return TableResult::err("Column not found"),
    };

    table.columns[idx].totals_row_function = params.function;
    table.columns[idx].totals_row_formula = params.custom_formula;

    TableResult::ok(table.clone())
}

/// Toggle totals row visibility
#[tauri::command]
pub fn toggle_totals_row(
    state: State<AppState>,
    table_id: u64,
    show: bool,
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

    let was_shown = table.style_options.total_row;

    if show && !was_shown {
        // Adding totals row - expand range
        table.end_row += 1;
    } else if !show && was_shown {
        // Removing totals row - shrink range
        table.end_row -= 1;
    }

    table.style_options.total_row = show;

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

/// Convert table to range (delete table but keep data)
#[tauri::command]
pub fn convert_to_range(
    state: State<AppState>,
    table_id: u64,
) -> TableResult {
    // Same as delete_table but conceptually different
    delete_table(state, table_id)
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
