//! FILENAME: app/src-tauri/src/scripting/notebook_commands.rs
//! PURPOSE: Tauri commands for notebook CRUD and cell execution with snapshots.
//! CONTEXT: These commands manage notebook documents (create/save/load/delete),
//! execute cells in a persistent QuickJS runtime with shared variables,
//! and support snapshot-based rewind.

use tauri::{Manager, State};

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
    file_state: State<'_, crate::persistence::FileState>,
    script_state: State<ScriptState>,
    id: String,
    name: String,
) -> Result<NotebookDocument, String> {
    let mut notebook = NotebookDocument {
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

    // Scripts/notebooks are persisted in the .cala; this is a document change.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut notebooks = script_state.workbook_notebooks.write(&effect)
        .map_err(|e| e.to_string())?;
    // Creating OVER an existing id keeps that id's provenance (see
    // `notebook_save`): "create" is an insert the renderer chooses the id for,
    // so without this a caller could mint a local notebook on top of a
    // publisher's one and launder the stamp the run gate reads.
    notebook.source_package = super::commands::sticky_source_package(
        notebook.source_package.take(),
        notebooks.get(&id).and_then(|nb| nb.source_package.as_deref()),
    );
    notebooks.insert(id, notebook.clone());

    Ok(notebook)
}

/// Save (create or update) a notebook document.
///
/// PROVENANCE IS STICKY HERE TOO, for the reason it is sticky in `save_script`:
/// `source_package` is the only authority on whose code a notebook is, the
/// field is optional on the wire, and this command is called on EVERY run —
/// `useNotebookStore.runCell` / `runAll` / `runFromCell` all save the in-memory
/// document immediately before executing it. A writer that omitted the stamp
/// (or a hostile renderer that dropped it) would therefore turn a publisher's
/// notebook into local code one keystroke before the gate below reads it.
/// Omission means "leave it alone", never "make this mine".
#[tauri::command]
pub fn notebook_save(
    file_state: State<'_, crate::persistence::FileState>,
    script_state: State<ScriptState>,
    notebook: NotebookDocument,
) -> Result<(), String> {
    // Scripts/notebooks are persisted in the .cala; this is a document change.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut notebooks = script_state.workbook_notebooks.write(&effect)
        .map_err(|e| e.to_string())?;
    let mut notebook = notebook;
    notebook.source_package = super::commands::sticky_source_package(
        notebook.source_package.take(),
        notebooks
            .get(&notebook.id)
            .and_then(|nb| nb.source_package.as_deref()),
    );
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
        .read()
        .map_err(|e| e.to_string())?;
    notebooks
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("Notebook '{}' not found", id))
}

/// The listing row for one notebook — the ONE place a `NotebookDocument`
/// becomes a `NotebookSummary`. Provenance is COPIED from the record, never
/// derived: the notebook picker is a list of these rows, so a row that drops
/// `source_package` shows a publisher's notebook as one of the user's own.
fn notebook_summary(notebook: &NotebookDocument) -> NotebookSummary {
    NotebookSummary {
        id: notebook.id.clone(),
        name: notebook.name.clone(),
        cell_count: notebook.cells.len(),
        source_package: notebook.source_package.clone(),
    }
}

/// List all notebooks (lightweight summaries, WITH provenance).
#[tauri::command]
pub fn notebook_list(
    script_state: State<ScriptState>,
) -> Result<Vec<NotebookSummary>, String> {
    let notebooks = script_state
        .workbook_notebooks
        .read()
        .map_err(|e| e.to_string())?;

    let mut summaries: Vec<NotebookSummary> = notebooks
        .values()
        .map(notebook_summary)
        .collect();

    summaries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(summaries)
}

/// Delete a notebook by ID. Also clears any active runtime for it.
#[tauri::command]
pub async fn notebook_delete(
    file_state: State<'_, crate::persistence::FileState>,
    script_state: State<'_, ScriptState>,
    id: String,
) -> Result<(), String> {
    // Don't delete out from under a running execution.
    let _exec = script_state.notebook_exec_lock.lock().await;

    {
        // Notebooks are persisted (`workbook.notebooks`).
        let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
        let mut notebooks = script_state
            .workbook_notebooks
            .write(&effect)
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

/// The consent-store script id for one cell of a distributed notebook.
///
/// The consent store is keyed `(packageName, scriptId, sourceHash)` and is
/// SHARED by every distributed-code surface (object scripts, chart libraries,
/// writeback validators, module scripts). A notebook joins it rather than
/// growing a second store: the package key is the application name the pull
/// stamped, and the unit of consent is one CELL, because one cell's source is
/// exactly what `run_cell_internal` hands to QuickJS. The `notebook:{id}`
/// prefix matches the surface id the capability store already uses for
/// notebooks (`grantNotebookBiCapability`), so one notebook reads as one
/// subject everywhere.
pub(crate) fn notebook_consent_script_id(notebook_id: &str, cell_id: &str) -> String {
    format!("notebook:{}:{}", notebook_id, cell_id)
}

/// Refuse to run a CELL OF A NOTEBOOK THAT ARRIVED IN A .calp APPLICATION.
///
/// THE HOLE. `core/calp/src/pull.rs` materializes a published application's
/// notebooks into the subscriber's workbook, stamps each with
/// `source_package`, and STRIPS their execution metadata on the delivered bytes
/// — explicitly because a notebook from a stranger is inert data the user has
/// not agreed to run. Module scripts from the very same application are gated
/// by `require_distributed_module_consent`; notebooks had NOTHING. Opening the
/// notebook panel, picking the publisher's notebook out of the list (which,
/// before this change, did not say it was theirs) and pressing Run All
/// executed a stranger's JavaScript against the workbook with no package
/// consent anywhere in the path.
///
/// FAILS CLOSED, and is RUST-AUTHORITATIVE: the renderer is assumed hostile, so
/// the check cannot live in the notebook store that builds the call — and
/// `notebook_save`, which the store calls immediately before every run, now
/// refuses to let an omitted stamp erase the record this reads.
///
/// The evidence is the SAME consent store the object-script, chart-library,
/// validator and module gates read: a record under the application name naming
/// this cell and this EXACT source hash. So an upstream refresh that changes a
/// cell re-asks (the hash moves), one application's consent never covers
/// another's, and editing a publisher's cell does not inherit approval for what
/// it used to say.
///
/// The sanctioned way to RUN a publisher's analysis is to copy its cells into a
/// notebook of your own — a local notebook carries no stamp, so it is not
/// gated, and the refusal message says so.
/// Whether a stored record's `source_package` names an application at all.
///
/// The ONE blank-stamp rule for notebooks: `None` and whitespace-only are the
/// user's own record. Both the stateful gate (which uses it to skip reading the
/// consent file) and the pure decision (which uses it to pick the LOCAL kind)
/// go through here, so they cannot drift apart.
fn is_stamped_package(source_package: Option<&str>) -> bool {
    source_package.map(str::trim).is_some_and(|p| !p.is_empty())
}

fn distributed_notebook_refusal(
    source_package: Option<&str>,
    notebook_id: &str,
    notebook_name: &str,
    cell_id: &str,
    source: &str,
    consent_file: Option<&serde_json::Value>,
) -> Option<String> {
    // An absent — or blank — stamp is not an application: it is a record with
    // nothing stamped on it, i.e. the user's own notebook. Same rule as
    // `scriptOriginForStoredRecord` (app/src/api/scriptHost/scriptOrigin.ts):
    // a publisher-chosen name can never select the LOCAL kind, and whitespace
    // can never select the PACKAGE kind. ONE rule, in `is_stamped_package`, so
    // the stateful half's early return and this decision cannot disagree.
    let package = source_package.map(str::trim).filter(|_| is_stamped_package(source_package))?;

    let source_hash = calp::integrity::sha256_hex(source.as_bytes());
    let consent_id = notebook_consent_script_id(notebook_id, cell_id);
    if let Some(file) = consent_file {
        if crate::calp_commands::consent_granted_in(file, package, &consent_id, &source_hash) {
            return None;
        }
    }
    // THE WORDS STATE THE REAL RULE, WHICH IS NOT "NOT YET APPROVED".
    //
    // This message used to read "you have not approved that application's code",
    // which describes a pending decision — and every other surface's refusal
    // means exactly that, because a consent screen exists that can settle it. No
    // such screen exists for a notebook, and that is deliberate: the consent
    // record is written by the object-script prompt over object scripts and
    // module scripts only (extensions/ScriptableObjects/lib/packageConsentSet.ts),
    // nothing anywhere writes a `notebook:{id}:{cell}` id into it, and a
    // distributed notebook is meant to arrive as readable analysis rather than as
    // something to switch on. So the sentence promised an approval the product
    // has no way to give, and sent the user hunting for a button that is not
    // there.
    //
    // The consent BRANCH above is kept, and is not dead: a `.calp` that a future
    // surface consents cell-by-cell would be admitted by it unchanged. What
    // changes here is only the claim made to the user when the answer is no.
    Some(format!(
        "{}: The notebook '{}' arrived in the application '{}'. Notebooks from an \
         application are delivered to be read, not run — Calcula has no way to approve \
         one, so its cells stay inert here. You can read every cell, and copy the \
         ones you want into a notebook of your own to run them.",
        super::commands::DISTRIBUTED_SCRIPT_NOT_CONSENTED,
        notebook_name,
        package
    ))
}

/// The stateful half of {@link distributed_notebook_refusal}: read the stored
/// notebook's provenance and the workbook's consent file, then decide.
///
/// Provenance comes from the STORED record, never from the request — the run
/// request carries only ids and a source string, and a caller that could assert
/// its own provenance would be asserting the thing being checked.
///
/// A notebook id that is not in the store is not a stored notebook (a cell run
/// against a document that was just deleted); there is nothing whose provenance
/// could be read, and the run has no package to be refused for.
fn require_distributed_notebook_consent(
    app: &tauri::AppHandle,
    script_state: &ScriptState,
    notebook_id: &str,
    cell_id: &str,
    source: &str,
) -> Result<(), String> {
    let record: Option<(Option<String>, String)> = {
        let notebooks = script_state
            .workbook_notebooks
            .read()
            .map_err(|e| e.to_string())?;
        notebooks
            .get(notebook_id)
            .map(|nb| (nb.source_package.clone(), nb.name.clone()))
    }; // guard dropped: nothing below may hold it, and no await follows it
    let Some((source_package, name)) = record else {
        return Ok(());
    };
    // THE USER'S OWN NOTEBOOK NEVER PAYS FOR THE CONSENT FILE. This gate runs
    // once per CELL on every path (run / run-all / rewind / run-from all funnel
    // through `run_cell_internal`), and it used to read and parse the whole
    // consent file BEFORE `distributed_notebook_refusal` looked at the stamp —
    // so a Run All over N local cells was N parses of a file that could not
    // change the answer. The blank-stamp rule below is the same one the pure
    // half applies (and its tests pin); this is only the order.
    if !is_stamped_package(source_package.as_deref()) {
        return Ok(());
    }
    let consent_file = crate::calp_commands::read_script_consent_file(app);
    match distributed_notebook_refusal(
        source_package.as_deref(),
        notebook_id,
        &name,
        cell_id,
        source,
        consent_file.as_ref(),
    ) {
        Some(message) => Err(message),
        None => Ok(()),
    }
}

/// True when a cell holds PROSE, not JavaScript.
///
/// A notebook text cell is marked by a `//!markdown` first line rather than by
/// a new persisted field, so the `.cala` / `.calp` notebook record keeps one
/// shape (see ScriptNotebook/lib/cellKind.ts for the full rationale). This is
/// the AUTHORITATIVE half of that rule: run / run-all / rewind / run-from all
/// funnel through `run_cell_internal`, so a text cell can never reach QuickJS
/// even if a frontend forgot to filter it — markdown is not valid JavaScript,
/// and executing it would surface as a confusing syntax error rather than as
/// the no-op it must be.
///
/// Must agree with `MARKER_RE` in cellKind.ts: optional indent, `//!`, optional
/// space, `markdown`, optional trailing space — case-insensitive.
pub(crate) fn is_markdown_source(source: &str) -> bool {
    let first_line = source.split('\n').next().unwrap_or("");
    let trimmed = first_line.trim_end_matches('\r').trim();
    let Some(rest) = trimmed.strip_prefix("//!") else {
        return false;
    };
    rest.trim().eq_ignore_ascii_case("markdown")
}

/// The response a skipped (text) cell answers with: a success that ran nothing.
fn markdown_skip_response() -> NotebookCellResponse {
    NotebookCellResponse::Success {
        output: Vec::new(),
        cells_modified: 0,
        duration_ms: 0,
        execution_index: 0,
        screen_updating: true,
        deferred_actions: Vec::new(),
    }
}

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
    view_state: Option<&crate::scripting::types::HostViewState>,
) -> Result<NotebookCellResponse, String> {
    // Text cells are prose: they never reach the interpreter, never take a
    // checkpoint, and never consume an execution index. Checked BEFORE the
    // script-security gate so a "prompt"/"disabled" setting does not make a
    // literate notebook unreadable — nothing is being executed to gate.
    if is_markdown_source(source) {
        return Ok(markdown_skip_response());
    }

    // Notebook cells are script execution — same security gate as run_script.
    super::commands::check_script_security(script_state)?;

    // ...and the same PROVENANCE gate as a module script: a notebook that
    // arrived inside somebody's .calp does not run on the strength of the
    // user's trust in their OWN code. Checked on every path, because run /
    // run-all / rewind / run-from all funnel through here.
    require_distributed_notebook_consent(app, script_state, notebook_id, cell_id, source)?;

    // Phase 1 (sync): clone AppState data + checkpoint bookkeeping
    let grids = app_state.grids.read().map_err(|e| e.to_string())?.clone();
    let style_registry = app_state.style_registry.read().map_err(|e| e.to_string())?.clone();
    let sheet_names = app_state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let active_sheet = *app_state.active_sheet.read().map_err(|e| e.to_string())?;

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
            view_state.cloned(),
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

    // 7. Apply everything the cell produced back into AppState through the
    //    SHARED script apply path (the same one run_script and the MCP script
    //    tool use). This replaced a wholesale `*app_grids = modified_grids`
    //    swap, which had no undo entry (Ctrl+Z could not revert a notebook cell)
    //    and no recalculation (formulas depending on written cells went stale).
    //
    //    The shared path performs the whole-workbook protection pre-pass, opens
    //    ONE undo transaction, replays the active-sheet diff through
    //    update_cells_batch (parse + dependency maps + recalc), installs the
    //    other written sheets with their formula strings parsed and evaluates
    //    them, marks the workbook dirty, persists the script's workbook-property
    //    writes, and records the per-sheet audit entries — so a notebook cell is
    //    now audited with the same surface/id/sheet/range shape AND the same
    //    effective-change counts as every other script surface.
    if let script_engine::ScriptResult::Success {
        cells_modified,
        workbook_properties_changed,
        ..
    } = &result
    {
        crate::scripting::commands::apply_script_result_via_handle(
            app,
            &modified_grids,
            active_sheet,
            *cells_modified,
            workbook_properties_changed,
            "notebook",
            &format!("{}:{}", notebook_id, cell_id),
        )?;
    }

    // 8. Update the notebook document's cell with execution results
    {
        // The notebook document (source + last outputs) is persisted, so recording a
        // run is a document change in its own right.
        let file_state = app.state::<crate::persistence::FileState>();
        let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
        let mut notebooks = script_state
            .workbook_notebooks
            .write(&effect)
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
            deferred_actions,
            ..
        } => Ok(NotebookCellResponse::Success {
            output,
            cells_modified,
            duration_ms,
            execution_index,
            screen_updating,
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
/// 4. Applies the cell's writes back to AppState through the shared script apply
///    path (undoable, parsed, recalculated, audited — see `run_cell_internal`)
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
    run_cell_internal(
        &app,
        &state,
        &script_state,
        &request.notebook_id,
        &request.cell_id,
        &request.source,
        request.view_state.as_ref(),
    )
    .await
}

/// Run all notebook cells sequentially from the top.
/// Resets the runtime and baseline, then executes each cell in order.
#[tauri::command]
pub async fn notebook_run_all(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    script_state: State<'_, ScriptState>,
    notebook_id: String,
    view_state: Option<crate::scripting::types::HostViewState>,
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
            .read()
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
        let response = run_cell_internal(
            &app,
            &state,
            &script_state,
            &notebook_id,
            &cell_id,
            &source,
            view_state.as_ref(),
        )
        .await?;

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
            .read()
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
    //
    // DELIBERATELY NOT protection-gated. This restores state the workbook
    // already held, so it is the undo of the notebook's own writes — gating it
    // would strand the user with the notebook's output if the sheet were
    // protected in between. Same reasoning as `solver_revert`; see the
    // exempt-paths block in protection.rs.
    let active_sheet = *app_state.active_sheet.read().map_err(|e| e.to_string())?;
    {
        let active_grid_clone = snapshot_grids.get(active_sheet).cloned();

        // Rewinding installs a checkpoint's cells over the live ones -- a real
        // change to what a save would write, even though it is a "revert" in
        // intent. Same call as step 4 below; `mutates` is idempotent and the
        // flag announces only the clean->dirty TRANSITION, so this costs one
        // event, not two.
        let file_state = app.state::<crate::persistence::FileState>();
        let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
        let mut app_grids = app_state.grids.write(&effect).map_err(|e| e.to_string())?;
        *app_grids = snapshot_grids;
        drop(app_grids);

        if let Some(grid) = active_grid_clone {
            let mut app_grid = app_state.grid.write(&effect).map_err(|e| e.to_string())?;
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
        let file_state = app.state::<crate::persistence::FileState>();
        let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
        let mut notebooks = script_state
            .workbook_notebooks
            .write(&effect)
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
            request.view_state.as_ref(),
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
            .read()
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
            request.view_state.as_ref(),
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

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod notebook_provenance_tests {
    use super::{
        distributed_notebook_refusal, is_stamped_package, notebook_consent_script_id,
        notebook_summary,
    };
    use crate::scripting::commands::{sticky_source_package, DISTRIBUTED_SCRIPT_NOT_CONSENTED};
    use crate::scripting::types::{NotebookCell, NotebookDocument};

    fn notebook(id: &str, package: Option<&str>, cells: &[(&str, &str)]) -> NotebookDocument {
        NotebookDocument {
            id: id.to_string(),
            name: format!("{} (display name)", id),
            cells: cells
                .iter()
                .map(|(cell_id, source)| NotebookCell {
                    id: cell_id.to_string(),
                    source: source.to_string(),
                    last_output: Vec::new(),
                    last_error: None,
                    cells_modified: 0,
                    duration_ms: 0,
                    execution_index: None,
                })
                .collect(),
            source_package: package.map(str::to_string),
        }
    }

    fn consent_file_for(package: &str, consent_id: &str, source: &str) -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "consents": [{
                "packageName": package,
                "scripts": [{
                    "id": consent_id,
                    "sourceHash": calp::integrity::sha256_hex(source.as_bytes()),
                    "source": source,
                }],
                "grantedCapabilities": [],
                "grantedAt": "2026-01-01T00:00:00Z",
            }],
        })
    }

    // -----------------------------------------------------------------------
    // notebook_list: a listing row must say whose notebook it is
    // -----------------------------------------------------------------------

    #[test]
    fn a_notebook_listing_row_carries_the_package_stamp() {
        let row = notebook_summary(&notebook("nb-1", Some("Quarterly Reports"), &[("c1", "1")]));
        assert_eq!(
            row.source_package.as_deref(),
            Some("Quarterly Reports"),
            "the notebook picker is a list of these rows; dropping the stamp \
             shows a publisher's notebook as one of the user's own"
        );
        assert_eq!(row.cell_count, 1);
    }

    #[test]
    fn a_local_notebook_listing_row_claims_no_package() {
        let row = notebook_summary(&notebook("nb-2", None, &[("c1", "1"), ("c2", "2")]));
        assert_eq!(row.source_package, None);
        assert_eq!(row.cell_count, 2);
    }

    // -----------------------------------------------------------------------
    // notebook_save: an omitted stamp must not launder a publisher's notebook
    // -----------------------------------------------------------------------

    /// `useNotebookStore` saves the in-memory document immediately before every
    /// run, so a save that dropped the stamp would disarm the run gate one
    /// keystroke before it fires. `notebook_save`/`notebook_create` apply the
    /// same stickiness `save_script` does.
    #[test]
    fn a_notebook_save_that_omits_the_stamp_does_not_erase_it() {
        assert_eq!(
            sticky_source_package(None, Some("Quarterly Reports")),
            Some("Quarterly Reports".to_string())
        );
    }

    // -----------------------------------------------------------------------
    // The run gate: a distributed notebook must not run unconsented
    // -----------------------------------------------------------------------

    #[test]
    fn a_distributed_notebook_cell_is_refused_with_no_consent_record() {
        let src = "Calcula.setCellValue(0, 0, 'pwned');";
        let refusal = distributed_notebook_refusal(
            Some("evil-app"),
            "nb-1",
            "Sales Analysis",
            "c1",
            src,
            None,
        )
        .expect("a notebook from an unapproved application must not run");
        assert!(refusal.starts_with(DISTRIBUTED_SCRIPT_NOT_CONSENTED), "{}", refusal);
        assert!(refusal.contains("evil-app"), "{}", refusal);
        assert!(refusal.contains("Sales Analysis"), "{}", refusal);
        // The refusal names the sanctioned alternative, so the user is not left
        // hunting for a way to switch the check off.
        assert!(refusal.contains("notebook of your own"), "{}", refusal);
    }

    #[test]
    fn a_consent_record_for_that_exact_cell_source_admits_it() {
        let src = "Calcula.setCellValue(0, 0, 1);";
        let file = consent_file_for("good-app", &notebook_consent_script_id("nb-1", "c1"), src);
        assert!(distributed_notebook_refusal(
            Some("good-app"),
            "nb-1",
            "Sales Analysis",
            "c1",
            src,
            Some(&file),
        )
        .is_none());
    }

    #[test]
    fn consent_does_not_survive_the_cell_changing() {
        // An upstream refresh — or an edit in the notebook panel — moves the
        // hash, so yesterday's approval cannot cover today's code.
        let approved = "Calcula.setCellValue(0, 0, 1);";
        let changed = "Calcula.setCellValue(0, 0, 999);";
        let file =
            consent_file_for("good-app", &notebook_consent_script_id("nb-1", "c1"), approved);
        assert!(distributed_notebook_refusal(
            Some("good-app"),
            "nb-1",
            "Sales Analysis",
            "c1",
            changed,
            Some(&file),
        )
        .is_some());
    }

    #[test]
    fn consent_for_one_cell_does_not_cover_another() {
        let src = "Calcula.setCellValue(0, 0, 1);";
        let file = consent_file_for("good-app", &notebook_consent_script_id("nb-1", "c1"), src);
        assert!(distributed_notebook_refusal(
            Some("good-app"),
            "nb-1",
            "Sales Analysis",
            "c2",
            src,
            Some(&file),
        )
        .is_some());
    }

    #[test]
    fn one_applications_consent_never_covers_anothers_notebook() {
        let src = "Calcula.setCellValue(0, 0, 1);";
        let file = consent_file_for("good-app", &notebook_consent_script_id("nb-1", "c1"), src);
        assert!(distributed_notebook_refusal(
            Some("evil-app"),
            "nb-1",
            "Sales Analysis",
            "c1",
            src,
            Some(&file),
        )
        .is_some());
    }

    #[test]
    fn a_local_notebook_is_not_gated() {
        let src = "Calcula.setCellValue(0, 0, 1);";
        // No stamp at all...
        assert!(
            distributed_notebook_refusal(None, "nb-9", "My Notebook", "c1", src, None).is_none()
        );
        // ...and a blank stamp is nothing stamped, not an application named "".
        assert!(
            distributed_notebook_refusal(Some("   "), "nb-9", "My Notebook", "c1", src, None)
                .is_none()
        );
    }

    /// The stateful gate skips the consent-file read on exactly the records the
    /// pure decision treats as LOCAL. One predicate feeds both, and this pins
    /// that predicate — the "file is never read for a local notebook" ordering
    /// itself is pinned from TypeScript (distributedNotebookRefusalHonesty), which
    /// reads this file as text, because there is no tauri mock app to drive the
    /// stateful half here.
    #[test]
    fn a_stamp_names_an_application_only_when_it_has_content() {
        assert!(!is_stamped_package(None));
        assert!(!is_stamped_package(Some("")));
        assert!(!is_stamped_package(Some("   ")));
        assert!(!is_stamped_package(Some("\t\n")));
        assert!(is_stamped_package(Some("Acme Finance Pack")));
        assert!(is_stamped_package(Some("  padded  ")));
    }
}

#[cfg(test)]
mod markdown_cell_tests {
    use super::{is_markdown_source, markdown_skip_response};
    use crate::scripting::types::NotebookCellResponse;

    #[test]
    fn marker_is_recognized_in_its_canonical_form() {
        assert!(is_markdown_source("//!markdown\n# Heading"));
    }

    #[test]
    fn marker_tolerates_indent_space_case_and_crlf() {
        for src in [
            "  //!markdown\ntext",
            "//! markdown\ntext",
            "//!MARKDOWN\ntext",
            "//!markdown   \ntext",
            "//!markdown\r\ntext",
            "//!markdown",
        ] {
            assert!(is_markdown_source(src), "should be markdown: {:?}", src);
        }
    }

    /// The marker only counts on the FIRST line — a code cell that mentions it
    /// later is still code, or a snippet could be silenced by a comment.
    #[test]
    fn marker_on_a_later_line_does_not_count() {
        assert!(!is_markdown_source("const x = 1;\n//!markdown\n"));
    }

    #[test]
    fn ordinary_code_and_comments_are_not_markdown() {
        for src in [
            "",
            "1 + 1",
            "// markdown\nconst x = 1;",
            "//!markdownish\ntext",
            "//!md\ntext",
            "/*!markdown*/",
            "model.query('c', {measures: ['x']})",
        ] {
            assert!(!is_markdown_source(src), "should be code: {:?}", src);
        }
    }

    /// A skipped text cell answers as an inert success: no output, no grid
    /// writes, and screen updating untouched.
    #[test]
    fn skip_response_is_inert() {
        match markdown_skip_response() {
            NotebookCellResponse::Success {
                output,
                cells_modified,
                deferred_actions,
                screen_updating,
                ..
            } => {
                assert!(output.is_empty());
                assert_eq!(cells_modified, 0);
                assert!(deferred_actions.is_empty());
                assert!(screen_updating);
            }
            other => panic!("expected an inert success, got {:?}", other),
        }
    }
}
