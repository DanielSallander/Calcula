//! FILENAME: app/src-tauri/src/merge_commands.rs
// PURPOSE: Tauri commands for cell merge operations.
// CONTEXT: Handles merging and unmerging cells in the spreadsheet.
//
// EXCEL'S MERGE MENU (2026-10-02). The ribbon's Merge & Center split button and
// its menu (Merge & Center, Merge Across, Merge Cells, Unmerge Cells) are built
// on the SAME three commands every other caller uses -- no new command was
// added (the dispatch frame sits on a 32 MB main-thread stack). What the
// gestures need beyond a plain Range.Merge arrives as `MergeOptions` on
// `merge_cells`, an optional end corner on `unmerge_cells` and an optional
// rectangle on `get_merged_regions`; all three are Option, so every existing
// caller (api.mergeCells, the fill engine, the walker, the TestRunner suites)
// gets exactly the old behaviour.
//
// - `across`: one region per ROW, in ONE call, so Merge Across over N rows is
//   atomic and ONE undo step.
// - `absorb`: a merge wholly inside the range is dissolved and re-merged into
//   the bigger one (Excel); a PARTIAL overlap is still refused.
// - `keep_first_value`: Excel's value rule -- a region whose top-left cell
//   holds no content takes the first cell in reading order that does.
// - `probe`: every gate runs and the plan is reported (regions created and
//   dissolved, how many discard values) with NOTHING changed and the document
//   left clean, so the gesture can show Excel's data-loss warning BEFORE
//   anything happens, for any selection size.

use crate::api_types::{CellData, MergeOptions, MergeResult, MergedRegion, MovedCell};
use crate::persistence::FileState;
use crate::{format_cell_value_and_class, AppState};
use engine::UndoMergeRegion;
use tauri::State;

/// The most rows one Merge Across may merge at once. Each row becomes a merged
/// region of its own, and the merged-region set is fetched WHOLE by the
/// selection model on every Shift-extend and by the fill engine, so an
/// unbounded Merge Across over whole columns would make every later selection
/// gesture pay for a million regions. A Calcula-only refusal: Excel has no such
/// limit (recorded in docs/design/open-items.md).
pub const MAX_MERGE_ACROSS_ROWS: u32 = 10_000;

/// Convert an api_types::MergedRegion to an engine::UndoMergeRegion.
fn to_undo_region(r: &MergedRegion) -> UndoMergeRegion {
    UndoMergeRegion {
        start_row: r.start_row,
        start_col: r.start_col,
        end_row: r.end_row,
        end_col: r.end_col,
    }
}

/// Whether two rectangles share at least one cell.
fn rects_intersect(a: &MergedRegion, b: &MergedRegion) -> bool {
    !(a.end_row < b.start_row
        || a.start_row > b.end_row
        || a.end_col < b.start_col
        || a.start_col > b.end_col)
}

/// Whether `inner` lies wholly inside `outer`.
fn rect_contains(outer: &MergedRegion, inner: &MergedRegion) -> bool {
    inner.start_row >= outer.start_row
        && inner.end_row <= outer.end_row
        && inner.start_col >= outer.start_col
        && inner.end_col <= outer.end_col
}

/// Excel's notion of "this cell holds something" for the merge warning and the
/// value rule: a constant (a single space included) or ANY formula (`=""`
/// included). Formatting alone is not content.
fn holds_content(cell: &engine::Cell) -> bool {
    cell.ast.is_some() || !matches!(cell.value, engine::CellValue::Empty)
}

/// The cells STORED inside a rectangle, in reading order (row by row, left to
/// right).
///
/// SPARSE OR DENSE, whichever is smaller. `Grid::cells` is a sparse map, and
/// Select All is 1,048,576 x 16,384 = 17.2 billion coordinates: walking them to
/// find the three cells that hold anything froze the app before the data-loss
/// warning could even appear. When the rectangle is bigger than the number of
/// cells the grid holds, the grid's own entries are filtered instead; either
/// way the cost is bounded by the smaller of the two.
fn stored_cells_in(grid: &engine::Grid, area: &MergedRegion) -> Vec<(u32, u32)> {
    let rows = u64::from(area.end_row - area.start_row) + 1;
    let cols = u64::from(area.end_col - area.start_col) + 1;
    let mut out: Vec<(u32, u32)> = Vec::new();
    if rows.saturating_mul(cols) > grid.cells.len() as u64 {
        out.extend(grid.cells.keys().copied().filter(|&(r, c)| {
            r >= area.start_row && r <= area.end_row && c >= area.start_col && c <= area.end_col
        }));
        out.sort_unstable();
    } else {
        for row in area.start_row..=area.end_row {
            for col in area.start_col..=area.end_col {
                if grid.get_cell(row, col).is_some() {
                    out.push((row, col));
                }
            }
        }
    }
    out
}

/// The slice of `stored` (sorted by row, then column, all inside the merge
/// rectangle) that falls inside `region`. Every planned region spans the
/// rectangle's full column range, so its cells are one contiguous run.
fn cells_of_region<'a>(stored: &'a [(u32, u32)], region: &MergedRegion) -> &'a [(u32, u32)] {
    let from = stored.partition_point(|&(r, _)| r < region.start_row);
    let to = stored.partition_point(|&(r, _)| r <= region.end_row);
    &stored[from..to.max(from)]
}

/// The master cell of `region` as the canvas needs it, with the given spans.
fn master_cell_data(
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    locale: &engine::LocaleSettings,
    region: &MergedRegion,
    row_span: u32,
    col_span: u32,
) -> CellData {
    let master_cell = grid.get_cell(region.start_row, region.start_col);
    // Display-only: this index is formatted and handed back to the frontend as
    // CellData.style_index, so it must honour the row/column tiers.
    let master_style_index = grid.effective_style_index(region.start_row, region.start_col);
    let style = styles.get(master_style_index);
    // An EMPTY merge master has no value, so it has nothing to overflow --
    // which is Text, the fail-safe direction.
    let (display, overflow) = master_cell
        .map(|c| format_cell_value_and_class(&c.value, style, locale))
        .unwrap_or_else(|| (String::new(), crate::api_types::OverflowClass::Text));
    CellData {
        row: region.start_row,
        col: region.start_col,
        display,
        overflow,
        display_color: None,
        formula: master_cell.and_then(|c| c.formula_string()).map(|f| format!("={}", f)),
        style_index: master_style_index,
        row_span,
        col_span,
        sheet_index: None,
        rich_text: None,
        accounting_layout: None,
    }
}

/// Merge cells in a range on a NON-ACTIVE sheet (Wave 3 cross-sheet ops).
///
/// The same chain as the active path — protection (per-cell + formatCells
/// option) on the TARGET sheet, writeback claim guard, overlap refusal — but
/// against `grids[target]` and the per-sheet merge store. Undo is two
/// sheet-tagged CustomRestores in ONE transaction: the slave cells
/// ("script_grid_cells") and the sheet's merge set ("sheet_merge_regions"),
/// so one Ctrl+Z restores content and geometry together on the RIGHT sheet.
pub(crate) fn merge_cells_off_sheet(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    target: usize,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<MergeResult, String> {
    crate::protection::check_sheet_protection_range(
        state,
        target,
        start_row.min(end_row),
        start_col.min(end_col),
        start_row.max(end_row),
        start_col.max(end_col),
    )?;
    crate::protection::check_sheet_action(state, target, "formatCells", "merge cells")?;
    crate::calp_commands::ensure_range_unclaimed_on_sheets(
        state, "merge these cells", &[target], start_row, start_col, end_row, end_col,
    )?;

    // SPILL PROTECTION (§2y), on the TARGET sheet. Merging DELETES every cell
    // but the master, so it is the bluntest gesture there is: run over a
    // dynamic array it erased values the array still claimed, and the next
    // recalculation of the origin wrote them straight back inside the merged
    // region. Refused whole — see `check_no_array_within`.
    crate::commands::data::check_no_array_within(
        state,
        target,
        start_row.min(end_row),
        start_col.min(end_col),
        start_row.max(end_row),
        start_col.max(end_col),
    )?;

    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    // Read the target sheet's merge set (mirror-vs-store resolved by the
    // helper) for the overlap check and the undo snapshot.
    let previous_regions: Vec<MergedRegion> =
        crate::report::with_sheet_merges(state, target, |merged| merged.iter().cloned().collect());

    if min_row == max_row && min_col == max_col {
        return Ok(MergeResult {
            success: false,
            merged_regions: previous_regions,
            ..Default::default()
        });
    }

    for region in &previous_regions {
        let overlaps = !(max_row < region.start_row
            || min_row > region.end_row
            || max_col < region.start_col
            || min_col > region.end_col);
        if overlaps {
            return Err("Cannot merge: selection overlaps with existing merged region".to_string());
        }
    }

    let new_region = MergedRegion {
        start_row: min_row,
        start_col: min_col,
        end_row: max_row,
        end_col: max_col,
    };

    // Clear slave cells on the target grid, capturing their prior state.
    let mut previous_cells: Vec<(u32, u32, Option<engine::Cell>)> = Vec::new();
    {
        // The bounds check is the LAST thing that can refuse, so it runs against
        // a read-only view and the effect is constructed only once it has passed.
        // `lock_pending` keeps this one critical section: dropping the lock to
        // check and re-taking it to write would let a concurrent command resize
        // `grids` in between.
        let grids = state.grids.lock_pending().map_err(|e| e.to_string())?;
        if target >= grids.len() {
            return Err(format!("Sheet index {} out of range", target));
        }
        // Sparse when the rectangle is bigger than the sheet's cell count (see
        // `stored_cells_in`): a whole-column merge must not walk a million
        // empty coordinates.
        let stored = stored_cells_in(&grids[target], &new_region);
        let effect = crate::document_effect::DocumentEffect::mutates(file_state);
        let mut grids = grids.authorize(&effect);
        let grid = &mut grids[target];
        for (row, col) in stored {
            if row == min_row && col == min_col {
                continue; // Master cell keeps its content.
            }
            let previous = grid.get_cell(row, col).cloned();
            if previous.is_some() {
                previous_cells.push((row, col, previous));
                grid.clear_cell(row, col);
            }
        }
    }

    // Whether anything a formula can READ was destroyed, captured before
    // `previous_cells` is moved into the undo snapshot below. A merge over
    // empty cells changes no value, so it must not pay for a recalculation.
    let previous_cells_were_empty = previous_cells.is_empty();

    // ONE transaction: slave cells + merge geometry.
    {
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        let opened_transaction = !undo_stack.has_open_transaction();
        if opened_transaction {
            undo_stack.begin_transaction("Merge cells".to_string());
        }
        if !previous_cells.is_empty() {
            undo_stack.record_custom_restore(
                "script_grid_cells".to_string(),
                crate::undo_commands::script_grid_cells_snapshot_bytes(target, previous_cells),
                "Merge cells",
            );
        }
        undo_stack.record_custom_restore(
            "sheet_merge_regions".to_string(),
            crate::undo_commands::sheet_merge_regions_snapshot_bytes(target, previous_regions),
            "Merge cells",
        );
        if opened_transaction {
            undo_stack.commit_transaction();
        }
    }

    // Add the merged region to the target sheet's set.
    // Past every gate; the insert below is the commit.
    let merge_effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let merged_regions: Vec<MergedRegion> =
        crate::report::with_sheet_merges_mut(state, &merge_effect, target, |merged| {
            merged.insert(new_region.clone());
            merged.iter().cloned().collect()
        });

    // PHASE B — dependents (§2m). A merge DESTROYS every slave cell, so any
    // formula reading one is stale the moment this returns. The ACTIVE path
    // seeds the shared cascade; this twin did not, which is the same
    // active/off-sheet asymmetry that hid `sort_range` and `clear_range` —
    // mirrored, so here it was the sheet you were NOT looking at that stayed
    // wrong. Every guard taken above is scoped to its own block, so this runs
    // as a second lock phase (`recalc_after_off_sheet_write` takes the same
    // grid and dependency mutexes, and std mutexes are not reentrant).
    if !previous_cells_were_empty {
        crate::commands::data::recalc_after_off_sheet_write(
            state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &[target],
        );
    }

    // No updated_cells: the active canvas shows nothing from the target sheet,
    // and the sheet re-materializes from grids[target] on switch.
    Ok(MergeResult {
        success: true,
        merged_regions,
        created_regions: vec![new_region],
        ..Default::default()
    })
}

/// Merge cells in the specified range.
/// The top-left cell becomes the "master" cell containing the merged content.
/// All other cells in the range are cleared. `options` (absent = a plain
/// Range.Merge) carries the ribbon gestures' extras; see the file header.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn merge_cells(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    sheet_index: Option<usize>,
    options: Option<MergeOptions>,
) -> Result<MergeResult, String> {
    merge_cells_core(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        start_row,
        start_col,
        end_row,
        end_col,
        sheet_index,
        options,
    )
}

/// The body of `merge_cells`, on plain references so it can be driven from a
/// unit test (a `#[tauri::command]` cannot be).
#[allow(clippy::too_many_arguments)]
pub fn merge_cells_core(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    sheet_index: Option<usize>,
    options: Option<MergeOptions>,
) -> Result<MergeResult, String> {
    let opts = options.unwrap_or_default();

    // Wave 3: an explicit non-active target takes the off-sheet path.
    {
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        if let Some(target) = sheet_index {
            if target != active {
                // The ribbon gestures act on the selection, which is always on
                // the active sheet; an off-sheet caller is a script, and a
                // script's merge is a plain Range.Merge.
                if opts != MergeOptions::default() {
                    return Err("Merge options apply to the active sheet only.".to_string());
                }
                let count = state.sheet_names.read().map_err(|e| e.to_string())?.len();
                if target >= count {
                    return Err(format!(
                        "Sheet index {} out of range: workbook has {} sheet(s)",
                        target, count
                    ));
                }
                return merge_cells_off_sheet(
                    state,
                    file_state,
                    user_files_state,
                    pivot_state,
                    pane_control_state,
                    ribbon_filter_state,
                    target,
                    start_row,
                    start_col,
                    end_row,
                    end_col,
                );
            }
        }
    }
    // Sheet protection, BEFORE any lock below (the gate takes its own locks).
    // Merging clears every non-master cell in the range — on a protected sheet
    // that is a content-destroying write, so it needs the same per-cell gate as
    // any other write, plus the formatCells option (merge is an alignment
    // format operation in Excel's taxonomy).
    {
        let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;
        crate::protection::check_sheet_protection_range(
            state,
            active_sheet,
            start_row.min(end_row),
            start_col.min(end_col),
            start_row.max(end_row),
            start_col.max(end_col),
        )?;
        crate::protection::check_sheet_action(state, active_sheet, "formatCells", "merge cells")?;
    }

    // WRITEBACK CLAIM GUARD. Merging DELETES every non-master cell in the
    // range, so it is the bluntest of the range gestures: it would erase
    // respondents' answers outright and leave the writeback layer asserting
    // values for cells that no longer exist as separate slots. Refused for the
    // whole range before any lock or undo transaction. See the policy note in
    // calp_commands.rs for why an existing draft does not excuse this.
    crate::calp_commands::ensure_range_unclaimed(
        state, "merge these cells", start_row, start_col, end_row, end_col,
    )?;

    // SPILL PROTECTION (§2y) — see the off-sheet twin. Merging deletes every
    // non-master cell in the range, which is not something half an array can
    // survive.
    {
        let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;
        crate::commands::data::check_no_array_within(
            state,
            active_sheet,
            start_row.min(end_row),
            start_col.min(end_col),
            start_row.max(end_row),
            start_col.max(end_col),
        )?;
    }

    // PENDING, not written: several branches below legitimately change nothing
    // (a 1x1 range, a single-column Merge Across, a merge that already is
    // exactly that merge, every refusal, and the whole probe), and each of them
    // must leave the document clean. The effect is constructed only on the
    // branch that changes something, in the same critical section
    // (`.authorize`), so no other command can slip in between plan and write.
    let grid = state.grid.lock_pending().map_err(|e| e.to_string())?;
    let grids = state.grids.lock_pending().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;
    let styles = state.style_registry.read().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock_pending().map_err(|e| e.to_string())?;
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;

    // Normalize coordinates (ensure start <= end)
    let rect = MergedRegion {
        start_row: start_row.min(end_row),
        start_col: start_col.min(end_col),
        end_row: start_row.max(end_row),
        end_col: start_col.max(end_col),
    };
    let current: Vec<MergedRegion> = merged_regions.iter().cloned().collect();

    // Nothing to merge: a single cell, or Merge Across over one column (each
    // row would be a 1x1). Excel does nothing in both cases.
    let single_cell = rect.start_row == rect.end_row && rect.start_col == rect.end_col;
    let single_column_across = opts.across && rect.start_col == rect.end_col;
    if single_cell || single_column_across {
        return Ok(MergeResult {
            success: false,
            merged_regions: current,
            ..Default::default()
        });
    }

    if opts.across && rect.end_row - rect.start_row + 1 > MAX_MERGE_ACROSS_ROWS {
        // The figure is MAX_MERGE_ACROSS_ROWS, written for a reader.
        return Err("Merge Across can merge at most 10,000 rows at once. Select fewer rows.".to_string());
    }

    // Existing merges inside the range are absorbed (with `absorb`); one that
    // only PARTLY overlaps is refused, as before -- Excel never reaches that
    // case because its selection grows to take in whole merged areas, and
    // Calcula's selection does the same (useSelection).
    let mut contained: Vec<MergedRegion> = Vec::new();
    for region in &current {
        if !rects_intersect(&rect, region) {
            continue;
        }
        if opts.absorb && rect_contains(&rect, region) {
            contained.push(region.clone());
        } else {
            return Err("Cannot merge: selection overlaps with existing merged region".to_string());
        }
    }

    let planned: Vec<MergedRegion> = if opts.across {
        (rect.start_row..=rect.end_row)
            .map(|row| MergedRegion {
                start_row: row,
                start_col: rect.start_col,
                end_row: row,
                end_col: rect.end_col,
            })
            .collect()
    } else {
        vec![rect.clone()]
    };

    // A merge that is already exactly what was asked for changes nothing: no
    // undo step, and the document stays clean.
    if !contained.is_empty() {
        let wanted: std::collections::HashSet<&MergedRegion> = planned.iter().collect();
        let existing: std::collections::HashSet<&MergedRegion> = contained.iter().collect();
        if wanted == existing {
            return Ok(MergeResult {
                success: false,
                merged_regions: current,
                ..Default::default()
            });
        }
    }

    // THE PLAN, per region: how many cells hold content (two or more discard
    // values -- Excel's warning), and which cell's value moves into the
    // top-left one (Excel's value rule: the first in reading order, when the
    // top-left holds nothing).
    let stored = stored_cells_in(&grid, &rect);
    let mut lossy_regions: u32 = 0;
    let mut moves: Vec<Option<(u32, u32)>> = Vec::with_capacity(planned.len());
    for region in &planned {
        let mut first_content: Option<(u32, u32)> = None;
        let mut with_content: u32 = 0;
        for &(row, col) in cells_of_region(&stored, region) {
            if grid.get_cell(row, col).is_some_and(holds_content) {
                with_content += 1;
                if first_content.is_none() {
                    first_content = Some((row, col));
                }
            }
        }
        if with_content >= 2 {
            lossy_regions += 1;
        }
        let master_holds = grid
            .get_cell(region.start_row, region.start_col)
            .is_some_and(holds_content);
        moves.push(if opts.keep_first_value && !master_holds { first_content } else { None });
    }
    let moved_cells: Vec<MovedCell> = planned
        .iter()
        .zip(&moves)
        .filter_map(|(region, from)| {
            from.map(|(from_row, from_col)| MovedCell {
                from_row,
                from_col,
                to_row: region.start_row,
                to_col: region.start_col,
            })
        })
        .collect();

    if opts.probe {
        // A READ. No DocumentEffect is constructed and the pending guards are
        // simply dropped: asking what a merge would do must never dirty the
        // document or leave an undo step.
        return Ok(MergeResult {
            success: true,
            merged_regions: current,
            updated_cells: Vec::new(),
            created_regions: planned,
            removed_regions: contained,
            lossy_regions,
            moved_cells,
        });
    }

    // Every refusal above has passed and this branch changes the document:
    // constructed HERE (see DocumentEffect::mutates on ordering), and the
    // pending guards are upgraded in the same critical section.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut merged_regions = merged_regions.authorize(&effect);

    // The mirror is cleared by ITS OWN stored list, so a mirror that ever
    // diverged from `grid` cannot keep a slave the merge meant to delete.
    let mirror_stored: Vec<(u32, u32)> = if active_sheet < grids.len() {
        stored_cells_in(&grids[active_sheet], &rect)
    } else {
        Vec::new()
    };

    let label = if opts.across { "Merge across" } else { "Merge cells" };
    // Joins a caller's open step (the ribbon gesture opens one so its centring
    // and reference re-pointing land in the SAME Ctrl+Z).
    let transaction = undo_stack.begin_owned_transaction(label);

    // Absorbed merges first, so undo re-adds them last.
    for region in &contained {
        // Sheet-tagged: a merge belongs to the sheet it was made on, and the
        // user can be on another sheet by the time they undo it.
        undo_stack.record_merge_region_removed(active_sheet, to_undo_region(region));
        merged_regions.remove(region);
    }

    let mut updated_cells: Vec<CellData> = Vec::new();
    // Slaves that actually HELD something, plus masters that received a moved
    // value — the recalc seeds for phase B (§2c). A merge destroys the slaves'
    // values, so anything reading them is stale from here on; merging is a
    // bulk cell rewrite like any other.
    let mut seeds: Vec<(u32, u32)> = Vec::new();
    let mut formula_moved = false;
    for (region, from) in planned.iter().zip(&moves) {
        let master = (region.start_row, region.start_col);

        // Excel's value rule: a TRUE move -- value, formula and style travel
        // together, the way a cut and paste would carry them.
        if let Some((from_row, from_col)) = *from {
            if let Some(source) = grid.get_cell(from_row, from_col).cloned() {
                undo_stack.record_cell_change(
                    active_sheet,
                    master.0,
                    master.1,
                    grid.get_cell(master.0, master.1).cloned(),
                );
                formula_moved |= source.ast.is_some();
                grid.set_cell(master.0, master.1, source.clone());
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(master.0, master.1, source);
                }
                seeds.push(master);
            }
        }

        // Record each slave cell's previous state for undo, then clear it.
        // Only coordinates that hold a cell are visited (`stored_cells_in`).
        for &(row, col) in cells_of_region(&stored, region) {
            if (row, col) == master {
                continue; // Master cell is not cleared
            }
            let previous = grid.get_cell(row, col).cloned();
            if previous.is_some() {
                undo_stack.record_cell_change(active_sheet, row, col, previous);
                seeds.push((row, col));
                grid.clear_cell(row, col);
            }
        }
        if active_sheet < grids.len() {
            for &(row, col) in cells_of_region(&mirror_stored, region) {
                if (row, col) != master {
                    grids[active_sheet].clear_cell(row, col);
                }
            }
        }

        undo_stack.record_merge_region_added(active_sheet, to_undo_region(region));
        merged_regions.insert(region.clone());

        updated_cells.push(master_cell_data(
            &grid,
            &styles,
            &locale,
            region,
            region.end_row - region.start_row + 1,
            region.end_col - region.start_col + 1,
        ));
    }

    undo_stack.commit_owned(transaction);

    let regions_snapshot: Vec<MergedRegion> = merged_regions.iter().cloned().collect();

    // PHASE B — dependents (§2c). Merging is a content-DESTROYING bulk rewrite:
    // every slave cell's value is erased, so `=B1` beside a merge kept the
    // pre-merge number exactly the way `=A1` beside a sort did. Locks released
    // first — the recalc takes the same grid/styles/merged_regions/locale
    // mutexes and std mutexes are not reentrant.
    drop(locale);
    drop(undo_stack);
    drop(merged_regions);
    drop(styles);
    drop(grids);
    drop(grid);

    // A moved FORMULA reads from its new cell now, and the dependency maps are
    // keyed by cell: rebuilt from the grid, the way an undo restore does,
    // before the cascade walks them.
    if formula_moved {
        crate::undo_commands::rebuild_all_dependencies(state);
    }

    if !seeds.is_empty() {
        crate::commands::data::recalc_after_active_sheet_bulk_rewrite(
            state,
            user_files_state,
            pane_control_state,
            ribbon_filter_state,
            &seeds,
            &mut updated_cells,
        );
    }

    Ok(MergeResult {
        success: true,
        merged_regions: regions_snapshot,
        updated_cells,
        created_regions: planned,
        removed_regions: contained,
        lossy_regions,
        moved_cells,
    })
}

/// Unmerge on a NON-ACTIVE sheet (Wave 3 cross-sheet ops). Undo restores the
/// sheet's merge set via ONE sheet-tagged "sheet_merge_regions" entry —
/// unmerging destroys no cell content (the slaves were emptied at merge time).
pub(crate) fn unmerge_cells_off_sheet(
    state: &AppState,
    file_state: &FileState,
    target: usize,
    row: u32,
    col: u32,
) -> Result<MergeResult, String> {
    crate::protection::check_sheet_action(state, target, "formatCells", "unmerge cells")?;

    let previous_regions: Vec<MergedRegion> =
        crate::report::with_sheet_merges(state, target, |merged| merged.iter().cloned().collect());

    let region_to_remove = previous_regions
        .iter()
        .find(|r| row >= r.start_row && row <= r.end_row && col >= r.start_col && col <= r.end_col)
        .cloned();

    let Some(region) = region_to_remove else {
        return Ok(MergeResult {
            success: false,
            merged_regions: previous_regions,
            ..Default::default()
        });
    };

    // Same claim policy as the active twin: checked against the FOUND region.
    crate::calp_commands::ensure_range_unclaimed_on_sheets(
        state,
        "unmerge these cells",
        &[target],
        region.start_row,
        region.start_col,
        region.end_row,
        region.end_col,
    )?;

    {
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        let opened_transaction = !undo_stack.has_open_transaction();
        if opened_transaction {
            undo_stack.begin_transaction("Unmerge cells".to_string());
        }
        undo_stack.record_custom_restore(
            "sheet_merge_regions".to_string(),
            crate::undo_commands::sheet_merge_regions_snapshot_bytes(target, previous_regions),
            "Unmerge cells",
        );
        if opened_transaction {
            undo_stack.commit_transaction();
        }
    }

    let unmerge_effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let merged_regions: Vec<MergedRegion> =
        crate::report::with_sheet_merges_mut(state, &unmerge_effect, target, |merged| {
            merged.remove(&region);
            merged.iter().cloned().collect()
        });

    Ok(MergeResult {
        success: true,
        merged_regions,
        removed_regions: vec![region],
        ..Default::default()
    })
}

/// Unmerge cells at the specified position.
/// If the cell is part of a merged region, the region is dissolved. With an
/// end corner (`end_row` + `end_col`), EVERY merged region that intersects the
/// rectangle from (`row`, `col`) is dissolved in ONE undo step -- Excel's
/// Unmerge Cells over a selection.
#[tauri::command]
pub fn unmerge_cells(
    state: State<AppState>,
    file_state: State<FileState>,
    row: u32,
    col: u32,
    sheet_index: Option<usize>,
    end_row: Option<u32>,
    end_col: Option<u32>,
) -> Result<MergeResult, String> {
    unmerge_cells_core(&state, &file_state, row, col, sheet_index, end_row, end_col)
}

/// The body of `unmerge_cells`, on plain references so it can be driven from a
/// unit test.
pub fn unmerge_cells_core(
    state: &AppState,
    file_state: &FileState,
    row: u32,
    col: u32,
    sheet_index: Option<usize>,
    end_row: Option<u32>,
    end_col: Option<u32>,
) -> Result<MergeResult, String> {
    // The rectangle form needs BOTH corners; one alone is the single-cell form.
    let range = match (end_row, end_col) {
        (Some(er), Some(ec)) => Some(MergedRegion {
            start_row: row.min(er),
            start_col: col.min(ec),
            end_row: row.max(er),
            end_col: col.max(ec),
        }),
        _ => None,
    };

    // Wave 3: an explicit non-active target takes the off-sheet path.
    {
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        if let Some(target) = sheet_index {
            if target != active {
                if range.is_some() {
                    return Err("Unmerging a range applies to the active sheet only.".to_string());
                }
                let count = state.sheet_names.read().map_err(|e| e.to_string())?.len();
                if target >= count {
                    return Err(format!(
                        "Sheet index {} out of range: workbook has {} sheet(s)",
                        target, count
                    ));
                }
                return unmerge_cells_off_sheet(state, file_state, target, row, col);
            }
        }
    }
    // Same gate as merge_cells: merge structure is a format attribute, and
    // Excel refuses to change it on a protected sheet without formatCells.
    {
        let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;
        crate::protection::check_sheet_action(state, active_sheet, "formatCells", "unmerge cells")?;
    }

    // Find the merged region(s) FIRST, holding only `merged_regions`, so the
    // writeback guard below can run before the rest of the lock set is taken
    // (the guard takes its own locks — writeback_index, active_sheet,
    // sheet_ids — and must never be reached with grid held, or two commands
    // could acquire the two sets in opposite orders).
    let found: Vec<MergedRegion> = {
        let merged_regions = state.merged_regions.read().map_err(|e| e.to_string())?;
        match &range {
            Some(area) => {
                let mut hits: Vec<MergedRegion> = merged_regions
                    .iter()
                    .filter(|r| rects_intersect(area, r))
                    .cloned()
                    .collect();
                // HashSet order is arbitrary; a stable order keeps the undo
                // record and the reply deterministic.
                hits.sort_by_key(|r| (r.start_row, r.start_col));
                hits
            }
            None => merged_regions
                .iter()
                .find(|r| {
                    row >= r.start_row && row <= r.end_row && col >= r.start_col && col <= r.end_col
                })
                .cloned()
                .into_iter()
                .collect(),
        }
    };

    // WRITEBACK CLAIM GUARD. Unmerging destroys no values — the slave cells
    // were already emptied when the merge was made — but it changes which cell
    // of a claimed rectangle is addressable and visible to the respondent.
    // Guarding merge while leaving unmerge open would let a script toggle a
    // claimed region's geometry at will, so both directions are refused. The
    // check is against each FOUND REGION, not the clicked cell: a merge can
    // extend into a claim that the clicked cell itself sits outside of.
    for region in &found {
        crate::calp_commands::ensure_range_unclaimed(
            state,
            "unmerge these cells",
            region.start_row,
            region.start_col,
            region.end_row,
            region.end_col,
        )?;
    }

    // The sheet this unmerge is recorded ON, read before the grid lock is taken
    // (same reason the writeback guard above runs first).
    let unmerge_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;

    let grid = state.grid.read().map_err(|e| e.to_string())?;
    let styles = state.style_registry.read().map_err(|e| e.to_string())?;
    // `lock_pending`: this command legitimately does nothing when no merge is
    // found, and that branch must leave the document clean.
    let merged_regions = state.merged_regions.lock_pending().map_err(|e| e.to_string())?;
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;

    // Re-checked under the lock: the regions were found under an earlier read,
    // and the claim guard ran between the two. Only a region that is STILL
    // there is removed and recorded -- recording one that another command
    // removed in between would make undo re-add a merge that no longer existed.
    let to_remove: Vec<MergedRegion> =
        found.into_iter().filter(|r| merged_regions.contains(r)).collect();

    if to_remove.is_empty() {
        return Ok(MergeResult {
            success: false,
            merged_regions: merged_regions.iter().cloned().collect(),
            ..Default::default()
        });
    }

    // A region was found, so this call removes it: the flag is set here and
    // the guard is upgraded in the same critical section.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut merged_regions = merged_regions.authorize(&effect);
    // ONE undo step for every region, joining a caller's open step.
    let transaction = undo_stack.begin_owned_transaction("Unmerge cells");
    let mut updated_cells: Vec<CellData> = Vec::with_capacity(to_remove.len());
    for region in &to_remove {
        // Sheet-tagged; see `merge_cells_core`.
        undo_stack.record_merge_region_removed(unmerge_sheet, to_undo_region(region));
        merged_regions.remove(region);
        // Return the master cell with span reset to 1
        updated_cells.push(master_cell_data(&grid, &styles, &locale, region, 1, 1));
    }
    undo_stack.commit_owned(transaction);

    Ok(MergeResult {
        success: true,
        merged_regions: merged_regions.iter().cloned().collect(),
        updated_cells,
        removed_regions: to_remove,
        ..Default::default()
    })
}

/// Get the merged regions of the current sheet: all of them, or -- when all
/// four bounds are given -- only those that intersect that rectangle (the
/// ribbon asks "is anything in my selection merged?" on every selection
/// change, and must not ship the whole set to answer it).
#[tauri::command]
pub fn get_merged_regions(
    state: State<AppState>,
    start_row: Option<u32>,
    start_col: Option<u32>,
    end_row: Option<u32>,
    end_col: Option<u32>,
) -> Result<Vec<MergedRegion>, String> {
    get_merged_regions_core(&state, start_row, start_col, end_row, end_col)
}

/// The body of `get_merged_regions`.
pub fn get_merged_regions_core(
    state: &AppState,
    start_row: Option<u32>,
    start_col: Option<u32>,
    end_row: Option<u32>,
    end_col: Option<u32>,
) -> Result<Vec<MergedRegion>, String> {
    let merged_regions = state.merged_regions.read().map_err(|e| e.to_string())?;
    let area = match (start_row, start_col, end_row, end_col) {
        (Some(sr), Some(sc), Some(er), Some(ec)) => Some(MergedRegion {
            start_row: sr.min(er),
            start_col: sc.min(ec),
            end_row: sr.max(er),
            end_col: sc.max(ec),
        }),
        _ => None,
    };
    Ok(match area {
        Some(area) => merged_regions.iter().filter(|r| rects_intersect(&area, r)).cloned().collect(),
        None => merged_regions.iter().cloned().collect(),
    })
}

/// Check if a cell is part of a merged region.
/// Returns the master cell's coordinates and span if it is.
#[tauri::command]
pub fn get_merge_info(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Result<Option<MergedRegion>, String> {
    let merged_regions = state.merged_regions.read().map_err(|e| e.to_string())?;

    let region = merged_regions
        .iter()
        .find(|r| row >= r.start_row && row <= r.end_row && col >= r.start_col && col <= r.end_col)
        .cloned();

    Ok(region)
}
