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

use std::collections::HashSet;
use tauri::State;

use crate::api_types::{
    AnimApplyFrameParams, AnimRerollParams, AnimRerollResult, AnimRestoreParams, AnimSnapshotParams,
    AnimSnapshotResult, AnimationFrameResult, CellData, GifExportRequest, GifFrame, MergedRegion,
};
use crate::document_effect::{DocumentEffect, TransientScope};
use crate::{
    evaluate_formula_multi_sheet, get_column_row_dependents,
    get_recalculation_order, AppState,
};
use engine::{Cell, CellValue, Grid, StyleRegistry};

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
    pub cells: Vec<((u32, u32), Option<Cell>)>,
}

/// Build a CellData snapshot from the grid (copy of scenario_manager's helper —
/// kept local so the two modules stay independent).
fn build_cell_data(
    grid: &Grid,
    styles: &StyleRegistry,
    merged_regions: &HashSet<MergedRegion>,
    r: u32,
    c: u32,
    locale: &engine::LocaleSettings,
) -> Option<CellData> {
    let cell = grid.get_cell(r, c)?;
    // Row/column style tiers: resolve against the same grid the cell came from.
    let effective_style_index = grid.effective_style_index(r, c);
    let style = styles.get(effective_style_index);
    let (display, overflow) = crate::format_cell_value_and_class(&cell.value, style, locale);

    let merge = merged_regions
        .iter()
        .find(|m| m.start_row == r && m.start_col == c);
    let (row_span, col_span) = match merge {
        Some(m) => (m.end_row - m.start_row + 1, m.end_col - m.start_col + 1),
        None => (1, 1),
    };

    Some(CellData {
        row: r,
        col: c,
        display,
        overflow,
        display_color: None,
        formula: cell.formula_string().map(|f| format!("={}", f)),
        style_index: effective_style_index,
        row_span,
        col_span,
        sheet_index: None,
        rich_text: None,
        accounting_layout: None,
    })
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

/// One grid mutation to perform for a frame: set a literal/prior cell, or clear
/// it back to empty (used when restoring a cell that was originally absent).
enum SetOp {
    Set(Cell),
    Clear,
}

/// Apply a batch of set/clear ops to a sheet, recalculate the affected formula
/// dependents (scoped — NOT a full workbook recalc), and return the changed
/// CellData. Pure over grid references so it is unit-testable without Tauri State.
/// Mirrors scenario_manager::scenario_show's recalc loop.
#[allow(clippy::too_many_arguments)]
fn apply_set_ops_and_recalc(
    // The gate. Every caller must have decided what this write does to the saved
    // document; animation is the one surface that legitimately answers "transient",
    // and it can only say so by presenting a TransientScope, i.e. by proving the
    // matching anim_restore snapshot is already filed. See `document_effect`.
    _effect: &DocumentEffect,
    grids: &mut Vec<Grid>,
    active_grid: &mut Grid,
    active_sheet: usize,
    sheet_idx: usize,
    sheet_names: &[String],
    styles: &StyleRegistry,
    dependents_map: &crate::DependencyMap,
    column_dependents_map: &crate::StripeDependentsMap,
    row_dependents_map: &crate::StripeDependentsMap,
    merged_regions: &HashSet<MergedRegion>,
    locale: &engine::LocaleSettings,
    ops: &[((u32, u32), SetOp)],
) -> Vec<CellData> {
    // BACKGROUND, and the surface a `#LIMIT!` here MUST be transient in the
    // undo sense: animation advances a driver and recalculates dependents per
    // FRAME under the transient-write pattern, so nothing it produces — error
    // or value — may enter the undo graph. It does not: this path writes
    // through the same snapshot/restore machinery every other frame write uses,
    // and `anim_stop` restores the pre-animation cells verbatim. The ceiling is
    // the persisting one because the frames ARE what the user is looking at.
    let _governor = crate::eval_budget::inherit_or(crate::eval_budget::EvalSurface::Background);
    let mut changed: Vec<(u32, u32)> = Vec::new();
    for ((r, c), op) in ops {
        match op {
            SetOp::Set(cell) => {
                grids[sheet_idx].set_cell(*r, *c, cell.clone());
                if sheet_idx == active_sheet {
                    active_grid.set_cell(*r, *c, cell.clone());
                }
            }
            SetOp::Clear => {
                grids[sheet_idx].clear_cell(*r, *c);
                if sheet_idx == active_sheet {
                    active_grid.clear_cell(*r, *c);
                }
            }
        }
        if !changed.contains(&(*r, *c)) {
            changed.push((*r, *c));
        }
    }

    // Affected = changed cells + their (cell/column/row) dependents.
    let mut all_affected: Vec<(u32, u32)> = Vec::new();
    for &cc in &changed {
        if !all_affected.contains(&cc) {
            all_affected.push(cc);
        }
        let recalc = get_recalculation_order(cc, dependents_map);
        let extra = get_column_row_dependents(cc, column_dependents_map, row_dependents_map);
        for dep in recalc.iter().chain(extra.iter()) {
            if !all_affected.contains(dep) {
                all_affected.push(*dep);
            }
        }
    }

    // Re-evaluate the formula cells among the affected set.
    for &(r, c) in &all_affected {
        if let Some(cell) = grids[sheet_idx].get_cell(r, c).cloned() {
            if let Some(formula) = cell.formula_string() {
                let new_value =
                    evaluate_formula_multi_sheet(&grids[..], sheet_names, sheet_idx, &formula);
                let mut updated = cell;
                updated.value = new_value;
                grids[sheet_idx].set_cell(r, c, updated.clone());
                if sheet_idx == active_sheet {
                    active_grid.set_cell(r, c, updated);
                }
            }
        }
    }

    // Build CellData for every affected cell; emit an explicit blank for any
    // changed cell that is now empty (a cleared-on-restore driver cell) so the
    // frontend repaints it as blank instead of keeping the last frame value.
    let mut updated_cells = Vec::new();
    let mut present: HashSet<(u32, u32)> = HashSet::new();
    for &(r, c) in &all_affected {
        if let Some(cd) = build_cell_data(&grids[sheet_idx], styles, merged_regions, r, c, locale) {
            present.insert((r, c));
            updated_cells.push(cd);
        }
    }
    for &(r, c) in &changed {
        if !present.contains(&(r, c)) && grids[sheet_idx].get_cell(r, c).is_none() {
            updated_cells.push(CellData {
                row: r,
                col: c,
                display: String::new(),
                // Empty: nothing to overflow, and text never marks.
                overflow: crate::api_types::OverflowClass::Text,
                display_color: None,
                formula: None,
                // Now-empty cell: a row/column style still applies to it.
                style_index: grids[sheet_idx].effective_style_index(r, c),
                row_span: 1,
                col_span: 1,
                sheet_index: None,
                rich_text: None,
                accounting_layout: None,
            });
        }
    }
    updated_cells
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

    state
        .animation_snapshots
        .lock()
        .unwrap()
        .insert(params.token, AnimSnapshot { sheet_id, cells: saved });

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
    let sheet_idx = params.sheet_index;

    // The frame names its sheet independently of the snapshot, so it is gated
    // on its own: a frame aimed at a CANVAS writes nothing. Before any lock.
    if let Err(e) = crate::sheets::ensure_not_canvas_in_state(&state, sheet_idx, "animate cells") {
        return AnimationFrameResult { updated_cells: Vec::new(), error: Some(e) };
    }

    // A frame may only be applied while the matching anim_snapshot is on file. This is
    // what makes "transient" checkable rather than remembered: no snapshot, no restore,
    // no exemption -- so the write is refused instead of silently escaping the dirty
    // flag. (scenario_show cannot satisfy this, which is correct: it has no restore.)
    let effect = match frame_effect(&state, &params.token) {
        Ok(e) => e,
        Err(e) => {
            return AnimationFrameResult {
                updated_cells: Vec::new(),
                error: Some(e),
            }
        }
    };

    // Lock order matches scenario_show to avoid cross-path deadlocks.
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let dependents_map = state.dependents.lock().unwrap();
    let column_dependents_map = state.column_dependents.lock().unwrap();
    let row_dependents_map = state.row_dependents.lock().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    if sheet_idx >= grids.len() {
        return AnimationFrameResult {
            updated_cells: Vec::new(),
            error: Some(format!("Sheet index {} out of range", sheet_idx)),
        };
    }

    let mut ops: Vec<((u32, u32), SetOp)> = Vec::with_capacity(params.writes.len());
    for w in &params.writes {
        let style_index = grids[sheet_idx]
            .get_cell(w.row, w.col)
            .map_or(0, |c| c.style_index);
        let mut cell = match parse_transient_value(&w.value) {
            CellValue::Number(n) => Cell::new_number(n),
            CellValue::Text(t) => Cell::new_text(t),
            CellValue::Boolean(b) => Cell::new_boolean(b),
            _ => Cell::new_text(w.value.clone()),
        };
        cell.style_index = style_index;
        ops.push(((w.row, w.col), SetOp::Set(cell)));
    }

    let updated_cells = apply_set_ops_and_recalc(
        &effect,
        &mut grids,
        &mut grid,
        active_sheet,
        sheet_idx,
        &sheet_names,
        &styles,
        &dependents_map,
        &column_dependents_map,
        &row_dependents_map,
        &merged_regions,
        &locale,
        &ops,
    );

    AnimationFrameResult {
        updated_cells,
        error: None,
    }
}

/// Restore the model to a named snapshot buffer (and drop it), recalculating
/// dependents. Safe to call with an unknown token (no-op) so stop/cleanup is
/// idempotent.
#[tauri::command]
pub fn anim_restore(state: State<AppState>, params: AnimRestoreParams) -> AnimationFrameResult {
    anim_restore_inner(&state, params)
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
pub(crate) fn anim_restore_inner(state: &AppState, params: AnimRestoreParams) -> AnimationFrameResult {
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

    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    // RE-RESOLVED under the grid locks (`grid` -> `grids` -> `sheet_ids`, the
    // canonical order): a sheet moved between the gate and here is still
    // found. Its kind cannot have changed -- a sheet's kind is fixed for its
    // life and moves with it -- so the gate above still holds for it.
    let Some(sheet_idx) = snapshot_sheet_index(state, saved.sheet_id, params.sheet_index) else {
        return AnimationFrameResult {
            updated_cells: Vec::new(),
            error: Some(
                "The sheet this animation snapshot was taken on no longer exists; nothing was restored"
                    .to_string(),
            ),
        };
    };
    let active_sheet = *state.active_sheet.read().unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let dependents_map = state.dependents.lock().unwrap();
    let column_dependents_map = state.column_dependents.lock().unwrap();
    let row_dependents_map = state.row_dependents.lock().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    if sheet_idx >= grids.len() {
        return AnimationFrameResult {
            updated_cells: Vec::new(),
            error: Some(format!("Sheet index {} out of range", sheet_idx)),
        };
    }

    // `effect` is already a plain DocumentEffect: the token is proven at the top
    // of the command (an unregistered one refuses there), so there is no longer an
    // Option to unwrap here.

    let ops: Vec<((u32, u32), SetOp)> = saved
        .cells
        .into_iter()
        .map(|((r, c), prior)| {
            let op = match prior {
                Some(cell) => SetOp::Set(cell),
                None => SetOp::Clear,
            };
            ((r, c), op)
        })
        .collect();

    let updated_cells = apply_set_ops_and_recalc(
        &effect,
        &mut grids,
        &mut grid,
        active_sheet,
        sheet_idx,
        &sheet_names,
        &styles,
        &dependents_map,
        &column_dependents_map,
        &row_dependents_map,
        &merged_regions,
        &locale,
        &ops,
    );

    AnimationFrameResult {
        updated_cells,
        error: None,
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
    crate::calculation::recalculate_sheet_values(
        &state,
        &user_files_state,
        &pivot_state,
        params.sheet_index,
        Some((&*pane_control_state, &*ribbon_filter_state)),
    );

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
    use std::collections::HashMap;

    /// A transient effect for the pure-helper tests: they exercise the recalc mechanics
    /// directly, so they stand in for a live animation run with its snapshot on file.
    fn test_transient_effect() -> DocumentEffect {
        let mut registry: HashMap<String, ()> = HashMap::new();
        registry.insert("test-run".to_string(), ());
        let scope = TransientScope::prove_restore_registered(&registry, "test-run")
            .expect("registered token");
        DocumentEffect::transient(&scope)
    }

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

    fn locale() -> engine::LocaleSettings {
        engine::LocaleSettings::from_locale_id("en-US")
    }

    /// A1 (literal) with B1 = A1*2 depending on it.
    fn model() -> (Vec<Grid>, Grid, crate::DependencyMap) {
        let mut g = Grid::new();
        g.set_cell(0, 0, Cell::new_number(10.0)); // A1 = 10
        g.set_cell(0, 1, Cell::new_formula("A1*2".to_string())); // B1 = A1*2
        let mut active = Grid::new();
        active.set_cell(0, 0, Cell::new_number(10.0));
        active.set_cell(0, 1, Cell::new_formula("A1*2".to_string()));

        let mut deps = crate::DependencyMap::default();
        let mut b1 = crate::CoordSet::default();
        b1.insert((0, 1)); // B1 depends on A1
        deps.insert((0, 0), b1);

        (vec![g], active, deps)
    }

    #[test]
    fn apply_then_restore_round_trips_literal_and_dependent() {
        let (mut grids, mut active, deps) = model();
        let coldeps = crate::StripeDependentsMap::default();
        let rowdeps = crate::StripeDependentsMap::default();
        let merged = HashSet::new();
        let styles = StyleRegistry::new();
        let names = vec!["Sheet1".to_string()];

        // Snapshot A1.
        let saved: Vec<((u32, u32), Option<Cell>)> =
            vec![((0, 0), grids[0].get_cell(0, 0).cloned())];

        // Apply frame: A1 = 99 -> B1 should recalc to 198.
        let mut a1 = Cell::new_number(99.0);
        a1.style_index = 0;
        let apply_ops = vec![((0, 0), SetOp::Set(a1))];
        apply_set_ops_and_recalc(
            &test_transient_effect(),
            &mut grids, &mut active, 0, 0, &names, &styles, &deps, &coldeps, &rowdeps,
            &merged, &locale(), &apply_ops,
        );
        assert!(matches!(grids[0].get_cell(0, 0).unwrap().value, CellValue::Number(n) if (n - 99.0).abs() < 1e-9));
        assert!(matches!(grids[0].get_cell(0, 1).unwrap().value, CellValue::Number(n) if (n - 198.0).abs() < 1e-9));

        // Restore from snapshot: A1 back to 10 -> B1 back to 20.
        let restore_ops: Vec<((u32, u32), SetOp)> = saved
            .into_iter()
            .map(|((r, c), prior)| (
                (r, c),
                match prior { Some(cell) => SetOp::Set(cell), None => SetOp::Clear },
            ))
            .collect();
        apply_set_ops_and_recalc(
            &test_transient_effect(),
            &mut grids, &mut active, 0, 0, &names, &styles, &deps, &coldeps, &rowdeps,
            &merged, &locale(), &restore_ops,
        );

        let a1_after = grids[0].get_cell(0, 0).unwrap();
        assert!(matches!(a1_after.value, CellValue::Number(n) if (n - 10.0).abs() < 1e-9));
        assert!(a1_after.formula_string().is_none(), "restored A1 must stay a literal");
        assert_eq!(a1_after.style_index, 0);

        let b1_after = grids[0].get_cell(0, 1).unwrap();
        assert!(matches!(b1_after.value, CellValue::Number(n) if (n - 20.0).abs() < 1e-9));
        assert!(b1_after.formula_string().is_some(), "restored B1 must keep its formula");
    }

    #[test]
    fn restore_clears_a_cell_that_was_originally_empty() {
        let (mut grids, mut active, deps) = model();
        let coldeps = crate::StripeDependentsMap::default();
        let rowdeps = crate::StripeDependentsMap::default();
        let merged = HashSet::new();
        let styles = StyleRegistry::new();
        let names = vec!["Sheet1".to_string()];

        // C1 (0,2) is empty originally. Snapshot it (None), then write, then restore.
        let saved: Vec<((u32, u32), Option<Cell>)> =
            vec![((0, 2), grids[0].get_cell(0, 2).cloned())];
        assert!(saved[0].1.is_none());

        let apply_ops = vec![((0, 2), SetOp::Set(Cell::new_number(5.0)))];
        apply_set_ops_and_recalc(
            &test_transient_effect(),
            &mut grids, &mut active, 0, 0, &names, &styles, &deps, &coldeps, &rowdeps,
            &merged, &locale(), &apply_ops,
        );
        assert!(grids[0].get_cell(0, 2).is_some());

        let restore_ops: Vec<((u32, u32), SetOp)> = saved
            .into_iter()
            .map(|((r, c), prior)| (
                (r, c),
                match prior { Some(cell) => SetOp::Set(cell), None => SetOp::Clear },
            ))
            .collect();
        let updated = apply_set_ops_and_recalc(
            &test_transient_effect(),
            &mut grids, &mut active, 0, 0, &names, &styles, &deps, &coldeps, &rowdeps,
            &merged, &locale(), &restore_ops,
        );
        assert!(grids[0].get_cell(0, 2).is_none(), "C1 must be empty again after restore");
        // The cleared cell is reported as an explicit blank so the UI repaints it.
        assert!(updated.iter().any(|c| c.row == 0 && c.col == 2 && c.display.is_empty()));
    }
}
