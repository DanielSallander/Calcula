//! FILENAME: app/src-tauri/src/merge_commands.rs
// PURPOSE: Tauri commands for cell merge operations.
// CONTEXT: Handles merging and unmerging cells in the spreadsheet.

use crate::api_types::{CellData, MergedRegion, MergeResult};
use crate::persistence::FileState;
use crate::{format_cell_value, AppState};
use engine::UndoMergeRegion;
use tauri::State;

/// Convert an api_types::MergedRegion to an engine::UndoMergeRegion.
fn to_undo_region(r: &MergedRegion) -> UndoMergeRegion {
    UndoMergeRegion {
        start_row: r.start_row,
        start_col: r.start_col,
        end_row: r.end_row,
        end_col: r.end_col,
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
            updated_cells: Vec::new(),
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
        let effect = crate::document_effect::DocumentEffect::mutates(file_state);
        let mut grids = grids.authorize(&effect);
        let grid = &mut grids[target];
        for row in min_row..=max_row {
            for col in min_col..=max_col {
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
        updated_cells: Vec::new(),
    })
}

/// Merge cells in the specified range.
/// The top-left cell becomes the "master" cell containing the merged content.
/// All other cells in the range are cleared.
#[tauri::command]
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
) -> Result<MergeResult, String> {
    // Wave 3: an explicit non-active target takes the off-sheet path.
    {
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        if let Some(target) = sheet_index {
            if target != active {
                let count = state.sheet_names.read().map_err(|e| e.to_string())?.len();
                if target >= count {
                    return Err(format!(
                        "Sheet index {} out of range: workbook has {} sheet(s)",
                        target, count
                    ));
                }
                return merge_cells_off_sheet(
                    &state,
                    &file_state,
                    &user_files_state,
                    &pivot_state,
                    &pane_control_state,
                    &ribbon_filter_state,
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
            &state,
            active_sheet,
            start_row.min(end_row),
            start_col.min(end_col),
            start_row.max(end_row),
            start_col.max(end_col),
        )?;
        crate::protection::check_sheet_action(&state, active_sheet, "formatCells", "merge cells")?;
    }

    // WRITEBACK CLAIM GUARD. Merging DELETES every non-master cell in the
    // range, so it is the bluntest of the range gestures: it would erase
    // respondents' answers outright and leave the writeback layer asserting
    // values for cells that no longer exist as separate slots. Refused for the
    // whole range before any lock or undo transaction. See the policy note in
    // calp_commands.rs for why an existing draft does not excuse this.
    crate::calp_commands::ensure_range_unclaimed(
        &state, "merge these cells", start_row, start_col, end_row, end_col,
    )?;

    // SPILL PROTECTION (§2y) — see the off-sheet twin. Merging deletes every
    // non-master cell in the range, which is not something half an array can
    // survive.
    {
        let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;
        crate::commands::data::check_no_array_within(
            &state,
            active_sheet,
            start_row.min(end_row),
            start_col.min(end_col),
            start_row.max(end_row),
            start_col.max(end_col),
        )?;
    }

    // Every gate above has passed; from here this command commits. Constructed
    // HERE and not at the top so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = state.grid.write(&effect).map_err(|e| e.to_string())?;
    let mut grids = state.grids.write(&effect).map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;
    let styles = state.style_registry.read().map_err(|e| e.to_string())?;
    let mut merged_regions = state.merged_regions.write(&effect).map_err(|e| e.to_string())?;
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;

    // Normalize coordinates (ensure start <= end)
    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    // Check if single cell - nothing to merge
    if min_row == max_row && min_col == max_col {
        return Ok(MergeResult {
            success: false,
            merged_regions: merged_regions.iter().cloned().collect(),
            updated_cells: Vec::new(),
        });
    }

    // Check for overlapping merges
    for region in merged_regions.iter() {
        let overlaps = !(max_row < region.start_row
            || min_row > region.end_row
            || max_col < region.start_col
            || min_col > region.end_col);
        if overlaps {
            return Err("Cannot merge: selection overlaps with existing merged region".to_string());
        }
    }

    // Create the new merged region
    let new_region = MergedRegion {
        start_row: min_row,
        start_col: min_col,
        end_row: max_row,
        end_col: max_col,
    };

    // Get the master cell content (top-left)
    let master_cell = grid.get_cell(min_row, min_col).cloned();
    // Display-only: this index is formatted and handed back to the frontend as
    // CellData.style_index, so it must honour the row/column tiers. Resolved
    // before the grid is mutably borrowed below.
    let master_style_index = grid.effective_style_index(min_row, min_col);

    // Record undo: save slave cells that will be cleared + the merge region being added
    let opened_transaction = !undo_stack.has_open_transaction();
    if opened_transaction {
        undo_stack.begin_transaction("Merge cells".to_string());
    }

    // Record each slave cell's previous state for undo
    for row in min_row..=max_row {
        for col in min_col..=max_col {
            if row == min_row && col == min_col {
                continue; // Master cell is not cleared
            }
            let previous = grid.get_cell(row, col).cloned();
            if previous.is_some() {
                undo_stack.record_cell_change(active_sheet, row, col, previous);
            }
        }
    }

    // Record the merge region addition
    // Sheet-tagged: a merge belongs to the sheet it was made on, and the user
    // can be on another sheet by the time they undo it.
    undo_stack.record_merge_region_added(active_sheet, to_undo_region(&new_region));

    if opened_transaction {
        undo_stack.commit_transaction();
    }

    // Clear all cells in the range except the master
    let mut updated_cells = Vec::new();
    // Slaves that actually HELD content — the recalc seeds for phase B (§2c).
    // A merge destroys their values, so anything reading them is stale from
    // here on; merging is a bulk cell rewrite like any other.
    let mut cleared_slaves: Vec<(u32, u32)> = Vec::new();
    for row in min_row..=max_row {
        for col in min_col..=max_col {
            if row == min_row && col == min_col {
                // Master cell - keep content, will be returned with spans
                continue;
            }
            // Clear slave cells
            if grid.get_cell(row, col).is_some() {
                cleared_slaves.push((row, col));
            }
            grid.clear_cell(row, col);
            if active_sheet < grids.len() {
                grids[active_sheet].clear_cell(row, col);
            }
        }
    }

    // Add the merged region
    merged_regions.insert(new_region.clone());

    // Return the master cell with span info
    let style = styles.get(master_style_index);
    let display = master_cell
        .as_ref()
        .map(|c| format_cell_value(&c.value, style, &locale))
        .unwrap_or_default();

    updated_cells.push(CellData {
        row: min_row,
        col: min_col,
        display,
        display_color: None,
        formula: master_cell.as_ref().and_then(|c| c.formula_string()).map(|f| format!("={}", f)),
        style_index: master_style_index,
        row_span: max_row - min_row + 1,
        col_span: max_col - min_col + 1,
        sheet_index: None,
        rich_text: None,
                accounting_layout: None,
    });

    // Mark workbook as dirty
    let _ = crate::document_effect::DocumentEffect::mutates(&file_state);

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

    if !cleared_slaves.is_empty() {
        crate::commands::data::recalc_after_active_sheet_bulk_rewrite(
            &state,
            &user_files_state,
            &pane_control_state,
            &ribbon_filter_state,
            &cleared_slaves,
            &mut updated_cells,
        );
    }

    Ok(MergeResult {
        success: true,
        merged_regions: regions_snapshot,
        updated_cells,
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
            updated_cells: Vec::new(),
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
        updated_cells: Vec::new(),
    })
}

/// Unmerge cells at the specified position.
/// If the cell is part of a merged region, the region is dissolved.
#[tauri::command]
pub fn unmerge_cells(
    state: State<AppState>,
    file_state: State<FileState>,
    row: u32,
    col: u32,
    sheet_index: Option<usize>,
) -> Result<MergeResult, String> {
    // Wave 3: an explicit non-active target takes the off-sheet path.
    {
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        if let Some(target) = sheet_index {
            if target != active {
                let count = state.sheet_names.read().map_err(|e| e.to_string())?.len();
                if target >= count {
                    return Err(format!(
                        "Sheet index {} out of range: workbook has {} sheet(s)",
                        target, count
                    ));
                }
                return unmerge_cells_off_sheet(&state, &file_state, target, row, col);
            }
        }
    }
    // Same gate as merge_cells: merge structure is a format attribute, and
    // Excel refuses to change it on a protected sheet without formatCells.
    {
        let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;
        crate::protection::check_sheet_action(&state, active_sheet, "formatCells", "unmerge cells")?;
    }

    // Find the merged region containing this cell FIRST, holding only
    // `merged_regions`, so the writeback guard below can run before the rest of
    // the lock set is taken (the guard takes its own locks — writeback_index,
    // active_sheet, sheet_ids — and must never be reached with grid held, or
    // two commands could acquire the two sets in opposite orders).
    let region_to_remove = {
        let merged_regions = state.merged_regions.read().map_err(|e| e.to_string())?;
        merged_regions
            .iter()
            .find(|r| {
                row >= r.start_row && row <= r.end_row && col >= r.start_col && col <= r.end_col
            })
            .cloned()
    };

    // WRITEBACK CLAIM GUARD. Unmerging destroys no values — the slave cells
    // were already emptied when the merge was made — but it changes which cell
    // of a claimed rectangle is addressable and visible to the respondent.
    // Guarding merge while leaving unmerge open would let a script toggle a
    // claimed region's geometry at will, so both directions are refused. The
    // check is against the FOUND REGION, not the clicked cell: a merge can
    // extend into a claim that the clicked cell itself sits outside of.
    if let Some(ref region) = region_to_remove {
        crate::calp_commands::ensure_range_unclaimed(
            &state,
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
    // `lock_pending`: this command legitimately does nothing when the clicked
    // cell is in no merge, and that branch must leave the document clean.
    let merged_regions = state.merged_regions.lock_pending().map_err(|e| e.to_string())?;
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;

    if let Some(region) = region_to_remove {
        // A region was found, so this call removes it: the flag is set here and
        // the guard is upgraded in the same critical section.
        let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
        let mut merged_regions = merged_regions.authorize(&effect);
        // Record undo: the merge region being removed
        let opened_transaction = !undo_stack.has_open_transaction();
        if opened_transaction {
            undo_stack.begin_transaction("Unmerge cells".to_string());
        }
        // Sheet-tagged; see `merge_cells`.
        undo_stack.record_merge_region_removed(unmerge_sheet, to_undo_region(&region));
        if opened_transaction {
            undo_stack.commit_transaction();
        }

        merged_regions.remove(&region);

        // Return the master cell with span reset to 1
        let master_cell = grid.get_cell(region.start_row, region.start_col).cloned();
        let master_style_index = grid.effective_style_index(region.start_row, region.start_col);
        let style = styles.get(master_style_index);
        let display = master_cell
            .as_ref()
            .map(|c| format_cell_value(&c.value, style, &locale))
            .unwrap_or_default();

        let updated_cells = vec![CellData {
            row: region.start_row,
            col: region.start_col,
            display,
            display_color: None,
            formula: master_cell.as_ref().and_then(|c| c.formula_string()).map(|f| format!("={}", f)),
            style_index: master_style_index,
            row_span: 1,
            col_span: 1,
            sheet_index: None,
            rich_text: None,
                accounting_layout: None,
        }];

        Ok(MergeResult {
            success: true,
            merged_regions: merged_regions.iter().cloned().collect(),
            updated_cells,
        })
    } else {
        Ok(MergeResult {
            success: false,
            merged_regions: merged_regions.iter().cloned().collect(),
            updated_cells: Vec::new(),
        })
    }
}

/// Get all merged regions for the current sheet.
#[tauri::command]
pub fn get_merged_regions(state: State<AppState>) -> Result<Vec<MergedRegion>, String> {
    let merged_regions = state.merged_regions.read().map_err(|e| e.to_string())?;
    Ok(merged_regions.iter().cloned().collect())
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
