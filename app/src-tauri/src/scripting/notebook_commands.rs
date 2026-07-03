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
        source_package: None,
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
pub async fn notebook_delete(
    script_state: State<'_, ScriptState>,
    id: String,
) -> Result<(), String> {
    // Don't delete out from under a running execution.
    let _exec = script_state.notebook_exec_lock.lock().await;

    {
        let mut notebooks = script_state
            .workbook_notebooks
            .lock()
            .map_err(|e| e.to_string())?;
        if notebooks.remove(&id).is_none() {
            return Err(format!("Notebook '{}' not found", id));
        }
    }

    reset_runtime_internal(&script_state).await
}

// ============================================================================
// Internal Helpers
// ============================================================================

/// Internal helper that runs a single notebook cell.
/// Separated from the Tauri command so it can be called from run_all/rewind/run_from.
///
/// Callers (the command wrappers) hold `notebook_exec_lock` for the whole
/// orchestration; this helper itself must NOT take it (run_all/rewind call it
/// in a loop under one guard). Structured in three phases so no std
/// MutexGuard is ever held across an await point.
async fn run_cell_internal(
    app: &tauri::AppHandle,
    app_state: &AppState,
    script_state: &ScriptState,
    notebook_id: &str,
    cell_id: &str,
    source: &str,
) -> Result<NotebookCellResponse, String> {
    // Notebook cells are script execution — same security gate as run_script.
    super::commands::check_script_security(script_state)?;

    // Phase 1 (sync): clone AppState data + checkpoint bookkeeping
    let grids = app_state.grids.lock().map_err(|e| e.to_string())?.clone();
    let style_registry = app_state.style_registry.lock().map_err(|e| e.to_string())?.clone();
    let sheet_names = app_state.sheet_names.lock().map_err(|e| e.to_string())?.clone();
    let active_sheet = *app_state.active_sheet.lock().map_err(|e| e.to_string())?;

    {
        let mut runtime = script_state
            .notebook_runtime
            .lock()
            .map_err(|e| e.to_string())?;

        // Capture baseline if this is the first cell execution
        if runtime.baseline.is_none() {
            runtime.baseline = Some(grids.clone());
        }

        // Capture checkpoint (snapshot before this cell runs)
        let checkpoint = GridCheckpoint {
            cell_id: cell_id.to_string(),
            grids: grids.clone(),
        };

        // Enforce max checkpoints (LRU: remove oldest)
        if runtime.checkpoints.len() >= runtime.max_checkpoints {
            runtime.checkpoints.remove(0);
        }
        runtime.checkpoints.push(checkpoint);
    } // runtime guard dropped before the await below

    // Phase 2 (async): execute on the dedicated executor thread, which owns
    // the persistent QuickJS session (creates it on first use). The UI stays
    // responsive while a long cell runs. The provider seed enables the
    // read-only model.* API (capability-gated per call, keyed by the surface
    // id); the tokio Handle lets the provider drive async BI calls from the
    // executor thread.
    let (result, modified_grids) = script_state
        .notebook_executor
        .run_cell(
            source.to_string(),
            grids,
            style_registry,
            sheet_names,
            active_sheet,
            format!("notebook:{}", notebook_id),
            Some(super::notebook_executor::ProviderSeed {
                app: app.clone(),
                rt: tokio::runtime::Handle::current(),
            }),
        )
        .await?;

    // Phase 3 (sync): execution index, grid apply, audit, document update
    let execution_index = {
        let mut runtime = script_state
            .notebook_runtime
            .lock()
            .map_err(|e| e.to_string())?;
        runtime.execution_counter += 1;
        runtime.execution_counter
    };

    // 7. Apply modified grids back to AppState (if cells were modified)
    match &result {
        script_engine::ScriptResult::Success { cells_modified, .. } => {
            if *cells_modified > 0 && !modified_grids.is_empty() {
                // Audit (unified Rust-QuickJS trail): record the notebook cell's
                // grid mutation through the shared sink so all QuickJS surfaces
                // produce one consistent, always-on, structured audit entry.
                // Notebooks apply wholesale (no diff), so no mutated range is
                // attached — just the surface, notebook:cell id, sheet, and count.
                crate::scripting::commands::record_script_grid_mutation(
                    app_state,
                    "notebook",
                    &format!("{}:{}", notebook_id, cell_id),
                    active_sheet,
                    *cells_modified,
                    &[],
                );
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
            enable_events,
            deferred_actions,
            ..
        } => Ok(NotebookCellResponse::Success {
            output,
            cells_modified,
            duration_ms,
            execution_index,
            screen_updating,
            enable_events,
            deferred_actions,
        }),
        script_engine::ScriptResult::Error { message, output } => {
            Ok(NotebookCellResponse::Error { message, output })
        }
    }
}

/// Internal helper to reset the notebook runtime (session + bookkeeping).
/// Callers must hold `notebook_exec_lock`.
async fn reset_runtime_internal(script_state: &ScriptState) -> Result<(), String> {
    {
        let mut runtime = script_state
            .notebook_runtime
            .lock()
            .map_err(|e| e.to_string())?;
        runtime.checkpoints.clear();
        runtime.baseline = None;
        runtime.execution_counter = 0;
    } // guard dropped before the await
    script_state.notebook_executor.reset().await;
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
pub async fn notebook_run_cell(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    script_state: State<'_, ScriptState>,
    request: RunNotebookCellRequest,
    window: tauri::Window,
) -> Result<NotebookCellResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let _exec = script_state.notebook_exec_lock.lock().await;
    run_cell_internal(&app, &state, &script_state, &request.notebook_id, &request.cell_id, &request.source).await
}

/// Run all notebook cells sequentially from the top.
/// Resets the runtime and baseline, then executes each cell in order.
#[tauri::command]
pub async fn notebook_run_all(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    script_state: State<'_, ScriptState>,
    notebook_id: String,
    window: tauri::Window,
) -> Result<Vec<NotebookCellResponse>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let _exec = script_state.notebook_exec_lock.lock().await;
    // Reset the runtime first
    reset_runtime_internal(&script_state).await?;

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
        let response = run_cell_internal(&app, &state, &script_state, &notebook_id, &cell_id, &source).await?;

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
pub async fn notebook_rewind(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    script_state: State<'_, ScriptState>,
    request: RewindNotebookRequest,
    window: tauri::Window,
) -> Result<Vec<NotebookCellResponse>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let _exec = script_state.notebook_exec_lock.lock().await;
    notebook_rewind_internal(&app, &state, &script_state, &request).await
}

/// Internal rewind implementation (callable from other commands).
/// Callers must hold `notebook_exec_lock`.
async fn notebook_rewind_internal(
    app: &tauri::AppHandle,
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

    // 3. Reset the runtime (drop the JS session) and clear checkpoints.
    // Baseline is deliberately kept: it still describes the state before the
    // first cell of this notebook ran.
    {
        let mut runtime = script_state
            .notebook_runtime
            .lock()
            .map_err(|e| e.to_string())?;
        runtime.checkpoints.clear();
        runtime.execution_counter = 0;
    } // guard dropped before the await
    script_state.notebook_executor.reset().await;

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
            app,
            app_state,
            script_state,
            &request.notebook_id,
            &cell_id,
            &source,
        )
        .await?;
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
pub async fn notebook_run_from(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    script_state: State<'_, ScriptState>,
    request: RewindNotebookRequest,
    window: tauri::Window,
) -> Result<Vec<NotebookCellResponse>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let _exec = script_state.notebook_exec_lock.lock().await;
    // 1. Rewind to the target cell (restores snapshot + replays prior cells)
    let replay_results = notebook_rewind_internal(&app, &state, &script_state, &request).await?;

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
            &app,
            &state,
            &script_state,
            &request.notebook_id,
            &cell_id,
            &source,
        )
        .await?;
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
pub async fn notebook_reset_runtime(
    script_state: State<'_, ScriptState>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let _exec = script_state.notebook_exec_lock.lock().await;
    reset_runtime_internal(&script_state).await
}
