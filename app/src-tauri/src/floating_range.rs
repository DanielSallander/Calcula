//! FILENAME: app/src-tauri/src/floating_range.rs
//! PURPOSE: Floating Range objects — lifecycle over OBJECT-backed sheets.
//!
//! A Floating Range (FR) is a shape-like object floating over the grid whose
//! content is a real range of cells. The cells live in an ordinary engine
//! sheet marked `sheets::OBJECT_SHEET_VISIBILITY` (invisible to every sheet
//! surface, fully present to evaluation), so `=Float1!A1` parses, normalizes,
//! cascades, F9s, undoes and persists through the EXISTING sheet machinery.
//! This module owns only what is genuinely object-shaped: the row store
//! (`AppState.floating_ranges`), geometry, the visible row/col window, and the
//! lifecycle commands.
//!
//! # Undo doctrine (BUG-0005 applied to objects)
//!
//! * CREATE keeps the undo history: appending a sheet renumbers nothing and
//!   renames nothing, so no queued entry is invalidated. The creation itself
//!   is not undoable (parity with `add_sheet`).
//! * DELETE and RENAME end the history — they are sheet-structural operations
//!   with exactly the hazards `invalidate_undo_history_for_sheet_structure`
//!   documents, and both run through the sheet machinery that already calls it.
//! * GEOMETRY / WINDOW changes are undoable via `obj_floating_range`
//!   (`r_object_swap`): the payload is EntityId/SheetId-keyed and carries no
//!   sheet index, so it survives every sheet operation unmangled.

use tauri::State;

use crate::api_types::{FloatingRange, FloatingRangeInfo, FloatingRangePatch};
use crate::persistence::FileState;
use crate::pivot::types::PivotState;
use crate::AppState;

/// V1 window bounds. A floating range is a small working surface, not a second
/// workbook; the caps keep the frontend's whole-range fetch and the script
/// surface's payloads bounded.
pub const MAX_FLOATING_RANGE_ROWS: u32 = 1000;
pub const MAX_FLOATING_RANGE_COLS: u32 = 256;

/// The restore kind for geometry/window undo (`RESTORE_REGISTRY`).
pub(crate) const FLOATING_RANGE_RESTORE_KIND: &str = "obj_floating_range";

/// Default name stem: short, because it is typed inside formulas.
const NAME_STEM: &str = "Float";

// ---------------------------------------------------------------------------
// Resolution helpers — stable id -> live index, live index -> info
// ---------------------------------------------------------------------------

/// Resolve a SheetId to its CURRENT index. `None` when the sheet is gone.
pub(crate) fn sheet_index_of(state: &AppState, sheet_id: identity::SheetId) -> Option<usize> {
    state
        .sheet_ids
        .read()
        .ok()?
        .iter()
        .position(|id| *id == sheet_id)
}

/// Re-stamp `OBJECT_SHEET_VISIBILITY` over `visibility` for every floating
/// range's backing sheet. The floating-range store is the AUTHORITY on which
/// sheets are object-backed; any code that restores or rebuilds the
/// visibility vector WHOLESALE (the `sheet_tab_state` undo arm) must call
/// this, or a snapshot recorded before a floating range existed resurrects
/// its cell store as a visible tab.
///
/// Takes the visibility vector as a parameter because the caller already
/// holds its write guard; acquires `floating_ranges` and `sheet_ids` reads
/// itself (visibility-then-floating_ranges is the crate-wide order —
/// `create_floating_range_inner` takes them the same way around).
pub(crate) fn reassert_object_sheet_markers(state: &AppState, visibility: &mut [String]) {
    let Ok(rows) = state.floating_ranges.read() else { return };
    let Ok(sheet_ids) = state.sheet_ids.read() else { return };
    for fr in rows.iter() {
        if let Some(idx) = sheet_ids.iter().position(|id| *id == fr.backing_sheet_id) {
            if let Some(slot) = visibility.get_mut(idx) {
                *slot = crate::sheets::OBJECT_SHEET_VISIBILITY.to_string();
            }
        }
    }
}

fn find_row(state: &AppState, id: identity::EntityId) -> Result<FloatingRange, String> {
    state
        .floating_ranges
        .read()
        .map_err(|e| e.to_string())?
        .iter()
        .find(|fr| fr.id == id)
        .cloned()
        .ok_or_else(|| format!("No floating range with id {id}"))
}

fn info_for(state: &AppState, range: FloatingRange) -> Result<FloatingRangeInfo, String> {
    let backing_sheet_index = sheet_index_of(state, range.backing_sheet_id)
        .ok_or_else(|| "Floating range backing sheet is missing".to_string())?;
    let host_sheet_index = sheet_index_of(state, range.host_sheet_id)
        .ok_or_else(|| "Floating range host sheet is missing".to_string())?;
    let name = state
        .sheet_names
        .read()
        .map_err(|e| e.to_string())?
        .get(backing_sheet_index)
        .cloned()
        .ok_or_else(|| "Floating range backing sheet has no name".to_string())?;
    Ok(FloatingRangeInfo {
        range,
        name,
        backing_sheet_index,
        host_sheet_index,
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Create a floating range: one OBJECT-backed sheet (via the ONE shared
/// `append_sheet_stores` push-list) plus one row. Starts as a 1x1 window at
/// `(x, y)` sheet pixels on the ACTIVE sheet.
///
/// NOT undoable (add_sheet parity), and deliberately does NOT end the undo
/// history: the append renumbers no sheet and rewrites no formula, so every
/// queued entry stays exactly as valid as it was.
#[tauri::command]
pub fn create_floating_range(
    state: State<AppState>,
    file_state: State<FileState>,
    name: Option<String>,
    x: f64,
    y: f64,
) -> Result<FloatingRangeInfo, String> {
    create_floating_range_inner(&state, &file_state, name, x, y)
}

pub(crate) fn create_floating_range_inner(
    state: &AppState,
    file_state: &FileState,
    name: Option<String>,
    x: f64,
    y: f64,
) -> Result<FloatingRangeInfo, String> {
    crate::protection::check_workbook_structure(state, "create a floating range")?;
    // Excel's rule for a caller-supplied name, checked BEFORE the document is
    // marked modified. Uniqueness needs the sheet list — under the lock below.
    let name = match name {
        Some(requested) => Some(crate::sheet_names::validate_sheet_name(&requested)?),
        None => None,
    };
    if !(x.is_finite() && y.is_finite()) || x < 0.0 || y < 0.0 {
        return Err("Floating range position must be finite and non-negative".to_string());
    }

    // The host is the sheet the user is looking at — never an object sheet by
    // the activate_sheet invariant.
    let host_sheet_id = {
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        state
            .sheet_ids
            .read()
            .map_err(|e| e.to_string())?
            .get(active)
            .copied()
            .ok_or_else(|| "Active sheet has no id".to_string())?
    };

    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let created = {
        // CANONICAL LOCK ORDER: grids before sheet_names (see add_sheet).
        let mut grids = state.grids.write(&effect).unwrap();
        let mut sheet_names = state.sheet_names.write(&effect).unwrap();
        let mut freeze_configs = state.freeze_configs.write(&effect).unwrap();
        let mut tab_colors = state.tab_colors.write(&effect).unwrap();
        let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();
        let mut all_column_widths = state.all_column_widths.write(&effect).unwrap();
        let mut all_row_heights = state.all_row_heights.write(&effect).unwrap();

        // Default name: Float1, Float2, ... — free across the SHARED namespace
        // (sheets and floating ranges alike), exactly like add_sheet's counter.
        let new_name = match name {
            Some(requested) => {
                crate::sheet_names::ensure_sheet_name_is_free(&requested, &sheet_names, None)?;
                requested
            }
            None => {
                let mut counter = 1usize;
                loop {
                    let candidate = format!("{NAME_STEM}{counter}");
                    if crate::sheet_names::ensure_sheet_name_is_free(
                        &candidate,
                        &sheet_names,
                        None,
                    )
                    .is_ok()
                    {
                        break candidate;
                    }
                    counter += 1;
                }
            }
        };

        let (_backing_index, backing_sheet_id) = crate::sheets::append_sheet_stores(
            state,
            &effect,
            new_name,
            crate::sheets::OBJECT_SHEET_VISIBILITY,
            &mut sheet_names,
            &mut grids,
            &mut freeze_configs,
            &mut tab_colors,
            &mut sheet_visibility,
            &mut all_column_widths,
            &mut all_row_heights,
        );

        let row = FloatingRange {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            backing_sheet_id,
            host_sheet_id,
            x,
            y,
            rotation: 0.0,
            pin_to_grid: false,
            row_count: 1,
            col_count: 1,
            col_widths: Default::default(),
            row_heights: Default::default(),
            // A new object advertises its private A1 space: name bar, column
            // letters, row numbers. `update_floating_range` turns them off.
            show_title: true,
            show_column_headers: true,
            show_row_headers: true,
        };
        state
            .floating_ranges
            .write(&effect)
            .unwrap()
            .push(row.clone());
        row
    };
    // No dependency rebuild (the new grid is empty and never active), no undo
    // history invalidation (see the module doc), no activation.
    crate::log_info!(
        "FLOAT",
        "created floating range '{}' ({})",
        info_name(state, &created),
        created.id
    );
    info_for(state, created)
}

fn info_name(state: &AppState, range: &FloatingRange) -> String {
    sheet_index_of(state, range.backing_sheet_id)
        .and_then(|i| state.sheet_names.read().ok()?.get(i).cloned())
        .unwrap_or_else(|| "?".to_string())
}

/// Every floating range, with live name/index resolutions. Rows whose backing
/// sheet is missing are skipped (load repair logs them; nothing to render).
#[tauri::command]
pub fn list_floating_ranges(state: State<AppState>) -> Vec<FloatingRangeInfo> {
    list_floating_ranges_inner(&state)
}

pub(crate) fn list_floating_ranges_inner(state: &AppState) -> Vec<FloatingRangeInfo> {
    let rows: Vec<FloatingRange> = match state.floating_ranges.read() {
        Ok(rows) => rows.clone(),
        Err(_) => return Vec::new(),
    };
    rows.into_iter()
        .filter_map(|row| info_for(state, row).ok())
        .collect()
}

/// Patch geometry (`x`/`y`) and/or the visible window (`row_count`/`col_count`).
/// UNDOABLE via `obj_floating_range` — the payload carries stable ids only.
/// Shrinking the window HIDES cells, it never deletes them; regrowing shows
/// them again, and formulas addressing out-of-window cells keep evaluating
/// (they are real cells in a real sheet).
#[tauri::command]
pub fn update_floating_range(
    state: State<AppState>,
    file_state: State<FileState>,
    id: identity::EntityId,
    patch: FloatingRangePatch,
) -> Result<FloatingRangeInfo, String> {
    update_floating_range_inner(&state, &file_state, id, patch)
}

pub(crate) fn update_floating_range_inner(
    state: &AppState,
    file_state: &FileState,
    id: identity::EntityId,
    patch: FloatingRangePatch,
) -> Result<FloatingRangeInfo, String> {
    if let Some(x) = patch.x {
        if !x.is_finite() || x < 0.0 {
            return Err("x must be finite and non-negative".to_string());
        }
    }
    if let Some(y) = patch.y {
        if !y.is_finite() || y < 0.0 {
            return Err("y must be finite and non-negative".to_string());
        }
    }
    if let Some(rows) = patch.row_count {
        if rows == 0 || rows > MAX_FLOATING_RANGE_ROWS {
            return Err(format!(
                "rowCount must be 1..={MAX_FLOATING_RANGE_ROWS}"
            ));
        }
    }
    if let Some(cols) = patch.col_count {
        if cols == 0 || cols > MAX_FLOATING_RANGE_COLS {
            return Err(format!(
                "colCount must be 1..={MAX_FLOATING_RANGE_COLS}"
            ));
        }
    }

    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let (previous, updated) = {
        let mut rows = state.floating_ranges.write(&effect).unwrap();
        let row = rows
            .iter_mut()
            .find(|fr| fr.id == id)
            .ok_or_else(|| format!("No floating range with id {id}"))?;
        let previous = row.clone();
        if let Some(x) = patch.x {
            row.x = x;
        }
        if let Some(y) = patch.y {
            row.y = y;
        }
        if let Some(rc) = patch.row_count {
            row.row_count = rc;
        }
        if let Some(cc) = patch.col_count {
            row.col_count = cc;
        }
        if let Some(v) = patch.show_title {
            row.show_title = v;
        }
        if let Some(v) = patch.show_column_headers {
            row.show_column_headers = v;
        }
        if let Some(v) = patch.show_row_headers {
            row.show_row_headers = v;
        }
        (previous, row.clone())
    };

    // UNDOABLE — recorded after the store guard is released (`undo_stack`
    // precedes the state locks in the canonical order). No entry for a
    // no-op patch: a step that restores the state it is already in reads,
    // from the keyboard, as a swallowed undo.
    let chrome_changed = previous.show_title != updated.show_title
        || previous.show_column_headers != updated.show_column_headers
        || previous.show_row_headers != updated.show_row_headers;
    if previous.x != updated.x
        || previous.y != updated.y
        || previous.row_count != updated.row_count
        || previous.col_count != updated.col_count
        || chrome_changed
    {
        let description = if previous.row_count != updated.row_count
            || previous.col_count != updated.col_count
        {
            "Resize floating range"
        } else if chrome_changed {
            // Chrome is undoable in its own right: hiding a strip SHRINKS the
            // frame, so it is a visible layout change, not a view preference.
            "Change floating range chrome"
        } else {
            "Move floating range"
        };
        let snapshot = crate::undo_commands::FloatingRangeObjSnapshot {
            id,
            previous: Some(previous),
        };
        if let Ok(bytes) = serde_json::to_vec(&snapshot) {
            let mut undo = state.undo_stack.lock().unwrap();
            undo.record_custom_restore(
                FLOATING_RANGE_RESTORE_KIND.to_string(),
                bytes,
                description,
            );
        }
    }

    info_for(state, updated)
}

/// Read a floating range's cells, id-addressed: the same SPARSE
/// `TypedCellData` payload as `get_range_cells_typed` (the caller fills the
/// rectangle), with the backing sheet resolved server-side so the frontend
/// never handles raw sheet indexes.
#[tauri::command]
pub fn get_floating_range_cells(
    state: State<AppState>,
    id: identity::EntityId,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<Vec<crate::api_types::TypedCellData>, String> {
    let range = find_row(&state, id)?;
    let backing_index = sheet_index_of(&state, range.backing_sheet_id)
        .ok_or_else(|| "Floating range backing sheet is missing".to_string())?;
    crate::commands::data::get_range_cells_typed(
        state,
        Some(backing_index),
        start_row,
        start_col,
        end_row,
        end_col,
    )
}

/// Write ONE cell of a floating range, id-addressed (the backing sheet index
/// is resolved server-side — the frontend never handles raw indexes).
/// Delegates to the off-sheet write path (`update_cell_on_sheets_inner`):
/// same protection/writeback/spill gates, same cross-sheet edge registration
/// (GAP A), same recalculation — and UNDOABLE via `SetCell{sheet: backing}`.
///
/// `invariant`: scripts pass `true` for canonical-US typed writes; the UI
/// passes nothing and gets the workbook-locale parse, exactly like the grid.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_floating_range_cell(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    id: identity::EntityId,
    row: u32,
    col: u32,
    value: String,
    invariant: Option<bool>,
) -> Result<Vec<usize>, String> {
    update_floating_range_cell_inner(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        id,
        row,
        col,
        value,
        invariant,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn update_floating_range_cell_inner(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    id: identity::EntityId,
    row: u32,
    col: u32,
    value: String,
    invariant: Option<bool>,
) -> Result<Vec<usize>, String> {
    let range = find_row(state, id)?;
    // The window is object policy: the UI and the script surface address only
    // visible cells. (Out-of-window cells remain REAL cells that formulas can
    // read — this bounds the write door, not the address space.)
    if row >= range.row_count || col >= range.col_count {
        return Err(format!(
            "Cell ({row},{col}) is outside the floating range's {}x{} window",
            range.row_count, range.col_count
        ));
    }
    let backing_index = sheet_index_of(state, range.backing_sheet_id)
        .ok_or_else(|| "Floating range backing sheet is missing".to_string())?;
    crate::commands::data::update_cell_on_sheets_inner(
        state,
        file_state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        vec![backing_index],
        row,
        col,
        value,
        invariant,
        Some(true),
    )
}

/// Rename a floating range — through the SHEET rename machinery (validation,
/// the workbook-repairable gate, `repair_all_formulas` over every grid,
/// cross-map re-keying, name-casing restamp), because the object's name IS its
/// backing sheet's name. Ends the undo history, exactly like a sheet rename
/// and for exactly its reasons.
#[tauri::command]
pub fn rename_floating_range(
    state: State<AppState>,
    file_state: State<FileState>,
    id: identity::EntityId,
    new_name: String,
) -> Result<FloatingRangeInfo, String> {
    rename_floating_range_inner(&state, &file_state, id, new_name)
}

pub(crate) fn rename_floating_range_inner(
    state: &AppState,
    file_state: &FileState,
    id: identity::EntityId,
    new_name: String,
) -> Result<FloatingRangeInfo, String> {
    let row = find_row(state, id)?;
    let backing_index = sheet_index_of(state, row.backing_sheet_id)
        .ok_or_else(|| "Floating range backing sheet is missing".to_string())?;
    crate::sheets::rename_sheet_inner(state, file_state, backing_index, new_name, true)?;
    info_for(state, row)
}

/// Delete a floating range: the backing sheet goes through the SHEET delete
/// machinery (`delete_sheet_impl` — repairable pre-flight, store removals,
/// `#REF!` repair, cross-map re-keying, workbook recalculation, undo history
/// ended), then the object row is removed. The pre-flight can refuse; a
/// refused delete leaves the row in place.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn delete_floating_range(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    timeline_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    id: identity::EntityId,
) -> Result<(), String> {
    delete_floating_range_inner(
        &state,
        &file_state,
        &pivot_state,
        &user_files_state,
        &pane_control_state,
        &ribbon_filter_state,
        &slicer_state,
        &timeline_state,
        id,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn delete_floating_range_inner(
    state: &AppState,
    file_state: &FileState,
    pivot_state: &PivotState,
    user_files_state: &crate::persistence::UserFilesState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    slicer_state: &crate::slicer::SlicerState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    id: identity::EntityId,
) -> Result<(), String> {
    let row = find_row(state, id)?;
    let backing_index = sheet_index_of(state, row.backing_sheet_id)
        .ok_or_else(|| "Floating range backing sheet is missing".to_string())?;

    // The sheet delete first — it holds the refusal gate. Only after it
    // succeeds does the object row go, so a refused delete changes nothing.
    crate::sheets::delete_sheet_impl(
        state,
        file_state,
        pivot_state,
        user_files_state,
        pane_control_state,
        ribbon_filter_state,
        slicer_state,
        timeline_state,
        backing_index,
        true,
    )?;

    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    state
        .floating_ranges
        .write(&effect)
        .unwrap()
        .retain(|fr| fr.id != id);
    crate::log_info!("FLOAT", "deleted floating range {}", id);
    Ok(())
}

/// GAP B: register every object-backed sheet's cross-sheet dependency edges.
///
/// The active-sheet-only edge rebuild (`rebuild_all_dependencies_from_grid`)
/// registers cross-sheet edges lazily, when a sheet becomes ACTIVE — and a
/// backing sheet never does. A loaded document's floating-range formulas would
/// therefore come back present, values intact, and permanently DEAD (§2z's
/// defect class: restored collection, missing index). Called from the load
/// path after `rebuild_all_dependencies`, and from `.calp` materialization —
/// the ONE shared installer rule.
///
/// Callers must hold NO AppState locks.
pub(crate) fn register_object_sheet_edges(state: &AppState) {
    let grids = state.grids.read().unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let visibility = state.sheet_visibility.read().unwrap();
    let mut dependents = state.cross_sheet_dependents.lock().unwrap();
    let mut dependencies = state.cross_sheet_dependencies.lock().unwrap();

    for idx in 0..grids.len() {
        if crate::sheets::is_user_sheet(&visibility, idx) {
            continue;
        }
        let grid = &grids[idx];
        // Collect first: update_cross_sheet_dependencies mutates the maps and
        // the iteration must see a consistent grid.
        let formula_cells: Vec<((u32, u32), rustc_hash::FxHashSet<(String, u32, u32)>)> = grid
            .cells
            .iter()
            .filter_map(|(&(row, col), cell)| {
                let ast = cell.ast.as_deref()?;
                let refs = crate::extract_all_references(ast, grid).cross_sheet_cells;
                if refs.is_empty() {
                    return None;
                }
                Some(((row, col), crate::normalize_cross_sheet_refs(&refs, &sheet_names)))
            })
            .collect();
        for ((row, col), refs) in formula_cells {
            crate::update_cross_sheet_dependencies(
                (idx, row, col),
                refs,
                &mut dependencies,
                &mut dependents,
            );
        }
    }
}

/// The Sheet → FloatingRange cascade (`DEPENDENCY_MATRIX`): every floating
/// range HOSTED on the deleted sheet dies with it. Called by
/// `delete_sheet_impl` with all locks released; each orphan deletes its own
/// backing sheet back through `delete_sheet_impl` (depth one — a backing sheet
/// hosts nothing).
#[allow(clippy::too_many_arguments)]
pub(crate) fn delete_floating_ranges_for_host(
    state: &AppState,
    file_state: &FileState,
    pivot_state: &PivotState,
    user_files_state: &crate::persistence::UserFilesState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    slicer_state: &crate::slicer::SlicerState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    host_sheet_id: identity::SheetId,
) {
    let orphaned: Vec<identity::EntityId> = match state.floating_ranges.read() {
        Ok(rows) => rows
            .iter()
            .filter(|fr| fr.host_sheet_id == host_sheet_id)
            .map(|fr| fr.id)
            .collect(),
        Err(_) => return,
    };
    for id in orphaned {
        // Indexes shift after every delete; each pass re-resolves from the
        // stable id inside delete_floating_range_inner.
        if let Err(e) = delete_floating_range_inner(
            state,
            file_state,
            pivot_state,
            user_files_state,
            pane_control_state,
            ribbon_filter_state,
            slicer_state,
            timeline_state,
            id,
        ) {
            // The host sheet is already gone; a refusal here would strand the
            // row. Drop it anyway and log — the backing sheet, if it survived,
            // is invisible and unreferenced by the object store.
            crate::log_error!(
                "FLOAT",
                "cascade delete of floating range {} failed: {} — dropping its row",
                id,
                e
            );
            if let Ok(mut rows) = state
                .floating_ranges
                .write(&crate::document_effect::DocumentEffect::mutates(file_state))
            {
                rows.retain(|fr| fr.id != id);
            }
        }
    }
}
