//! FILENAME: app/src-tauri/src/animation_commands.rs
// PURPOSE: Transient frame-write primitive for the Animation/Simulation feature.
// CONTEXT: An animation advances a "driver" value over a frame range while the
//          model recalculates each frame. Frames must be TRANSIENT: they mutate
//          the grid + recalc dependents, but NEVER touch the undo stack and NEVER
//          mark the document dirty, and the model must snap back when playback
//          stops. This mirrors scenario_manager::scenario_show's snapshot/apply/
//          recalc/restore recipe (which also bypasses the undo stack), generalized
//          into a reusable snapshot (anim_snapshot) + apply (anim_apply_frame) +
//          restore (anim_restore) trio keyed by a caller-owned token.
//
//          These commands are "feature-open" (not in PRIVILEGED_BACKEND_COMMANDS),
//          so a trusted built-in extension reaches them through the gated
//          ExtensionContext.invokeBackend door with no capability friction.

use tauri::State;

use crate::api_types::{
    AnimApplyFrameParams, AnimRerollParams, AnimRerollResult, AnimRestoreParams, AnimSnapshotParams,
    AnimSnapshotResult, AnimationFrameResult, CellData, GifExportRequest, GifFrame,
};
use crate::document_effect::{DocumentEffect, TransientScope};
use crate::whatif_recalc::{stored_cell, write_cells_and_recalc_on, RecalcMode, WhatIfStates};
use crate::AppState;
use engine::{Cell, CellValue};

// ============================================================================
// Helpers
// ============================================================================

/// One run's restore buffer, filed by `anim_snapshot` and played back (and
/// dropped) by `anim_restore`.
///
/// It names its sheet by STABLE ID, not by index. The index is only where the
/// sheet was when playback started: drag its tab past another sheet mid-run and
/// the index now names a different sheet -- a canvas included -- and a restore
/// that trusted the caller's index wrote the snapshot's cells into that sheet's
/// grid, where they were saved.
#[derive(Debug, Clone, Default)]
pub struct AnimSnapshot {
    /// The sheet the cells were read from. `None` only for a sheet with no
    /// stable id on file, which then falls back to the caller's index.
    pub sheet_id: Option<identity::SheetId>,
    /// The saved (cell coord, prior Cell) pairs; `None` = the cell was absent.
    /// They are also the ONLY cells a frame of this run may write.
    pub cells: Vec<((u32, u32), Option<Cell>)>,
    /// Under MANUAL calculation, every formula cell's stored value when the
    /// run began (`whatif_recalc::ValueJournal`): the restore puts these back
    /// instead of recalculating, so a value the user left stale for F9 is still
    /// the value they see after Stop. `None` under automatic calculation, where
    /// recalculating gives back the same values.
    pub values: Option<crate::whatif_recalc::ValueJournal>,
}

/// Parse a transient write value as a literal (number / boolean / text), exactly
/// like scenario values. A driver write is always a literal — it intentionally
/// does NOT install a formula or mutate the dependency graph (that would defeat
/// the transient guarantee).
fn parse_transient_value(value: &str) -> CellValue {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return CellValue::Empty;
    }
    if let Ok(n) = trimmed.parse::<f64>() {
        return CellValue::Number(n);
    }
    match trimmed.to_uppercase().as_str() {
        "TRUE" => CellValue::Boolean(true),
        "FALSE" => CellValue::Boolean(false),
        _ => CellValue::Text(trimmed.to_string()),
    }
}

/// Apply a batch of writes to a sheet -- `Some(cell)` sets, `None` clears it back
/// to empty (a cell that was absent when the run's snapshot was taken) -- and
/// recalculate every dependent, ON EVERY SHEET, through the shared cascade
/// (`whatif_recalc`, BUG-0613), returning the changed CellData.
///
/// A frame therefore shows exactly the values a real recalculation of that
/// driver value would, and the restore puts back exactly the values the model
/// had: this used to re-evaluate only the frame sheet's own dependents,
/// positionlessly (`ROW()` / implicit intersection / a cube or custom-function
/// cell's preserve answered for nowhere), through the ACTIVE sheet's dependency
/// map -- so a chart or a formula on another sheet that read the driver never
/// moved during playback, and kept the last frame's value after a stop.
///
/// A frame is recalculated whatever the calculation mode (`RecalcMode::Always`,
/// the seeded cascade: only the cells that read the driver): a frame is only
/// worth showing recalculated. The restore under manual calculation passes
/// `RecalcMode::AsAnEdit` and puts the run's value journal back instead, so
/// the workbook ends exactly as it began, stale values included.
fn apply_writes_and_recalc(
    state: &AppState,
    states: &WhatIfStates<'_>,
    // The gate. Every caller must have decided what this write does to the saved
    // document; animation is the one surface that legitimately answers "transient",
    // and it can only say so by presenting a TransientScope, i.e. by proving the
    // matching anim_restore snapshot is already filed. See `document_effect`.
    effect: &DocumentEffect,
    resolve_sheet: &dyn Fn() -> Option<usize>,
    writes: &[((u32, u32), Option<Cell>)],
    mode: RecalcMode,
) -> Result<Option<Vec<CellData>>, String> {
    // BACKGROUND, and the surface a `#LIMIT!` here MUST be transient in the
    // undo sense: animation advances a driver and recalculates dependents per
    // FRAME under the transient-write pattern, so nothing it produces — error
    // or value — may enter the undo graph. It does not: this path writes
    // through the same snapshot/restore machinery every other frame write uses,
    // and `anim_stop` restores the pre-animation cells verbatim. The ceiling is
    // the persisting one because the frames ARE what the user is looking at.
    let _governor = crate::eval_budget::inherit_or(crate::eval_budget::EvalSurface::Background);
    let mut updated_cells = Vec::new();
    let written = write_cells_and_recalc_on(
        state,
        states,
        effect,
        resolve_sheet,
        writes,
        mode,
        &mut updated_cells,
    )?;
    Ok(written.map(|_| updated_cells))
}

/// The transient gate for the anim_* trio, and the only place any of them can obtain
/// permission to write the grid.
///
/// Succeeds only while the run's `anim_snapshot` restore buffer is on file. That is the
/// operational definition of "transient": a write that is guaranteed to be undone. It is
/// checkable here, which is why animation gets a first-class exemption from the dirty
/// flag and `scenario_show` -- which applies values permanently and has no restore
/// command at all -- cannot obtain one.
pub(crate) fn frame_effect(state: &AppState, token: &str) -> Result<DocumentEffect, String> {
    let snapshots = state
        .animation_snapshots
        .lock()
        .map_err(|_| "animation snapshot registry poisoned".to_string())?;
    let scope = TransientScope::prove_restore_registered(&snapshots, token)?;
    Ok(DocumentEffect::transient(&scope))
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Snapshot the given cells into a named transient buffer so a later
/// `anim_restore` can put the model back exactly. One token per driver run.
#[tauri::command]
pub fn anim_snapshot(state: State<AppState>, params: AnimSnapshotParams) -> AnimSnapshotResult {
    anim_snapshot_inner(&state, params)
}

/// `anim_snapshot` over a plain reference, so the restore's sheet binding can be
/// driven from a unit test (a `tauri::State` cannot be built in one).
pub(crate) fn anim_snapshot_inner(state: &AppState, params: AnimSnapshotParams) -> AnimSnapshotResult {
    // NOT WHILE A WHAT-IF RUN IS WRITING TRIALS. Data Table, Goal Seek and
    // Solver are `(async)` and Scenario Summary puts its changing cells back:
    // a buffer filed between two trials would snapshot a TRIAL value as the
    // cell's original, and Stop would put that trial back for good. The flag is
    // held until the buffer is filed, so no run can start in between either
    // (`whatif_recalc::begin_whatif_run` refuses while a buffer is on file).
    let _whatif = match crate::whatif_recalc::claim_whatif_flag(state) {
        Ok(guard) => guard,
        Err(()) => {
            return AnimSnapshotResult {
                success: false,
                error: Some(crate::whatif_recalc::ANIMATION_WHATIF_BUSY.to_string()),
            };
        }
    };
    let sheet_idx = params.sheet_index;
    // A CANVAS has no cells to drive: refusing the snapshot also refuses every
    // frame of the run (a frame needs its snapshot on file), so no transient
    // value ever sits in a canvas's hidden grid between frames.
    if let Err(e) = crate::sheets::ensure_not_canvas_in_state(state, sheet_idx, "animate cells") {
        return AnimSnapshotResult { success: false, error: Some(e) };
    }
    let grids = state.grids.read().unwrap();
    if sheet_idx >= grids.len() {
        return AnimSnapshotResult {
            success: false,
            error: Some(format!("Sheet index {} out of range", sheet_idx)),
        };
    }
    let saved: Vec<((u32, u32), Option<Cell>)> = params
        .cells
        .iter()
        .map(|&(r, c)| ((r, c), grids[sheet_idx].get_cell(r, c).cloned()))
        .collect();
    // The sheet's stable id, read under the same `grids` guard as the cells
    // (`grids` -> `sheet_ids` is the canonical order), so the pair describes one
    // moment: a move cannot slip between reading the cells and naming the sheet.
    let sheet_id = state.sheet_ids.read().unwrap().get(sheet_idx).copied();
    drop(grids);

    // Under manual calculation the restore must give back stale values too.
    let manual = state.calculation_mode.lock().map(|m| *m != "automatic").unwrap_or(false);
    let values = manual.then(|| crate::whatif_recalc::journal_formula_values(state));

    state
        .animation_snapshots
        .lock()
        .unwrap()
        .insert(params.token, AnimSnapshot { sheet_id, cells: saved, values });

    AnimSnapshotResult {
        success: true,
        error: None,
    }
}

/// Apply one frame's transient writes and recalc dependents. Does NOT touch the
/// undo stack and does NOT mark the document dirty.
#[tauri::command]
pub fn anim_apply_frame(
    state: State<AppState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: AnimApplyFrameParams,
) -> AnimationFrameResult {
    let states = WhatIfStates {
        user_files: &user_files_state,
        pivots: &pivot_state,
        pane_control: &pane_control_state,
        ribbon_filter: &ribbon_filter_state,
    };
    anim_apply_frame_inner(&state, &states, params)
}

/// `anim_apply_frame` over plain references (see `anim_snapshot_inner`).
pub(crate) fn anim_apply_frame_inner(
    state: &AppState,
    states: &WhatIfStates<'_>,
    params: AnimApplyFrameParams,
) -> AnimationFrameResult {
    // Animation frames recalculate under the transient-write pattern (no undo
    // entries, restored on stop). They still WRITE cells the user is watching,
    // so the persisting ceiling; and they carry the workbook cancel token, so
    // the same Cancel that stops a recalculation stops a runaway frame.
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Background,
        &state.calc_cancel,
    );
    // THE FRAME WRITES WHERE ITS SNAPSHOT WAS TAKEN, and only the cells the
    // snapshot holds. It used to write `params.sheet_index` -- where the sheet
    // was when playback STARTED -- and any cell at all: drag a tab past the
    // animated sheet mid-run and later frames wrote into the other sheet, which
    // the restore (keyed by the snapshot's stable id) never put back and which
    // never dirtied the document, so the frame values were saved with the next
    // unrelated save. The snapshot's id is copied out under the registry lock;
    // the sheet is re-resolved under the grid locks by the write itself. With
    // no snapshot on file the frame is refused below (`frame_effect`).
    let snapshot = state.animation_snapshots.lock().unwrap().get(&params.token).map(|snapshot| {
        (
            snapshot.sheet_id,
            snapshot.cells.iter().map(|(pos, _)| *pos).collect::<std::collections::HashSet<(u32, u32)>>(),
        )
    });
    let fallback = params.sheet_index;
    let snapshot_sheet_id = snapshot.as_ref().and_then(|(id, _)| *id);
    if let Some((_, snapshot_cells)) = &snapshot {
        if let Some(w) = params.writes.iter().find(|w| !snapshot_cells.contains(&(w.row, w.col))) {
            return AnimationFrameResult {
                updated_cells: Vec::new(),
                error: Some(format!(
                    "Cell at row {}, column {} is not in this animation's snapshot; a frame may only write the cells its restore puts back",
                    w.row + 1,
                    w.col + 1
                )),
            };
        }
    }
    let Some(sheet_idx) = snapshot_sheet_index(state, snapshot_sheet_id, fallback) else {
        return AnimationFrameResult {
            updated_cells: Vec::new(),
            error: Some("The sheet this animation snapshot was taken on no longer exists".to_string()),
        };
    };

    // A frame aimed at a CANVAS writes nothing (the snapshot refuses one too).
    // Before the effect.
    if let Err(e) = crate::sheets::ensure_not_canvas_in_state(state, sheet_idx, "animate cells") {
        return AnimationFrameResult { updated_cells: Vec::new(), error: Some(e) };
    }

    // A frame may only be applied while the matching anim_snapshot is on file. This is
    // what makes "transient" checkable rather than remembered: no snapshot, no restore,
    // no exemption -- so the write is refused instead of silently escaping the dirty
    // flag. (scenario_show cannot satisfy this, which is correct: it has no restore.)
    let effect = match frame_effect(state, &params.token) {
        Ok(e) => e,
        Err(e) => {
            return AnimationFrameResult {
                updated_cells: Vec::new(),
                error: Some(e),
            }
        }
    };

    let writes: Vec<((u32, u32), Option<Cell>)> = params
        .writes
        .iter()
        .map(|w| {
            let style_index = stored_cell(state, sheet_idx, w.row, w.col).map_or(0, |c| c.style_index);
            let mut cell = match parse_transient_value(&w.value) {
                CellValue::Number(n) => Cell::new_number(n),
                CellValue::Text(t) => Cell::new_text(t),
                CellValue::Boolean(b) => Cell::new_boolean(b),
                _ => Cell::new_text(w.value.clone()),
            };
            cell.style_index = style_index;
            ((w.row, w.col), Some(cell))
        })
        .collect();

    let resolve = || snapshot_sheet_index(state, snapshot_sheet_id, fallback);
    match apply_writes_and_recalc(state, states, &effect, &resolve, &writes, RecalcMode::Always) {
        Ok(Some(updated_cells)) => {
            note_frame_in_journal(state, &params.token, resolve(), &updated_cells);
            AnimationFrameResult { updated_cells, error: None }
        }
        Ok(None) => AnimationFrameResult {
            updated_cells: Vec::new(),
            error: Some("The sheet this animation snapshot was taken on no longer exists".to_string()),
        },
        Err(e) => AnimationFrameResult { updated_cells: Vec::new(), error: Some(e) },
    }
}

/// Restore the model to a named snapshot buffer (and drop it), recalculating
/// dependents. Safe to call with an unknown token (no-op) so stop/cleanup is
/// idempotent.
#[tauri::command]
pub fn anim_restore(
    state: State<AppState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: AnimRestoreParams,
) -> AnimationFrameResult {
    let states = WhatIfStates {
        user_files: &user_files_state,
        pivots: &pivot_state,
        pane_control: &pane_control_state,
        ribbon_filter: &ribbon_filter_state,
    };
    anim_restore_inner(&state, &states, params)
}

/// Under MANUAL calculation, record in the run's value journal what this frame
/// LEFT in the cells it recalculated, so Stop restores only the run's own
/// values and never a cell the user re-typed or recalculated while the run was
/// paused (`whatif_recalc::ValueJournal`). A frame whose sheet is not the
/// active one may not report every cell it recalculated (under automatic
/// calculation it is recalculated as a whole background sheet, which reports
/// none): the journal then falls back to the formula check alone. The values
/// are read first and the registry locked alone afterwards (no nesting).
fn note_frame_in_journal(state: &AppState, token: &str, frame_sheet: Option<usize>, updated_cells: &[CellData]) {
    let journalled = state
        .animation_snapshots
        .lock()
        .map(|snapshots| snapshots.get(token).is_some_and(|s| s.values.is_some()))
        .unwrap_or(false);
    if !journalled {
        return;
    }
    let left = crate::whatif_recalc::frame_left_values(state, updated_cells);
    let active = state.active_sheet.read().map(|a| *a).ok();
    let unreported = frame_sheet.is_none() || frame_sheet != active;
    if let Ok(mut snapshots) = state.animation_snapshots.lock() {
        if let Some(journal) = snapshots.get_mut(token).and_then(|s| s.values.as_mut()) {
            journal.note_frame(left, unreported);
        }
    }
}

/// Where a snapshot's sheet is NOW: the index its stable id resolves to, or the
/// caller's index for a snapshot that carries no id. `None` = the sheet is gone.
fn snapshot_sheet_index(state: &AppState, sheet_id: Option<identity::SheetId>, fallback: usize) -> Option<usize> {
    match sheet_id {
        Some(id) => state.sheet_ids.read().unwrap().iter().position(|s| *s == id),
        None => Some(fallback),
    }
}

/// `anim_restore` over a plain reference (see `anim_snapshot_inner`).
///
/// The target sheet comes from the SNAPSHOT, not from `params.sheet_index`,
/// which is only where the sheet was when the caller last looked. Refused --
/// with the snapshot left on file -- when that sheet is a canvas; refused and
/// dropped when the sheet no longer exists (there is nothing left to restore
/// into, and keeping it would keep a transient-write licence alive for a run
/// that can never be put back).
pub(crate) fn anim_restore_inner(
    state: &AppState,
    states: &WhatIfStates<'_>,
    params: AnimRestoreParams,
) -> AnimationFrameResult {
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Background,
        &state.calc_cancel,
    );
    // Proof BEFORE the take: the restore is the thing being performed, so the snapshot
    // is on file at this instant by definition.
    // A restore with no registered snapshot cannot claim the transient exemption,
    // and it also has nothing to restore -- the `None` arm below returns before any
    // write. So the token is REQUIRED here rather than optional: an absent one is a
    // refusal, not a licence to write undecided.
    let Ok(effect) = frame_effect(state, &params.token) else {
        return AnimationFrameResult {
            updated_cells: Vec::new(),
            error: Some("No animation snapshot is registered for this token".to_string()),
        };
    };

    // WHICH SHEET, decided BEFORE the snapshot leaves the registry. The id is
    // copied out under the registry lock and the lock released; the index is
    // then resolved and the kind checked, each store alone.
    let snapshot_sheet_id = match state.animation_snapshots.lock().unwrap().get(&params.token) {
        Some(snapshot) => snapshot.sheet_id,
        None => {
            return AnimationFrameResult {
                updated_cells: Vec::new(),
                error: None,
            }
        }
    };
    let Some(gate_idx) = snapshot_sheet_index(state, snapshot_sheet_id, params.sheet_index) else {
        state.animation_snapshots.lock().unwrap().remove(&params.token);
        return AnimationFrameResult {
            updated_cells: Vec::new(),
            error: Some(
                "The sheet this animation snapshot was taken on no longer exists; nothing was restored"
                    .to_string(),
            ),
        };
    };
    if let Err(e) = crate::sheets::ensure_not_canvas_in_state(state, gate_idx, "animate cells") {
        return AnimationFrameResult { updated_cells: Vec::new(), error: Some(e) };
    }
    if gate_idx != params.sheet_index {
        crate::log_info!(
            "ANIM",
            "anim_restore: the snapshot's sheet moved from index {} to {} during playback; restoring it there",
            params.sheet_index,
            gate_idx
        );
    }

    let saved = state
        .animation_snapshots
        .lock()
        .unwrap()
        .remove(&params.token);
    let saved = match saved {
        Some(s) => s,
        None => {
            return AnimationFrameResult {
                updated_cells: Vec::new(),
                error: None,
            }
        }
    };

    // `effect` is already a plain DocumentEffect: the token is proven at the top
    // of the command (an unregistered one refuses there), so there is no longer an
    // Option to unwrap here.
    //
    // The sheet is RE-RESOLVED under the grid locks (`grid` -> `grids` ->
    // `sheet_ids`, the canonical order), inside the write: a sheet moved between
    // the gate and here is still found. Its kind cannot have changed -- a sheet's
    // kind is fixed for its life and moves with it -- so the gate above still
    // holds for it.
    let sheet_id = saved.sheet_id;
    let fallback = params.sheet_index;
    let resolve = || snapshot_sheet_index(state, sheet_id, fallback);
    // Under MANUAL calculation (still), the driver cells go back as a typed value
    // would -- nothing recalculated -- and every formula value the frames
    // changed goes back to what it was, stale or not. Otherwise the restore
    // recalculates the driver's dependents, which gives back the same values.
    let manual = state.calculation_mode.lock().map(|m| *m != "automatic").unwrap_or(false);
    let journal = if manual { saved.values.as_ref() } else { None };
    let mode = if journal.is_some() { RecalcMode::AsAnEdit } else { RecalcMode::Always };
    match apply_writes_and_recalc(state, states, &effect, &resolve, &saved.cells, mode) {
        Ok(Some(mut updated_cells)) => {
            if let Some(journal) = journal {
                crate::whatif_recalc::restore_journal_values(state, &effect, journal, &mut updated_cells);
            }
            AnimationFrameResult { updated_cells, error: None }
        }
        Ok(None) => AnimationFrameResult {
            updated_cells: Vec::new(),
            error: Some(
                "The sheet this animation snapshot was taken on no longer exists; nothing was restored"
                    .to_string(),
            ),
        },
        Err(e) => AnimationFrameResult { updated_cells: Vec::new(), error: Some(e) },
    }
}

// ============================================================================
// Monte Carlo: re-roll volatiles + read the outcome cell
// ============================================================================

/// Force a full sheet recalculation (which re-rolls volatile RAND/RANDBETWEEN
/// cells) and return the outcome cell's numeric value. One call == one trial.
/// Feature-open; makes no permanent structural change (RAND cells are volatile).
#[tauri::command]
pub fn anim_reroll_and_read(
    state: State<AppState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: AnimRerollParams,
) -> AnimRerollResult {
    // A Monte Carlo trial recalculates the whole sheet; between a what-if run's
    // trials that pass would read (and settle dependents on) the run's borrowed
    // input. Held for the trial, so no run starts mid-pass either.
    let _whatif = match crate::whatif_recalc::claim_whatif_flag(&state) {
        Ok(guard) => guard,
        Err(()) => {
            return AnimRerollResult {
                value: None,
                error: Some(crate::whatif_recalc::ANIMATION_WHATIF_BUSY.to_string()),
            };
        }
    };
    crate::calculation::recalculate_sheet_values(
        &state,
        &user_files_state,
        &pivot_state,
        params.sheet_index,
        Some((&*pane_control_state, &*ribbon_filter_state)),
    );
    // A whole-sheet pass reports no cells, so a run journalling values under
    // manual calculation can no longer tell which ones it changed: its restore
    // falls back to the formula check alone (`whatif_recalc::ValueJournal`).
    if let Ok(mut snapshots) = state.animation_snapshots.lock() {
        for journal in snapshots.values_mut().filter_map(|s| s.values.as_mut()) {
            journal.note_frame(Vec::new(), true);
        }
    }

    let grids = state.grids.read().unwrap();
    if params.sheet_index >= grids.len() {
        return AnimRerollResult {
            value: None,
            error: Some(format!("Sheet index {} out of range", params.sheet_index)),
        };
    }
    let value = grids[params.sheet_index]
        .get_cell(params.outcome_row, params.outcome_col)
        .and_then(|c| match &c.value {
            CellValue::Number(n) => Some(*n),
            CellValue::Boolean(b) => Some(if *b { 1.0 } else { 0.0 }),
            _ => None,
        });

    AnimRerollResult { value, error: None }
}

// ============================================================================
// GIF export
// ============================================================================

/// Encode a sequence of RGBA frames to an animated GIF (in-memory). Each frame is
/// quantized to its own 256-colour palette. Pure (no I/O) so it is unit-testable.
fn encode_gif(width: u16, height: u16, frames: Vec<GifFrame>, repeat: bool) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 {
        return Err("GIF dimensions must be non-zero".to_string());
    }
    if frames.is_empty() {
        return Err("No frames to encode".to_string());
    }
    let expected = width as usize * height as usize * 4;
    let mut out: Vec<u8> = Vec::new();
    {
        let mut encoder = gif::Encoder::new(&mut out, width, height, &[])
            .map_err(|e| format!("GIF encoder init failed: {}", e))?;
        encoder
            .set_repeat(if repeat { gif::Repeat::Infinite } else { gif::Repeat::Finite(0) })
            .map_err(|e| format!("GIF set_repeat failed: {}", e))?;
        for (i, gf) in frames.into_iter().enumerate() {
            if gf.rgba.len() != expected {
                return Err(format!(
                    "Frame {} has {} bytes, expected {} ({}x{}x4)",
                    i,
                    gf.rgba.len(),
                    expected,
                    width,
                    height
                ));
            }
            let mut rgba = gf.rgba;
            let mut frame = gif::Frame::from_rgba_speed(width, height, &mut rgba, 10);
            frame.delay = gf.delay_cs.max(2); // browsers clamp <2cs to a default; keep sane
            encoder
                .write_frame(&frame)
                .map_err(|e| format!("GIF write_frame {} failed: {}", i, e))?;
        }
    } // encoder dropped here -> writes the GIF trailer into `out`
    Ok(out)
}

/// Encode RGBA frames to an animated GIF and write it to `req.path`.
/// PRIVILEGED (host filesystem write) — reachable only by trusted callers (see
/// PRIVILEGED_BACKEND_COMMANDS.hostFilesystem in backendCommands.ts).
#[tauri::command]
pub fn export_gif(req: GifExportRequest) -> Result<(), String> {
    let bytes = encode_gif(req.width, req.height, req.frames, req.repeat)?;
    std::fs::write(&req.path, bytes).map_err(|e| format!("Failed to write {}: {}", req.path, e))?;
    Ok(())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_gif_produces_a_valid_header() {
        let w = 2u16;
        let h = 2u16;
        let px = (w as usize) * (h as usize) * 4;
        let frames = vec![
            GifFrame { rgba: vec![255u8; px], delay_cs: 5 },
            GifFrame { rgba: vec![0u8; px], delay_cs: 5 },
        ];
        let bytes = encode_gif(w, h, frames, true).expect("encode ok");
        assert!(bytes.len() > 6);
        assert_eq!(&bytes[0..6], b"GIF89a");
    }

    #[test]
    fn encode_gif_rejects_wrong_frame_size() {
        assert!(encode_gif(2, 2, vec![GifFrame { rgba: vec![0u8; 3], delay_cs: 5 }], false).is_err());
        assert!(encode_gif(0, 2, vec![GifFrame { rgba: vec![], delay_cs: 5 }], false).is_err());
        assert!(encode_gif(2, 2, vec![], false).is_err());
    }

    // The frame / restore round trip (a literal, a same-sheet dependent and a
    // dependent on ANOTHER sheet, a cell absent before the run) is driven
    // through the real anim_* bodies in whatif_recalc_tests.rs (BUG-0613).
}
