// FILENAME: src-tauri/src/undo_commands.rs
// PURPOSE: Tauri commands for undo/redo operations.

use crate::api_types::CellData;
use crate::{format_cell_value, AppState};
use engine::{CellChange, Transaction};
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
pub fn undo(state: State<AppState>) -> UndoResult {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut column_widths = state.column_widths.lock().unwrap();
    let mut row_heights = state.row_heights.lock().unwrap();

    let transaction = match undo_stack.pop_undo() {
        Some(t) => t,
        None => {
            return UndoResult {
                success: false,
                description: None,
                updated_cells: Vec::new(),
                can_undo: false,
                can_redo: undo_stack.can_redo(),
            };
        }
    };

    let description = transaction.description.clone();
    let mut updated_cells = Vec::new();
    
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
                        let display = format_cell_value(&cell.value, style);
                        updated_cells.push(CellData {
                            row: *row,
                            col: *col,
                            display,
                            formula: cell.formula.clone(),
                            style_index: cell.style_index,
                            row_span: 1,
                            col_span: 1,
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
                            formula: None,
                            style_index: 0,
                            row_span: 1,
                            col_span: 1,
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
        }
    }

    // Push to redo stack
    undo_stack.push_redo(redo_transaction);

    UndoResult {
        success: true,
        description: Some(description),
        updated_cells,
        can_undo: undo_stack.can_undo(),
        can_redo: undo_stack.can_redo(),
    }
}

/// Perform redo operation.
#[tauri::command]
pub fn redo(state: State<AppState>) -> UndoResult {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut column_widths = state.column_widths.lock().unwrap();
    let mut row_heights = state.row_heights.lock().unwrap();

    let transaction = match undo_stack.pop_redo() {
        Some(t) => t,
        None => {
            return UndoResult {
                success: false,
                description: None,
                updated_cells: Vec::new(),
                can_undo: undo_stack.can_undo(),
                can_redo: false,
            };
        }
    };

    let description = transaction.description.clone();
    let mut updated_cells = Vec::new();
    
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
                        let display = format_cell_value(&cell.value, style);
                        updated_cells.push(CellData {
                            row: *row,
                            col: *col,
                            display,
                            formula: cell.formula.clone(),
                            style_index: cell.style_index,
                            row_span: 1,
                            col_span: 1,
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
                            formula: None,
                            style_index: 0,
                            row_span: 1,
                            col_span: 1,
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
        }
    }

    // Push to undo stack (without clearing redo)
    undo_stack.push_undo_for_redo(undo_transaction);

    UndoResult {
        success: true,
        description: Some(description),
        updated_cells,
        can_undo: undo_stack.can_undo(),
        can_redo: undo_stack.can_redo(),
    }
}

/// Clear undo/redo history (e.g., when opening a new file).
#[tauri::command]
pub fn clear_undo_history(state: State<AppState>) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.clear();
}