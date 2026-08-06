//! FILENAME: app/src-tauri/src/commands/dimensions.rs
// PURPOSE: Managing row heights and column widths.

use crate::api_types::{DefaultDimensions, DimensionData};
use crate::persistence::FileState;
use crate::AppState;
use tauri::State;

/// Set a column width.
#[tauri::command]
pub fn set_column_width(state: State<AppState>, file_state: State<FileState>, col: u32, width: f64) -> Result<(), String> {
    // allowFormatColumns option gate. Returns Result (it used to return unit) so
    // a refusal can reach the user instead of the resize silently not happening.
    {
        let active_sheet = *state.active_sheet.lock().unwrap();
        crate::protection::check_sheet_action(&state, active_sheet, "formatColumns", "resize columns")?;
    }
    let mut widths = state.column_widths.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Record previous state for undo
    let previous_width = widths.get(&col).copied();

    if width > 0.0 {
        widths.insert(col, width);
    } else {
        widths.remove(&col);
    }

    // Record undo
    undo_stack.record_column_width_change(col, previous_width);

    // Mark workbook as dirty
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }
    Ok(())
}

/// Get a column width.
#[tauri::command]
pub fn get_column_width(state: State<AppState>, col: u32) -> Option<f64> {
    let widths = state.column_widths.lock().unwrap();
    widths.get(&col).copied()
}

/// Get all column widths.
#[tauri::command]
pub fn get_all_column_widths(state: State<AppState>) -> Vec<DimensionData> {
    let widths = state.column_widths.lock().unwrap();
    widths
        .iter()
        .map(|(&index, &size)| DimensionData { index, size, dimension_type: "column".to_string() })
        .collect()
}

/// Set a row height.
#[tauri::command]
pub fn set_row_height(state: State<AppState>, file_state: State<FileState>, row: u32, height: f64) -> Result<(), String> {
    // allowFormatRows option gate; see set_column_width for the Result change.
    {
        let active_sheet = *state.active_sheet.lock().unwrap();
        crate::protection::check_sheet_action(&state, active_sheet, "formatRows", "resize rows")?;
    }
    let mut heights = state.row_heights.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Record previous state for undo
    let previous_height = heights.get(&row).copied();

    if height > 0.0 {
        heights.insert(row, height);
    } else {
        heights.remove(&row);
    }

    // Record undo
    undo_stack.record_row_height_change(row, previous_height);

    // Mark workbook as dirty
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }
    Ok(())
}

/// Get a row height.
#[tauri::command]
pub fn get_row_height(state: State<AppState>, row: u32) -> Option<f64> {
    let heights = state.row_heights.lock().unwrap();
    heights.get(&row).copied()
}

/// Get all row heights.
#[tauri::command]
pub fn get_all_row_heights(state: State<AppState>) -> Vec<DimensionData> {
    let heights = state.row_heights.lock().unwrap();
    heights
        .iter()
        .map(|(&index, &size)| DimensionData { index, size, dimension_type: "row".to_string() })
        .collect()
}

/// Get the default row height and column width.
#[tauri::command]
pub fn get_default_dimensions(state: State<AppState>) -> DefaultDimensions {
    let row_h = *state.default_row_height.lock().unwrap();
    let col_w = *state.default_column_width.lock().unwrap();
    DefaultDimensions {
        default_row_height: row_h,
        default_column_width: col_w,
    }
}

/// Set the default row height.
#[tauri::command]
pub fn set_default_row_height(state: State<AppState>, file_state: State<FileState>, height: f64) -> DefaultDimensions {
    let clamped = if height < 1.0 { 1.0 } else { height };
    let mut h = state.default_row_height.lock().unwrap();
    let previous = *h;
    *h = clamped;
    drop(h);

    // Record undo
    let data = serde_json::to_vec(&previous).unwrap_or_default();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.record_custom_restore("default_row_height".to_string(), data, "Change default row height");
    drop(undo_stack);

    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }
    let col_w = *state.default_column_width.lock().unwrap();
    DefaultDimensions {
        default_row_height: clamped,
        default_column_width: col_w,
    }
}

/// Set the default column width.
#[tauri::command]
pub fn set_default_column_width(state: State<AppState>, file_state: State<FileState>, width: f64) -> DefaultDimensions {
    let clamped = if width < 1.0 { 1.0 } else { width };
    let mut w = state.default_column_width.lock().unwrap();
    let previous = *w;
    *w = clamped;
    drop(w);

    // Record undo
    let data = serde_json::to_vec(&previous).unwrap_or_default();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.record_custom_restore("default_column_width".to_string(), data, "Change default column width");
    drop(undo_stack);

    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }
    let row_h = *state.default_row_height.lock().unwrap();
    DefaultDimensions {
        default_row_height: row_h,
        default_column_width: clamped,
    }
}
// ============================================================================
// User-hidden rows / columns
// ============================================================================
//
// Hiding a row is the degenerate case of a dimension, so it lives here and
// follows `set_row_height` exactly: protection gate, mutate, record undo, mark
// the workbook dirty. Before this existed, hide/unhide was frontend-only
// session state -- it never reached the backend, never marked the document
// modified, was not undoable, did not shift when rows were inserted, and was
// lost on save/reload.
//
// THIS IS AN AUTHORITY, NOT A CACHE. Three independent sources can hide a row
// and none of them may write another's set:
//
//     effectiveHidden(row) = userHidden(row) OR filterHidden(row) OR outlineHidden(row)
//
// A filter recompute must not clear a user hide; a user unhide must not
// resurrect a filter-hidden row. `commands::nav::collect_hidden_rows_for_sheet`
// is where the three are composed.

use std::collections::HashSet;

/// Grow both per-sheet user-hidden vectors to at least `len` entries.
///
/// Every per-sheet vector in AppState has to stay parallel with the sheet list.
/// Rather than mirror this into all the sites that push a sheet, the accessors
/// below grow on demand -- a missed site then yields an EMPTY set (nothing
/// hidden) instead of a panic or a set read off the wrong sheet.
pub(crate) fn ensure_user_hidden_len(state: &AppState, len: usize) {
    if let Ok(mut rows) = state.all_user_hidden_rows.lock() {
        while rows.len() < len {
            rows.push(HashSet::new());
        }
    }
    if let Ok(mut cols) = state.all_user_hidden_cols.lock() {
        while cols.len() < len {
            cols.push(HashSet::new());
        }
    }
}

/// Move the ACTIVE sheet's user-hidden sets into per-sheet slot `index`
/// (leaving the active mirror empty). Call before switching away from `index`.
pub(crate) fn stash_active_user_hidden(state: &AppState, index: usize) {
    ensure_user_hidden_len(state, index + 1);
    if let (Ok(mut all), Ok(mut active)) =
        (state.all_user_hidden_rows.lock(), state.user_hidden_rows.lock())
    {
        all[index] = std::mem::take(&mut *active);
    }
    if let (Ok(mut all), Ok(mut active)) =
        (state.all_user_hidden_cols.lock(), state.user_hidden_cols.lock())
    {
        all[index] = std::mem::take(&mut *active);
    }
}

/// Move per-sheet slot `index` into the ACTIVE mirror. Call after switching to
/// `index`.
pub(crate) fn load_active_user_hidden(state: &AppState, index: usize) {
    ensure_user_hidden_len(state, index + 1);
    if let (Ok(mut all), Ok(mut active)) =
        (state.all_user_hidden_rows.lock(), state.user_hidden_rows.lock())
    {
        *active = std::mem::take(&mut all[index]);
    }
    if let (Ok(mut all), Ok(mut active)) =
        (state.all_user_hidden_cols.lock(), state.user_hidden_cols.lock())
    {
        *active = std::mem::take(&mut all[index]);
    }
}

/// Append an empty per-sheet slot (a brand-new sheet hides nothing).
pub(crate) fn push_user_hidden_sheet(state: &AppState) {
    if let Ok(mut rows) = state.all_user_hidden_rows.lock() {
        rows.push(HashSet::new());
    }
    if let Ok(mut cols) = state.all_user_hidden_cols.lock() {
        cols.push(HashSet::new());
    }
}

/// Insert a per-sheet slot at `at`, cloned from `source` (sheet duplicate).
pub(crate) fn duplicate_user_hidden_sheet(state: &AppState, source: usize, at: usize) {
    ensure_user_hidden_len(state, source.max(at) + 1);
    if let Ok(mut rows) = state.all_user_hidden_rows.lock() {
        let cloned = rows[source].clone();
        let at = at.min(rows.len());
        rows.insert(at, cloned);
    }
    if let Ok(mut cols) = state.all_user_hidden_cols.lock() {
        let cloned = cols[source].clone();
        let at = at.min(cols.len());
        cols.insert(at, cloned);
    }
}

/// Drop the per-sheet slot for a deleted sheet.
pub(crate) fn remove_user_hidden_sheet(state: &AppState, index: usize) {
    if let Ok(mut rows) = state.all_user_hidden_rows.lock() {
        if index < rows.len() {
            rows.remove(index);
        }
    }
    if let Ok(mut cols) = state.all_user_hidden_cols.lock() {
        if index < cols.len() {
            cols.remove(index);
        }
    }
}

fn rotate_slot<T>(v: &mut Vec<T>, from: usize, to: usize) {
    if from >= v.len() || to >= v.len() || from == to {
        return;
    }
    if from < to {
        v[from..=to].rotate_left(1);
    } else {
        v[to..=from].rotate_right(1);
    }
}

/// Rotate a per-sheet slot from `from` to `to` (sheet reorder).
pub(crate) fn rotate_user_hidden_sheet(state: &AppState, from: usize, to: usize, count: usize) {
    ensure_user_hidden_len(state, count);
    if let Ok(mut rows) = state.all_user_hidden_rows.lock() {
        rotate_slot(&mut rows, from, to);
    }
    if let Ok(mut cols) = state.all_user_hidden_cols.lock() {
        rotate_slot(&mut cols, from, to);
    }
}

/// The user-hidden rows for ANY sheet, active or not. The active sheet's set
/// lives in the mirror; every other sheet's in the per-sheet vector.
pub(crate) fn user_hidden_rows_for_sheet(state: &AppState, sheet_index: usize) -> HashSet<u32> {
    let active = state.active_sheet.lock().map(|a| *a).unwrap_or(0);
    if sheet_index == active {
        state.user_hidden_rows.lock().map(|s| s.clone()).unwrap_or_default()
    } else {
        state
            .all_user_hidden_rows
            .lock()
            .ok()
            .and_then(|v| v.get(sheet_index).cloned())
            .unwrap_or_default()
    }
}

/// The user-hidden columns for ANY sheet (see `user_hidden_rows_for_sheet`).
pub(crate) fn user_hidden_cols_for_sheet(state: &AppState, sheet_index: usize) -> HashSet<u32> {
    let active = state.active_sheet.lock().map(|a| *a).unwrap_or(0);
    if sheet_index == active {
        state.user_hidden_cols.lock().map(|s| s.clone()).unwrap_or_default()
    } else {
        state
            .all_user_hidden_cols
            .lock()
            .ok()
            .and_then(|v| v.get(sheet_index).cloned())
            .unwrap_or_default()
    }
}

/// Replace the user-hidden sets for ANY sheet, active or not (load paths).
pub(crate) fn set_user_hidden_for_sheet(
    state: &AppState,
    sheet_index: usize,
    rows: HashSet<u32>,
    cols: HashSet<u32>,
) {
    ensure_user_hidden_len(state, sheet_index + 1);
    let active = state.active_sheet.lock().map(|a| *a).unwrap_or(0);
    if let Ok(mut all) = state.all_user_hidden_rows.lock() {
        all[sheet_index] = rows.clone();
    }
    if let Ok(mut all) = state.all_user_hidden_cols.lock() {
        all[sheet_index] = cols.clone();
    }
    if sheet_index == active {
        if let Ok(mut mirror) = state.user_hidden_rows.lock() {
            *mirror = rows;
        }
        if let Ok(mut mirror) = state.user_hidden_cols.lock() {
            *mirror = cols;
        }
    }
}

/// Hide or unhide a set of ROWS on the active sheet.
///
/// Range-taking rather than per-index: "Hide" on a 500-row selection must be
/// ONE IPC call and ONE undo step. Returns the resulting user-hidden row set
/// (ascending) so the caller can update its view without a second read.
///
/// ALSO RECALCULATES SUBTOTAL/AGGREGATE. Row visibility is a formula input for
/// exactly those two functions, and hiding a row writes no cell, so nothing in
/// the dependency graph dirties them. Without the cascade below,
/// `SUBTOTAL(109, A1:A100)` would keep showing its pre-hide total until some
/// unrelated edit swept it up — and would be SAVED that way. The cascade runs
/// after the mutation, holding no locks, and the resulting values reach the
/// screen through `grid:refresh` (the same event the .calp refresh path uses),
/// so the command's own return contract is unchanged.
#[tauri::command]
pub fn set_rows_hidden(
    app: tauri::AppHandle,
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    rows: Vec<u32>,
    hidden: bool,
) -> Result<Vec<u32>, String> {
    let result = set_rows_hidden_inner(&state, &file_state, &rows, hidden)?;
    recalc_visibility_after_row_change(
        &app,
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
    );
    Ok(result)
}

/// Run the SUBTOTAL/AGGREGATE cascade and tell the frontend to refetch.
///
/// Callers must hold no grid or store lock. Failures are swallowed on purpose:
/// the visibility change itself already succeeded and is undoable, and a failed
/// recalculation must not turn a successful hide into an error the user cannot
/// act on. (The stale-value case is then no worse than before this existed.)
///
/// There is deliberately NO column counterpart. SUBTOTAL and AGGREGATE are
/// row-oriented — Microsoft's AGGREGATE reference states outright that hiding
/// columns in a horizontal range does not affect the result — so
/// `set_cols_hidden` has nothing to recalculate.
pub(crate) fn recalc_visibility_after_row_change(
    app: &tauri::AppHandle,
    state: &AppState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
) {
    use tauri::Emitter;
    match crate::calculation::recalc_visibility_dependents_core(
        state,
        user_files_state,
        pivot_state,
        Some((pane_control_state, ribbon_filter_state)),
    ) {
        Ok(cells) if !cells.is_empty() => {
            let _ = app.emit("grid:refresh", ());
        }
        Ok(_) => {}
        Err(e) => {
            crate::log_warn!("CMD", "visibility recalc after row hide failed: {}", e);
        }
    }
}

/// State-only body of `set_rows_hidden` (unit-testable without a Tauri State).
pub(crate) fn set_rows_hidden_inner(
    state: &AppState,
    file_state: &FileState,
    rows: &[u32],
    hidden: bool,
) -> Result<Vec<u32>, String> {
    // Hiding a row IS a row format in Excel, and it is gated by the same
    // protection option as resizing one.
    let active_sheet = *state.active_sheet.lock().unwrap();
    crate::protection::check_sheet_action(
        state,
        active_sheet,
        "formatRows",
        if hidden { "hide rows" } else { "unhide rows" },
    )?;

    let previous: Vec<u32> = {
        let mut set = state.user_hidden_rows.lock().unwrap();
        let mut prev: Vec<u32> = set.iter().copied().collect();
        prev.sort_unstable();
        for r in rows {
            if hidden {
                set.insert(*r);
            } else {
                set.remove(r);
            }
        }
        prev
    };

    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.record_custom_restore(
            crate::undo_commands::USER_HIDDEN_RESTORE_KIND.to_string(),
            crate::undo_commands::user_hidden_snapshot_bytes(active_sheet, Some(previous), None),
            if hidden { "Hide rows" } else { "Unhide rows" },
        );
    }

    if let Ok(mut modified) = file_state.is_modified.lock() {
        *modified = true;
    }
    Ok(sorted_set(&state.user_hidden_rows))
}

/// Hide or unhide a set of COLUMNS on the active sheet (see `set_rows_hidden`).
#[tauri::command]
pub fn set_cols_hidden(
    state: State<AppState>,
    file_state: State<FileState>,
    cols: Vec<u32>,
    hidden: bool,
) -> Result<Vec<u32>, String> {
    set_cols_hidden_inner(&state, &file_state, &cols, hidden)
}

/// State-only body of `set_cols_hidden` (unit-testable without a Tauri State).
pub(crate) fn set_cols_hidden_inner(
    state: &AppState,
    file_state: &FileState,
    cols: &[u32],
    hidden: bool,
) -> Result<Vec<u32>, String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    crate::protection::check_sheet_action(
        state,
        active_sheet,
        "formatColumns",
        if hidden { "hide columns" } else { "unhide columns" },
    )?;

    let previous: Vec<u32> = {
        let mut set = state.user_hidden_cols.lock().unwrap();
        let mut prev: Vec<u32> = set.iter().copied().collect();
        prev.sort_unstable();
        for c in cols {
            if hidden {
                set.insert(*c);
            } else {
                set.remove(c);
            }
        }
        prev
    };

    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.record_custom_restore(
            crate::undo_commands::USER_HIDDEN_RESTORE_KIND.to_string(),
            crate::undo_commands::user_hidden_snapshot_bytes(active_sheet, None, Some(previous)),
            if hidden { "Hide columns" } else { "Unhide columns" },
        );
    }

    if let Ok(mut modified) = file_state.is_modified.lock() {
        *modified = true;
    }
    Ok(sorted_set(&state.user_hidden_cols))
}

fn sorted_set(m: &std::sync::Mutex<HashSet<u32>>) -> Vec<u32> {
    let set = m.lock().unwrap();
    let mut v: Vec<u32> = set.iter().copied().collect();
    v.sort_unstable();
    v
}

/// The rows the user hid by hand on the active sheet, ascending.
#[tauri::command]
pub fn get_user_hidden_rows(state: State<AppState>) -> Vec<u32> {
    sorted_set(&state.user_hidden_rows)
}

/// The columns the user hid by hand on the active sheet, ascending.
#[tauri::command]
pub fn get_user_hidden_cols(state: State<AppState>) -> Vec<u32> {
    sorted_set(&state.user_hidden_cols)
}

/// Sort a set into the ascending vector the wire types carry.
fn ascending(set: HashSet<u32>) -> Vec<u32> {
    let mut v: Vec<u32> = set.into_iter().collect();
    v.sort_unstable();
    v
}

/// Reject a sheet index that is past the end of the workbook. Reading a
/// missing sheet must SAY SO rather than answering "nothing is hidden" --
/// that is the difference between an honest error and a silent wrong answer.
pub(crate) fn resolve_sheet(
    state: &AppState,
    sheet_index: Option<usize>,
    method: &str,
) -> Result<usize, String> {
    let active = *state.active_sheet.lock().unwrap();
    let target = sheet_index.unwrap_or(active);
    let count = state.sheet_names.lock().map(|n| n.len()).unwrap_or(0);
    if target >= count {
        return Err(format!(
            "{}: no sheet with index {} (the workbook has {} sheet(s))",
            method, target, count
        ));
    }
    Ok(target)
}

/// Which ROWS are hidden on `sheet_index` (the active sheet by default), split
/// into the by-hand set and the effective union.
///
/// ANY sheet, not just the active one: `user_hidden_rows_for_sheet` reads the
/// active mirror or the per-sheet vector as appropriate, and
/// `collect_hidden_rows_for_sheet` composes the three authorities. This is the
/// read a script needs to answer "is row 5 of Sheet Data visible?" without an
/// activate-dance.
#[tauri::command]
pub fn get_hidden_rows_info(
    state: State<AppState>,
    sheet_index: Option<usize>,
) -> Result<crate::api_types::HiddenLinesInfo, String> {
    hidden_rows_info_inner(&state, sheet_index)
}

/// State-only body of `get_hidden_rows_info` (unit-testable without a State).
pub(crate) fn hidden_rows_info_inner(
    state: &AppState,
    sheet_index: Option<usize>,
) -> Result<crate::api_types::HiddenLinesInfo, String> {
    let target = resolve_sheet(state, sheet_index, "getHiddenRows")?;
    Ok(crate::api_types::HiddenLinesInfo {
        user: ascending(user_hidden_rows_for_sheet(state, target)),
        effective: ascending(crate::commands::nav::collect_hidden_rows_for_sheet(state, target)),
    })
}

/// Which COLUMNS are hidden on `sheet_index` (see `get_hidden_rows_info`).
/// There are no column filters, so `effective` here is user OR outline.
#[tauri::command]
pub fn get_hidden_cols_info(
    state: State<AppState>,
    sheet_index: Option<usize>,
) -> Result<crate::api_types::HiddenLinesInfo, String> {
    hidden_cols_info_inner(&state, sheet_index)
}

/// State-only body of `get_hidden_cols_info` (unit-testable without a State).
pub(crate) fn hidden_cols_info_inner(
    state: &AppState,
    sheet_index: Option<usize>,
) -> Result<crate::api_types::HiddenLinesInfo, String> {
    let target = resolve_sheet(state, sheet_index, "getHiddenColumns")?;
    Ok(crate::api_types::HiddenLinesInfo {
        user: ascending(user_hidden_cols_for_sheet(state, target)),
        effective: ascending(crate::commands::nav::collect_hidden_cols_for_sheet(state, target)),
    })
}
