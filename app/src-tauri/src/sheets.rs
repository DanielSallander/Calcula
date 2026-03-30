//! FILENAME: app/src-tauri/src/sheets.rs
// PURPOSE: Sheet management commands for multi-sheet workbook support.
// CONTEXT: Provides Tauri commands for creating, switching, renaming, deleting,
//          moving, copying, hiding/unhiding sheets, tab colors, and freeze panes.

use std::collections::HashMap;
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

/// Split window configuration for a sheet.
/// Unlike freeze panes, split windows allow independent scrolling in each quadrant.
/// The split position is stored as a row/column index.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SplitConfig {
    pub split_row: Option<u32>,
    pub split_col: Option<u32>,
}

/// Information about a single sheet (sent to frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfo {
    pub index: usize,
    pub name: String,
    pub freeze_row: Option<u32>,
    pub freeze_col: Option<u32>,
    /// Tab color as CSS hex string (e.g., "#ff0000"). Empty = no color.
    #[serde(default)]
    pub tab_color: String,
    /// Whether the sheet is hidden
    #[serde(default)]
    pub hidden: bool,
}

/// Result of get_sheets command
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetsResult {
    pub sheets: Vec<SheetInfo>,
    pub active_index: usize,
}

// ============================================================================
// Helper: build SheetInfo list from state vectors
// ============================================================================

fn build_sheet_list(
    sheet_names: &[String],
    freeze_configs: &[FreezeConfig],
    tab_colors: &[String],
    hidden_sheets: &[bool],
) -> Vec<SheetInfo> {
    sheet_names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let freeze = freeze_configs.get(index).cloned().unwrap_or_default();
            SheetInfo {
                index,
                name: name.clone(),
                freeze_row: freeze.freeze_row,
                freeze_col: freeze.freeze_col,
                tab_color: tab_colors.get(index).cloned().unwrap_or_default(),
                hidden: hidden_sheets.get(index).copied().unwrap_or(false),
            }
        })
        .collect()
}

/// Helper to ensure per-sheet Vec has enough entries, pushing defaults.
fn ensure_vec_len<T: Default>(v: &mut Vec<T>, min_len: usize) {
    while v.len() < min_len {
        v.push(T::default());
    }
}

// ============================================================================
// Existing Commands (updated for tab_color / hidden)
// ============================================================================

#[tauri::command]
pub fn get_sheets(state: State<AppState>) -> SheetsResult {
    let sheet_names = state.sheet_names.lock().unwrap();
    let active_index = *state.active_sheet.lock().unwrap();
    let freeze_configs = state.freeze_configs.lock().unwrap();
    let tab_colors = state.tab_colors.lock().unwrap();
    let hidden_sheets = state.hidden_sheets.lock().unwrap();

    SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &hidden_sheets),
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
    let tab_colors = state.tab_colors.lock().unwrap();
    let hidden_sheets = state.hidden_sheets.lock().unwrap();
    let mut column_widths = state.column_widths.lock().unwrap();
    let mut row_heights = state.row_heights.lock().unwrap();
    let mut all_column_widths = state.all_column_widths.lock().unwrap();
    let mut all_row_heights = state.all_row_heights.lock().unwrap();

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    while grids.len() <= index {
        grids.push(engine::grid::Grid::new());
    }

    // Ensure per-sheet dimension storage is large enough
    while all_column_widths.len() <= index {
        all_column_widths.push(HashMap::new());
    }
    while all_row_heights.len() <= index {
        all_row_heights.push(HashMap::new());
    }

    let old_index = *active_sheet;

    if old_index != index {
        if old_index < grids.len() {
            grids[old_index] = current_grid.clone();
        }
        *current_grid = grids[index].clone();

        // Swap dimensions: save current to old sheet, load from new sheet
        if old_index < all_column_widths.len() {
            all_column_widths[old_index] = std::mem::take(&mut *column_widths);
        }
        if old_index < all_row_heights.len() {
            all_row_heights[old_index] = std::mem::take(&mut *row_heights);
        }
        *column_widths = std::mem::take(&mut all_column_widths[index]);
        *row_heights = std::mem::take(&mut all_row_heights[index]);
    }

    *active_sheet = index;

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &hidden_sheets),
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
    let mut tab_colors = state.tab_colors.lock().unwrap();
    let mut hidden_sheets = state.hidden_sheets.lock().unwrap();
    let mut column_widths = state.column_widths.lock().unwrap();
    let mut row_heights = state.row_heights.lock().unwrap();
    let mut all_column_widths = state.all_column_widths.lock().unwrap();
    let mut all_row_heights = state.all_row_heights.lock().unwrap();

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

    // Save current sheet's dimensions before switching
    while all_column_widths.len() <= old_index {
        all_column_widths.push(HashMap::new());
    }
    while all_row_heights.len() <= old_index {
        all_row_heights.push(HashMap::new());
    }
    all_column_widths[old_index] = std::mem::take(&mut *column_widths);
    all_row_heights[old_index] = std::mem::take(&mut *row_heights);

    sheet_names.push(new_name);
    let new_grid = engine::grid::Grid::new();
    grids.push(new_grid.clone());
    freeze_configs.push(FreezeConfig::default());
    {
        let mut split_configs = state.split_configs.lock().unwrap();
        split_configs.push(SplitConfig::default());
    }
    tab_colors.push(String::new());
    hidden_sheets.push(false);
    // New sheet gets empty dimensions
    all_column_widths.push(HashMap::new());
    all_row_heights.push(HashMap::new());

    let new_index = sheet_names.len() - 1;
    *active_sheet = new_index;
    *current_grid = new_grid;

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &hidden_sheets),
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
    let mut tab_colors = state.tab_colors.lock().unwrap();
    let mut hidden_sheets = state.hidden_sheets.lock().unwrap();
    let mut tables = state.tables.lock().unwrap();
    let mut table_names = state.table_names.lock().unwrap();
    let mut column_widths = state.column_widths.lock().unwrap();
    let mut row_heights = state.row_heights.lock().unwrap();
    let mut all_column_widths = state.all_column_widths.lock().unwrap();
    let mut all_row_heights = state.all_row_heights.lock().unwrap();

    if sheet_names.len() <= 1 {
        return Err("Cannot delete the last sheet".to_string());
    }

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    let old_active = *active_sheet;
    let deleted_name = sheet_names[index].clone();

    if old_active < grids.len() {
        grids[old_active] = current_grid.clone();
    }

    // Save current dimensions to per-sheet storage before deletion
    while all_column_widths.len() <= old_active {
        all_column_widths.push(HashMap::new());
    }
    while all_row_heights.len() <= old_active {
        all_row_heights.push(HashMap::new());
    }
    all_column_widths[old_active] = std::mem::take(&mut *column_widths);
    all_row_heights[old_active] = std::mem::take(&mut *row_heights);

    // Remove tables on the deleted sheet and update name registry
    if let Some(sheet_tables) = tables.remove(&index) {
        for table in sheet_tables.values() {
            table_names.remove(&table.name.to_uppercase());
        }
    }

    // Re-key tables for sheets above the deleted index (shift down by 1)
    let keys_to_shift: Vec<usize> = tables.keys().filter(|&&k| k > index).cloned().collect();
    for old_key in keys_to_shift {
        if let Some(sheet_tables) = tables.remove(&old_key) {
            let new_key = old_key - 1;
            for table in sheet_tables.values() {
                if let Some(entry) = table_names.get_mut(&table.name.to_uppercase()) {
                    entry.0 = new_key;
                }
            }
            let mut updated_tables = sheet_tables;
            for table in updated_tables.values_mut() {
                table.sheet_index = new_key;
            }
            tables.insert(new_key, updated_tables);
        }
    }

    sheet_names.remove(index);
    if index < grids.len() {
        grids.remove(index);
    }

    // Repair 3D reference bookends in all formulas
    let names_after = sheet_names.clone();
    crate::repair_all_formulas(&mut grids, &|formula| {
        crate::repair_3d_refs_on_delete(formula, &deleted_name, &names_after)
    });
    if index < freeze_configs.len() {
        freeze_configs.remove(index);
    }
    {
        let mut split_configs = state.split_configs.lock().unwrap();
        if index < split_configs.len() {
            split_configs.remove(index);
        }
    }
    if index < tab_colors.len() {
        tab_colors.remove(index);
    }
    if index < hidden_sheets.len() {
        hidden_sheets.remove(index);
    }
    if index < all_column_widths.len() {
        all_column_widths.remove(index);
    }
    if index < all_row_heights.len() {
        all_row_heights.remove(index);
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

    // Load new active sheet's dimensions
    if new_active < all_column_widths.len() {
        *column_widths = std::mem::take(&mut all_column_widths[new_active]);
    }
    if new_active < all_row_heights.len() {
        *row_heights = std::mem::take(&mut all_row_heights[new_active]);
    }

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &hidden_sheets),
        active_index: *active_sheet,
    })
}

#[tauri::command]
pub fn rename_sheet(state: State<AppState>, index: usize, new_name: String) -> Result<SheetsResult, String> {
    let mut sheet_names = state.sheet_names.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let freeze_configs = state.freeze_configs.lock().unwrap();
    let tab_colors = state.tab_colors.lock().unwrap();
    let hidden_sheets = state.hidden_sheets.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let mut current_grid = state.grid.lock().unwrap();

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

    let old_name = sheet_names[index].clone();
    sheet_names[index] = trimmed_name.clone();

    // Sync current grid before repairing formulas
    if active_sheet < grids.len() {
        grids[active_sheet] = current_grid.clone();
    }

    // Repair cross-sheet and 3D reference bookends in all formulas
    let old = old_name.clone();
    let new_n = trimmed_name.clone();
    crate::repair_all_formulas(&mut grids, &|formula| {
        Some(crate::repair_3d_refs_on_rename(formula, &old, &new_n))
    });

    // Sync back the active grid
    if active_sheet < grids.len() {
        *current_grid = grids[active_sheet].clone();
    }

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &hidden_sheets),
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
    let tab_colors = state.tab_colors.lock().unwrap();
    let hidden_sheets = state.hidden_sheets.lock().unwrap();

    // Ensure freeze_configs has enough entries
    while freeze_configs.len() <= active_sheet {
        freeze_configs.push(FreezeConfig::default());
    }

    freeze_configs[active_sheet] = FreezeConfig {
        freeze_row,
        freeze_col,
    };

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &hidden_sheets),
        active_index: active_sheet,
    })
}

#[tauri::command]
pub fn get_freeze_panes(state: State<AppState>) -> FreezeConfig {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let freeze_configs = state.freeze_configs.lock().unwrap();

    freeze_configs.get(active_sheet).cloned().unwrap_or_default()
}

// ============================================================================
// Split Window Commands
// ============================================================================

#[tauri::command]
pub fn set_split_window(
    state: State<AppState>,
    split_row: Option<u32>,
    split_col: Option<u32>,
) -> Result<(), String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut split_configs = state.split_configs.lock().unwrap();

    // Ensure split_configs has enough entries
    while split_configs.len() <= active_sheet {
        split_configs.push(SplitConfig::default());
    }

    split_configs[active_sheet] = SplitConfig {
        split_row,
        split_col,
    };

    Ok(())
}

#[tauri::command]
pub fn get_split_window(state: State<AppState>) -> SplitConfig {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let split_configs = state.split_configs.lock().unwrap();

    split_configs.get(active_sheet).cloned().unwrap_or_default()
}

// ============================================================================
// New Commands: Move, Copy, Hide/Unhide, Tab Color
// ============================================================================

/// Move a sheet from one position to another.
#[tauri::command]
pub fn move_sheet(
    state: State<AppState>,
    from_index: usize,
    to_index: usize,
) -> Result<SheetsResult, String> {
    let mut sheet_names = state.sheet_names.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let mut active_sheet = state.active_sheet.lock().unwrap();
    let mut current_grid = state.grid.lock().unwrap();
    let mut freeze_configs = state.freeze_configs.lock().unwrap();
    let mut tab_colors = state.tab_colors.lock().unwrap();
    let mut hidden_sheets = state.hidden_sheets.lock().unwrap();
    let mut column_widths = state.column_widths.lock().unwrap();
    let mut row_heights = state.row_heights.lock().unwrap();
    let mut all_column_widths = state.all_column_widths.lock().unwrap();
    let mut all_row_heights = state.all_row_heights.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    let count = sheet_names.len();
    if from_index >= count {
        return Err(format!("Source sheet index {} out of range", from_index));
    }
    if to_index >= count {
        return Err(format!("Target sheet index {} out of range", to_index));
    }
    if from_index == to_index {
        return Ok(SheetsResult {
            sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &hidden_sheets),
            active_index: *active_sheet,
        });
    }

    // Sync active grid to storage first
    let old_active = *active_sheet;
    if old_active < grids.len() {
        grids[old_active] = current_grid.clone();
    }
    ensure_vec_len(&mut all_column_widths, count);
    ensure_vec_len(&mut all_row_heights, count);
    if old_active < all_column_widths.len() {
        all_column_widths[old_active] = std::mem::take(&mut *column_widths);
    }
    if old_active < all_row_heights.len() {
        all_row_heights[old_active] = std::mem::take(&mut *row_heights);
    }

    // Helper: rotate an element in a Vec from `from` to `to`
    fn rotate_element<T>(v: &mut Vec<T>, from: usize, to: usize) {
        if from < to {
            // Move right: rotate left the subslice [from..=to]
            v[from..=to].rotate_left(1);
        } else {
            // Move left: rotate right the subslice [to..=from]
            v[to..=from].rotate_right(1);
        }
    }

    // Ensure all per-sheet vecs are long enough
    ensure_vec_len(&mut freeze_configs, count);
    ensure_vec_len(&mut tab_colors, count);
    ensure_vec_len(&mut hidden_sheets, count);
    ensure_vec_len(&mut page_setups, count);

    rotate_element(&mut *sheet_names, from_index, to_index);
    rotate_element(&mut *grids, from_index, to_index);
    rotate_element(&mut *freeze_configs, from_index, to_index);
    {
        let mut split_configs = state.split_configs.lock().unwrap();
        ensure_vec_len(&mut split_configs, count);
        rotate_element(&mut *split_configs, from_index, to_index);
    }
    rotate_element(&mut *tab_colors, from_index, to_index);
    rotate_element(&mut *hidden_sheets, from_index, to_index);
    rotate_element(&mut *all_column_widths, from_index, to_index);
    rotate_element(&mut *all_row_heights, from_index, to_index);
    rotate_element(&mut *page_setups, from_index, to_index);

    // Update active_sheet to follow the moved sheet
    let new_active = if old_active == from_index {
        to_index
    } else if from_index < to_index {
        // Moved right: sheets in [from+1..=to] shifted left by 1
        if old_active > from_index && old_active <= to_index {
            old_active - 1
        } else {
            old_active
        }
    } else {
        // Moved left: sheets in [to..from-1] shifted right by 1
        if old_active >= to_index && old_active < from_index {
            old_active + 1
        } else {
            old_active
        }
    };

    *active_sheet = new_active;
    *current_grid = grids[new_active].clone();
    *column_widths = std::mem::take(&mut all_column_widths[new_active]);
    *row_heights = std::mem::take(&mut all_row_heights[new_active]);

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &hidden_sheets),
        active_index: new_active,
    })
}

/// Copy a sheet to a new position.
#[tauri::command]
pub fn copy_sheet(
    state: State<AppState>,
    source_index: usize,
    new_name: Option<String>,
) -> Result<SheetsResult, String> {
    let mut sheet_names = state.sheet_names.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let mut active_sheet = state.active_sheet.lock().unwrap();
    let mut current_grid = state.grid.lock().unwrap();
    let mut freeze_configs = state.freeze_configs.lock().unwrap();
    let mut tab_colors = state.tab_colors.lock().unwrap();
    let mut hidden_sheets = state.hidden_sheets.lock().unwrap();
    let mut column_widths = state.column_widths.lock().unwrap();
    let mut row_heights = state.row_heights.lock().unwrap();
    let mut all_column_widths = state.all_column_widths.lock().unwrap();
    let mut all_row_heights = state.all_row_heights.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    let count = sheet_names.len();
    if source_index >= count {
        return Err(format!("Source sheet index {} out of range", source_index));
    }

    // Sync active grid
    let old_active = *active_sheet;
    if old_active < grids.len() {
        grids[old_active] = current_grid.clone();
    }
    ensure_vec_len(&mut all_column_widths, count);
    ensure_vec_len(&mut all_row_heights, count);
    if old_active < all_column_widths.len() {
        all_column_widths[old_active] = std::mem::take(&mut *column_widths);
    }
    if old_active < all_row_heights.len() {
        all_row_heights[old_active] = std::mem::take(&mut *row_heights);
    }

    // Generate copy name
    let copy_name = new_name.unwrap_or_else(|| {
        let base = &sheet_names[source_index];
        let mut counter = 2;
        loop {
            let candidate = format!("{} ({})", base, counter);
            if !sheet_names.contains(&candidate) {
                return candidate;
            }
            counter += 1;
        }
    });

    if sheet_names.contains(&copy_name) {
        return Err(format!("Sheet '{}' already exists", copy_name));
    }

    // Clone source data
    let cloned_grid = grids[source_index].clone();
    ensure_vec_len(&mut freeze_configs, count);
    ensure_vec_len(&mut tab_colors, count);
    ensure_vec_len(&mut hidden_sheets, count);
    ensure_vec_len(&mut page_setups, count);

    let cloned_freeze = freeze_configs[source_index].clone();
    let cloned_tab_color = tab_colors[source_index].clone();
    let cloned_widths = all_column_widths[source_index].clone();
    let cloned_heights = all_row_heights[source_index].clone();
    let cloned_page_setup = page_setups[source_index].clone();

    // Insert right after the source
    let insert_at = source_index + 1;
    sheet_names.insert(insert_at, copy_name);
    grids.insert(insert_at, cloned_grid.clone());
    freeze_configs.insert(insert_at, cloned_freeze);
    {
        let mut split_configs = state.split_configs.lock().unwrap();
        ensure_vec_len(&mut split_configs, count);
        let cloned_split = split_configs[source_index].clone();
        split_configs.insert(insert_at, cloned_split);
    }
    tab_colors.insert(insert_at, cloned_tab_color);
    hidden_sheets.insert(insert_at, false); // Copy is always visible
    all_column_widths.insert(insert_at, cloned_widths);
    all_row_heights.insert(insert_at, cloned_heights);
    page_setups.insert(insert_at, cloned_page_setup);

    // Switch to the new copy
    let new_index = insert_at;
    *active_sheet = new_index;
    *current_grid = cloned_grid;
    *column_widths = std::mem::take(&mut all_column_widths[new_index]);
    *row_heights = std::mem::take(&mut all_row_heights[new_index]);

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &hidden_sheets),
        active_index: new_index,
    })
}

/// Hide a sheet. Cannot hide the last visible sheet.
/// Returns the recommended new active_index (frontend should call set_active_sheet if it changed).
#[tauri::command]
pub fn hide_sheet(
    state: State<AppState>,
    index: usize,
) -> Result<SheetsResult, String> {
    let sheet_names = state.sheet_names.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let freeze_configs = state.freeze_configs.lock().unwrap();
    let tab_colors = state.tab_colors.lock().unwrap();
    let mut hidden_sheets = state.hidden_sheets.lock().unwrap();

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    ensure_vec_len(&mut hidden_sheets, sheet_names.len());

    // Check: at least one visible sheet must remain
    let visible_count = hidden_sheets.iter().enumerate()
        .filter(|(i, &h)| !h && *i != index)
        .count();
    if visible_count == 0 {
        return Err("Cannot hide the last visible sheet".to_string());
    }

    hidden_sheets[index] = true;

    // If hiding the active sheet, recommend the nearest visible sheet
    let recommended_active = if index == active_sheet {
        (0..sheet_names.len())
            .find(|&i| !hidden_sheets[i])
            .unwrap_or(0)
    } else {
        active_sheet
    };

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &hidden_sheets),
        active_index: recommended_active,
    })
}

/// Unhide a sheet.
#[tauri::command]
pub fn unhide_sheet(
    state: State<AppState>,
    index: usize,
) -> Result<SheetsResult, String> {
    let sheet_names = state.sheet_names.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let freeze_configs = state.freeze_configs.lock().unwrap();
    let tab_colors = state.tab_colors.lock().unwrap();
    let mut hidden_sheets = state.hidden_sheets.lock().unwrap();

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    ensure_vec_len(&mut hidden_sheets, sheet_names.len());
    hidden_sheets[index] = false;

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &hidden_sheets),
        active_index: active_sheet,
    })
}

/// Set the tab color for a sheet.
#[tauri::command]
pub fn set_tab_color(
    state: State<AppState>,
    index: usize,
    color: String,
) -> Result<SheetsResult, String> {
    let sheet_names = state.sheet_names.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let freeze_configs = state.freeze_configs.lock().unwrap();
    let mut tab_colors = state.tab_colors.lock().unwrap();
    let hidden_sheets = state.hidden_sheets.lock().unwrap();

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    ensure_vec_len(&mut tab_colors, sheet_names.len());
    tab_colors[index] = color;

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &hidden_sheets),
        active_index: active_sheet,
    })
}
