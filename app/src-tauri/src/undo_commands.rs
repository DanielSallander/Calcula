//! FILENAME: app/src-tauri/src/undo_commands.rs
// PURPOSE: Tauri commands for undo/redo operations.

use crate::api_types::{CellData, MergedRegion};
use crate::persistence::FileState;
use crate::{
    extract_all_references, format_cell_value, update_column_dependencies,
    update_cross_sheet_dependencies, update_dependencies, update_row_dependencies, AppState,
};
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

/// Rebuild all formula dependency maps from scratch by scanning all cells.
/// Called after a structural restore (undo of insert/delete rows/cols) to fix
/// stale dependency tracking.
fn rebuild_all_dependencies(state: &AppState) {
    let grid = state.grid.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies = state.cross_sheet_dependencies.lock().unwrap();

    // Clear all maps
    dependents_map.clear();
    dependencies_map.clear();
    column_dependents_map.clear();
    column_dependencies_map.clear();
    row_dependents_map.clear();
    row_dependencies_map.clear();
    cross_sheet_dependents.clear();
    cross_sheet_dependencies.clear();

    // Scan all cells and rebuild
    for (&(row, col), cell) in &grid.cells {
        if let Some(ast) = &cell.ast {
            let refs = extract_all_references(ast, &grid);

            if !refs.cells.is_empty() {
                update_dependencies(
                    (row, col),
                    refs.cells,
                    &mut dependencies_map,
                    &mut dependents_map,
                );
            }
            if !refs.columns.is_empty() {
                update_column_dependencies(
                    (row, col),
                    refs.columns,
                    &mut column_dependencies_map,
                    &mut column_dependents_map,
                );
            }
            if !refs.rows.is_empty() {
                update_row_dependencies(
                    (row, col),
                    refs.rows,
                    &mut row_dependencies_map,
                    &mut row_dependents_map,
                );
            }
            if !refs.cross_sheet_cells.is_empty() {
                update_cross_sheet_dependencies(
                    (active_sheet, row, col),
                    refs.cross_sheet_cells,
                    &mut cross_sheet_dependencies,
                    &mut cross_sheet_dependents,
                );
            }
        }
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

/// Apply undo/redo changes and return the result.
/// Shared logic used by both `undo` and `redo` commands.
fn apply_changes(
    state: &AppState,
    file_state: &FileState,
    transaction: Transaction,
    is_undo: bool,
) -> UndoResult {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut column_widths = state.column_widths.lock().unwrap();
    let mut row_heights = state.row_heights.lock().unwrap();
    let mut merged_regions = state.merged_regions.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    let description = transaction.description.clone();
    let mut updated_cells = Vec::new();
    let mut merge_changed = false;
    let mut structural_restore = false;

    // Build the inverse transaction
    let mut inverse_transaction = Transaction::new(description.clone());

    // Apply changes in REVERSE order for proper undo/redo semantics
    for change in transaction.changes.iter().rev() {
        match change {
            CellChange::SetCell { row, col, previous } => {
                // Save current state for inverse
                let current = grid.get_cell(*row, *col).cloned();
                inverse_transaction.add_change(CellChange::SetCell {
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
                            formula: cell.formula_string().map(|f| format!("={}", f)),
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
                inverse_transaction.add_change(CellChange::SetColumnWidth {
                    col: *col,
                    previous: current,
                });
                match previous {
                    Some(width) => { column_widths.insert(*col, *width); }
                    None => { column_widths.remove(col); }
                }
            }
            CellChange::SetRowHeight { row, previous } => {
                let current = row_heights.get(row).copied();
                inverse_transaction.add_change(CellChange::SetRowHeight {
                    row: *row,
                    previous: current,
                });
                match previous {
                    Some(height) => { row_heights.insert(*row, *height); }
                    None => { row_heights.remove(row); }
                }
            }
            CellChange::AddMergeRegion(region) => {
                if is_undo {
                    // Undo adding = remove it
                    merged_regions.remove(&to_api_region(region));
                    inverse_transaction.add_change(CellChange::RemoveMergeRegion(region.clone()));
                } else {
                    // Redo adding = add it back
                    merged_regions.insert(to_api_region(region));
                    inverse_transaction.add_change(CellChange::RemoveMergeRegion(region.clone()));
                }
                merge_changed = true;
            }
            CellChange::RemoveMergeRegion(region) => {
                if is_undo {
                    // Undo removing = add it back
                    merged_regions.insert(to_api_region(region));
                    inverse_transaction.add_change(CellChange::AddMergeRegion(region.clone()));
                } else {
                    // Redo removing = remove it
                    merged_regions.remove(&to_api_region(region));
                    inverse_transaction.add_change(CellChange::AddMergeRegion(region.clone()));
                }
                merge_changed = true;
            }
            CellChange::RestoreSnapshot(snapshot) => {
                // Save current state as inverse snapshot
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
                inverse_transaction.add_change(CellChange::RestoreSnapshot(current_snapshot));

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
            CellChange::CustomRestore { kind, data } => {
                // Handle custom metadata restore (comments, notes, hyperlinks, etc.)
                apply_custom_restore(state, kind, data, &mut inverse_transaction);
            }
        }
    }

    // Push inverse transaction to the appropriate stack
    if is_undo {
        undo_stack.push_redo(inverse_transaction);
    } else {
        undo_stack.push_undo_for_redo(inverse_transaction);
    }

    // Mark workbook as dirty
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    let can_undo = undo_stack.can_undo();
    let can_redo = undo_stack.can_redo();

    // Drop all locks before rebuilding dependencies
    drop(locale);
    drop(merged_regions);
    drop(row_heights);
    drop(column_widths);
    drop(styles);
    drop(grids);
    drop(grid);
    drop(undo_stack);

    // Rebuild dependency maps after structural restore
    if structural_restore {
        rebuild_all_dependencies(state);
    }

    UndoResult {
        success: true,
        description: Some(description),
        updated_cells,
        can_undo,
        can_redo,
        merge_changed,
        structural_restore,
    }
}

/// Handle custom metadata restore for undo/redo.
/// `kind` identifies the subsystem (e.g., "comment", "note", "hyperlink").
/// `data` is the serialized previous state.
fn apply_custom_restore(
    state: &AppState,
    kind: &str,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    match kind {
        "comment" => {
            apply_comment_restore(state, data, inverse_transaction);
        }
        "note" => {
            apply_note_restore(state, data, inverse_transaction);
        }
        "hyperlink" => {
            apply_hyperlink_restore(state, data, inverse_transaction);
        }
        "default_row_height" => {
            apply_default_dimension_restore(state, kind, data, inverse_transaction);
        }
        "default_column_width" => {
            apply_default_dimension_restore(state, kind, data, inverse_transaction);
        }
        _ => {
            eprintln!("[undo] Unknown custom restore kind: {}", kind);
        }
    }
}

/// Restore a comment snapshot for undo/redo.
fn apply_comment_restore(
    state: &AppState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    use crate::comments::Comment;

    #[derive(serde::Deserialize, serde::Serialize)]
    struct CommentSnapshot {
        sheet_index: usize,
        row: u32,
        col: u32,
        previous: Option<Comment>,
    }

    let snapshot: CommentSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize comment snapshot: {}", e);
            return;
        }
    };

    let mut comments = state.comments.lock().unwrap();
    let sheet_comments = comments.entry(snapshot.sheet_index).or_default();
    let key = (snapshot.row, snapshot.col);

    // Save current state for inverse
    let current = sheet_comments.get(&key).cloned();
    let inverse_data = serde_json::to_vec(&CommentSnapshot {
        sheet_index: snapshot.sheet_index,
        row: snapshot.row,
        col: snapshot.col,
        previous: current,
    }).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "comment".to_string(),
        data: inverse_data,
    });

    // Restore previous state
    match snapshot.previous {
        Some(comment) => { sheet_comments.insert(key, comment); }
        None => { sheet_comments.remove(&key); }
    }
}

/// Restore a note snapshot for undo/redo.
fn apply_note_restore(
    state: &AppState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    use crate::notes::Note;

    #[derive(serde::Deserialize, serde::Serialize)]
    struct NoteSnapshot {
        sheet_index: usize,
        row: u32,
        col: u32,
        previous: Option<Note>,
    }

    let snapshot: NoteSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize note snapshot: {}", e);
            return;
        }
    };

    let mut notes = state.notes.lock().unwrap();
    let sheet_notes = notes.entry(snapshot.sheet_index).or_default();
    let key = (snapshot.row, snapshot.col);

    // Save current state for inverse
    let current = sheet_notes.get(&key).cloned();
    let inverse_data = serde_json::to_vec(&NoteSnapshot {
        sheet_index: snapshot.sheet_index,
        row: snapshot.row,
        col: snapshot.col,
        previous: current,
    }).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "note".to_string(),
        data: inverse_data,
    });

    // Restore previous state
    match snapshot.previous {
        Some(note) => { sheet_notes.insert(key, note); }
        None => { sheet_notes.remove(&key); }
    }
}

/// Restore a hyperlink snapshot for undo/redo.
fn apply_hyperlink_restore(
    state: &AppState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    use crate::hyperlinks::Hyperlink;

    #[derive(serde::Deserialize, serde::Serialize)]
    struct HyperlinkSnapshot {
        sheet_index: usize,
        row: u32,
        col: u32,
        previous: Option<Hyperlink>,
    }

    let snapshot: HyperlinkSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize hyperlink snapshot: {}", e);
            return;
        }
    };

    let mut hyperlinks = state.hyperlinks.lock().unwrap();
    let sheet_links = hyperlinks.entry(snapshot.sheet_index).or_default();
    let key = (snapshot.row, snapshot.col);

    // Save current state for inverse
    let current = sheet_links.get(&key).cloned();
    let inverse_data = serde_json::to_vec(&HyperlinkSnapshot {
        sheet_index: snapshot.sheet_index,
        row: snapshot.row,
        col: snapshot.col,
        previous: current,
    }).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "hyperlink".to_string(),
        data: inverse_data,
    });

    // Restore previous state
    match snapshot.previous {
        Some(link) => { sheet_links.insert(key, link); }
        None => { sheet_links.remove(&key); }
    }
}

/// Restore default row height or column width for undo/redo.
fn apply_default_dimension_restore(
    state: &AppState,
    kind: &str,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let value: f64 = match serde_json::from_slice(data) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize default dimension: {}", e);
            return;
        }
    };

    match kind {
        "default_row_height" => {
            let mut h = state.default_row_height.lock().unwrap();
            let current = *h;
            inverse_transaction.add_change(CellChange::CustomRestore {
                kind: kind.to_string(),
                data: serde_json::to_vec(&current).unwrap_or_default(),
            });
            *h = value;
        }
        "default_column_width" => {
            let mut w = state.default_column_width.lock().unwrap();
            let current = *w;
            inverse_transaction.add_change(CellChange::CustomRestore {
                kind: kind.to_string(),
                data: serde_json::to_vec(&current).unwrap_or_default(),
            });
            *w = value;
        }
        _ => {}
    }
}

/// Perform undo operation.
#[tauri::command]
pub fn undo(state: State<AppState>, file_state: State<FileState>) -> UndoResult {
    let transaction = {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        match undo_stack.pop_undo() {
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
        }
    };

    apply_changes(&state, &file_state, transaction, true)
}

/// Perform redo operation.
#[tauri::command]
pub fn redo(state: State<AppState>, file_state: State<FileState>) -> UndoResult {
    let transaction = {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        match undo_stack.pop_redo() {
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
        }
    };

    apply_changes(&state, &file_state, transaction, false)
}

/// Clear undo/redo history (e.g., when opening a new file).
#[tauri::command]
pub fn clear_undo_history(state: State<AppState>) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.clear();
}
