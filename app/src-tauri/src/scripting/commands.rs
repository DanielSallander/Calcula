//! FILENAME: app/src-tauri/src/scripting/commands.rs
//! PURPOSE: Tauri commands for script execution and management.
//! CONTEXT: These commands bridge the frontend Script Editor extension
//! to the Rust script engine. They follow the same patterns as pivot commands.

use tauri::State;

use crate::AppState;
use super::types::{ScriptState, RunScriptRequest, RunScriptResponse};

/// Execute a script against the current spreadsheet state.
///
/// 1. Clones the relevant AppState data (grids, styles, sheet names)
/// 2. Runs the script in an isolated V8 runtime
/// 3. If successful, applies grid changes back to AppState
/// 4. Returns the result to the frontend
#[tauri::command]
pub fn run_script(
    state: State<AppState>,
    _script_state: State<ScriptState>,
    request: RunScriptRequest,
) -> Result<RunScriptResponse, String> {
    // 1. Clone data from AppState for isolated execution
    let grids = state.grids.lock().map_err(|e| e.to_string())?.clone();
    let style_registry = state.style_registry.lock().map_err(|e| e.to_string())?.clone();
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?.clone();
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;

    // 2. Run the script in the V8 engine
    let (result, modified_grids) = script_engine::ScriptEngine::run(
        &request.source,
        &request.filename,
        grids,
        style_registry,
        sheet_names,
        active_sheet,
    );

    // 3. If successful and grids were modified, apply changes back
    match &result {
        script_engine::ScriptResult::Success { cells_modified, .. } => {
            if *cells_modified > 0 && !modified_grids.is_empty() {
                let mut app_grids = state.grids.lock().map_err(|e| e.to_string())?;
                *app_grids = modified_grids;
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
        } => Ok(RunScriptResponse::Success {
            output,
            cells_modified,
            duration_ms,
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
) -> Result<(), String> {
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
