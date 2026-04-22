//! FILENAME: app/src-tauri/src/undo_commands.rs
// PURPOSE: Tauri commands for undo/redo operations.

use crate::api_types::{CellData, MergedRegion};
use crate::persistence::FileState;
use crate::{format_cell_value, AppState};
use engine::{CellChange, GridSnapshot, Transaction, UndoMergeRegion};
use serde::Serialize;
use tauri::State;

/// Result of an undo/redo operation
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    /// Whether the operation succeeded
    pub success: bool,
    /// Description of what was undone/redone
    pub description: Option<String>,
    /// Cells that were modified
    pub updated_cells: Vec<CellData>,
    /// Whether more undo operations are available
    pub can_undo: bool,
    /// Whether more redo operations are available
    pub can_redo: bool,
    /// Whether merged regions changed (frontend should refresh merge info)
    pub merge_changed: bool,
    /// Whether a structural restore occurred (frontend should do a full refresh)
    pub structural_restore: bool,
}

/// Get current undo/redo state
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoState {
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_description: Option<String>,
    pub redo_description: Option<String>,
}

/// Convert engine::UndoMergeRegion to api_types::MergedRegion
fn to_api_region(r: &UndoMergeRegion) -> MergedRegion {
    MergedRegion {
        start_row: r.start_row,
        start_col: r.start_col,
        end_row: r.end_row,
        end_col: r.end_col,
    }
}

/// Convert api_types::MergedRegion to engine::UndoMergeRegion
fn to_undo_region(r: &MergedRegion) -> UndoMergeRegion {
    UndoMergeRegion {
        start_row: r.start_row,
        start_col: r.start_col,
        end_row: r.end_row,
        end_col: r.end_col,
    }
}

/// Begin a transaction for batching multiple changes.
#[tauri::command]
pub fn begin_undo_transaction(state: State<AppState>, description: String) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.begin_transaction(description);
}

/// Commit the current transaction.
#[tauri::command]
pub fn commit_undo_transaction(state: State<AppState>) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.commit_transaction();
}

/// Cancel the current transaction.
#[tauri::command]
pub fn cancel_undo_transaction(state: State<AppState>) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.cancel_transaction();
}

/// Get current undo/redo state for UI.
#[tauri::command]
pub fn get_undo_state(state: State<AppState>) -> UndoState {
    let undo_stack = state.undo_stack.lock().unwrap();
    UndoState {
        can_undo: undo_stack.can_undo(),
        can_redo: undo_stack.can_redo(),
        undo_description: undo_stack.undo_description().map(String::from),
        redo_description: undo_stack.redo_description().map(String::from),
    }
}

/// Perform undo operation.
#[tauri::command]
pub fn undo(state: State<AppState>, file_state: State<FileState>) -> UndoResult {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut column_widths = state.column_widths.lock().unwrap();
    let mut row_heights = state.row_heights.lock().unwrap();
    let mut merged_regions = state.merged_regions.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    let transaction = match undo_stack.pop_undo() {
        Some(t) => t,
        None => {
            return UndoResult {
                success: false,
                description: None,
                updated_cells: Vec::new(),
                can_undo: false,
                can_redo: undo_stack.can_redo(),
                merge_changed: false,
                structural_restore: false,
            };
        }
    };

    let description = transaction.description.clone();
    let mut updated_cells = Vec::new();
    let mut merge_changed = false;
    let mut structural_restore = false;

    // Build the inverse transaction for redo
    let mut redo_transaction = Transaction::new(description.clone());

    // Apply changes in REVERSE order for proper undo semantics
    for change in transaction.changes.iter().rev() {
        match change {
            CellChange::SetCell { row, col, previous } => {
                // Save current state for redo
                let current = grid.get_cell(*row, *col).cloned();
                redo_transaction.add_change(CellChange::SetCell {
                    row: *row,
                    col: *col,
                    previous: current,
                });

                // Restore previous state
                match previous {
                    Some(cell) => {
                        grid.set_cell(*row, *col, cell.clone());
                        if active_sheet < grids.len() {
                            grids[active_sheet].set_cell(*row, *col, cell.clone());
                        }
                        let style = styles.get(cell.style_index);
                        let display = format_cell_value(&cell.value, style, &locale);
                        updated_cells.push(CellData {
                            row: *row,
                            col: *col,
                            display,
                            display_color: None,
                            formula: cell.formula.clone(),
                            style_index: cell.style_index,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                            rich_text: None,
                            accounting_layout: None,
                        });
                    }
                    None => {
                        grid.clear_cell(*row, *col);
                        if active_sheet < grids.len() {
                            grids[active_sheet].clear_cell(*row, *col);
                        }
                        updated_cells.push(CellData {
                            row: *row,
                            col: *col,
                            display: String::new(),
                            display_color: None,
                            formula: None,
                            style_index: 0,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                            rich_text: None,
                            accounting_layout: None,
                        });
                    }
                }
            }
            CellChange::SetColumnWidth { col, previous } => {
                let current = column_widths.get(col).copied();
                redo_transaction.add_change(CellChange::SetColumnWidth {
                    col: *col,
                    previous: current,
                });

                match previous {
                    Some(width) => {
                        column_widths.insert(*col, *width);
                    }
                    None => {
                        column_widths.remove(col);
                    }
                }
            }
            CellChange::SetRowHeight { row, previous } => {
                let current = row_heights.get(row).copied();
                redo_transaction.add_change(CellChange::SetRowHeight {
                    row: *row,
                    previous: current,
                });

                match previous {
                    Some(height) => {
                        row_heights.insert(*row, *height);
                    }
                    None => {
                        row_heights.remove(row);
                    }
                }
            }
            CellChange::AddMergeRegion(region) => {
                // Undo adding a merge = remove it
                let api_region = to_api_region(region);
                merged_regions.remove(&api_region);
                // Record inverse: removing this region (redo will add it back)
                redo_transaction.add_change(CellChange::RemoveMergeRegion(region.clone()));
                merge_changed = true;
            }
            CellChange::RemoveMergeRegion(region) => {
                // Undo removing a merge = add it back
                let api_region = to_api_region(region);
                merged_regions.insert(api_region);
                // Record inverse: adding this region (redo will remove it)
                redo_transaction.add_change(CellChange::AddMergeRegion(region.clone()));
                merge_changed = true;
            }
            CellChange::RestoreSnapshot(snapshot) => {
                // Save current state as the redo snapshot
                let current_snapshot = GridSnapshot {
                    cells: grid.cells.clone(),
                    row_heights: row_heights.clone(),
                    column_widths: column_widths.clone(),
                    merged_regions: merged_regions
                        .iter()
                        .map(|r| to_undo_region(r))
                        .collect(),
                    max_row: grid.max_row,
                    max_col: grid.max_col,
                };
                redo_transaction.add_change(CellChange::RestoreSnapshot(current_snapshot));

                // Restore from snapshot
                grid.cells = snapshot.cells.clone();
                grid.max_row = snapshot.max_row;
                grid.max_col = snapshot.max_col;
                *row_heights = snapshot.row_heights.clone();
                *column_widths = snapshot.column_widths.clone();
                merged_regions.clear();
                for r in &snapshot.merged_regions {
                    merged_regions.insert(to_api_region(r));
                }

                // Sync grids vector
                if active_sheet < grids.len() {
                    grids[active_sheet].cells = grid.cells.clone();
                    grids[active_sheet].max_row = grid.max_row;
                    grids[active_sheet].max_col = grid.max_col;
                }

                structural_restore = true;
                merge_changed = true;
            }
        }
    }

    // Push to redo stack
    undo_stack.push_redo(redo_transaction);

    // Mark workbook as dirty (undo changes data state)
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    UndoResult {
        success: true,
        description: Some(description),
        updated_cells,
        can_undo: undo_stack.can_undo(),
        can_redo: undo_stack.can_redo(),
        merge_changed,
        structural_restore,
    }
}

/// Perform redo operation.
#[tauri::command]
pub fn redo(state: State<AppState>, file_state: State<FileState>) -> UndoResult {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut column_widths = state.column_widths.lock().unwrap();
    let mut row_heights = state.row_heights.lock().unwrap();
    let mut merged_regions = state.merged_regions.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    let transaction = match undo_stack.pop_redo() {
        Some(t) => t,
        None => {
            return UndoResult {
                success: false,
                description: None,
                updated_cells: Vec::new(),
                can_undo: undo_stack.can_undo(),
                can_redo: false,
                merge_changed: false,
                structural_restore: false,
            };
        }
    };

    let description = transaction.description.clone();
    let mut updated_cells = Vec::new();
    let mut merge_changed = false;
    let mut structural_restore = false;

    // Build the inverse transaction for undo
    let mut undo_transaction = Transaction::new(description.clone());

    // Apply changes in REVERSE order
    for change in transaction.changes.iter().rev() {
        match change {
            CellChange::SetCell { row, col, previous } => {
                let current = grid.get_cell(*row, *col).cloned();
                undo_transaction.add_change(CellChange::SetCell {
                    row: *row,
                    col: *col,
                    previous: current,
                });

                match previous {
                    Some(cell) => {
                        grid.set_cell(*row, *col, cell.clone());
                        if active_sheet < grids.len() {
                            grids[active_sheet].set_cell(*row, *col, cell.clone());
                        }
                        let style = styles.get(cell.style_index);
                        let display = format_cell_value(&cell.value, style, &locale);
                        updated_cells.push(CellData {
                            row: *row,
                            col: *col,
                            display,
                            display_color: None,
                            formula: cell.formula.clone(),
                            style_index: cell.style_index,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                            rich_text: None,
                            accounting_layout: None,
                        });
                    }
                    None => {
                        grid.clear_cell(*row, *col);
                        if active_sheet < grids.len() {
                            grids[active_sheet].clear_cell(*row, *col);
                        }
                        updated_cells.push(CellData {
                            row: *row,
                            col: *col,
                            display: String::new(),
                            display_color: None,
                            formula: None,
                            style_index: 0,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                            rich_text: None,
                            accounting_layout: None,
                        });
                    }
                }
            }
            CellChange::SetColumnWidth { col, previous } => {
                let current = column_widths.get(col).copied();
                undo_transaction.add_change(CellChange::SetColumnWidth {
                    col: *col,
                    previous: current,
                });

                match previous {
                    Some(width) => {
                        column_widths.insert(*col, *width);
                    }
                    None => {
                        column_widths.remove(col);
                    }
                }
            }
            CellChange::SetRowHeight { row, previous } => {
                let current = row_heights.get(row).copied();
                undo_transaction.add_change(CellChange::SetRowHeight {
                    row: *row,
                    previous: current,
                });

                match previous {
                    Some(height) => {
                        row_heights.insert(*row, *height);
                    }
                    None => {
                        row_heights.remove(row);
                    }
                }
            }
            CellChange::AddMergeRegion(region) => {
                // Redo adding a merge = add it back
                let api_region = to_api_region(region);
                merged_regions.insert(api_region);
                undo_transaction.add_change(CellChange::RemoveMergeRegion(region.clone()));
                merge_changed = true;
            }
            CellChange::RemoveMergeRegion(region) => {
                // Redo removing a merge = remove it
                let api_region = to_api_region(region);
                merged_regions.remove(&api_region);
                undo_transaction.add_change(CellChange::AddMergeRegion(region.clone()));
                merge_changed = true;
            }
            CellChange::RestoreSnapshot(snapshot) => {
                // Save current state as the undo snapshot
                let current_snapshot = GridSnapshot {
                    cells: grid.cells.clone(),
                    row_heights: row_heights.clone(),
                    column_widths: column_widths.clone(),
                    merged_regions: merged_regions
                        .iter()
                        .map(|r| to_undo_region(r))
                        .collect(),
                    max_row: grid.max_row,
                    max_col: grid.max_col,
                };
                undo_transaction.add_change(CellChange::RestoreSnapshot(current_snapshot));

                // Restore from snapshot
                grid.cells = snapshot.cells.clone();
                grid.max_row = snapshot.max_row;
                grid.max_col = snapshot.max_col;
                *row_heights = snapshot.row_heights.clone();
                *column_widths = snapshot.column_widths.clone();
                merged_regions.clear();
                for r in &snapshot.merged_regions {
                    merged_regions.insert(to_api_region(r));
                }

                // Sync grids vector
                if active_sheet < grids.len() {
                    grids[active_sheet].cells = grid.cells.clone();
                    grids[active_sheet].max_row = grid.max_row;
                    grids[active_sheet].max_col = grid.max_col;
                }

                structural_restore = true;
                merge_changed = true;
            }
        }
    }

    // Push to undo stack (without clearing redo)
    undo_stack.push_undo_for_redo(undo_transaction);

    // Mark workbook as dirty (redo changes data state)
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    UndoResult {
        success: true,
        description: Some(description),
        updated_cells,
        can_undo: undo_stack.can_undo(),
        can_redo: undo_stack.can_redo(),
        merge_changed,
        structural_restore,
    }
}

/// Clear undo/redo history (e.g., when opening a new file).
#[tauri::command]
pub fn clear_undo_history(state: State<AppState>) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.clear();
}
