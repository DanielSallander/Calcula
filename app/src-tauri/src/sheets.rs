// FILENAME: src-tauri/src/sheets.rs
// PURPOSE: Sheet management commands for multi-sheet workbook support.
// CONTEXT: Provides Tauri commands for creating, switching, renaming, and deleting sheets.
// UPDATED: Fixed grid synchronization - now properly syncs state.grid with grids[active_sheet]

use tauri::State;
use crate::AppState;
use serde::{Deserialize, Serialize};

/// Information about a single sheet (sent to frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfo {
    pub index: usize,
    pub name: String,
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

    let sheets: Vec<SheetInfo> = sheet_names
        .iter()
        .enumerate()
        .map(|(index, name)| SheetInfo {
            index,
            name: name.clone(),
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

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    // Ensure grids vector has enough entries
    while grids.len() <= index {
        grids.push(engine::grid::Grid::new());
    }

    let old_index = *active_sheet;
    
    // Only sync if actually changing sheets
    if old_index != index {
        // Save current grid back to grids[old_index]
        if old_index < grids.len() {
            grids[old_index] = current_grid.clone();
        }

        // Load grids[new_index] into current_grid
        *current_grid = grids[index].clone();
    }

    *active_sheet = index;

    let sheets: Vec<SheetInfo> = sheet_names
        .iter()
        .enumerate()
        .map(|(i, name)| SheetInfo {
            index: i,
            name: name.clone(),
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

    // Generate a default name if not provided
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

    // Check for duplicate names
    if sheet_names.contains(&new_name) {
        return Err(format!("Sheet '{}' already exists", new_name));
    }

    let old_index = *active_sheet;
    
    // Save current grid back to grids[old_index] before switching
    if old_index < grids.len() {
        grids[old_index] = current_grid.clone();
    }

    // Add new sheet
    sheet_names.push(new_name);
    let new_grid = engine::grid::Grid::new();
    grids.push(new_grid.clone());
    
    // Switch to the new sheet
    let new_index = sheet_names.len() - 1;
    *active_sheet = new_index;
    
    // Load the new empty grid as current
    *current_grid = new_grid;

    let sheets: Vec<SheetInfo> = sheet_names
        .iter()
        .enumerate()
        .map(|(i, name)| SheetInfo {
            index: i,
            name: name.clone(),
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

    // Must have at least one sheet
    if sheet_names.len() <= 1 {
        return Err("Cannot delete the last sheet".to_string());
    }

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    let old_active = *active_sheet;

    // Save current grid before any modifications
    if old_active < grids.len() {
        grids[old_active] = current_grid.clone();
    }

    // Remove the sheet
    sheet_names.remove(index);
    if index < grids.len() {
        grids.remove(index);
    }

    // Adjust active sheet index
    let new_active = if old_active >= sheet_names.len() {
        // Was on last sheet which got deleted or shifted
        sheet_names.len() - 1
    } else if old_active > index {
        // Active sheet was after deleted sheet
        old_active - 1
    } else if old_active == index {
        // Deleted the active sheet, stay at same index if possible
        if index < sheet_names.len() {
            index
        } else {
            sheet_names.len() - 1
        }
    } else {
        // Active sheet was before deleted sheet, no change needed
        old_active
    };

    *active_sheet = new_active;
    
    // Load the new active sheet's grid
    if new_active < grids.len() {
        *current_grid = grids[new_active].clone();
    } else {
        *current_grid = engine::grid::Grid::new();
    }

    let sheets: Vec<SheetInfo> = sheet_names
        .iter()
        .enumerate()
        .map(|(i, name)| SheetInfo {
            index: i,
            name: name.clone(),
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

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    let trimmed_name = new_name.trim().to_string();
    if trimmed_name.is_empty() {
        return Err("Sheet name cannot be empty".to_string());
    }

    // Check for duplicate names (excluding current sheet)
    for (i, name) in sheet_names.iter().enumerate() {
        if i != index && name == &trimmed_name {
            return Err(format!("Sheet '{}' already exists", trimmed_name));
        }
    }

    sheet_names[index] = trimmed_name;

    let sheets: Vec<SheetInfo> = sheet_names
        .iter()
        .enumerate()
        .map(|(i, name)| SheetInfo {
            index: i,
            name: name.clone(),
        })
        .collect();

    Ok(SheetsResult {
        sheets,
        active_index: active_sheet,
    })
}