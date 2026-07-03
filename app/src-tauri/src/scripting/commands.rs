//! FILENAME: app/src-tauri/src/scripting/commands.rs
//! PURPOSE: Tauri commands for script execution and management.
//! CONTEXT: These commands bridge the frontend Script Editor extension
//! to the Rust script engine. They follow the same patterns as pivot commands.

use tauri::State;

use crate::AppState;
use crate::api_types::CellUpdateInput;
use crate::persistence::{FileState, UserFilesState};
use crate::log_info;
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

/// Human label for an audited script surface.
fn surface_label(surface: &str) -> &'static str {
    match surface {
        "run_script" => "A script",
        "mcp" => "An AI tool",
        "notebook" => "A notebook cell",
        _ => "A script",
    }
}

/// Bounding box (firstRow, lastRow, firstCol, lastCol) of a diff, or None when empty.
fn updates_bounds(updates: &[CellUpdateInput]) -> Option<(u32, u32, u32, u32)> {
    let mut it = updates.iter();
    let first = it.next()?;
    let (mut r0, mut r1, mut c0, mut c1) = (first.row, first.row, first.col, first.col);
    for u in it {
        r0 = r0.min(u.row);
        r1 = r1.max(u.row);
        c0 = c0.min(u.col);
        c1 = c1.max(u.col);
    }
    Some((r0, r1, c0, c1))
}

/// Record a sandboxed script's grid mutation into the per-workbook audit log
/// (the always-on script-activity trail — `AuditEvent::ScriptExecuted`), with
/// structured attribution: surface kind, surface id, sheet, cell count, and the
/// mutated active-sheet bounding box (when a diff is available; wholesale paths
/// like notebooks pass an empty `range_updates` and omit the range). This is the
/// single helper both the run_script/MCP path and the notebook path call, so all
/// Rust QuickJS surfaces produce one consistent audit shape.
pub(crate) fn record_script_grid_mutation(
    state: &AppState,
    surface: &str,
    surface_id: &str,
    sheet: usize,
    cells_modified: u32,
    range_updates: &[CellUpdateInput],
) {
    use serde_json::json;
    let now = chrono::Utc::now().to_rfc3339();
    let mut extra: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();
    extra.insert("surface".into(), json!(surface));
    if !surface_id.is_empty() {
        extra.insert("surfaceId".into(), json!(surface_id));
    }
    extra.insert("sheet".into(), json!(sheet));
    extra.insert("cellsModified".into(), json!(cells_modified));
    if let Some((r0, r1, c0, c1)) = updates_bounds(range_updates) {
        extra.insert("firstRow".into(), json!(r0));
        extra.insert("lastRow".into(), json!(r1));
        extra.insert("firstCol".into(), json!(c0));
        extra.insert("lastCol".into(), json!(c1));
    }
    let desc = format!(
        "{} modified {} cell(s) on sheet {}",
        surface_label(surface),
        cells_modified,
        sheet + 1
    );
    if let Ok(mut audit) = state.audit_log.lock() {
        audit.record_with_extra(
            calp::audit::AuditEvent::ScriptExecuted,
            &desc,
            "local",
            &now,
            extra,
        );
    }
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
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
/// `update_cells_batch` (single undo entry + dependency recalc). NON-active sheets
/// are now first-class too: each changed sheet's BEFORE cells are snapshotted and
/// recorded as a `script_grid_cells` CustomRestore (joined into the SAME undo
/// transaction as the active diff), the post-script grid is applied, then the
/// sheet is recalced (`recalculate_sheet_values`), the workbook is marked dirty,
/// and a per-sheet audit entry is written. No-ops when nothing changed.
///
/// RESIDUAL (v1): `recalculate_sheet_values` re-evaluates PRE-EXISTING parsed
/// formula cells on the non-active sheet; a formula a script writes AS A STRING to
/// a non-active sheet (e.g. "=A1+B1") lands as literal text (the script op stores
/// `ast: None` and only the active diff is re-parsed by `update_cells_batch`).
/// And a formula on a THIRD sheet (neither written nor active) that references a
/// written cell refreshes on next recalc/visit — same class as the single-sheet
/// dependency-map limitation (BUG-0016). Both are pre-existing engine limits, not
/// regressions of this path.
///
/// LOCK DISCIPLINE: the AppState grid locks are held only to compute the diff and
/// snapshot/apply the non-active writes, then DROPPED before calling
/// `update_cells_batch` / `recalculate_sheet_values` (which take their own locks)
/// to avoid a deadlock.
pub(crate) fn apply_script_modified_grids(
    state: &State<AppState>,
    file_state: &State<FileState>,
    user_files_state: &State<UserFilesState>,
    pivot_state: &State<'_, crate::pivot::PivotState>,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    modified_grids: &[Grid],
    active_sheet: usize,
    cells_modified: u32,
    surface: &str,
    surface_id: &str,
) -> Result<(), String> {
    if cells_modified == 0 || modified_grids.is_empty() {
        return Ok(());
    }

    // GET.CONTROLVALUE snapshot: built ONCE, BEFORE any grid locks (canonical
    // lock order: control stores first, grids last). Consumed by the
    // active-sheet batch below; the per-sheet recalc passes rebuild their own
    // snapshot from the same states (recalculate_sheet_values builds before
    // its grid locks too). Without this, a script write would re-evaluate
    // GET.CONTROLVALUE formulas with an empty snapshot and clobber them to #N/A.
    let control_values = crate::control_values::build_control_values(
        state, pane_control_state, ribbon_filter_state,
    );

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

    // Apply non-active-sheet writes the undoable + recalc-tracked way (no longer a
    // silent wholesale swap). For each non-active sheet the script changed, snapshot
    // its BEFORE cells (the union of populated coords in both grids — each entry
    // carries the full prior `Cell`, incl. cached value), then apply the post-script
    // grid. The snapshots drive a single CustomRestore undo entry; recalc + dirty +
    // audit follow below.
    struct NonActiveWrite {
        sheet_index: usize,
        before_cells: Vec<(u32, u32, Option<Cell>)>,
        diff: Vec<CellUpdateInput>,
    }
    let mut non_active_writes: Vec<NonActiveWrite> = Vec::new();
    {
        let mut app_grids = state.grids.lock().map_err(|e| e.to_string())?;
        for (idx, after_grid) in modified_grids.iter().enumerate() {
            if idx == active_sheet || idx >= app_grids.len() {
                continue;
            }
            let diff = diff_grids_to_updates(&app_grids[idx], after_grid);
            if diff.is_empty() {
                continue;
            }
            // Snapshot BEFORE cells for the union of populated coords (a superset of
            // what changed — over-capturing an unchanged cell restores it to itself,
            // a no-op). This guarantees undo returns the sheet to EXACT prior state,
            // including formula cells that `recalculate_sheet_values` re-evaluates.
            let before_cells: Vec<(u32, u32, Option<Cell>)> = {
                let before_grid = &app_grids[idx];
                let mut coords: std::collections::HashSet<(u32, u32)> =
                    std::collections::HashSet::new();
                coords.extend(before_grid.cells.keys().copied());
                coords.extend(after_grid.cells.keys().copied());
                let mut v: Vec<(u32, u32, Option<Cell>)> = coords
                    .into_iter()
                    .map(|(r, c)| (r, c, before_grid.get_cell(r, c).cloned()))
                    .collect();
                v.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
                v
            };
            app_grids[idx] = after_grid.clone();
            non_active_writes.push(NonActiveWrite { sheet_index: idx, before_cells, diff });
        }
        drop(app_grids);
    }
    let has_non_active = !non_active_writes.is_empty();

    // Open ONE undo transaction so the non-active CustomRestores and the active-sheet
    // diff (recorded by `update_cells_batch`, which JOINS an already-open transaction
    // and won't commit it) land as a SINGLE undoable action.
    if has_non_active {
        let mut undo = state.undo_stack.lock().map_err(|e| e.to_string())?;
        undo.begin_transaction(format!("{} edit", surface_label(surface)));
        for w in &non_active_writes {
            let snapshot = crate::undo_commands::ScriptGridCellsSnapshot {
                sheet_index: w.sheet_index,
                cells: w.before_cells.clone(),
            };
            let data = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
            undo.record_custom_restore(
                "script_grid_cells".to_string(),
                data,
                "Script edit (off-sheet)",
            );
        }
    }

    // Replay the active-sheet diff through the edit pipeline (parse + recalc + undo +
    // dirty). All AppState grid locks acquired above are now dropped. Capture the
    // result so the combined transaction is finalized even if the batch errors —
    // an open transaction left dangling would bleed into the next edit.
    let active_result: Result<(), String> = if !updates.is_empty() {
        let cell_count = updates.len();
        // Active-sheet audit (transparency): accurate sheet + effective-change count
        // + range. Recorded before the move into update_cells_batch.
        record_script_grid_mutation(state, surface, surface_id, active_sheet, cell_count as u32, &updates);
        let r = crate::commands::data::update_cells_batch_with_controls(
            state.clone(),
            file_state.clone(),
            user_files_state.clone(),
            pivot_state.clone(),
            updates,
            None,
            Some(control_values),
        );
        if r.is_ok() {
            log_info!(
                "SCRIPT",
                "applied {} active-sheet cell change(s) via edit pipeline (parsed + recalc + undoable)",
                cell_count
            );
        }
        r.map(|_| ())
    } else {
        Ok(())
    };

    if !has_non_active {
        // No outer transaction we own; just propagate any batch error.
        return active_result.map(|_| ());
    }

    {
        // ALWAYS commit the transaction we opened — even if the active batch errored —
        // so it can never dangle open on the undo stack and bleed into the next edit.
        let mut undo = state.undo_stack.lock().map_err(|e| e.to_string())?;
        undo.commit_transaction();
    }
    // Propagate a batch error now (after committing); skip recalc/audit on failure.
    active_result?;

    {
        // Recalc each written non-active sheet (its own formula chains), then the
        // active sheet (active formulas that READ the written cells — the batch
        // path's cascade is seeded only from active-sheet writes, so it misses
        // active -> non-active references). Reuses the .calp refresh pattern.
        // Each pass receives the pane-control/ribbon-filter states so
        // GET.CONTROLVALUE formulas re-evaluate against the real snapshot.
        for w in &non_active_writes {
            crate::calculation::recalculate_sheet_values(
                state,
                user_files_state,
                pivot_state,
                w.sheet_index,
                Some((pane_control_state, ribbon_filter_state)),
            );
        }
        crate::calculation::recalculate_sheet_values(
            state,
            user_files_state,
            pivot_state,
            active_sheet,
            Some((pane_control_state, ribbon_filter_state)),
        );
        // Dirty flag (update_cells_batch sets it only when there was an active diff).
        if let Ok(mut modified) = file_state.is_modified.lock() {
            *modified = true;
        }
        // Per-sheet audit with correct attribution + range (replaces the prior single
        // active-sheet entry that mis-attributed off-sheet writes to the active sheet).
        for w in &non_active_writes {
            record_script_grid_mutation(
                state, surface, surface_id, w.sheet_index, w.diff.len() as u32, &w.diff,
            );
        }
        log_info!(
            "SCRIPT",
            "applied {} non-active sheet(s) undoably (snapshot undo + per-sheet recalc + dirty + audit)",
            non_active_writes.len()
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
/// The `file_state`, `user_files_state`, `pivot_state`, `pane_control_state`,
/// and `ribbon_filter_state` parameters exist solely so this command can
/// forward them to the apply path (`update_cells_batch` + recalc, incl. the
/// GET.CONTROLVALUE snapshot); Tauri injects them by type from the
/// managed-state set, so no change to the `generate_handler!` registration is
/// needed.
#[tauri::command]
pub fn run_script(
    state: State<AppState>,
    script_state: State<ScriptState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: RunScriptRequest,
    window: tauri::Window,
) -> Result<RunScriptResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
    //    replay it via update_cells_batch (single undo entry + recalc). Writes to
    //    non-active sheets are snapshot-undoable + per-sheet recalced + audited too
    //    (one combined transaction); see apply_script_modified_grids for residual
    //    cross-sheet limits.
    if let script_engine::ScriptResult::Success { cells_modified, .. } = &result {
        apply_script_modified_grids(
            &state,
            &file_state,
            &user_files_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
            &modified_grids,
            active_sheet,
            *cells_modified,
            "run_script",
            &request.filename,
        )?;
    }

    // 4. Convert to response type. run_script is a string-output surface:
    //    structured items (tables from display.table) flatten to text.
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
            output: output.iter().map(|i| i.to_text()).collect(),
            cells_modified,
            duration_ms,
            bookmark_mutations,
            deferred_actions,
            screen_updating,
            enable_events,
        }),
        script_engine::ScriptResult::Error { message, output } => {
            Ok(RunScriptResponse::Error {
                message,
                output: output.iter().map(|i| i.to_text()).collect(),
            })
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
