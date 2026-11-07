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
    set_column_width_inner(&state, &file_state, col, width)
}

/// State-only body of `set_column_width` (unit-testable without a State).
///
/// LOCK ORDER: the width is written, and the mirror RELEASED, before the undo
/// stack is taken -- the two are never held together here. The cell writers
/// (`update_cell_impl` and its siblings, which the AI chat, the MCP server and
/// the notebook run off the main thread) hold `grid`, `grids` and the undo stack
/// and THEN read `column_widths` for every formula's evaluation context (and
/// write it for a computed property). This held `column_widths` while it waited
/// for the stack, with no grid lock to order it against them, so a resize
/// meeting such a write froze the window with no panic and no log. The batch
/// resize (`set_line_sizes_inner`) and the hide commands have always released
/// first.
///
/// ONE CRITICAL SECTION, held by `grid`. Releasing the mirror before the stack
/// made the record no longer atomic with the write (rev8B, round 9): two
/// resizes of the same line on different threads (the user plus an AI, MCP or
/// notebook writer) could interleave write, write, record, record, and the
/// undo history then held the steps in swapped order -- the first Ctrl+Z put
/// back the ORIGINAL size, the second the intermediate one. The resize now
/// holds `grid` (the canonical first lock, which every cell writer and
/// `apply_changes` also take first) from the gate through the record, so a
/// second resize, a cell writer or an undo waits for the whole step. Holding
/// `grid` is the cell writers' own order (grid, then the stack), so it adds no
/// edge; the mirror is still released before the stack.
pub(crate) fn set_column_width_inner(state: &AppState, file_state: &FileState, col: u32, width: f64) -> Result<(), String> {
    // Serializes the whole step (see ONE CRITICAL SECTION). Read-only: the
    // grid is not written, only held.
    let _step = state.grid.read().unwrap();
    // allowFormatColumns option gate. Returns Result (it used to return unit) so
    // a refusal can reach the user instead of the resize silently not happening.
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        crate::protection::check_sheet_action(state, active_sheet, "formatColumns", "resize columns")?;
    }
    // The protection gate above is the only thing that can still refuse, so the
    // effect is minted here: constructing it dirties the workbook immediately.
    let effect = DocumentEffect::mutates(file_state);
    // The sheet this resize is being recorded ON. `column_widths` is the ACTIVE
    // sheet's mirror, so the change is only meaningful against that sheet — and
    // the user can be looking at a different one by the time they undo.
    let recorded_on = *state.active_sheet.read().unwrap();
    // The previous width (for undo), read and replaced under ONE hold.
    let previous_width = {
        let mut widths = state.column_widths.write(&effect).unwrap();
        let previous = widths.get(&col).copied();
        if width > 0.0 {
            widths.insert(col, width);
        } else {
            widths.remove(&col);
        }
        previous
    };

    // Record undo -- the mirror is released (see the LOCK ORDER note above).
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.record_column_width_change(recorded_on, col, previous_width);
    }

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
    set_row_height_inner(&state, &file_state, row, height)
}

/// State-only body of `set_row_height` (unit-testable without a State). The
/// mirror is released before the undo stack is taken, exactly as in
/// `set_column_width_inner` (see its LOCK ORDER note): the cell writers hold the
/// stack while they read `row_heights`. `grid` is held from the gate through
/// the record (see its ONE CRITICAL SECTION note).
pub(crate) fn set_row_height_inner(state: &AppState, file_state: &FileState, row: u32, height: f64) -> Result<(), String> {
    let _step = state.grid.read().unwrap();
    // allowFormatRows option gate; see set_column_width for the Result change.
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        crate::protection::check_sheet_action(state, active_sheet, "formatRows", "resize rows")?;
    }
    let effect = DocumentEffect::mutates(file_state);
    // See `set_column_width`: the sheet this resize belongs to.
    let recorded_on = *state.active_sheet.read().unwrap();
    // The previous height (for undo), read and replaced under ONE hold.
    let previous_height = {
        let mut heights = state.row_heights.write(&effect).unwrap();
        let previous = heights.get(&row).copied();
        if height > 0.0 {
            heights.insert(row, height);
        } else {
            heights.remove(&row);
        }
        previous
    };

    // Record undo -- the mirror is released.
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.record_row_height_change(recorded_on, row, previous_height);
    }

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

// ============================================================================
// The sheet's STANDARD row height / column width
// ============================================================================
//
// PER SHEET, as in Excel (live Excel 16, 2026-10-30): Format > Default Width
// on Sheet2 leaves Sheet1's standard alone, Select All + Row Height sets the
// sheet's `<sheetFormatPr defaultRowHeight customHeight="1">` and no per-row
// heights, and a new sheet starts at the application standard. The value lives
// on the sheet's `engine::Grid` (`default_row_height` / `default_column_width`;
// `None` = the application standard), so the `grid` mirror is the active
// sheet's and `grids[i]` every sheet's -- a sheet's add, delete, move, copy
// and structural undo carry it with no parallel per-sheet vector. It was ONE
// workbook-wide AppState value (BUG-0352).

/// The undo restore kind of a change to a sheet's standard size.
pub(crate) const SHEET_DEFAULT_SIZE_RESTORE_KIND: &str = "sheet_default_size";

/// One sheet's standard row height (`rows`) or column width before a change
/// (or, as the inverse, after it). `size: None` = the application standard.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
pub(crate) struct SheetDefaultSizeSnapshot {
    pub sheet_index: usize,
    pub rows: bool,
    pub size: Option<f64>,
}

/// A sheet's effective standard sizes: its own, else the application's.
pub(crate) fn sheet_default_dimensions(grid: &engine::Grid) -> DefaultDimensions {
    DefaultDimensions {
        default_row_height: grid.default_row_height.unwrap_or(::persistence::DEFAULT_ROW_HEIGHT_PX),
        default_column_width: grid.default_column_width.unwrap_or(::persistence::DEFAULT_COLUMN_WIDTH_PX),
    }
}

/// The application standard for an axis.
fn application_standard(rows: bool) -> f64 {
    if rows {
        ::persistence::DEFAULT_ROW_HEIGHT_PX
    } else {
        ::persistence::DEFAULT_COLUMN_WIDTH_PX
    }
}

/// A requested standard size as the sheet stores it: clamped to at least 1px,
/// and `None` when it IS the application standard (so an ordinary sheet keeps
/// writing the bytes it always did). `px <= 0` resets to the standard.
fn stored_standard(rows: bool, px: f64) -> Option<f64> {
    if px <= 0.0 {
        return None;
    }
    let clamped = px.max(1.0);
    if (clamped - application_standard(rows)).abs() < 1e-9 {
        None
    } else {
        Some(clamped)
    }
}

fn axis_standard(grid: &engine::Grid, rows: bool) -> Option<f64> {
    if rows {
        grid.default_row_height
    } else {
        grid.default_column_width
    }
}

fn set_axis_standard(grid: &mut engine::Grid, rows: bool, size: Option<f64>) {
    if rows {
        grid.default_row_height = size;
    } else {
        grid.default_column_width = size;
    }
}

/// Write sheet `index`'s standard size into BOTH copies that can hold it: the
/// `grid` mirror when `index` is the active sheet, and `grids[index]`.
fn write_sheet_standard(
    grid: &mut engine::Grid,
    grids: &mut [engine::Grid],
    active: usize,
    index: usize,
    rows: bool,
    size: Option<f64>,
) {
    if index == active {
        set_axis_standard(grid, rows, size);
    }
    if let Some(sheet) = grids.get_mut(index) {
        set_axis_standard(sheet, rows, size);
    }
}

/// Get the ACTIVE sheet's standard row height and column width.
#[tauri::command]
pub fn get_default_dimensions(state: State<AppState>) -> DefaultDimensions {
    let grid = state.grid.read().unwrap();
    sheet_default_dimensions(&grid)
}

/// Set the active sheet's standard row height.
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
    set_sheet_standard_inner(state, file_state, true, height)
}

/// Set the active sheet's standard column width (Excel's Format > Default
/// Width...).
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
    set_sheet_standard_inner(state, file_state, false, width)
}

/// The active sheet's standard size on one axis, in ONE critical section: the
/// gate, the write and the undo record all happen holding `grid` and `grids`
/// (the canonical first two locks, the cell writers' own order before the
/// stack), so no concurrent writer can slip between the write and its record.
/// A size equal to the current one changes nothing and stays clean.
fn set_sheet_standard_inner(state: &AppState, file_state: &FileState, rows: bool, px: f64) -> Result<DefaultDimensions, String> {
    if !px.is_finite() {
        return Err(format!(
            "{} must be a number of pixels.",
            if rows { "The standard row height" } else { "The standard column width" }
        ));
    }
    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let active = *state.active_sheet.read().unwrap();
    crate::protection::check_sheet_action(
        state,
        active,
        if rows { "formatRows" } else { "formatColumns" },
        if rows { "change the standard row height" } else { "change the standard column width" },
    )?;
    let previous = axis_standard(&grid, rows);
    let target = stored_standard(rows, px);
    if previous == target {
        return Ok(sheet_default_dimensions(&grid));
    }
    // After the gate, and something changes: a refusal never dirties.
    let effect = DocumentEffect::mutates(file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    write_sheet_standard(&mut grid, &mut grids, active, active, rows, target);
    let dims = sheet_default_dimensions(&grid);

    let snapshot = SheetDefaultSizeSnapshot { sheet_index: active, rows, size: previous };
    let label = if rows { "Change default row height" } else { "Change default column width" };
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.record_custom_restore(
        SHEET_DEFAULT_SIZE_RESTORE_KIND.to_string(),
        serde_json::to_vec(&snapshot).unwrap_or_default(),
        label,
    );
    Ok(dims)
}

/// Undo / redo of a sheet's standard size: put the recorded size back on the
/// sheet it was recorded on, recording the current one as the inverse.
///
/// DEFERRED in the restore registry: it takes `grid` and `grids`, which
/// `apply_changes` holds through its inline pass.
pub(crate) fn apply_sheet_default_size_restore(
    state: &AppState,
    effect: &DocumentEffect,
    data: &[u8],
    inverse_transaction: &mut engine::Transaction,
) {
    let snap: SheetDefaultSizeSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            crate::log_error!("UNDO", "bad sheet standard-size snapshot: {}", e);
            return;
        }
    };
    let Ok(mut grid) = state.grid.write(effect) else { return };
    let Ok(mut grids) = state.grids.write(effect) else { return };
    let active = state.active_sheet.read().map(|a| *a).unwrap_or(0);
    let current = if snap.sheet_index == active {
        axis_standard(&grid, snap.rows)
    } else {
        match grids.get(snap.sheet_index) {
            Some(sheet) => axis_standard(sheet, snap.rows),
            None => return,
        }
    };
    write_sheet_standard(&mut grid, &mut grids, active, snap.sheet_index, snap.rows, snap.size);
    let inverse = SheetDefaultSizeSnapshot { sheet_index: snap.sheet_index, rows: snap.rows, size: current };
    inverse_transaction.add_change(engine::CellChange::CustomRestore {
        kind: SHEET_DEFAULT_SIZE_RESTORE_KIND.to_string(),
        data: serde_json::to_vec(&inverse).unwrap_or_default(),
    });
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
// SELECT ALL IS THE SHEET'S STANDARD SIZE. The sheet stores one explicit size
// per line, and that map is what every structural undo snapshot, every
// dimension refresh and the grid's scroll arithmetic carry, so 1,048,576
// explicit heights would be expensive AFTER this command. Excel never writes
// them: Select All + Row Height 30 sets the sheet's
// `<sheetFormatPr defaultRowHeight="30" customHeight="1">` and every row --
// including one that had an explicit 50 -- shows 30 (live Excel 16,
// 2026-10-30; Select All + Column Width likewise sets `defaultColWidth` and
// drops every column's own width). A run over the WHOLE axis therefore sets
// the sheet's standard size and clears the lines' own sizes, in the same one
// undo step (BUG-0353). Any other span still sets the lines themselves; the
// Home tab's span rule bounds what it sends.

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
/// One run over the WHOLE axis (Select All) sets the sheet's standard size
/// instead and drops every line's own size (see the section comment).
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
    set_line_sizes_core(state, file_state, rows, runs, size).map(|outcome| outcome.changed)
}

/// What a batch resize did.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LineSizesOutcome {
    /// Lines whose size or visibility changed.
    pub changed: u64,
    /// The resize SHOWED hidden lines (by hand or in a collapsed outline group;
    /// Excel's rule, below).
    pub unhid: bool,
    /// The resize expanded collapsed outline groups, so the outline the
    /// frontend caches is stale.
    pub outline_changed: bool,
    /// The resize showed rows the AutoFilter had filtered out (a resize of
    /// nothing but hidden rows under a filter), so the filter the frontend
    /// caches is stale.
    pub filter_changed: bool,
    /// The runs the size REACHED, ascending: every line of the request but
    /// the hidden rows filter mode passed over. What the macro recorder replays
    /// line by line, so a replay touches what the gesture touched.
    pub reached: Vec<(u32, u32)>,
}

/// Tell the frontend the outline changed (the backend-initiated
/// `mutation:refresh`, bridged into the same domain fan-out an undo uses).
fn announce_outline_changed(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app.emit(
        crate::object_deps::MUTATION_REFRESH_EVENT,
        crate::object_deps::MutationRefreshEvent { domains: vec!["outline".to_string()], source: "commit".to_string() },
    );
}

/// True when `line` lies in one of `runs` (sorted, merged -- `normalize_line_runs`).
/// A binary search: the callers ask it once per hidden line, and a filter can
/// hide most of a sheet while a discontiguous selection holds thousands of
/// runs (a linear scan made planning O(hidden x runs) -- rev14C, round 16).
fn in_runs(runs: &[(u32, u32)], line: u32) -> bool {
    let i = runs.partition_point(|&(lo, _)| {
        #[cfg(test)]
        IN_RUNS_COMPARISONS.with(|n| n.set(n.get() + 1));
        lo <= line
    });
    i > 0 && line <= runs[i - 1].1
}

#[cfg(test)]
thread_local! {
    /// How many run comparisons `in_runs` made on this thread: the WORK a
    /// planning test asserts, instead of a wall-clock time a loaded machine can
    /// push past any bound (round 18).
    pub(crate) static IN_RUNS_COMPARISONS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// [`set_line_sizes_inner`], reporting whether it unhid lines.
///
/// A height or width GIVEN to a hidden line shows it, as in Excel: [LIVE] Excel
/// 16, row 5 and column D hidden -- Select All + Row Height 30 and Select All +
/// Column Width 20 unhide both (the "select all, set the height, everything is
/// back" idiom), and so do Rows 3:7 + Row Height 30 and Columns C:E + Column
/// Width 20. Format > Default Width does NOT ([LIVE] a hidden column F stays
/// hidden), and neither does `size <= 0`, which here resets a line to the
/// standard rather than giving it a size. The unhide is part of the same undo
/// step, so one Ctrl+Z hides the lines again and puts their sizes back.
///
/// EACH KIND OF HIDDEN LINE, as live Excel 16 does it (2026-10-30, round 14):
///  - Hidden by hand: shown (above).
///  - Inside a COLLAPSED OUTLINE GROUP: shown too ([LIVE] rows 13:15 grouped
///    and collapsed, Rows(1:25).RowHeight = 30 shows all three; columns C:D
///    likewise for a width). Excel keeps one hidden flag per line, so a resize
///    that covers PART of a collapsed group shows only the lines it covers
///    ([LIVE] Rows(14).RowHeight = 30 shows row 14; 13 and 15 stay hidden and
///    the group reads as expanded, ShowDetail True). Calcula's outline hides
///    a group's lines by its `collapsed` flag, so the group is EXPANDED and the
///    lines it hid outside the runs are kept hidden by hand -- the same state
///    Excel ends in, in one undo step with the outline.
///  - ROWS under FILTER MODE (an AutoFilter with a criterion, or an advanced
///    filter in place -- Excel's `FilterMode`): when the runs hold at least one
///    visible row, the size goes to the VISIBLE rows only and no row is shown
///    ([LIVE] Rows(18:22).RowHeight = 30 with row 20 hidden by hand leaves it
///    hidden at its old height; Cells.RowHeight = 40 changes the standard but a
///    filtered-out row comes back at its OLD height when unfiltered -- so here
///    it keeps its size, pinned when the standard moves). When every row of the
///    runs is hidden, Excel resizes and shows them all ([LIVE] Rows(20:20) and
///    Rows(3:4) under a filter), and so does this: the hand- and outline-hidden
///    rows as above, and an AutoFilter's filtered-out rows leave its hidden
///    set (its criteria stay; the filter is held through the write and its
///    previous state is an `obj_autofilter` restore in the same undo step).
///    A row an ADVANCED filter in place hides is shown the same way ([LIVE]
///    Excel 16, 2026-11-06, misc6/probe.ps1: A1:A14 advanced-filtered to hide
///    row 4, Rows(4:4).RowHeight = 30 shows it, FilterMode stays True, and
///    Rows(3:5).RowHeight = 30 leaves it hidden); it leaves the filter's set,
///    whose previous state is an `obj_advanced_filter_hidden` restore in the
///    same step. A whole-row move writes its vacated hidden rows this way
///    (`lineMoveVacated.ts` `lineSizeWrites`), so Excel's move shows an
///    advanced-filtered row at its old place too ([LIVE] `Range("3:5").Cut
///    Range("A20")`: row 4 shown, row 21 hidden).
///    AutoFilter dropdowns with no criterion are not filter mode ([LIVE]).
///    Columns have no filter mode ([LIVE] Columns(A:H).ColumnWidth under a
///    filter still shows a hidden column).
pub(crate) fn set_line_sizes_core(
    state: &AppState,
    file_state: &FileState,
    rows: bool,
    runs: &[(u32, u32)],
    size: f64,
) -> Result<LineSizesOutcome, String> {
    if !size.is_finite() {
        return Err(format!("{} must be a number of pixels.", if rows { "A row height" } else { "A column width" }));
    }
    let last_line = if rows { engine::EXCEL_MAX_ROW_INDEX } else { engine::EXCEL_MAX_COL_INDEX };
    let runs = normalize_line_runs(runs, last_line)?;
    // ONE CRITICAL SECTION, from the gate through the undo record: `grid` and
    // `grids` first (the canonical order; the cell writers take them before
    // the stack too), so a concurrent resize, cell writer or undo waits for the
    // whole step and the steps are recorded in the order they were written
    // (rev8B, round 9). The mirror is still released before the stack.
    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    crate::protection::check_sheet_action(
        state,
        active_sheet,
        if rows { "formatRows" } else { "formatColumns" },
        if rows { "resize rows" } else { "resize columns" },
    )?;
    let target = if size > 0.0 { Some(size) } else { None };
    // Select All (one run over the whole axis) is the sheet's STANDARD size,
    // as in Excel: one value, every line's own size dropped -- never 1,048,576
    // explicit heights.
    let whole_axis = runs.len() == 1 && runs[0] == (0, last_line);

    // ONE CRITICAL SECTION for the decision and the write (rev12B, round 13:
    // the hidden set used to be COUNTED under a read that was released before
    // the write, so a concurrent Unhide in between could make a resize that
    // changed nothing dirty the document and record a no-op step). The size
    // store, then the user-hidden set, then the outline -- the save snapshot's
    // own order (`row_heights` before the user-hidden sets) -- all held from the
    // decision through the write and released before the undo stack.
    let store = if rows { &state.row_heights } else { &state.column_widths };
    let sizes = store.lock_pending().unwrap();
    let hidden_store = if rows { &state.user_hidden_rows } else { &state.user_hidden_cols };
    let hidden = hidden_store.lock_pending().unwrap();
    let outlines = state.outlines.lock_pending().unwrap();
    let outline_before: Option<crate::grouping::SheetOutline> = outlines.get(&active_sheet).cloned();
    // Filter mode (rows only; see above), decided under the same guards. The
    // AutoFilter is HELD through the write (after `outlines`): a resize of
    // nothing but hidden rows shows the rows it filtered out, as Excel does.
    let auto_filters = if rows { Some(state.auto_filters.lock_pending().unwrap()) } else { None };
    // The ADVANCED filter's hidden set, held through the write the same way
    // (after the AutoFilter): a resize of nothing but hidden rows shows the
    // rows it filtered out too ([LIVE] below).
    let advanced_filters = if rows { Some(state.advanced_filter_hidden_rows.lock_pending().unwrap()) } else { None };
    let (filter_mode, filter_hidden): (bool, HashSet<u32>) = if rows {
        let mut hidden: HashSet<u32> = HashSet::new();
        let mut mode = false;
        if let Some(af) = auto_filters.as_ref().and_then(|afs| afs.get(&active_sheet)) {
            mode |= af.enabled && af.is_data_filtered();
            hidden.extend(af.hidden_rows.iter().copied());
        }
        if let Some(adv) = advanced_filters.as_ref().and_then(|adv| adv.get(&active_sheet)) {
            mode = true;
            hidden.extend(adv.iter().copied());
        }
        (mode, hidden)
    } else {
        (false, HashSet::new())
    };

    let plan = plan_line_visibility(
        rows,
        &runs,
        size > 0.0,
        &hidden,
        outline_before.as_ref(),
        filter_mode,
        &filter_hidden,
    );
    // The AutoFilter's filtered-out rows of the runs the resize SHOWS (only
    // when every row of the runs is hidden; `plan.show_filtered`).
    let filter_unhide: Vec<u32> = match auto_filters.as_ref().and_then(|afs| afs.get(&active_sheet)) {
        Some(af) if plan.show_filtered => {
            let mut lines: Vec<u32> = af.hidden_rows.iter().copied().filter(|&l| in_runs(&runs, l)).collect();
            lines.sort_unstable();
            lines
        }
        _ => Vec::new(),
    };
    // ...and the ADVANCED filter's, a row both filters hide counted once.
    let advanced_unhide: Vec<u32> = match advanced_filters.as_ref().and_then(|adv| adv.get(&active_sheet)) {
        Some(adv) if plan.show_filtered => {
            let mut lines: Vec<u32> = adv.iter().copied().filter(|&l| in_runs(&runs, l)).collect();
            lines.sort_unstable();
            lines.dedup();
            lines
        }
        _ => Vec::new(),
    };
    let advanced_only = advanced_unhide.iter().filter(|l| filter_unhide.binary_search(l).is_err()).count() as u64;
    let unhides = plan.user_unhide.len() as u64 + plan.outline_shown + filter_unhide.len() as u64 + advanced_only;

    let previous = line_size_segments(&sizes, &runs);
    let previous_standard = axis_standard(&grid, rows);
    // The lines the size reaches: every line of the runs but the hidden ones
    // filter mode passes over.
    let sized_runs = runs_without(&runs, &plan.skip);
    let sized_previous = line_size_segments(&sizes, &sized_runs);
    let (changed, next_standard, pins) = if whole_axis {
        let next_standard = stored_standard(rows, size);
        let was_standard = previous_standard.unwrap_or_else(|| application_standard(rows));
        let now = next_standard.unwrap_or_else(|| application_standard(rows));
        let changed: u64 = sized_previous
            .iter()
            .filter(|&&(_, _, was)| (was.unwrap_or(was_standard) - now).abs() > 1e-9)
            .map(|&(first, last, _)| last as u64 - first as u64 + 1)
            .sum();
        // A line the size passes over keeps the size it HAD: one with no size
        // of its own followed the old standard, so it is pinned there when the
        // standard moves ([LIVE] a filtered-out row comes back at its old
        // height after Cells.RowHeight).
        let pins: Vec<u32> = if (was_standard - now).abs() > 1e-9 {
            plan.skip.iter().copied().filter(|l| !sizes.contains_key(l)).collect()
        } else {
            Vec::new()
        };
        // A line can look the same while its record changes (an own size equal
        // to the new standard): that is still a change to save and to undo.
        let record_changes = sized_previous.iter().any(|&(_, _, was)| was.is_some())
            || previous_standard != next_standard
            || !pins.is_empty();
        (if record_changes { changed.max(1) } else { 0 }, Some(next_standard), (pins, was_standard))
    } else {
        let changed: u64 = sized_previous
            .iter()
            .filter(|&&(_, _, was)| was != target)
            .map(|&(first, last, _)| last as u64 - first as u64 + 1)
            .sum();
        (changed, None, (Vec::new(), 0.0))
    };
    if changed == 0 && unhides == 0 {
        return Ok(LineSizesOutcome {
            changed: 0,
            unhid: false,
            outline_changed: false,
            filter_changed: false,
            reached: sized_runs,
        });
    }
    let changed = changed.max(unhides);
    // Past every gate, and something changes: committed.
    let effect = DocumentEffect::mutates(file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut sizes = sizes.authorize(&effect);
    let line_target = if whole_axis { None } else { target };
    let mut next: Vec<(u32, u32, Option<f64>)> = sized_runs.iter().map(|&(lo, hi)| (lo, hi, line_target)).collect();
    let (pins, pinned_size) = pins;
    next.extend(pins.iter().map(|&l| (l, l, Some(pinned_size))));
    apply_line_size_segments(&mut sizes, &next);
    drop(sizes);
    if let Some(standard) = next_standard {
        write_sheet_standard(&mut grid, &mut grids, active_sheet, active_sheet, rows, standard);
    }
    // Show the hidden lines the resize covers -- and keep hidden by hand the
    // lines an expanded group hid outside the runs. The set as it was is the
    // undo record (whole-set, like a hide's own).
    let mut hidden = hidden.authorize(&effect);
    let hidden_before: Option<Vec<u32>> = if !plan.user_unhide.is_empty() || !plan.keep_hidden.is_empty() {
        let mut before: Vec<u32> = hidden.iter().copied().collect();
        before.sort_unstable();
        for l in &plan.user_unhide {
            hidden.remove(l);
        }
        hidden.extend(plan.keep_hidden.iter().copied());
        Some(before)
    } else {
        None
    };
    drop(hidden);
    let outline_changed = match &plan.outline_next {
        Some(next_outline) => {
            outlines.authorize(&effect).insert(active_sheet, next_outline.clone());
            true
        }
        None => {
            drop(outlines);
            false
        }
    };
    // Show the filtered-out rows of a resize of nothing but hidden rows: they
    // leave the AutoFilter's hidden set (its criteria stay, as in Excel, where
    // Reapply hides them again). The filter as it was is the undo record.
    let filter_before: Option<crate::autofilter::AutoFilter> = match auto_filters {
        Some(afs) if !filter_unhide.is_empty() => {
            let mut afs = afs.authorize(&effect);
            match afs.get_mut(&active_sheet) {
                Some(af) => {
                    let before = af.clone();
                    for l in &filter_unhide {
                        af.hidden_rows.remove(l);
                    }
                    Some(before)
                }
                None => None,
            }
        }
        other => {
            drop(other);
            None
        }
    };
    // The same for the rows an ADVANCED filter hid: they leave its set (the
    // filter stays -- an empty set keeps the sheet in filter mode, as Excel's
    // FilterMode stays True). The set as it was is the undo record.
    let advanced_before: Option<Option<Vec<u32>>> = match advanced_filters {
        Some(adv) if !advanced_unhide.is_empty() => {
            let mut adv = adv.authorize(&effect);
            let before = adv.get(&active_sheet).cloned();
            if let Some(set) = adv.get_mut(&active_sheet) {
                set.retain(|l| advanced_unhide.binary_search(l).is_err());
            }
            Some(before)
        }
        other => {
            drop(other);
            None
        }
    };
    let filter_changed = filter_before.is_some() || advanced_before.is_some();

    let label = if rows { "Row Height" } else { "Column Width" };
    let snapshot = LineSizesSnapshot { sheet_index: active_sheet, rows, segments: previous };
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let owned = undo_stack.begin_owned_transaction(label.to_string());
    undo_stack.record_custom_restore(
        LINE_SIZES_RESTORE_KIND.to_string(),
        serde_json::to_vec(&snapshot).unwrap_or_default(),
        label,
    );
    if let Some(before) = &hidden_before {
        let (hidden_rows, hidden_cols) = if rows { (Some(before.clone()), None) } else { (None, Some(before.clone())) };
        undo_stack.record_custom_restore(
            crate::undo_commands::USER_HIDDEN_RESTORE_KIND.to_string(),
            crate::undo_commands::user_hidden_snapshot_bytes(active_sheet, hidden_rows, hidden_cols),
            label,
        );
    }
    if outline_changed {
        undo_stack.record_custom_restore(
            crate::undo_commands::OUTLINE_RESTORE_KIND.to_string(),
            crate::undo_commands::outline_snapshot_bytes(active_sheet, outline_before),
            label,
        );
    }
    if let Some(before) = filter_before {
        undo_stack.record_custom_restore(
            "obj_autofilter".to_string(),
            crate::undo_commands::autofilter_snapshot_bytes(active_sheet, Some(before)),
            label,
        );
    }
    if let Some(before) = advanced_before {
        undo_stack.record_custom_restore(
            crate::undo_commands::ADVANCED_FILTER_HIDDEN_RESTORE_KIND.to_string(),
            crate::undo_commands::advanced_filter_hidden_snapshot_bytes(active_sheet, before),
            label,
        );
    }
    if next_standard.is_some() && next_standard != Some(previous_standard) {
        let standard = SheetDefaultSizeSnapshot { sheet_index: active_sheet, rows, size: previous_standard };
        undo_stack.record_custom_restore(
            SHEET_DEFAULT_SIZE_RESTORE_KIND.to_string(),
            serde_json::to_vec(&standard).unwrap_or_default(),
            label,
        );
    }
    undo_stack.commit_owned(owned);
    Ok(LineSizesOutcome { changed, unhid: unhides > 0, outline_changed, filter_changed, reached: sized_runs })
}

/// What a batch resize does to the hidden lines of its runs (Excel's rules,
/// see [`set_line_sizes_core`]).
#[derive(Debug, Default)]
pub(crate) struct LineVisibilityPlan {
    /// Hidden lines inside the runs that the size does NOT reach (rows under
    /// filter mode when the runs hold a visible row). Ascending.
    pub skip: Vec<u32>,
    /// Hand-hidden lines inside the runs that the resize shows.
    pub user_unhide: Vec<u32>,
    /// The outline with every collapsed group that hid a line of the runs
    /// expanded; `None` when no group changes.
    pub outline_next: Option<crate::grouping::SheetOutline>,
    /// How many lines of the runs the expansion shows.
    pub outline_shown: u64,
    /// Lines an expanded group hid OUTSIDE the runs: they stay hidden, now by
    /// hand (Excel's per-line hidden flag; see the doc above). Like Excel's
    /// flag, the group's next expand or show-level shows them again
    /// (`grouping::show_hand_hidden_in_details`, rev14C, round 16).
    pub keep_hidden: Vec<u32>,
    /// Rows under FILTER MODE whose runs hold no visible row: the resize also
    /// shows the rows the AutoFilter filtered out (Excel [LIVE]).
    pub show_filtered: bool,
}

/// A group's span less its summary line meets one of `runs`.
fn group_hides_in_runs(lo: u32, hi: u32, summary: u32, runs: &[(u32, u32)]) -> bool {
    runs.iter().any(|&(a, b)| {
        let (from, to) = (lo.max(a), hi.min(b));
        from <= to && !(from == to && from == summary)
    })
}

/// Decide what a resize of `runs` does to their hidden lines. `gives_size` is
/// false for a reset (`size <= 0`), which shows nothing.
pub(crate) fn plan_line_visibility(
    rows: bool,
    runs: &[(u32, u32)],
    gives_size: bool,
    user_hidden: &HashSet<u32>,
    outline: Option<&crate::grouping::SheetOutline>,
    filter_mode: bool,
    filter_hidden: &HashSet<u32>,
) -> LineVisibilityPlan {
    let mut plan = LineVisibilityPlan::default();
    if !gives_size {
        return plan;
    }
    let outline_hidden: HashSet<u32> = match outline {
        Some(o) if rows => o.get_hidden_rows(),
        Some(o) => o.get_hidden_cols(),
        None => HashSet::new(),
    };
    if rows && filter_mode {
        let mut hidden_in_runs: Vec<u32> = user_hidden
            .iter()
            .chain(outline_hidden.iter())
            .chain(filter_hidden.iter())
            .copied()
            .filter(|&l| in_runs(runs, l))
            .collect();
        hidden_in_runs.sort_unstable();
        hidden_in_runs.dedup();
        let total: u64 = runs.iter().map(|&(lo, hi)| hi as u64 - lo as u64 + 1).sum();
        if (hidden_in_runs.len() as u64) < total {
            // A visible row in the runs: the size goes to the visible rows only.
            plan.skip = hidden_in_runs;
            return plan;
        }
        // Every row of the runs is hidden: they are all sized and SHOWN, the
        // rows the filter hid included.
        plan.show_filtered = true;
    }
    plan.user_unhide = user_hidden.iter().copied().filter(|&l| in_runs(runs, l)).collect();
    plan.user_unhide.sort_unstable();
    if let Some(o) = outline {
        if outline_hidden.iter().any(|&l| in_runs(runs, l)) {
            let mut next = o.clone();
            let below = |p: &crate::grouping::SummaryPosition| matches!(p, crate::grouping::SummaryPosition::BelowRight);
            if rows {
                let summary_below = below(&next.settings.summary_row_position);
                for g in next.row_groups.iter_mut().filter(|g| g.collapsed) {
                    let summary = if summary_below { g.end_row } else { g.start_row };
                    if group_hides_in_runs(g.start_row, g.end_row, summary, runs) {
                        g.collapsed = false;
                    }
                }
            } else {
                let summary_right = below(&next.settings.summary_col_position);
                for g in next.column_groups.iter_mut().filter(|g| g.collapsed) {
                    let summary = if summary_right { g.end_col } else { g.start_col };
                    if group_hides_in_runs(g.start_col, g.end_col, summary, runs) {
                        g.collapsed = false;
                    }
                }
            }
            let still_hidden = if rows { next.get_hidden_rows() } else { next.get_hidden_cols() };
            plan.outline_shown = outline_hidden
                .iter()
                .filter(|&&l| in_runs(runs, l) && !still_hidden.contains(&l) && !user_hidden.contains(&l))
                .count() as u64;
            plan.keep_hidden = outline_hidden
                .iter()
                .copied()
                .filter(|&l| !in_runs(runs, l) && !still_hidden.contains(&l) && !user_hidden.contains(&l))
                .collect();
            plan.keep_hidden.sort_unstable();
            plan.outline_next = Some(next);
        }
    }
    plan
}

/// `runs` less the ascending `skip` lines, as runs.
fn runs_without(runs: &[(u32, u32)], skip: &[u32]) -> Vec<(u32, u32)> {
    if skip.is_empty() {
        return runs.to_vec();
    }
    let mut out: Vec<(u32, u32)> = Vec::with_capacity(runs.len() + skip.len());
    let mut s = 0usize;
    for &(lo, hi) in runs {
        let mut next = lo as u64;
        while s < skip.len() && skip[s] < lo {
            s += 1;
        }
        while s < skip.len() && skip[s] <= hi {
            let line = skip[s] as u64;
            if line > next {
                out.push((next as u32, (line - 1) as u32));
            }
            next = line + 1;
            s += 1;
        }
        if next <= hi as u64 {
            out.push((next as u32, hi));
        }
    }
    out
}

/// Excel's Row Height... over every row of `rows` (inclusive runs, e.g.
/// `[[0, 1048575]]` for Select All), ONE undo step. See the section comment.
///
/// With a `target` (P3 2.4) the rows are a FLOATING GRID's: the object's own
/// row-height map changes (`cell_target::set_line_sizes_on_target`), never
/// the backing sheet's, gated by the host's Format Rows option.
///
/// A height given to hidden rows shows them (Excel's rule, see
/// `set_line_sizes_core`), and row visibility is a SUBTOTAL/AGGREGATE input,
/// so an unhide runs the same cascade a Unhide does. Expanding a collapsed
/// outline group announces the outline (`mutation:refresh`, domain "outline").
///
/// Returns the runs the height REACHED (`LineSizesOutcome::reached`; a
/// floating grid's are the runs as sent), for the macro recorder.
#[tauri::command]
pub fn set_row_heights(
    app: tauri::AppHandle,
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    rows: Vec<(u32, u32)>,
    height: f64,
    target: Option<crate::api_types::CellTargetRef>,
) -> Result<Vec<(u32, u32)>, String> {
    if let Some(target) = &target {
        return crate::cell_target::set_line_sizes_on_target(&state, &file_state, target, true, &rows, height).map(|_| rows.clone());
    }
    let outcome = set_line_sizes_core(&state, &file_state, true, &rows, height)?;
    if outcome.outline_changed {
        announce_outline_changed(&app);
    }
    if outcome.filter_changed {
        // The AutoFilter's hidden set changed: the "objects" domain -- the one
        // an undo of an `obj_autofilter` restore announces -- makes the
        // AutoFilter extension re-read the filter (TABLE_DEFINITIONS_UPDATED)
        // and push its hidden rows into the grid.
        use tauri::Emitter;
        let _ = app.emit(
            crate::object_deps::MUTATION_REFRESH_EVENT,
            crate::object_deps::MutationRefreshEvent { domains: vec!["objects".to_string()], source: "commit".to_string() },
        );
    }
    if outcome.unhid {
        recalc_visibility_after_row_change(
            &app,
            &state,
            &user_files_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
        );
    }
    Ok(outcome.reached)
}

/// Excel's Column Width... over every column of `cols` (inclusive runs), ONE
/// undo step; a width given to hidden columns shows them (by hand or in a
/// collapsed outline group), as in Excel. With a `target`, a floating grid's
/// own column-width map (see `set_row_heights`), gated by the host's Format
/// Columns option.
#[tauri::command]
pub fn set_column_widths(
    app: tauri::AppHandle,
    state: State<AppState>,
    file_state: State<FileState>,
    cols: Vec<(u32, u32)>,
    width: f64,
    target: Option<crate::api_types::CellTargetRef>,
) -> Result<Vec<(u32, u32)>, String> {
    if let Some(target) = &target {
        return crate::cell_target::set_line_sizes_on_target(&state, &file_state, target, false, &cols, width).map(|_| cols.clone());
    }
    let outcome = set_line_sizes_core(&state, &file_state, false, &cols, width)?;
    if outcome.outline_changed {
        announce_outline_changed(&app);
    }
    Ok(outcome.reached)
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
