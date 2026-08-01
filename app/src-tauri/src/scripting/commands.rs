//! FILENAME: app/src-tauri/src/scripting/commands.rs
//! PURPOSE: Tauri commands for script execution and management.
//! CONTEXT: These commands bridge the frontend Script Editor extension
//! to the Rust script engine. They follow the same patterns as pivot commands.

use std::collections::HashMap;
use std::sync::Arc;

use tauri::State;

use crate::AppState;
use crate::api_types::CellUpdateInput;
use crate::control_values::ControlValuesMap;
use crate::pane_control::PaneControlState;
use crate::persistence::{FileState, UserFilesState};
use crate::pivot::PivotState;
use crate::ribbon_filter::RibbonFilterState;
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
pub(crate) fn diff_grids_to_updates(before: &Grid, after: &Grid) -> Vec<CellUpdateInput> {
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

/// Turn the FORMULA STRINGS a script wrote into real formula cells.
///
/// The script engine has no parser: every write it makes stores `ast: None`
/// (see `core/script-engine/src/ops/cells.rs`), so `Calcula.setCellValue(0, 0,
/// "=A1+B1", 2)` leaves the literal text `=A1+B1` sitting in the grid. The
/// ACTIVE sheet escapes this because its diff is replayed through
/// `update_cells_batch`, which parses. Every OTHER sheet used to be installed by
/// a wholesale grid swap, so its formulas stayed text forever.
///
/// This is that missing parse step for the sheets the batch pipeline cannot
/// reach: for each diffed cell whose input string starts with '=', rebuild the
/// cell with `parse_cell_input_invariant` (identical parsing to the batch path —
/// the diff already carries invariant/US-format text) and carry the post-script
/// style index over. The resulting cell has an AST and an Empty value; the
/// per-sheet `recalculate_sheet_values` pass that follows evaluates it.
///
/// Cells that already hold an AST are left alone (a pre-existing formula the
/// script did not author), and an unparseable "=..." falls back to text exactly
/// as `Cell::new_formula` does everywhere else.
///
/// Pure function (grid in, grid out) so the parse rule is unit-testable.
pub(crate) fn parse_script_formula_writes(
    after: &Grid,
    diff: &[CellUpdateInput],
    locale: &engine::LocaleSettings,
) -> Grid {
    let mut prepared = after.clone();
    for update in diff {
        if !update.value.starts_with('=') {
            continue;
        }
        let existing = prepared.get_cell(update.row, update.col);
        if existing.map(|c| c.ast.is_some()).unwrap_or(false) {
            continue;
        }
        let style_index = existing.map(|c| c.style_index).unwrap_or(0);
        let mut cell = crate::parse_cell_input_invariant(&update.value, locale);
        cell.style_index = style_index;
        prepared.set_cell(update.row, update.col, cell);
    }
    prepared
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

/// Record a non-script MCP/AI tool mutation (formatting, chart/table/pivot/
/// named-range creation) into the SAME per-workbook audit trail as script grid
/// mutations (`AuditEvent::ScriptExecuted`, surface "mcp"), so every way an AI
/// client can change the workbook is visible in the audit viewer — not only the
/// cell writes that flow through the script engine. `extra` carries the tool's
/// structured attribution (tool name is added here; pass target details).
pub(crate) fn record_mcp_tool_action(
    state: &AppState,
    tool: &str,
    desc: &str,
    extra_fields: Vec<(&str, serde_json::Value)>,
) {
    use serde_json::json;
    let now = chrono::Utc::now().to_rfc3339();
    let mut extra: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    extra.insert("surface".into(), json!("mcp"));
    extra.insert("tool".into(), json!(tool));
    for (k, v) in extra_fields {
        extra.insert(k.to_string(), v);
    }
    if let Ok(mut audit) = state.audit_log.lock() {
        audit.record_with_extra(
            calp::audit::AuditEvent::ScriptExecuted,
            desc,
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

/// Error sentinel for an AI tool call blocked by the MCP access ceiling.
pub const MCP_ACCESS_RESTRICTED: &str = "MCP_ACCESS_RESTRICTED";

/// The tier an AI tool call needs: workbook mutations (writes, formatting,
/// object creation) or arbitrary script execution. Read-only tools need no
/// check — "read" is always allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum McpAccessTier {
    Mutate,
    Script,
}

/// Rank of an access-level string; unknown values rank as the most
/// restrictive tier so a tampered persisted level can never widen access.
fn mcp_access_rank(level: &str) -> u8 {
    match level {
        "script" => 2,
        "mutate" => 1,
        _ => 0, // "read" or anything unrecognized
    }
}

/// Gate for the AI tool surface (MCP server + in-app AI chat): enforce the
/// user-set access ceiling ("read" < "mutate" < "script"), THEN the Script
/// Security consent gate. The ceiling caps what a consented session may do —
/// e.g. "mutate" lets an agent edit the workbook but never run arbitrary JS.
pub(crate) fn check_mcp_access(
    script_state: &ScriptState,
    required: McpAccessTier,
) -> Result<(), String> {
    let ceiling = script_state
        .mcp_access_level
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let required_rank = match required {
        McpAccessTier::Mutate => 1,
        McpAccessTier::Script => 2,
    };
    if mcp_access_rank(&ceiling) < required_rank {
        let needed = match required {
            McpAccessTier::Mutate => "workbook mutations",
            McpAccessTier::Script => "script execution",
        };
        return Err(format!(
            "{}: This tool needs {} but the AI access level is set to '{}' (MCP Server panel)",
            MCP_ACCESS_RESTRICTED, needed, ceiling
        ));
    }
    check_script_security(script_state)
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

/// Serialize the BEFORE cells of an off-active-sheet script write into the
/// `script_grid_cells` CustomRestore payload undo consumes.
///
/// A serialization failure is FATAL for the write, and that is deliberate: this
/// runs in the PLAN phase, before anything has been mutated, so refusing keeps
/// the operation atomic. The alternative — recording an empty/partial snapshot —
/// would leave the script's value sitting where the user's formula was with no
/// way back.
///
/// (Formula ASTs used to be unserializable whenever they carried a literal, so
/// this had a per-cell salvage fallback. `parser::ast::Value` is adjacently
/// tagged now and every AST round-trips, so the fallback is gone.)
fn script_grid_cells_snapshot_bytes(
    sheet_index: usize,
    before_cells: Vec<(u32, u32, Option<Cell>)>,
) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&crate::undo_commands::ScriptGridCellsSnapshot {
        sheet_index,
        cells: before_cells,
    })
    .map_err(|e| {
        format!(
            "Refusing this script's write to sheet {}: its prior contents could not be \
             captured for undo ({})",
            sheet_index + 1,
            e
        )
    })
}

/// How the shared apply path writes the ACTIVE sheet's diff.
///
/// Production hands over `update_cells_batch_with_controls` (parse + evaluate +
/// dependency maps + spill + a single undo entry). It is a closure rather than a
/// direct call for one reason: that function takes Tauri `State` handles, which
/// cannot be constructed outside a running app, so the surrounding
/// transaction/diff/off-sheet logic would otherwise be untestable.
type ActiveSheetApply<'a> =
    &'a dyn Fn(Vec<CellUpdateInput>, Arc<ControlValuesMap>) -> Result<(), String>;

/// Apply a script engine's `modified_grids` back into live AppState the
/// undoable, recalc-tracked, event-visible way (C1a). Shared by the in-app
/// `run_script`, the MCP `execute_script` and the NOTEBOOK cell runner, so
/// every Rust-QuickJS surface inherits the exact same edit-pipeline behavior —
/// instead of the wholesale grid swap those surfaces used to do (which skipped
/// undo + parsing + recalc + events).
///
/// EVERY changed sheet is diffed before->after; no sheet is installed wholesale:
///
/// * ACTIVE sheet — replayed through `update_cells_batch` (parse + dependency
///   maps + spill + recalc cascade + one undo entry).
/// * NON-ACTIVE sheets — the BEFORE cells are snapshotted into a
///   `script_grid_cells` CustomRestore (joined into the SAME undo transaction as
///   the active diff), the post-script grid is installed with the script's
///   formula STRINGS parsed into real formula cells
///   (`parse_script_formula_writes`), then the sheet is evaluated by
///   `recalculate_sheet_values`. The workbook is marked dirty and a per-sheet
///   audit entry is written.
///
/// RECALC ORDER: writes to all sheets are installed BEFORE anything is
/// evaluated, then the sequence [written non-active sheets in index order, then
/// the active sheet] runs TWICE. One pass would leave a formula stale whenever
/// the sheet it reads is evaluated after it (e.g. sheet 2 reads a written
/// formula on sheet 3, or reads an active-sheet formula that itself reads
/// sheet 3). The second pass settles that hop. Chains longer than two hops
/// between written sheets refresh on the next recalc — the same class as the
/// single-sheet dependency-map limitation (BUG-0016).
///
/// LOCK DISCIPLINE: the AppState grid locks are held only to compute the diff and
/// snapshot/apply the non-active writes, then DROPPED before calling
/// `update_cells_batch` / `recalculate_sheet_values` (which take their own locks)
/// to avoid a deadlock.
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_script_modified_grids_core(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &PivotState,
    pane_control_state: &PaneControlState,
    ribbon_filter_state: &RibbonFilterState,
    modified_grids: &[Grid],
    active_sheet: usize,
    cells_modified: u32,
    surface: &str,
    surface_id: &str,
    apply_active: ActiveSheetApply<'_>,
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

    // SHEET PROTECTION, decided for EVERY sheet before ANY of them is mutated.
    //
    // Two reasons this is a whole-workbook pre-pass rather than a per-sheet gate
    // at each write:
    //
    //  1. The active sheet is gated inside `update_cells_batch_with_controls`,
    //     which runs AFTER the non-active grids have already been installed
    //     below. Without this pre-pass, a refusal on the active sheet would
    //     return early leaving every other sheet's writes applied — and skipped
    //     past their recalc, dirty flag and audit entries.
    //  2. Non-active sheets are installed directly into `app_grids[idx]`, which
    //     consults nothing. A script calling
    //     `Calcula.workbook.sheets(i).range(...).setValue(...)` on a protected
    //     background sheet would otherwise write straight through it.
    //
    // Deciding first makes a refusal atomic: nothing has been touched yet, so
    // there is nothing to roll back.
    {
        let app_grids = state.grids.lock().map_err(|e| e.to_string())?;
        // Borrowed gate form: `grids` is held for the whole loop and
        // std::sync::Mutex is not reentrant, so the locking wrapper would
        // deadlock here. Acquire the rest in canonical order
        // (grids -> style_registry -> sheet_protection).
        let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        let protection_storage = state.sheet_protection.lock().map_err(|e| e.to_string())?;
        let empty_grid = Grid::new();
        for (idx, after_grid) in modified_grids.iter().enumerate() {
            if idx >= app_grids.len() {
                continue;
            }
            let before = app_grids.get(idx).unwrap_or(&empty_grid);
            let diff = diff_grids_to_updates(before, after_grid);
            if diff.is_empty() {
                continue;
            }
            // Lock state is read from the PRE-script grid — whether the user may
            // write a cell depends on what the sheet looks like now, not on what
            // the script wants it to become.
            crate::protection::check_sheet_protection_cells_in(
                &protection_storage,
                before,
                &styles,
                idx,
                diff.iter().map(|u| (u.row, u.col)),
            )?;
        }
    }

    // Apply non-active-sheet writes the undoable + parsed + recalc-tracked way,
    // in two phases under one grids lock:
    //
    //   PLAN  — diff each changed sheet, capture its BEFORE cells, SERIALIZE the
    //           undo snapshot and build the parsed post-script grid. Nothing is
    //           mutated yet, so any failure here (a protected cell, an
    //           unrepresentable prior cell) leaves the workbook untouched.
    //   APPLY — install the planned grids. Cannot fail.
    //
    // The snapshot has to be produced BEFORE the install: it used to be
    // serialized after every grid had already been swapped in, so a serialization
    // failure returned an error on a workbook that had already been written to,
    // with no undo entry, no recalc and no dirty flag.
    struct NonActiveWrite {
        sheet_index: usize,
        snapshot_bytes: Vec<u8>,
        diff: Vec<CellUpdateInput>,
        /// The grid to install; taken during the APPLY phase.
        prepared: Option<Grid>,
    }
    let mut non_active_writes: Vec<NonActiveWrite> = Vec::new();
    {
        let mut app_grids = state.grids.lock().map_err(|e| e.to_string())?;
        // Canonical order inside this block: grids -> locale (the order
        // update_cells_batch_core acquires them in).
        let locale = state.locale.lock().map_err(|e| e.to_string())?.clone();
        // --- PLAN ---
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
            // a no-op). This is what lets undo return the sheet to its EXACT prior
            // state, including formula cells whose cached value
            // `recalculate_sheet_values` refreshes below. See
            // `script_grid_cells_snapshot_bytes` for the atomicity contract.
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
            let snapshot_bytes = script_grid_cells_snapshot_bytes(idx, before_cells)?;
            // The parse step the batch pipeline performs for the active sheet —
            // without it a script's "=A1+B1" stays literal text off-sheet.
            let prepared = parse_script_formula_writes(after_grid, &diff, &locale);
            non_active_writes.push(NonActiveWrite {
                sheet_index: idx,
                snapshot_bytes,
                diff,
                prepared: Some(prepared),
            });
        }
        // --- APPLY ---
        for w in non_active_writes.iter_mut() {
            app_grids[w.sheet_index] = w.prepared.take().expect("planned grid");
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
            undo.record_custom_restore(
                "script_grid_cells".to_string(),
                w.snapshot_bytes.clone(),
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
        // + range. Recorded before the move into the batch.
        record_script_grid_mutation(state, surface, surface_id, active_sheet, cell_count as u32, &updates);
        let r = apply_active(updates, control_values);
        if r.is_ok() {
            log_info!(
                "SCRIPT",
                "applied {} active-sheet cell change(s) via edit pipeline (parsed + recalc + undoable)",
                cell_count
            );
        }
        r
    } else {
        Ok(())
    };

    if !has_non_active {
        // No outer transaction we own; just propagate any batch error.
        return active_result;
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
        // Evaluate every sheet that changed. Sequence = written non-active sheets
        // (index order), then the active sheet — the active pass is what refreshes
        // active formulas that READ the written cells, since the batch path's
        // cascade is seeded only from active-sheet writes. Run TWICE: writes are
        // all installed by now, so a second pass propagates one more cross-sheet
        // hop (sheet 2 reading a written formula on sheet 3, or reading an active
        // formula that itself reads sheet 3) that a single ordered pass leaves
        // stale. Each pass receives the pane-control/ribbon-filter states so
        // GET.CONTROLVALUE formulas re-evaluate against the real snapshot.
        for _pass in 0..2 {
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
        }
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
            "applied {} non-active sheet(s) undoably (snapshot undo + parse + per-sheet recalc + dirty + audit)",
            non_active_writes.len()
        );
    }

    Ok(())
}

/// `apply_script_modified_grids_core` wired to the real edit pipeline. This is
/// the entry point every surface with Tauri `State` handles uses (run_script,
/// MCP execute_script).
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_script_modified_grids(
    state: &State<AppState>,
    file_state: &State<FileState>,
    user_files_state: &State<UserFilesState>,
    pivot_state: &State<'_, PivotState>,
    pane_control_state: &PaneControlState,
    ribbon_filter_state: &RibbonFilterState,
    modified_grids: &[Grid],
    active_sheet: usize,
    cells_modified: u32,
    surface: &str,
    surface_id: &str,
) -> Result<(), String> {
    apply_script_modified_grids_core(
        state,
        file_state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        modified_grids,
        active_sheet,
        cells_modified,
        surface,
        surface_id,
        &|updates, control_values| {
            crate::commands::data::update_cells_batch_with_controls(
                state.clone(),
                file_state.clone(),
                user_files_state.clone(),
                pivot_state.clone(),
                updates,
                None,
                Some(control_values),
            )
            .map(|_| ())
        },
    )
}

/// Persist EVERYTHING a successful script run produced server-side: the grid
/// writes (see `apply_script_modified_grids`) and the workbook properties the
/// script set with `Calcula.setWorkbookProperty`.
///
/// Document metadata is deliberately NOT a DeferredAction — it is state the
/// backend owns, so a surface that only forwarded deferred actions to the
/// frontend (the notebook) used to drop those writes on the floor.
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_script_result(
    state: &State<AppState>,
    file_state: &State<FileState>,
    user_files_state: &State<UserFilesState>,
    pivot_state: &State<'_, PivotState>,
    pane_control_state: &PaneControlState,
    ribbon_filter_state: &RibbonFilterState,
    modified_grids: &[Grid],
    active_sheet: usize,
    cells_modified: u32,
    workbook_properties_changed: &HashMap<String, String>,
    surface: &str,
    surface_id: &str,
) -> Result<(), String> {
    apply_script_modified_grids(
        state,
        file_state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        modified_grids,
        active_sheet,
        cells_modified,
        surface,
        surface_id,
    )?;
    // Outside the grid apply on purpose: a script may set only document
    // properties and touch no cell at all, which short-circuits the grid path.
    super::types::apply_workbook_property_changes(
        state,
        file_state,
        workbook_properties_changed,
    )?;
    Ok(())
}

/// `apply_script_result` for surfaces that hold an `AppHandle` instead of the
/// individual `State` handles — the notebook executor path, which runs its cells
/// on a dedicated thread and only carries the handle.
pub(crate) fn apply_script_result_via_handle(
    app: &tauri::AppHandle,
    modified_grids: &[Grid],
    active_sheet: usize,
    cells_modified: u32,
    workbook_properties_changed: &HashMap<String, String>,
    surface: &str,
    surface_id: &str,
) -> Result<(), String> {
    use tauri::Manager;
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState is not managed".to_string())?;
    let file_state = app
        .try_state::<FileState>()
        .ok_or_else(|| "FileState is not managed".to_string())?;
    let user_files_state = app
        .try_state::<UserFilesState>()
        .ok_or_else(|| "UserFilesState is not managed".to_string())?;
    let pivot_state = app
        .try_state::<PivotState>()
        .ok_or_else(|| "PivotState is not managed".to_string())?;
    let pane_control_state = app
        .try_state::<PaneControlState>()
        .ok_or_else(|| "PaneControlState is not managed".to_string())?;
    let ribbon_filter_state = app
        .try_state::<RibbonFilterState>()
        .ok_or_else(|| "RibbonFilterState is not managed".to_string())?;

    apply_script_result(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        modified_grids,
        active_sheet,
        cells_modified,
        workbook_properties_changed,
        surface,
        surface_id,
    )
}

/// Execute a script against the current spreadsheet state.
///
/// 1. Clones the relevant AppState data (grids, styles, sheet names)
/// 2. Runs the script in an isolated QuickJS runtime (on a CLONE of the grids),
///    fed the real application info + live workbook state and bounded by the
///    one-off runtime limits
/// 3. If successful, DIFFS the script's result against the live AppState and
///    replays the changes through the normal edit pipeline so they get formula
///    parsing, dependency recalc, and a single undo entry — instead of a
///    wholesale grid swap — then persists the workbook properties it set
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

    // 2. Run the script with the REAL application info + live workbook state,
    //    under the one-off runtime limits (memory + stack + wall-clock budget).
    let options = script_engine::ScriptRunOptions {
        app_info: super::types::build_app_info(&state),
        host_state: super::types::build_host_state(
            &state,
            Some(&file_state),
            active_sheet,
            request.view_state.as_ref(),
        ),
        cell_bookmarks_json: request.cell_bookmarks_json.unwrap_or_else(|| "[]".to_string()),
        view_bookmarks_json: request.view_bookmarks_json.unwrap_or_else(|| "[]".to_string()),
        limits: script_engine::ScriptLimits::default(),
    };
    let (result, modified_grids) = script_engine::ScriptEngine::run_with_options(
        &request.source,
        &request.filename,
        grids,
        style_registry,
        sheet_names,
        active_sheet,
        options,
    );

    // 3. If successful, route everything the run produced back into AppState:
    //    cell writes through the edit pipeline (parsed, recalculated, undoable)
    //    and the workbook properties the script set.
    //
    //    The engine ran on a CLONE; AppState still holds the ORIGINAL grids, so
    //    AppState IS the "before". Every changed sheet is diffed and replayed —
    //    the active one via update_cells_batch, the rest snapshot-undoable +
    //    parsed + per-sheet recalced + audited (one combined transaction). See
    //    apply_script_modified_grids_core for the recalc-order reasoning.
    if let script_engine::ScriptResult::Success {
        cells_modified,
        workbook_properties_changed,
        ..
    } = &result
    {
        apply_script_result(
            &state,
            &file_state,
            &user_files_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
            &modified_grids,
            active_sheet,
            *cells_modified,
            workbook_properties_changed,
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
            // Persisted server-side in step 3 — not part of the IPC response.
            workbook_properties_changed: _,
            screen_updating,
        } => Ok(RunScriptResponse::Success {
            output: output.iter().map(|i| i.to_text()).collect(),
            cells_modified,
            duration_ms,
            bookmark_mutations,
            deferred_actions,
            screen_updating,
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
        .map_err(|e| e.to_string())? = level;
    // Persist (per-app, not per-workbook) so the choice survives relaunch (B5).
    persist_security_config(window.app_handle(), &script_state);
    Ok(())
}

/// Get the current AI access ceiling ("read" | "mutate" | "script").
#[tauri::command]
pub fn get_mcp_access_level(script_state: State<ScriptState>) -> Result<String, String> {
    let level = script_state
        .mcp_access_level
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    Ok(level)
}

/// Set the AI access ceiling for the MCP / in-app AI tool surface.
#[tauri::command]
pub fn set_mcp_access_level(
    script_state: State<ScriptState>,
    level: String,
    window: tauri::Window,
) -> Result<(), String> {
    use tauri::Manager;
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let valid_levels = ["read", "mutate", "script"];
    if !valid_levels.contains(&level.as_str()) {
        return Err(format!(
            "Invalid MCP access level '{}'. Must be one of: read, mutate, script",
            level
        ));
    }
    *script_state
        .mcp_access_level
        .lock()
        .map_err(|e| e.to_string())? = level;
    persist_security_config(window.app_handle(), &script_state);
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

/// Persist the Script Security level + AI access ceiling (one config file) so
/// both survive relaunch. Best-effort; reads the current values from state.
fn persist_security_config(app: &tauri::AppHandle, script_state: &ScriptState) {
    let level = match script_state.security_level.lock() {
        Ok(l) => l.clone(),
        Err(_) => return,
    };
    let mcp_level = match script_state.mcp_access_level.lock() {
        Ok(l) => l.clone(),
        Err(_) => return,
    };
    if let Some(path) = security_config_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::json!({
            "securityLevel": level,
            "mcpAccessLevel": mcp_level,
        });
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

/// Parse + validate a persisted AI access ceiling. Same fail-closed contract as
/// `parse_persisted_level`: anything unrecognized keeps the in-memory default.
fn parse_persisted_mcp_level(bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let level = value.get("mcpAccessLevel")?.as_str()?;
    ["read", "mutate", "script"]
        .contains(&level)
        .then(|| level.to_string())
}

/// Read the persisted Script Security config (if any) and apply it to
/// ScriptState at startup. Falls back to the in-memory defaults ("prompt" /
/// "script") when the file is absent or a field is invalid. Called once after
/// the app is built.
pub fn hydrate_security_level(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(path) = security_config_path(app) else { return };
    let Ok(bytes) = std::fs::read(&path) else { return };
    let Some(state) = app.try_state::<ScriptState>() else { return };
    if let Some(level) = parse_persisted_level(&bytes) {
        if let Ok(mut lvl) = state.security_level.lock() {
            *lvl = level;
        }
    }
    if let Some(level) = parse_persisted_mcp_level(&bytes) {
        if let Ok(mut lvl) = state.mcp_access_level.lock() {
            *lvl = level;
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

    #[test]
    fn accepts_valid_mcp_levels() {
        for lvl in ["read", "mutate", "script"] {
            let bytes = format!("{{\"mcpAccessLevel\":\"{}\"}}", lvl);
            assert_eq!(
                super::parse_persisted_mcp_level(bytes.as_bytes()),
                Some(lvl.to_string())
            );
        }
    }

    #[test]
    fn rejects_invalid_mcp_levels() {
        assert_eq!(super::parse_persisted_mcp_level(br#"{"mcpAccessLevel":"admin"}"#), None);
        assert_eq!(super::parse_persisted_mcp_level(br#"{"mcpAccessLevel":1}"#), None);
        assert_eq!(super::parse_persisted_mcp_level(br#"{}"#), None);
    }
}

#[cfg(test)]
mod mcp_access_tests {
    use super::{check_mcp_access, McpAccessTier, MCP_ACCESS_RESTRICTED};
    use crate::scripting::types::ScriptState;

    /// ScriptState with Script Security "enabled" (so only the ceiling gates)
    /// and the given AI access ceiling.
    fn state_with(ceiling: &str) -> ScriptState {
        let state = ScriptState::new();
        *state.security_level.lock().unwrap() = "enabled".to_string();
        *state.mcp_access_level.lock().unwrap() = ceiling.to_string();
        state
    }

    #[test]
    fn read_ceiling_blocks_mutate_and_script() {
        let state = state_with("read");
        for tier in [McpAccessTier::Mutate, McpAccessTier::Script] {
            let err = check_mcp_access(&state, tier).unwrap_err();
            assert!(err.starts_with(MCP_ACCESS_RESTRICTED), "got: {}", err);
        }
    }

    #[test]
    fn mutate_ceiling_allows_mutate_blocks_script() {
        let state = state_with("mutate");
        assert!(check_mcp_access(&state, McpAccessTier::Mutate).is_ok());
        let err = check_mcp_access(&state, McpAccessTier::Script).unwrap_err();
        assert!(err.starts_with(MCP_ACCESS_RESTRICTED), "got: {}", err);
    }

    #[test]
    fn script_ceiling_allows_both() {
        let state = state_with("script");
        assert!(check_mcp_access(&state, McpAccessTier::Mutate).is_ok());
        assert!(check_mcp_access(&state, McpAccessTier::Script).is_ok());
    }

    #[test]
    fn unknown_ceiling_ranks_as_read() {
        let state = state_with("bogus");
        let err = check_mcp_access(&state, McpAccessTier::Mutate).unwrap_err();
        assert!(err.starts_with(MCP_ACCESS_RESTRICTED), "got: {}", err);
    }

    #[test]
    fn ceiling_pass_still_defers_to_script_security() {
        let state = state_with("script");
        *state.security_level.lock().unwrap() = "disabled".to_string();
        let err = check_mcp_access(&state, McpAccessTier::Script).unwrap_err();
        assert!(err.starts_with(super::SCRIPTS_DISABLED), "got: {}", err);
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

// ============================================================================
// Script apply-path tests
// ============================================================================
//
// These drive `apply_script_modified_grids_core` — the single path every Rust
// QuickJS surface (run_script, MCP, notebook cells) now writes through — against
// a real `AppState`. The active-sheet leg is handed to the caller as a closure
// (see `ActiveSheetApply`) because `update_cells_batch_with_controls` takes
// Tauri `State` handles, which cannot exist outside a running app; the tests
// therefore exercise the OFF-active-sheet leg end to end (snapshot undo, parse,
// evaluate, dirty, audit) and assert structurally on what the active leg is
// handed and when.

#[cfg(test)]
mod script_apply_tests {
    use super::*;
    use crate::pane_control::PaneControlState;
    use crate::persistence::{FileState, UserFilesState};
    use crate::pivot::PivotState;
    use crate::ribbon_filter::RibbonFilterState;
    use engine::{Cell, CellValue, Grid};
    use std::cell::RefCell;
    use std::collections::HashMap as StdHashMap;
    use std::sync::Mutex;

    /// The managed-state set the apply path needs, owned by the test.
    struct Harness {
        state: AppState,
        file_state: FileState,
        user_files: UserFilesState,
        pivot: PivotState,
        pane: PaneControlState,
        ribbon: RibbonFilterState,
    }

    /// A two-sheet workbook with sheet 0 active. Sheet 1 is the NON-active sheet
    /// the batch pipeline cannot reach — the leg these tests own.
    fn harness(sheet1: Grid) -> Harness {
        let state = crate::create_app_state();
        // Deterministic parsing/rendering regardless of the machine's locale.
        *state.locale.lock().unwrap() = engine::LocaleSettings::invariant();
        state.grids.lock().unwrap().push(sheet1);
        state.sheet_names.lock().unwrap().push("Sheet2".to_string());
        state.sheet_visibility.lock().unwrap().push("visible".to_string());
        state.all_column_widths.lock().unwrap().push(Default::default());
        state.all_row_heights.lock().unwrap().push(Default::default());
        state.show_gridlines.lock().unwrap().push(true);
        Harness {
            state,
            file_state: FileState {
                current_path: Mutex::new(None),
                is_modified: Mutex::new(false),
                session_password: Mutex::new(None),
                is_encrypted: Mutex::new(false),
            },
            user_files: UserFilesState {
                files: Mutex::new(StdHashMap::new()),
            },
            pivot: PivotState::new(),
            pane: PaneControlState::new(),
            ribbon: RibbonFilterState::new(),
        }
    }

    /// The post-script grids for a workbook whose sheet 0 is untouched.
    fn modified(h: &Harness, sheet1_after: Grid) -> Vec<Grid> {
        let sheet0 = h.state.grids.lock().unwrap()[0].clone();
        vec![sheet0, sheet1_after]
    }

    /// Run the shared apply path, recording what the active-sheet leg received.
    /// Returns (updates handed over, was an undo transaction open at that
    /// moment) for each call.
    fn apply(
        h: &Harness,
        modified_grids: &[Grid],
        cells_modified: u32,
        surface: &str,
        surface_id: &str,
    ) -> (Result<(), String>, Vec<(Vec<CellUpdateInput>, bool)>) {
        let calls: RefCell<Vec<(Vec<CellUpdateInput>, bool)>> = RefCell::new(Vec::new());
        let active = |updates: Vec<CellUpdateInput>, _cv: Arc<ControlValuesMap>| {
            let in_transaction = h.state.undo_stack.lock().unwrap().has_open_transaction();
            calls.borrow_mut().push((updates, in_transaction));
            Ok(())
        };
        let result = apply_script_modified_grids_core(
            &h.state,
            &h.file_state,
            &h.user_files,
            &h.pivot,
            &h.pane,
            &h.ribbon,
            modified_grids,
            0,
            cells_modified,
            surface,
            surface_id,
            &active,
        );
        let recorded = calls.borrow().clone();
        (result, recorded)
    }

    /// The cell shape a script write produces: a value with NO ast, because the
    /// script engine has no parser (core/script-engine/src/ops/cells.rs).
    fn script_wrote(value: CellValue) -> Cell {
        Cell {
            ast: None,
            value,
            style_index: 0,
            rich_text: None,
        }
    }

    fn value_at(h: &Harness, sheet: usize, row: u32, col: u32) -> CellValue {
        h.state.grids.lock().unwrap()[sheet]
            .get_cell(row, col)
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    }

    // --- DEFECT 2: formula strings written off the active sheet ------------

    /// Pure parse rule: a diffed "=..." write becomes a real formula cell,
    /// keeping the style the script left on it.
    #[test]
    fn formula_writes_are_parsed_and_keep_their_style() {
        let mut after = Grid::new();
        let mut written = script_wrote(CellValue::Text("=A1+B1".to_string()));
        written.style_index = 7;
        after.set_cell(0, 2, written);
        after.set_cell(0, 3, script_wrote(CellValue::Text("plain".to_string())));

        let diff = diff_grids_to_updates(&Grid::new(), &after);
        let prepared = parse_script_formula_writes(&after, &diff, &engine::LocaleSettings::invariant());

        let formula_cell = prepared.get_cell(0, 2).expect("C1 present");
        assert!(formula_cell.has_formula(), "the '=' write must become a formula");
        assert_eq!(formula_cell.style_index, 7, "style survives the re-parse");
        // A literal is left exactly as the script wrote it.
        assert_eq!(
            prepared.get_cell(0, 3).map(|c| c.value.clone()),
            Some(CellValue::Text("plain".to_string()))
        );
    }

    /// THE regression: `Calcula.setCellValue(0, 2, "=A1+B1", 1)` on a NON-active
    /// sheet used to leave the literal text "=A1+B1" in the grid forever,
    /// because only the active sheet's diff was replayed through the parser.
    /// It must now parse AND evaluate.
    #[test]
    fn formula_string_written_to_a_non_active_sheet_evaluates() {
        let mut sheet1 = Grid::new();
        sheet1.set_cell(0, 0, Cell::new_number(2.0));
        sheet1.set_cell(0, 1, Cell::new_number(3.0));
        let h = harness(sheet1.clone());

        let mut after = sheet1;
        after.set_cell(0, 2, script_wrote(CellValue::Text("=A1+B1".to_string())));
        let grids = modified(&h, after);

        let (result, active_calls) = apply(&h, &grids, 1, "notebook", "nb-1:cell-1");
        assert!(result.is_ok(), "{:?}", result);
        assert!(active_calls.is_empty(), "sheet 0 was untouched");

        let cell = h.state.grids.lock().unwrap()[1]
            .get_cell(0, 2)
            .cloned()
            .expect("C1 present");
        assert!(cell.has_formula(), "must be stored as a formula, not text");
        assert_eq!(cell.value, CellValue::Number(5.0), "and must be evaluated");
    }

    // --- DEFECT 1: undo + recalculation for notebook writes ----------------

    /// A notebook cell's write is undoable: it lands in ONE committed
    /// transaction carrying the exact prior cells, so Ctrl+Z can revert it.
    /// The old wholesale `*app_grids = modified_grids` swap recorded nothing.
    #[test]
    fn a_notebook_write_is_undoable() {
        let mut sheet1 = Grid::new();
        sheet1.set_cell(0, 0, Cell::new_number(5.0));
        let h = harness(sheet1.clone());

        let mut after = sheet1;
        after.set_cell(0, 0, script_wrote(CellValue::Number(42.0)));
        let grids = modified(&h, after);

        let (result, _) = apply(&h, &grids, 1, "notebook", "nb-1:cell-1");
        assert!(result.is_ok(), "{:?}", result);
        assert_eq!(value_at(&h, 1, 0, 0), CellValue::Number(42.0));

        let mut undo = h.state.undo_stack.lock().unwrap();
        assert_eq!(undo.undo_depth(), 1, "exactly one undoable action");
        let transaction = undo.pop_undo().expect("a transaction to undo");
        let restores: Vec<&Vec<u8>> = transaction
            .changes
            .iter()
            .filter_map(|c| match c {
                engine::undo::CellChange::CustomRestore { kind, data }
                    if kind == "script_grid_cells" =>
                {
                    Some(data)
                }
                _ => None,
            })
            .collect();
        assert_eq!(restores.len(), 1, "one snapshot for the one written sheet");

        let snapshot: crate::undo_commands::ScriptGridCellsSnapshot =
            serde_json::from_slice(restores[0]).expect("snapshot deserializes");
        assert_eq!(snapshot.sheet_index, 1);
        let prior = snapshot
            .cells
            .iter()
            .find(|(r, c, _)| *r == 0 && *c == 0)
            .expect("A1 captured");
        assert_eq!(
            prior.2.as_ref().map(|c| c.value.clone()),
            Some(CellValue::Number(5.0)),
            "undo restores the value that was there before the cell ran"
        );
    }

    /// A formula that DEPENDS on a cell the notebook wrote is re-evaluated.
    /// The wholesale swap left it displaying its stale cached value until the
    /// user forced a recalculation.
    #[test]
    fn a_dependent_formula_recalculates_after_a_notebook_write() {
        let mut sheet1 = Grid::new();
        sheet1.set_cell(0, 0, Cell::new_number(1.0));
        let mut dependent = Cell::new_formula("A1*10".to_string());
        dependent.value = CellValue::Number(10.0); // cached result of 1*10
        sheet1.set_cell(0, 1, dependent);
        let h = harness(sheet1.clone());

        let mut after = sheet1;
        after.set_cell(0, 0, script_wrote(CellValue::Number(5.0)));
        let grids = modified(&h, after);

        let (result, _) = apply(&h, &grids, 1, "notebook", "nb-1:cell-1");
        assert!(result.is_ok(), "{:?}", result);
        assert_eq!(
            value_at(&h, 1, 0, 1),
            CellValue::Number(50.0),
            "the dependent formula must not keep its stale cached value"
        );
    }

    /// The workbook is marked dirty, so the write survives to the .cala.
    #[test]
    fn an_off_sheet_write_dirties_the_document() {
        let h = harness(Grid::new());
        let mut after = Grid::new();
        after.set_cell(0, 0, script_wrote(CellValue::Number(1.0)));
        let grids = modified(&h, after);

        let (result, _) = apply(&h, &grids, 1, "notebook", "nb-1:cell-1");
        assert!(result.is_ok(), "{:?}", result);
        assert!(*h.file_state.is_modified.lock().unwrap());
    }

    /// The ACTIVE sheet's writes are handed to the edit pipeline (parse +
    /// dependency maps + recalc cascade) as an invariant diff, and that happens
    /// INSIDE the transaction the off-sheet snapshots opened — so the whole
    /// cell is one undoable action rather than two.
    #[test]
    fn active_sheet_writes_reach_the_edit_pipeline_inside_one_transaction() {
        let h = harness(Grid::new());
        let mut sheet0 = Grid::new();
        sheet0.set_cell(0, 0, script_wrote(CellValue::Text("=1+1".to_string())));
        let mut sheet1 = Grid::new();
        sheet1.set_cell(3, 3, script_wrote(CellValue::Number(7.0)));
        let grids = vec![sheet0, sheet1];

        let (result, active_calls) = apply(&h, &grids, 2, "notebook", "nb-1:cell-1");
        assert!(result.is_ok(), "{:?}", result);
        assert_eq!(active_calls.len(), 1, "the active diff is replayed once");
        let (updates, in_transaction) = &active_calls[0];
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].value, "=1+1");
        assert_eq!(
            updates[0].invariant,
            Some(true),
            "the pipeline must not re-localize a script diff"
        );
        assert!(
            in_transaction,
            "the active replay must join the off-sheet transaction"
        );
        assert_eq!(
            h.state.undo_stack.lock().unwrap().undo_depth(),
            1,
            "one undoable action for the whole cell"
        );
    }

    // --- Undo snapshots of formula ASTs ------------------------------------

    /// Every formula AST is JSON-representable, literals included. This used to
    /// be false (`parser::ast::Value` was internally tagged, which serde cannot
    /// serialize for a newtype variant wrapping a primitive) and forced a
    /// per-cell salvage fallback in `script_grid_cells_snapshot_bytes`.
    #[test]
    fn formula_cells_serialize_for_undo_literals_included() {
        for formula in ["A1+B1", "A1*10", "IF(A1>0,\"y\",\"n\")", "SUM(A1:A10)"] {
            let cell = Cell::new_formula(formula.to_string());
            let bytes = serde_json::to_vec(&cell)
                .unwrap_or_else(|e| panic!("={} must serialize for undo: {}", formula, e));
            let back: Cell = serde_json::from_slice(&bytes).expect("and deserialize");
            assert_eq!(back.formula_string(), cell.formula_string(), "={}", formula);
        }
    }

    /// A script overwriting a literal-bearing formula on a non-active sheet is
    /// applied AND fully undoable: the snapshot carries the original AST back.
    #[test]
    fn overwriting_a_literal_bearing_formula_stays_undoable() {
        let mut sheet1 = Grid::new();
        let mut existing = Cell::new_formula("A1*10".to_string());
        existing.value = CellValue::Number(10.0);
        sheet1.set_cell(0, 1, existing);
        let h = harness(sheet1.clone());

        let mut after = sheet1;
        after.set_cell(0, 1, script_wrote(CellValue::Number(99.0)));
        let grids = modified(&h, after);

        let (result, _) = apply(&h, &grids, 1, "notebook", "nb-1:cell-1");
        assert!(result.is_ok(), "{:?}", result);
        assert_eq!(
            h.state.grids.lock().unwrap()[1]
                .get_cell(0, 1)
                .map(|c| c.value.clone()),
            Some(CellValue::Number(99.0)),
            "the write lands"
        );

        let transaction = h
            .state
            .undo_stack
            .lock()
            .unwrap()
            .pop_undo()
            .expect("a transaction");
        let data = transaction
            .changes
            .iter()
            .find_map(|c| match c {
                engine::undo::CellChange::CustomRestore { kind, data }
                    if kind == "script_grid_cells" =>
                {
                    Some(data.clone())
                }
                _ => None,
            })
            .expect("a snapshot");
        let snapshot: crate::undo_commands::ScriptGridCellsSnapshot =
            serde_json::from_slice(&data).expect("snapshot deserializes");
        let (_, _, before) = snapshot
            .cells
            .iter()
            .find(|(r, c, _)| *r == 0 && *c == 1)
            .expect("B1 captured");
        let before = before.as_ref().expect("B1 had contents");
        assert!(before.has_formula(), "the original formula survives in undo");
        assert_eq!(before.formula_string(), Some("A1*10".to_string()));
    }

    // --- Audit semantics ---------------------------------------------------

    /// Both surfaces record the TRUE diff size, not the engine's raw write
    /// counter, and the entry still carries surface + id + sheet + range.
    /// The notebook used to log the raw counter with no range at all.
    #[test]
    fn audit_records_the_true_diff_size_with_surface_id_sheet_and_range() {
        let h = harness(Grid::new());
        let mut after = Grid::new();
        after.set_cell(2, 1, script_wrote(CellValue::Number(1.0)));
        after.set_cell(4, 3, script_wrote(CellValue::Number(2.0)));
        let grids = modified(&h, after);

        // A deliberately inflated engine counter: the audit must not echo it.
        let (result, _) = apply(&h, &grids, 999, "notebook", "nb-1:cell-1");
        assert!(result.is_ok(), "{:?}", result);

        let audit = h.state.audit_log.lock().unwrap();
        let entry = audit
            .entries
            .iter()
            .find(|e| e.extra.get("surface").and_then(|v| v.as_str()) == Some("notebook"))
            .expect("a notebook audit entry");
        assert_eq!(
            entry.extra.get("surfaceId").and_then(|v| v.as_str()),
            Some("nb-1:cell-1")
        );
        assert_eq!(entry.extra.get("sheet").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(
            entry.extra.get("cellsModified").and_then(|v| v.as_u64()),
            Some(2),
            "the diff size, not the raw engine counter"
        );
        assert_eq!(entry.extra.get("firstRow").and_then(|v| v.as_u64()), Some(2));
        assert_eq!(entry.extra.get("lastRow").and_then(|v| v.as_u64()), Some(4));
        assert_eq!(entry.extra.get("firstCol").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(entry.extra.get("lastCol").and_then(|v| v.as_u64()), Some(3));
    }

    // --- Protection is still decided before anything is written ------------

    /// A protected target sheet refuses the whole cell, and refuses it BEFORE
    /// any grid is touched — nothing to roll back.
    #[test]
    fn a_protected_target_sheet_refuses_before_any_write_lands() {
        let mut sheet1 = Grid::new();
        sheet1.set_cell(0, 0, Cell::new_number(5.0));
        let h = harness(sheet1.clone());
        h.state.sheet_protection.lock().unwrap().insert(
            1,
            crate::protection::SheetProtection {
                protected: true,
                ..Default::default()
            },
        );

        let mut after = sheet1;
        after.set_cell(0, 0, script_wrote(CellValue::Number(42.0)));
        let grids = modified(&h, after);

        let (result, active_calls) = apply(&h, &grids, 1, "notebook", "nb-1:cell-1");
        assert!(result.is_err(), "a protected sheet must refuse the write");
        assert!(active_calls.is_empty(), "nothing reached the edit pipeline");
        assert_eq!(
            value_at(&h, 1, 0, 0),
            CellValue::Number(5.0),
            "the grid is untouched"
        );
        assert_eq!(h.state.undo_stack.lock().unwrap().undo_depth(), 0);
    }
}
