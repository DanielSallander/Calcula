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
use tauri::{Emitter, State};

#[derive(Default)]
pub struct FileState {
    pub current_path: Mutex<Option<PathBuf>>,
    pub is_modified: Mutex<bool>,
}

/// Virtual filesystem for user files stored inside the .cala archive.
#[derive(Default)]
pub struct UserFilesState {
    pub files: Mutex<HashMap<String, Vec<u8>>>,
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
// PUBLIC HELPERS
// ============================================================================

/// Build a Workbook from the current AppState (used by save_file and export_as_package).
pub fn build_workbook_for_save(
    state: &State<AppState>,
    user_files_state: &State<UserFilesState>,
) -> Result<Workbook, String> {
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
    workbook.user_files = user_files_state.files.lock().map_err(|e| e.to_string())?.clone();
    workbook.theme = state.theme.lock().unwrap().clone();

    Ok(workbook)
}

/// Build a Workbook from the current AppState including slicer state.
pub fn build_workbook_for_save_with_slicers(
    state: &State<AppState>,
    user_files_state: &State<UserFilesState>,
    slicer_state: &State<crate::slicer::SlicerState>,
) -> Result<Workbook, String> {
    let mut workbook = build_workbook_for_save(state, user_files_state)?;
    workbook.slicers = collect_slicers_for_save(slicer_state);
    Ok(workbook)
}

/// Collect slicers from SlicerState into SavedSlicer format.
fn collect_slicers_for_save(
    slicer_state: &State<crate::slicer::SlicerState>,
) -> Vec<persistence::SavedSlicer> {
    let slicers = slicer_state.slicers.lock().unwrap();
    let computed_props = slicer_state.computed_properties.lock().unwrap();
    slicers
        .values()
        .map(|s| {
            let mut saved = slicer_to_saved(s);
            // Attach computed properties for this slicer
            if let Some(props) = computed_props.get(&s.id) {
                saved.computed_properties = props
                    .iter()
                    .map(|p| persistence::SavedSlicerComputedProperty {
                        id: p.id,
                        attribute: p.attribute.clone(),
                        formula: p.formula.clone(),
                    })
                    .collect();
            }
            saved
        })
        .collect()
}

fn slicer_to_saved(slicer: &crate::slicer::Slicer) -> persistence::SavedSlicer {
    persistence::SavedSlicer {
        id: slicer.id,
        name: slicer.name.clone(),
        header_text: slicer.header_text.clone(),
        sheet_index: slicer.sheet_index,
        x: slicer.x,
        y: slicer.y,
        width: slicer.width,
        height: slicer.height,
        source_type: match slicer.source_type {
            crate::slicer::SlicerSourceType::Table => persistence::SavedSlicerSourceType::Table,
            crate::slicer::SlicerSourceType::Pivot => persistence::SavedSlicerSourceType::Pivot,
        },
        source_id: slicer.source_id,
        field_name: slicer.field_name.clone(),
        selected_items: slicer.selected_items.clone(),
        show_header: slicer.show_header,
        columns: slicer.columns,
        style_preset: slicer.style_preset.clone(),
        selection_mode: match slicer.selection_mode {
            crate::slicer::SlicerSelectionMode::Standard => persistence::SavedSlicerSelectionMode::Standard,
            crate::slicer::SlicerSelectionMode::Single => persistence::SavedSlicerSelectionMode::Single,
            crate::slicer::SlicerSelectionMode::Multi => persistence::SavedSlicerSelectionMode::Multi,
        },
        hide_no_data: slicer.hide_no_data,
        indicate_no_data: slicer.indicate_no_data,
        sort_no_data_last: slicer.sort_no_data_last,
        force_selection: slicer.force_selection,
        show_select_all: slicer.show_select_all,
        arrangement: match slicer.arrangement {
            crate::slicer::SlicerArrangement::Grid => persistence::SavedSlicerArrangement::Grid,
            crate::slicer::SlicerArrangement::Horizontal => persistence::SavedSlicerArrangement::Horizontal,
            crate::slicer::SlicerArrangement::Vertical => persistence::SavedSlicerArrangement::Vertical,
        },
        rows: slicer.rows,
        item_gap: slicer.item_gap,
        autogrid: slicer.autogrid,
        item_padding: slicer.item_padding,
        button_radius: slicer.button_radius,
        computed_properties: Vec::new(),
    }
}

fn saved_to_slicer(saved: &persistence::SavedSlicer) -> crate::slicer::Slicer {
    crate::slicer::Slicer {
        id: saved.id,
        name: saved.name.clone(),
        header_text: saved.header_text.clone(),
        sheet_index: saved.sheet_index,
        x: saved.x,
        y: saved.y,
        width: saved.width,
        height: saved.height,
        source_type: match saved.source_type {
            persistence::SavedSlicerSourceType::Table => crate::slicer::SlicerSourceType::Table,
            persistence::SavedSlicerSourceType::Pivot => crate::slicer::SlicerSourceType::Pivot,
        },
        source_id: saved.source_id,
        field_name: saved.field_name.clone(),
        selected_items: saved.selected_items.clone(),
        show_header: saved.show_header,
        columns: saved.columns,
        style_preset: saved.style_preset.clone(),
        selection_mode: match saved.selection_mode {
            persistence::SavedSlicerSelectionMode::Standard => crate::slicer::SlicerSelectionMode::Standard,
            persistence::SavedSlicerSelectionMode::Single => crate::slicer::SlicerSelectionMode::Single,
            persistence::SavedSlicerSelectionMode::Multi => crate::slicer::SlicerSelectionMode::Multi,
        },
        hide_no_data: saved.hide_no_data,
        indicate_no_data: saved.indicate_no_data,
        sort_no_data_last: saved.sort_no_data_last,
        force_selection: saved.force_selection,
        show_select_all: saved.show_select_all,
        arrangement: match saved.arrangement {
            persistence::SavedSlicerArrangement::Grid => crate::slicer::SlicerArrangement::Grid,
            persistence::SavedSlicerArrangement::Horizontal => crate::slicer::SlicerArrangement::Horizontal,
            persistence::SavedSlicerArrangement::Vertical => crate::slicer::SlicerArrangement::Vertical,
        },
        rows: saved.rows,
        item_gap: saved.item_gap,
        autogrid: saved.autogrid,
        item_padding: saved.item_padding,
        button_radius: saved.button_radius,
    }
}

/// Restore slicers from SavedSlicer format into SlicerState.
fn restore_slicers(
    saved_slicers: &[persistence::SavedSlicer],
    slicer_state: &State<crate::slicer::SlicerState>,
) {
    let mut slicers = slicer_state.slicers.lock().unwrap();
    let mut next_id = slicer_state.next_id.lock().unwrap();
    let mut computed_props = slicer_state.computed_properties.lock().unwrap();
    let mut next_cprop_id = slicer_state.next_computed_prop_id.lock().unwrap();

    slicers.clear();
    computed_props.clear();
    let mut max_id: u64 = 0;
    let mut max_cprop_id: u64 = 0;

    for saved in saved_slicers {
        let slicer = saved_to_slicer(saved);
        if slicer.id > max_id {
            max_id = slicer.id;
        }
        let slicer_id = slicer.id;
        slicers.insert(slicer.id, slicer);

        // Restore computed properties
        if !saved.computed_properties.is_empty() {
            let props: Vec<crate::slicer::computed::SlicerComputedProperty> = saved
                .computed_properties
                .iter()
                .map(|sp| {
                    if sp.id > max_cprop_id {
                        max_cprop_id = sp.id;
                    }
                    let cached_ast = parser::parse(&sp.formula)
                        .ok()
                        .map(|parsed| crate::convert_expr(&parsed));
                    crate::slicer::computed::SlicerComputedProperty {
                        id: sp.id,
                        slicer_id,
                        attribute: sp.attribute.clone(),
                        formula: sp.formula.clone(),
                        cached_ast,
                        cached_value: None,
                    }
                })
                .collect();
            computed_props.insert(slicer_id, props);
        }
    }

    *next_id = max_id + 1;
    *next_cprop_id = max_cprop_id + 1;
}

// ============================================================================
// COMMANDS
// ============================================================================

#[tauri::command]
pub fn save_file(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    slicer_state: State<crate::slicer::SlicerState>,
    script_state: State<crate::scripting::types::ScriptState>,
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
    workbook.slicers = collect_slicers_for_save(&slicer_state);
    workbook.scripts = collect_scripts_for_save(&script_state);
    workbook.notebooks = collect_notebooks_for_save(&script_state);
    workbook.user_files = user_files_state.files.lock().map_err(|e| e.to_string())?.clone();
    workbook.theme = state.theme.lock().unwrap().clone();

    // Save linked sheet metadata into user_files
    save_linked_sheets_metadata(&state, &mut workbook)?;

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
    user_files_state: State<UserFilesState>,
    slicer_state: State<crate::slicer::SlicerState>,
    script_state: State<crate::scripting::types::ScriptState>,
    path: String,
) -> Result<Vec<CellData>, String> {
    let path_buf = PathBuf::from(&path);

    // Route by file extension
    let ext = path_buf
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mut workbook = match ext.as_str() {
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

    // Restore slicers from workbook
    restore_slicers(&workbook.slicers, &slicer_state);

    // Restore scripts and notebooks
    restore_scripts(&workbook.scripts, &script_state);
    restore_notebooks(&workbook.notebooks, &script_state);

    // Restore user files from workbook (extract linked sheets metadata first)
    restore_linked_sheets_metadata(&state, &mut workbook)?;
    *user_files_state.files.lock().map_err(|e| e.to_string())? = workbook.user_files;

    // Restore document theme
    *state.theme.lock().map_err(|e| e.to_string())? = workbook.theme;

    *file_state.current_path.lock().map_err(|e| e.to_string())? = Some(path_buf);
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = false;

    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;

    let cells: Vec<CellData> = grid
        .cells
        .iter()
        .map(|((row, col), cell)| {
            let style = styles.get(cell.style_index);
            CellData {
                row: *row,
                col: *col,
                formula: cell.formula.clone(),
                display: format_cell_value(&cell.value, style, &locale),
                display_color: None,
                style_index: cell.style_index,
                row_span: 1,
                col_span: 1,
                sheet_index: None,
                rich_text: None,
                accounting_layout: None,
            }
        })
        .collect();

    Ok(cells)
}

#[tauri::command]
pub fn new_file(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    slicer_state: State<crate::slicer::SlicerState>,
    script_state: State<crate::scripting::types::ScriptState>,
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

    // Clear slicer state
    slicer_state.slicers.lock().unwrap().clear();
    *slicer_state.next_id.lock().unwrap() = 1;
    slicer_state.computed_properties.lock().unwrap().clear();
    *slicer_state.next_computed_prop_id.lock().unwrap() = 1;
    slicer_state.computed_prop_dependencies.lock().unwrap().clear();
    slicer_state.computed_prop_dependents.lock().unwrap().clear();

    // Clear script/notebook state
    script_state.workbook_scripts.lock().unwrap().clear();
    script_state.workbook_notebooks.lock().unwrap().clear();

    // Clear user files
    user_files_state.files.lock().map_err(|e| e.to_string())?.clear();

    // Clear linked sheets
    state.linked_sheets.lock().map_err(|e| e.to_string())?.clear();

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
// VIRTUAL FILES (stored inside the .cala archive)
// ============================================================================

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualFileEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub extension: String,
}

/// List all user files stored inside the .cala archive.
#[tauri::command]
pub fn list_virtual_files(user_files_state: State<UserFilesState>) -> Result<Vec<VirtualFileEntry>, String> {
    let files = user_files_state.files.lock().map_err(|e| e.to_string())?;

    let mut entries: Vec<VirtualFileEntry> = Vec::new();
    let mut seen_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (path, content) in files.iter() {
        // Collect parent directories
        if let Some(dir_path) = path.rsplit_once('/').map(|(d, _)| d.to_string()) {
            // Add each level of the directory hierarchy
            let parts: Vec<&str> = dir_path.split('/').collect();
            for i in 0..parts.len() {
                let dir = parts[..=i].join("/");
                if seen_dirs.insert(dir.clone()) {
                    entries.push(VirtualFileEntry {
                        path: dir,
                        is_dir: true,
                        size: 0,
                        extension: String::new(),
                    });
                }
            }
        }

        let extension = std::path::Path::new(path)
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();

        entries.push(VirtualFileEntry {
            path: path.clone(),
            is_dir: false,
            size: content.len() as u64,
            extension,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });

    Ok(entries)
}

/// Read a user file from the virtual filesystem.
#[tauri::command]
pub fn read_virtual_file(user_files_state: State<UserFilesState>, path: String) -> Result<String, String> {
    let files = user_files_state.files.lock().map_err(|e| e.to_string())?;

    let content = files.get(&path)
        .ok_or_else(|| format!("File not found: {}", path))?;

    String::from_utf8(content.clone())
        .map_err(|_| "File is not valid UTF-8 text".to_string())
}

/// Create or update a file in the virtual filesystem.
#[tauri::command]
pub fn create_virtual_file(
    app_handle: tauri::AppHandle,
    user_files_state: State<UserFilesState>,
    file_state: State<FileState>,
    path: String,
    content: Option<String>,
) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    if path.contains("..") {
        return Err("Invalid path".to_string());
    }

    let mut files = user_files_state.files.lock().map_err(|e| e.to_string())?;
    let bytes = content.unwrap_or_default().into_bytes();
    files.insert(path.clone(), bytes);

    // Mark file as modified
    if let Ok(mut modified) = file_state.is_modified.lock() {
        *modified = true;
    }

    // Notify frontend so cells using FILEREAD/FILELINES/FILEEXISTS can recalculate
    let _ = app_handle.emit("virtual-file-changed", &path);

    Ok(())
}

/// Create a virtual folder marker (stores as an empty entry with trailing /).
#[tauri::command]
pub fn create_virtual_folder(
    user_files_state: State<UserFilesState>,
    file_state: State<FileState>,
    path: String,
) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    if path.contains("..") {
        return Err("Invalid path".to_string());
    }

    // Folders are implicitly created when files exist inside them.
    // We store a placeholder empty file to represent empty folders.
    let mut files = user_files_state.files.lock().map_err(|e| e.to_string())?;
    let folder_marker = format!("{}/.folder", path.trim_end_matches('/'));
    files.insert(folder_marker, Vec::new());

    // Mark file as modified
    if let Ok(mut modified) = file_state.is_modified.lock() {
        *modified = true;
    }

    Ok(())
}

/// Delete a file from the virtual filesystem.
#[tauri::command]
pub fn delete_virtual_file(
    app_handle: tauri::AppHandle,
    user_files_state: State<UserFilesState>,
    file_state: State<FileState>,
    path: String,
) -> Result<(), String> {
    let mut files = user_files_state.files.lock().map_err(|e| e.to_string())?;

    // If it's a directory, remove all files under it
    let prefix = format!("{}/", path.trim_end_matches('/'));
    let keys_to_remove: Vec<String> = files.keys()
        .filter(|k| **k == path || k.starts_with(&prefix))
        .cloned()
        .collect();

    if keys_to_remove.is_empty() {
        return Err(format!("Not found: {}", path));
    }

    for key in keys_to_remove {
        files.remove(&key);
    }

    // Mark file as modified
    if let Ok(mut modified) = file_state.is_modified.lock() {
        *modified = true;
    }

    // Notify frontend so cells using FILEREAD/FILELINES/FILEEXISTS can recalculate
    let _ = app_handle.emit("virtual-file-changed", &path);

    Ok(())
}

/// Rename a file or folder in the virtual filesystem.
#[tauri::command]
pub fn rename_virtual_file(
    app_handle: tauri::AppHandle,
    user_files_state: State<UserFilesState>,
    file_state: State<FileState>,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    if new_path.trim().is_empty() {
        return Err("New name cannot be empty".to_string());
    }
    if new_path.contains("..") {
        return Err("Invalid path".to_string());
    }

    let mut files = user_files_state.files.lock().map_err(|e| e.to_string())?;

    // Check if it's a single file rename
    if let Some(content) = files.remove(&old_path) {
        if files.contains_key(&new_path) {
            // Put it back
            files.insert(old_path, content);
            return Err(format!("'{}' already exists", new_path));
        }
        files.insert(new_path, content);
    } else {
        // It's a folder rename — rename all files under old_path/
        let old_prefix = format!("{}/", old_path.trim_end_matches('/'));
        let new_prefix = format!("{}/", new_path.trim_end_matches('/'));
        let keys_to_rename: Vec<(String, Vec<u8>)> = files.iter()
            .filter(|(k, _)| k.starts_with(&old_prefix))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        if keys_to_rename.is_empty() {
            return Err(format!("Not found: {}", old_path));
        }

        for (old_key, content) in keys_to_rename {
            files.remove(&old_key);
            let new_key = format!("{}{}", new_prefix, &old_key[old_prefix.len()..]);
            files.insert(new_key, content);
        }
    }

    // Mark file as modified
    if let Ok(mut modified) = file_state.is_modified.lock() {
        *modified = true;
    }

    // Notify frontend so cells using FILEREAD/FILELINES/FILEEXISTS can recalculate
    let _ = app_handle.emit("virtual-file-changed", &old_path);

    Ok(())
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

// ============================================================================
// RAW TEXT FILE I/O (for CSV import/export)
// ============================================================================

/// Read a text file with optional encoding detection.
/// Supports UTF-8 (with or without BOM), and falls back to Windows-1252 (ANSI).
#[tauri::command]
pub fn read_text_file(path: String, encoding: Option<String>) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    let bytes = std::fs::read(&path_buf).map_err(|e| format!("Failed to read file: {}", e))?;

    let enc = encoding.unwrap_or_default().to_lowercase();

    match enc.as_str() {
        "utf-8" | "utf8" | "" => {
            // Try UTF-8 first, strip BOM if present
            let text = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
                String::from_utf8(bytes[3..].to_vec())
            } else {
                String::from_utf8(bytes.clone())
            };
            match text {
                Ok(s) => Ok(s),
                Err(_) if enc.is_empty() => {
                    // Auto-detect: fall back to Windows-1252
                    Ok(bytes.iter().map(|&b| b as char).collect())
                }
                Err(e) => Err(format!("UTF-8 decode error: {}", e)),
            }
        }
        "ansi" | "windows-1252" | "latin1" | "iso-8859-1" => {
            Ok(bytes.iter().map(|&b| b as char).collect())
        }
        _ => Err(format!("Unsupported encoding: {}", enc)),
    }
}

/// Write a text string to a file with the specified encoding.
#[tauri::command]
pub fn write_text_file(path: String, content: String, encoding: Option<String>) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);

    let enc = encoding.unwrap_or_default().to_lowercase();

    let bytes = match enc.as_str() {
        "utf-8-bom" => {
            let mut bom = vec![0xEF, 0xBB, 0xBF];
            bom.extend_from_slice(content.as_bytes());
            bom
        }
        "ansi" | "windows-1252" | "latin1" | "iso-8859-1" => {
            content.chars().map(|c| {
                let cp = c as u32;
                if cp <= 255 { cp as u8 } else { b'?' }
            }).collect()
        }
        _ => content.into_bytes(), // UTF-8 (default)
    };

    std::fs::write(&path_buf, bytes).map_err(|e| format!("Failed to write file: {}", e))
}

// ============================================================================
// LINKED SHEETS METADATA (save/restore via user_files)
// ============================================================================

const LINKED_SHEETS_META_KEY: &str = "_meta/linked_sheets.json";

/// Save linked sheet metadata into the workbook's user_files map.
fn save_linked_sheets_metadata(
    state: &State<AppState>,
    workbook: &mut Workbook,
) -> Result<(), String> {
    let linked = state.linked_sheets.lock().map_err(|e| e.to_string())?;
    if linked.is_empty() {
        // Remove stale metadata if present
        workbook.user_files.remove(LINKED_SHEETS_META_KEY);
        return Ok(());
    }

    let json = serde_json::to_string_pretty(&*linked)
        .map_err(|e| format!("Failed to serialize linked sheets: {}", e))?;
    workbook
        .user_files
        .insert(LINKED_SHEETS_META_KEY.to_string(), json.into_bytes());
    Ok(())
}

/// Restore linked sheet metadata from the workbook's user_files map.
/// Removes the metadata key from user_files so it doesn't show as a virtual file.
fn restore_linked_sheets_metadata(
    state: &State<AppState>,
    workbook: &mut Workbook,
) -> Result<(), String> {
    let mut linked = state.linked_sheets.lock().map_err(|e| e.to_string())?;
    linked.clear();

    if let Some(bytes) = workbook.user_files.remove(LINKED_SHEETS_META_KEY) {
        let json = String::from_utf8(bytes)
            .map_err(|e| format!("Invalid UTF-8 in linked sheets metadata: {}", e))?;
        let infos: Vec<calcula_format::publish::linked::LinkedSheetInfo> =
            serde_json::from_str(&json)
                .map_err(|e| format!("Failed to parse linked sheets metadata: {}", e))?;
        *linked = infos;
    }

    Ok(())
}

// ============================================================================
// SCRIPTS & NOTEBOOKS (save/restore via .cala features)
// ============================================================================

/// Collect scripts from ScriptState into SavedScript format for persistence.
fn collect_scripts_for_save(
    script_state: &State<crate::scripting::types::ScriptState>,
) -> Vec<persistence::SavedScript> {
    let scripts = script_state.workbook_scripts.lock().unwrap();
    scripts
        .values()
        .map(|s| persistence::SavedScript {
            id: s.id.clone(),
            name: s.name.clone(),
            description: s.description.clone(),
            source: s.source.clone(),
        })
        .collect()
}

/// Collect notebooks from ScriptState into SavedNotebook format for persistence.
fn collect_notebooks_for_save(
    script_state: &State<crate::scripting::types::ScriptState>,
) -> Vec<persistence::SavedNotebook> {
    let notebooks = script_state.workbook_notebooks.lock().unwrap();
    notebooks
        .values()
        .map(|n| persistence::SavedNotebook {
            id: n.id.clone(),
            name: n.name.clone(),
            cells: n
                .cells
                .iter()
                .map(|c| persistence::SavedNotebookCell {
                    id: c.id.clone(),
                    source: c.source.clone(),
                    last_output: c.last_output.clone(),
                    last_error: c.last_error.clone(),
                    cells_modified: c.cells_modified,
                    duration_ms: c.duration_ms,
                    execution_index: c.execution_index,
                })
                .collect(),
        })
        .collect()
}

/// Restore scripts from saved data into ScriptState.
fn restore_scripts(
    saved: &[persistence::SavedScript],
    script_state: &State<crate::scripting::types::ScriptState>,
) {
    let mut scripts = script_state.workbook_scripts.lock().unwrap();
    scripts.clear();
    for s in saved {
        scripts.insert(
            s.id.clone(),
            crate::scripting::types::WorkbookScript {
                id: s.id.clone(),
                name: s.name.clone(),
                description: s.description.clone(),
                source: s.source.clone(),
            },
        );
    }
}

/// Restore notebooks from saved data into ScriptState.
fn restore_notebooks(
    saved: &[persistence::SavedNotebook],
    script_state: &State<crate::scripting::types::ScriptState>,
) {
    let mut notebooks = script_state.workbook_notebooks.lock().unwrap();
    notebooks.clear();
    for n in saved {
        notebooks.insert(
            n.id.clone(),
            crate::scripting::types::NotebookDocument {
                id: n.id.clone(),
                name: n.name.clone(),
                cells: n
                    .cells
                    .iter()
                    .map(|c| crate::scripting::types::NotebookCell {
                        id: c.id.clone(),
                        source: c.source.clone(),
                        last_output: c.last_output.clone(),
                        last_error: c.last_error.clone(),
                        cells_modified: c.cells_modified,
                        duration_ms: c.duration_ms,
                        execution_index: c.execution_index,
                    })
                    .collect(),
            },
        );
    }
}
