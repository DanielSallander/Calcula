//! FILENAME: app/src-tauri/src/scripting/notebook_commands.rs
//! PURPOSE: Tauri commands for notebook CRUD and cell execution with snapshots.
//! CONTEXT: These commands manage notebook documents (create/save/load/delete),
//! execute cells in a persistent QuickJS runtime with shared variables,
//! and support snapshot-based rewind.

use tauri::State;

use crate::AppState;
use super::types::{
    GridCheckpoint, NotebookCell, NotebookCellResponse, NotebookDocument,
    NotebookSummary, RewindNotebookRequest, RunNotebookCellRequest, ScriptState,
};

// ============================================================================
// Notebook CRUD Commands
// ============================================================================

/// Create a new empty notebook.
#[tauri::command]
pub fn notebook_create(
    script_state: State<ScriptState>,
    id: String,
    name: String,
) -> Result<NotebookDocument, String> {
    let notebook = NotebookDocument {
        id: id.clone(),
        name,
        cells: vec![NotebookCell {
            id: format!("{}-cell-1", id),
            source: String::new(),
            last_output: Vec::new(),
            last_error: None,
            cells_modified: 0,
            duration_ms: 0,
            execution_index: None,
        }],
    };

    let mut notebooks = script_state
        .workbook_notebooks
        .lock()
        .map_err(|e| e.to_string())?;
    notebooks.insert(id, notebook.clone());

    Ok(notebook)
}

/// Save (create or update) a notebook document.
#[tauri::command]
pub fn notebook_save(
    script_state: State<ScriptState>,
    notebook: NotebookDocument,
) -> Result<(), String> {
    let mut notebooks = script_state
        .workbook_notebooks
        .lock()
        .map_err(|e| e.to_string())?;
    notebooks.insert(notebook.id.clone(), notebook);
    Ok(())
}

/// Load a notebook by ID.
#[tauri::command]
pub fn notebook_load(
    script_state: State<ScriptState>,
    id: String,
) -> Result<NotebookDocument, String> {
    let notebooks = script_state
        .workbook_notebooks
        .lock()
        .map_err(|e| e.to_string())?;
    notebooks
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("Notebook '{}' not found", id))
}

/// List all notebooks (lightweight summaries).
#[tauri::command]
pub fn notebook_list(
    script_state: State<ScriptState>,
) -> Result<Vec<NotebookSummary>, String> {
    let notebooks = script_state
        .workbook_notebooks
        .lock()
        .map_err(|e| e.to_string())?;

    let mut summaries: Vec<NotebookSummary> = notebooks
        .values()
        .map(|nb| NotebookSummary {
            id: nb.id.clone(),
            name: nb.name.clone(),
            cell_count: nb.cells.len(),
        })
        .collect();

    summaries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(summaries)
}

/// Delete a notebook by ID. Also clears any active runtime for it.
#[tauri::command]
pub fn notebook_delete(
    script_state: State<ScriptState>,
    id: String,
) -> Result<(), String> {
    let mut notebooks = script_state
        .workbook_notebooks
        .lock()
        .map_err(|e| e.to_string())?;

    if notebooks.remove(&id).is_none() {
        return Err(format!("Notebook '{}' not found", id));
    }

    // Clear runtime if it was active for this notebook
    let mut runtime = script_state
        .notebook_runtime
        .lock()
        .map_err(|e| e.to_string())?;
    runtime.session.0 = None;
    runtime.checkpoints.clear();
    runtime.baseline = None;
    runtime.execution_counter = 0;

    Ok(())
}

// ============================================================================
// Internal Helpers
// ============================================================================

/// Internal helper that runs a single notebook cell.
/// Separated from the Tauri command so it can be called from run_all/rewind/run_from.
fn run_cell_internal(
    app_state: &AppState,
    script_state: &ScriptState,
    notebook_id: &str,
    cell_id: &str,
    source: &str,
) -> Result<NotebookCellResponse, String> {
    // 1. Clone current AppState data
    let grids = app_state.grids.lock().map_err(|e| e.to_string())?.clone();
    let style_registry = app_state.style_registry.lock().map_err(|e| e.to_string())?.clone();
    let sheet_names = app_state.sheet_names.lock().map_err(|e| e.to_string())?.clone();
    let active_sheet = *app_state.active_sheet.lock().map_err(|e| e.to_string())?;

    let mut runtime = script_state
        .notebook_runtime
        .lock()
        .map_err(|e| e.to_string())?;

    // 2. Capture baseline if this is the first cell execution
    if runtime.baseline.is_none() {
        runtime.baseline = Some(grids.clone());
    }

    // 3. Ensure a NotebookSession exists
    if runtime.session.0.is_none() {
        let session = script_engine::NotebookSession::new(
            grids.clone(),
            style_registry.clone(),
            sheet_names.clone(),
            active_sheet,
        )?;
        runtime.session.0 = Some(session);
    }

    // 4. Capture checkpoint (snapshot before this cell runs)
    let checkpoint = GridCheckpoint {
        cell_id: cell_id.to_string(),
        grids: grids.clone(),
    };

    // Enforce max checkpoints (LRU: remove oldest)
    if runtime.checkpoints.len() >= runtime.max_checkpoints {
        runtime.checkpoints.remove(0);
    }
    runtime.checkpoints.push(checkpoint);

    // 5. Execute the cell in the persistent runtime
    let session = runtime.session.0.as_ref().unwrap();
    let (result, modified_grids) = session.run_cell(
        source,
        grids,
        style_registry,
        sheet_names,
        active_sheet,
    );

    // 6. Increment execution counter
    runtime.execution_counter += 1;
    let execution_index = runtime.execution_counter;

    // Must drop runtime lock before acquiring other locks
    drop(runtime);

    // 7. Apply modified grids back to AppState (if cells were modified)
    match &result {
        script_engine::ScriptResult::Success { cells_modified, .. } => {
            if *cells_modified > 0 && !modified_grids.is_empty() {
                let active_grid_clone = modified_grids.get(active_sheet).cloned();

                let mut app_grids = app_state.grids.lock().map_err(|e| e.to_string())?;
                *app_grids = modified_grids;
                drop(app_grids);

                if let Some(grid) = active_grid_clone {
                    let mut app_grid = app_state.grid.lock().map_err(|e| e.to_string())?;
                    *app_grid = grid;
                }
            }
        }
        _ => {}
    }

    // 8. Update the notebook document's cell with execution results
    {
        let mut notebooks = script_state
            .workbook_notebooks
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(notebook) = notebooks.get_mut(notebook_id) {
            if let Some(cell) = notebook.cells.iter_mut().find(|c| c.id == cell_id) {
                cell.source = source.to_string();
                match &result {
                    script_engine::ScriptResult::Success {
                        output,
                        cells_modified,
                        duration_ms,
                        ..
                    } => {
                        cell.last_output = output.clone();
                        cell.last_error = None;
                        cell.cells_modified = *cells_modified;
                        cell.duration_ms = *duration_ms;
                        cell.execution_index = Some(execution_index);
                    }
                    script_engine::ScriptResult::Error { message, output } => {
                        cell.last_output = output.clone();
                        cell.last_error = Some(message.clone());
                        cell.execution_index = Some(execution_index);
                    }
                }
            }
        }
    }

    // 9. Convert to response
    match result {
        script_engine::ScriptResult::Success {
            output,
            cells_modified,
            duration_ms,
            screen_updating,
            ..
        } => Ok(NotebookCellResponse::Success {
            output,
            cells_modified,
            duration_ms,
            execution_index,
            screen_updating,
        }),
        script_engine::ScriptResult::Error { message, output } => {
            Ok(NotebookCellResponse::Error { message, output })
        }
    }
}

/// Internal helper to reset the notebook runtime.
fn reset_runtime_internal(script_state: &ScriptState) -> Result<(), String> {
    let mut runtime = script_state
        .notebook_runtime
        .lock()
        .map_err(|e| e.to_string())?;
    runtime.session.0 = None;
    runtime.checkpoints.clear();
    runtime.baseline = None;
    runtime.execution_counter = 0;
    Ok(())
}

// ============================================================================
// Notebook Cell Execution Commands
// ============================================================================

/// Run a single notebook cell.
///
/// 1. Ensures a NotebookSession exists (creates one if needed)
/// 2. Captures a grid snapshot (checkpoint) before execution
/// 3. Executes the cell in the persistent QuickJS runtime
/// 4. Applies modified grids back to AppState
/// 5. Returns the execution result
#[tauri::command]
pub fn notebook_run_cell(
    state: State<AppState>,
    script_state: State<ScriptState>,
    request: RunNotebookCellRequest,
) -> Result<NotebookCellResponse, String> {
    run_cell_internal(&state, &script_state, &request.notebook_id, &request.cell_id, &request.source)
}

/// Run all notebook cells sequentially from the top.
/// Resets the runtime and baseline, then executes each cell in order.
#[tauri::command]
pub fn notebook_run_all(
    state: State<AppState>,
    script_state: State<ScriptState>,
    notebook_id: String,
) -> Result<Vec<NotebookCellResponse>, String> {
    // Reset the runtime first
    reset_runtime_internal(&script_state)?;

    // Get the cell sources from the notebook
    let cell_sources: Vec<(String, String)> = {
        let notebooks = script_state
            .workbook_notebooks
            .lock()
            .map_err(|e| e.to_string())?;
        let notebook = notebooks
            .get(&notebook_id)
            .ok_or_else(|| format!("Notebook '{}' not found", notebook_id))?;
        notebook
            .cells
            .iter()
            .map(|c| (c.id.clone(), c.source.clone()))
            .collect()
    };

    let mut results = Vec::new();

    for (cell_id, source) in cell_sources {
        let response = run_cell_internal(&state, &script_state, &notebook_id, &cell_id, &source)?;

        // Stop on error
        let is_error = matches!(&response, NotebookCellResponse::Error { .. });
        results.push(response);
        if is_error {
            break;
        }
    }

    Ok(results)
}

/// Rewind a notebook to just before a specific cell.
///
/// 1. Finds the snapshot for the target cell
/// 2. Restores the grid state from that snapshot
/// 3. Resets the QuickJS runtime
/// 4. Replays all cells before the target to rebuild JS variable state
/// 5. Marks the target cell and all subsequent cells as stale
#[tauri::command]
pub fn notebook_rewind(
    state: State<AppState>,
    script_state: State<ScriptState>,
    request: RewindNotebookRequest,
) -> Result<Vec<NotebookCellResponse>, String> {
    notebook_rewind_internal(&state, &script_state, &request)
}

/// Internal rewind implementation (callable from other commands).
fn notebook_rewind_internal(
    app_state: &AppState,
    script_state: &ScriptState,
    request: &RewindNotebookRequest,
) -> Result<Vec<NotebookCellResponse>, String> {
    // 1. Find the checkpoint for the target cell
    let snapshot_grids: Vec<engine::grid::Grid>;
    let cells_before_target: Vec<(String, String)>;
    {
        let runtime = script_state
            .notebook_runtime
            .lock()
            .map_err(|e| e.to_string())?;

        let checkpoint_idx = runtime
            .checkpoints
            .iter()
            .position(|cp| cp.cell_id == request.target_cell_id)
            .ok_or_else(|| {
                format!(
                    "No checkpoint found for cell '{}'. Was it ever executed?",
                    request.target_cell_id
                )
            })?;

        snapshot_grids = runtime.checkpoints[checkpoint_idx].grids.clone();

        // Determine which cells come before the target in the notebook
        let notebooks = script_state
            .workbook_notebooks
            .lock()
            .map_err(|e| e.to_string())?;
        let notebook = notebooks
            .get(&request.notebook_id)
            .ok_or_else(|| format!("Notebook '{}' not found", request.notebook_id))?;

        let target_pos = notebook
            .cells
            .iter()
            .position(|c| c.id == request.target_cell_id)
            .ok_or_else(|| format!("Cell '{}' not found in notebook", request.target_cell_id))?;

        cells_before_target = notebook.cells[..target_pos]
            .iter()
            .map(|c| (c.id.clone(), c.source.clone()))
            .collect();
    }

    // 2. Restore the snapshot to AppState
    let active_sheet = *app_state.active_sheet.lock().map_err(|e| e.to_string())?;
    {
        let active_grid_clone = snapshot_grids.get(active_sheet).cloned();

        let mut app_grids = app_state.grids.lock().map_err(|e| e.to_string())?;
        *app_grids = snapshot_grids;
        drop(app_grids);

        if let Some(grid) = active_grid_clone {
            let mut app_grid = app_state.grid.lock().map_err(|e| e.to_string())?;
            *app_grid = grid;
        }
    }

    // 3. Reset the runtime and clear checkpoints
    {
        let mut runtime = script_state
            .notebook_runtime
            .lock()
            .map_err(|e| e.to_string())?;
        runtime.session.0 = None;
        runtime.checkpoints.clear();
        runtime.execution_counter = 0;
    }

    // 4. Mark target and subsequent cells as stale in the notebook document
    {
        let mut notebooks = script_state
            .workbook_notebooks
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(notebook) = notebooks.get_mut(&request.notebook_id) {
            let target_pos = notebook
                .cells
                .iter()
                .position(|c| c.id == request.target_cell_id);
            if let Some(pos) = target_pos {
                for cell in &mut notebook.cells[pos..] {
                    cell.execution_index = None;
                    cell.last_output.clear();
                    cell.last_error = None;
                    cell.cells_modified = 0;
                    cell.duration_ms = 0;
                }
            }
        }
    }

    // 5. Replay cells before target to rebuild JS variable state
    let mut replay_results = Vec::new();
    for (cell_id, source) in cells_before_target {
        let response = run_cell_internal(
            app_state,
            script_state,
            &request.notebook_id,
            &cell_id,
            &source,
        )?;
        let is_error = matches!(&response, NotebookCellResponse::Error { .. });
        replay_results.push(response);
        if is_error {
            break;
        }
    }

    Ok(replay_results)
}

/// Run from a specific cell onwards (rewind to that cell, then run it and all after).
#[tauri::command]
pub fn notebook_run_from(
    state: State<AppState>,
    script_state: State<ScriptState>,
    request: RewindNotebookRequest,
) -> Result<Vec<NotebookCellResponse>, String> {
    // 1. Rewind to the target cell (restores snapshot + replays prior cells)
    let replay_results = notebook_rewind_internal(&state, &script_state, &request)?;

    // Check if replay had errors
    if replay_results
        .last()
        .map_or(false, |r| matches!(r, NotebookCellResponse::Error { .. }))
    {
        return Ok(replay_results);
    }

    // 2. Get cells from target onwards
    let cells_from_target: Vec<(String, String)> = {
        let notebooks = script_state
            .workbook_notebooks
            .lock()
            .map_err(|e| e.to_string())?;
        let notebook = notebooks
            .get(&request.notebook_id)
            .ok_or_else(|| format!("Notebook '{}' not found", request.notebook_id))?;

        let target_pos = notebook
            .cells
            .iter()
            .position(|c| c.id == request.target_cell_id)
            .ok_or_else(|| format!("Cell '{}' not found", request.target_cell_id))?;

        notebook.cells[target_pos..]
            .iter()
            .map(|c| (c.id.clone(), c.source.clone()))
            .collect()
    };

    // 3. Execute cells from target onwards
    let mut all_results = replay_results;
    for (cell_id, source) in cells_from_target {
        let response = run_cell_internal(
            &state,
            &script_state,
            &request.notebook_id,
            &cell_id,
            &source,
        )?;
        let is_error = matches!(&response, NotebookCellResponse::Error { .. });
        all_results.push(response);
        if is_error {
            break;
        }
    }

    Ok(all_results)
}

/// Reset the notebook runtime — destroys the QuickJS session and clears
/// all checkpoints. Called when switching notebooks or closing the notebook view.
#[tauri::command]
pub fn notebook_reset_runtime(
    script_state: State<ScriptState>,
) -> Result<(), String> {
    reset_runtime_internal(&script_state)
}
