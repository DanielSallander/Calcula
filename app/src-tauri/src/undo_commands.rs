//! FILENAME: app/src-tauri/src/undo_commands.rs
// PURPOSE: Tauri commands for undo/redo operations.

use crate::api_types::{CellData, MergedRegion};
use crate::persistence::FileState;
use crate::pivot::operations::*;
use crate::pivot::types::PivotState;
use crate::ribbon_filter::types::{RibbonFilter, RibbonFilterState};
use crate::slicer::types::{Slicer, SlicerState};
use crate::{
    extract_all_references, format_cell_value, update_column_dependencies,
    update_cross_sheet_dependencies, update_dependencies, update_row_dependencies, AppState,
};
use engine::{CellChange, GridSnapshot, Transaction, UndoMergeRegion};
use pivot_engine::PivotDefinition;
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
    /// Whether pivot table state was restored (frontend should refresh pivot view)
    pub pivot_changed: bool,
    /// Whether slicer state was restored (frontend should refresh slicers)
    pub slicer_changed: bool,
    /// Whether ribbon filter state was restored (frontend should refresh ribbon filters)
    pub ribbon_filter_changed: bool,
}

/// Get current undo/redo state
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoState {
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_description: Option<String>,
    pub redo_description: Option<String>,
    /// Number of transactions available to undo (used by test oracles).
    pub undo_depth: usize,
    /// Number of transactions available to redo (used by test oracles).
    pub redo_depth: usize,
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
        undo_depth: undo_stack.undo_depth(),
        redo_depth: undo_stack.redo_depth(),
    }
}

/// Apply undo/redo changes and return the result.
/// Shared logic used by both `undo` and `redo` commands.
fn apply_changes(
    state: &AppState,
    file_state: &FileState,
    pivot_state: &PivotState,
    slicer_state: &SlicerState,
    ribbon_filter_state: &RibbonFilterState,
    transaction: Transaction,
    is_undo: bool,
) -> UndoResult {
    let undo_stack = state.undo_stack.lock().unwrap();
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
    let mut pivot_changed = false;
    let mut slicer_changed = false;
    let mut ribbon_filter_changed = false;

    // Deferred custom restores that need to run AFTER grid locks are released
    // (pivot/slicer/ribbon_filter restores acquire their own locks and may need grid access)
    let mut deferred_restores: Vec<(String, Vec<u8>)> = Vec::new();

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
                // Pivot/slicer/ribbon_filter restores need grid access and would deadlock
                // if called while grid locks are held. Defer them.
                if kind.starts_with("pivot_") || kind.starts_with("slicer") || kind.starts_with("ribbon_filter") {
                    deferred_restores.push((kind.clone(), data.clone()));
                } else {
                    // Handle simple metadata restores (comments, notes, hyperlinks, etc.)
                    apply_custom_restore(
                        state, pivot_state, slicer_state, ribbon_filter_state,
                        kind, data, &mut inverse_transaction,
                    );
                }
            }
        }
    }

    // Mark workbook as dirty
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    // Drop all grid/style locks BEFORE processing deferred restores
    // (pivot/slicer/ribbon_filter restores need to acquire grid/state locks)
    drop(locale);
    drop(merged_regions);
    drop(row_heights);
    drop(column_widths);
    drop(styles);
    drop(grids);
    drop(grid);
    drop(undo_stack);

    // Process deferred pivot/slicer/ribbon_filter restores (now safe to acquire locks)
    for (kind, data) in deferred_restores {
        let restore_kind = apply_custom_restore(
            state, pivot_state, slicer_state, ribbon_filter_state,
            &kind, &data, &mut inverse_transaction,
        );
        match restore_kind {
            CustomRestoreKind::Pivot => pivot_changed = true,
            CustomRestoreKind::Slicer => slicer_changed = true,
            CustomRestoreKind::RibbonFilter => ribbon_filter_changed = true,
            CustomRestoreKind::Other => {}
        }
    }

    // Push inverse transaction to the appropriate stack (re-acquire undo_stack)
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        if is_undo {
            undo_stack.push_redo(inverse_transaction);
        } else {
            undo_stack.push_undo_for_redo(inverse_transaction);
        }
    }

    let (can_undo, can_redo) = {
        let undo_stack = state.undo_stack.lock().unwrap();
        (undo_stack.can_undo(), undo_stack.can_redo())
    };

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
        pivot_changed,
        slicer_changed,
        ribbon_filter_changed,
    }
}

/// Identifies which subsystem a CustomRestore affected.
enum CustomRestoreKind {
    Pivot,
    Slicer,
    RibbonFilter,
    Other,
}

/// Handle custom metadata restore for undo/redo.
/// `kind` identifies the subsystem (e.g., "comment", "note", "hyperlink", "pivot", "slicer").
/// `data` is the serialized previous state.
fn apply_custom_restore(
    state: &AppState,
    pivot_state: &PivotState,
    slicer_state: &SlicerState,
    ribbon_filter_state: &RibbonFilterState,
    kind: &str,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) -> CustomRestoreKind {
    match kind {
        "comment" => {
            apply_comment_restore(state, data, inverse_transaction);
            CustomRestoreKind::Other
        }
        "note" => {
            apply_note_restore(state, data, inverse_transaction);
            CustomRestoreKind::Other
        }
        "hyperlink" => {
            apply_hyperlink_restore(state, data, inverse_transaction);
            CustomRestoreKind::Other
        }
        "default_row_height" | "default_column_width" => {
            apply_default_dimension_restore(state, kind, data, inverse_transaction);
            CustomRestoreKind::Other
        }
        "pivot_definition" => {
            apply_pivot_definition_restore(state, pivot_state, data, inverse_transaction);
            CustomRestoreKind::Pivot
        }
        "pivot_create" => {
            apply_pivot_create_restore(state, pivot_state, data, inverse_transaction);
            CustomRestoreKind::Pivot
        }
        "pivot_delete" => {
            apply_pivot_delete_restore(state, pivot_state, data, inverse_transaction);
            CustomRestoreKind::Pivot
        }
        "slicer" => {
            apply_slicer_restore(slicer_state, data, inverse_transaction);
            CustomRestoreKind::Slicer
        }
        "slicer_create" => {
            apply_slicer_create_restore(slicer_state, data, inverse_transaction);
            CustomRestoreKind::Slicer
        }
        "slicer_delete" => {
            apply_slicer_delete_restore(slicer_state, data, inverse_transaction);
            CustomRestoreKind::Slicer
        }
        "ribbon_filter" => {
            apply_ribbon_filter_restore(ribbon_filter_state, data, inverse_transaction);
            CustomRestoreKind::RibbonFilter
        }
        "ribbon_filter_create" => {
            apply_ribbon_filter_create_restore(ribbon_filter_state, data, inverse_transaction);
            CustomRestoreKind::RibbonFilter
        }
        "ribbon_filter_delete" => {
            apply_ribbon_filter_delete_restore(ribbon_filter_state, data, inverse_transaction);
            CustomRestoreKind::RibbonFilter
        }
        _ => {
            eprintln!("[undo] Unknown custom restore kind: {}", kind);
            CustomRestoreKind::Other
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
pub fn undo(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    slicer_state: State<'_, SlicerState>,
    ribbon_filter_state: State<'_, RibbonFilterState>,
) -> UndoResult {
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
                    pivot_changed: false,
                    slicer_changed: false,
                    ribbon_filter_changed: false,
                };
            }
        }
    };

    apply_changes(&state, &file_state, &pivot_state, &slicer_state, &ribbon_filter_state, transaction, true)
}

/// Perform redo operation.
#[tauri::command]
pub fn redo(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    slicer_state: State<'_, SlicerState>,
    ribbon_filter_state: State<'_, RibbonFilterState>,
) -> UndoResult {
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
                    pivot_changed: false,
                    slicer_changed: false,
                    ribbon_filter_changed: false,
                };
            }
        }
    };

    apply_changes(&state, &file_state, &pivot_state, &slicer_state, &ribbon_filter_state, transaction, false)
}

/// Clear undo/redo history (e.g., when opening a new file).
#[tauri::command]
pub fn clear_undo_history(state: State<AppState>) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.clear();
}

// ============================================================================
// PIVOT TABLE UNDO/REDO HANDLERS
// ============================================================================

/// Snapshot of a pivot definition for undo/redo.
/// Optionally includes cells that were overwritten when the pivot expanded,
/// so that `undo_pivot_overwrite` can restore them when the user cancels.
#[derive(serde::Serialize, serde::Deserialize)]
struct PivotDefinitionSnapshot {
    pivot_id: pivot_engine::PivotId,
    definition: PivotDefinition,
    /// Cells overwritten by the pivot expansion.
    /// Empty when no cells were overwritten.
    #[serde(default)]
    overwritten_cells: Vec<crate::pivot::operations::SavedCell>,
    /// Sheet index where overwritten cells lived.
    #[serde(default)]
    dest_sheet_idx: usize,
}

/// Snapshot of a full pivot table (definition + cache) for create/delete undo.
#[derive(serde::Serialize, serde::Deserialize)]
struct PivotFullSnapshot {
    pivot_id: pivot_engine::PivotId,
    definition: PivotDefinition,
    cache: pivot_engine::PivotCache,
}

/// Restore a pivot definition for undo/redo.
/// Replaces the current definition, recalculates the view, and rewrites the grid.
fn apply_pivot_definition_restore(
    state: &AppState,
    pivot_state: &PivotState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: PivotDefinitionSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize pivot definition snapshot: {}", e);
            return;
        }
    };

    let pivot_id = snapshot.pivot_id;

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    if let Some((definition, cache)) = pivot_tables.get_mut(&pivot_id) {
        // Save current definition for inverse transaction
        let dest_sheet_idx_current = resolve_dest_sheet_index(state, definition);

        let current_snapshot = PivotDefinitionSnapshot {
            pivot_id,
            definition: definition.clone(),
            // Overwritten cells for the inverse will be captured when redo runs
            overwritten_cells: Vec::new(),
            dest_sheet_idx: dest_sheet_idx_current,
        };
        let inverse_data = serde_json::to_vec(&current_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "pivot_definition".to_string(),
            data: inverse_data,
        });

        // Restore the old definition
        *definition = snapshot.definition;

        // Recalculate the view
        let view = safe_calculate_pivot(definition, cache);

        // Store view for windowed cell fetching
        pivot_state.views.lock().unwrap().insert(pivot_id, view.clone());

        let destination = definition.destination;
        let dest_sheet_idx = resolve_dest_sheet_index(state, definition);

        drop(pivot_tables);

        // Rewrite the grid
        finalize_pivot_update(state, pivot_state, pivot_id, dest_sheet_idx, destination, &view);

        // Restore cells that were overwritten by the previous pivot expansion
        if !snapshot.overwritten_cells.is_empty() {
            let mut grids = state.grids.lock().unwrap();
            if let Some(dest_grid) = grids.get_mut(snapshot.dest_sheet_idx) {
                for sc in &snapshot.overwritten_cells {
                    dest_grid.set_cell(sc.row, sc.col, sc.cell.clone());
                }
            }
            let active_sheet = *state.active_sheet.lock().unwrap();
            if snapshot.dest_sheet_idx == active_sheet {
                let mut grid = state.grid.lock().unwrap();
                for sc in &snapshot.overwritten_cells {
                    grid.set_cell(sc.row, sc.col, sc.cell.clone());
                }
            }
        }
    } else {
        eprintln!("[undo] Pivot table {} not found for definition restore", pivot_id);
    }
}

/// Undo pivot creation: remove the pivot and clear its grid region.
fn apply_pivot_create_restore(
    state: &AppState,
    pivot_state: &PivotState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: PivotFullSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize pivot create snapshot: {}", e);
            return;
        }
    };

    let pivot_id = snapshot.pivot_id;

    // Save current state for redo (redo = re-create the pivot)
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    if let Some((definition, cache)) = pivot_tables.get(&pivot_id) {
        let redo_snapshot = PivotFullSnapshot {
            pivot_id,
            definition: definition.clone(),
            cache: cache.clone(),
        };
        let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "pivot_delete".to_string(),
            data: redo_data,
        });

        let dest_sheet_idx = resolve_dest_sheet_index(state, definition);

        // Clear the pivot grid region
        let old_region = get_pivot_region(state, pivot_id);
        if let Some(ref region) = old_region {
            let mut grids = state.grids.lock().unwrap();
            if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
                clear_pivot_region_from_grid(
                    dest_grid,
                    region.start_row, region.start_col,
                    region.end_row, region.end_col,
                );

                let active_sheet = *state.active_sheet.lock().unwrap();
                if dest_sheet_idx == active_sheet {
                    let mut grid = state.grid.lock().unwrap();
                    for row in region.start_row..=region.end_row {
                        for col in region.start_col..=region.end_col {
                            grid.clear_cell(row, col);
                        }
                    }
                    grid.recalculate_bounds();
                }
            }
        }
    }

    // Remove pivot
    pivot_tables.remove(&pivot_id);
    pivot_state.views.lock().unwrap().remove(&pivot_id);

    // Clear active if this was the active pivot
    let mut active = pivot_state.active_pivot_id.lock().unwrap();
    if *active == Some(pivot_id) {
        *active = None;
    }
    drop(active);

    // Remove pivot region tracking
    let mut regions = state.protected_regions.lock().unwrap();
    regions.retain(|r| !(r.region_type == "pivot" && r.owner_id == pivot_id));
}

/// Undo pivot deletion: re-create the pivot from the snapshot.
fn apply_pivot_delete_restore(
    state: &AppState,
    pivot_state: &PivotState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: PivotFullSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize pivot delete snapshot: {}", e);
            return;
        }
    };

    let pivot_id = snapshot.pivot_id;
    let definition = snapshot.definition;
    let mut cache = snapshot.cache;

    // Save for redo (redo = delete it again)
    let redo_snapshot = PivotFullSnapshot {
        pivot_id,
        definition: definition.clone(),
        cache: cache.clone(),
    };
    let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "pivot_create".to_string(),
        data: redo_data,
    });

    // Recalculate view
    let view = safe_calculate_pivot(&definition, &mut cache);
    pivot_state.views.lock().unwrap().insert(pivot_id, view.clone());

    let destination = definition.destination;
    let dest_sheet_idx = resolve_dest_sheet_index(state, &definition);

    // Restore pivot
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    pivot_tables.insert(pivot_id, (definition, cache));
    drop(pivot_tables);

    // Write to grid
    finalize_pivot_update(state, pivot_state, pivot_id, dest_sheet_idx, destination, &view);
}

// ============================================================================
// SLICER UNDO/REDO HANDLERS
// ============================================================================

/// Snapshot of a slicer for property/selection undo.
#[derive(serde::Serialize, serde::Deserialize)]
struct SlicerSnapshot {
    slicer_id: identity::EntityId,
    previous: Slicer,
}

/// Snapshot for slicer creation undo (undo = delete).
#[derive(serde::Serialize, serde::Deserialize)]
struct SlicerCreateSnapshot {
    slicer_id: identity::EntityId,
}

/// Restore a slicer's previous state (properties/selection).
fn apply_slicer_restore(
    slicer_state: &SlicerState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: SlicerSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize slicer snapshot: {}", e);
            return;
        }
    };

    let mut slicers = slicer_state.slicers.lock().unwrap();
    if let Some(slicer) = slicers.get_mut(&snapshot.slicer_id) {
        // Save current state for inverse
        let inverse_snapshot = SlicerSnapshot {
            slicer_id: snapshot.slicer_id,
            previous: slicer.clone(),
        };
        let inverse_data = serde_json::to_vec(&inverse_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "slicer".to_string(),
            data: inverse_data,
        });

        // Restore previous state
        *slicer = snapshot.previous;
    }
}

/// Undo slicer creation: remove the slicer.
fn apply_slicer_create_restore(
    slicer_state: &SlicerState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: SlicerCreateSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize slicer create snapshot: {}", e);
            return;
        }
    };

    let mut slicers = slicer_state.slicers.lock().unwrap();
    if let Some(slicer) = slicers.remove(&snapshot.slicer_id) {
        // Save for redo (redo = re-create)
        let redo_snapshot = SlicerSnapshot {
            slicer_id: snapshot.slicer_id,
            previous: slicer,
        };
        let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "slicer_delete".to_string(),
            data: redo_data,
        });
    }
}

/// Undo slicer deletion: re-create the slicer from snapshot.
fn apply_slicer_delete_restore(
    slicer_state: &SlicerState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: SlicerSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize slicer delete snapshot: {}", e);
            return;
        }
    };

    // Save for redo (redo = delete it again)
    let redo_snapshot = SlicerCreateSnapshot {
        slicer_id: snapshot.slicer_id,
    };
    let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "slicer_create".to_string(),
        data: redo_data,
    });

    // Restore slicer
    let mut slicers = slicer_state.slicers.lock().unwrap();
    slicers.insert(snapshot.slicer_id, snapshot.previous);
}

// ============================================================================
// RIBBON FILTER UNDO/REDO HANDLERS
// ============================================================================

/// Snapshot of a ribbon filter for property/selection undo.
#[derive(serde::Serialize, serde::Deserialize)]
struct RibbonFilterSnapshot {
    filter_id: identity::EntityId,
    previous: RibbonFilter,
}

/// Snapshot for ribbon filter creation undo (undo = delete).
#[derive(serde::Serialize, serde::Deserialize)]
struct RibbonFilterCreateSnapshot {
    filter_id: identity::EntityId,
}

/// Restore a ribbon filter's previous state (properties/selection).
fn apply_ribbon_filter_restore(
    ribbon_filter_state: &RibbonFilterState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: RibbonFilterSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize ribbon filter snapshot: {}", e);
            return;
        }
    };

    let mut filters = ribbon_filter_state.filters.lock().unwrap();
    if let Some(filter) = filters.get_mut(&snapshot.filter_id) {
        // Save current state for inverse
        let inverse_snapshot = RibbonFilterSnapshot {
            filter_id: snapshot.filter_id,
            previous: filter.clone(),
        };
        let inverse_data = serde_json::to_vec(&inverse_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "ribbon_filter".to_string(),
            data: inverse_data,
        });

        // Restore previous state
        *filter = snapshot.previous;
    }
}

/// Undo ribbon filter creation: remove the filter.
fn apply_ribbon_filter_create_restore(
    ribbon_filter_state: &RibbonFilterState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: RibbonFilterCreateSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize ribbon filter create snapshot: {}", e);
            return;
        }
    };

    let mut filters = ribbon_filter_state.filters.lock().unwrap();
    if let Some(filter) = filters.remove(&snapshot.filter_id) {
        let redo_snapshot = RibbonFilterSnapshot {
            filter_id: snapshot.filter_id,
            previous: filter,
        };
        let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "ribbon_filter_delete".to_string(),
            data: redo_data,
        });
    }
}

/// Undo ribbon filter deletion: re-create the filter from snapshot.
fn apply_ribbon_filter_delete_restore(
    ribbon_filter_state: &RibbonFilterState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: RibbonFilterSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize ribbon filter delete snapshot: {}", e);
            return;
        }
    };

    let redo_snapshot = RibbonFilterCreateSnapshot {
        filter_id: snapshot.filter_id,
    };
    let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "ribbon_filter_create".to_string(),
        data: redo_data,
    });

    let mut filters = ribbon_filter_state.filters.lock().unwrap();
    filters.insert(snapshot.filter_id, snapshot.previous);
}
