//! FILENAME: app/src-tauri/src/commands/dimensions.rs
// PURPOSE: Managing row heights and column widths.

use crate::api_types::{DefaultDimensions, DimensionData};
use crate::document_effect::{CleanReason, DocumentEffect, Persisted};
use crate::persistence::FileState;
use crate::AppState;
use std::collections::HashMap;
use tauri::State;

/// Set a column width.
#[tauri::command]
pub fn set_column_width(state: State<AppState>, file_state: State<FileState>, col: u32, width: f64) -> Result<(), String> {
    // allowFormatColumns option gate. Returns Result (it used to return unit) so
    // a refusal can reach the user instead of the resize silently not happening.
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        crate::protection::check_sheet_action(&state, active_sheet, "formatColumns", "resize columns")?;
    }
    // The protection gate above is the only thing that can still refuse, so the
    // effect is minted here: constructing it dirties the workbook immediately.
    let effect = DocumentEffect::mutates(&file_state);
    // The sheet this resize is being recorded ON. `column_widths` is the ACTIVE
    // sheet's mirror, so the change is only meaningful against that sheet — and
    // the user can be looking at a different one by the time they undo.
    let recorded_on = *state.active_sheet.read().unwrap();
    let mut widths = state.column_widths.write(&effect).unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Record previous state for undo
    let previous_width = widths.get(&col).copied();

    if width > 0.0 {
        widths.insert(col, width);
    } else {
        widths.remove(&col);
    }

    // Record undo
    undo_stack.record_column_width_change(recorded_on, col, previous_width);

    Ok(())
}

/// Get a column width.
#[tauri::command]
pub fn get_column_width(state: State<AppState>, col: u32) -> Option<f64> {
    let widths = state.column_widths.read().unwrap();
    widths.get(&col).copied()
}

/// Get all column widths.
#[tauri::command]
pub fn get_all_column_widths(state: State<AppState>) -> Vec<DimensionData> {
    let widths = state.column_widths.read().unwrap();
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
        let active_sheet = *state.active_sheet.read().unwrap();
        crate::protection::check_sheet_action(&state, active_sheet, "formatRows", "resize rows")?;
    }
    let effect = DocumentEffect::mutates(&file_state);
    // See `set_column_width`: the sheet this resize belongs to.
    let recorded_on = *state.active_sheet.read().unwrap();
    let mut heights = state.row_heights.write(&effect).unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Record previous state for undo
    let previous_height = heights.get(&row).copied();

    if height > 0.0 {
        heights.insert(row, height);
    } else {
        heights.remove(&row);
    }

    // Record undo
    undo_stack.record_row_height_change(recorded_on, row, previous_height);

    Ok(())
}

/// Get a row height.
#[tauri::command]
pub fn get_row_height(state: State<AppState>, row: u32) -> Option<f64> {
    let heights = state.row_heights.read().unwrap();
    heights.get(&row).copied()
}

/// Get all row heights.
#[tauri::command]
pub fn get_all_row_heights(state: State<AppState>) -> Vec<DimensionData> {
    let heights = state.row_heights.read().unwrap();
    heights
        .iter()
        .map(|(&index, &size)| DimensionData { index, size, dimension_type: "row".to_string() })
        .collect()
}

/// Get the default row height and column width.
#[tauri::command]
pub fn get_default_dimensions(state: State<AppState>) -> DefaultDimensions {
    let row_h = *state.default_row_height.read().unwrap();
    let col_w = *state.default_column_width.read().unwrap();
    DefaultDimensions {
        default_row_height: row_h,
        default_column_width: col_w,
    }
}

/// Set the default row height.
///
/// GATED like `set_row_height` (the sheet's "Format rows" protection option):
/// the default height resizes every row without a height of its own, so a
/// protected sheet that refuses one row's resize must refuse this too.
#[tauri::command]
pub fn set_default_row_height(state: State<AppState>, file_state: State<FileState>, height: f64) -> Result<DefaultDimensions, String> {
    set_default_row_height_inner(&state, &file_state, height)
}

/// State-only body of `set_default_row_height` (unit-testable without a State).
pub(crate) fn set_default_row_height_inner(state: &AppState, file_state: &FileState, height: f64) -> Result<DefaultDimensions, String> {
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        crate::protection::check_sheet_action(state, active_sheet, "formatRows", "change the standard row height")?;
    }
    let clamped = if height < 1.0 { 1.0 } else { height };
    // After the gate: a refusal must not leave a spuriously dirty document.
    let effect = DocumentEffect::mutates(file_state);
    let mut h = state.default_row_height.write(&effect).unwrap();
    let previous = *h;
    *h = clamped;
    drop(h);

    // Record undo
    let data = serde_json::to_vec(&previous).unwrap_or_default();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.record_custom_restore("default_row_height".to_string(), data, "Change default row height");
    drop(undo_stack);

    let col_w = *state.default_column_width.read().unwrap();
    Ok(DefaultDimensions {
        default_row_height: clamped,
        default_column_width: col_w,
    })
}

/// Set the default column width (Excel's Format > Default Width...).
///
/// GATED like `set_column_width` (the sheet's "Format columns" protection
/// option). It was not: on a sheet protected without that option a single
/// column could not be resized, yet Default Width resized every column without
/// a width of its own (shell-sheets lane report, "Not fixed" 1). The Home tab
/// also asks first, to refuse before its dialog opens; this is the authority.
#[tauri::command]
pub fn set_default_column_width(state: State<AppState>, file_state: State<FileState>, width: f64) -> Result<DefaultDimensions, String> {
    set_default_column_width_inner(&state, &file_state, width)
}

/// State-only body of `set_default_column_width` (unit-testable without a State).
pub(crate) fn set_default_column_width_inner(state: &AppState, file_state: &FileState, width: f64) -> Result<DefaultDimensions, String> {
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        crate::protection::check_sheet_action(state, active_sheet, "formatColumns", "change the standard column width")?;
    }
    let clamped = if width < 1.0 { 1.0 } else { width };
    // After the gate: a refusal must not leave a spuriously dirty document.
    let effect = DocumentEffect::mutates(file_state);
    let mut w = state.default_column_width.write(&effect).unwrap();
    let previous = *w;
    *w = clamped;
    drop(w);

    // Record undo
    let data = serde_json::to_vec(&previous).unwrap_or_default();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.record_custom_restore("default_column_width".to_string(), data, "Change default column width");
    drop(undo_stack);

    let row_h = *state.default_row_height.read().unwrap();
    Ok(DefaultDimensions {
        default_row_height: row_h,
        default_column_width: clamped,
    })
}

// ============================================================================
// Batch resize: Row Height / Column Width over a whole selection span
// ============================================================================
//
// WHY A BATCH. Excel's Row Height... and Column Width... set every row (column)
// the selection spans, and "Select All, then Row Height" is how a user gives a
// whole sheet one height. `set_row_height` is one line per call and one undo
// entry per call; the Home tab looped it, which is 1,048,576 IPC round trips
// for Select All -- the reason it refused anything over 16,384 lines.
//
// THE SHAPE. The lines arrive as inclusive RUNS (`[[0, 1048575]]` for Select
// All, not a million indices), and the change is ONE undo entry of a compact
// kind: the previous sizes of those runs, run-length encoded (`segments`), so
// undoing Select All + Row Height stores a handful of segments, not a million
// `SetRowHeight` changes (a `CellChange` is hundreds of bytes: the enum is as
// big as its `GridSnapshot` variant). The work here is linear in the lines
// changed. A size equal to the current one changes nothing, records nothing
// and leaves the document clean.
//
// WHAT IS STILL PER LINE. The sheet stores one explicit size per line, and
// that map is what every structural undo snapshot, every dimension refresh and
// the grid's scroll arithmetic carry. Giving 1,048,576 rows an explicit height
// is therefore expensive AFTER this command, not in it; Excel's own answer --
// a per-sheet default row height -- needs a persisted per-sheet field this
// lane does not own (see the rust-followup report). The Home tab's own span
// rule decides what it sends.

/// The undo restore kind of a batch resize.
pub(crate) const LINE_SIZES_RESTORE_KIND: &str = "line_sizes";

/// One sheet's line sizes over some runs, before a batch resize (or, as the
/// inverse, after it).
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
pub(crate) struct LineSizesSnapshot {
    pub sheet_index: usize,
    /// Rows (`true`) or columns (`false`).
    pub rows: bool,
    /// `(first, last, size)`: every line `first..=last` had `size`; `None` = no
    /// size of its own (the default). Ascending, non-overlapping, and covering
    /// exactly the runs the resize touched.
    pub segments: Vec<(u32, u32, Option<f64>)>,
}

/// Sort and merge `runs` (overlapping and adjacent runs join) after checking
/// each lies on the sheet. Either end may come first.
pub(crate) fn normalize_line_runs(runs: &[(u32, u32)], last_line: u32) -> Result<Vec<(u32, u32)>, String> {
    let mut sorted: Vec<(u32, u32)> = Vec::with_capacity(runs.len());
    for &(a, b) in runs {
        let (lo, hi) = (a.min(b), a.max(b));
        if hi > last_line {
            return Err(format!("Line {} is past the end of the sheet (the last is {}).", hi + 1, last_line + 1));
        }
        sorted.push((lo, hi));
    }
    sorted.sort_unstable();
    let mut merged: Vec<(u32, u32)> = Vec::with_capacity(sorted.len());
    for (lo, hi) in sorted {
        match merged.last_mut() {
            Some(last) if lo as u64 <= last.1 as u64 + 1 => last.1 = last.1.max(hi),
            _ => merged.push((lo, hi)),
        }
    }
    Ok(merged)
}

/// The explicit sizes inside one run, ascending -- by walking whichever is
/// smaller, the run or the map.
fn explicit_sizes_in(sizes: &HashMap<u32, f64>, lo: u32, hi: u32) -> Vec<(u32, f64)> {
    let span = hi as u64 - lo as u64 + 1;
    let mut found: Vec<(u32, f64)> = if (sizes.len() as u64) < span {
        sizes.iter().filter(|(&k, _)| k >= lo && k <= hi).map(|(&k, &v)| (k, v)).collect()
    } else {
        (lo..=hi).filter_map(|k| sizes.get(&k).map(|&v| (k, v))).collect()
    };
    found.sort_unstable_by_key(|&(k, _)| k);
    found
}

/// The sizes of `runs`, run-length encoded (see `LineSizesSnapshot::segments`).
pub(crate) fn line_size_segments(sizes: &HashMap<u32, f64>, runs: &[(u32, u32)]) -> Vec<(u32, u32, Option<f64>)> {
    let mut out: Vec<(u32, u32, Option<f64>)> = Vec::new();
    let push = |first: u32, last: u32, size: Option<f64>, out: &mut Vec<(u32, u32, Option<f64>)>| {
        if let Some(prev) = out.last_mut() {
            if prev.2 == size && prev.1 as u64 + 1 == first as u64 {
                prev.1 = last;
                return;
            }
        }
        out.push((first, last, size));
    };
    for &(lo, hi) in runs {
        let mut next = lo as u64;
        for (line, size) in explicit_sizes_in(sizes, lo, hi) {
            if (line as u64) > next {
                push(next as u32, line - 1, None, &mut out);
            }
            push(line, line, Some(size), &mut out);
            next = line as u64 + 1;
        }
        if next <= hi as u64 {
            push(next as u32, hi, None, &mut out);
        }
    }
    out
}

/// Write `segments` into `sizes`: a `None` segment removes its lines' own
/// sizes, a `Some` one gives every line that size.
pub(crate) fn apply_line_size_segments(sizes: &mut HashMap<u32, f64>, segments: &[(u32, u32, Option<f64>)]) {
    for &(first, last, size) in segments {
        match size {
            Some(px) => {
                sizes.reserve((last as u64 - first as u64 + 1).min(1 << 21) as usize);
                for line in first..=last {
                    sizes.insert(line, px);
                }
            }
            None => {
                let span = last as u64 - first as u64 + 1;
                if (sizes.len() as u64) < span {
                    sizes.retain(|&k, _| k < first || k > last);
                } else {
                    for line in first..=last {
                        sizes.remove(&line);
                    }
                }
            }
        }
    }
}

/// Set every line of `runs` (rows when `rows`, else columns) on the ACTIVE
/// sheet to `size` px -- `size <= 0` removes their own sizes, as
/// `set_row_height` does -- in ONE undo step. Returns how many lines changed.
///
/// Gated by the sheet's "Format rows" / "Format columns" protection option,
/// exactly as the one-line commands are. A refusal, or a resize that changes
/// nothing, leaves the document clean.
pub(crate) fn set_line_sizes_inner(
    state: &AppState,
    file_state: &FileState,
    rows: bool,
    runs: &[(u32, u32)],
    size: f64,
) -> Result<u64, String> {
    if !size.is_finite() {
        return Err(format!("{} must be a number of pixels.", if rows { "A row height" } else { "A column width" }));
    }
    let last_line = if rows { engine::EXCEL_MAX_ROW_INDEX } else { engine::EXCEL_MAX_COL_INDEX };
    let runs = normalize_line_runs(runs, last_line)?;
    let active_sheet = *state.active_sheet.read().unwrap();
    crate::protection::check_sheet_action(
        state,
        active_sheet,
        if rows { "formatRows" } else { "formatColumns" },
        if rows { "resize rows" } else { "resize columns" },
    )?;
    let target = if size > 0.0 { Some(size) } else { None };

    let store = if rows { &state.row_heights } else { &state.column_widths };
    let sizes = store.lock_pending().unwrap();
    let previous = line_size_segments(&sizes, &runs);
    let changed: u64 = previous
        .iter()
        .filter(|&&(_, _, was)| was != target)
        .map(|&(first, last, _)| last as u64 - first as u64 + 1)
        .sum();
    if changed == 0 {
        return Ok(0);
    }
    // Past every gate, and something changes: committed.
    let effect = DocumentEffect::mutates(file_state);
    let mut sizes = sizes.authorize(&effect);
    let next: Vec<(u32, u32, Option<f64>)> = runs.iter().map(|&(lo, hi)| (lo, hi, target)).collect();
    apply_line_size_segments(&mut sizes, &next);
    drop(sizes);

    let label = if rows { "Row Height" } else { "Column Width" };
    let snapshot = LineSizesSnapshot { sheet_index: active_sheet, rows, segments: previous };
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let owned = undo_stack.begin_owned_transaction(label.to_string());
    undo_stack.record_custom_restore(
        LINE_SIZES_RESTORE_KIND.to_string(),
        serde_json::to_vec(&snapshot).unwrap_or_default(),
        label,
    );
    undo_stack.commit_owned(owned);
    Ok(changed)
}

/// Excel's Row Height... over every row of `rows` (inclusive runs, e.g.
/// `[[0, 1048575]]` for Select All), ONE undo step. See the section comment.
///
/// With a `target` (P3 2.4) the rows are a FLOATING GRID's: the object's own
/// row-height map changes (`cell_target::set_line_sizes_on_target`), never
/// the backing sheet's, gated by the host's Format Rows option.
#[tauri::command]
pub fn set_row_heights(
    state: State<AppState>,
    file_state: State<FileState>,
    rows: Vec<(u32, u32)>,
    height: f64,
    target: Option<crate::api_types::CellTargetRef>,
) -> Result<(), String> {
    if let Some(target) = &target {
        return crate::cell_target::set_line_sizes_on_target(&state, &file_state, target, true, &rows, height);
    }
    set_line_sizes_inner(&state, &file_state, true, &rows, height).map(|_| ())
}

/// Excel's Column Width... over every column of `cols` (inclusive runs), ONE
/// undo step. With a `target`, a floating grid's own column-width map (see
/// `set_row_heights`), gated by the host's Format Columns option.
#[tauri::command]
pub fn set_column_widths(
    state: State<AppState>,
    file_state: State<FileState>,
    cols: Vec<(u32, u32)>,
    width: f64,
    target: Option<crate::api_types::CellTargetRef>,
) -> Result<(), String> {
    if let Some(target) = &target {
        return crate::cell_target::set_line_sizes_on_target(&state, &file_state, target, false, &cols, width);
    }
    set_line_sizes_inner(&state, &file_state, false, &cols, width).map(|_| ())
}

/// Undo / redo of a batch resize: put the recorded sizes back on the sheet
/// they were recorded on (the active mirror, or that sheet's per-sheet store
/// when the user has since switched), recording the CURRENT sizes of the same
/// lines as the symmetric inverse.
///
/// DEFERRED in the restore registry: `apply_changes` holds the width and
/// height mirrors through its inline pass, and std's locks are not reentrant
/// (the pivot column-width restore paid for that once).
pub(crate) fn apply_line_sizes_restore(
    state: &AppState,
    effect: &DocumentEffect,
    data: &[u8],
    inverse_transaction: &mut engine::Transaction,
) {
    let snap: LineSizesSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            crate::log_error!("UNDO", "bad line-size snapshot: {}", e);
            return;
        }
    };
    let runs: Vec<(u32, u32)> = snap.segments.iter().map(|&(a, b, _)| (a, b)).collect();
    let active = state.active_sheet.read().map(|a| *a).unwrap_or(0);
    let swap = |sizes: &mut HashMap<u32, f64>| -> Vec<(u32, u32, Option<f64>)> {
        let current = line_size_segments(sizes, &runs);
        apply_line_size_segments(sizes, &snap.segments);
        current
    };
    let inverse = if snap.sheet_index == active {
        let store = if snap.rows { &state.row_heights } else { &state.column_widths };
        let Ok(mut sizes) = store.write(effect) else { return };
        swap(&mut *sizes)
    } else {
        let store = if snap.rows { &state.all_row_heights } else { &state.all_column_widths };
        let Ok(mut all) = store.write(effect) else { return };
        let Some(sizes) = all.get_mut(snap.sheet_index) else { return };
        swap(sizes)
    };
    let inverse_snap = LineSizesSnapshot { sheet_index: snap.sheet_index, rows: snap.rows, segments: inverse };
    inverse_transaction.add_change(engine::CellChange::CustomRestore {
        kind: LINE_SIZES_RESTORE_KIND.to_string(),
        data: serde_json::to_vec(&inverse_snap).unwrap_or_default(),
    });
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
///
/// Takes the caller's `DocumentEffect` rather than minting one: growing the
/// vector is bookkeeping that rides whatever operation needed the slot, and a
/// helper that minted its own `deliberately_clean` here would be an opt-out
/// nobody had to argue for.
pub(crate) fn ensure_user_hidden_len(state: &AppState, effect: &DocumentEffect, len: usize) {
    if let Ok(mut rows) = state.all_user_hidden_rows.write(effect) {
        while rows.len() < len {
            rows.push(HashSet::new());
        }
    }
    if let Ok(mut cols) = state.all_user_hidden_cols.write(effect) {
        while cols.len() < len {
            cols.push(HashSet::new());
        }
    }
}

/// Move the ACTIVE sheet's user-hidden sets into per-sheet slot `index`
/// (leaving the active mirror empty). Call before switching away from `index`.
///
/// NAVIGATION, not a document change: this moves a value between the active
/// mirror and its per-sheet slot, and `build_workbook_for_save` reads whichever
/// of the two is authoritative for the sheet it is writing. The bytes a save
/// produces are identical before and after, so the effect is minted here rather
/// than demanded from the caller — a sheet switch must not raise the asterisk.
pub(crate) fn stash_active_user_hidden(state: &AppState, index: usize) {
    let effect = DocumentEffect::deliberately_clean(CleanReason::Navigation);
    ensure_user_hidden_len(state, &effect, index + 1);
    if let (Ok(mut all), Ok(mut active)) = (
        state.all_user_hidden_rows.write(&effect),
        state.user_hidden_rows.write(&effect),
    ) {
        all[index] = std::mem::take(&mut *active);
    }
    if let (Ok(mut all), Ok(mut active)) = (
        state.all_user_hidden_cols.write(&effect),
        state.user_hidden_cols.write(&effect),
    ) {
        all[index] = std::mem::take(&mut *active);
    }
}

/// Move per-sheet slot `index` into the ACTIVE mirror. Call after switching to
/// `index`. Navigation, for the reason `stash_active_user_hidden` gives.
pub(crate) fn load_active_user_hidden(state: &AppState, index: usize) {
    let effect = DocumentEffect::deliberately_clean(CleanReason::Navigation);
    ensure_user_hidden_len(state, &effect, index + 1);
    if let (Ok(mut all), Ok(mut active)) = (
        state.all_user_hidden_rows.write(&effect),
        state.user_hidden_rows.write(&effect),
    ) {
        *active = std::mem::take(&mut all[index]);
    }
    if let (Ok(mut all), Ok(mut active)) = (
        state.all_user_hidden_cols.write(&effect),
        state.user_hidden_cols.write(&effect),
    ) {
        *active = std::mem::take(&mut all[index]);
    }
}

/// Append an empty per-sheet slot (a brand-new sheet hides nothing).
///
/// The four structural helpers below take the caller's effect: adding,
/// deleting, duplicating and reordering a sheet all change what a save writes,
/// but WHICH of `mutates` / `LoadingFromDisk` applies is the calling command's
/// decision (a load rebuilds the whole vector and must stay clean).
pub(crate) fn push_user_hidden_sheet(state: &AppState, effect: &DocumentEffect) {
    if let Ok(mut rows) = state.all_user_hidden_rows.write(effect) {
        rows.push(HashSet::new());
    }
    if let Ok(mut cols) = state.all_user_hidden_cols.write(effect) {
        cols.push(HashSet::new());
    }
}

/// Insert a per-sheet slot at `at`, cloned from `source` (sheet duplicate).
pub(crate) fn duplicate_user_hidden_sheet(
    state: &AppState,
    effect: &DocumentEffect,
    source: usize,
    at: usize,
) {
    ensure_user_hidden_len(state, effect, source.max(at) + 1);
    if let Ok(mut rows) = state.all_user_hidden_rows.write(effect) {
        let cloned = rows[source].clone();
        let at = at.min(rows.len());
        rows.insert(at, cloned);
    }
    if let Ok(mut cols) = state.all_user_hidden_cols.write(effect) {
        let cloned = cols[source].clone();
        let at = at.min(cols.len());
        cols.insert(at, cloned);
    }
}

/// Drop the per-sheet slot for a deleted sheet.
pub(crate) fn remove_user_hidden_sheet(state: &AppState, effect: &DocumentEffect, index: usize) {
    if let Ok(mut rows) = state.all_user_hidden_rows.write(effect) {
        if index < rows.len() {
            rows.remove(index);
        }
    }
    if let Ok(mut cols) = state.all_user_hidden_cols.write(effect) {
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
pub(crate) fn rotate_user_hidden_sheet(
    state: &AppState,
    effect: &DocumentEffect,
    from: usize,
    to: usize,
    count: usize,
) {
    ensure_user_hidden_len(state, effect, count);
    if let Ok(mut rows) = state.all_user_hidden_rows.write(effect) {
        rotate_slot(&mut rows, from, to);
    }
    if let Ok(mut cols) = state.all_user_hidden_cols.write(effect) {
        rotate_slot(&mut cols, from, to);
    }
}

/// The user-hidden rows for ANY sheet, active or not. The active sheet's set
/// lives in the mirror; every other sheet's in the per-sheet vector.
pub(crate) fn user_hidden_rows_for_sheet(state: &AppState, sheet_index: usize) -> HashSet<u32> {
    let active = state.active_sheet.read().map(|a| *a).unwrap_or(0);
    if sheet_index == active {
        state.user_hidden_rows.read().map(|s| s.clone()).unwrap_or_default()
    } else {
        state
            .all_user_hidden_rows
            .read()
            .ok()
            .and_then(|v| v.get(sheet_index).cloned())
            .unwrap_or_default()
    }
}

/// The user-hidden columns for ANY sheet (see `user_hidden_rows_for_sheet`).
pub(crate) fn user_hidden_cols_for_sheet(state: &AppState, sheet_index: usize) -> HashSet<u32> {
    let active = state.active_sheet.read().map(|a| *a).unwrap_or(0);
    if sheet_index == active {
        state.user_hidden_cols.read().map(|s| s.clone()).unwrap_or_default()
    } else {
        state
            .all_user_hidden_cols
            .read()
            .ok()
            .and_then(|v| v.get(sheet_index).cloned())
            .unwrap_or_default()
    }
}

/// Replace the user-hidden sets for ANY sheet, active or not (load paths).
pub(crate) fn set_user_hidden_for_sheet(
    state: &AppState,
    effect: &DocumentEffect,
    sheet_index: usize,
    rows: HashSet<u32>,
    cols: HashSet<u32>,
) {
    ensure_user_hidden_len(state, effect, sheet_index + 1);
    let active = state.active_sheet.read().map(|a| *a).unwrap_or(0);
    if let Ok(mut all) = state.all_user_hidden_rows.write(effect) {
        all[sheet_index] = rows.clone();
    }
    if let Ok(mut all) = state.all_user_hidden_cols.write(effect) {
        all[sheet_index] = cols.clone();
    }
    if sheet_index == active {
        if let Ok(mut mirror) = state.user_hidden_rows.write(effect) {
            *mirror = rows;
        }
        if let Ok(mut mirror) = state.user_hidden_cols.write(effect) {
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
    target: Option<crate::api_types::CellTargetRef>,
) -> Result<Vec<u32>, String> {
    // A floating grid's rows (P3 2.6): the OBJECT's hidden set, returned as
    // the result. No SUBTOTAL cascade -- the engine reads row visibility from
    // the sheets' user-hidden sets only (spec P3, Decision conflicts).
    if let Some(target) = &target {
        return crate::cell_target::set_lines_hidden_on_target(&state, &file_state, target, true, &rows, hidden);
    }
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
    let active_sheet = *state.active_sheet.read().unwrap();
    crate::protection::check_sheet_action(
        state,
        active_sheet,
        "formatRows",
        if hidden { "hide rows" } else { "unhide rows" },
    )?;

    // After the protection gate, before the mutation (see `set_column_width`).
    let effect = DocumentEffect::mutates(file_state);

    let previous: Vec<u32> = {
        let mut set = state.user_hidden_rows.write(&effect).unwrap();
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

    Ok(sorted_set(&state.user_hidden_rows))
}

/// Hide or unhide a set of COLUMNS on the active sheet (see `set_rows_hidden`).
#[tauri::command]
pub fn set_cols_hidden(
    state: State<AppState>,
    file_state: State<FileState>,
    cols: Vec<u32>,
    hidden: bool,
    target: Option<crate::api_types::CellTargetRef>,
) -> Result<Vec<u32>, String> {
    // A floating grid's columns: the OBJECT's hidden set (see `set_rows_hidden`).
    if let Some(target) = &target {
        return crate::cell_target::set_lines_hidden_on_target(&state, &file_state, target, false, &cols, hidden);
    }
    set_cols_hidden_inner(&state, &file_state, &cols, hidden)
}

/// State-only body of `set_cols_hidden` (unit-testable without a Tauri State).
pub(crate) fn set_cols_hidden_inner(
    state: &AppState,
    file_state: &FileState,
    cols: &[u32],
    hidden: bool,
) -> Result<Vec<u32>, String> {
    let active_sheet = *state.active_sheet.read().unwrap();
    crate::protection::check_sheet_action(
        state,
        active_sheet,
        "formatColumns",
        if hidden { "hide columns" } else { "unhide columns" },
    )?;

    let effect = DocumentEffect::mutates(file_state);

    let previous: Vec<u32> = {
        let mut set = state.user_hidden_cols.write(&effect).unwrap();
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

    Ok(sorted_set(&state.user_hidden_cols))
}

fn sorted_set(m: &Persisted<HashSet<u32>>) -> Vec<u32> {
    let set = m.read().unwrap();
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
    let active = *state.active_sheet.read().unwrap();
    let target = sheet_index.unwrap_or(active);
    let count = state.sheet_names.read().map(|n| n.len()).unwrap_or(0);
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

/// The batch resize commands and the standard-size protection gate, over a
/// real `AppState` (a CHILD so it can reach the state-only bodies).
#[cfg(test)]
#[path = "dimensions_batch_tests.rs"]
mod dimensions_batch_tests;
