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
}

impl TableColumn {
    pub fn new(id: identity::EntityId, name: String) -> Self {
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

/// Name registry: table_name (uppercase) -> (sheet_index, table_id)
pub type TableNameRegistry = HashMap<String, (usize, identity::EntityId)>;

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
/// name — so refuse the collision instead of creating the ambiguity.
fn name_collides_with_defined_name(state: &AppState, name: &str) -> bool {
    state
        .named_ranges
        .lock()
        .map(|names| names.contains_key(&name.to_uppercase()))
        .unwrap_or(false)
}

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

    // Validate or generate name
    let name = if params.name.is_empty() {
        generate_table_name(&table_names)
    } else if !is_valid_table_name(&params.name) {
        return TableResult::err("Invalid table name");
    } else if table_names.contains_key(&params.name.to_uppercase()) {
        return TableResult::err("Table name already exists");
    } else if name_collides_with_defined_name(&state, &params.name) {
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
        let mut auto_filters = state.auto_filters.lock().unwrap();
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
    table_names.insert(name.to_uppercase(), (active_sheet, table.id));
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

    TableResult::ok(table)
}

/// Delete a table.
///
/// The table OBJECT goes away; the cells stay. So every dependent formula is
/// rewritten from `Table1[Amount]` to the equivalent absolute range first —
/// exactly as `convert_to_range` does — and the AutoFilter the table installed
/// is removed. Previously neither happened: structured references were left as
/// `_UNRESOLVED` NamedRef sentinels the evaluator rejects, and a sheet-level
/// AutoFilter survived with no visible owner and rows still hidden by it.
#[tauri::command]
pub fn delete_table(
    state: State<AppState>,
    table_id: identity::EntityId,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = crate::protection::require_sheet_unprotected(&state, active_sheet, "the table") {
        return TableResult::err(&e);
    }
    let mut tables = state.tables.lock().unwrap();
    let mut table_names = state.table_names.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();

    // Clone before removal: the ref rewrite below needs the table still present
    // in the registry to resolve `Table1[Col]` into a concrete range.
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

    let table_name_upper = table.name.to_uppercase();
    let rewritten_cells = rewrite_table_refs_to_ranges(
        &tables,
        &table_names,
        &mut grids,
        &mut grid,
        active_sheet,
        &table_name_upper,
        &table,
    );

    if let Some(sheet_tables) = tables.get_mut(&active_sheet) {
        sheet_tables.remove(&table_id);
    }
    table_names.remove(&table_name_upper);

    drop(tables);
    drop(table_names);
    drop(grids);
    drop(grid);

    let removed_filter = clear_table_auto_filter(&state, &table, active_sheet);

    // C10 cleanup: prune any object scripts attached to this table so a deleted
    // table leaves no dangling scripts behind. instanceId == the table id.
    let table_id_str = table_id.to_string();
    let scripts_before = if let Ok(mut scripts) = state.object_scripts.lock() {
        let before = scripts.clone();
        scripts.retain(|s| {
            !(s.object_type == persistence::ScriptableObjectType::Table
                && s.instance_id.as_deref() == Some(table_id_str.as_str()))
        });
        if scripts.len() != before.len() { Some(before) } else { None }
    } else {
        None
    };

    // ONE undo transaction covering EVERY side effect. Recording only the table
    // (BUG-0006) meant Ctrl+Z brought back a table whose AutoFilter was gone,
    // whose scripts were gone, and whose dependents' structured references had
    // already been flattened to plain ranges — a half-undo that looked like a
    // successful one.
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Delete table".to_string());

        // Undo replays a transaction's changes in REVERSE record order
        // (undo_commands.rs: `transaction.changes.iter().rev()`, and deferred
        // restores execute in the order they were collected during that reverse
        // pass). So recording the cells FIRST makes them restore LAST — after
        // the table object exists again, which is what the restored structured
        // references need in order to resolve.
        let mut by_sheet: std::collections::HashMap<usize, Vec<(u32, u32, Option<engine::Cell>)>> =
            std::collections::HashMap::new();
        for (sheet_idx, row, col, before) in rewritten_cells {
            by_sheet.entry(sheet_idx).or_default().push((row, col, before));
        }
        for (sheet_index, cells) in by_sheet {
            undo_stack.record_custom_restore(
                "script_grid_cells".to_string(),
                crate::undo_commands::script_grid_cells_snapshot_bytes(sheet_index, cells),
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
        if let Some(previous) = scripts_before {
            undo_stack.record_custom_restore(
                "obj_object_scripts".to_string(),
                crate::undo_commands::object_scripts_snapshot_bytes(previous),
                "Restore table scripts",
            );
        }
        undo_stack.record_custom_restore(
            "obj_table".to_string(),
            crate::undo_commands::table_snapshot_bytes(active_sheet, table_id, Some(table)),
            "Delete table",
        );
        undo_stack.commit_transaction();
    }

    TableResult::ok_empty()
}

/// Rename a table
#[tauri::command]
pub fn rename_table(
    state: State<AppState>,
    table_id: identity::EntityId,
    new_name: String,
) -> TableResult {
    if !is_valid_table_name(&new_name) {
        return TableResult::err("Invalid table name");
    }
    if name_collides_with_defined_name(&state, &new_name) {
        return TableResult::err(
            "A defined name with this name already exists. Names and tables share one namespace — pick a different name.",
        );
    }

    let active_sheet = *state.active_sheet.lock().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = crate::protection::require_sheet_unprotected(&state, active_sheet, "the table") {
        return TableResult::err(&e);
    }
    let mut tables = state.tables.lock().unwrap();
    let mut table_names = state.table_names.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();

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

    // Snapshot BEFORE mutating so Ctrl+Z restores the old name (and with it the
    // name-registry entry, which the obj_table restore re-keys).
    let previous = table.clone();
    let upper_old = table.name.to_uppercase();

    // Remove old name, add new name
    table_names.remove(&upper_old);
    table_names.insert(upper_new, (active_sheet, table_id));
    table.name = new_name.clone();

    let updated = table.clone();

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

    // ONE transaction covering the rename AND the rewritten cells. Recording
    // only the table meant Ctrl+Z put the old name back on the registry while
    // every dependent formula kept saying the NEW name — so undoing a rename
    // produced #NAME? everywhere. Cells are recorded first so they restore last
    // (undo replays a transaction in reverse), i.e. after the table is back.
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Rename table".to_string());
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
        undo_stack.record_custom_restore(
            "obj_table".to_string(),
            crate::undo_commands::table_snapshot_bytes(active_sheet, table_id, Some(previous)),
            "Rename table",
        );
        undo_stack.commit_transaction();

        if cell_count > 0 {
            crate::log_info!(
                "TABLES",
                "Rename updated {} dependent formula cell(s) to '{}'",
                cell_count,
                new_name
            );
        }
    }

    TableResult::ok(updated)
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
                cell.formula_string().and_then(|f| {
                    if f.to_uppercase().contains(old_name_upper) {
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
    state: State<AppState>,
    params: UpdateTableStyleParams,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = crate::protection::require_sheet_unprotected(&state, active_sheet, "the table") {
        return TableResult::err(&e);
    }
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
    table_id: identity::EntityId,
    column_name: String,
    position: Option<usize>,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = crate::protection::require_sheet_unprotected(&state, active_sheet, "the table") {
        return TableResult::err(&e);
    }
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

    TableResult::ok(table.clone())
}

/// Remove a column from a table
#[tauri::command]
pub fn remove_table_column(
    state: State<AppState>,
    table_id: identity::EntityId,
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
    table_id: identity::EntityId,
    old_name: String,
    new_name: String,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = crate::protection::require_sheet_unprotected(&state, active_sheet, "the table") {
        return TableResult::err(&e);
    }
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
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = crate::protection::require_sheet_unprotected(&state, active_sheet, "the table") {
        return TableResult::err(&e);
    }
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
    table_id: identity::EntityId,
    show: bool,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = crate::protection::require_sheet_unprotected(&state, active_sheet, "the table") {
        return TableResult::err(&e);
    }
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
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = crate::protection::require_sheet_unprotected(&state, active_sheet, "the table") {
        return TableResult::err(&e);
    }
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
        if let Ok(mut auto_filters) = state.auto_filters.lock() {
            if let Some(af) = auto_filters.get_mut(&active_sheet) {
                let is_ours = previous.auto_filter_id == Some(af.id);
                if is_ours {
                    filter_undo = Some(af.clone());

                    // `column_filters` is keyed RELATIVE to start_col. Moving
                    // start_col without re-keying would leave every existing
                    // criterion pointing at a different physical column —
                    // filtering the wrong data with no visible change.
                    if af.start_col != updated.start_col {
                        let old_start = af.start_col;
                        let remapped: std::collections::HashMap<u32, crate::autofilter::ColumnFilter> =
                            af.column_filters
                                .iter()
                                .filter_map(|(rel, cf)| {
                                    let abs = old_start + rel;
                                    if abs < updated.start_col || abs > updated.end_col {
                                        return None; // Column left the table.
                                    }
                                    let new_rel = abs - updated.start_col;
                                    let mut moved = cf.clone();
                                    moved.column_index = new_rel;
                                    Some((new_rel, moved))
                                })
                                .collect();
                        af.column_filters = remapped;
                    } else {
                        // Same origin: drop criteria for columns the resize cut.
                        let max_rel = updated.end_col - updated.start_col;
                        af.column_filters.retain(|rel, _| *rel <= max_rel);
                    }

                    af.start_row = updated.start_row;
                    af.end_row = updated.end_row;
                    af.start_col = updated.start_col;
                    af.end_col = updated.end_col;
                }
            }
        }
    }

    // ONE transaction: undoing the resize must also put the filter back where
    // it was, criteria and all. Recording only the table left Ctrl+Z restoring
    // the old bounds while the filter stayed on the resized range.
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Resize table".to_string());
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
        undo_stack.commit_transaction();
    }

    TableResult::ok(updated)
}

/// Rewrite every structured reference that mentions `table_name_upper` into
/// absolute A1 references, across ALL sheets.
///
/// Must run while the table is STILL in the registry — resolution needs it to
/// turn `Table1[Amount]` into a concrete range. Shared by `convert_to_range`
/// and `delete_table`: both leave the cells in place, so a formula over the
/// table's columns should keep working against the now-plain range. Skipping
/// this on delete left `Table1[Amount]` as an `_UNRESOLVED` NamedRef sentinel
/// that the evaluator rejects — a silent breakage of every dependent formula.
fn rewrite_table_refs_to_ranges(
    tables: &TableStorage,
    table_names: &TableNameRegistry,
    grids: &mut [engine::Grid],
    grid: &mut engine::Grid,
    active_sheet: usize,
    table_name_upper: &str,
    target: &Table,
) -> Vec<(usize, u32, u32, Option<engine::Cell>)> {
    // Pre-mutation cells, so the caller can make the rewrite undoable.
    let mut touched: Vec<(usize, u32, u32, Option<engine::Cell>)> = Vec::new();
    // SCOPE GUARD. `resolve_table_refs_in_ast` flattens EVERY table ref in an
    // expression, not just the target's, and a bare `[@Col]` names no table at
    // all — so a naive "contains the name or contains [@" filter would drag
    // OTHER, still-live tables' structured references into the rewrite and
    // destroy them permanently (the AST is the stored form; undo only restores
    // the Table object, not the cells).
    //
    // So: only touch a formula that refers to the target and to NOTHING else.
    // A mixed formula is left alone — its target ref degrades to #NAME? exactly
    // as before this rewrite existed, which is loud and reversible, whereas
    // silently de-structuring a live table's formulas is neither.
    let other_names: Vec<String> = table_names
        .keys()
        .filter(|n| n.as_str() != table_name_upper)
        .cloned()
        .collect();

    for (sheet_idx, sheet_grid) in grids.iter_mut().enumerate() {
        // Fast filter on the formula text before paying for a parse.
        let formula_cells: Vec<(u32, u32, String)> = sheet_grid
            .cells
            .iter()
            .filter_map(|(&(row, col), cell)| {
                cell.formula_string().and_then(|f| {
                    let f_upper = f.to_uppercase();
                    // A bare `[@Col]` resolves against the table CONTAINING the
                    // cell, so it is only ours when the cell is inside the
                    // target's own range on the target's own sheet.
                    let this_row_ref_is_ours = f_upper.contains("[@")
                        && sheet_idx == target.sheet_index
                        && row >= target.start_row
                        && row <= target.end_row
                        && col >= target.start_col
                        && col <= target.end_col;
                    let names_target = f_upper.contains(table_name_upper);
                    if !names_target && !this_row_ref_is_ours {
                        return None;
                    }
                    // Refuse anything that also names another table.
                    if other_names.iter().any(|n| f_upper.contains(n.as_str())) {
                        return None;
                    }
                    Some((row, col, f))
                })
            })
            .collect();

        for (row, col, formula_str) in formula_cells {
            let parsed = match parser::parse(&formula_str) {
                Ok(ast) => ast,
                Err(_) => continue, // Can't parse — leave as-is
            };
            if !crate::ast_has_table_refs(&parsed) {
                continue;
            }

            let ctx = crate::TableRefContext {
                tables,
                table_names,
                current_sheet_index: sheet_idx,
                current_row: row,
            };
            let resolved = crate::resolve_table_refs_in_ast(&parsed, &ctx);
            let new_formula = format!("={}", crate::expression_to_formula(&resolved));

            // A re-parse failure must NOT be swallowed: `.ok()` would leave the
            // cell with ast: None, silently demoting a formula cell to a plain
            // value. If we cannot produce a valid replacement, keep the original.
            let Ok(reparsed) = parser::parse(&new_formula) else {
                crate::log_warn!(
                    "TABLES",
                    "Skipped ref rewrite at sheet {} r{}c{}: '{}' did not re-parse",
                    sheet_idx, row, col, new_formula
                );
                continue;
            };

            if let Some(cell) = sheet_grid.get_cell(row, col) {
                let before = cell.clone();
                let mut updated = before.clone();
                updated.ast = Some(Box::new(reparsed));
                sheet_grid.set_cell(row, col, updated.clone());
                if sheet_idx == active_sheet {
                    grid.set_cell(row, col, updated);
                }
                touched.push((sheet_idx, row, col, Some(before)));
            }
        }
    }

    touched
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
    table: &Table,
    sheet_index: usize,
) -> Option<crate::autofilter::AutoFilter> {
    let af_id = table.auto_filter_id?;
    let Ok(mut auto_filters) = state.auto_filters.lock() else {
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

/// Convert table to range: rewrite all structured references that mention this
/// table into absolute A1 references, then remove the table from the registry.
/// Cell data and formatting are preserved.
#[tauri::command]
pub fn convert_to_range(
    state: State<AppState>,
    table_id: identity::EntityId,
) -> TableResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = crate::protection::require_sheet_unprotected(&state, active_sheet, "the table") {
        return TableResult::err(&e);
    }
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

    rewrite_table_refs_to_ranges(
        &tables,
        &table_names,
        &mut grids,
        &mut grid,
        active_sheet,
        &table_name_upper,
        &table,
    );

    // Remove the table from the registry
    if let Some(sheet_tables) = tables.get_mut(&active_sheet) {
        sheet_tables.remove(&table_id);
    }
    table_names.remove(&table_name_upper);

    drop(tables);
    drop(table_names);
    drop(grids);
    drop(grid);
    clear_table_auto_filter(&state, &table, active_sheet);

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

            // Grow the AutoFilter with the table — but only if the sheet's
            // filter is actually THIS table's. With two filter-bearing tables
            // on a sheet, auto-expanding one would otherwise stretch the
            // other's filter over rows it does not own.
            if table.style_options.show_filter_button {
                let owned = table.auto_filter_id;
                let mut auto_filters = state.auto_filters.lock().unwrap();
                if let Some(af) = auto_filters.get_mut(&active_sheet) {
                    if owned == Some(af.id) {
                        af.end_row = table.end_row;
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
                }
            }

            table.columns.push(TableColumn::new(new_col_id, new_name));
            table.end_col += 1;

            // Same ownership rule as the row branch above.
            if table.style_options.show_filter_button {
                let owned = table.auto_filter_id;
                let mut auto_filters = state.auto_filters.lock().unwrap();
                if let Some(af) = auto_filters.get_mut(&active_sheet) {
                    if owned == Some(af.id) {
                        af.end_col = table.end_col;
                    }
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
    table_id: identity::EntityId,
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
    table_id: identity::EntityId,
) -> Option<Table> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let tables = state.tables.lock().unwrap();

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
    let tables = state.tables.lock().unwrap();
    for sheet_tables in tables.values() {
        if let Some(table) = sheet_tables.get(&table_id) {
            return Some(table.clone());
        }
    }
    None
}

/// Append one data row to a table by expanding its end_row by 1, across any
/// sheet. The host writes the new row's cells via the cell ops (recalc + undo)
/// and emits the dataChanged event; this command only grows the table bounds.
#[tauri::command]
pub fn add_table_row(
    state: State<AppState>,
    table_id: identity::EntityId,
) -> Result<(), String> {
    let mut tables = state.tables.lock().unwrap();
    for sheet_tables in tables.values_mut() {
        if let Some(table) = sheet_tables.get_mut(&table_id) {
            table.end_row += 1;
            // Keep the AutoFilter range in sync — but only the filter this
            // table owns. Same ownership rule as resize/delete/auto-expand;
            // without it, adding a row to one table stretches whichever filter
            // happens to be on the sheet, including another table's.
            if table.style_options.show_filter_button {
                let sheet_index = table.sheet_index;
                let new_end = table.end_row;
                let owned = table.auto_filter_id;
                let mut auto_filters = state.auto_filters.lock().unwrap();
                if let Some(af) = auto_filters.get_mut(&sheet_index) {
                    if owned == Some(af.id) {
                        af.end_row = new_end;
                    }
                }
            }
            return Ok(());
        }
    }
    Err("Table not found".to_string())
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
    let tables = state.tables.lock().unwrap();
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
    let tables = state.tables.lock().unwrap();
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
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    table_id: identity::EntityId,
    column_name: String,
    formula: String,
) -> TableResult {
    // GET.CONTROLVALUE snapshot: built BEFORE the table/grid locks below.
    let control_values = crate::control_values::build_control_values(
        &state, &pane_control_state, &ribbon_filter_state,
    );
    let active_sheet = *state.active_sheet.lock().unwrap();
    // Tables are not editable while the sheet is protected (Excel greys the
    // whole table surface out). One rule for every table mutation.
    if let Err(e) = crate::protection::require_sheet_unprotected(&state, active_sheet, "the table") {
        return TableResult::err(&e);
    }
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
        let locale = state.locale.lock().unwrap();

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
                cube_prefetch: None,
                current_row: Some(row),
                current_col: Some(abs_col),
                row_heights: None,
                column_widths: None,
                hidden_rows: None,
                control_values: Some(control_values.clone()),
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

            // Format display value for frontend. The cell keeps its own explicit
            // style_index (preserved above); only the DISPLAY honours the row/column
            // tiers, resolved against the grid this cell is written to.
            let style = styles.get(grid.effective_style_index(row, abs_col));
            let display = crate::format_cell_value(&cell.value, style, &locale);

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
    table_id: identity::EntityId,
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

    fn test_id() -> identity::EntityId {
        identity::EntityId::from_bytes(identity::generate_uuid_v7())
    }

    #[test]
    fn test_totals_row_function_default() {
        assert_eq!(TotalsRowFunction::default(), TotalsRowFunction::None);
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

    /// Mirrors the `column_filters` remap in `resize_table`. Keys are RELATIVE
    /// to the filter's start_col, so a moved origin must re-key them or every
    /// criterion silently filters a different physical column.
    fn remap_filter_keys(
        old_start: u32,
        keys: &[u32],
        new_start: u32,
        new_end: u32,
    ) -> Vec<u32> {
        let mut out: Vec<u32> = keys
            .iter()
            .filter_map(|rel| {
                let abs = old_start + rel;
                if abs < new_start || abs > new_end {
                    return None;
                }
                Some(abs - new_start)
            })
            .collect();
        out.sort_unstable();
        out
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
}
