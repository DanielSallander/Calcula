//! FILENAME: app/src-tauri/src/cell_target.rs
//! PURPOSE: CELL TARGETS -- commands that act on an OBJECT's cells (a floating
//!          grid's backing sheet) instead of Core's selection on the active
//!          sheet (P3, owner finding G3: every Home command on floating-grid
//!          cells).
//!
//! The frontend names WHAT it acts on (`CellTargetRef`, an object id); this
//! module answers WHERE that is, in ONE place (`resolve_cell_target`), so no
//! caller ever handles a backing sheet index the renderer sent. It also owns:
//!
//! * the WRITE EXTENT refusal (`ensure_in_extent`);
//! * the TOCTOU re-check under a command's held grid guards
//!   (`ensure_target_still_at`);
//! * HOST PROTECTION (`target_protection_view`, `gate_target_cells`,
//!   `gate_host_action`): a protected host sheet protects its floating grids'
//!   cells. The backing sheet's own protection is never set, so every existing
//!   pure gate is asked with a ONE-ENTRY view keyed by the backing index that
//!   holds the HOST's protection with its allow-edit ranges cleared (they name
//!   host coordinates, not the grid's). The lock flags then come from the
//!   backing cells, the protected flag and the options from the host;
//! * the styled read the floating grid paints from (`get_cell_target_cells`).
//!
//! The canvas rule: `ensure_not_canvas` is asked about the BACKING sheet, which
//! is never a canvas, so a floating grid on a canvas page takes every cell
//! command. A host's canvas kind is never asked about cells.

use std::collections::{BTreeSet, HashSet};

use tauri::State;

use crate::api_types::{
    CellData, CellTargetCells, CellTargetRef, FloatingRange, MergedRegion, StyleData, StyleEntry,
    TargetCellData,
};
use crate::protection::ProtectionStorage;
use crate::AppState;

/// The `gate_target_cells` action for writing cell CONTENT. It is not a
/// protection OPTION (there is no "edit cells" checkbox): content writes are
/// governed by the lock flags alone, so no option is asked for it.
pub(crate) const EDIT_CELLS: &str = "editCells";

/// A `CellTargetRef` resolved against the live workbook. Valid until the next
/// sheet operation renumbers sheets; a command that holds grid guards
/// re-checks it with `ensure_target_still_at` before writing.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedCellTarget {
    pub id: identity::EntityId,
    pub backing_sheet_id: identity::SheetId,
    pub backing_index: usize,
    pub host_index: usize,
    /// The object's name (= the backing sheet's name), for refusals.
    pub name: String,
    /// `floating_range::floating_range_write_extent`: the window grown to the
    /// backing sheet's used range, capped at the window maxima.
    pub extent_rows: u32,
    pub extent_cols: u32,
    /// The row as resolved (window, size maps, hidden sets).
    pub row: FloatingRange,
}

/// THE ONE RESOLVER.
///
/// LOCKS: `floating_ranges` read (released), `sheet_ids` read (released),
/// `sheet_names` read (released), then the extent read (`active_sheet`,
/// `grid` | `grids`; released). Call holding NOTHING, before the command's
/// own guards.
pub(crate) fn resolve_cell_target(
    state: &AppState,
    target: &CellTargetRef,
) -> Result<ResolvedCellTarget, String> {
    match target {
        CellTargetRef::FloatingRange { id } => {
            let row = state
                .floating_ranges
                .read()
                .map_err(|e| e.to_string())?
                .iter()
                .find(|fr| fr.id == *id)
                .cloned()
                .ok_or_else(|| format!("No floating range with id {id}"))?;
            let (backing_index, host_index) = {
                let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
                let backing = sheet_ids
                    .iter()
                    .position(|s| *s == row.backing_sheet_id)
                    .ok_or_else(|| "Floating range backing sheet is missing".to_string())?;
                let host = sheet_ids
                    .iter()
                    .position(|s| *s == row.host_sheet_id)
                    .ok_or_else(|| "Floating range host sheet is missing".to_string())?;
                (backing, host)
            };
            let name = state
                .sheet_names
                .read()
                .map_err(|e| e.to_string())?
                .get(backing_index)
                .cloned()
                .unwrap_or_default();
            let (extent_rows, extent_cols) =
                crate::floating_range::floating_range_write_extent(state, &row, backing_index);
            Ok(ResolvedCellTarget {
                id: *id,
                backing_sheet_id: row.backing_sheet_id,
                backing_index,
                host_index,
                name,
                extent_rows,
                extent_cols,
                row,
            })
        }
    }
}

/// Refuse a rectangle (inclusive corners, any order) that reaches outside the
/// target's write extent, naming the first cell outside it.
pub(crate) fn ensure_in_extent(
    t: &ResolvedCellTarget,
    r0: u32,
    c0: u32,
    r1: u32,
    c1: u32,
) -> Result<(), String> {
    let (max_row, max_col) = (r0.max(r1), c0.max(c1));
    if max_row < t.extent_rows && max_col < t.extent_cols {
        return Ok(());
    }
    // The cell named is the first one past the extent along the rectangle's
    // far edge -- the one the user can find.
    let row = if max_row >= t.extent_rows { t.extent_rows.max(r0.min(r1)) } else { r0.min(r1) };
    let col = if max_col >= t.extent_cols { t.extent_cols.max(c0.min(c1)) } else { c0.min(c1) };
    Err(format!(
        "Cell {}{} is outside floating grid '{}'. Nothing was changed.",
        crate::pivot::utils::col_index_to_letter(col),
        row + 1,
        t.name
    ))
}

/// TOCTOU re-check UNDER the command's held grid guards: the sheet at
/// `backing_index` is still the target's backing sheet. LOCKS: `sheet_ids`
/// read, released -- after `grids`, the canonical order
/// (animation_commands.rs takes `grids` then `sheet_ids`).
pub(crate) fn ensure_target_still_at(state: &AppState, t: &ResolvedCellTarget) -> Result<(), String> {
    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
    if sheet_ids.get(t.backing_index) == Some(&t.backing_sheet_id) {
        Ok(())
    } else {
        Err(format!(
            "Floating grid '{}' moved while the command ran. Nothing was changed; try again.",
            t.name
        ))
    }
}

/// The HOST-PROTECTION VIEW for a backing sheet: a one-entry storage keyed by
/// `backing_index` holding the host's protection with its allow-edit ranges
/// CLEARED (they name host coordinates, so a range granting host B2 must not
/// grant the floating grid's B2). Empty when the host has no protection entry.
/// Every existing pure gate then runs unchanged with sheet = `backing_index`.
pub(crate) fn protection_view_for(
    storage: &ProtectionStorage,
    host_index: usize,
    backing_index: usize,
) -> ProtectionStorage {
    let mut view = ProtectionStorage::new();
    if let Some(host) = storage.get(&host_index) {
        let mut p = host.clone();
        p.allow_edit_ranges.clear();
        view.insert(backing_index, p);
    }
    view
}

/// [`protection_view_for`] for a resolved target.
pub(crate) fn target_protection_view(
    storage: &ProtectionStorage,
    t: &ResolvedCellTarget,
) -> ProtectionStorage {
    protection_view_for(storage, t.host_index, t.backing_index)
}

/// The host's OPTION gate for an act on a floating grid (`formatRows`,
/// `insertRows`, ...), answered through the view so the canvas rule is asked of
/// the backing sheet. LOCKS: `sheet_kinds` then `sheet_protection`, both read
/// and released; call holding nothing.
pub(crate) fn gate_host_action(
    state: &AppState,
    host_index: usize,
    backing_index: usize,
    action: &str,
    what: &str,
) -> Result<(), String> {
    let kinds = state.sheet_kinds.read().map_err(|e| e.to_string())?;
    let storage = state.sheet_protection.read().map_err(|e| e.to_string())?;
    let view = protection_view_for(&storage, host_index, backing_index);
    crate::protection::check_sheet_action_in(&kinds, &view, backing_index, action, what)
}

/// The state-taking host gate for commands that gate BEFORE their own guards
/// (content writes, structure, clear, sort, merge): the option `action` (none
/// for [`EDIT_CELLS`]), then the BACKING cells' lock flags over `rect`
/// (inclusive `(r0, c0, r1, c1)`), against the host's protection.
///
/// LOCKS: `sheet_kinds` + `sheet_protection` probe (released); then, only when
/// the host is protected, `grid` | `grids` -> `style_registry` ->
/// `sheet_protection`, the canonical order, all released. Same TOCTOU class as
/// `update_cell_on_sheets_inner`'s "protection before any other lock".
pub(crate) fn gate_target_cells(
    state: &AppState,
    t: &ResolvedCellTarget,
    rect: (u32, u32, u32, u32),
    action: &str,
    what: &str,
) -> Result<(), String> {
    let (r0, c0, r1, c1) = (rect.0.min(rect.2), rect.1.min(rect.3), rect.0.max(rect.2), rect.1.max(rect.3));
    let protected = {
        let kinds = state.sheet_kinds.read().map_err(|e| e.to_string())?;
        // The backing sheet is never a canvas; asked anyway, so a future
        // object kind that WERE one is refused rather than written.
        crate::sheets::ensure_not_canvas(&kinds, t.backing_index, what)?;
        let storage = state.sheet_protection.read().map_err(|e| e.to_string())?;
        let view = target_protection_view(&storage, t);
        if action != EDIT_CELLS {
            crate::protection::check_sheet_action_in(&kinds, &view, t.backing_index, action, what)?;
        }
        view.get(&t.backing_index).map(|p| p.protected).unwrap_or(false)
    };
    if !protected {
        return Ok(());
    }
    let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
    let check = |grid: &engine::Grid, styles: &engine::StyleRegistry, storage: &ProtectionStorage| {
        let view = target_protection_view(storage, t);
        crate::protection::check_sheet_protection_range_in(
            &[], &view, grid, styles, t.backing_index, r0, c0, r1, c1,
        )
    };
    if t.backing_index == active {
        let grid = state.grid.read().map_err(|e| e.to_string())?;
        let styles = state.style_registry.read().map_err(|e| e.to_string())?;
        let storage = state.sheet_protection.read().map_err(|e| e.to_string())?;
        check(&grid, &styles, &storage)
    } else {
        let grids = state.grids.read().map_err(|e| e.to_string())?;
        let styles = state.style_registry.read().map_err(|e| e.to_string())?;
        let storage = state.sheet_protection.read().map_err(|e| e.to_string())?;
        let Some(grid) = grids.get(t.backing_index) else {
            return Err("Floating range backing sheet is missing".to_string());
        };
        check(grid, &styles, &storage)
    }
}

/// [`gate_target_cells`] over an explicit CELL LIST instead of a rectangle
/// (Replace All touches only its matches, so a locked cell it never matches
/// must not refuse it -- the same rule `replace_all` applies on a sheet).
/// Content writes only: no protection option is asked.
///
/// LOCKS: `sheet_protection` probe (released); then, only when the host is
/// protected, `grid` | `grids` -> `style_registry` -> `sheet_protection`, the
/// canonical order, all released. Call holding nothing.
pub(crate) fn gate_target_cell_list(
    state: &AppState,
    t: &ResolvedCellTarget,
    cells: &[(u32, u32)],
) -> Result<(), String> {
    let protected = {
        let storage = state.sheet_protection.read().map_err(|e| e.to_string())?;
        target_protection_view(&storage, t)
            .get(&t.backing_index)
            .map(|p| p.protected)
            .unwrap_or(false)
    };
    if !protected || cells.is_empty() {
        return Ok(());
    }
    let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
    let check = |grid: &engine::Grid, styles: &engine::StyleRegistry, storage: &ProtectionStorage| {
        let view = target_protection_view(storage, t);
        crate::protection::check_sheet_protection_cells_in(
            &[], &view, grid, styles, t.backing_index, cells.iter().copied(),
        )
    };
    if t.backing_index == active {
        let grid = state.grid.read().map_err(|e| e.to_string())?;
        let styles = state.style_registry.read().map_err(|e| e.to_string())?;
        let storage = state.sheet_protection.read().map_err(|e| e.to_string())?;
        check(&grid, &styles, &storage)
    } else {
        let grids = state.grids.read().map_err(|e| e.to_string())?;
        let styles = state.style_registry.read().map_err(|e| e.to_string())?;
        let storage = state.sheet_protection.read().map_err(|e| e.to_string())?;
        let Some(grid) = grids.get(t.backing_index) else {
            return Err("Floating range backing sheet is missing".to_string());
        };
        check(grid, &styles, &storage)
    }
}

/// `target` and an explicit sheet / group are mutually exclusive: a command
/// told both would have to guess which one the caller meant.
pub(crate) fn refuse_target_with_sheet(
    target: &Option<CellTargetRef>,
    has_sheet: bool,
) -> Result<(), String> {
    if target.is_some() && has_sheet {
        Err("Pass a floating grid target or a sheet, not both.".to_string())
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// The batch write (paste, AutoSum, Fill Series, Flash Fill into an object)
// ---------------------------------------------------------------------------

/// `update_cells_batch` on an OBJECT's cells (P3 2.4). The active-sheet batch
/// body is NOT reused: its protection check, control-anchor probe and core are
/// all keyed on the active sheet. Instead:
///
/// 1. Holding nothing, before any effect: resolve; the bounding box inside
///    the write extent; the HOST's protection over exactly the written cells'
///    lock flags; the protected-region guard on the backing sheet (none
///    today, kept for truth); and the writeback and array guards per cell, so
///    the writes below can only fail on a poisoned lock and a paste is never
///    half done.
/// 2. ONE owned undo step (`label`, joining a caller's open step); each update
///    goes through `update_cell_on_sheets_inner` on the backing sheet with
///    recalc OFF (it stores, registers the cell's cross-sheet edges and
///    records undo inside the step). An explicit `style_index` is applied
///    FIRST, so the format the entry lands in decides how it is read (a Text
///    cell keeps "007"), exactly as the sheet batch does.
/// 3. PHASE B, holding nothing from phase A: ONE recalculation of the
///    backing sheet's dependents anywhere -- a host formula `=Float1!A1`
///    included.
///
/// Returns the written cells as the object paints them (backing coordinates,
/// display in the app locale), read back through the styled read.
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_cells_batch_on_target(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    target: &CellTargetRef,
    updates: Vec<crate::api_types::CellUpdateInput>,
    label: &str,
) -> Result<Vec<CellData>, String> {
    let t = resolve_cell_target(state, target)?;
    if updates.is_empty() {
        return Ok(Vec::new());
    }
    let cells: Vec<(u32, u32)> = updates.iter().map(|u| (u.row, u.col)).collect();
    let (r0, c0, r1, c1) = cells.iter().fold(
        (u32::MAX, u32::MAX, 0u32, 0u32),
        |(a, b, c, d), &(r, col)| (a.min(r), b.min(col), c.max(r), d.max(col)),
    );
    ensure_in_extent(&t, r0, c0, r1, c1)?;
    let backing = t.backing_index;
    gate_target_cell_list(state, &t, &cells)?;
    crate::commands::data::check_region_cells_protection(state, backing, cells.iter().copied())?;
    for &(row, col) in &cells {
        crate::calp_commands::ensure_writeback_draft_before_write_on_sheets(state, &[backing], row, col)?;
    }
    crate::commands::data::check_spill_protection_cells(state, backing, &cells)?;

    // The undo lock is taken and RELEASED around the step's begin and commit:
    // every write below takes it again itself.
    let owned = {
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        undo_stack.begin_owned_transaction(label.to_string())
    };
    let written = write_batch_on_backing(
        state,
        file_state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        &t,
        updates,
    );
    {
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        undo_stack.commit_owned(owned);
    }
    let written = written?;

    // PHASE B: one recalculation for the whole batch.
    if !written.is_empty() {
        crate::commands::data::recalc_after_off_sheet_write(
            state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &[backing],
        );
    }
    read_written_cells(state, target, &written)
}

/// Step 2 of [`update_cells_batch_on_target`]: the writes, inside the caller's
/// owned undo step. Returns the coordinates written.
#[allow(clippy::too_many_arguments)]
fn write_batch_on_backing(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    t: &ResolvedCellTarget,
    updates: Vec<crate::api_types::CellUpdateInput>,
) -> Result<Vec<(u32, u32)>, String> {
    let backing = t.backing_index;
    let mut written: Vec<(u32, u32)> = Vec::with_capacity(updates.len());
    for u in updates {
        if let Some(style_index) = u.style_index {
            set_backing_style(state, file_state, t, u.row, u.col, style_index)?;
        }
        crate::commands::data::update_cell_on_sheets_inner(
            state,
            file_state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            vec![backing],
            u.row,
            u.col,
            u.value.clone(),
            u.invariant,
            Some(false),
        )?;
        // A clear of a styled paste source keeps the format it brought: the
        // clear above removed the whole cell, so the style is put back.
        if u.value.trim().is_empty() {
            if let Some(style_index) = u.style_index.filter(|&s| s != 0) {
                set_backing_style(state, file_state, t, u.row, u.col, style_index)?;
            }
        }
        written.push((u.row, u.col));
    }
    Ok(written)
}

/// Give one backing cell an explicit style index, recording its previous
/// state in the open undo step. No change, no effect. LOCKS: `grids` ->
/// [`sheet_ids`, the TOCTOU re-check] -> `undo_stack`.
fn set_backing_style(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    t: &ResolvedCellTarget,
    row: u32,
    col: u32,
    style_index: usize,
) -> Result<(), String> {
    let grids = state.grids.lock_pending().map_err(|e| e.to_string())?;
    ensure_target_still_at(state, t)?;
    let Some(grid) = grids.get(t.backing_index) else {
        return Err("Floating range backing sheet is missing".to_string());
    };
    let previous = grid.get_cell(row, col).cloned();
    if previous.as_ref().map(|c| c.style_index) == Some(style_index) {
        return Ok(());
    }
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut grids = grids.authorize(&effect);
    let mut cell = previous.clone().unwrap_or_else(engine::Cell::new);
    cell.style_index = style_index;
    grids[t.backing_index].set_cell(row, col, cell);
    state
        .undo_stack
        .lock()
        .map_err(|e| e.to_string())?
        .record_cell_change(t.backing_index, row, col, previous);
    Ok(())
}

/// The written cells as the object paints them, read through the styled read
/// in bands that respect its cell cap. A written cell left empty and
/// unstyled is returned as an empty cell, so the caller learns it was
/// cleared.
fn read_written_cells(
    state: &AppState,
    target: &CellTargetRef,
    written: &[(u32, u32)],
) -> Result<Vec<CellData>, String> {
    if written.is_empty() {
        return Ok(Vec::new());
    }
    let (r0, c0, r1, c1) = written.iter().fold(
        (u32::MAX, u32::MAX, 0u32, 0u32),
        |(a, b, c, d), &(r, col)| (a.min(r), b.min(col), c.max(r), d.max(col)),
    );
    let width = u64::from(c1 - c0 + 1);
    let band = ((crate::commands::data::MAX_TYPED_RANGE_CELLS as u64 / width).max(1)) as u32;
    let wanted: HashSet<(u32, u32)> = written.iter().copied().collect();
    let mut found: std::collections::HashMap<(u32, u32), CellData> = std::collections::HashMap::new();
    let mut start = r0;
    while start <= r1 {
        let end = start.saturating_add(band - 1).min(r1);
        let part = get_cell_target_cells_inner(state, target, start, c0, end, c1)?;
        for c in part.cells {
            if wanted.contains(&(c.cell.row, c.cell.col)) {
                found.insert((c.cell.row, c.cell.col), c.cell);
            }
        }
        if end == r1 {
            break;
        }
        start = end + 1;
    }
    let mut out: Vec<CellData> = Vec::with_capacity(written.len());
    let mut seen: HashSet<(u32, u32)> = HashSet::new();
    for &(row, col) in written {
        if !seen.insert((row, col)) {
            continue;
        }
        out.push(found.remove(&(row, col)).unwrap_or(CellData {
            row,
            col,
            display: String::new(),
            overflow: crate::api_types::OverflowClass::Text,
            display_color: None,
            formula: None,
            style_index: 0,
            row_span: 1,
            col_span: 1,
            sheet_index: None,
            rich_text: None,
            accounting_layout: None,
        }));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// The styled read
// ---------------------------------------------------------------------------

/// Excel's value kind, for General alignment (numbers right, text left,
/// booleans and errors centred). A collection cell displays as text.
fn value_kind_of(value: Option<&engine::CellValue>) -> &'static str {
    match value {
        None | Some(engine::CellValue::Empty) => "empty",
        Some(engine::CellValue::Number(_)) => "number",
        Some(engine::CellValue::Boolean(_)) => "boolean",
        Some(engine::CellValue::Error(_)) => "error",
        Some(engine::CellValue::Text(_))
        | Some(engine::CellValue::List(_))
        | Some(engine::CellValue::Dict(_)) => "text",
    }
}

/// Read a rectangle of a cell target with everything its renderer paints from:
/// stored cells (style-only empty cells and merge masters included), the
/// backing merges, conditional-format results evaluated on the BACKING grid,
/// the styles the cells use, and the backing rules. A READ: no effect.
#[tauri::command]
pub fn get_cell_target_cells(
    state: State<AppState>,
    target: CellTargetRef,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<CellTargetCells, String> {
    get_cell_target_cells_inner(&state, &target, start_row, start_col, end_row, end_col)
}

/// [`get_cell_target_cells`] over a plain reference (tests).
///
/// LOCALE: read ONCE at the top, holding nothing (take, clone, drop). This is
/// the permanent form: code that holds an `AppState` reads `state.locale`,
/// never the process mirror (`app_locale::display_locale`, which tests do not
/// install). The display-locale census (`display_locale_census_tests.rs`)
/// pins that this function reads `state.locale` and never `invariant()`.
///
/// LOCK ORDER. Section A (cells) mirrors `formatting_result`:
/// `grid` (only if the backing sheet were active) -> `grids` -> [`sheet_ids`,
/// the TOCTOU re-check, released] -> `style_registry` ->
/// `all_merged_regions` | `merged_regions` -> `sheet_protection`, all
/// released, then `theme`. Section B (conditional formats) runs after A is
/// released and mirrors `evaluate_conditional_formats`: `grids` ->
/// `sheet_names` -> `conditional_formats`. CF guards are never held together
/// with `style_registry`.
pub(crate) fn get_cell_target_cells_inner(
    state: &AppState,
    target: &CellTargetRef,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<CellTargetCells, String> {
    let locale = state.locale.lock().map_err(|e| e.to_string())?.clone();
    let t = resolve_cell_target(state, target)?;

    let empty = || CellTargetCells {
        cells: Vec::new(),
        merges: Vec::new(),
        conditional: Vec::new(),
        styles: Vec::new(),
        rules: Vec::new(),
    };
    // Normalise, then CLIP to the extent: a reader asking past it gets the
    // part that exists, never a refusal (the band reader asks in fixed bands).
    let (r0, r1) = (start_row.min(end_row), start_row.max(end_row));
    let (c0, c1) = (start_col.min(end_col), start_col.max(end_col));
    if t.extent_rows == 0 || t.extent_cols == 0 || r0 >= t.extent_rows || c0 >= t.extent_cols {
        return Ok(empty());
    }
    let (r1, c1) = (r1.min(t.extent_rows - 1), c1.min(t.extent_cols - 1));
    let area = (r1 - r0 + 1) as u64 * (c1 - c0 + 1) as u64;
    if area > crate::commands::data::MAX_TYPED_RANGE_CELLS as u64 {
        return Err(format!(
            "A floating grid read covers at most {} cells (asked for {area}); read it in bands.",
            crate::commands::data::MAX_TYPED_RANGE_CELLS
        ));
    }
    let backing = t.backing_index;
    let intersects = |a0: u32, b0: u32, a1: u32, b1: u32| !(a1 < r0 || a0 > r1 || b1 < c0 || b0 > c1);

    // ---- Section A: cells, merges, styles -------------------------------
    let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
    let (cells, merges, used_styles) = {
        let grid_guard = if backing == active {
            Some(state.grid.read().map_err(|e| e.to_string())?)
        } else {
            None
        };
        let grids = state.grids.read().map_err(|e| e.to_string())?;
        ensure_target_still_at(state, &t)?;
        let styles = state.style_registry.read().map_err(|e| e.to_string())?;
        let grid: &engine::Grid = match &grid_guard {
            Some(g) => g,
            None => grids
                .get(backing)
                .ok_or_else(|| "Floating range backing sheet is missing".to_string())?,
        };
        // The backing merges: the per-sheet store, or the active mirror if the
        // backing sheet were ever active (it never is: activate_sheet refuses
        // object sheets).
        let mut merges: Vec<MergedRegion> = if backing == active {
            state.merged_regions.read().map_err(|e| e.to_string())?.iter().cloned().collect()
        } else {
            state
                .all_merged_regions
                .read()
                .map_err(|e| e.to_string())?
                .get(backing)
                .map(|set| set.iter().cloned().collect())
                .unwrap_or_default()
        };
        merges.retain(|m| intersects(m.start_row, m.start_col, m.end_row, m.end_col));
        merges.sort_by_key(|m| (m.start_row, m.start_col, m.end_row, m.end_col));
        // Formula hiding answers from the HOST (the view): a hidden formula on
        // a protected host is withheld here exactly as get_cell withholds one.
        let sheet_protected = {
            let storage = state.sheet_protection.read().map_err(|e| e.to_string())?;
            target_protection_view(&storage, &t)
                .get(&backing)
                .map(|p| p.protected)
                .unwrap_or(false)
        };

        let mut covered: HashSet<(u32, u32)> = HashSet::new();
        for m in &merges {
            for r in m.start_row..=m.end_row {
                for c in m.start_col..=m.end_col {
                    if (r, c) != (m.start_row, m.start_col) {
                        covered.insert((r, c));
                    }
                }
            }
        }
        let span_at = |row: u32, col: u32| {
            merges
                .iter()
                .find(|m| m.start_row == row && m.start_col == col)
                .map(|m| (m.end_row - m.start_row + 1, m.end_col - m.start_col + 1))
                .unwrap_or((1, 1))
        };

        let mut used_styles: BTreeSet<usize> = BTreeSet::new();
        let mut cells: Vec<TargetCellData> = Vec::new();
        for row in r0..=r1 {
            for col in c0..=c1 {
                if covered.contains(&(row, col)) {
                    continue;
                }
                let (row_span, col_span) = span_at(row, col);
                let cell = grid.get_cell(row, col);
                let style_index = grid.effective_style_index(row, col);
                if cell.is_none() && row_span == 1 && col_span == 1 && style_index == 0 {
                    continue;
                }
                let style = styles.get(style_index);
                let data = match cell {
                    Some(c) => {
                        let fmt = crate::format_cell_value_with_color(&c.value, style, &locale);
                        let formula = if sheet_protected && style.formula_hidden {
                            None
                        } else {
                            crate::commands::data::formula_display(c, &locale)
                        };
                        CellData {
                            row,
                            col,
                            display: fmt.text,
                            overflow: fmt.overflow,
                            display_color: fmt.color,
                            formula,
                            style_index,
                            row_span,
                            col_span,
                            sheet_index: None,
                            rich_text: c.rich_text.as_ref().map(|runs| crate::api_types::rich_text_runs_to_data(runs)),
                            accounting_layout: fmt.accounting.map(|a| crate::api_types::AccountingLayout {
                                symbol: a.symbol,
                                symbol_before: a.symbol_before,
                                value: a.value,
                            }),
                        }
                    }
                    None => CellData {
                        row,
                        col,
                        display: String::new(),
                        overflow: crate::api_types::OverflowClass::Text,
                        display_color: None,
                        formula: None,
                        style_index,
                        row_span,
                        col_span,
                        sheet_index: None,
                        rich_text: None,
                        accounting_layout: None,
                    },
                };
                used_styles.insert(style_index);
                cells.push(TargetCellData {
                    cell: data,
                    value_kind: value_kind_of(cell.map(|c| &c.value)).to_string(),
                });
            }
        }
        let used_styles: Vec<(usize, engine::CellStyle)> =
            used_styles.into_iter().map(|i| (i, styles.get(i).clone())).collect();
        (cells, merges, used_styles)
    };
    let styles = {
        let theme = state.theme.read().map_err(|e| e.to_string())?;
        used_styles
            .iter()
            .map(|(index, style)| StyleEntry { index: *index, style: StyleData::from_cell_style(style, &theme) })
            .collect()
    };

    // ---- Section B: conditional formats, on the BACKING grid ----------------
    let (conditional, rules) = {
        let grids = state.grids.read().map_err(|e| e.to_string())?;
        let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
        let cf = state.conditional_formats.read().map_err(|e| e.to_string())?;
        match (cf.get(&backing), grids.get(backing)) {
            (Some(all_rules), Some(grid)) if !all_rules.is_empty() => {
                let conditional = crate::conditional_formatting::evaluate_conditional_formats_for(
                    grid,
                    &grids,
                    &sheet_names,
                    backing,
                    all_rules,
                    r0,
                    r1,
                    c0,
                    c1,
                );
                let rules = all_rules
                    .iter()
                    .filter(|rule| {
                        rule.ranges
                            .iter()
                            .any(|r| intersects(r.start_row, r.start_col, r.end_row, r.end_col))
                    })
                    .cloned()
                    .collect();
                (conditional, rules)
            }
            _ => (Vec::new(), Vec::new()),
        }
    };

    Ok(CellTargetCells { cells, merges, conditional, styles, rules })
}

// ---------------------------------------------------------------------------
// Table-like structure and line formats on an object (P3 S5, spec 2.5 / 2.6)
// ---------------------------------------------------------------------------

/// "row" / "column", for refusals and undo names.
fn line_noun(rows: bool) -> &'static str {
    if rows {
        "row"
    } else {
        "column"
    }
}

/// "Row 5" / "Column E" -- how a refusal names one line of a floating grid.
fn line_label(rows: bool, line: u32) -> String {
    if rows {
        format!("Row {}", line + 1)
    } else {
        format!("Column {}", crate::pivot::utils::col_index_to_letter(line))
    }
}

/// Refuse a line span (`first..=last`) that reaches past the target's write
/// extent, naming the first line outside it.
fn ensure_lines_in_extent(t: &ResolvedCellTarget, rows: bool, first: u32, last: u32) -> Result<(), String> {
    let extent = if rows { t.extent_rows } else { t.extent_cols };
    if first.max(last) < extent {
        return Ok(());
    }
    Err(format!(
        "{} is outside floating grid '{}'. Nothing was changed.",
        line_label(rows, extent.max(first.min(last))),
        t.name
    ))
}

/// The backing sheet's used END line (rows or columns), UNCAPPED -- the cap
/// rule asks where content really is, not where the write extent stops.
/// LOCKS: `active_sheet`, then `grid` | `grids`, read and released.
fn backing_used_end(state: &AppState, backing_index: usize, rows: bool) -> Option<u32> {
    let active = state.active_sheet.read().map(|a| *a).unwrap_or(usize::MAX);
    let used = if backing_index == active {
        state.grid.read().ok().and_then(|g| engine::navigation::used_range(&g))
    } else {
        state
            .grids
            .read()
            .ok()
            .and_then(|g| g.get(backing_index).and_then(engine::navigation::used_range))
    };
    used.map(|(_, _, end_row, end_col)| if rows { end_row } else { end_col })
}

/// A size map after inserting `count` lines at `at`: keys at or past `at`
/// move down by `count`; a key pushed to `max` or past it is dropped (its line
/// left the object's reach).
pub(crate) fn shift_size_map_for_insert(
    map: &std::collections::HashMap<u32, f64>,
    at: u32,
    count: u32,
    max: u32,
) -> std::collections::HashMap<u32, f64> {
    map.iter()
        .filter_map(|(&k, &v)| {
            let moved = if k >= at { k.checked_add(count)? } else { k };
            (moved < max).then_some((moved, v))
        })
        .collect()
}

/// A size map after deleting `count` lines at `at`: keys inside the span are
/// dropped, keys past it move up by `count`.
pub(crate) fn shift_size_map_for_delete(
    map: &std::collections::HashMap<u32, f64>,
    at: u32,
    count: u32,
) -> std::collections::HashMap<u32, f64> {
    let end = at.saturating_add(count);
    map.iter()
        .filter_map(|(&k, &v)| {
            if k < at {
                Some((k, v))
            } else if k < end {
                None
            } else {
                Some((k - count, v))
            }
        })
        .collect()
}

/// A hidden-line set after inserting: the same rule as the size map, kept
/// sorted and deduplicated (`validate_line_set`'s invariant).
pub(crate) fn shift_line_set_for_insert(set: &[u32], at: u32, count: u32, max: u32) -> Vec<u32> {
    let shifted: BTreeSet<u32> = set
        .iter()
        .filter_map(|&k| {
            let moved = if k >= at { k.checked_add(count)? } else { k };
            (moved < max).then_some(moved)
        })
        .collect();
    shifted.into_iter().collect()
}

/// A hidden-line set after deleting: the same rule as the size map.
pub(crate) fn shift_line_set_for_delete(set: &[u32], at: u32, count: u32) -> Vec<u32> {
    let end = at.saturating_add(count);
    let shifted: BTreeSet<u32> = set
        .iter()
        .filter_map(|&k| {
            if k < at {
                Some(k)
            } else if k < end {
                None
            } else {
                Some(k - count)
            }
        })
        .collect();
    shifted.into_iter().collect()
}

/// The window patch a structural edit implies (2.5): the line count grows by
/// `count` when an insert lands INSIDE the window, or shrinks by the deleted
/// lines that were inside it (minimum 1); the size map and the hidden set move
/// with their lines. `None` when nothing about the object changes (an edit
/// wholly below the window that moves no override).
fn window_patch_for(
    row: &FloatingRange,
    rows: bool,
    insert: bool,
    at: u32,
    count: u32,
) -> Option<crate::api_types::FloatingRangePatch> {
    use crate::floating_range::{MAX_FLOATING_RANGE_COLS, MAX_FLOATING_RANGE_ROWS};
    let (line_count, sizes, hidden, max) = if rows {
        (row.row_count, &row.row_heights, &row.hidden_rows, MAX_FLOATING_RANGE_ROWS)
    } else {
        (row.col_count, &row.col_widths, &row.hidden_cols, MAX_FLOATING_RANGE_COLS)
    };
    let (next_count, next_sizes, next_hidden) = if insert {
        let grown = if at < line_count { line_count.saturating_add(count).min(max) } else { line_count };
        (
            grown,
            shift_size_map_for_insert(sizes, at, count, max),
            shift_line_set_for_insert(hidden, at, count, max),
        )
    } else {
        let end = at.saturating_add(count).min(line_count);
        let inside = end.saturating_sub(at.min(line_count));
        (
            line_count.saturating_sub(inside).max(1),
            shift_size_map_for_delete(sizes, at, count),
            shift_line_set_for_delete(hidden, at, count),
        )
    };
    if next_count == line_count && &next_sizes == sizes && &next_hidden == hidden {
        return None;
    }
    let mut patch = crate::api_types::FloatingRangePatch::default();
    if rows {
        if next_count != line_count {
            patch.row_count = Some(next_count);
        }
        if &next_sizes != sizes {
            patch.row_heights = Some(next_sizes);
        }
        if &next_hidden != hidden {
            patch.hidden_rows = Some(next_hidden);
        }
    } else {
        if next_count != line_count {
            patch.col_count = Some(next_count);
        }
        if &next_sizes != sizes {
            patch.col_widths = Some(next_sizes);
        }
        if &next_hidden != hidden {
            patch.hidden_cols = Some(next_hidden);
        }
    }
    Some(patch)
}

#[cfg(test)]
thread_local! {
    /// TEST ONLY: make the window patch of the next structural edit on this
    /// thread fail AFTER the backing sheet shifted -- the one failure (a
    /// poisoned store lock) the all-or-nothing rollback exists for, which a
    /// test cannot otherwise provoke. Consumed by the edit that sees it.
    pub(crate) static FAIL_WINDOW_PATCH_FOR_TEST: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Insert or delete whole ROWS / COLUMNS of a floating grid with TABLE
/// semantics (P3 2.5, DECISIONS2): the backing content shifts (formulas such
/// as `=Float1!A5` on other sheets adjust as Excel does), and the WINDOW grows
/// or shrinks with it, its size map and hidden set moving with their lines --
/// all ONE undo step.
///
/// GATES FIRST, holding nothing, before any effect:
/// 1. resolve; the edited lines inside the write extent;
/// 2. insert: `max(line_count, used_end + 1) + count <= MAX` -- the backing
///    shift moves EVERY line from `at` on, so content already near the cap
///    would be pushed where the extent (capped there) can no longer reach it;
///    delete: never every window line ("A floating grid keeps at least one
///    row.");
/// 3. the gates the window patch runs (subscribed canvas, the host's "Edit
///    objects", the page's Lock Objects when the frame changes), and the
///    HOST's structural option through the host-protection view (insert:
///    `insertRows` / `insertColumns`; delete: `deleteRows` / `deleteColumns`
///    plus the lock flags of the deleted backing cells, as Excel refuses a
///    delete over locked cells).
///
/// Then ONE owned transaction (joining a caller's open step), its undo lock
/// RELEASED before `off_sheet_structural_edit` takes its grid locks (2.13);
/// the backing shift (its own effect, joining the step); the window patch
/// (`PatchGate::ObjectEdit`: inserting a sheet row grows the frame, an object
/// edit); commit. A failure after the first write -- only a poisoned lock can
/// cause one -- takes back everything this edit recorded
/// (`undo_commands::roll_back_open_changes_after`) before the error returns,
/// so no half step survives.
#[allow(clippy::too_many_arguments)]
pub(crate) fn edit_lines_on_target(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    pivot_state: &crate::pivot::PivotState,
    user_files_state: &crate::persistence::UserFilesState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    slicer_state: &crate::slicer::SlicerState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    target: &CellTargetRef,
    rows: bool,
    insert: bool,
    at: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    use crate::floating_range::{MAX_FLOATING_RANGE_COLS, MAX_FLOATING_RANGE_ROWS};
    use calp::writeback::StructuralEdit as SE;

    let noun = line_noun(rows);
    if count == 0 {
        return Err(format!(
            "Nothing to {}: choose at least one {noun}. Nothing was changed.",
            if insert { "insert" } else { "delete" }
        ));
    }
    // 1. Resolve; the edited lines inside the write extent.
    let t = resolve_cell_target(state, target)?;
    let last = at.saturating_add(count - 1);
    if insert {
        ensure_lines_in_extent(&t, rows, at, at)?;
    } else {
        ensure_lines_in_extent(&t, rows, at, last)?;
    }
    let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
    if t.backing_index == active {
        // A backing sheet is never the active sheet; the off-sheet pipeline
        // below is the only one that writes it without the active mirror.
        return Err(format!(
            "Floating grid '{}' cannot be edited while its backing sheet is active. Nothing was changed.",
            t.name
        ));
    }

    // 2. The cap (insert) / the last-line rule (delete).
    let (line_count, max) = if rows {
        (t.row.row_count, MAX_FLOATING_RANGE_ROWS)
    } else {
        (t.row.col_count, MAX_FLOATING_RANGE_COLS)
    };
    if insert {
        let used_lines = backing_used_end(state, t.backing_index, rows)
            .map(|end| end.saturating_add(1))
            .unwrap_or(0);
        let reach = line_count.max(used_lines) as u64 + count as u64;
        if reach > max as u64 {
            return Err(format!("A floating grid holds at most {max} {noun}s. Nothing was changed."));
        }
    } else if at == 0 && count >= line_count {
        return Err(format!("A floating grid keeps at least one {noun}. Nothing was changed."));
    }

    // 3. The window patch's own gates, and the host's structural option.
    let what: &'static str = match (insert, rows) {
        (true, true) => "insert floating grid rows",
        (true, false) => "insert floating grid columns",
        (false, true) => "delete floating grid rows",
        (false, false) => "delete floating grid columns",
    };
    let patch = window_patch_for(&t.row, rows, insert, at, count);
    crate::floating_range::ensure_host_layout_editable(state, &t.row)?;
    crate::floating_range::ensure_host_objects_editable(state, t.host_index, what)?;
    if patch.is_some() {
        // Every field the patch can carry here (count, sizes, hidden set) is
        // geometry: the page's Lock Objects refuses it.
        crate::sheets::ensure_canvas_objects_unlocked(state, t.host_index, what)?;
    }
    let host_option = match (insert, rows) {
        (true, true) => "insertRows",
        (true, false) => "insertColumns",
        (false, true) => "deleteRows",
        (false, false) => "deleteColumns",
    };
    if insert {
        gate_host_action(state, t.host_index, t.backing_index, host_option, what)?;
    } else {
        let rect = if rows {
            (at, 0, last, t.extent_cols.saturating_sub(1))
        } else {
            (0, at, t.extent_rows.saturating_sub(1), last)
        };
        gate_target_cells(state, &t, rect, host_option, what)?;
    }

    // ONE owned step. The undo lock is RELEASED before the shift takes its
    // grid locks (2.13); the shift and the patch JOIN this step. `point` is
    // where this edit's changes start in it (a caller's, before, stay).
    let description = format!("{} floating grid {noun}(s)", if insert { "Insert" } else { "Delete" });
    let (owned, point) = {
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        let owned = undo_stack.begin_owned_transaction(description);
        let point = undo_stack.current_transaction_mut().map(|tx| tx.changes.len()).unwrap_or(0);
        (owned, point)
    };
    let fail = |error: String| -> Result<Vec<CellData>, String> {
        crate::undo_commands::roll_back_open_changes_after(
            state,
            file_state,
            user_files_state,
            pivot_state,
            slicer_state,
            ribbon_filter_state,
            pane_control_state,
            timeline_state,
            point,
        );
        if let Ok(mut undo_stack) = state.undo_stack.lock() {
            undo_stack.cancel_owned(owned);
        }
        Err(error)
    };

    let edit = match (insert, rows) {
        (true, true) => SE::RowInsert { at, count },
        (true, false) => SE::ColInsert { at, count },
        (false, true) => SE::RowDelete { at, count },
        (false, false) => SE::ColDelete { at, count },
    };
    if let Err(e) = crate::commands::structure::off_sheet_structural_edit(
        state,
        file_state,
        pivot_state,
        user_files_state,
        pane_control_state,
        ribbon_filter_state,
        slicer_state,
        timeline_state,
        t.backing_index,
        edit,
    ) {
        return fail(e);
    }

    if let Some(patch) = patch {
        #[cfg(test)]
        if FAIL_WINDOW_PATCH_FOR_TEST.with(|f| f.replace(false)) {
            return fail("The floating range store is unavailable".to_string());
        }
        if let Err(e) = crate::floating_range::update_floating_range_inner(
            state,
            file_state,
            t.id,
            patch,
            crate::floating_range::PatchGate::ObjectEdit,
        ) {
            return fail(e);
        }
    }

    {
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        undo_stack.commit_owned(owned);
    }
    // The active sheet's cells did not change (the backing sheet is never
    // active): the object repaints from `get_cell_target_cells`.
    Ok(Vec::new())
}

/// Home > Format > Row Height / Column Width (and their AutoFit) on a floating
/// grid's lines: the OBJECT's size map, never the backing sheet's
/// `all_row_heights` / `all_column_widths` (the grid paints from its own
/// map). `runs` are inclusive object line runs; `size <= 0` removes the lines'
/// own sizes, as on a sheet; a size is clamped to the object's limits
/// (8..500 px rows, 8..1000 px columns). Gated by the host's Format Rows /
/// Format Columns option (`PatchGate::LineFormat`); Lock Objects still
/// refuses. A resize that changes nothing leaves the document clean.
pub(crate) fn set_line_sizes_on_target(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    target: &CellTargetRef,
    rows: bool,
    runs: &[(u32, u32)],
    size: f64,
) -> Result<(), String> {
    use crate::floating_range::{
        MAX_FLOATING_RANGE_COL_W, MAX_FLOATING_RANGE_ROW_H, MIN_FLOATING_RANGE_COL_W, MIN_FLOATING_RANGE_ROW_H,
    };
    if !size.is_finite() {
        return Err(format!("{} must be a number of pixels.", if rows { "A row height" } else { "A column width" }));
    }
    let t = resolve_cell_target(state, target)?;
    for &(a, b) in runs {
        ensure_lines_in_extent(&t, rows, a.min(b), a.max(b))?;
    }
    let (min, max) = if rows {
        (MIN_FLOATING_RANGE_ROW_H, MAX_FLOATING_RANGE_ROW_H)
    } else {
        (MIN_FLOATING_RANGE_COL_W, MAX_FLOATING_RANGE_COL_W)
    };
    let mut sizes = if rows { t.row.row_heights.clone() } else { t.row.col_widths.clone() };
    for &(a, b) in runs {
        for line in a.min(b)..=a.max(b) {
            if size > 0.0 {
                sizes.insert(line, size.clamp(min, max));
            } else {
                sizes.remove(&line);
            }
        }
    }
    let mut patch = crate::api_types::FloatingRangePatch::default();
    let gate = if rows {
        patch.row_heights = Some(sizes);
        crate::floating_range::PatchGate::LineFormat {
            host_option: "formatRows",
            what: "change a floating grid's row height",
        }
    } else {
        patch.col_widths = Some(sizes);
        crate::floating_range::PatchGate::LineFormat {
            host_option: "formatColumns",
            what: "change a floating grid's column width",
        }
    };
    crate::floating_range::update_floating_range_inner(state, file_state, t.id, patch, gate).map(|_| ())
}

/// Home > Format > Hide & Unhide on a floating grid's lines: the OBJECT's
/// hidden set (2.6), never the backing sheet's user-hidden sets. Returns the
/// object's resulting set, ascending. Gated by the host's Format Rows /
/// Format Columns option; Lock Objects refuses (a hidden line shrinks the
/// frame). NO SUBTOTAL cascade: the engine reads row visibility from sheet
/// sets only (spec, Decision conflicts).
pub(crate) fn set_lines_hidden_on_target(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    target: &CellTargetRef,
    rows: bool,
    lines: &[u32],
    hidden: bool,
) -> Result<Vec<u32>, String> {
    let t = resolve_cell_target(state, target)?;
    for &line in lines {
        ensure_lines_in_extent(&t, rows, line, line)?;
    }
    let current = if rows { &t.row.hidden_rows } else { &t.row.hidden_cols };
    let mut set: BTreeSet<u32> = current.iter().copied().collect();
    for &line in lines {
        if hidden {
            set.insert(line);
        } else {
            set.remove(&line);
        }
    }
    let next: Vec<u32> = set.into_iter().collect();
    let mut patch = crate::api_types::FloatingRangePatch::default();
    let what: &'static str = match (rows, hidden) {
        (true, true) => "hide floating grid rows",
        (true, false) => "unhide floating grid rows",
        (false, true) => "hide floating grid columns",
        (false, false) => "unhide floating grid columns",
    };
    let host_option = if rows {
        patch.hidden_rows = Some(next);
        "formatRows"
    } else {
        patch.hidden_cols = Some(next);
        "formatColumns"
    };
    let info = crate::floating_range::update_floating_range_inner(
        state,
        file_state,
        t.id,
        patch,
        crate::floating_range::PatchGate::LineFormat { host_option, what },
    )?;
    Ok(if rows { info.range.hidden_rows } else { info.range.hidden_cols })
}
