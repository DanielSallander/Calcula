//! FILENAME: app/src-tauri/src/scripting/commands.rs
//! PURPOSE: Tauri commands for script execution and management.
//! CONTEXT: These commands bridge the frontend Script Editor extension
//! to the Rust script engine. They follow the same patterns as pivot commands.

use tauri::State;

use crate::AppState;
use super::types::{ScriptState, ScriptSummary, RunScriptRequest, RunScriptResponse, WorkbookScript};

/// Key under which the once-per-session "prompt" approval is stored in
/// `ScriptState.permission_grants`.
const SESSION_APPROVAL_KEY: &str = "__session__";

/// Error sentinel for the "prompt" security level: the frontend keys on this
/// to show a confirmation and retry after `grant_script_session_approval`.
pub const SCRIPT_PROMPT_REQUIRED: &str = "SCRIPT_PROMPT_REQUIRED";
/// Error sentinel for the "disabled" security level.
pub const SCRIPTS_DISABLED: &str = "SCRIPTS_DISABLED";

/// Check the global script security level before executing any script.
/// - "enabled": run freely.
/// - "prompt": require the once-per-session approval granted via
///   `grant_script_session_approval` after the user confirms in the UI.
/// - "disabled": always refuse.
/// Every script execution path (run_script, notebook cells, MCP) must call
/// this — a stored security setting that gates nothing is worse than none.
pub(crate) fn check_script_security(script_state: &ScriptState) -> Result<(), String> {
    let level = script_state
        .security_level
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    match level.as_str() {
        "enabled" => Ok(()),
        "disabled" => Err(format!(
            "{}: Script execution is disabled (Script Security setting)",
            SCRIPTS_DISABLED
        )),
        _ => {
            let grants = script_state
                .permission_grants
                .lock()
                .map_err(|e| e.to_string())?;
            let approved = grants
                .get(SESSION_APPROVAL_KEY)
                .map(|perms| perms.iter().any(|p| p == "execute"))
                .unwrap_or(false);
            if approved {
                Ok(())
            } else {
                Err(format!(
                    "{}: Script execution requires confirmation (Script Security setting is 'prompt')",
                    SCRIPT_PROMPT_REQUIRED
                ))
            }
        }
    }
}

/// Grant session-wide script execution approval. The "prompt" security level
/// asks once per session; the frontend calls this after the user confirms.
#[tauri::command]
pub fn grant_script_session_approval(
    script_state: State<ScriptState>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_SCRIPT_EDITOR)?;
    let mut grants = script_state
        .permission_grants
        .lock()
        .map_err(|e| e.to_string())?;
    let entry = grants.entry(SESSION_APPROVAL_KEY.to_string()).or_default();
    if !entry.iter().any(|p| p == "execute") {
        entry.push("execute".to_string());
    }
    Ok(())
}

/// Execute a script against the current spreadsheet state.
///
/// 1. Clones the relevant AppState data (grids, styles, sheet names)
/// 2. Runs the script in an isolated V8 runtime
/// 3. If successful, applies grid changes back to AppState
/// 4. Returns the result to the frontend
#[tauri::command]
pub fn run_script(
    state: State<AppState>,
    script_state: State<ScriptState>,
    request: RunScriptRequest,
    window: tauri::Window,
) -> Result<RunScriptResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_SCRIPT_EDITOR)?;
    check_script_security(&script_state)?;

    // 1. Clone data from AppState for isolated execution
    let grids = state.grids.lock().map_err(|e| e.to_string())?.clone();
    let style_registry = state.style_registry.lock().map_err(|e| e.to_string())?.clone();
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?.clone();
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?.clone();
    let calculation_mode = state.calculation_mode.lock().map_err(|e| e.to_string())?.clone();

    // Build Application info from current AppState
    let app_info = script_engine::types::AppInfo {
        name: "Calcula".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        operating_system: std::env::consts::OS.to_string(),
        path_separator: std::path::MAIN_SEPARATOR.to_string(),
        decimal_separator: locale.decimal_separator.to_string(),
        thousands_separator: locale.thousands_separator.to_string(),
        calculation_mode,
    };

    // 2. Run the script in the engine
    let (result, modified_grids) = script_engine::ScriptEngine::run_with_bookmarks(
        &request.source,
        &request.filename,
        grids,
        style_registry,
        sheet_names,
        active_sheet,
        request.cell_bookmarks_json.unwrap_or_else(|| "[]".to_string()),
        request.view_bookmarks_json.unwrap_or_else(|| "[]".to_string()),
        app_info,
    );

    // 3. If successful and grids were modified, apply changes back
    match &result {
        script_engine::ScriptResult::Success { cells_modified, .. } => {
            if *cells_modified > 0 && !modified_grids.is_empty() {
                // Clone the active sheet grid before moving modified_grids
                let active_grid_clone = modified_grids.get(active_sheet).cloned();

                // Update the multi-sheet grids vector (original behavior)
                let mut app_grids = state.grids.lock().map_err(|e| e.to_string())?;
                *app_grids = modified_grids;
                drop(app_grids);

                // Sync the active sheet into state.grid so that
                // get_viewport_cells / get_cell return the updated data
                if let Some(grid) = active_grid_clone {
                    let mut app_grid = state.grid.lock().map_err(|e| e.to_string())?;
                    *app_grid = grid;
                }
            }
        }
        _ => {}
    }

    // 4. Convert to response type
    match result {
        script_engine::ScriptResult::Success {
            output,
            cells_modified,
            duration_ms,
            bookmark_mutations,
            deferred_actions,
            screen_updating,
            enable_events,
        } => Ok(RunScriptResponse::Success {
            output,
            cells_modified,
            duration_ms,
            bookmark_mutations,
            deferred_actions,
            screen_updating,
            enable_events,
        }),
        script_engine::ScriptResult::Error { message, output } => {
            Ok(RunScriptResponse::Error { message, output })
        }
    }
}

/// Get the current script security level.
#[tauri::command]
pub fn get_script_security_level(
    script_state: State<ScriptState>,
) -> Result<String, String> {
    let level = script_state
        .security_level
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    Ok(level)
}

/// Set the script security level.
#[tauri::command]
pub fn set_script_security_level(
    script_state: State<ScriptState>,
    level: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let valid_levels = ["disabled", "prompt", "enabled"];
    if !valid_levels.contains(&level.as_str()) {
        return Err(format!(
            "Invalid security level '{}'. Must be one of: disabled, prompt, enabled",
            level
        ));
    }
    *script_state
        .security_level
        .lock()
        .map_err(|e| e.to_string())? = level;
    Ok(())
}

// ============================================================================
// Script Module CRUD Commands
// ============================================================================

/// List all saved script modules (lightweight: id + name only).
#[tauri::command]
pub fn list_scripts(
    script_state: State<ScriptState>,
) -> Result<Vec<ScriptSummary>, String> {
    let scripts = script_state
        .workbook_scripts
        .lock()
        .map_err(|e| e.to_string())?;

    let mut summaries: Vec<ScriptSummary> = scripts
        .values()
        .map(|s| ScriptSummary {
            id: s.id.clone(),
            name: s.name.clone(),
            scope: s.scope.clone(),
        })
        .collect();

    // Sort by name for consistent ordering
    summaries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(summaries)
}

/// Get a single script module by ID (includes source code).
#[tauri::command]
pub fn get_script(
    script_state: State<ScriptState>,
    id: String,
) -> Result<WorkbookScript, String> {
    let scripts = script_state
        .workbook_scripts
        .lock()
        .map_err(|e| e.to_string())?;

    scripts
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("Script '{}' not found", id))
}

/// Save (create or update) a script module.
#[tauri::command]
pub fn save_script(
    script_state: State<ScriptState>,
    script: WorkbookScript,
) -> Result<(), String> {
    let mut scripts = script_state
        .workbook_scripts
        .lock()
        .map_err(|e| e.to_string())?;

    scripts.insert(script.id.clone(), script);
    Ok(())
}

/// Delete a script module by ID.
#[tauri::command]
pub fn delete_script(
    script_state: State<ScriptState>,
    id: String,
) -> Result<(), String> {
    let mut scripts = script_state
        .workbook_scripts
        .lock()
        .map_err(|e| e.to_string())?;

    if scripts.remove(&id).is_none() {
        return Err(format!("Script '{}' not found", id));
    }
    Ok(())
}

/// Rename a script module.
#[tauri::command]
pub fn rename_script(
    script_state: State<ScriptState>,
    id: String,
    new_name: String,
) -> Result<(), String> {
    let mut scripts = script_state
        .workbook_scripts
        .lock()
        .map_err(|e| e.to_string())?;

    let script = scripts
        .get_mut(&id)
        .ok_or_else(|| format!("Script '{}' not found", id))?;

    script.name = new_name;
    Ok(())
}
