//! FILENAME: app/src-tauri/src/commands/search.rs
// PURPOSE: Find and replace functionality.

use crate::api_types::CellData;
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::{format_cell_value_and_class, AppState};
use engine::CellValue;
use tauri::State;

// FIND AND REPLACE REWRITES GRID CELLS, which are persisted, so both replace commands
// dirty the document. Neither took a `FileState`: Replace All could rewrite hundreds of
// cells, open an undo transaction for them, and still leave the workbook looking clean
// at close. Both have an off-sheet twin that writes to a NON-ACTIVE sheet, and those
// twins need the flag just as much -- the write is invisible on the current canvas, so
// nothing else would ever set it.
//
// All four mark only once the gates (writeback claim, sheet protection) have passed AND
// a replacement has actually been committed: "no match here" and "formula cell, skipped"
// are no-ops that must leave the document clean.

/// Search result containing match coordinates and total count.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub matches: Vec<(u32, u32)>,
    pub total_count: usize,
}

/// Result of a replace operation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub updated_cells: Vec<CellData>,
    pub replacement_count: usize,
}

/// Resolve an optional 0-based sheet index (None = active) with bounds check.
/// Returns (target, active).
fn resolve_search_sheet(
    state: &AppState,
    sheet_index: Option<usize>,
) -> Result<(usize, usize), String> {
    let active = *state.active_sheet.read().unwrap();
    match sheet_index {
        None => Ok((active, active)),
        Some(idx) => {
            let count = state.sheet_names.read().unwrap().len();
            if idx < count {
                Ok((idx, active))
            } else {
                Err(format!(
                    "Sheet index {} out of range: workbook has {} sheet(s)",
                    idx, count
                ))
            }
        }
    }
}

/// Run a read-only closure against the TARGET sheet's grid: the mirror when
/// the target is active (grids[active] can lag behind it), grids[target]
/// otherwise.
fn with_search_grid<R>(
    state: &AppState,
    target: usize,
    active: usize,
    f: impl FnOnce(&engine::Grid) -> R,
) -> R {
    if target == active {
        let grid = state.grid.read().unwrap();
        f(&grid)
    } else {
        let grids = state.grids.read().unwrap();
        static EMPTY: once_cell::sync::Lazy<engine::Grid> =
            once_cell::sync::Lazy::new(engine::Grid::new);
        f(grids.get(target).unwrap_or(&EMPTY))
    }
}

/// Find all cells matching the query (on the active sheet, or `sheet_index`).
#[tauri::command]
pub fn find_all(
    state: State<AppState>,
    query: String,
    case_sensitive: bool,
    match_entire_cell: bool,
    search_formulas: bool,
    sheet_index: Option<usize>,
) -> Result<FindResult, String> {
    let (target, active) = resolve_search_sheet(&state, sheet_index)?;
    let matches = with_search_grid(&state, target, active, |grid| {
        grid.find_all(&query, case_sensitive, match_entire_cell, search_formulas)
    });
    let total_count = matches.len();
    Ok(FindResult { matches, total_count })
}

/// Count matches without returning coordinates (faster for large grids).
#[tauri::command]
pub fn count_matches(
    state: State<AppState>,
    query: String,
    case_sensitive: bool,
    match_entire_cell: bool,
    search_formulas: bool,
    sheet_index: Option<usize>,
) -> Result<usize, String> {
    let (target, active) = resolve_search_sheet(&state, sheet_index)?;
    Ok(with_search_grid(&state, target, active, |grid| {
        grid.count_matches(&query, case_sensitive, match_entire_cell, search_formulas)
    }))
}

/// The value transform shared by replace_all's two paths (active mirror /
/// off-sheet grid): what the cell's value becomes, or None to leave it alone.
fn compute_replacement_value(
    value: &CellValue,
    search: &str,
    search_normalized: &str,
    replacement: &str,
    case_sensitive: bool,
    match_entire_cell: bool,
) -> Option<CellValue> {
    match value {
        CellValue::Text(text) => {
            let new_text = if case_sensitive {
                text.replace(search, replacement)
            } else {
                replace_case_insensitive(text, search, replacement)
            };

            if match_entire_cell && new_text != replacement {
                return None; // Not an exact match in entire-cell mode
            }

            if new_text != *text {
                Some(CellValue::Text(new_text))
            } else {
                None
            }
        }
        CellValue::Number(n) => {
            let text = if n.fract() == 0.0 {
                format!("{:.0}", n)
            } else {
                format!("{}", n)
            };

            let text_normalized = if case_sensitive {
                text.clone()
            } else {
                text.to_lowercase()
            };

            if match_entire_cell {
                if text_normalized == search_normalized {
                    Some(CellValue::Text(replacement.to_string()))
                } else {
                    None
                }
            } else if text_normalized.contains(search_normalized) {
                let new_text = if case_sensitive {
                    text.replace(search, replacement)
                } else {
                    replace_case_insensitive(&text, search, replacement)
                };
                if let Ok(num) = new_text.parse::<f64>() {
                    Some(CellValue::Number(num))
                } else {
                    Some(CellValue::Text(new_text))
                }
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Replace All on a NON-ACTIVE sheet (Wave 3 cross-sheet ops): same guards as
/// the active path — writeback claim per matched cell, sheet protection over
/// the match list, formula cells skipped — against `grids[target]`. Undo is a
/// single sheet-tagged "script_grid_cells" CustomRestore; dependents anywhere
/// recalculate through `recalc_after_off_sheet_write`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn replace_all_off_sheet(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::types::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    target: usize,
    search: String,
    replacement: String,
    case_sensitive: bool,
    match_entire_cell: bool,
) -> Result<ReplaceResult, String> {
    let matches = {
        let grids = state.grids.read().unwrap();
        match grids.get(target) {
            Some(grid) => grid.find_all(&search, case_sensitive, match_entire_cell, false),
            None => Vec::new(),
        }
    };

    // WRITEBACK CLAIM GUARD against the match list, on the TARGET sheet.
    crate::calp_commands::ensure_cells_unclaimed_on_sheet(
        state, "replace all here", target, &matches,
    )?;

    // SPILL PROTECTION against the match list, on the TARGET sheet — see the
    // active twin. Rewriting a spilled VALUE in place is refused whatever the
    // recalculation can do afterwards: the cell is derived state that no
    // formula produced, so a replacement in it is a value nothing owns.
    crate::commands::data::check_spill_protection_cells(state, target, &matches)?;

    let grids = state.grids.lock_pending().unwrap();
    let styles = state.style_registry.read().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Sheet protection over the cells this replace would touch, on the target
    // sheet's grid (borrowed form — same rationale as the active path).
    {
        let grid = grids
            .get(target)
            .ok_or_else(|| format!("Sheet index {} out of range", target))?;
        let protection_storage = state.sheet_protection.read().unwrap();
        crate::protection::check_sheet_protection_cells_in(
            &protection_storage,
            grid,
            &styles,
            target,
            matches.iter().copied(),
        )?;
    }

    if matches.is_empty() {
        return Ok(ReplaceResult {
            updated_cells: Vec::new(),
            replacement_count: 0,
        });
    }

    // Both gates passed and there is at least one match: cells on the target sheet are
    // about to be rewritten. Off-sheet writes are exactly the ones nothing else marks.
    let effect = DocumentEffect::mutates(file_state);
    let mut grids = grids.authorize(&effect);

    let search_normalized = if case_sensitive {
        search.clone()
    } else {
        search.to_lowercase()
    };

    let grid = grids
        .get_mut(target)
        .ok_or_else(|| format!("Sheet index {} out of range", target))?;

    let mut previous_cells: Vec<(u32, u32, Option<engine::Cell>)> = Vec::new();
    let mut replacement_count = 0;

    for (row, col) in matches {
        let Some(cell) = grid.get_cell(row, col).cloned() else { continue };
        if cell.has_formula() {
            continue; // Skip formula cells for safety (same as the active path)
        }
        let Some(new_val) = compute_replacement_value(
            &cell.value,
            &search,
            &search_normalized,
            &replacement,
            case_sensitive,
            match_entire_cell,
        ) else {
            continue;
        };

        previous_cells.push((row, col, Some(cell.clone())));
        let mut new_cell = cell;
        new_cell.value = new_val;
        grid.set_cell(row, col, new_cell);
        replacement_count += 1;
    }

    if replacement_count > 0 {
        undo_stack.begin_transaction(format!(
            "Replace All: '{}' -> '{}' ({} cells)",
            search, replacement, replacement_count
        ));
        undo_stack.record_custom_restore(
            "script_grid_cells".to_string(),
            crate::undo_commands::script_grid_cells_snapshot_bytes(target, previous_cells),
            "Replace All",
        );
        undo_stack.commit_transaction();
    }

    drop(undo_stack);
    drop(styles);
    drop(grids);

    // Dependent formulas (on the target sheet or anywhere referencing it)
    // recalculate now.
    if replacement_count > 0 {
        crate::commands::data::recalc_after_off_sheet_write(
            state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &[target],
        );
    }

    Ok(ReplaceResult {
        updated_cells: Vec::new(),
        replacement_count,
    })
}

/// Replace all occurrences of search text with replacement text.
/// This is an atomic operation - a single undo will revert all changes.
/// Returns the updated cells and count of replacements made.
#[tauri::command]
pub fn replace_all(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    search: String,
    replacement: String,
    case_sensitive: bool,
    match_entire_cell: bool,
    sheet_index: Option<usize>,
) -> Result<ReplaceResult, String> {
    // Wave 3: an explicit non-active target takes the off-sheet path.
    {
        let (target, active) = resolve_search_sheet(&state, sheet_index)?;
        if target != active {
            return replace_all_off_sheet(
                &state,
                &file_state,
                &user_files_state,
                &pivot_state,
                &pane_control_state,
                &ribbon_filter_state,
                target,
                search,
                replacement,
                case_sensitive,
                match_entire_cell,
            );
        }
    }
    // The match list is needed by BOTH gates below, so it is computed under a
    // short-lived read lock and the writeback guard runs with no other lock
    // held (it takes writeback_index / active_sheet / sheet_ids of its own).
    let matches = {
        let grid = state.grid.read().unwrap();
        grid.find_all(&search, case_sensitive, match_entire_cell, false)
    };

    // WRITEBACK CLAIM GUARD. Replace All rewrote matched cells straight through
    // `grid.set_cell`, never touching `update_cell_impl`. It used to SKIP
    // claimed cells and report a count nobody surfaces, which is a partial
    // mutation dressed up as success: the user is told "42 replaced" and never
    // learns which cells were left alone or why. Refused for the whole gesture
    // instead, naming the region — the same policy the sheet-protection gate
    // below already applies, and for the same reason (Replace All is ONE user
    // action). Checked against the MATCH LIST, not a bounding box, so a replace
    // that never lands in the form still runs.
    crate::calp_commands::ensure_cells_unclaimed(&state, "replace all here", &matches)?;

    // SPILL PROTECTION over the MATCH LIST (§2y). Formula cells are skipped
    // below, so the origin of an array is never rewritten here — but a spilled
    // VALUE is an ordinary non-formula cell and was being rewritten in place,
    // where typing the same character into it is refused. The write did not
    // even survive: the map still said the array owned the cell, so the next
    // recalculation of the origin restored the old value and the replacement
    // vanished with no error. Checked against the match list, and refused for
    // the whole gesture, exactly like the two guards above.
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        crate::commands::data::check_spill_protection_cells(&state, active_sheet, &matches)?;
    }

    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    // Sheet protection over the cells this replace would actually touch. Whole
    // gesture rejected, matching the batch-write policy: Replace All is one user
    // action, so applying it to the unlocked subset would silently do half a job.
    // Checked against the MATCH LIST rather than a bounding rectangle, so a
    // replace that happens to miss every locked cell still succeeds.
    //
    // Uses the BORROWED form: this command already holds `grid` and
    // `style_registry`, which the gate now needs to resolve lock state through
    // the style tiers, and std::sync::Mutex is not reentrant — the locking
    // wrapper would deadlock here. `sheet_protection` is taken last, matching
    // the canonical grid -> style_registry -> sheet_protection order.
    {
        let protection_storage = state.sheet_protection.read().unwrap();
        crate::protection::check_sheet_protection_cells_in(
            &protection_storage,
            &grid,
            &styles,
            active_sheet,
            matches.iter().copied(),
        )?;
    }

    if matches.is_empty() {
        return Ok(ReplaceResult {
            updated_cells: Vec::new(),
            replacement_count: 0,
        });
    }

    // Both gates passed and there is at least one match: the loop below rewrites cells.
    let effect = DocumentEffect::mutates(&file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);

    // Begin atomic transaction for undo
    undo_stack.begin_transaction(format!(
        "Replace All: '{}' -> '{}' ({} cells)",
        search, replacement, matches.len()
    ));

    let search_normalized = if case_sensitive {
        search.clone()
    } else {
        search.to_lowercase()
    };

    let mut updated_cells = Vec::new();
    let mut replacement_count = 0;
    // Cells whose VALUE actually changed — the recalc seeds for phase B (§2c).
    // Not the same as the match list: a match inside a formula cell is skipped,
    // and a match whose transform yields no change writes nothing.
    let mut replaced_cells: Vec<(u32, u32)> = Vec::new();

    // No per-cell writeback lookup in this loop: `ensure_cells_unclaimed` above
    // already answered for the whole match list, once, before any lock.
    for (row, col) in matches {
        // Record previous state for undo
        let previous_cell = grid.get_cell(row, col).cloned();

        if let Some(cell) = grid.get_cell(row, col).cloned() {
            // Only replace in text values, not formulas
            if cell.has_formula() {
                continue; // Skip formula cells for safety
            }

            // The value transform is shared with the off-sheet path so the two
            // can never diverge.
            let new_value = compute_replacement_value(
                &cell.value,
                &search,
                &search_normalized,
                &replacement,
                case_sensitive,
                match_entire_cell,
            );

            if let Some(new_val) = new_value {
                let mut new_cell = cell.clone();
                new_cell.value = new_val;
                
                // Record undo
                undo_stack.record_cell_change(active_sheet, row, col, previous_cell);

                // Update grid
                grid.set_cell(row, col, new_cell.clone());
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(row, col, new_cell.clone());
                }
                replaced_cells.push((row, col));

                // Get display value for frontend. Resolved against the active
                // grid (the one just written) so row/column tiers apply; the
                // cell itself keeps its own index.
                let effective_style_index = grid.effective_style_index(row, col);
                let style = styles.get(effective_style_index);
                let (display, overflow) = format_cell_value_and_class(&new_cell.value, style, &locale);

                // Get merge span info
                let merge_info = merged_regions.iter().find(|r| r.start_row == row && r.start_col == col);
                let (row_span, col_span) = if let Some(region) = merge_info {
                    (region.end_row - region.start_row + 1, region.end_col - region.start_col + 1)
                } else {
                    (1, 1)
                };

                updated_cells.push(CellData {
                    row,
                    col,
                    display,
                    overflow,
                    display_color: None,
                    formula: new_cell.formula_string().map(|f| format!("={}", f)),
                    style_index: effective_style_index,
                    row_span,
                    col_span,
                    sheet_index: None,
                    rich_text: None,
                    accounting_layout: None,
                });

                replacement_count += 1;
            }
        }
    }

    // Commit the atomic transaction
    undo_stack.commit_transaction();

    // PHASE B — dependents (§2c). The off-sheet twin `replace_all_off_sheet`
    // has always recalculated through `recalc_after_off_sheet_write`; this
    // active-sheet path recalculated nothing, so replacing on the sheet you
    // were LOOKING at left every dependent stale while replacing on one you
    // were not produced the right answer. Same asymmetry as `sort_range`.
    //
    // Locks released first — the recalc takes the same grid/style/merge/locale
    // mutexes plus the dependency maps, and std mutexes are not reentrant.
    drop(locale);
    drop(merged_regions);
    drop(undo_stack);
    drop(styles);
    drop(grids);
    drop(grid);

    if !replaced_cells.is_empty() {
        crate::commands::data::recalc_after_active_sheet_bulk_rewrite(
            &state,
            &user_files_state,
            &pane_control_state,
            &ribbon_filter_state,
            &replaced_cells,
            &mut updated_cells,
        );
    }

    Ok(ReplaceResult {
        updated_cells,
        replacement_count,
    })
}

/// Case-insensitive string replacement.
fn replace_case_insensitive(text: &str, search: &str, replacement: &str) -> String {
    if search.is_empty() {
        return text.to_string();
    }
    
    let search_lower = search.to_lowercase();
    let text_lower = text.to_lowercase();
    let mut result = String::new();
    let mut last_end = 0;
    
    for (start, _) in text_lower.match_indices(&search_lower) {
        result.push_str(&text[last_end..start]);
        result.push_str(replacement);
        last_end = start + search.len();
    }
    
    result.push_str(&text[last_end..]);
    result
}

/// Replace-Next on a NON-ACTIVE sheet (Wave 3 cross-sheet ops): same guards
/// as the active path against `grids[target]`; undo is one sheet-tagged
/// "script_grid_cells" entry.
pub(crate) fn replace_single_off_sheet(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::types::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    target: usize,
    row: u32,
    col: u32,
    search: String,
    replacement: String,
    case_sensitive: bool,
) -> Result<Option<CellData>, String> {
    crate::calp_commands::ensure_range_unclaimed_on_sheets(
        state, "replace in this cell", &[target], row, col, row, col,
    )?;

    // SPILL PROTECTION on the TARGET sheet — see `replace_all_off_sheet`.
    crate::commands::data::check_spill_protection_cells(state, target, &[(row, col)])?;

    let replaced = {
        let grids = state.grids.lock_pending().unwrap();
        let styles = state.style_registry.read().unwrap();
        let mut undo_stack = state.undo_stack.lock().unwrap();

        if target >= grids.len() {
            return Err(format!("Sheet index {} out of range", target));
        }
        let grid = &grids[target];

        // Sheet protection on the TARGET sheet (borrowed form). Reads only, and
        // it can still refuse -- so it runs under the PENDING guard, before any
        // dirty decision, without releasing the lock it was taken under.
        {
            let protection_storage = state.sheet_protection.read().unwrap();
            crate::protection::check_sheet_protection_range_in(
                &protection_storage, grid, &styles, target, row, col, row, col,
            )?;
        }

        let Some(cell) = grid.get_cell(row, col).cloned() else {
            return Ok(None);
        };
        if cell.has_formula() {
            return Ok(None);
        }

        // Single-occurrence transform, same as the active path.
        let new_value = match &cell.value {
            CellValue::Text(text) => {
                let new_text = if case_sensitive {
                    text.replacen(&search, &replacement, 1)
                } else {
                    replace_case_insensitive_once(text, &search, &replacement)
                };
                if new_text != *text { Some(CellValue::Text(new_text)) } else { None }
            }
            CellValue::Number(n) => {
                let text = if n.fract() == 0.0 { format!("{:.0}", n) } else { format!("{}", n) };
                let new_text = if case_sensitive {
                    text.replacen(&search, &replacement, 1)
                } else {
                    replace_case_insensitive_once(&text, &search, &replacement)
                };
                if new_text != text {
                    if let Ok(num) = new_text.parse::<f64>() {
                        Some(CellValue::Number(num))
                    } else {
                        Some(CellValue::Text(new_text))
                    }
                } else {
                    None
                }
            }
            _ => None,
        };

        let Some(new_val) = new_value else {
            return Ok(None);
        };

        let mut new_cell = cell.clone();
        new_cell.value = new_val;

        // A replacement really is being committed (the `return Ok(None)` paths above
        // cover "no cell", "formula cell" and "text unchanged").
        let effect = DocumentEffect::mutates(file_state);
        let mut grids = grids.authorize(&effect);
        let grid = &mut grids[target];

        undo_stack.begin_transaction("Replace".to_string());
        undo_stack.record_custom_restore(
            "script_grid_cells".to_string(),
            crate::undo_commands::script_grid_cells_snapshot_bytes(
                target,
                vec![(row, col, Some(cell))],
            ),
            "Replace",
        );
        undo_stack.commit_transaction();

        grid.set_cell(row, col, new_cell);
        true
    };

    if replaced {
        crate::commands::data::recalc_after_off_sheet_write(
            state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &[target],
        );
    }

    // No CellData payload: the active canvas shows nothing from the target
    // sheet. None doubles as "nothing to repaint" — the caller learns whether
    // a replacement happened from its own bookkeeping (the TS host counts
    // replacements from replace_all; replace_single off-sheet is a scripting
    // path where the count is 0 or 1 and the return below says which).
    Ok(Some(CellData {
        row,
        col,
        display: String::new(),
        // Empty: nothing to overflow, and text never marks.
        overflow: crate::api_types::OverflowClass::Text,
        display_color: None,
        formula: None,
        style_index: 0,
        row_span: 1,
        col_span: 1,
        sheet_index: Some(target),
        rich_text: None,
        accounting_layout: None,
    }))
}

/// Replace a single cell's content (for Replace Next functionality).
#[tauri::command]
pub fn replace_single(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    row: u32,
    col: u32,
    search: String,
    replacement: String,
    case_sensitive: bool,
    sheet_index: Option<usize>,
) -> Result<Option<CellData>, String> {
    // Wave 3: an explicit non-active target takes the off-sheet path.
    {
        let (target, active) = resolve_search_sheet(&state, sheet_index)?;
        if target != active {
            return replace_single_off_sheet(
                &state,
                &file_state,
                &user_files_state,
                &pivot_state,
                &pane_control_state,
                &ribbon_filter_state,
                target,
                row,
                col,
                search,
                replacement,
                case_sensitive,
            );
        }
    }
    // WRITEBACK CLAIM GUARD, before any lock. This used to return `Ok(None)`,
    // which is ALSO the "no match here" answer — so Replace Next walking into
    // the form looked exactly like a cell that simply did not match, and the
    // user was never told why their replacement did not happen. A replace is
    // not a drafted value-entry, so the range guard (which ignores drafts)
    // applies rather than the single-cell draft guard.
    crate::calp_commands::ensure_range_unclaimed(&state, "replace in this cell", row, col, row, col)?;

    // SPILL PROTECTION — see `replace_all`. A spilled value is a non-formula
    // cell, so it is exactly what this command is willing to rewrite, and
    // exactly what nothing else in the product lets the user rewrite.
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        crate::commands::data::check_spill_protection_cells(&state, active_sheet, &[(row, col)])?;
    }

    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    // Sheet protection (Replace on a locked cell). Borrowed form — `grid` and
    // `styles` are already held above; see the note in `replace_all`.
    {
        let protection_storage = state.sheet_protection.read().unwrap();
        crate::protection::check_sheet_protection_range_in(
            &protection_storage, &grid, &styles, active_sheet, row, col, row, col,
        )?;
    }

    let previous_cell = grid.get_cell(row, col).cloned();
    
    if let Some(cell) = previous_cell.clone() {
        // Skip formula cells
        if cell.has_formula() {
            return Ok(None);
        }

        let new_value = match &cell.value {
            CellValue::Text(text) => {
                let new_text = if case_sensitive {
                    text.replacen(&search, &replacement, 1)
                } else {
                    replace_case_insensitive_once(text, &search, &replacement)
                };
                
                if new_text != *text {
                    Some(CellValue::Text(new_text))
                } else {
                    None
                }
            }
            CellValue::Number(n) => {
                let text = if n.fract() == 0.0 {
                    format!("{:.0}", n)
                } else {
                    format!("{}", n)
                };
                
                let new_text = if case_sensitive {
                    text.replacen(&search, &replacement, 1)
                } else {
                    replace_case_insensitive_once(&text, &search, &replacement)
                };
                
                if new_text != text {
                    if let Ok(num) = new_text.parse::<f64>() {
                        Some(CellValue::Number(num))
                    } else {
                        Some(CellValue::Text(new_text))
                    }
                } else {
                    None
                }
            }
            _ => None,
        };

        if let Some(new_val) = new_value {
            let mut new_cell = cell.clone();
            new_cell.value = new_val;

            // Only here: a formula cell or an unchanged value returns without writing.
            let effect = DocumentEffect::mutates(&file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);

            // Record undo
            undo_stack.record_cell_change(active_sheet, row, col, previous_cell);
            
            // Update grid
            grid.set_cell(row, col, new_cell.clone());
            if active_sheet < grids.len() {
                grids[active_sheet].set_cell(row, col, new_cell.clone());
            }

            let effective_style_index = grid.effective_style_index(row, col);
            let style = styles.get(effective_style_index);
            let (display, overflow) = format_cell_value_and_class(&new_cell.value, style, &locale);

            // Get merge span info
            let merge_info = merged_regions.iter().find(|r| r.start_row == row && r.start_col == col);
            let (row_span, col_span) = if let Some(region) = merge_info {
                (region.end_row - region.start_row + 1, region.end_col - region.start_col + 1)
            } else {
                (1, 1)
            };

            let replaced = CellData {
                row,
                col,
                display,
                overflow,
                display_color: None,
                formula: new_cell.formula_string().map(|f| format!("={}", f)),
                style_index: effective_style_index,
                row_span,
                col_span,
                sheet_index: None,
                rich_text: None,
                accounting_layout: None,
            };

            // PHASE B — dependents (§2c), matching `replace_single_off_sheet`,
            // which has always recalculated. Locks released first: the recalc
            // takes the same mutexes and std mutexes are not reentrant. The
            // re-evaluated dependents are written to the grid but not returned
            // — this command's contract is one `CellData` for the replaced
            // cell, and the caller refreshes the viewport.
            drop(locale);
            drop(merged_regions);
            drop(undo_stack);
            drop(styles);
            drop(grids);
            drop(grid);

            let mut recalculated = Vec::new();
            crate::commands::data::recalc_after_active_sheet_bulk_rewrite(
                &state,
                &user_files_state,
                &pane_control_state,
                &ribbon_filter_state,
                &[(row, col)],
                &mut recalculated,
            );

            return Ok(Some(replaced));
        }
    }

    Ok(None)
}

/// Case-insensitive replacement of first occurrence only.
fn replace_case_insensitive_once(text: &str, search: &str, replacement: &str) -> String {
    if search.is_empty() {
        return text.to_string();
    }
    
    let search_lower = search.to_lowercase();
    let text_lower = text.to_lowercase();
    
    if let Some(start) = text_lower.find(&search_lower) {
        let mut result = String::new();
        result.push_str(&text[..start]);
        result.push_str(replacement);
        result.push_str(&text[start + search.len()..]);
        result
    } else {
        text.to_string()
    }
}
