// FILENAME: app\src-tauri\src\persistence.rs
use crate::api_types::CellData;
use crate::{format_cell_value, AppState};
use persistence::{load_xlsx, save_xlsx, DimensionData, Workbook};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct FileState {
    pub current_path: Mutex<Option<PathBuf>>,
    pub is_modified: Mutex<bool>,
}

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

    let dimensions = DimensionData {
        column_widths: col_widths.clone(),
        row_heights: row_heights.clone(),
    };

    let workbook = Workbook::from_grid(&grid, &styles, &dimensions);
    let path_buf = PathBuf::from(&path);

    save_xlsx(&workbook, &path_buf).map_err(|e| e.to_string())?;

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
    let workbook = load_xlsx(&path_buf).map_err(|e| e.to_string())?;

    if workbook.sheets.is_empty() {
        return Err("No sheets in workbook".to_string());
    }

    let sheet = &workbook.sheets[workbook.active_sheet];
    let (new_grid, new_styles) = sheet.to_grid();

    {
        let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
        let mut styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        let mut col_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
        let mut row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
        let mut deps = state.dependents.lock().map_err(|e| e.to_string())?;

        *grid = new_grid;
        *styles = new_styles;
        *col_widths = sheet.column_widths.clone();
        *row_heights = sheet.row_heights.clone();
        deps.clear();
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
                style_index: cell.style_index,
                row_span: 1,
                col_span: 1,
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

        *grid = engine::grid::Grid::new();
        *styles = engine::style::StyleRegistry::new();
        col_widths.clear();
        row_heights.clear();
        deps.clear();
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