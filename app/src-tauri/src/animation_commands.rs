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

use std::collections::{HashMap, HashSet};
use tauri::State;

use crate::api_types::{
    AnimApplyFrameParams, AnimRestoreParams, AnimSnapshotParams, AnimSnapshotResult,
    AnimationFrameResult, CellData, GifExportRequest, GifFrame, MergedRegion,
};
use crate::{
    evaluate_formula_multi_sheet, format_cell_value, get_column_row_dependents,
    get_recalculation_order, AppState,
};
use engine::{Cell, CellValue, Grid, StyleRegistry};

// ============================================================================
// Helpers
// ============================================================================

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
    let style = styles.get(cell.style_index);
    let display = format_cell_value(&cell.value, style, locale);

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
        display_color: None,
        formula: cell.formula_string().map(|f| format!("={}", f)),
        style_index: cell.style_index,
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
    grids: &mut Vec<Grid>,
    active_grid: &mut Grid,
    active_sheet: usize,
    sheet_idx: usize,
    sheet_names: &[String],
    styles: &StyleRegistry,
    dependents_map: &HashMap<(u32, u32), HashSet<(u32, u32)>>,
    column_dependents_map: &HashMap<u32, HashSet<(u32, u32)>>,
    row_dependents_map: &HashMap<u32, HashSet<(u32, u32)>>,
    merged_regions: &HashSet<MergedRegion>,
    locale: &engine::LocaleSettings,
    ops: &[((u32, u32), SetOp)],
) -> Vec<CellData> {
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
                display_color: None,
                formula: None,
                style_index: 0,
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

// ============================================================================
// Tauri Commands
// ============================================================================

/// Snapshot the given cells into a named transient buffer so a later
/// `anim_restore` can put the model back exactly. One token per driver run.
#[tauri::command]
pub fn anim_snapshot(state: State<AppState>, params: AnimSnapshotParams) -> AnimSnapshotResult {
    let sheet_idx = params.sheet_index;
    let grids = state.grids.lock().unwrap();
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
    drop(grids);

    state
        .animation_snapshots
        .lock()
        .unwrap()
        .insert(params.token, saved);

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
    let sheet_idx = params.sheet_index;

    // Lock order matches scenario_show to avoid cross-path deadlocks.
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let dependents_map = state.dependents.lock().unwrap();
    let column_dependents_map = state.column_dependents.lock().unwrap();
    let row_dependents_map = state.row_dependents.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();
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

    let sheet_idx = params.sheet_index;

    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let dependents_map = state.dependents.lock().unwrap();
    let column_dependents_map = state.column_dependents.lock().unwrap();
    let row_dependents_map = state.row_dependents.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    if sheet_idx >= grids.len() {
        return AnimationFrameResult {
            updated_cells: Vec::new(),
            error: Some(format!("Sheet index {} out of range", sheet_idx)),
        };
    }

    let ops: Vec<((u32, u32), SetOp)> = saved
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

    fn locale() -> engine::LocaleSettings {
        engine::LocaleSettings::from_locale_id("en-US")
    }

    /// A1 (literal) with B1 = A1*2 depending on it.
    fn model() -> (Vec<Grid>, Grid, HashMap<(u32, u32), HashSet<(u32, u32)>>) {
        let mut g = Grid::new();
        g.set_cell(0, 0, Cell::new_number(10.0)); // A1 = 10
        g.set_cell(0, 1, Cell::new_formula("A1*2".to_string())); // B1 = A1*2
        let mut active = Grid::new();
        active.set_cell(0, 0, Cell::new_number(10.0));
        active.set_cell(0, 1, Cell::new_formula("A1*2".to_string()));

        let mut deps: HashMap<(u32, u32), HashSet<(u32, u32)>> = HashMap::new();
        let mut b1 = HashSet::new();
        b1.insert((0, 1)); // B1 depends on A1
        deps.insert((0, 0), b1);

        (vec![g], active, deps)
    }

    #[test]
    fn apply_then_restore_round_trips_literal_and_dependent() {
        let (mut grids, mut active, deps) = model();
        let coldeps = HashMap::new();
        let rowdeps = HashMap::new();
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
        let coldeps = HashMap::new();
        let rowdeps = HashMap::new();
        let merged = HashSet::new();
        let styles = StyleRegistry::new();
        let names = vec!["Sheet1".to_string()];

        // C1 (0,2) is empty originally. Snapshot it (None), then write, then restore.
        let saved: Vec<((u32, u32), Option<Cell>)> =
            vec![((0, 2), grids[0].get_cell(0, 2).cloned())];
        assert!(saved[0].1.is_none());

        let apply_ops = vec![((0, 2), SetOp::Set(Cell::new_number(5.0)))];
        apply_set_ops_and_recalc(
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
            &mut grids, &mut active, 0, 0, &names, &styles, &deps, &coldeps, &rowdeps,
            &merged, &locale(), &restore_ops,
        );
        assert!(grids[0].get_cell(0, 2).is_none(), "C1 must be empty again after restore");
        // The cleared cell is reported as an explicit blank so the UI repaints it.
        assert!(updated.iter().any(|c| c.row == 0 && c.col == 2 && c.display.is_empty()));
    }
}
