//! FILENAME: app/src-tauri/src/persistence.rs

use crate::api_types::CellData;
use crate::tables::{
    Table, TableColumn, TableStyleOptions, TotalsRowFunction, TableStorage, TableNameRegistry,
};
use crate::{format_cell_value, AppState};
use persistence::{
    load_xlsx, save_xlsx, DimensionData, SavedTable, SavedTableColumn, SavedTableStyleOptions,
    Workbook,
};
use calcula_format::{save_calcula, load_calcula};
use calcula_format::ai::{AiSerializeOptions, serialize_for_ai, SheetInput};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct FileState {
    pub current_path: Mutex<Option<PathBuf>>,
    pub is_modified: Mutex<bool>,
}

// ============================================================================
// Table <-> SavedTable conversion
// ============================================================================

fn table_to_saved(table: &Table) -> SavedTable {
    SavedTable {
        id: table.id,
        name: table.name.clone(),
        sheet_index: table.sheet_index,
        start_row: table.start_row,
        start_col: table.start_col,
        end_row: table.end_row,
        end_col: table.end_col,
        columns: table
            .columns
            .iter()
            .map(|c| SavedTableColumn {
                id: c.id,
                name: c.name.clone(),
                totals_row_function: totals_fn_to_string(&c.totals_row_function),
                totals_row_formula: c.totals_row_formula.clone(),
                calculated_formula: c.calculated_formula.clone(),
            })
            .collect(),
        style_options: SavedTableStyleOptions {
            banded_rows: table.style_options.banded_rows,
            banded_columns: table.style_options.banded_columns,
            header_row: table.style_options.header_row,
            total_row: table.style_options.total_row,
            first_column: table.style_options.first_column,
            last_column: table.style_options.last_column,
            show_filter_button: table.style_options.show_filter_button,
        },
        style_name: table.style_name.clone(),
    }
}

fn saved_to_table(saved: &SavedTable) -> Table {
    Table {
        id: saved.id,
        name: saved.name.clone(),
        sheet_index: saved.sheet_index,
        start_row: saved.start_row,
        start_col: saved.start_col,
        end_row: saved.end_row,
        end_col: saved.end_col,
        columns: saved
            .columns
            .iter()
            .map(|c| TableColumn {
                id: c.id,
                name: c.name.clone(),
                totals_row_function: string_to_totals_fn(&c.totals_row_function),
                totals_row_formula: c.totals_row_formula.clone(),
                calculated_formula: c.calculated_formula.clone(),
            })
            .collect(),
        style_options: TableStyleOptions {
            banded_rows: saved.style_options.banded_rows,
            banded_columns: saved.style_options.banded_columns,
            header_row: saved.style_options.header_row,
            total_row: saved.style_options.total_row,
            first_column: saved.style_options.first_column,
            last_column: saved.style_options.last_column,
            show_filter_button: saved.style_options.show_filter_button,
        },
        style_name: saved.style_name.clone(),
        auto_filter_id: None,
    }
}

fn totals_fn_to_string(func: &TotalsRowFunction) -> String {
    match func {
        TotalsRowFunction::None => "none".to_string(),
        TotalsRowFunction::Average => "average".to_string(),
        TotalsRowFunction::Count => "count".to_string(),
        TotalsRowFunction::CountNumbers => "countNumbers".to_string(),
        TotalsRowFunction::Max => "max".to_string(),
        TotalsRowFunction::Min => "min".to_string(),
        TotalsRowFunction::Sum => "sum".to_string(),
        TotalsRowFunction::StdDev => "stdDev".to_string(),
        TotalsRowFunction::Var => "var".to_string(),
        TotalsRowFunction::Custom => "custom".to_string(),
    }
}

fn string_to_totals_fn(s: &str) -> TotalsRowFunction {
    match s {
        "average" => TotalsRowFunction::Average,
        "count" => TotalsRowFunction::Count,
        "countNumbers" => TotalsRowFunction::CountNumbers,
        "max" => TotalsRowFunction::Max,
        "min" => TotalsRowFunction::Min,
        "sum" => TotalsRowFunction::Sum,
        "stdDev" => TotalsRowFunction::StdDev,
        "var" => TotalsRowFunction::Var,
        "custom" => TotalsRowFunction::Custom,
        _ => TotalsRowFunction::None,
    }
}

/// Collect all tables from the AppState into SavedTable format.
fn collect_tables_for_save(
    tables: &TableStorage,
) -> Vec<SavedTable> {
    let mut saved = Vec::new();
    for sheet_tables in tables.values() {
        for table in sheet_tables.values() {
            saved.push(table_to_saved(table));
        }
    }
    saved
}

/// Restore tables from SavedTable format into AppState structures.
fn restore_tables(
    saved_tables: &[SavedTable],
) -> (TableStorage, TableNameRegistry, u64) {
    let mut tables: TableStorage = HashMap::new();
    let mut table_names: TableNameRegistry = HashMap::new();
    let mut max_id: u64 = 0;

    for saved in saved_tables {
        let table = saved_to_table(saved);
        if table.id > max_id {
            max_id = table.id;
        }
        table_names.insert(table.name.to_uppercase(), (table.sheet_index, table.id));
        tables
            .entry(table.sheet_index)
            .or_insert_with(HashMap::new)
            .insert(table.id, table);
    }

    (tables, table_names, max_id + 1)
}

// ============================================================================
// COMMANDS
// ============================================================================

#[tauri::command]
pub fn save_file(
    state: State<AppState>,
    file_state: State<FileState>,
    path: String,
) -> Result<(), String> {
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let col_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
    let row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
    let tables = state.tables.lock().map_err(|e| e.to_string())?;

    let dimensions = DimensionData {
        column_widths: col_widths.clone(),
        row_heights: row_heights.clone(),
    };

    let mut workbook = Workbook::from_grid(&grid, &styles, &dimensions);
    workbook.tables = collect_tables_for_save(&tables);

    let path_buf = PathBuf::from(&path);

    // Route by file extension
    let ext = path_buf
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "cala" => save_calcula(&workbook, &path_buf).map_err(|e| e.to_string())?,
        _ => save_xlsx(&workbook, &path_buf).map_err(|e| e.to_string())?,
    }

    *file_state.current_path.lock().map_err(|e| e.to_string())? = Some(path_buf);
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = false;

    Ok(())
}

#[tauri::command]
pub fn open_file(
    state: State<AppState>,
    file_state: State<FileState>,
    path: String,
) -> Result<Vec<CellData>, String> {
    let path_buf = PathBuf::from(&path);

    // Route by file extension
    let ext = path_buf
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let workbook = match ext.as_str() {
        "cala" => load_calcula(&path_buf).map_err(|e| e.to_string())?,
        _ => load_xlsx(&path_buf).map_err(|e| e.to_string())?,
    };

    if workbook.sheets.is_empty() {
        return Err("No sheets in workbook".to_string());
    }

    let sheet = &workbook.sheets[workbook.active_sheet];
    let (new_grid, new_styles) = sheet.to_grid();

    // Restore tables from the workbook metadata
    let (new_tables, new_table_names, next_id) = restore_tables(&workbook.tables);

    {
        let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
        let mut styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        let mut col_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
        let mut row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
        let mut deps = state.dependents.lock().map_err(|e| e.to_string())?;
        let mut tables = state.tables.lock().map_err(|e| e.to_string())?;
        let mut table_names = state.table_names.lock().map_err(|e| e.to_string())?;
        let mut next_table_id = state.next_table_id.lock().map_err(|e| e.to_string())?;

        *grid = new_grid;
        *styles = new_styles;
        *col_widths = sheet.column_widths.clone();
        *row_heights = sheet.row_heights.clone();
        deps.clear();

        // Reset per-sheet dimension storage (active sheet dims are in col_widths/row_heights)
        let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;
        all_cw.clear();
        all_cw.push(std::collections::HashMap::new()); // placeholder for active sheet
        all_rh.clear();
        all_rh.push(std::collections::HashMap::new());

        // Restore table state
        *tables = new_tables;
        *table_names = new_table_names;
        *next_table_id = next_id;
    }

    *file_state.current_path.lock().map_err(|e| e.to_string())? = Some(path_buf);
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = false;

    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;

    let cells: Vec<CellData> = grid
        .cells
        .iter()
        .map(|((row, col), cell)| {
            let style = styles.get(cell.style_index);
            CellData {
                row: *row,
                col: *col,
                formula: cell.formula.clone(),
                display: format_cell_value(&cell.value, style),
                display_color: None,
                style_index: cell.style_index,
                row_span: 1,
                col_span: 1,
                sheet_index: None,
            }
        })
        .collect();

    Ok(cells)
}

#[tauri::command]
pub fn new_file(
    state: State<AppState>,
    file_state: State<FileState>,
) -> Result<(), String> {
    {
        let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
        let mut styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        let mut col_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
        let mut row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
        let mut deps = state.dependents.lock().map_err(|e| e.to_string())?;
        let mut tables = state.tables.lock().map_err(|e| e.to_string())?;
        let mut table_names = state.table_names.lock().map_err(|e| e.to_string())?;
        let mut next_table_id = state.next_table_id.lock().map_err(|e| e.to_string())?;

        *grid = engine::grid::Grid::new();
        *styles = engine::style::StyleRegistry::new();
        col_widths.clear();
        row_heights.clear();
        deps.clear();

        // Reset per-sheet dimension storage
        let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;
        all_cw.clear();
        all_cw.push(std::collections::HashMap::new());
        all_rh.clear();
        all_rh.push(std::collections::HashMap::new());

        // Clear table state
        tables.clear();
        table_names.clear();
        *next_table_id = 1;
    }

    *file_state.current_path.lock().map_err(|e| e.to_string())? = None;
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = false;

    Ok(())
}

#[tauri::command]
pub fn get_current_file_path(file_state: State<FileState>) -> Option<String> {
    file_state
        .current_path
        .lock()
        .ok()
        .and_then(|p| p.as_ref().map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn is_file_modified(file_state: State<FileState>) -> bool {
    file_state.is_modified.lock().map(|m| *m).unwrap_or(false)
}

#[tauri::command]
pub fn mark_file_modified(file_state: State<FileState>) {
    if let Ok(mut modified) = file_state.is_modified.lock() {
        *modified = true;
    }
}

// ============================================================================
// AI CONTEXT SERIALIZATION
// ============================================================================

#[tauri::command]
pub fn get_ai_context(
    state: State<AppState>,
    options: AiSerializeOptions,
) -> Result<String, String> {
    let grids = state.grids.lock().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let active_grid = state.grid.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;

    // Build sheet inputs — use stored grids for non-active sheets, active grid for current
    let mut sheet_inputs: Vec<SheetInput> = Vec::new();
    for (i, name) in sheet_names.iter().enumerate() {
        if i == active_sheet {
            sheet_inputs.push(SheetInput {
                name,
                grid: &active_grid,
                styles: &styles,
            });
        } else if let Some(grid) = grids.get(i) {
            sheet_inputs.push(SheetInput {
                name,
                grid,
                styles: &styles,
            });
        }
    }

    Ok(serialize_for_ai(&sheet_inputs, &options))
}
