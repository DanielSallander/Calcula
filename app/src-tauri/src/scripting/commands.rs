//! FILENAME: app/src-tauri/src/scripting/commands.rs
//! PURPOSE: Tauri commands for script execution and management.
//! CONTEXT: These commands bridge the frontend Script Editor extension
//! to the Rust script engine. They follow the same patterns as pivot commands.

use tauri::State;

use crate::AppState;
use crate::api_types::CellUpdateInput;
use crate::persistence::{FileState, UserFilesState};
use crate::{log_info, log_warn};
use engine::{Cell, CellValue, Grid};
use super::types::{ScriptState, ScriptSummary, RunScriptRequest, RunScriptResponse, WorkbookScript};

/// Render a cell as the input string a user would type to recreate it.
///
/// This is the inverse of `parse_cell_input_invariant`: a formula cell yields
/// "=<formula>" with the formula rendered from the AST (invariant US format —
/// '.' decimals, ',' argument separators), and a literal yields the plain text
/// a user would enter. An empty/blank cell yields "".
///
/// Numbers render with '.' as the decimal separator (NOT locale-aware) because
/// the resulting `CellUpdateInput` is fed back through the edit pipeline with
/// `invariant = true`, which expects US-format input.
fn cell_input_string(cell: &Cell) -> String {
    if let Some(formula) = cell.formula_string() {
        return format!("={}", formula);
    }
    match &cell.value {
        CellValue::Empty => String::new(),
        CellValue::Number(n) => {
            // Render integers without a trailing ".0"; others via the default
            // float formatting (always '.' decimal — invariant).
            if n.fract() == 0.0 && n.abs() < 1e15 {
                format!("{:.0}", n)
            } else {
                format!("{}", n)
            }
        }
        CellValue::Text(s) => s.clone(),
        CellValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        // Errors / collections have no clean user-typed input form. Fall back to
        // their display string; this preserves the visible value through the
        // edit pipeline (re-parsed as text) rather than losing the cell.
        _ => cell.display_value(),
    }
}

/// Diff two grids (before/after a script ran) into the minimal set of
/// `CellUpdateInput`s needed to transform `before` into `after`.
///
/// The diff is keyed on the user-input string of each cell (see
/// `cell_input_string`): a cell is considered changed when its effective input
/// string differs between the two grids. Cells present in `before` but cleared
/// in `after` produce an update with value "" (clear). The resulting updates
/// carry `invariant = true` so the edit pipeline does not re-localize them.
///
/// Pure function (no Tauri State) so it is unit-testable without a running app.
fn diff_grids_to_updates(before: &Grid, after: &Grid) -> Vec<CellUpdateInput> {
    use std::collections::HashSet;

    // Union of populated coordinates in both grids.
    let mut coords: HashSet<(u32, u32)> = HashSet::new();
    coords.extend(before.cells.keys().copied());
    coords.extend(after.cells.keys().copied());

    let mut updates = Vec::new();
    for (row, col) in coords {
        let before_str = before
            .get_cell(row, col)
            .map(cell_input_string)
            .unwrap_or_default();
        let after_str = after
            .get_cell(row, col)
            .map(cell_input_string)
            .unwrap_or_default();

        if before_str != after_str {
            updates.push(CellUpdateInput {
                row,
                col,
                value: after_str,
                style_index: None,
                invariant: Some(true),
            });
        }
    }

    // Deterministic ordering (row-major) — diffs come from a HashSet, so sort
    // for stable behavior and reproducible logs/tests.
    updates.sort_by(|a, b| (a.row, a.col).cmp(&(b.row, b.col)));
    updates
}

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

/// Apply a script engine's `modified_grids` back into live AppState the
/// undoable, recalc-tracked, event-visible way (C1a). Shared by the in-app
/// `run_script` and the MCP `execute_script` so AI writes inherit the exact
/// same edit-pipeline behavior the in-app twin gets — instead of the wholesale
/// grid swap MCP used to do (which skipped undo + recalc + events).
///
/// The active sheet is diffed before->after and replayed through
/// `update_cells_batch` (single undo entry + dependency recalc). Non-active
/// sheets are applied wholesale as a documented v1 limit (not undoable / not
/// recalc-tracked). No-ops when nothing changed.
///
/// LOCK DISCIPLINE: the AppState grid locks are held only to compute the diff /
/// do the wholesale writes, then DROPPED before calling `update_cells_batch`
/// (which takes its own locks) to avoid a deadlock.
pub(crate) fn apply_script_modified_grids(
    state: &State<AppState>,
    file_state: &State<FileState>,
    user_files_state: &State<UserFilesState>,
    pivot_state: &State<'_, crate::pivot::PivotState>,
    modified_grids: &[Grid],
    active_sheet: usize,
    cells_modified: u32,
) -> Result<(), String> {
    if cells_modified == 0 || modified_grids.is_empty() {
        return Ok(());
    }

    // Audit (B4): record that a sandboxed script mutated the grid, so the
    // Rust QuickJS surface is not invisible to the activity log.
    {
        let now = chrono::Utc::now().to_rfc3339();
        if let Ok(mut audit) = state.audit_log.lock() {
            audit.record(
                calp::audit::AuditEvent::ScriptExecuted,
                &format!("A script modified {} cell(s)", cells_modified),
                "local",
                &now,
            );
        }
    }

    // Build the active-sheet diff WITHOUT mutating AppState. Hold the AppState
    // grid locks only long enough to compute the diff, then drop them.
    let updates: Vec<CellUpdateInput> = {
        let app_grids = state.grids.lock().map_err(|e| e.to_string())?;
        let empty_grid = Grid::new();
        let before_active = app_grids.get(active_sheet).unwrap_or(&empty_grid);
        match modified_grids.get(active_sheet) {
            Some(after_active) => diff_grids_to_updates(before_active, after_active),
            None => Vec::new(),
        }
    };

    // Apply non-active-sheet writes wholesale (documented v1 limit: not undoable
    // / not recalc-tracked). Only touch sheets that actually differ.
    {
        let mut app_grids = state.grids.lock().map_err(|e| e.to_string())?;
        let mut wholesale_sheets = 0usize;
        let empty_grid = Grid::new();
        for (idx, after_grid) in modified_grids.iter().enumerate() {
            if idx == active_sheet {
                continue;
            }
            // `Cell` has no PartialEq, so compare via the input-string diff: a
            // non-empty diff means this sheet changed. Scope the immutable borrow
            // so the mutable write below is allowed.
            let differs = {
                let before_grid = app_grids.get(idx).unwrap_or(&empty_grid);
                !diff_grids_to_updates(before_grid, after_grid).is_empty()
            };
            if differs {
                if idx < app_grids.len() {
                    app_grids[idx] = after_grid.clone();
                }
                wholesale_sheets += 1;
            }
        }
        drop(app_grids);
        if wholesale_sheets > 0 {
            log_warn!(
                "SCRIPT",
                "script wrote {} non-active sheet(s) wholesale: these writes are NOT undoable or recalc-tracked yet (v1 limit)",
                wholesale_sheets
            );
        }
    }

    // Replay the active-sheet diff through the edit pipeline. All AppState locks
    // acquired above are now dropped.
    if !updates.is_empty() {
        let cell_count = updates.len();
        crate::commands::data::update_cells_batch(
            state.clone(),
            file_state.clone(),
            user_files_state.clone(),
            pivot_state.clone(),
            updates,
            None,
        )?;
        log_info!(
            "SCRIPT",
            "applied {} active-sheet cell change(s) via edit pipeline (parsed + recalc + undoable)",
            cell_count
        );
    }

    Ok(())
}

/// Execute a script against the current spreadsheet state.
///
/// 1. Clones the relevant AppState data (grids, styles, sheet names)
/// 2. Runs the script in an isolated QuickJS runtime (on a CLONE of the grids)
/// 3. If successful, DIFFS the script's result against the live AppState and
///    replays the changes through the normal edit pipeline
///    (`update_cells_batch`) so they get formula parsing, dependency recalc,
///    and a single undo entry — instead of a wholesale grid swap.
/// 4. Returns the result to the frontend
///
/// The `file_state`, `user_files_state`, and `pivot_state` parameters exist
/// solely so this command can forward them to `update_cells_batch`; Tauri
/// injects them by type from the managed-state set, so no change to the
/// `generate_handler!` registration is needed.
#[tauri::command]
pub fn run_script(
    state: State<AppState>,
    script_state: State<ScriptState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
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

    // 3. If successful and grids were modified, route the changes through the
    //    edit pipeline so they get parsed, recalculated, and made undoable.
    //
    //    The engine ran on a CLONE; AppState still holds the ORIGINAL grids, so
    //    AppState IS the "before". We diff the active sheet before -> after and
    //    replay it via update_cells_batch (single undo entry + recalc). Writes
    //    to non-active sheets are applied wholesale as a documented v1 limit
    //    (no per-sheet undo/recalc for off-screen sheets yet).
    if let script_engine::ScriptResult::Success { cells_modified, .. } = &result {
        apply_script_modified_grids(
            &state,
            &file_state,
            &user_files_state,
            &pivot_state,
            &modified_grids,
            active_sheet,
            *cells_modified,
        )?;
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
    use tauri::Manager;
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
        .map_err(|e| e.to_string())? = level.clone();
    // Persist (per-app, not per-workbook) so the choice survives relaunch (B5).
    persist_security_level(window.app_handle(), &level);
    Ok(())
}

/// Path of the per-app Script Security config file.
fn security_config_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("script-security.json"))
}

/// Persist the Script Security level so it survives relaunch. Best-effort.
fn persist_security_level(app: &tauri::AppHandle, level: &str) {
    if let Some(path) = security_config_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::json!({ "securityLevel": level });
        if let Ok(bytes) = serde_json::to_vec_pretty(&json) {
            let _ = std::fs::write(&path, bytes);
        }
    }
}

/// Parse + validate a persisted security level from config bytes. Returns None
/// for malformed JSON, a missing field, or an unrecognized level — so a corrupt
/// or tampered config can never apply an invalid (or downgraded-to-garbage)
/// level; the in-memory default is kept instead.
fn parse_persisted_level(bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let level = value.get("securityLevel")?.as_str()?;
    ["disabled", "prompt", "enabled"]
        .contains(&level)
        .then(|| level.to_string())
}

/// Read the persisted Script Security level (if any) and apply it to ScriptState
/// at startup. Falls back to the in-memory default ("prompt") when the file is
/// absent or invalid. Called once after the app is built.
pub fn hydrate_security_level(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(path) = security_config_path(app) else { return };
    let Ok(bytes) = std::fs::read(&path) else { return };
    if let Some(level) = parse_persisted_level(&bytes) {
        if let Some(state) = app.try_state::<ScriptState>() {
            if let Ok(mut lvl) = state.security_level.lock() {
                *lvl = level;
            }
        }
    }
}

#[cfg(test)]
mod security_level_tests {
    use super::parse_persisted_level;

    #[test]
    fn accepts_valid_levels() {
        for lvl in ["disabled", "prompt", "enabled"] {
            let bytes = format!("{{\"securityLevel\":\"{}\"}}", lvl);
            assert_eq!(parse_persisted_level(bytes.as_bytes()), Some(lvl.to_string()));
        }
    }

    #[test]
    fn rejects_invalid_or_corrupt() {
        assert_eq!(parse_persisted_level(br#"{"securityLevel":"bogus"}"#), None);
        assert_eq!(parse_persisted_level(br#"{"securityLevel":42}"#), None);
        assert_eq!(parse_persisted_level(br#"{}"#), None);
        assert_eq!(parse_persisted_level(b"not json at all"), None);
        assert_eq!(parse_persisted_level(b""), None);
    }
}

/// Returns the current script-execution gate state, for a caller to consult
/// BEFORE mounting/running scripts (e.g. object scripts at workbook load):
/// `"allowed"`, `"disabled"`, or `"needsApproval"`. This is the non-throwing
/// counterpart of `check_script_security` — it lets the UI gate quietly instead
/// of catching a sentinel error, so the global Script Security setting governs
/// the object-script surface too, not only the run_script / notebook paths.
#[tauri::command]
pub fn script_execution_status(script_state: State<ScriptState>) -> Result<String, String> {
    let level = script_state
        .security_level
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let status = match level.as_str() {
        "enabled" => "allowed",
        "disabled" => "disabled",
        _ => {
            let grants = script_state
                .permission_grants
                .lock()
                .map_err(|e| e.to_string())?;
            let approved = grants
                .get(SESSION_APPROVAL_KEY)
                .map(|perms| perms.iter().any(|p| p == "execute"))
                .unwrap_or(false);
            if approved { "allowed" } else { "needsApproval" }
        }
    };
    Ok(status.to_string())
}

// ============================================================================
// Script Module CRUD Commands
// ============================================================================

/// Reserved-id prefix for records the workbook stores in the module-script map
/// that are NOT user-authored runnable code (e.g. the Custom Functions library,
/// persisted as JSON under `__calcula_custom_functions__`). These records reuse
/// the persisted-with-the-workbook script map for storage convenience, but they
/// must never surface in the Script Editor / code inventory, and the user must
/// not be able to delete or rename them out from under the owning feature.
const RESERVED_SCRIPT_PREFIX: &str = "__calcula_";

/// True for reserved internal records (see `RESERVED_SCRIPT_PREFIX`).
fn is_reserved_script_id(id: &str) -> bool {
    id.starts_with(RESERVED_SCRIPT_PREFIX)
}

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
        // Hide reserved internal data records (e.g. the Custom Functions JSON
        // store) from the Script Editor / code inventory — they are not code.
        .filter(|s| !is_reserved_script_id(&s.id))
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
    // Reserved internal records (e.g. the Custom Functions store) are owned by a
    // feature, not the user — deleting one here would silently wipe that feature.
    if is_reserved_script_id(&id) {
        return Err(format!("Script '{}' is reserved and cannot be deleted", id));
    }

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
    // Reserved internal records must keep their well-known id/name.
    if is_reserved_script_id(&id) {
        return Err(format!("Script '{}' is reserved and cannot be renamed", id));
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use engine::Cell;

    /// Reserved internal records (the Custom Functions JSON store and any other
    /// `__calcula_`-prefixed data record) are recognized so they can be hidden
    /// from the Script Editor and protected from user delete/rename.
    #[test]
    fn test_reserved_script_id_detection() {
        assert!(is_reserved_script_id("__calcula_custom_functions__"));
        assert!(is_reserved_script_id("__calcula_anything"));
        assert!(!is_reserved_script_id("my_script"));
        assert!(!is_reserved_script_id("calcula_helper")); // no leading "__"
    }

    /// A changed literal value produces an update carrying the new literal,
    /// flagged invariant so the edit pipeline does not re-localize it.
    #[test]
    fn test_diff_changed_literal() {
        let mut before = Grid::new();
        before.set_cell(0, 0, Cell::new_number(1.0));
        let mut after = Grid::new();
        after.set_cell(0, 0, Cell::new_number(42.0));

        let updates = diff_grids_to_updates(&before, &after);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].row, 0);
        assert_eq!(updates[0].col, 0);
        assert_eq!(updates[0].value, "42");
        assert_eq!(updates[0].invariant, Some(true));
        assert_eq!(updates[0].style_index, None);
    }

    /// A changed formula produces an update whose value is the "=" + formula
    /// string (so the pipeline re-parses it into an AST and tracks deps).
    #[test]
    fn test_diff_changed_formula() {
        let mut before = Grid::new();
        before.set_cell(2, 0, Cell::new_number(0.0));
        let mut after = Grid::new();
        after.set_cell(2, 0, Cell::new_formula("SUM(A1:A2)".to_string()));

        let updates = diff_grids_to_updates(&before, &after);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].row, 2);
        assert_eq!(updates[0].col, 0);
        // Rendered from the AST in invariant form, with the leading "=".
        assert_eq!(updates[0].value, "=SUM(A1:A2)");
        assert_eq!(updates[0].invariant, Some(true));
    }

    /// A cell present in `before` but cleared in `after` produces a clear
    /// (value "").
    #[test]
    fn test_diff_deleted_cell() {
        let mut before = Grid::new();
        before.set_cell(0, 0, Cell::new_text("hello".to_string()));
        let after = Grid::new();

        let updates = diff_grids_to_updates(&before, &after);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].row, 0);
        assert_eq!(updates[0].col, 0);
        assert_eq!(updates[0].value, "");
        assert_eq!(updates[0].invariant, Some(true));
    }

    /// Unchanged cells produce no updates.
    #[test]
    fn test_diff_no_change() {
        let mut before = Grid::new();
        before.set_cell(0, 0, Cell::new_number(5.0));
        before.set_cell(1, 1, Cell::new_text("x".to_string()));
        let after = before.clone();

        let updates = diff_grids_to_updates(&before, &after);
        assert!(updates.is_empty());
    }

    /// A newly-added cell (absent in `before`) produces an update with its
    /// literal value.
    #[test]
    fn test_diff_added_cell() {
        let before = Grid::new();
        let mut after = Grid::new();
        after.set_cell(3, 4, Cell::new_boolean(true));

        let updates = diff_grids_to_updates(&before, &after);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].row, 3);
        assert_eq!(updates[0].col, 4);
        assert_eq!(updates[0].value, "TRUE");
    }
}
