//! FILENAME: app/src-tauri/src/sheets.rs
// PURPOSE: Sheet management commands for multi-sheet workbook support.
// CONTEXT: Provides Tauri commands for creating, switching, renaming, deleting sheets,
//          and managing freeze panes.

use tauri::State;
use crate::AppState;
use serde::{Deserialize, Serialize};

/// Freeze panes configuration for a sheet
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FreezeConfig {
    pub freeze_row: Option<u32>,
    pub freeze_col: Option<u32>,
}

/// Information about a single sheet (sent to frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfo {
    pub index: usize,
    pub name: String,
    pub freeze_row: Option<u32>,
    pub freeze_col: Option<u32>,
}

/// Result of get_sheets command
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetsResult {
    pub sheets: Vec<SheetInfo>,
    pub active_index: usize,
}

#[tauri::command]
pub fn get_sheets(state: State<AppState>) -> SheetsResult {
    let sheet_names = state.sheet_names.lock().unwrap();
    let active_index = *state.active_sheet.lock().unwrap();
    let freeze_configs = state.freeze_configs.lock().unwrap();

    let sheets: Vec<SheetInfo> = sheet_names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let freeze = freeze_configs.get(index).cloned().unwrap_or_default();
            SheetInfo {
                index,
                name: name.clone(),
                freeze_row: freeze.freeze_row,
                freeze_col: freeze.freeze_col,
            }
        })
        .collect();

    SheetsResult {
        sheets,
        active_index,
    }
}

#[tauri::command]
pub fn get_active_sheet(state: State<AppState>) -> usize {
    *state.active_sheet.lock().unwrap()
}

#[tauri::command]
pub fn set_active_sheet(state: State<AppState>, index: usize) -> Result<SheetsResult, String> {
    let sheet_names = state.sheet_names.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let mut active_sheet = state.active_sheet.lock().unwrap();
    let mut current_grid = state.grid.lock().unwrap();
    let freeze_configs = state.freeze_configs.lock().unwrap();

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    while grids.len() <= index {
        grids.push(engine::grid::Grid::new());
    }

    let old_index = *active_sheet;
    
    if old_index != index {
        if old_index < grids.len() {
            grids[old_index] = current_grid.clone();
        }
        *current_grid = grids[index].clone();
    }

    *active_sheet = index;

    let sheets: Vec<SheetInfo> = sheet_names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let freeze = freeze_configs.get(i).cloned().unwrap_or_default();
            SheetInfo {
                index: i,
                name: name.clone(),
                freeze_row: freeze.freeze_row,
                freeze_col: freeze.freeze_col,
            }
        })
        .collect();

    Ok(SheetsResult {
        sheets,
        active_index: index,
    })
}

#[tauri::command]
pub fn add_sheet(state: State<AppState>, name: Option<String>) -> Result<SheetsResult, String> {
    let mut sheet_names = state.sheet_names.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let mut active_sheet = state.active_sheet.lock().unwrap();
    let mut current_grid = state.grid.lock().unwrap();
    let mut freeze_configs = state.freeze_configs.lock().unwrap();

    let new_name = name.unwrap_or_else(|| {
        let mut counter = sheet_names.len() + 1;
        loop {
            let candidate = format!("Sheet{}", counter);
            if !sheet_names.contains(&candidate) {
                return candidate;
            }
            counter += 1;
        }
    });

    if sheet_names.contains(&new_name) {
        return Err(format!("Sheet '{}' already exists", new_name));
    }

    let old_index = *active_sheet;
    
    if old_index < grids.len() {
        grids[old_index] = current_grid.clone();
    }

    sheet_names.push(new_name);
    let new_grid = engine::grid::Grid::new();
    grids.push(new_grid.clone());
    freeze_configs.push(FreezeConfig::default());
    
    let new_index = sheet_names.len() - 1;
    *active_sheet = new_index;
    *current_grid = new_grid;

    let sheets: Vec<SheetInfo> = sheet_names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let freeze = freeze_configs.get(i).cloned().unwrap_or_default();
            SheetInfo {
                index: i,
                name: name.clone(),
                freeze_row: freeze.freeze_row,
                freeze_col: freeze.freeze_col,
            }
        })
        .collect();

    Ok(SheetsResult {
        sheets,
        active_index: *active_sheet,
    })
}

#[tauri::command]
pub fn delete_sheet(state: State<AppState>, index: usize) -> Result<SheetsResult, String> {
    let mut sheet_names = state.sheet_names.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let mut active_sheet = state.active_sheet.lock().unwrap();
    let mut current_grid = state.grid.lock().unwrap();
    let mut freeze_configs = state.freeze_configs.lock().unwrap();

    if sheet_names.len() <= 1 {
        return Err("Cannot delete the last sheet".to_string());
    }

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    let old_active = *active_sheet;

    if old_active < grids.len() {
        grids[old_active] = current_grid.clone();
    }

    sheet_names.remove(index);
    if index < grids.len() {
        grids.remove(index);
    }
    if index < freeze_configs.len() {
        freeze_configs.remove(index);
    }

    let new_active = if old_active >= sheet_names.len() {
        sheet_names.len() - 1
    } else if old_active > index {
        old_active - 1
    } else if old_active == index {
        if index < sheet_names.len() {
            index
        } else {
            sheet_names.len() - 1
        }
    } else {
        old_active
    };

    *active_sheet = new_active;
    
    if new_active < grids.len() {
        *current_grid = grids[new_active].clone();
    } else {
        *current_grid = engine::grid::Grid::new();
    }

    let sheets: Vec<SheetInfo> = sheet_names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let freeze = freeze_configs.get(i).cloned().unwrap_or_default();
            SheetInfo {
                index: i,
                name: name.clone(),
                freeze_row: freeze.freeze_row,
                freeze_col: freeze.freeze_col,
            }
        })
        .collect();

    Ok(SheetsResult {
        sheets,
        active_index: *active_sheet,
    })
}

#[tauri::command]
pub fn rename_sheet(state: State<AppState>, index: usize, new_name: String) -> Result<SheetsResult, String> {
    let mut sheet_names = state.sheet_names.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let freeze_configs = state.freeze_configs.lock().unwrap();

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    let trimmed_name = new_name.trim().to_string();
    if trimmed_name.is_empty() {
        return Err("Sheet name cannot be empty".to_string());
    }

    for (i, name) in sheet_names.iter().enumerate() {
        if i != index && name == &trimmed_name {
            return Err(format!("Sheet '{}' already exists", trimmed_name));
        }
    }

    sheet_names[index] = trimmed_name;

    let sheets: Vec<SheetInfo> = sheet_names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let freeze = freeze_configs.get(i).cloned().unwrap_or_default();
            SheetInfo {
                index: i,
                name: name.clone(),
                freeze_row: freeze.freeze_row,
                freeze_col: freeze.freeze_col,
            }
        })
        .collect();

    Ok(SheetsResult {
        sheets,
        active_index: active_sheet,
    })
}

#[tauri::command]
pub fn set_freeze_panes(
    state: State<AppState>,
    freeze_row: Option<u32>,
    freeze_col: Option<u32>,
) -> Result<SheetsResult, String> {
    let sheet_names = state.sheet_names.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut freeze_configs = state.freeze_configs.lock().unwrap();

    // Ensure freeze_configs has enough entries
    while freeze_configs.len() <= active_sheet {
        freeze_configs.push(FreezeConfig::default());
    }

    freeze_configs[active_sheet] = FreezeConfig {
        freeze_row,
        freeze_col,
    };

    let sheets: Vec<SheetInfo> = sheet_names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let freeze = freeze_configs.get(i).cloned().unwrap_or_default();
            SheetInfo {
                index: i,
                name: name.clone(),
                freeze_row: freeze.freeze_row,
                freeze_col: freeze.freeze_col,
            }
        })
        .collect();

    Ok(SheetsResult {
        sheets,
        active_index: active_sheet,
    })
}

#[tauri::command]
pub fn get_freeze_panes(state: State<AppState>) -> FreezeConfig {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let freeze_configs = state.freeze_configs.lock().unwrap();
    
    freeze_configs.get(active_sheet).cloned().unwrap_or_default()
}