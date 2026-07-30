//! FILENAME: app/src-tauri/src/commands/structure.rs
// PURPOSE: Complex logic for inserting and deleting rows/columns and updating references.

use crate::api_types::CellData;
use crate::commands::utils::get_cell_internal_with_merge;
use crate::AppState;
use crate::persistence::FileState;
use crate::pivot::types::PivotState;
use engine::{Cell, GridSnapshot, UndoMergeRegion};
use once_cell::sync::Lazy;

use regex::Regex;
use std::collections::HashMap;
use tauri::State;

// Pre-compiled regexes for formula reference shifting (avoids ~2.6ms per Regex::new call)
// Group 1 in each of these is a captured LEADING DELIMITER (re-emitted by the
// rewrite closures), and the column part is capped at 3 letters — Excel's last
// column is XFD. Without both, `Sheet1` matched as column "Sheet" row 1 and
// `LOG10` as column LOG row 10. The RIGHT edge is guarded non-consumingly by
// `replace_all_guarded` (13 built-in functions end in digits: LOG10, BIN2DEC,
// OCT2HEX, ... — `=LOG10(A5)` must not become `=LOG11(A6)` on a fill or shift).
static CELL_REF_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(^|[^A-Za-z0-9_.])(\$?)([A-Za-z]{1,3})(\$?)(\d+)").unwrap());
static ROW_RANGE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(^|[^A-Za-z0-9_.:$])(\$?)(\d+):(\$?)(\d+)").unwrap());
static COL_RANGE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(^|[^A-Za-z0-9_.:])(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})").unwrap());
static CELL_RANGE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(^|[^A-Za-z0-9_.])(\$?)([A-Za-z]{1,3})(\$?)(\d+):(\$?)([A-Za-z]{1,3})(\$?)(\d+)")
        .unwrap()
});

/// Capture a snapshot of the current grid state for undo.
fn capture_grid_snapshot(state: &AppState) -> GridSnapshot {
    let grid = state.grid.lock().unwrap();
    let row_heights = state.row_heights.lock().unwrap();
    let column_widths = state.column_widths.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    GridSnapshot {
        cells: grid.cells.clone(),
        row_heights: row_heights.clone(),
        column_widths: column_widths.clone(),
        merged_regions: merged_regions
            .iter()
            .map(|r| UndoMergeRegion {
                start_row: r.start_row,
                start_col: r.start_col,
                end_row: r.end_row,
                end_col: r.end_col,
            })
            .collect(),
        max_row: grid.max_row,
        max_col: grid.max_col,
        row_styles: grid.row_styles.iter().map(|(k, v)| (*k, *v)).collect(),
        column_styles: grid.column_styles.iter().map(|(k, v)| (*k, *v)).collect(),
    }
}

/// ============================================================================
// PROTECTED REGION SHIFT HELPERS
// ============================================================================

/// Realign report definitions with their (already coordinate-shifted) protected
/// regions and drop definitions whose region was removed, then persist. A report
/// definition mirrors its region exactly (anchor = region start, bounds = region
/// end), so after a generic region shift this brings the definition store — the
/// source of truth for the NEXT refresh's destination — back in sync. Without it
/// a refresh would re-materialize the report at its pre-shift coordinates.
fn sync_report_definitions_to_regions(state: &AppState) {
    let report_regions: Vec<_> = {
        let regions = state.protected_regions.lock().unwrap();
        regions
            .iter()
            .filter(|r| r.region_type == "report")
            .map(|r| (r.owner_id, r.sheet_index, r.start_row, r.start_col, r.end_row, r.end_col))
            .collect()
    };
    {
        let mut defs = state.report_definitions.lock().unwrap();
        defs.retain(|d| report_regions.iter().any(|(id, ..)| *id == d.id));
        for d in defs.iter_mut() {
            if let Some((_, sheet, sr, sc, er, ec)) =
                report_regions.iter().find(|(id, ..)| *id == d.id)
            {
                d.sheet_index = *sheet;
                d.anchor_row = *sr;
                d.anchor_col = *sc;
                d.end_row = *er;
                d.end_col = *ec;
            }
        }
    }
    crate::report::sync_reports_to_extension_data(state);
}

/// Shift protected regions when rows are inserted.
/// Coordinate shifts apply to ALL regions; pivot definition updates apply only to pivot regions.
fn shift_pivot_regions_for_row_insert(state: &AppState, pivot_state: &PivotState, from_row: u32, count: u32, sheet_index: usize) {
    let mut regions = state.protected_regions.lock().unwrap();
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();

    for region in regions.iter_mut() {
        if region.sheet_index != sheet_index {
            continue;
        }

        // Shift region coordinates if at or below insertion point (generic for all regions)
        if region.start_row >= from_row {
            region.start_row += count;
            region.end_row += count;
        } else if region.end_row >= from_row {
            // Region spans the insertion point - expand it
            region.end_row += count;
        }

        // Pivot-specific: also update the pivot definition's destination
        if region.region_type == "pivot" {
            let pid = region.owner_id;
            if let Some((definition, _)) = pivot_tables.get_mut(&pid) {
                let (dest_row, dest_col) = definition.destination;
                if dest_row >= from_row {
                    definition.destination = (dest_row + count, dest_col);
                }

                let (src_start_row, src_start_col) = definition.source_start;
                let (src_end_row, src_end_col) = definition.source_end;

                if src_start_row >= from_row {
                    definition.source_start = (src_start_row + count, src_start_col);
                }
                if src_end_row >= from_row {
                    definition.source_end = (src_end_row + count, src_end_col);
                } else if src_end_row >= from_row {
                    definition.source_end = (src_end_row + count, src_end_col);
                }
            }
        }
    }

    // Report-specific: realign report definitions with their shifted regions.
    drop(pivot_tables);
    drop(regions);
    sync_report_definitions_to_regions(state);
}

/// Shift protected regions when columns are inserted.
fn shift_pivot_regions_for_col_insert(state: &AppState, pivot_state: &PivotState, from_col: u32, count: u32, sheet_index: usize) {
    let mut regions = state.protected_regions.lock().unwrap();
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();

    for region in regions.iter_mut() {
        if region.sheet_index != sheet_index {
            continue;
        }

        // Shift region coordinates (generic for all regions)
        if region.start_col >= from_col {
            region.start_col += count;
            region.end_col += count;
        } else if region.end_col >= from_col {
            region.end_col += count;
        }

        // Pivot-specific: update the pivot definition's destination
        if region.region_type == "pivot" {
            let pid = region.owner_id;
            if let Some((definition, _)) = pivot_tables.get_mut(&pid) {
                let (dest_row, dest_col) = definition.destination;
                if dest_col >= from_col {
                    definition.destination = (dest_row, dest_col + count);
                }

                let (src_start_row, src_start_col) = definition.source_start;
                let (src_end_row, src_end_col) = definition.source_end;

                if src_start_col >= from_col {
                    definition.source_start = (src_start_row, src_start_col + count);
                }
                if src_end_col >= from_col {
                    definition.source_end = (src_end_row, src_end_col + count);
                } else if src_end_col >= from_col {
                    definition.source_end = (src_end_row, src_end_col + count);
                }
            }
        }
    }

    // Report-specific: realign report definitions with their shifted regions.
    drop(pivot_tables);
    drop(regions);
    sync_report_definitions_to_regions(state);
}

/// Shift protected regions when rows are deleted.
fn shift_pivot_regions_for_row_delete(state: &AppState, pivot_state: &PivotState, from_row: u32, count: u32, sheet_index: usize) {
    let mut regions = state.protected_regions.lock().unwrap();
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();

    // Collect IDs of regions fully within the deleted range
    let mut regions_to_remove: Vec<String> = Vec::new();

    for region in regions.iter_mut() {
        if region.sheet_index != sheet_index {
            continue;
        }

        let delete_end = from_row + count;

        // Check if region is fully within deleted range
        if region.start_row >= from_row && region.end_row < delete_end {
            regions_to_remove.push(region.id.clone());
            continue;
        }

        // Shift region coordinates (generic for all regions)
        if region.start_row >= delete_end {
            region.start_row -= count;
            region.end_row -= count;
        } else if region.start_row >= from_row {
            region.start_row = from_row;
            region.end_row -= count;
        } else if region.end_row >= delete_end {
            region.end_row -= count;
        } else if region.end_row >= from_row {
            region.end_row = from_row.saturating_sub(1);
        }

        // Pivot-specific: update definition
        if region.region_type == "pivot" {
            let pid = region.owner_id;
            if let Some((definition, _)) = pivot_tables.get_mut(&pid) {
                let (dest_row, dest_col) = definition.destination;
                if dest_row >= delete_end {
                    definition.destination = (dest_row - count, dest_col);
                } else if dest_row >= from_row {
                    definition.destination = (from_row, dest_col);
                }

                let (src_start_row, src_start_col) = definition.source_start;
                let (src_end_row, src_end_col) = definition.source_end;

                let new_start_row = if src_start_row >= delete_end {
                    src_start_row - count
                } else if src_start_row >= from_row {
                    from_row
                } else {
                    src_start_row
                };

                let new_end_row = if src_end_row >= delete_end {
                    src_end_row - count
                } else if src_end_row >= from_row {
                    from_row.saturating_sub(1).max(new_start_row)
                } else {
                    src_end_row
                };

                definition.source_start = (new_start_row, src_start_col);
                definition.source_end = (new_end_row, src_end_col);
            }
        }
    }

    // Remove fully deleted regions and their associated pivot data
    for region_id in &regions_to_remove {
        if let Some(region) = regions.iter().find(|r| &r.id == region_id) {
            if region.region_type == "pivot" {
                let pid = region.owner_id;
                pivot_tables.remove(&pid);
            }
        }
    }
    regions.retain(|r| !regions_to_remove.contains(&r.id));

    // Report-specific: realign report definitions with their shifted regions
    // (definitions whose region was fully deleted are dropped).
    drop(pivot_tables);
    drop(regions);
    sync_report_definitions_to_regions(state);
}

/// ============================================================================
// TABLE BOUNDARY SHIFT HELPERS
// ============================================================================

/// Shift table boundaries when rows are inserted.
/// Tables entirely below the insertion point are shifted down.
/// Tables spanning the insertion point (including at start_row) expand.
fn shift_table_boundaries_for_row_insert(state: &AppState, from_row: u32, count: u32, sheet_index: usize) {
    let mut tables = state.tables.lock().unwrap();

    if let Some(sheet_tables) = tables.get_mut(&sheet_index) {
        for table in sheet_tables.values_mut() {
            if table.start_row > from_row {
                // Insertion is strictly before the table - shift entire table down
                table.start_row += count;
                table.end_row += count;
            } else if table.end_row >= from_row {
                // Insertion is inside the table (including at start_row) - expand
                table.end_row += count;
            }
        }
    }
}

/// Shift table boundaries when columns are inserted.
/// Tables entirely to the right of the insertion point are shifted right.
/// Tables spanning the insertion point (including at start_col) expand.
fn shift_table_boundaries_for_col_insert(state: &AppState, from_col: u32, count: u32, sheet_index: usize) {
    let mut tables = state.tables.lock().unwrap();

    if let Some(sheet_tables) = tables.get_mut(&sheet_index) {
        for table in sheet_tables.values_mut() {
            if table.start_col > from_col {
                // Insertion is strictly before the table - shift entire table right
                table.start_col += count;
                table.end_col += count;
            } else if table.end_col >= from_col {
                // Insertion is inside the table (including at start_col) - expand
                table.end_col += count;
            }
        }
    }
}

/// Shift table boundaries when rows are deleted.
/// Tables fully within the deleted range are removed.
fn shift_table_boundaries_for_row_delete(state: &AppState, from_row: u32, count: u32, sheet_index: usize) {
    let mut tables = state.tables.lock().unwrap();
    let mut table_names = state.table_names.lock().unwrap();

    let delete_end = from_row + count;

    if let Some(sheet_tables) = tables.get_mut(&sheet_index) {
        // Collect IDs of tables to remove (fully within deleted range)
        let to_remove: Vec<identity::EntityId> = sheet_tables
            .values()
            .filter(|t| t.start_row >= from_row && t.end_row < delete_end)
            .map(|t| t.id)
            .collect();

        // Remove from name registry
        for id in &to_remove {
            if let Some(table) = sheet_tables.get(id) {
                table_names.remove(&table.name.to_uppercase());
            }
        }

        // Remove fully deleted tables
        for id in &to_remove {
            sheet_tables.remove(id);
        }

        // Shift remaining table boundaries
        for table in sheet_tables.values_mut() {
            if table.start_row >= delete_end {
                // Entire table is below deleted range - shift up
                table.start_row -= count;
                table.end_row -= count;
            } else if table.start_row >= from_row {
                // Table starts within deleted range but extends beyond - shrink from top
                table.start_row = from_row;
                table.end_row -= count;
            } else if table.end_row >= delete_end {
                // Table spans entire deleted range - shrink
                table.end_row -= count;
            } else if table.end_row >= from_row {
                // Table end is within deleted range - shrink from bottom
                table.end_row = from_row.saturating_sub(1);
            }
        }
    }
}

/// Shift table boundaries when columns are deleted.
/// Tables fully within the deleted range are removed.
fn shift_table_boundaries_for_col_delete(state: &AppState, from_col: u32, count: u32, sheet_index: usize) {
    let mut tables = state.tables.lock().unwrap();
    let mut table_names = state.table_names.lock().unwrap();

    let delete_end = from_col + count;

    if let Some(sheet_tables) = tables.get_mut(&sheet_index) {
        // Collect IDs of tables to remove (fully within deleted range)
        let to_remove: Vec<identity::EntityId> = sheet_tables
            .values()
            .filter(|t| t.start_col >= from_col && t.end_col < delete_end)
            .map(|t| t.id)
            .collect();

        // Remove from name registry
        for id in &to_remove {
            if let Some(table) = sheet_tables.get(id) {
                table_names.remove(&table.name.to_uppercase());
            }
        }

        // Remove fully deleted tables
        for id in &to_remove {
            sheet_tables.remove(id);
        }

        // Shift remaining table boundaries and truncate columns
        for table in sheet_tables.values_mut() {
            if table.start_col >= delete_end {
                // Entire table is right of deleted range - shift left
                table.start_col -= count;
                table.end_col -= count;
            } else if table.start_col >= from_col {
                // Table starts within deleted range but extends beyond - shrink from left
                let cols_removed = (delete_end - table.start_col) as usize;
                // Remove columns from the beginning
                for _ in 0..cols_removed.min(table.columns.len()) {
                    table.columns.remove(0);
                }
                table.start_col = from_col;
                table.end_col -= count;
            } else if table.end_col >= delete_end {
                // Table spans entire deleted range - shrink and remove middle columns
                let first_col_idx = (from_col - table.start_col) as usize;
                let cols_to_remove = count as usize;
                for _ in 0..cols_to_remove.min(table.columns.len().saturating_sub(first_col_idx)) {
                    if first_col_idx < table.columns.len() {
                        table.columns.remove(first_col_idx);
                    }
                }
                table.end_col -= count;
            } else if table.end_col >= from_col {
                // Table end is within deleted range - shrink from right
                let cols_to_remove = (table.end_col - from_col + 1) as usize;
                let keep_count = table.columns.len().saturating_sub(cols_to_remove);
                table.columns.truncate(keep_count);
                table.end_col = from_col.saturating_sub(1);
            }
        }
    }
}

/// Move the FLAT `(sheet, row, col)`-keyed SPILL tracking through a structural
/// edit.
///
/// The spill pair (`spill_hosts`: spill cell -> origin; `spill_ranges`: origin
/// -> its spill cells) must move IN LOCKSTEP, keys and values, or the two sides
/// disagree about which cells a formula owns — which both lets a write clobber
/// a live spill area and falsely blocks writes on vacated cells. Note the
/// DELETE paths already refuse an edit that would partially break a spill
/// range; this handles the cases they allow, and inserts, which were unguarded.
///
/// Records no undo entry: the spill maps are session-only derived state
/// (persistence clears them on load and nothing rebuilds them from disk).
///
/// ON-GRID CONTROLS ARE NOT SHIFTED HERE — they are handled by
/// `shift_controls`, which moves the cell key and the object-script instance id
/// together. Doing the key alone here would rename a control out from under its
/// script, which is why this function skipped them.
fn shift_flat_cell_stores(
    state: &AppState,
    sheet_index: usize,
    edit: calp::writeback::StructuralEdit,
) {
    use crate::commands::coord_shift::{shift_coord_pair, shift_flat_cell_map};

    // spill_hosts: value is the ORIGIN cell of the spill that owns this cell.
    if let Ok(mut hosts) = state.spill_hosts.lock() {
        let mut orphaned = false;
        shift_flat_cell_map(&mut hosts, sheet_index, edit, |origin, e| {
            if !shift_coord_pair(origin, e) {
                orphaned = true;
            }
        });
        if orphaned {
            // The origin was deleted, so every cell claiming it is meaningless.
            // Cheaper and safer to drop the whole sheet's tracking than to keep
            // entries pointing at a formula that no longer exists.
            hosts.retain(|&(sheet, _, _), _| sheet != sheet_index);
        }
    }

    // spill_ranges: value is the LIST of cells this origin spilled into.
    if let Ok(mut ranges) = state.spill_ranges.lock() {
        shift_flat_cell_map(&mut ranges, sheet_index, edit, |cells, e| {
            cells.retain_mut(|c| shift_coord_pair(c, e));
        });
    }
}

/// Move every per-sheet RANGE-keyed store through a structural edit.
///
/// Conditional formats and data validations remember RECTANGLES rather than
/// single cells, so they need [`coord_shift::shift_range`] rather than
/// `shift_cell` — but the failure was the same: insert a row above a formatted
/// range and the highlight stayed on the old rows, now colouring different data.
///
/// A rule/validation whose every range was deleted is dropped entirely.
///
/// The caller must already hold the undo-stack lock inside `begin_transaction`.
fn shift_per_sheet_range_stores(
    state: &AppState,
    undo_stack: &mut engine::UndoStack,
    sheet_index: usize,
    edit: calp::writeback::StructuralEdit,
) {
    use crate::commands::coord_shift::{shift_range, CellRange};

    // --- Conditional formats: each rule owns a LIST of ranges. ---
    if let Ok(mut store) = state.conditional_formats.lock() {
        if let Some(rules) = store.get_mut(&sheet_index) {
            if !rules.is_empty() {
                let previous = rules.clone();
                let mut changed = false;

                rules.retain_mut(|rule| {
                    let before_len = rule.ranges.len();
                    rule.ranges.retain_mut(|r| {
                        let shifted = shift_range(
                            CellRange {
                                start_row: r.start_row,
                                end_row: r.end_row,
                                start_col: r.start_col,
                                end_col: r.end_col,
                            },
                            edit,
                        );
                        match shifted {
                            Some(n) => {
                                if (n.start_row, n.end_row, n.start_col, n.end_col)
                                    != (r.start_row, r.end_row, r.start_col, r.end_col)
                                {
                                    changed = true;
                                    r.start_row = n.start_row;
                                    r.end_row = n.end_row;
                                    r.start_col = n.start_col;
                                    r.end_col = n.end_col;
                                }
                                true
                            }
                            None => {
                                changed = true;
                                false
                            }
                        }
                    });
                    if rule.ranges.len() != before_len {
                        changed = true;
                    }
                    // A rule with no ranges left applies to nothing.
                    if rule.ranges.is_empty() {
                        // Mark changed even when the rule ARRIVED range-less:
                        // the retain below still drops it, and without this the
                        // undo entry is skipped and the rule is unrecoverable.
                        changed = true;
                        return false;
                    }
                    true
                });

                if changed {
                    undo_stack.record_custom_restore(
                        "obj_conditional_formats".to_string(),
                        crate::undo_commands::conditional_formats_snapshot_bytes(
                            sheet_index,
                            previous,
                        ),
                        "Shift conditional formats",
                    );
                }
            }
        }
    }

    // --- Allow-edit ranges: the exceptions carved out of sheet protection. ---
    //
    // Arithmetic and fail-safe drop rule live in
    // [`coord_shift::shift_allow_edit_ranges`]; this is the wiring.
    if let Ok(mut store) = state.sheet_protection.lock() {
        if let Some(protection) = store.get_mut(&sheet_index) {
            if !protection.allow_edit_ranges.is_empty() {
                // Snapshot ONLY the ranges — never the whole record. The
                // sheet-level `protected` flag / password / options are not
                // undo-tracked by the protection commands, so capturing them
                // here would make undo of this edit silently revert protection
                // changes the author made afterwards.
                let previous_ranges = protection.allow_edit_ranges.clone();

                if crate::commands::coord_shift::shift_allow_edit_ranges(
                    &mut protection.allow_edit_ranges,
                    edit,
                ) {
                    undo_stack.record_custom_restore(
                        "obj_sheet_protection".to_string(),
                        crate::undo_commands::sheet_protection_snapshot_bytes(
                            sheet_index,
                            previous_ranges,
                        ),
                        "Shift allow-edit ranges",
                    );
                }
            }
        }
    }

    // --- Data validations: one range each. ---
    if let Ok(mut store) = state.data_validations.lock() {
        if let Some(ranges) = store.get_mut(&sheet_index) {
            if !ranges.is_empty() {
                let previous = ranges.clone();
                let mut changed = false;

                ranges.retain_mut(|v| {
                    let shifted = shift_range(
                        CellRange {
                            start_row: v.start_row,
                            end_row: v.end_row,
                            start_col: v.start_col,
                            end_col: v.end_col,
                        },
                        edit,
                    );
                    match shifted {
                        Some(n) => {
                            if (n.start_row, n.end_row, n.start_col, n.end_col)
                                != (v.start_row, v.end_row, v.start_col, v.end_col)
                            {
                                changed = true;
                                v.start_row = n.start_row;
                                v.end_row = n.end_row;
                                v.start_col = n.start_col;
                                v.end_col = n.end_col;
                            }
                            true
                        }
                        None => {
                            changed = true;
                            false
                        }
                    }
                });

                if changed {
                    undo_stack.record_custom_restore(
                        "obj_validation".to_string(),
                        crate::undo_commands::validation_snapshot_bytes(sheet_index, previous),
                        "Shift data validations",
                    );
                }
            }
        }
    }
}

/// Move the ACTIVE sheet's merged regions through a structural edit.
///
/// Deliberately records NO undo entry: `capture_grid_snapshot` (the first
/// statement of every structural command) already copies the whole merge set
/// into the `GridSnapshot`, and undo restores it wholesale. Adding a second
/// restore would double-apply against that snapshot in the same transaction.
/// For the same reason this MUST run after `capture_grid_snapshot`, or the
/// snapshot would capture post-shift geometry and undo would be a no-op.
///
/// Only the active-sheet mirror is touched — `all_merged_regions[active]` is
/// stale by design until the next sheet switch.
fn shift_merged_regions(state: &AppState, edit: calp::writeback::StructuralEdit) {
    use crate::commands::coord_shift::{shift_range, CellRange};

    let Ok(mut merges) = state.merged_regions.lock() else {
        return;
    };
    if merges.is_empty() {
        return;
    }

    let shifted: std::collections::HashSet<crate::api_types::MergedRegion> = merges
        .iter()
        .filter_map(|m| {
            let n = shift_range(
                CellRange {
                    start_row: m.start_row,
                    end_row: m.end_row,
                    start_col: m.start_col,
                    end_col: m.end_col,
                },
                edit,
            )?;
            // A merge that shrank to a single cell must be DROPPED, not kept:
            // `merge_cells` refuses to create a 1x1, the renderer skips spans
            // of 1 so it would be invisible, yet it would still block future
            // merges over that cell and make xlsx export fail.
            if n.start_row == n.end_row && n.start_col == n.end_col {
                return None;
            }
            Some(crate::api_types::MergedRegion {
                start_row: n.start_row,
                end_row: n.end_row,
                start_col: n.start_col,
                end_col: n.end_col,
            })
        })
        .collect();

    *merges = shifted;
}

/// Move every per-sheet CELL-KEYED store through a structural edit, recording
/// each one's pre-shift contents into the caller's already-open transaction.
///
/// Comments, notes, hyperlinks and cell protection all remember a cell POSITION
/// and none of them moved with the grid: insert a row above a commented cell
/// and the comment stayed put, so it annotated whatever value slid into that
/// position. Delete the row and the comment survived on an unrelated cell.
/// They share one shape, so they share one shift — see
/// `commands::coord_shift`, which owns the arithmetic.
///
/// The caller must already hold the undo-stack lock inside `begin_transaction`.
fn shift_per_sheet_cell_stores(
    state: &AppState,
    undo_stack: &mut engine::UndoStack,
    sheet_index: usize,
    edit: calp::writeback::StructuralEdit,
) {
    use crate::commands::coord_shift::shift_per_sheet_cell_map;

    macro_rules! shift_store {
        ($lock:expr, $kind:literal, $label:literal) => {
            if let Ok(mut store) = $lock {
                let previous: Vec<((u32, u32), _)> = store
                    .get(&sheet_index)
                    .map(|m| m.iter().map(|(k, v)| (*k, v.clone())).collect())
                    .unwrap_or_default();
                if shift_per_sheet_cell_map(&mut store, sheet_index, edit) {
                    undo_stack.record_custom_restore(
                        $kind.to_string(),
                        crate::undo_commands::sheet_cell_map_snapshot_bytes(
                            sheet_index,
                            previous,
                        ),
                        $label,
                    );
                }
            }
        };
    }

    shift_store!(state.comments.lock(), "obj_comments", "Shift comments");
    shift_store!(state.notes.lock(), "obj_notes", "Shift notes");
    shift_store!(state.hyperlinks.lock(), "obj_hyperlinks", "Shift hyperlinks");
    // Cell protection is NOT shifted here any more, and needs no replacement:
    // lock state now rides on `Cell.style_index`, which moves with the cell
    // itself when rows or columns are inserted or deleted.
}

/// Shift the row/column default-style tiers through a structural edit.
///
/// These are keyed by row/column INDEX, so an insert or delete renumbers them
/// exactly like any other coordinate-anchored store: without this, inserting a
/// row above a styled row leaves the style on the wrong row, and a formatted
/// column drifts one column left after a delete.
///
/// Records NO undo entry, deliberately — `capture_grid_snapshot` takes the
/// tiers (as it does merged regions) and undo restores them wholesale, so a
/// second restore would double-apply within the same transaction. For the same
/// reason this MUST run AFTER the snapshot is captured.
/// Takes the grids BORROWED: the structure commands hold both `state.grid` and
/// `state.grids` when they call this, and `std::sync::Mutex` is not reentrant.
fn shift_style_tiers(
    grid: &mut engine::Grid,
    grids: &mut [engine::Grid],
    sheet_index: usize,
    edit: calp::writeback::StructuralEdit,
) {
    use calp::writeback::{interval_delete, interval_insert, StructuralEdit as SE};

    // Only the matching axis moves: row edits renumber rows, column edits
    // renumber columns.
    let shift_axis = |map: &std::collections::HashMap<u32, usize>,
                      at: u32,
                      count: u32,
                      inserting: bool| {
        let mut out: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
        for (&idx, &style) in map.iter() {
            // Reuse the shared 1-D interval math by treating the single index
            // as a degenerate [idx, idx] interval — same rule the cell and
            // range shifts use, so a tier can never drift differently.
            let moved = if inserting {
                Some(interval_insert(idx, idx, at, count))
            } else {
                interval_delete(idx, idx, at, count)
            };
            if let Some((start, _end)) = moved {
                out.insert(start, style);
            }
            // `None` = the row/column itself was deleted; its tier goes with it.
        }
        out
    };

    let apply = |grid: &mut engine::Grid| match edit {
        SE::RowInsert { at, count } => {
            grid.row_styles = shift_axis(&grid.row_styles.iter().map(|(k, v)| (*k, *v)).collect(), at, count, true)
                .into_iter().collect();
        }
        SE::RowDelete { at, count } => {
            grid.row_styles = shift_axis(&grid.row_styles.iter().map(|(k, v)| (*k, *v)).collect(), at, count, false)
                .into_iter().collect();
        }
        SE::ColInsert { at, count } => {
            grid.column_styles = shift_axis(&grid.column_styles.iter().map(|(k, v)| (*k, *v)).collect(), at, count, true)
                .into_iter().collect();
        }
        SE::ColDelete { at, count } => {
            grid.column_styles = shift_axis(&grid.column_styles.iter().map(|(k, v)| (*k, *v)).collect(), at, count, false)
                .into_iter().collect();
        }
    };

    apply(grid);
    // Both mirrors, or the tier becomes invisible to readers that resolve
    // against `grids[active_sheet]`.
    if let Some(g) = grids.get_mut(sheet_index) {
        apply(g);
    }
}

/// Track the sheet's AutoFilter through a structural edit, recording the
/// pre-shift filter into the caller's already-open undo transaction.
///
/// AutoFilters were the last coordinate-anchored per-sheet object that
/// structure edits ignored: inserting a row above a filtered table left the
/// filter spanning the wrong rows, painted chevrons on a row that is no longer
/// the header, and (since ownership is re-derived from geometry on reload)
/// could permanently unlink the filter from the table that owns it.
///
/// `column_filters` is keyed RELATIVE to `start_col`, so a column edit that
/// moves the origin must re-key the criteria — the same rule `resize_table`
/// follows. Criteria for columns the edit deleted are dropped.
///
/// The caller must already hold the undo-stack lock inside `begin_transaction`.
fn shift_sheet_auto_filter(
    state: &AppState,
    undo_stack: &mut engine::UndoStack,
    sheet_index: usize,
    edit: calp::writeback::StructuralEdit,
) {
    let Ok(mut auto_filters) = state.auto_filters.lock() else {
        return;
    };
    let Some(af) = auto_filters.get_mut(&sheet_index) else {
        return;
    };

    let before = af.clone();
    let old_start_col = af.start_col;

    // Reuse the SAME 1-D interval math the writeback-region shift uses, so
    // there is one implementation (and one exhaustive no-inversion test) rather
    // than a second hand-rolled copy of the branch table.
    use calp::writeback::{interval_delete, interval_insert, StructuralEdit};
    match edit {
        StructuralEdit::RowInsert { at, count } => {
            let (s, e) = interval_insert(af.start_row, af.end_row, at, count);
            af.start_row = s;
            af.end_row = e;
        }
        StructuralEdit::ColInsert { at, count } => {
            let (s, e) = interval_insert(af.start_col, af.end_col, at, count);
            af.start_col = s;
            af.end_col = e;
        }
        StructuralEdit::RowDelete { at, count } => {
            match interval_delete(af.start_row, af.end_row, at, count) {
                Some((s, e)) => {
                    af.start_row = s;
                    af.end_row = e;
                }
                None => {
                    // Every row of the filter is gone, header included.
                    auto_filters.remove(&sheet_index);
                    drop(auto_filters);
                    record_auto_filter_shift(undo_stack, sheet_index, before);
                    return;
                }
            }
        }
        StructuralEdit::ColDelete { at, count } => {
            match interval_delete(af.start_col, af.end_col, at, count) {
                Some((s, e)) => {
                    af.start_col = s;
                    af.end_col = e;
                }
                None => {
                    auto_filters.remove(&sheet_index);
                    drop(auto_filters);
                    record_auto_filter_shift(undo_stack, sheet_index, before);
                    return;
                }
            }
        }
    }

    // Re-key criteria whenever the column origin moved, and drop any whose
    // column no longer exists inside the filter.
    if af.start_col != old_start_col || !af.column_filters.is_empty() {
        let new_start = af.start_col;
        let new_end = af.end_col;
        let remapped: std::collections::HashMap<u32, crate::autofilter::ColumnFilter> = before
            .column_filters
            .iter()
            .filter_map(|(rel, cf)| {
                let abs = old_start_col + rel;
                // Follow the column edit for the absolute position too.
                let abs = match edit {
                    calp::writeback::StructuralEdit::ColInsert { at, count } if abs >= at => {
                        abs + count
                    }
                    calp::writeback::StructuralEdit::ColDelete { at, count } => {
                        if abs >= at.saturating_add(count) {
                            abs - count
                        } else if abs >= at {
                            return None; // The column itself was deleted.
                        } else {
                            abs
                        }
                    }
                    _ => abs,
                };
                if abs < new_start || abs > new_end {
                    return None;
                }
                let new_rel = abs - new_start;
                let mut moved = cf.clone();
                moved.column_index = new_rel;
                Some((new_rel, moved))
            })
            .collect();
        af.column_filters = remapped;
    }

    // Hidden rows are positional, so a ROW edit at or above the filter's last
    // row invalidates them and they are cheapest to drop — keeping a stale set
    // would hide the wrong data rows, which is worse than showing all of them.
    //
    // Anything else must NOT touch them. Clearing unconditionally silently
    // un-filtered the sheet for edits that provably cannot move a filtered row
    // (any column edit; a row edit entirely below the filter), leaving the
    // criteria active with nothing hidden and no recompute anywhere to restore
    // it — `recompute_hidden_rows` only runs from the filter-mutating commands.
    let rows_invalidated = match edit {
        StructuralEdit::RowInsert { at, .. } | StructuralEdit::RowDelete { at, .. } => {
            at <= before.end_row
        }
        StructuralEdit::ColInsert { .. } | StructuralEdit::ColDelete { .. } => false,
    };
    if rows_invalidated {
        af.hidden_rows.clear();
    }

    // Only record an undo entry when something actually moved — an edit far
    // below/right of the filter must not push a no-op entry onto the stack.
    let changed = af.start_row != before.start_row
        || af.end_row != before.end_row
        || af.start_col != before.start_col
        || af.end_col != before.end_col
        || af.column_filters.len() != before.column_filters.len()
        || (rows_invalidated && !before.hidden_rows.is_empty());
    drop(auto_filters);
    if changed {
        record_auto_filter_shift(undo_stack, sheet_index, before);
    }
}

/// Record the pre-shift AutoFilter into an already-open undo transaction.
fn record_auto_filter_shift(
    undo_stack: &mut engine::UndoStack,
    sheet_index: usize,
    previous: crate::autofilter::AutoFilter,
) {
    undo_stack.record_custom_restore(
        "obj_autofilter".to_string(),
        crate::undo_commands::autofilter_snapshot_bytes(sheet_index, Some(previous)),
        "Shift AutoFilter",
    );
}

/// Track author-side writeback DRAFT region selectors through a structural
/// edit, recording the pre-shift list into the caller's already-open undo
/// transaction so grid + selectors restore as one step.
///
/// `RegionSelector` is raw coordinates with no anchoring, so without this an
/// inserted column silently re-points a published collection surface: a region
/// covering A:D keeps saying cols 0..3 while col 3 now holds what col 2 held,
/// and every subscriber's answer lands in the wrong field with nothing
/// reporting it.
///
/// DRAFTS ONLY. `state.writeback_declarations` mirrors PUBLISHED declarations
/// from immutable signed manifests — the manifest is the contract, and a local
/// grid edit does not change what the publisher declared. Rewriting those would
/// desync the app from the signature it verified (and `rebuild_writeback_index`
/// overwrites them from the manifest anyway).
///
/// The caller must already hold the undo-stack lock inside `begin_transaction`,
/// matching the cell-types / cell-behaviors helpers directly above.
fn shift_writeback_draft_regions(
    state: &AppState,
    undo_stack: &mut engine::UndoStack,
    sheet_index: usize,
    edit: calp::writeback::StructuralEdit,
) {
    let Some(sheet_id) = state
        .sheet_ids
        .lock()
        .ok()
        .and_then(|ids| ids.get(sheet_index).copied())
    else {
        return;
    };

    let Ok(mut regions) = state.writeback_draft_regions.lock() else {
        return;
    };
    if regions.is_empty() {
        return;
    }

    let previous = regions.clone();
    let report = calp::writeback::shift_regions_for_edit(&mut regions, sheet_id, edit);
    if report.is_empty() {
        return;
    }

    undo_stack.record_custom_restore(
        "obj_writeback_regions".to_string(),
        crate::undo_commands::writeback_regions_snapshot_bytes(
            previous,
            report.dropped.clone(),
        ),
        "Shift writeback regions",
    );

    // A dropped region is the author losing a configured collection surface —
    // never let that happen silently.
    if !report.dropped.is_empty() {
        crate::log_warn!(
            "CALP",
            "Structural edit removed {} writeback draft region(s) whose cells were all deleted: {}",
            report.dropped.len(),
            report.dropped.join(", ")
        );
    }
}

/// Shift protected regions when columns are deleted.
fn shift_pivot_regions_for_col_delete(state: &AppState, pivot_state: &PivotState, from_col: u32, count: u32, sheet_index: usize) {
    let mut regions = state.protected_regions.lock().unwrap();
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();

    let mut regions_to_remove: Vec<String> = Vec::new();

    for region in regions.iter_mut() {
        if region.sheet_index != sheet_index {
            continue;
        }

        let delete_end = from_col + count;

        // Check if region is fully within deleted range
        if region.start_col >= from_col && region.end_col < delete_end {
            regions_to_remove.push(region.id.clone());
            continue;
        }

        // Shift region coordinates (generic for all regions)
        if region.start_col >= delete_end {
            region.start_col -= count;
            region.end_col -= count;
        } else if region.start_col >= from_col {
            region.start_col = from_col;
            region.end_col -= count;
        } else if region.end_col >= delete_end {
            region.end_col -= count;
        } else if region.end_col >= from_col {
            region.end_col = from_col.saturating_sub(1);
        }

        // Pivot-specific: update definition
        if region.region_type == "pivot" {
            let pid = region.owner_id;
            if let Some((definition, _)) = pivot_tables.get_mut(&pid) {
                let (dest_row, dest_col) = definition.destination;
                if dest_col >= delete_end {
                    definition.destination = (dest_row, dest_col - count);
                } else if dest_col >= from_col {
                    definition.destination = (dest_row, from_col);
                }

                let (src_start_row, src_start_col) = definition.source_start;
                let (src_end_row, src_end_col) = definition.source_end;

                let new_start_col = if src_start_col >= delete_end {
                    src_start_col - count
                } else if src_start_col >= from_col {
                    from_col
                } else {
                    src_start_col
                };

                let new_end_col = if src_end_col >= delete_end {
                    src_end_col - count
                } else if src_end_col >= from_col {
                    from_col.saturating_sub(1).max(new_start_col)
                } else {
                    src_end_col
                };

                definition.source_start = (src_start_row, new_start_col);
                definition.source_end = (src_end_row, new_end_col);
            }
        }
    }

    // Remove fully deleted regions and their associated pivot data
    for region_id in &regions_to_remove {
        if let Some(region) = regions.iter().find(|r| &r.id == region_id) {
            if region.region_type == "pivot" {
                let pid = region.owner_id;
                pivot_tables.remove(&pid);
            }
        }
    }
    regions.retain(|r| !regions_to_remove.contains(&r.id));

    // Report-specific: realign report definitions with their shifted regions
    // (definitions whose region was fully deleted are dropped).
    drop(pivot_tables);
    drop(regions);
    sync_report_definitions_to_regions(state);
}

// ============================================================================
// ROW/COLUMN INSERTION WITH DEPENDENCY MAP UPDATES
// ============================================================================

/// Shift all cell positions in a HashMap where the key is (row, col)
fn shift_cell_positions_for_row_insert<V: Clone, S: std::hash::BuildHasher>(
    map: &mut HashMap<(u32, u32), V, S>,
    from_row: u32,
    count: u32,
) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), v) in entries {
        let new_r = if r >= from_row { r + count } else { r };
        map.insert((new_r, c), v);
    }
}

/// Shift all cell positions in a HashMap where the key is (row, col)
fn shift_cell_positions_for_col_insert<V: Clone, S: std::hash::BuildHasher>(
    map: &mut HashMap<(u32, u32), V, S>,
    from_col: u32,
    count: u32,
) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), v) in entries {
        let new_c = if c >= from_col { c + count } else { c };
        map.insert((r, new_c), v);
    }
}

/// Shift cell references inside a HashSet<(u32, u32)>
fn shift_cell_set_for_row_insert(set: &crate::CoordSet, from_row: u32, count: u32) -> crate::CoordSet {
    set.iter()
        .map(|(r, c)| {
            let new_r = if *r >= from_row { *r + count } else { *r };
            (new_r, *c)
        })
        .collect()
}

fn shift_cell_set_for_col_insert(set: &crate::CoordSet, from_col: u32, count: u32) -> crate::CoordSet {
    set.iter()
        .map(|(r, c)| {
            let new_c = if *c >= from_col { *c + count } else { *c };
            (*r, new_c)
        })
        .collect()
}

/// Shift row indices in row_dependents map
fn shift_row_indices(map: &mut crate::StripeDependentsMap, from_row: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for (row_idx, cell_set) in entries {
        let new_row_idx = if row_idx >= from_row { row_idx + count } else { row_idx };
        // Also shift the cell positions in the set
        let new_set = shift_cell_set_for_row_insert(&cell_set, from_row, count);
        map.insert(new_row_idx, new_set);
    }
}

/// Shift column indices in column_dependents map
fn shift_col_indices(map: &mut crate::StripeDependentsMap, from_col: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for (col_idx, cell_set) in entries {
        let new_col_idx = if col_idx >= from_col { col_idx + count } else { col_idx };
        // Also shift the cell positions in the set
        let new_set = shift_cell_set_for_col_insert(&cell_set, from_col, count);
        map.insert(new_col_idx, new_set);
    }
}

/// Shift row dependencies (cell -> set of row indices)
fn shift_row_dependencies_map(map: &mut crate::StripeDependenciesMap, from_row: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), row_set) in entries {
        let new_r = if r >= from_row { r + count } else { r };
        let new_row_set: rustc_hash::FxHashSet<u32> = row_set
            .iter()
            .map(|row_idx| if *row_idx >= from_row { *row_idx + count } else { *row_idx })
            .collect();
        map.insert((new_r, c), new_row_set);
    }
}

/// Shift column dependencies (cell -> set of col indices)
fn shift_col_dependencies_map(map: &mut crate::StripeDependenciesMap, from_col: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), col_set) in entries {
        let new_c = if c >= from_col { c + count } else { c };
        let new_col_set: rustc_hash::FxHashSet<u32> = col_set
            .iter()
            .map(|col_idx| if *col_idx >= from_col { *col_idx + count } else { *col_idx })
            .collect();
        map.insert((r, new_c), new_col_set);
    }
}

/// Insert rows at the specified position, shifting existing rows down.
/// Uses snapshot-based undo to restore the full grid state on undo.
#[tauri::command]
pub fn insert_rows(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    row: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    // Sheet protection OPTION gate. Distinct from the per-cell gate: this asks
    // whether the sheet allows this KIND of structural change at all, which is
    // what the Protect Sheet dialog's checkboxes control.
    {
        let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        crate::protection::check_sheet_action(&state, active_sheet, "insertRows", "insert rows")?;
    }
    // Capture snapshot BEFORE acquiring other locks (helper acquires its own locks)
    let snapshot = capture_grid_snapshot(&state);

    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;

    // Lock all dependency maps
    let mut dependents_map = state.dependents.lock().map_err(|e| e.to_string())?;
    let mut dependencies_map = state.dependencies.lock().map_err(|e| e.to_string())?;
    let mut column_dependents_map = state.column_dependents.lock().map_err(|e| e.to_string())?;
    let mut column_dependencies_map = state.column_dependencies.lock().map_err(|e| e.to_string())?;
    let mut row_dependents_map = state.row_dependents.lock().map_err(|e| e.to_string())?;
    let mut row_dependencies_map = state.row_dependencies.lock().map_err(|e| e.to_string())?;

    // Record snapshot for undo
    undo_stack.begin_transaction(format!("Insert {} row(s)", count));
    undo_stack.record_snapshot(snapshot);
    // Cell-type assignments move with their rows; their pre-shift state is
    // recorded in the SAME transaction so one undo restores grid + assignments
    // atomically.
    {
        let mut cell_types = state.cell_types.lock().map_err(|e| e.to_string())?;
        let previous = crate::cell_types::entries_for_sheet(&cell_types, active_sheet);
        if crate::cell_types::shift_rows_for_insert(&mut cell_types, active_sheet, row, count) {
            undo_stack.record_custom_restore(
                "obj_cell_types".to_string(),
                crate::undo_commands::cell_types_snapshot_bytes(active_sheet, previous),
                "Shift cell types",
            );
        }
    }
    // Cell-behavior bindings track their target ranges the same way.
    {
        let mut behaviors = state.cell_behaviors.lock().map_err(|e| e.to_string())?;
        let previous = crate::cell_behaviors::all_bindings(&behaviors);
        if crate::cell_behaviors::shift_rows_for_insert(&mut behaviors, active_sheet, row, count) {
            undo_stack.record_custom_restore(
                "obj_cell_behaviors".to_string(),
                crate::undo_commands::cell_behaviors_snapshot_bytes(previous),
                "Shift cell behaviors",
            );
        }
    }
    // Writeback draft regions are coordinate-anchored and must track the shift.
    shift_writeback_draft_regions(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowInsert { at: row, count },
    );
    // The sheet AutoFilter is coordinate-anchored too and must follow the edit.
    shift_sheet_auto_filter(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowInsert { at: row, count },
    );
    // Comments / notes / hyperlinks / cell protection are cell-keyed and move too.
    shift_per_sheet_cell_stores(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowInsert { at: row, count },
    );
    // Row/column style tiers are index-keyed too, so they renumber with the
    // same edit. Runs AFTER capture_grid_snapshot (see the fn doc).
    shift_style_tiers(
        &mut grid,
        &mut grids,
        active_sheet,
        calp::writeback::StructuralEdit::RowInsert { at: row, count },
    );
    // Outline groups, scenario cells, computed-property keys and
    // advanced-filter hidden rows are position-keyed too.
    shift_misc_coordinate_stores(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowInsert { at: row, count },
    );
    // Named ranges hold their definition as a formula STRING, so they are
    // coordinate holders too. Sheet name is read here (not held) so the shift
    // can tell a local reference from one pointing at another sheet.
    {
        let sheet_name = state
            .sheet_names
            .lock()
            .ok()
            .and_then(|n| n.get(active_sheet).cloned())
            .unwrap_or_default();
        shift_named_ranges(
            &state,
            &mut undo_stack,
            active_sheet,
            &sheet_name,
            calp::writeback::StructuralEdit::RowInsert { at: row, count },
        );
    }
    // Print area and scroll area are A1 range STRINGS on this sheet.
    shift_sheet_range_strings(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowInsert { at: row, count },
    );
    // On-grid controls: cell key AND object-script binding move together.
    shift_controls(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowInsert { at: row, count },
    );
    // Conditional formats and data validations are RANGE-keyed.
    shift_per_sheet_range_stores(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowInsert { at: row, count },
    );
    // Controls and the spill twin pair are flat (sheet, row, col)-keyed.
    shift_flat_cell_stores(&state, active_sheet, calp::writeback::StructuralEdit::RowInsert { at: row, count });

    // Sheet names: an unqualified reference means the sheet the formula LIVES
    // on, so the rewrite needs both that and the edited sheet's name.
    let sheet_names_snapshot: Vec<String> =
        state.sheet_names.lock().map(|n| n.clone()).unwrap_or_default();
    let edited_sheet_name = sheet_names_snapshot
        .get(active_sheet)
        .cloned()
        .unwrap_or_default();

    // Every OTHER sheet may hold formulas pointing at the edited sheet. The
    // in-command loop below only walks this sheet, so without this those
    // references silently go stale. BEFORE commit_transaction, deliberately:
    // its undo entries must join THIS transaction — recorded after commit they
    // became their own undo steps, so one Ctrl+Z reverted the cross-sheet
    // rewrites while the inserted row stayed.
    shift_cross_sheet_formulas(
        &state,
        &mut undo_stack,
        &mut grids,
        active_sheet,
        &edited_sheet_name,
        &sheet_names_snapshot,
        calp::writeback::StructuralEdit::RowInsert { at: row, count },
    );
    undo_stack.commit_transaction();

    // First, update formula references in ALL cells that reference rows at or after the insertion point
    let all_cells: Vec<((u32, u32), Cell)> = grid.cells.iter()
        .map(|(&pos, cell)| (pos, cell.clone()))
        .collect();

    for ((r, c), cell) in &all_cells {
        if let Some(formula) = cell.formula_string() {
            let updated_formula = shift_formula_rows_sheet_aware(&formula, &edited_sheet_name, &edited_sheet_name, row, count as i32);
            if updated_formula != formula {
                let mut updated_cell = cell.clone();
                updated_cell.ast = parser::parse(&updated_formula).ok().map(Box::new);
                grid.cells.insert((*r, *c), updated_cell);
            }
        }
    }

    // Collect all cells that need to be moved (from row onwards)
    let mut cells_to_move: Vec<((u32, u32), Cell)> = Vec::new();
    for (&(r, c), cell) in grid.cells.iter() {
        if r >= row {
            cells_to_move.push(((r, c), cell.clone()));
        }
    }
    
    // Sort by row descending so we move from bottom to top
    cells_to_move.sort_by(|a, b| b.0 .0.cmp(&a.0 .0));
    
    // Remove old cells and insert at new positions
    for ((r, c), cell) in cells_to_move {
        grid.cells.remove(&(r, c));
        grid.cells.insert((r + count, c), cell);
    }
    
    // Update row heights
    let old_heights: Vec<(u32, f64)> = row_heights.iter().map(|(&r, &h)| (r, h)).collect();
    row_heights.clear();
    for (r, height) in old_heights {
        if r >= row {
            row_heights.insert(r + count, height);
        } else {
            row_heights.insert(r, height);
        }
    }
    
    // === UPDATE DEPENDENCY MAPS ===
    
    // Update dependents map: shift keys and values
    let deps_entries: Vec<_> = dependents_map.drain().collect();
    for ((r, c), dep_set) in deps_entries {
        let new_r = if r >= row { r + count } else { r };
        let new_set = shift_cell_set_for_row_insert(&dep_set, row, count);
        dependents_map.insert((new_r, c), new_set);
    }
    
    // Update dependencies map: shift keys and values
    let deps_entries: Vec<_> = dependencies_map.drain().collect();
    for ((r, c), ref_set) in deps_entries {
        let new_r = if r >= row { r + count } else { r };
        let new_set = shift_cell_set_for_row_insert(&ref_set, row, count);
        dependencies_map.insert((new_r, c), new_set);
    }
    
    // Update column_dependents: shift cell positions in values
    for (_col, cell_set) in column_dependents_map.iter_mut() {
        *cell_set = shift_cell_set_for_row_insert(cell_set, row, count);
    }
    
    // Update column_dependencies: shift keys only (cell positions)
    shift_cell_positions_for_row_insert(&mut column_dependencies_map, row, count);
    
    // Update row_dependents: shift both keys (row indices) and values (cell positions)
    shift_row_indices(&mut row_dependents_map, row, count);
    
    // Update row_dependencies: shift keys (cell positions) and values (row indices)
    shift_row_dependencies_map(&mut row_dependencies_map, row, count);
    
    // Recalculate grid bounds
    grid.recalculate_bounds();
    
    // Sync grids vector
    if active_sheet < grids.len() {
        grids[active_sheet].cells = grid.cells.clone();
        grids[active_sheet].max_row = grid.max_row;
        grids[active_sheet].max_col = grid.max_col;
    }
    
    // Drop locks before calling pivot region shift (which needs its own locks)
    drop(dependents_map);
    drop(dependencies_map);
    drop(column_dependents_map);
    drop(column_dependencies_map);
    drop(row_dependents_map);
    drop(row_dependencies_map);
    drop(undo_stack);
    drop(row_heights);
    drop(merged_regions);
    drop(styles);
    drop(grids);
    drop(grid);
    
    // Merges follow the edit too. Deliberately AFTER the merged_regions
    // guard above is dropped — std::sync::Mutex is not reentrant, so
    // shifting while that guard is alive self-deadlocks. Still after
    // capture_grid_snapshot, which is what makes undo restore them.
    shift_merged_regions(&state, calp::writeback::StructuralEdit::RowInsert { at: row, count });

    // === UPDATE PIVOT REGIONS ===
    shift_pivot_regions_for_row_insert(&state, &pivot_state, row, count, active_sheet);

    // === UPDATE TABLE BOUNDARIES ===
    shift_table_boundaries_for_row_insert(&state, row, count, active_sheet);

    // Re-acquire locks for result building
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;

    // Return updated cells with merge info
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, r, c, &locale) {
                result.push(cell_data);
            }
        }
    }
    
    // Update IdRegistry for the structural shift
    {
        let active = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        if let Some(&sid) = sheet_ids.get(active) {
            let mut id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;
            id_reg.shift_rows_down(sid, row, count);
        }
    }

    // Mark workbook as dirty
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    Ok(result)
}

/// Insert columns at the specified position, shifting existing columns right.
/// Uses snapshot-based undo to restore the full grid state on undo.
#[tauri::command]
pub fn insert_columns(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    col: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    // Sheet protection OPTION gate. Distinct from the per-cell gate: this asks
    // whether the sheet allows this KIND of structural change at all, which is
    // what the Protect Sheet dialog's checkboxes control.
    {
        let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        crate::protection::check_sheet_action(&state, active_sheet, "insertColumns", "insert columns")?;
    }
    // Capture snapshot BEFORE acquiring other locks
    let snapshot = capture_grid_snapshot(&state);

    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut column_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;

    // Lock all dependency maps
    let mut dependents_map = state.dependents.lock().map_err(|e| e.to_string())?;
    let mut dependencies_map = state.dependencies.lock().map_err(|e| e.to_string())?;
    let mut column_dependents_map = state.column_dependents.lock().map_err(|e| e.to_string())?;
    let mut column_dependencies_map = state.column_dependencies.lock().map_err(|e| e.to_string())?;
    let mut row_dependents_map = state.row_dependents.lock().map_err(|e| e.to_string())?;
    let mut row_dependencies_map = state.row_dependencies.lock().map_err(|e| e.to_string())?;

    // Record snapshot for undo
    undo_stack.begin_transaction(format!("Insert {} column(s)", count));
    undo_stack.record_snapshot(snapshot);
    // Cell-type assignments move with their columns (same transaction; see insert_rows).
    {
        let mut cell_types = state.cell_types.lock().map_err(|e| e.to_string())?;
        let previous = crate::cell_types::entries_for_sheet(&cell_types, active_sheet);
        if crate::cell_types::shift_cols_for_insert(&mut cell_types, active_sheet, col, count) {
            undo_stack.record_custom_restore(
                "obj_cell_types".to_string(),
                crate::undo_commands::cell_types_snapshot_bytes(active_sheet, previous),
                "Shift cell types",
            );
        }
    }
    {
        let mut behaviors = state.cell_behaviors.lock().map_err(|e| e.to_string())?;
        let previous = crate::cell_behaviors::all_bindings(&behaviors);
        if crate::cell_behaviors::shift_cols_for_insert(&mut behaviors, active_sheet, col, count) {
            undo_stack.record_custom_restore(
                "obj_cell_behaviors".to_string(),
                crate::undo_commands::cell_behaviors_snapshot_bytes(previous),
                "Shift cell behaviors",
            );
        }
    }
    // Writeback draft regions are coordinate-anchored and must track the shift.
    shift_writeback_draft_regions(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColInsert { at: col, count },
    );
    // The sheet AutoFilter is coordinate-anchored too and must follow the edit.
    shift_sheet_auto_filter(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColInsert { at: col, count },
    );
    // Comments / notes / hyperlinks / cell protection are cell-keyed and move too.
    shift_per_sheet_cell_stores(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColInsert { at: col, count },
    );
    // Row/column style tiers are index-keyed too, so they renumber with the
    // same edit. Runs AFTER capture_grid_snapshot (see the fn doc).
    shift_style_tiers(
        &mut grid,
        &mut grids,
        active_sheet,
        calp::writeback::StructuralEdit::ColInsert { at: col, count },
    );
    // Outline groups, scenario cells, computed-property keys and
    // advanced-filter hidden rows are position-keyed too.
    shift_misc_coordinate_stores(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColInsert { at: col, count },
    );
    // Named ranges hold their definition as a formula STRING, so they are
    // coordinate holders too. Sheet name is read here (not held) so the shift
    // can tell a local reference from one pointing at another sheet.
    {
        let sheet_name = state
            .sheet_names
            .lock()
            .ok()
            .and_then(|n| n.get(active_sheet).cloned())
            .unwrap_or_default();
        shift_named_ranges(
            &state,
            &mut undo_stack,
            active_sheet,
            &sheet_name,
            calp::writeback::StructuralEdit::ColInsert { at: col, count },
        );
    }
    // Print area and scroll area are A1 range STRINGS on this sheet.
    shift_sheet_range_strings(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColInsert { at: col, count },
    );
    // On-grid controls: cell key AND object-script binding move together.
    shift_controls(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColInsert { at: col, count },
    );
    // Conditional formats and data validations are RANGE-keyed.
    shift_per_sheet_range_stores(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColInsert { at: col, count },
    );
    // Controls and the spill twin pair are flat (sheet, row, col)-keyed.
    shift_flat_cell_stores(&state, active_sheet, calp::writeback::StructuralEdit::ColInsert { at: col, count });

    // Sheet names: an unqualified reference means the sheet the formula LIVES
    // on, so the rewrite needs both that and the edited sheet name.
    let sheet_names_snapshot: Vec<String> =
        state.sheet_names.lock().map(|n| n.clone()).unwrap_or_default();
    let edited_sheet_name = sheet_names_snapshot
        .get(active_sheet)
        .cloned()
        .unwrap_or_default();

    // Every OTHER sheet may hold formulas pointing at the edited sheet. BEFORE
    // commit_transaction so its undo entries join THIS transaction (see the
    // row-insert twin).
    shift_cross_sheet_formulas(
        &state,
        &mut undo_stack,
        &mut grids,
        active_sheet,
        &edited_sheet_name,
        &sheet_names_snapshot,
        calp::writeback::StructuralEdit::ColInsert { at: col, count },
    );
    undo_stack.commit_transaction();

    // First, update formula references in ALL cells
    let all_cells: Vec<((u32, u32), Cell)> = grid.cells.iter()
        .map(|(&pos, cell)| (pos, cell.clone()))
        .collect();

    for ((r, c), cell) in &all_cells {
        if let Some(formula) = cell.formula_string() {
            let updated_formula = shift_formula_cols_sheet_aware(&formula, &edited_sheet_name, &edited_sheet_name, col, count as i32);
            if updated_formula != formula {
                let mut updated_cell = cell.clone();
                updated_cell.ast = parser::parse(&updated_formula).ok().map(Box::new);
                grid.cells.insert((*r, *c), updated_cell);
            }
        }
    }

    // Collect all cells that need to be moved (from col onwards)
    let mut cells_to_move: Vec<((u32, u32), Cell)> = Vec::new();
    for (&(r, c), cell) in grid.cells.iter() {
        if c >= col {
            cells_to_move.push(((r, c), cell.clone()));
        }
    }
    
    // Sort by column descending so we move from right to left
    cells_to_move.sort_by(|a, b| b.0 .1.cmp(&a.0 .1));
    
    // Remove old cells and insert at new positions
    for ((r, c), cell) in cells_to_move {
        grid.cells.remove(&(r, c));
        grid.cells.insert((r, c + count), cell);
    }
    
    // Update column widths
    let old_widths: Vec<(u32, f64)> = column_widths.iter().map(|(&c, &w)| (c, w)).collect();
    column_widths.clear();
    for (c, width) in old_widths {
        if c >= col {
            column_widths.insert(c + count, width);
        } else {
            column_widths.insert(c, width);
        }
    }
    
    // === UPDATE DEPENDENCY MAPS ===
    
    // Update dependents map: shift keys and values
    let deps_entries: Vec<_> = dependents_map.drain().collect();
    for ((r, c), dep_set) in deps_entries {
        let new_c = if c >= col { c + count } else { c };
        let new_set = shift_cell_set_for_col_insert(&dep_set, col, count);
        dependents_map.insert((r, new_c), new_set);
    }
    
    // Update dependencies map: shift keys and values
    let deps_entries: Vec<_> = dependencies_map.drain().collect();
    for ((r, c), ref_set) in deps_entries {
        let new_c = if c >= col { c + count } else { c };
        let new_set = shift_cell_set_for_col_insert(&ref_set, col, count);
        dependencies_map.insert((r, new_c), new_set);
    }
    
    // Update column_dependents: shift both keys (col indices) and values (cell positions)
    shift_col_indices(&mut column_dependents_map, col, count);
    
    // Update column_dependencies: shift keys (cell positions) and values (col indices)
    shift_col_dependencies_map(&mut column_dependencies_map, col, count);
    
    // Update row_dependents: shift cell positions in values only
    for (_row, cell_set) in row_dependents_map.iter_mut() {
        *cell_set = shift_cell_set_for_col_insert(cell_set, col, count);
    }
    
    // Update row_dependencies: shift keys only (cell positions)
    shift_cell_positions_for_col_insert(&mut row_dependencies_map, col, count);
    
    // Recalculate grid bounds
    grid.recalculate_bounds();
    
    // Sync grids vector
    if active_sheet < grids.len() {
        grids[active_sheet].cells = grid.cells.clone();
        grids[active_sheet].max_row = grid.max_row;
        grids[active_sheet].max_col = grid.max_col;
    }
    
    // Drop locks before calling pivot region shift
    drop(dependents_map);
    drop(dependencies_map);
    drop(column_dependents_map);
    drop(column_dependencies_map);
    drop(row_dependents_map);
    drop(row_dependencies_map);
    drop(undo_stack);
    drop(column_widths);
    drop(merged_regions);
    drop(styles); 
    drop(grids);
    drop(grid);
    
    // Merges follow the edit too. Deliberately AFTER the merged_regions
    // guard above is dropped — std::sync::Mutex is not reentrant, so
    // shifting while that guard is alive self-deadlocks. Still after
    // capture_grid_snapshot, which is what makes undo restore them.
    shift_merged_regions(&state, calp::writeback::StructuralEdit::ColInsert { at: col, count });

    // === UPDATE PIVOT REGIONS ===
    shift_pivot_regions_for_col_insert(&state, &pivot_state, col, count, active_sheet);

    // === UPDATE TABLE BOUNDARIES ===
    shift_table_boundaries_for_col_insert(&state, col, count, active_sheet);

    // Re-acquire locks for result building
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;

    // Return updated cells with merge info
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, r, c, &locale) {
                result.push(cell_data);
            }
        }
    }

    // Update IdRegistry for the structural shift
    {
        let active = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        if let Some(&sid) = sheet_ids.get(active) {
            let mut id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;
            id_reg.shift_cols_right(sid, col, count);
        }
    }

    // Mark workbook as dirty
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    Ok(result)
}

// ============================================================================
// FORMULA REFERENCE SHIFTING (respects $ absolute markers)
// ============================================================================

/// Shift row references in a formula by a given amount.
/// Respects $ absolute markers - $5 won't be shifted, but 5 will.
pub fn shift_formula_row_references(formula: &str, from_row: u32, delta: i32) -> String {
    // A STRUCTURAL edit shifts absolute references too. `$` protects a
    // reference from being adjusted when the formula is COPIED — it does not
    // pin it to a physical row. Insert a row above row 5 and Excel rewrites
    // =$A$5 to =$A$6; leaving it at $A$5 would silently re-point the formula
    // at different data. (Contrast shift_formula_row_references_for_fill,
    // which is the copy/fill path and MUST respect `$`.)
    // from_row is 0-indexed, row_num is 1-indexed
    let shift = |row_num: u32| -> u32 {
        if row_num > from_row {
            ((row_num as i32) + delta).max(1) as u32
        } else {
            row_num
        }
    };
    rewrite_outside_strings(formula, |segment| {
        // Handle cell references (e.g., A5, $A$5, A$5, $A5)
        let result = replace_all_guarded(&CELL_REF_RE, segment, |caps| {
            let lead = &caps[1];
            let col_abs = &caps[2];
            let col_letters = &caps[3];
            let row_abs = &caps[4];
            let row_num: u32 = caps[5].parse().unwrap_or(0);
            format!("{}{}{}{}{}", lead, col_abs, col_letters, row_abs, shift(row_num))
        });

        // Handle row-only references (e.g., 5:5, $2:$10, 2:$10)
        replace_all_guarded(&ROW_RANGE_RE, &result, |caps| {
            let lead = &caps[1];
            let start_abs = &caps[2];
            let start_row: u32 = caps[3].parse().unwrap_or(0);
            let end_abs = &caps[4];
            let end_row: u32 = caps[5].parse().unwrap_or(0);
            format!(
                "{}{}{}:{}{}",
                lead,
                start_abs,
                shift(start_row),
                end_abs,
                shift(end_row)
            )
        })
    })
}

/// Shift column references in a formula by a given amount.
/// Respects $ absolute markers - $A won't be shifted, but A will.
pub fn shift_formula_col_references(formula: &str, from_col: u32, delta: i32) -> String {
    // Structural edits shift absolute references too; `$` is a copy/fill
    // marker, not a pin to a physical column. See the row equivalent above.
    let shift = |letters: &str| -> String {
        let col_index = shift_col_to_index(letters);
        if col_index >= from_col {
            shift_index_to_col(((col_index as i32) + delta).max(0) as u32)
        } else {
            letters.to_string()
        }
    };
    rewrite_outside_strings(formula, |segment| {
        // Handle cell references (e.g., C5, $C$5, C$5, $C5)
        let result = replace_all_guarded(&CELL_REF_RE, segment, |caps| {
            let lead = &caps[1];
            let col_abs = &caps[2];
            let col_letters = &caps[3];
            let row_abs = &caps[4];
            let row_num = &caps[5];
            format!("{}{}{}{}{}", lead, col_abs, shift(col_letters), row_abs, row_num)
        });

        // Handle column-only references (e.g., B:B, $A:$C, A:$C)
        replace_all_guarded(&COL_RANGE_RE, &result, |caps| {
            let lead = &caps[1];
            let start_abs = &caps[2];
            let start_col = &caps[3];
            let end_abs = &caps[4];
            let end_col = &caps[5];
            format!(
                "{}{}{}:{}{}",
                lead,
                start_abs,
                shift(start_col),
                end_abs,
                shift(end_col)
            )
        })
    })
}

/// Convert a column letter string (e.g., "A", "AA", "AZ") to a 0-based index.
/// Extracted as a shared helper for formula manipulation functions.
fn col_letters_to_index(col: &str) -> u32 {
    let mut index: u32 = 0;
    for ch in col.to_uppercase().chars() {
        index = index * 26 + (ch as u32 - 'A' as u32 + 1);
    }
    index - 1
}

/// Normalize inverted ranges in a formula after reference shifting.
///
/// During fill operations, a relative reference can shift past an absolute
/// anchor, producing an inverted range where start > end. For example:
///   =SUM(I10:$I$11)  filled down by 3  -->  =SUM(I13:$I$11)   [row 13 > 11]
///
/// This function detects such inversions and swaps the two cell references
/// so the range is valid:
///   =SUM(I13:$I$11)  -->  =SUM($I$11:I13)
///
/// The $ (absolute) markers travel with their original reference, preserving
/// fill semantics for any future operations on the result.
fn normalize_inverted_ranges(formula: &str) -> String {
    rewrite_outside_strings(formula, |segment| {
        replace_all_guarded(&CELL_RANGE_RE, segment, |caps| {
            let lead = &caps[1];
            let s_col_abs = &caps[2];
            let s_col     = &caps[3];
            let s_row_abs = &caps[4];
            let s_row: u32 = caps[5].parse().unwrap_or(0);

            let e_col_abs = &caps[6];
            let e_col     = &caps[7];
            let e_row_abs = &caps[8];
            let e_row: u32 = caps[9].parse().unwrap_or(0);

            let s_col_idx = col_letters_to_index(s_col);
            let e_col_idx = col_letters_to_index(e_col);

            let row_inverted = s_row > e_row;
            let col_inverted = s_col_idx > e_col_idx;

            if row_inverted || col_inverted {
                // Swap the entire start and end cell references.
                //
                // During fill, only one axis shifts at a time (rows for vertical,
                // cols for horizontal), so inversion only occurs on one axis while
                // the other stays equal or correctly ordered.  A full swap is safe
                // because the non-inverted axis either:
                //   (a) has identical start/end values (e.g., I:I), or
                //   (b) was already correctly ordered and stays that way.
                //
                // The $ markers travel with their original reference, which is
                // correct: the fixed (absolute) part becomes the new start, and
                // the moving (relative) part becomes the new end.
                format!("{}{}{}{}{}:{}{}{}{}",
                    lead,
                    e_col_abs, e_col, e_row_abs, e_row,
                    s_col_abs, s_col, s_row_abs, s_row)
            } else {
                // Range is correctly ordered -- keep as-is
                caps[0].to_string()
            }
        })
    })
}

/// Shift formula references for fill handle operation.
/// This shifts references based on the fill direction and offset.
/// After shifting, inverted ranges (where start > end due to a relative
/// reference crossing past an absolute anchor) are normalized.
/// Exported for use by fill handle command.
#[tauri::command]
pub fn shift_formula_for_fill(
    formula: String,
    row_delta: i32,
    col_delta: i32,
) -> Result<String, String> {
    Ok(shift_formula_internal(&formula, row_delta, col_delta))
}

/// Internal function to shift a single formula (no Result wrapper).
pub(crate) fn shift_formula_internal(formula: &str, row_delta: i32, col_delta: i32) -> String {
    let mut result = formula.to_string();

    // Shift rows if there's a row delta
    if row_delta != 0 {
        result = shift_formula_row_references_for_fill(&result, row_delta);
    }

    // Shift columns if there's a column delta
    if col_delta != 0 {
        result = shift_formula_col_references_for_fill(&result, col_delta);
    }

    // Normalize any ranges that became inverted after shifting.
    // Example: I10:$I$11 shifted by +3 rows --> I13:$I$11 --> $I$11:I13
    normalize_inverted_ranges(&result)
}

/// Batch shift multiple formulas at once for fill operations.
/// This is significantly faster than calling shift_formula_for_fill multiple times
/// because it processes all formulas in a single IPC call.
#[tauri::command]
pub fn shift_formulas_batch(
    inputs: Vec<crate::api_types::FormulaShiftInput>,
) -> crate::api_types::FormulaShiftResult {
    let t0 = std::time::Instant::now();
    let formulas: Vec<String> = inputs
        .iter()
        .map(|input| shift_formula_internal(&input.formula, input.row_delta, input.col_delta))
        .collect();
    let dt = t0.elapsed();

    crate::logging::log_perf!("SHIFT",
        "shift_formulas_batch(N={}) | process={:.2}ms",
        inputs.len(), dt.as_secs_f64() * 1000.0
    );

    crate::api_types::FormulaShiftResult { formulas }
}

/// Shift row references for fill operation (all non-absolute refs shift).
fn shift_formula_row_references_for_fill(formula: &str, delta: i32) -> String {
    rewrite_outside_strings(formula, |segment| {
        replace_all_guarded(&CELL_REF_RE, segment, |caps| {
            let lead = &caps[1];
            let col_abs = &caps[2];
            let col_letters = &caps[3];
            let row_abs = &caps[4];
            let row_num: u32 = caps[5].parse().unwrap_or(0);

            // Only shift if row is NOT absolute (no $)
            let new_row = if row_abs.is_empty() {
                ((row_num as i32) + delta).max(1) as u32
            } else {
                row_num
            };

            format!("{}{}{}{}{}", lead, col_abs, col_letters, row_abs, new_row)
        })
    })
}

/// Shift column references for fill operation (all non-absolute refs shift).
fn shift_formula_col_references_for_fill(formula: &str, delta: i32) -> String {
    rewrite_outside_strings(formula, |segment| {
        replace_all_guarded(&CELL_REF_RE, segment, |caps| {
            let lead = &caps[1];
            let col_abs = &caps[2];
            let col_letters = &caps[3];
            let row_abs = &caps[4];
            let row_num = &caps[5];

            let col_index = shift_col_to_index(col_letters);

            // Only shift if column is NOT absolute (no $)
            let new_col_letters = if col_abs.is_empty() {
                shift_index_to_col(((col_index as i32) + delta).max(0) as u32)
            } else {
                col_letters.to_string()
            };

            format!("{}{}{}{}{}", lead, col_abs, new_col_letters, row_abs, row_num)
        })
    })
}

// ============================================================================
// ROW/COLUMN DELETION WITH DEPENDENCY MAP UPDATES
// ============================================================================

/// Shift cell positions for row deletion (move cells up)
fn shift_cell_positions_for_row_delete<V: Clone, S: std::hash::BuildHasher>(
    map: &mut HashMap<(u32, u32), V, S>,
    from_row: u32,
    count: u32,
) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), v) in entries {
        // Skip cells in the deleted range
        if r >= from_row && r < from_row + count {
            continue;
        }
        let new_r = if r >= from_row + count { r - count } else { r };
        map.insert((new_r, c), v);
    }
}

/// Shift cell positions for column deletion (move cells left)
fn shift_cell_positions_for_col_delete<V: Clone, S: std::hash::BuildHasher>(
    map: &mut HashMap<(u32, u32), V, S>,
    from_col: u32,
    count: u32,
) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), v) in entries {
        // Skip cells in the deleted range
        if c >= from_col && c < from_col + count {
            continue;
        }
        let new_c = if c >= from_col + count { c - count } else { c };
        map.insert((r, new_c), v);
    }
}

/// Shift cell references inside a HashSet for row deletion
fn shift_cell_set_for_row_delete(set: &crate::CoordSet, from_row: u32, count: u32) -> crate::CoordSet {
    set.iter()
        .filter(|(r, _)| *r < from_row || *r >= from_row + count)
        .map(|(r, c)| {
            let new_r = if *r >= from_row + count { *r - count } else { *r };
            (new_r, *c)
        })
        .collect()
}

/// Shift cell references inside a HashSet for column deletion
fn shift_cell_set_for_col_delete(set: &crate::CoordSet, from_col: u32, count: u32) -> crate::CoordSet {
    set.iter()
        .filter(|(_, c)| *c < from_col || *c >= from_col + count)
        .map(|(r, c)| {
            let new_c = if *c >= from_col + count { *c - count } else { *c };
            (*r, new_c)
        })
        .collect()
}

/// Shift row indices in row_dependents map for deletion
fn shift_row_indices_for_delete(map: &mut crate::StripeDependentsMap, from_row: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for (row_idx, cell_set) in entries {
        // Skip rows in the deleted range
        if row_idx >= from_row && row_idx < from_row + count {
            continue;
        }
        let new_row_idx = if row_idx >= from_row + count { row_idx - count } else { row_idx };
        let new_set = shift_cell_set_for_row_delete(&cell_set, from_row, count);
        if !new_set.is_empty() {
            map.insert(new_row_idx, new_set);
        }
    }
}

/// Shift column indices in column_dependents map for deletion
fn shift_col_indices_for_delete(map: &mut crate::StripeDependentsMap, from_col: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for (col_idx, cell_set) in entries {
        // Skip columns in the deleted range
        if col_idx >= from_col && col_idx < from_col + count {
            continue;
        }
        let new_col_idx = if col_idx >= from_col + count { col_idx - count } else { col_idx };
        let new_set = shift_cell_set_for_col_delete(&cell_set, from_col, count);
        if !new_set.is_empty() {
            map.insert(new_col_idx, new_set);
        }
    }
}

/// Shift row dependencies for deletion
fn shift_row_dependencies_map_for_delete(map: &mut crate::StripeDependenciesMap, from_row: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), row_set) in entries {
        // Skip cells in the deleted range
        if r >= from_row && r < from_row + count {
            continue;
        }
        let new_r = if r >= from_row + count { r - count } else { r };
        let new_row_set: rustc_hash::FxHashSet<u32> = row_set
            .iter()
            .filter(|row_idx| **row_idx < from_row || **row_idx >= from_row + count)
            .map(|row_idx| if *row_idx >= from_row + count { *row_idx - count } else { *row_idx })
            .collect();
        if !new_row_set.is_empty() {
            map.insert((new_r, c), new_row_set);
        }
    }
}

/// Shift column dependencies for deletion
fn shift_col_dependencies_map_for_delete(map: &mut crate::StripeDependenciesMap, from_col: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), col_set) in entries {
        // Skip cells in the deleted range
        if c >= from_col && c < from_col + count {
            continue;
        }
        let new_c = if c >= from_col + count { c - count } else { c };
        let new_col_set: rustc_hash::FxHashSet<u32> = col_set
            .iter()
            .filter(|col_idx| **col_idx < from_col || **col_idx >= from_col + count)
            .map(|col_idx| if *col_idx >= from_col + count { *col_idx - count } else { *col_idx })
            .collect();
        if !new_col_set.is_empty() {
            map.insert((r, new_c), new_col_set);
        }
    }
}

/// Delete rows at the specified position, shifting remaining rows up.
/// Uses snapshot-based undo to restore the full grid state on undo.
#[tauri::command]
pub fn delete_rows(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    row: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    // Sheet protection OPTION gate. Distinct from the per-cell gate: this asks
    // whether the sheet allows this KIND of structural change at all, which is
    // what the Protect Sheet dialog's checkboxes control.
    {
        let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        crate::protection::check_sheet_action(&state, active_sheet, "deleteRows", "delete rows")?;
    }
    // Check if any spill range would be broken by this row deletion.
    // Block if any spill range has cells both inside and outside the deleted rows.
    {
        let active_sheet = *state.active_sheet.lock().unwrap();
        let spill_ranges = state.spill_ranges.lock().unwrap();
        for (&(sheet_idx, origin_row, origin_col), spill_cells) in spill_ranges.iter() {
            if sheet_idx != active_sheet { continue; }
            // Compute the full extent of this spill range (origin + spilled cells)
            let mut min_r = origin_row;
            let mut max_r = origin_row;
            for &(sr, _) in spill_cells {
                min_r = min_r.min(sr);
                max_r = max_r.max(sr);
            }
            let del_start = row;
            let del_end = row + count - 1;
            // Block if the deletion range partially overlaps the spill range
            let overlaps = del_start <= max_r && del_end >= min_r;
            let fully_inside = del_start <= min_r && del_end >= max_r;
            if overlaps && !fully_inside {
                let col_letter = crate::pivot::utils::col_index_to_letter(origin_col);
                let cell_ref = format!("{}{}", col_letter, origin_row + 1);
                return Err(format!(
                    "Can't delete rows\n\nThis would affect a spilled array from the formula in {}. Delete or modify that formula first.",
                    cell_ref
                ));
            }
        }
    }

    // Capture snapshot BEFORE acquiring other locks
    let snapshot = capture_grid_snapshot(&state);

    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;

    // Lock all dependency maps
    let mut dependents_map = state.dependents.lock().map_err(|e| e.to_string())?;
    let mut dependencies_map = state.dependencies.lock().map_err(|e| e.to_string())?;
    let mut column_dependents_map = state.column_dependents.lock().map_err(|e| e.to_string())?;
    let mut column_dependencies_map = state.column_dependencies.lock().map_err(|e| e.to_string())?;
    let mut row_dependents_map = state.row_dependents.lock().map_err(|e| e.to_string())?;
    let mut row_dependencies_map = state.row_dependencies.lock().map_err(|e| e.to_string())?;

    // Record snapshot for undo
    undo_stack.begin_transaction(format!("Delete {} row(s)", count));
    undo_stack.record_snapshot(snapshot);
    // Assignments on deleted rows drop; those below shift up (same transaction;
    // see insert_rows).
    {
        let mut cell_types = state.cell_types.lock().map_err(|e| e.to_string())?;
        let previous = crate::cell_types::entries_for_sheet(&cell_types, active_sheet);
        if crate::cell_types::shift_rows_for_delete(&mut cell_types, active_sheet, row, count) {
            undo_stack.record_custom_restore(
                "obj_cell_types".to_string(),
                crate::undo_commands::cell_types_snapshot_bytes(active_sheet, previous),
                "Shift cell types",
            );
        }
    }
    // Bindings shrink with overlapping deletes; fully-deleted targets orphan.
    {
        let mut behaviors = state.cell_behaviors.lock().map_err(|e| e.to_string())?;
        let previous = crate::cell_behaviors::all_bindings(&behaviors);
        if crate::cell_behaviors::shift_rows_for_delete(&mut behaviors, active_sheet, row, count) {
            undo_stack.record_custom_restore(
                "obj_cell_behaviors".to_string(),
                crate::undo_commands::cell_behaviors_snapshot_bytes(previous),
                "Shift cell behaviors",
            );
        }
    }
    // Writeback draft regions shrink with overlapping deletes; a region whose
    // cells are all deleted is dropped and reported.
    shift_writeback_draft_regions(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowDelete { at: row, count },
    );
    // The sheet AutoFilter is coordinate-anchored too and must follow the edit.
    shift_sheet_auto_filter(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowDelete { at: row, count },
    );
    // Comments / notes / hyperlinks / cell protection are cell-keyed and move too.
    shift_per_sheet_cell_stores(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowDelete { at: row, count },
    );
    // Row/column style tiers are index-keyed too, so they renumber with the
    // same edit. Runs AFTER capture_grid_snapshot (see the fn doc).
    shift_style_tiers(
        &mut grid,
        &mut grids,
        active_sheet,
        calp::writeback::StructuralEdit::RowDelete { at: row, count },
    );
    // Outline groups, scenario cells, computed-property keys and
    // advanced-filter hidden rows are position-keyed too.
    shift_misc_coordinate_stores(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowDelete { at: row, count },
    );
    // Named ranges hold their definition as a formula STRING, so they are
    // coordinate holders too. Sheet name is read here (not held) so the shift
    // can tell a local reference from one pointing at another sheet.
    {
        let sheet_name = state
            .sheet_names
            .lock()
            .ok()
            .and_then(|n| n.get(active_sheet).cloned())
            .unwrap_or_default();
        shift_named_ranges(
            &state,
            &mut undo_stack,
            active_sheet,
            &sheet_name,
            calp::writeback::StructuralEdit::RowDelete { at: row, count },
        );
    }
    // Print area and scroll area are A1 range STRINGS on this sheet.
    shift_sheet_range_strings(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowDelete { at: row, count },
    );
    // On-grid controls: cell key AND object-script binding move together.
    shift_controls(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowDelete { at: row, count },
    );
    // Conditional formats and data validations are RANGE-keyed.
    shift_per_sheet_range_stores(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::RowDelete { at: row, count },
    );
    // Controls and the spill twin pair are flat (sheet, row, col)-keyed.
    shift_flat_cell_stores(&state, active_sheet, calp::writeback::StructuralEdit::RowDelete { at: row, count });

    // Sheet names: an unqualified reference means the sheet the formula LIVES
    // on, so the rewrite needs both that and the edited sheet name.
    let sheet_names_snapshot: Vec<String> =
        state.sheet_names.lock().map(|n| n.clone()).unwrap_or_default();
    let edited_sheet_name = sheet_names_snapshot
        .get(active_sheet)
        .cloned()
        .unwrap_or_default();

    // Every OTHER sheet may hold formulas pointing at the edited sheet. BEFORE
    // commit_transaction so its undo entries join THIS transaction (see the
    // row-insert twin).
    shift_cross_sheet_formulas(
        &state,
        &mut undo_stack,
        &mut grids,
        active_sheet,
        &edited_sheet_name,
        &sheet_names_snapshot,
        calp::writeback::StructuralEdit::RowDelete { at: row, count },
    );
    undo_stack.commit_transaction();

    // First, remove cells in the deleted rows
    let cells_to_delete: Vec<(u32, u32)> = grid.cells.keys()
        .filter(|(r, _)| *r >= row && *r < row + count)
        .cloned()
        .collect();

    for pos in cells_to_delete {
        grid.cells.remove(&pos);
    }

    // Update formula references in remaining cells (shift up = negative delta)
    let all_cells: Vec<((u32, u32), Cell)> = grid.cells.iter()
        .map(|(&pos, cell)| (pos, cell.clone()))
        .collect();

    for ((r, c), cell) in &all_cells {
        if let Some(formula) = cell.formula_string() {
            let updated_formula = shift_formula_rows_sheet_aware(&formula, &edited_sheet_name, &edited_sheet_name, row, -(count as i32));
            if updated_formula != formula {
                let mut updated_cell = cell.clone();
                updated_cell.ast = parser::parse(&updated_formula).ok().map(Box::new);
                grid.cells.insert((*r, *c), updated_cell);
            }
        }
    }

    // Move remaining cells up
    let mut cells_to_move: Vec<((u32, u32), Cell)> = Vec::new();
    for (&(r, c), cell) in grid.cells.iter() {
        if r >= row + count {
            cells_to_move.push(((r, c), cell.clone()));
        }
    }
    
    // Sort by row ascending so we move from top to bottom
    cells_to_move.sort_by(|a, b| a.0 .0.cmp(&b.0 .0));
    
    // Remove old cells and insert at new positions
    for ((r, c), cell) in cells_to_move {
        grid.cells.remove(&(r, c));
        grid.cells.insert((r - count, c), cell);
    }
    
    // Update row heights
    let old_heights: Vec<(u32, f64)> = row_heights.iter().map(|(&r, &h)| (r, h)).collect();
    row_heights.clear();
    for (r, height) in old_heights {
        if r >= row && r < row + count {
            // Skip deleted rows
            continue;
        }
        if r >= row + count {
            row_heights.insert(r - count, height);
        } else {
            row_heights.insert(r, height);
        }
    }
    
    // === UPDATE DEPENDENCY MAPS ===
    
    // Update dependents map
    let deps_entries: Vec<_> = dependents_map.drain().collect();
    for ((r, c), dep_set) in deps_entries {
        if r >= row && r < row + count {
            continue; // Skip deleted rows
        }
        let new_r = if r >= row + count { r - count } else { r };
        let new_set = shift_cell_set_for_row_delete(&dep_set, row, count);
        if !new_set.is_empty() {
            dependents_map.insert((new_r, c), new_set);
        }
    }
    
    // Update dependencies map
    let deps_entries: Vec<_> = dependencies_map.drain().collect();
    for ((r, c), ref_set) in deps_entries {
        if r >= row && r < row + count {
            continue; // Skip deleted rows
        }
        let new_r = if r >= row + count { r - count } else { r };
        let new_set = shift_cell_set_for_row_delete(&ref_set, row, count);
        if !new_set.is_empty() {
            dependencies_map.insert((new_r, c), new_set);
        }
    }
    
    // Update column_dependents: shift cell positions in values
    for (_col, cell_set) in column_dependents_map.iter_mut() {
        *cell_set = shift_cell_set_for_row_delete(cell_set, row, count);
    }
    
    // Update column_dependencies: shift keys (cell positions)
    shift_cell_positions_for_row_delete(&mut column_dependencies_map, row, count);
    
    // Update row_dependents: shift both keys (row indices) and values (cell positions)
    shift_row_indices_for_delete(&mut row_dependents_map, row, count);
    
    // Update row_dependencies: shift keys (cell positions) and values (row indices)
    shift_row_dependencies_map_for_delete(&mut row_dependencies_map, row, count);
    
    // Recalculate grid bounds
    grid.recalculate_bounds();
    
    // Sync grids vector
    if active_sheet < grids.len() {
        grids[active_sheet].cells = grid.cells.clone();
        grids[active_sheet].max_row = grid.max_row;
        grids[active_sheet].max_col = grid.max_col;
    }
    
    // Drop locks before calling pivot region shift
    drop(dependents_map);
    drop(dependencies_map);
    drop(column_dependents_map);
    drop(column_dependencies_map);
    drop(row_dependents_map);
    drop(row_dependencies_map);
    drop(undo_stack);
    drop(row_heights);
    drop(merged_regions);
    drop(styles);
    drop(grids);
    drop(grid);
    
    // Merges follow the edit too. Deliberately AFTER the merged_regions
    // guard above is dropped — std::sync::Mutex is not reentrant, so
    // shifting while that guard is alive self-deadlocks. Still after
    // capture_grid_snapshot, which is what makes undo restore them.
    shift_merged_regions(&state, calp::writeback::StructuralEdit::RowDelete { at: row, count });

    // === UPDATE PIVOT REGIONS ===
    shift_pivot_regions_for_row_delete(&state, &pivot_state, row, count, active_sheet);

    // === UPDATE TABLE BOUNDARIES ===
    shift_table_boundaries_for_row_delete(&state, row, count, active_sheet);

    // Re-acquire locks for result building
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;
    
    // Return updated cells with merge info
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, r, c, &locale) {
                result.push(cell_data);
            }
        }
    }
    
    // Update IdRegistry for the structural shift
    {
        let active = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        if let Some(&sid) = sheet_ids.get(active) {
            let mut id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;
            id_reg.shift_rows_up(sid, row, count);
        }
    }

    // Mark workbook as dirty
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    Ok(result)
}

/// Delete columns at the specified position, shifting remaining columns left.
/// Uses snapshot-based undo to restore the full grid state on undo.
#[tauri::command]
pub fn delete_columns(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    col: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    // Sheet protection OPTION gate. Distinct from the per-cell gate: this asks
    // whether the sheet allows this KIND of structural change at all, which is
    // what the Protect Sheet dialog's checkboxes control.
    {
        let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        crate::protection::check_sheet_action(&state, active_sheet, "deleteColumns", "delete columns")?;
    }
    // Check if any spill range would be broken by this column deletion.
    {
        let active_sheet = *state.active_sheet.lock().unwrap();
        let spill_ranges = state.spill_ranges.lock().unwrap();
        for (&(sheet_idx, origin_row, origin_col), spill_cells) in spill_ranges.iter() {
            if sheet_idx != active_sheet { continue; }
            let mut min_c = origin_col;
            let mut max_c = origin_col;
            for &(_, sc) in spill_cells {
                min_c = min_c.min(sc);
                max_c = max_c.max(sc);
            }
            let del_start = col;
            let del_end = col + count - 1;
            let overlaps = del_start <= max_c && del_end >= min_c;
            let fully_inside = del_start <= min_c && del_end >= max_c;
            if overlaps && !fully_inside {
                let col_letter = crate::pivot::utils::col_index_to_letter(origin_col);
                let cell_ref = format!("{}{}", col_letter, origin_row + 1);
                return Err(format!(
                    "Can't delete columns\n\nThis would affect a spilled array from the formula in {}. Delete or modify that formula first.",
                    cell_ref
                ));
            }
        }
    }

    // Capture snapshot BEFORE acquiring other locks
    let snapshot = capture_grid_snapshot(&state);

    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut column_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;

    // Lock all dependency maps
    let mut dependents_map = state.dependents.lock().map_err(|e| e.to_string())?;
    let mut dependencies_map = state.dependencies.lock().map_err(|e| e.to_string())?;
    let mut column_dependents_map = state.column_dependents.lock().map_err(|e| e.to_string())?;
    let mut column_dependencies_map = state.column_dependencies.lock().map_err(|e| e.to_string())?;
    let mut row_dependents_map = state.row_dependents.lock().map_err(|e| e.to_string())?;
    let mut row_dependencies_map = state.row_dependencies.lock().map_err(|e| e.to_string())?;

    // Record snapshot for undo
    undo_stack.begin_transaction(format!("Delete {} column(s)", count));
    undo_stack.record_snapshot(snapshot);
    // Assignments on deleted columns drop; those to the right shift left (same
    // transaction; see insert_rows).
    {
        let mut cell_types = state.cell_types.lock().map_err(|e| e.to_string())?;
        let previous = crate::cell_types::entries_for_sheet(&cell_types, active_sheet);
        if crate::cell_types::shift_cols_for_delete(&mut cell_types, active_sheet, col, count) {
            undo_stack.record_custom_restore(
                "obj_cell_types".to_string(),
                crate::undo_commands::cell_types_snapshot_bytes(active_sheet, previous),
                "Shift cell types",
            );
        }
    }
    {
        let mut behaviors = state.cell_behaviors.lock().map_err(|e| e.to_string())?;
        let previous = crate::cell_behaviors::all_bindings(&behaviors);
        if crate::cell_behaviors::shift_cols_for_delete(&mut behaviors, active_sheet, col, count) {
            undo_stack.record_custom_restore(
                "obj_cell_behaviors".to_string(),
                crate::undo_commands::cell_behaviors_snapshot_bytes(previous),
                "Shift cell behaviors",
            );
        }
    }
    // Writeback draft regions shrink with overlapping deletes; a region whose
    // cells are all deleted is dropped and reported.
    shift_writeback_draft_regions(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColDelete { at: col, count },
    );
    // The sheet AutoFilter is coordinate-anchored too and must follow the edit.
    shift_sheet_auto_filter(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColDelete { at: col, count },
    );
    // Comments / notes / hyperlinks / cell protection are cell-keyed and move too.
    shift_per_sheet_cell_stores(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColDelete { at: col, count },
    );
    // Row/column style tiers are index-keyed too, so they renumber with the
    // same edit. Runs AFTER capture_grid_snapshot (see the fn doc).
    shift_style_tiers(
        &mut grid,
        &mut grids,
        active_sheet,
        calp::writeback::StructuralEdit::ColDelete { at: col, count },
    );
    // Outline groups, scenario cells, computed-property keys and
    // advanced-filter hidden rows are position-keyed too.
    shift_misc_coordinate_stores(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColDelete { at: col, count },
    );
    // Named ranges hold their definition as a formula STRING, so they are
    // coordinate holders too. Sheet name is read here (not held) so the shift
    // can tell a local reference from one pointing at another sheet.
    {
        let sheet_name = state
            .sheet_names
            .lock()
            .ok()
            .and_then(|n| n.get(active_sheet).cloned())
            .unwrap_or_default();
        shift_named_ranges(
            &state,
            &mut undo_stack,
            active_sheet,
            &sheet_name,
            calp::writeback::StructuralEdit::ColDelete { at: col, count },
        );
    }
    // Print area and scroll area are A1 range STRINGS on this sheet.
    shift_sheet_range_strings(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColDelete { at: col, count },
    );
    // On-grid controls: cell key AND object-script binding move together.
    shift_controls(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColDelete { at: col, count },
    );
    // Conditional formats and data validations are RANGE-keyed.
    shift_per_sheet_range_stores(
        &state,
        &mut undo_stack,
        active_sheet,
        calp::writeback::StructuralEdit::ColDelete { at: col, count },
    );
    // Controls and the spill twin pair are flat (sheet, row, col)-keyed.
    shift_flat_cell_stores(&state, active_sheet, calp::writeback::StructuralEdit::ColDelete { at: col, count });
    // Sheet names: an unqualified reference means the sheet the formula LIVES
    // on, so the rewrite needs both that and the edited sheet name.
    let sheet_names_snapshot: Vec<String> =
        state.sheet_names.lock().map(|n| n.clone()).unwrap_or_default();
    let edited_sheet_name = sheet_names_snapshot
        .get(active_sheet)
        .cloned()
        .unwrap_or_default();

    // Every OTHER sheet may hold formulas pointing at the edited sheet. BEFORE
    // commit_transaction so its undo entries join THIS transaction (see the
    // row-insert twin).
    shift_cross_sheet_formulas(
        &state,
        &mut undo_stack,
        &mut grids,
        active_sheet,
        &edited_sheet_name,
        &sheet_names_snapshot,
        calp::writeback::StructuralEdit::ColDelete { at: col, count },
    );
    undo_stack.commit_transaction();

    // First, remove cells in the deleted columns
    let cells_to_delete: Vec<(u32, u32)> = grid.cells.keys()
        .filter(|(_, c)| *c >= col && *c < col + count)
        .cloned()
        .collect();

    for pos in cells_to_delete {
        grid.cells.remove(&pos);
    }

    // Update formula references in remaining cells (shift left = negative delta)
    let all_cells: Vec<((u32, u32), Cell)> = grid.cells.iter()
        .map(|(&pos, cell)| (pos, cell.clone()))
        .collect();

    for ((r, c), cell) in &all_cells {
        if let Some(formula) = cell.formula_string() {
            let updated_formula = shift_formula_cols_sheet_aware(&formula, &edited_sheet_name, &edited_sheet_name, col, -(count as i32));
            if updated_formula != formula {
                let mut updated_cell = cell.clone();
                updated_cell.ast = parser::parse(&updated_formula).ok().map(Box::new);
                grid.cells.insert((*r, *c), updated_cell);
            }
        }
    }

    // Move remaining cells left
    let mut cells_to_move: Vec<((u32, u32), Cell)> = Vec::new();
    for (&(r, c), cell) in grid.cells.iter() {
        if c >= col + count {
            cells_to_move.push(((r, c), cell.clone()));
        }
    }
    
    // Sort by column ascending so we move from left to right
    cells_to_move.sort_by(|a, b| a.0 .1.cmp(&b.0 .1));
    
    // Remove old cells and insert at new positions
    for ((r, c), cell) in cells_to_move {
        grid.cells.remove(&(r, c));
        grid.cells.insert((r, c - count), cell);
    }
    
    // Update column widths
    let old_widths: Vec<(u32, f64)> = column_widths.iter().map(|(&c, &w)| (c, w)).collect();
    column_widths.clear();
    for (c, width) in old_widths {
        if c >= col && c < col + count {
            // Skip deleted columns
            continue;
        }
        if c >= col + count {
            column_widths.insert(c - count, width);
        } else {
            column_widths.insert(c, width);
        }
    }
    
    // === UPDATE DEPENDENCY MAPS ===
    
    // Update dependents map
    let deps_entries: Vec<_> = dependents_map.drain().collect();
    for ((r, c), dep_set) in deps_entries {
        if c >= col && c < col + count {
            continue; // Skip deleted columns
        }
        let new_c = if c >= col + count { c - count } else { c };
        let new_set = shift_cell_set_for_col_delete(&dep_set, col, count);
        if !new_set.is_empty() {
            dependents_map.insert((r, new_c), new_set);
        }
    }
    
    // Update dependencies map
    let deps_entries: Vec<_> = dependencies_map.drain().collect();
    for ((r, c), ref_set) in deps_entries {
        if c >= col && c < col + count {
            continue; // Skip deleted columns
        }
        let new_c = if c >= col + count { c - count } else { c };
        let new_set = shift_cell_set_for_col_delete(&ref_set, col, count);
        if !new_set.is_empty() {
            dependencies_map.insert((r, new_c), new_set);
        }
    }
    
    // Update column_dependents: shift both keys (col indices) and values (cell positions)
    shift_col_indices_for_delete(&mut column_dependents_map, col, count);
    
    // Update column_dependencies: shift keys (cell positions) and values (col indices)
    shift_col_dependencies_map_for_delete(&mut column_dependencies_map, col, count);
    
    // Update row_dependents: shift cell positions in values only
    for (_row, cell_set) in row_dependents_map.iter_mut() {
        *cell_set = shift_cell_set_for_col_delete(cell_set, col, count);
    }
    
    // Update row_dependencies: shift keys only (cell positions)
    shift_cell_positions_for_col_delete(&mut row_dependencies_map, col, count);
    
    // Recalculate grid bounds
    grid.recalculate_bounds();
    
    // Sync grids vector
    if active_sheet < grids.len() {
        grids[active_sheet].cells = grid.cells.clone();
        grids[active_sheet].max_row = grid.max_row;
        grids[active_sheet].max_col = grid.max_col;
    }
    
    // Drop locks before calling pivot region shift
    drop(dependents_map);
    drop(dependencies_map);
    drop(column_dependents_map);
    drop(column_dependencies_map);
    drop(row_dependents_map);
    drop(row_dependencies_map);
    drop(undo_stack);
    drop(column_widths);
    drop(merged_regions);
    drop(styles);
    drop(grids);
    drop(grid);
    
    // Merges follow the edit too. Deliberately AFTER the merged_regions
    // guard above is dropped — std::sync::Mutex is not reentrant, so
    // shifting while that guard is alive self-deadlocks. Still after
    // capture_grid_snapshot, which is what makes undo restore them.
    shift_merged_regions(&state, calp::writeback::StructuralEdit::ColDelete { at: col, count });

    // === UPDATE PIVOT REGIONS ===
    shift_pivot_regions_for_col_delete(&state, &pivot_state, col, count, active_sheet);

    // === UPDATE TABLE BOUNDARIES ===
    shift_table_boundaries_for_col_delete(&state, col, count, active_sheet);

    // Re-acquire locks for result building
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;

    // Return updated cells with merge info
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, r, c, &locale) {
                result.push(cell_data);
            }
        }
    }

    // Update IdRegistry for the structural shift
    {
        let active = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        if let Some(&sid) = sheet_ids.get(active) {
            let mut id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;
            id_reg.shift_cols_left(sid, col, count);
        }
    }

    // Mark workbook as dirty
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    Ok(result)
}

// ============================================================================
// CELL REFERENCE RELOCATION (for drag-move operations)
// ============================================================================

/// Helper: convert a 0-based column index to letters (e.g., 0 -> "A", 25 -> "Z", 26 -> "AA").
fn index_to_col_letters(mut idx: u32) -> String {
    let mut result = String::new();
    loop {
        result.insert(0, (b'A' + (idx % 26) as u8) as char);
        if idx < 26 {
            break;
        }
        idx = idx / 26 - 1;
    }
    result
}

/// Rewrite formula references that point into the source range so they point
/// to the destination range instead.  References outside the source range are
/// left untouched.  Absolute markers ($) are preserved.
///
/// `src_min_row` / `src_min_col` are 0-indexed grid coordinates.
/// Formula row numbers are 1-indexed (A1 style), so we add 1 when comparing.
fn relocate_references_in_formula(
    formula: &str,
    src_min_row: u32,
    src_min_col: u32,
    src_max_row: u32,
    src_max_col: u32,
    delta_row: i32,
    delta_col: i32,
) -> String {
    rewrite_outside_strings(formula, |segment| {
        // First pass: cell range references (A1:B5) — must run before single cell refs
        let result = replace_all_guarded(&CELL_RANGE_RE, segment, |caps| {
            let lead = &caps[1];
            let s_col_abs = &caps[2];
            let s_col = &caps[3];
            let s_row_abs = &caps[4];
            let s_row: u32 = caps[5].parse().unwrap_or(0);

            let e_col_abs = &caps[6];
            let e_col = &caps[7];
            let e_row_abs = &caps[8];
            let e_row: u32 = caps[9].parse().unwrap_or(0);

            let s_col_idx = col_letters_to_index(s_col);
            let e_col_idx = col_letters_to_index(e_col);

            // Check if both corners of the range are inside the source range
            // Row numbers in formulas are 1-indexed, grid is 0-indexed
            let s_in_range = s_row >= src_min_row + 1 && s_row <= src_max_row + 1
                && s_col_idx >= src_min_col && s_col_idx <= src_max_col;
            let e_in_range = e_row >= src_min_row + 1 && e_row <= src_max_row + 1
                && e_col_idx >= src_min_col && e_col_idx <= src_max_col;

            let new_s_row = if s_in_range { ((s_row as i32) + delta_row).max(1) as u32 } else { s_row };
            let new_s_col = if s_in_range { index_to_col_letters(((s_col_idx as i32) + delta_col).max(0) as u32) } else { s_col.to_string() };
            let new_e_row = if e_in_range { ((e_row as i32) + delta_row).max(1) as u32 } else { e_row };
            let new_e_col = if e_in_range { index_to_col_letters(((e_col_idx as i32) + delta_col).max(0) as u32) } else { e_col.to_string() };

            if !s_in_range && !e_in_range {
                caps[0].to_string()
            } else {
                format!("{}{}{}{}{}:{}{}{}{}",
                    lead,
                    s_col_abs, new_s_col, s_row_abs, new_s_row,
                    e_col_abs, new_e_col, e_row_abs, new_e_row)
            }
        });

        // Second pass: single cell references (A1, $B$5, etc.)
        replace_all_guarded(&CELL_REF_RE, &result, |caps| {
            let lead = &caps[1];
            let col_abs = &caps[2];
            let col_letters = &caps[3];
            let row_abs = &caps[4];
            let row_num: u32 = caps[5].parse().unwrap_or(0);

            let col_idx = col_letters_to_index(col_letters);

            // Check if this reference is inside the source range (row is 1-indexed)
            let in_range = row_num >= src_min_row + 1 && row_num <= src_max_row + 1
                && col_idx >= src_min_col && col_idx <= src_max_col;

            if in_range {
                let new_row = ((row_num as i32) + delta_row).max(1) as u32;
                let new_col = index_to_col_letters(((col_idx as i32) + delta_col).max(0) as u32);
                format!("{}{}{}{}{}", lead, col_abs, new_col, row_abs, new_row)
            } else {
                caps[0].to_string()
            }
        })
    })
}

/// Relocate all formula references in the current sheet that point into the
/// source range, making them point to the destination instead.
///
/// This is called after a drag-move operation: the cell data has already been
/// moved from `(src_start_row, src_start_col)` to `(dest_start_row, dest_start_col)`,
/// but formulas on the sheet still reference the old coordinates.
///
/// Returns the list of cells whose formulas were rewritten (with updated values).
#[tauri::command]
pub fn relocate_cell_references(
    state: State<AppState>,
    user_files_state: State<crate::UserFilesState>,
    src_start_row: u32,
    src_start_col: u32,
    src_end_row: u32,
    src_end_col: u32,
    dest_start_row: u32,
    dest_start_col: u32,
) -> Result<Vec<CellData>, String> {
    let src_min_row = src_start_row.min(src_end_row);
    let src_max_row = src_start_row.max(src_end_row);
    let src_min_col = src_start_col.min(src_end_col);
    let src_max_col = src_start_col.max(src_end_col);

    let delta_row = dest_start_row as i32 - src_min_row as i32;
    let delta_col = dest_start_col as i32 - src_min_col as i32;

    if delta_row == 0 && delta_col == 0 {
        return Ok(Vec::new());
    }

    let sheet_names = state.sheet_names.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();
    let user_files = user_files_state.files.lock().unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    // Collect cells whose formulas reference the source range
    let dest_max_row = dest_start_row + (src_max_row - src_min_row);
    let dest_max_col = dest_start_col + (src_max_col - src_min_col);
    let mut rewrites: Vec<(u32, u32, String)> = Vec::new();

    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            // Skip cells that are IN the destination range (they were just written)
            if r >= dest_start_row && r <= dest_max_row
                && c >= dest_start_col && c <= dest_max_col
            {
                continue;
            }

            if let Some(cell) = grid.get_cell(r, c) {
                if let Some(formula) = cell.formula_string() {
                    let new_formula = relocate_references_in_formula(
                        &formula,
                        src_min_row,
                        src_min_col,
                        src_max_row,
                        src_max_col,
                        delta_row,
                        delta_col,
                    );
                    if new_formula != *formula {
                        rewrites.push((r, c, new_formula));
                    }
                }
            }
        }
    }

    // Apply rewrites
    let mut result: Vec<CellData> = Vec::new();

    for (r, c, new_formula) in &rewrites {
        // Record undo
        let prev = grid.get_cell(*r, *c).cloned();
        undo_stack.record_cell_change(*r, *c, prev.clone());

        // Preserve existing style
        let existing_style_index = prev.as_ref().map_or(0, |c| c.style_index);

        // Evaluate the new formula
        let cell_value = crate::evaluate_formula_multi_sheet_with_files(
            &grids,
            &sheet_names,
            active_sheet,
            new_formula,
            &user_files,
        );

        // Build new cell
        let mut new_cell = Cell {
            ast: parser::parse(new_formula).ok().map(Box::new),
            value: cell_value,
            style_index: existing_style_index,
            rich_text: prev.as_ref().and_then(|c| c.rich_text.clone()),
        };

        // Parse the formula to extract references for dependency tracking
        if let Ok(parsed) = parser::parse(new_formula) {
            let refs = crate::extract_all_references(&parsed, &grid);

            crate::update_dependencies((*r, *c), refs.cells, &mut dependencies_map, &mut dependents_map);
            crate::update_column_dependencies((*r, *c), refs.columns, &mut column_dependencies_map, &mut column_dependents_map);
            crate::update_row_dependencies((*r, *c), refs.rows, &mut row_dependencies_map, &mut row_dependents_map);

            // Normalize cross-sheet refs
            let normalized_cross: rustc_hash::FxHashSet<(String, u32, u32)> = refs
                .cross_sheet_cells
                .iter()
                .filter_map(|(parsed_name, cr, cc)| {
                    let normalized = sheet_names
                        .iter()
                        .find(|name| name.eq_ignore_ascii_case(parsed_name))
                        .cloned()
                        .unwrap_or_else(|| parsed_name.clone());
                    Some((normalized, *cr, *cc))
                })
                .collect();
            crate::update_cross_sheet_dependencies(
                (active_sheet, *r, *c),
                normalized_cross,
                &mut cross_sheet_dependencies_map,
                &mut cross_sheet_dependents_map,
            );

            // Cache the AST
            let engine_ast = crate::convert_expr(&parsed);
            new_cell.set_cached_ast(engine_ast);
        }

        grid.set_cell(*r, *c, new_cell.clone());
        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(*r, *c, new_cell);
        }

        // Build CellData for result
        if let Some(cd) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, *r, *c, &locale) {
            result.push(cd);
        }
    }

    Ok(result)
}
/// Shift the per-sheet stores that are keyed by row/column POSITION but live
/// outside the grid: outline groups, scenario changing-cells, computed-property
/// row/column/cell keys, and advanced-filter hidden rows.
///
/// These were the last coordinate-anchored stores a structural edit ignored.
/// Each drifts in its own visible way: an outline bracket ends up around the
/// wrong rows, a scenario writes its value into a neighbouring cell, a computed
/// column property decorates the wrong column, and hidden rows hide the wrong
/// data after an insert.
///
/// Records ONE `obj_coord_stores` undo entry covering all four, since a single
/// edit shifts them together and they should undo together.
fn shift_misc_coordinate_stores(
    state: &AppState,
    undo_stack: &mut engine::UndoStack,
    sheet_index: usize,
    edit: calp::writeback::StructuralEdit,
) {
    use calp::writeback::{interval_delete, interval_insert, StructuralEdit as SE};
    use crate::commands::coord_shift::shift_cell;

    let row_edit = matches!(edit, SE::RowInsert { .. } | SE::RowDelete { .. });
    let (at, count, inserting) = match edit {
        SE::RowInsert { at, count } | SE::ColInsert { at, count } => (at, count, true),
        SE::RowDelete { at, count } | SE::ColDelete { at, count } => (at, count, false),
    };
    // Shift a single index, or None when the row/column itself was deleted.
    let shift_index = |i: u32| -> Option<u32> {
        if inserting {
            Some(interval_insert(i, i, at, count).0)
        } else {
            interval_delete(i, i, at, count).map(|(s, _)| s)
        }
    };

    let mut changed = false;

    // --- Outline groups: row groups move on row edits, column groups on column
    //     edits. A group whose whole span is deleted goes with it. ---
    let prev_outline = {
        let mut store = match state.outlines.lock() { Ok(s) => s, Err(_) => return };
        let before = store.get(&sheet_index).cloned();
        if let Some(outline) = store.get_mut(&sheet_index) {
            if row_edit {
                outline.row_groups.retain_mut(|g| {
                    let moved = if inserting {
                        Some(interval_insert(g.start_row, g.end_row, at, count))
                    } else {
                        interval_delete(g.start_row, g.end_row, at, count)
                    };
                    match moved {
                        Some((s, e)) => {
                            if (s, e) != (g.start_row, g.end_row) { changed = true; }
                            g.start_row = s;
                            g.end_row = e;
                            true
                        }
                        None => { changed = true; false }
                    }
                });
            } else {
                outline.column_groups.retain_mut(|g| {
                    let moved = if inserting {
                        Some(interval_insert(g.start_col, g.end_col, at, count))
                    } else {
                        interval_delete(g.start_col, g.end_col, at, count)
                    };
                    match moved {
                        Some((s, e)) => {
                            if (s, e) != (g.start_col, g.end_col) { changed = true; }
                            g.start_col = s;
                            g.end_col = e;
                            true
                        }
                        None => { changed = true; false }
                    }
                });
            }
        }
        before
    };

    // --- Scenario changing-cells: a cell whose row/column was deleted drops out
    //     of the scenario rather than silently pointing at a different cell. ---
    let prev_scenarios = {
        let mut store = match state.scenarios.lock() { Ok(s) => s, Err(_) => return };
        let before = store.get(&sheet_index).cloned();
        if let Some(list) = store.get_mut(&sheet_index) {
            for scenario in list.iter_mut() {
                scenario.changing_cells.retain_mut(|c| match shift_cell(c.row, c.col, edit) {
                    Some((r, col)) => {
                        if (r, col) != (c.row, c.col) { changed = true; }
                        c.row = r;
                        c.col = col;
                        true
                    }
                    None => { changed = true; false }
                });
            }
        }
        before
    };

    // --- Computed properties: three maps, keyed by column, row, and cell. ---
    let prev_computed = {
        let mut store = match state.computed_properties.lock() { Ok(s) => s, Err(_) => return };
        let before = store.get(&sheet_index).cloned();
        if let Some(props) = store.get_mut(&sheet_index) {
            if !row_edit {
                let old = std::mem::take(&mut props.column_props);
                for (col, v) in old {
                    if let Some(c) = shift_index(col) {
                        if c != col { changed = true; }
                        props.column_props.insert(c, v);
                    } else { changed = true; }
                }
            } else {
                let old = std::mem::take(&mut props.row_props);
                for (row, v) in old {
                    if let Some(r) = shift_index(row) {
                        if r != row { changed = true; }
                        props.row_props.insert(r, v);
                    } else { changed = true; }
                }
            }
            let old_cells = std::mem::take(&mut props.cell_props);
            for ((row, col), v) in old_cells {
                if let Some((r, c)) = shift_cell(row, col, edit) {
                    if (r, c) != (row, col) { changed = true; }
                    props.cell_props.insert((r, c), v);
                } else { changed = true; }
            }
        }
        before
    };

    // --- Advanced-filter hidden rows: row indices only. ---
    let prev_hidden = {
        let mut store = match state.advanced_filter_hidden_rows.lock() { Ok(s) => s, Err(_) => return };
        let before = store.get(&sheet_index).cloned();
        if row_edit {
            if let Some(rows) = store.get_mut(&sheet_index) {
                let old = std::mem::take(rows);
                for r in old {
                    if let Some(n) = shift_index(r) {
                        if n != r { changed = true; }
                        rows.push(n);
                    } else { changed = true; }
                }
                rows.sort_unstable();
            }
        }
        before
    };

    if changed {
        undo_stack.record_custom_restore(
            "obj_coord_stores".to_string(),
            crate::undo_commands::coord_stores_snapshot_bytes(
                sheet_index, prev_outline, prev_scenarios, prev_computed, prev_hidden,
            ),
            "Shift positional stores",
        );
    }
}

/// Shift named-range definitions through a structural edit.
///
/// `NamedRange.refers_to` holds a formula string ("=Sheet1!$A$1:$B$10"), so a
/// name is just another coordinate holder — and an unshifted one silently
/// re-points every formula that uses it at different data, with nothing visibly
/// wrong. Names almost always use ABSOLUTE references, which is why this only
/// became correct once the structural shift stopped treating `$` as a pin.
///
/// SHEET SCOPING is the subtlety. A name may refer to a sheet other than the one
/// being edited ("=Sheet2!$A$1"), and inserting a row on Sheet1 must not touch
/// it. The reference is only shifted when its sheet qualifier names the edited
/// sheet, or when there is no qualifier at all AND the name is scoped to that
/// sheet — an unqualified workbook-scoped name is ambiguous, so it is left
/// alone rather than guessed at.
///
/// Records one `obj_named_ranges` undo entry when anything moved.
fn shift_named_ranges(
    state: &AppState,
    undo_stack: &mut engine::UndoStack,
    sheet_index: usize,
    sheet_name: &str,
    edit: calp::writeback::StructuralEdit,
) {
    use calp::writeback::StructuralEdit as SE;

    let mut store = match state.named_ranges.lock() {
        Ok(s) => s,
        Err(_) => return,
    };
    if store.is_empty() {
        return;
    }
    let previous: Vec<(String, crate::named_ranges::NamedRange)> =
        store.iter().map(|(k, v)| (k.clone(), v.clone())).collect();

    let mut changed = false;
    for nr in store.values_mut() {
        // SHEET-AWARE shifting, per reference. The old form decided once per
        // NAME (from the first qualifier it saw) and then ran the sheet-blind
        // shifters over the whole refers_to — which renumbered refs to OTHER
        // sheets whenever a definition mixed targets, and skipped the edited
        // sheet's refs whenever the first qualifier pointed elsewhere.
        //
        // Unqualified refs mean "the name's own scope sheet": pass that as
        // formula_sheet when this name is scoped to the edited sheet, and a
        // name that can never match otherwise ("" is not a legal sheet name),
        // which leaves workbook-scoped unqualified refs untouched — exactly
        // the old, deliberate behaviour.
        let formula_sheet: &str = if nr.sheet_index == Some(sheet_index) { sheet_name } else { "" };
        let shifted = match edit {
            SE::RowInsert { at, count } => shift_formula_rows_sheet_aware(
                &nr.refers_to, formula_sheet, sheet_name, at, count as i32,
            ),
            SE::RowDelete { at, count } => shift_formula_rows_sheet_aware(
                &nr.refers_to, formula_sheet, sheet_name, at, -(count as i32),
            ),
            SE::ColInsert { at, count } => shift_formula_cols_sheet_aware(
                &nr.refers_to, formula_sheet, sheet_name, at, count as i32,
            ),
            SE::ColDelete { at, count } => shift_formula_cols_sheet_aware(
                &nr.refers_to, formula_sheet, sheet_name, at, -(count as i32),
            ),
        };
        if shifted != nr.refers_to {
            nr.refers_to = shifted;
            changed = true;
        }
    }
    drop(store);

    if changed {
        undo_stack.record_custom_restore(
            "obj_named_ranges".to_string(),
            crate::undo_commands::named_ranges_snapshot_bytes(previous),
            "Shift named ranges",
        );
    }
}

#[cfg(test)]
mod structural_formula_shift_tests {
    use super::{shift_formula_col_references, shift_formula_row_references};

    // The fill/copy path shares CELL_REF_RE with these shifters — before the
    // lead+trailing guards it matched LOG10 as column LOG row 10, so filling
    // =LOG10(A1) down produced =LOG11(A2) (#NAME?).
    #[test]
    fn digit_suffixed_function_names_survive_blind_shifts() {
        assert_eq!(shift_formula_row_references("=LOG10(A5)", 0, 1), "=LOG10(A6)");
        assert_eq!(
            shift_formula_col_references("=HEX2DEC(C5)", 0, 1),
            "=HEX2DEC(D5)"
        );
    }

    // A STRUCTURAL edit (insert/delete row or column) shifts ABSOLUTE references
    // too. `$` marks a reference as immune to being adjusted when the formula is
    // COPIED; it does not pin the reference to a physical row or column. Excel
    // rewrites =$A$5 to =$A$6 when you insert a row above row 5, and leaving it
    // alone would silently re-point the formula at different data.
    //
    // This is the rule named ranges depend on: their definitions are almost
    // always fully absolute ("=Sheet1!$A$1:$B$10"), so under the old behaviour
    // they could never shift at all.

    #[test]
    fn inserting_a_row_shifts_absolute_row_references() {
        // Insert 1 row at index 4 (row 5 in 1-based terms).
        assert_eq!(shift_formula_row_references("=$A$5", 4, 1), "=$A$6");
        assert_eq!(shift_formula_row_references("=A5", 4, 1), "=A6");
    }

    #[test]
    fn references_above_the_insertion_point_do_not_move() {
        assert_eq!(shift_formula_row_references("=$A$3", 4, 1), "=$A$3");
    }

    #[test]
    fn deleting_a_row_pulls_absolute_references_up() {
        assert_eq!(shift_formula_row_references("=$A$8", 4, -1), "=$A$7");
    }

    #[test]
    fn an_absolute_range_grows_when_a_row_is_inserted_inside_it() {
        // =SUM($A$1:$A$10) with a row inserted at index 4 must cover $A$1:$A$11,
        // or the sum silently stops including the new row.
        assert_eq!(
            shift_formula_row_references("=SUM($A$1:$A$10)", 4, 1),
            "=SUM($A$1:$A$11)"
        );
    }

    #[test]
    fn inserting_a_column_shifts_absolute_column_references() {
        // Insert 1 column at index 1 (column B).
        assert_eq!(shift_formula_col_references("=$C$5", 1, 1), "=$D$5");
        assert_eq!(shift_formula_col_references("=$A$5", 1, 1), "=$A$5", "left of it");
    }

    #[test]
    fn absolute_markers_survive_the_shift() {
        // The `$` must still be there afterwards — it still governs copy/fill.
        let out = shift_formula_row_references("=$A$5", 4, 1);
        assert!(out.contains("$A$"), "absolute markers preserved: {out}");
    }
}

/// Shift the per-sheet A1 RANGE STRINGS: the print area and the scroll area.
///
/// Both are stored as text ("A1:D10") rather than coordinates, which is why
/// they were missed by every coordinate-shift pass. Unshifted, a print area
/// silently prints the wrong rows after an insert, and a scroll area fences the
/// user out of the wrong region.
///
/// Simpler than named ranges: these live in a per-sheet `Vec`, so a definition
/// always belongs to its own sheet and there is no qualifier to disambiguate.
///
/// Records one `obj_range_strings` undo entry when either moved.
fn shift_sheet_range_strings(
    state: &AppState,
    undo_stack: &mut engine::UndoStack,
    sheet_index: usize,
    edit: calp::writeback::StructuralEdit,
) {
    use calp::writeback::StructuralEdit as SE;

    let shift = |text: &str| -> String {
        match edit {
            SE::RowInsert { at, count } => shift_formula_row_references(text, at, count as i32),
            SE::RowDelete { at, count } => shift_formula_row_references(text, at, -(count as i32)),
            SE::ColInsert { at, count } => shift_formula_col_references(text, at, count as i32),
            SE::ColDelete { at, count } => shift_formula_col_references(text, at, -(count as i32)),
        }
    };

    let mut changed = false;

    let prev_print = {
        let mut setups = match state.page_setups.lock() { Ok(s) => s, Err(_) => return };
        let before = setups.get(sheet_index).map(|s| s.print_area.clone());
        if let Some(ps) = setups.get_mut(sheet_index) {
            if !ps.print_area.is_empty() {
                let next = shift(&ps.print_area);
                if next != ps.print_area {
                    ps.print_area = next;
                    changed = true;
                }
            }
        }
        before
    };

    let prev_scroll = {
        let mut areas = match state.scroll_areas.lock() { Ok(s) => s, Err(_) => return };
        let before = areas.get(sheet_index).cloned().flatten();
        if let Some(Some(area)) = areas.get_mut(sheet_index) {
            let next = shift(area);
            if &next != area {
                *area = next;
                changed = true;
            }
        }
        before
    };

    if changed {
        undo_stack.record_custom_restore(
            "obj_range_strings".to_string(),
            crate::undo_commands::range_strings_snapshot_bytes(
                sheet_index, prev_print, prev_scroll,
            ),
            "Shift print / scroll areas",
        );
    }
}

#[cfg(test)]
mod range_string_shift_tests {
    use super::{shift_formula_col_references, shift_formula_row_references};

    // Print areas and scroll areas are stored as A1 range TEXT rather than
    // coordinates, which is why they were missed by the coordinate-shift passes.
    // They go through the same functions as cell formulas, so these pin the
    // bare-range (no leading '=') form those stores actually hold.

    #[test]
    fn a_print_area_grows_when_a_row_is_inserted_inside_it() {
        assert_eq!(shift_formula_row_references("A1:D10", 4, 1), "A1:D11");
    }

    #[test]
    fn a_print_area_below_the_insertion_point_moves_wholesale() {
        assert_eq!(shift_formula_row_references("A20:D30", 4, 1), "A21:D31");
    }

    #[test]
    fn a_print_area_above_the_insertion_point_is_untouched() {
        assert_eq!(shift_formula_row_references("A1:D3", 4, 1), "A1:D3");
    }

    #[test]
    fn deleting_columns_pulls_a_scroll_area_left() {
        assert_eq!(shift_formula_col_references("C1:F10", 1, -1), "B1:E10");
    }

    #[test]
    fn an_absolute_print_area_shifts_too() {
        // Print areas are commonly written absolute; the structural rule
        // ignores `$` (see structural_formula_shift_tests).
        assert_eq!(shift_formula_row_references("$A$1:$D$10", 4, 1), "$A$1:$D$11");
    }
}

// ============================================================================
// SHEET-AWARE FORMULA SHIFTING
// ============================================================================

/// A cell reference WITH its optional sheet qualifier.
///
/// Consuming the qualifier as part of the match is the whole point. The older
/// `CELL_REF_RE` starts at the column letters, so in `Sheet1!A5` it matches
/// `Sheet1` as column "Sheet" + row 1 and RENUMBERS THE SHEET NAME — a row
/// insert rewrote `=Sheet1!A5` to `=Sheet2!A6`, silently re-pointing the
/// formula at a different sheet. Matching the qualifier first makes that
/// impossible.
///
/// The column is limited to 1-3 letters because Excel's last column is XFD.
/// That is also what stops a defined name like `Q1` from being mangled: a name
/// that looks like a cell reference is not a legal name in the first place.
///
/// Group 1 is a captured LEADING DELIMITER, re-emitted verbatim. Rust's regex
/// engine has no lookbehind, and without this guard the pattern still matches a
/// SUBSTRING: in a bare `Sheet1` it finds `eet1` (column "eet", row 1) and
/// renumbers it. Requiring a non-identifier character before the reference is
/// what makes the 1-3 letter column cap bite on the LEFT edge.
///
/// The RIGHT edge needs a guard too, and the lead alone cannot provide it: 13
/// built-in functions end in digits (LOG10, BIN2DEC, OCT2HEX, ...) and parse as
/// column+row — `=LOG10(A5)` matched as column LOG, row 10, so a row insert
/// rewrote it to `=LOG11(A6)` (#NAME?). Rust regex has no lookahead, so the
/// trailing check lives in [`replace_all_guarded`], which peeks at the byte
/// after each match WITHOUT consuming it (consuming it would eat the `(` or
/// `+` that delimits the NEXT reference).
///
/// The optional `:endpoint2` tail makes a qualified RANGE one match, so the
/// qualifier governs BOTH endpoints. Matched separately, `Sheet2!A1:A10` had
/// its A1 attributed to Sheet2 but its A10 to the formula's own sheet — a
/// structural edit then shifted one endpoint and not the other, silently
/// resizing the range.
static QUALIFIED_REF_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(^|[^A-Za-z0-9_.])(?:(?:'([^']*)'|([A-Za-z_][A-Za-z0-9_.]*))!)?(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?",
    )
    .unwrap()
});

/// Whole-COLUMN range (`B:B`, `$A:$C`, `Sheet2!A:A`), optionally qualified.
/// The old sheet-blind shifter handled these; the first sheet-aware version
/// forgot them, so `=SUM(B:B)` stopped following column inserts entirely and
/// silently summed the wrong column. The trailing guard in
/// [`replace_all_guarded`] is what keeps `Jan:Mar!A1` (a 3-D sheet span, both
/// names 1-3 letters) from being renumbered as a column range.
static QUALIFIED_COL_RANGE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(^|[^A-Za-z0-9_.:])(?:(?:'([^']*)'|([A-Za-z_][A-Za-z0-9_.]*))!)?(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})",
    )
    .unwrap()
});

/// Whole-ROW range (`3:5`, `$2:$10`, `Sheet2!3:3`), optionally qualified.
/// Runs AFTER the cell pass, whose rewrites leave no digit:digit pairs behind
/// (`A1:B2` has already been consumed whole). The lead excludes `$` so the
/// tail of an already-rewritten `$A$1` cannot seed a bogus match.
static QUALIFIED_ROW_RANGE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(^|[^A-Za-z0-9_.:$])(?:(?:'([^']*)'|([A-Za-z_][A-Za-z0-9_.]*))!)?(\$?)(\d+):(\$?)(\d+)",
    )
    .unwrap()
});

/// `replace_all` with a NON-CONSUMING trailing guard.
///
/// A match followed by an identifier character, `(`, or `!` is not a reference:
/// it is the front of a longer identifier (`LOG10` in `LOG10(`, a sheet name in
/// `Mar!A1`) and is emitted verbatim. The peek must not consume — the very
/// character that blocks one match (`(`, `+`) is the lead delimiter of the
/// next.
fn replace_all_guarded(
    re: &Regex,
    input: &str,
    mut rewrite: impl FnMut(&regex::Captures) -> String,
) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last = 0;
    for caps in re.captures_iter(input) {
        let m = caps.get(0).unwrap();
        out.push_str(&input[last..m.start()]);
        let blocked = matches!(
            input[m.end()..].bytes().next(),
            Some(b) if b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'(' || b == b'!'
        );
        if blocked {
            out.push_str(m.as_str());
        } else {
            out.push_str(&rewrite(&caps));
        }
        last = m.end();
    }
    out.push_str(&input[last..]);
    out
}

/// Apply `rewrite` only OUTSIDE double-quoted string literals (`""` escapes a
/// quote, per Excel). Without this, every shifter rewrote A1-looking text
/// inside strings: `="see A5"` became `="see A6"` on a row insert.
fn rewrite_outside_strings(formula: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let mut out = String::with_capacity(formula.len());
    let mut seg_start = 0;
    let bytes = formula.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            // Rewrite the segment before the string, then copy the string
            // literal (including its closing quote) verbatim.
            out.push_str(&rewrite(&formula[seg_start..i]));
            let mut j = i + 1;
            while j < bytes.len() {
                if bytes[j] == b'"' {
                    if bytes.get(j + 1) == Some(&b'"') {
                        j += 2; // escaped quote, still inside the string
                        continue;
                    }
                    break;
                }
                j += 1;
            }
            let end = (j + 1).min(bytes.len());
            out.push_str(&formula[i..end]);
            i = end;
            seg_start = end;
        } else {
            i += 1;
        }
    }
    out.push_str(&rewrite(&formula[seg_start..]));
    out
}

/// Shared 26-adic column letter conversions for the shifters below.
fn shift_col_to_index(col: &str) -> u32 {
    let mut index: u32 = 0;
    for ch in col.to_uppercase().chars() {
        index = index * 26 + (ch as u32 - 'A' as u32 + 1);
    }
    index.saturating_sub(1)
}
fn shift_index_to_col(mut index: u32) -> String {
    let mut out = String::new();
    index += 1;
    while index > 0 {
        let rem = ((index - 1) % 26) as u8;
        out.insert(0, (b'A' + rem) as char);
        index = (index - 1) / 26;
    }
    out
}

/// Re-emit a matched sheet qualifier exactly as written.
fn qualifier_prefix(quoted: &Option<String>, bare: &Option<String>) -> String {
    match (quoted, bare) {
        (Some(q), _) => format!("'{}'!", q),
        (None, Some(b)) => format!("{}!", b),
        _ => String::new(),
    }
}

/// Shift the row part of every reference in `formula` that targets `edited_sheet`.
///
/// `formula_sheet` is the sheet the formula LIVES on, which is what an
/// unqualified reference means. A qualified reference names its own target.
/// References to any other sheet are left exactly as they are — that is the
/// difference between this and the sheet-blind version, and the reason this can
/// safely run over every sheet in the workbook rather than only the active one.
pub(crate) fn shift_formula_rows_sheet_aware(
    formula: &str,
    formula_sheet: &str,
    edited_sheet: &str,
    from_row: u32,
    delta: i32,
) -> String {
    // Absolute markers do not prevent a STRUCTURAL shift (see
    // structural_formula_shift_tests) but are preserved in the output.
    let shift_row = |row_num: u32| -> u32 {
        if row_num > from_row {
            ((row_num as i32) + delta).max(1) as u32
        } else {
            row_num
        }
    };
    rewrite_outside_strings(formula, |segment| {
        // Pass 1: cell refs and cell ranges (one match per range, so the
        // qualifier governs both endpoints).
        let pass1 = replace_all_guarded(&QUALIFIED_REF_RE, segment, |caps| {
            let lead = &caps[1];
            let quoted = caps.get(2).map(|m| m.as_str().to_string());
            let bare = caps.get(3).map(|m| m.as_str().to_string());
            let qualifier = quoted.clone().or(bare.clone());
            let target = qualifier.as_deref().unwrap_or(formula_sheet);
            let applies = target.eq_ignore_ascii_case(edited_sheet);

            let col_abs = &caps[4];
            let col_letters = &caps[5];
            let row_abs = &caps[6];
            let row_num: u32 = caps[7].parse().unwrap_or(0);
            let new_row = if applies { shift_row(row_num) } else { row_num };
            let mut out = format!(
                "{}{}{}{}{}{}",
                lead,
                qualifier_prefix(&quoted, &bare),
                col_abs,
                col_letters,
                row_abs,
                new_row
            );
            if let (Some(ca2), Some(cl2), Some(ra2), Some(rn2)) =
                (caps.get(8), caps.get(9), caps.get(10), caps.get(11))
            {
                let row2: u32 = rn2.as_str().parse().unwrap_or(0);
                let new_row2 = if applies { shift_row(row2) } else { row2 };
                out.push_str(&format!(
                    ":{}{}{}{}",
                    ca2.as_str(),
                    cl2.as_str(),
                    ra2.as_str(),
                    new_row2
                ));
            }
            out
        });
        // Pass 2: whole-row ranges (3:5).
        replace_all_guarded(&QUALIFIED_ROW_RANGE_RE, &pass1, |caps| {
            let lead = &caps[1];
            let quoted = caps.get(2).map(|m| m.as_str().to_string());
            let bare = caps.get(3).map(|m| m.as_str().to_string());
            let qualifier = quoted.clone().or(bare.clone());
            let target = qualifier.as_deref().unwrap_or(formula_sheet);
            let applies = target.eq_ignore_ascii_case(edited_sheet);

            let abs1 = &caps[4];
            let r1: u32 = caps[5].parse().unwrap_or(0);
            let abs2 = &caps[6];
            let r2: u32 = caps[7].parse().unwrap_or(0);
            let (n1, n2) = if applies { (shift_row(r1), shift_row(r2)) } else { (r1, r2) };
            format!(
                "{}{}{}{}:{}{}",
                lead,
                qualifier_prefix(&quoted, &bare),
                abs1,
                n1,
                abs2,
                n2
            )
        })
    })
}

/// Column twin of [`shift_formula_rows_sheet_aware`].
pub(crate) fn shift_formula_cols_sheet_aware(
    formula: &str,
    formula_sheet: &str,
    edited_sheet: &str,
    from_col: u32,
    delta: i32,
) -> String {
    let shift_col = |letters: &str| -> String {
        let col_index = shift_col_to_index(letters);
        if col_index >= from_col {
            shift_index_to_col(((col_index as i32) + delta).max(0) as u32)
        } else {
            letters.to_string()
        }
    };
    rewrite_outside_strings(formula, |segment| {
        // Pass 1: cell refs and cell ranges.
        let pass1 = replace_all_guarded(&QUALIFIED_REF_RE, segment, |caps| {
            let lead = &caps[1];
            let quoted = caps.get(2).map(|m| m.as_str().to_string());
            let bare = caps.get(3).map(|m| m.as_str().to_string());
            let qualifier = quoted.clone().or(bare.clone());
            let target = qualifier.as_deref().unwrap_or(formula_sheet);
            let applies = target.eq_ignore_ascii_case(edited_sheet);

            let col_abs = &caps[4];
            let col_letters = &caps[5];
            let row_abs = &caps[6];
            let row_num = &caps[7];
            let new_col =
                if applies { shift_col(col_letters) } else { col_letters.to_string() };
            let mut out = format!(
                "{}{}{}{}{}{}",
                lead,
                qualifier_prefix(&quoted, &bare),
                col_abs,
                new_col,
                row_abs,
                row_num
            );
            if let (Some(ca2), Some(cl2), Some(ra2), Some(rn2)) =
                (caps.get(8), caps.get(9), caps.get(10), caps.get(11))
            {
                let new_col2 = if applies {
                    shift_col(cl2.as_str())
                } else {
                    cl2.as_str().to_string()
                };
                out.push_str(&format!(
                    ":{}{}{}{}",
                    ca2.as_str(),
                    new_col2,
                    ra2.as_str(),
                    rn2.as_str()
                ));
            }
            out
        });
        // Pass 2: whole-column ranges (B:B, $A:$C).
        replace_all_guarded(&QUALIFIED_COL_RANGE_RE, &pass1, |caps| {
            let lead = &caps[1];
            let quoted = caps.get(2).map(|m| m.as_str().to_string());
            let bare = caps.get(3).map(|m| m.as_str().to_string());
            let qualifier = quoted.clone().or(bare.clone());
            let target = qualifier.as_deref().unwrap_or(formula_sheet);
            let applies = target.eq_ignore_ascii_case(edited_sheet);

            let abs1 = &caps[4];
            let c1 = &caps[5];
            let abs2 = &caps[6];
            let c2 = &caps[7];
            let (n1, n2) = if applies {
                (shift_col(c1), shift_col(c2))
            } else {
                (c1.to_string(), c2.to_string())
            };
            format!(
                "{}{}{}{}:{}{}",
                lead,
                qualifier_prefix(&quoted, &bare),
                abs1,
                n1,
                abs2,
                n2
            )
        })
    })
}

#[cfg(test)]
mod sheet_aware_shift_tests {
    use super::{shift_formula_cols_sheet_aware, shift_formula_rows_sheet_aware};

    // REGRESSION: the sheet-blind shift matched "Sheet1" as column "Sheet" plus
    // row 1 and renumbered it, so inserting a row rewrote =Sheet1!A5 to
    // =Sheet2!A6 — silently re-pointing the formula at a DIFFERENT SHEET.
    #[test]
    fn a_sheet_qualifier_is_never_renumbered() {
        let out = shift_formula_rows_sheet_aware("=Sheet1!A5", "Sheet2", "Sheet1", 0, 1);
        assert!(out.starts_with("=Sheet1!"), "sheet name must survive: {out}");
        assert_eq!(out, "=Sheet1!A6");
    }

    // REGRESSION: 13 built-in functions end in digits (LOG10, BIN2DEC,
    // OCT2HEX, ...) and parsed as column+row — a row insert rewrote
    // =LOG10(A5) to =LOG11(A6), yielding #NAME?. The trailing guard in
    // replace_all_guarded must reject a "reference" followed by `(`.
    #[test]
    fn function_names_ending_in_digits_are_never_renumbered() {
        assert_eq!(
            shift_formula_rows_sheet_aware("=LOG10(A5)", "Sheet1", "Sheet1", 0, 1),
            "=LOG10(A6)"
        );
        assert_eq!(
            shift_formula_rows_sheet_aware("=BIN2DEC(A5)+OCT2HEX(B7)", "Sheet1", "Sheet1", 0, 1),
            "=BIN2DEC(A6)+OCT2HEX(B8)"
        );
        assert_eq!(
            shift_formula_cols_sheet_aware("=LOG10(C5)", "Sheet1", "Sheet1", 0, 1),
            "=LOG10(D5)"
        );
    }

    // REGRESSION: a qualified RANGE was matched as two references, only the
    // first carrying the qualifier — so editing the formula's OWN sheet
    // shifted the second endpoint of Sheet2!A1:A10 and silently resized it.
    #[test]
    fn a_qualified_range_shifts_or_holds_as_one_unit() {
        // Formula lives on Sheet1; Sheet1 is edited; the Sheet2 range must not move at all.
        assert_eq!(
            shift_formula_rows_sheet_aware("=SUM(Sheet2!A1:A10)", "Sheet1", "Sheet1", 0, 1),
            "=SUM(Sheet2!A1:A10)"
        );
        // Editing Sheet2 shifts BOTH endpoints.
        assert_eq!(
            shift_formula_rows_sheet_aware("=SUM(Sheet2!A1:A10)", "Sheet1", "Sheet2", 0, 1),
            "=SUM(Sheet2!A2:A11)"
        );
    }

    // REGRESSION: whole-column references were handled by the old sheet-blind
    // shifter but forgotten by the first sheet-aware version — =SUM(B:B)
    // stopped following column inserts and silently summed the wrong column.
    #[test]
    fn whole_column_and_row_ranges_shift() {
        assert_eq!(
            shift_formula_cols_sheet_aware("=SUM(B:B)", "Sheet1", "Sheet1", 0, 1),
            "=SUM(C:C)"
        );
        assert_eq!(
            shift_formula_cols_sheet_aware("=SUM($A:$C)", "Sheet1", "Sheet1", 1, 1),
            "=SUM($A:$D)"
        );
        assert_eq!(
            shift_formula_rows_sheet_aware("=SUM(3:5)", "Sheet1", "Sheet1", 0, 1),
            "=SUM(4:6)"
        );
        // Qualified col range follows its own sheet, not the formula's.
        assert_eq!(
            shift_formula_cols_sheet_aware("=SUM(Sheet2!B:B)", "Sheet1", "Sheet1", 0, 1),
            "=SUM(Sheet2!B:B)"
        );
        assert_eq!(
            shift_formula_cols_sheet_aware("=SUM(Sheet2!B:B)", "Sheet1", "Sheet2", 0, 1),
            "=SUM(Sheet2!C:C)"
        );
    }

    // A 3-D sheet span (Jan:Mar!A1) must not be renumbered as a column range.
    #[test]
    fn three_d_sheet_spans_are_not_column_ranges() {
        let out = shift_formula_cols_sheet_aware("=SUM(Jan:Mar!A1)", "Sheet1", "Sheet1", 0, 1);
        assert!(out.starts_with("=SUM(Jan:Mar!"), "3-D span mangled: {out}");
    }

    // REGRESSION: A1-looking text inside string literals was rewritten —
    // ="see A5" became ="see A6" on a row insert.
    #[test]
    fn string_literals_are_never_rewritten() {
        assert_eq!(
            shift_formula_rows_sheet_aware(
                "=IF(A5>0,\"see A5\",A5)", "Sheet1", "Sheet1", 0, 1
            ),
            "=IF(A6>0,\"see A5\",A6)"
        );
        // Escaped quotes stay inside the string.
        assert_eq!(
            shift_formula_rows_sheet_aware(
                "=\"say \"\"A5\"\" now\"&A5", "Sheet1", "Sheet1", 0, 1
            ),
            "=\"say \"\"A5\"\" now\"&A6"
        );
    }

    #[test]
    fn a_reference_to_another_sheet_is_left_alone() {
        // Editing Sheet1 must not touch a reference aimed at Sheet2.
        assert_eq!(
            shift_formula_rows_sheet_aware("=Sheet2!A5", "Sheet1", "Sheet1", 0, 1),
            "=Sheet2!A5"
        );
    }

    #[test]
    fn an_unqualified_reference_belongs_to_the_formulas_own_sheet() {
        // On the edited sheet it shifts...
        assert_eq!(
            shift_formula_rows_sheet_aware("=A5", "Sheet1", "Sheet1", 0, 1),
            "=A6"
        );
        // ...on a different sheet it does not, because it means that sheet's A5.
        assert_eq!(
            shift_formula_rows_sheet_aware("=A5", "Sheet2", "Sheet1", 0, 1),
            "=A5"
        );
    }

    #[test]
    fn a_cross_sheet_reference_updates_when_its_target_is_edited() {
        // The bug this whole change is about: a formula on Sheet2 pointing at
        // Sheet1 must follow Sheet1's rows.
        assert_eq!(
            shift_formula_rows_sheet_aware("=Sheet1!$A$5", "Sheet2", "Sheet1", 0, 1),
            "=Sheet1!$A$6"
        );
    }

    #[test]
    fn quoted_sheet_names_round_trip() {
        assert_eq!(
            shift_formula_rows_sheet_aware("='My Sheet'!A5", "Other", "My Sheet", 0, 1),
            "='My Sheet'!A6"
        );
    }

    #[test]
    fn a_name_that_is_not_a_valid_column_is_not_treated_as_a_reference() {
        // "Sheet" is 5 letters; Excel's last column is XFD, so the column part
        // is capped at 3. This is what keeps defined names from being mangled.
        let out = shift_formula_rows_sheet_aware("=Sheet1", "Sheet1", "Sheet1", 0, 1);
        assert_eq!(out, "=Sheet1", "a bare name must not be renumbered");
    }

    #[test]
    fn columns_shift_only_for_the_edited_sheet() {
        assert_eq!(
            shift_formula_cols_sheet_aware("=Sheet1!$C$5", "Sheet2", "Sheet1", 1, 1),
            "=Sheet1!$D$5"
        );
        assert_eq!(
            shift_formula_cols_sheet_aware("=Sheet2!$C$5", "Sheet2", "Sheet1", 1, 1),
            "=Sheet2!$C$5"
        );
    }
}

/// Rewrite formulas on EVERY OTHER SHEET that reference the edited sheet.
///
/// The in-command rewrite only ever walked the active sheet's cells, so a
/// formula on Sheet2 reading `Sheet1!A5` kept pointing at the old row after a
/// Sheet1 insert — ordinary formulas, silently reading the wrong data, in any
/// multi-sheet workbook.
///
/// Running the OLD sheet-blind shift over other sheets would have been worse
/// than the bug: it would also have moved each sheet's own local references,
/// and it renumbered sheet NAMES (`Sheet1!A5` -> `Sheet2!A6`). This uses the
/// sheet-aware form, which touches only references whose target is the edited
/// sheet.
///
/// Records one `obj_cross_sheet_formulas` entry per affected sheet; the active
/// sheet is already covered by the caller's `GridSnapshot`.
fn shift_cross_sheet_formulas(
    state: &AppState,
    undo_stack: &mut engine::UndoStack,
    grids: &mut [engine::Grid],
    active_sheet: usize,
    edited_sheet_name: &str,
    sheet_names: &[String],
    edit: calp::writeback::StructuralEdit,
) {
    use calp::writeback::StructuralEdit as SE;

    for (idx, grid) in grids.iter_mut().enumerate() {
        if idx == active_sheet {
            continue; // Handled in-command against `state.grid`.
        }
        let Some(this_sheet) = sheet_names.get(idx) else { continue };

        let candidates: Vec<((u32, u32), engine::Cell)> = grid
            .cells
            .iter()
            .filter(|(_, c)| c.ast.is_some())
            .map(|(&pos, c)| (pos, c.clone()))
            .collect();

        let mut previous: Vec<((u32, u32), Option<engine::Cell>)> = Vec::new();
        for ((r, c), cell) in candidates {
            let Some(formula) = cell.formula_string() else { continue };
            // A formula on ANOTHER sheet can only reach the edited sheet
            // through a QUALIFIED reference — unqualified refs mean this sheet.
            // Skipping the '!'-free majority avoids rendering and regex-scanning
            // every formula in the workbook on every row/column edit.
            if !formula.contains('!') {
                continue;
            }
            let updated = match edit {
                SE::RowInsert { at, count } => shift_formula_rows_sheet_aware(
                    &formula, this_sheet, edited_sheet_name, at, count as i32,
                ),
                SE::RowDelete { at, count } => shift_formula_rows_sheet_aware(
                    &formula, this_sheet, edited_sheet_name, at, -(count as i32),
                ),
                SE::ColInsert { at, count } => shift_formula_cols_sheet_aware(
                    &formula, this_sheet, edited_sheet_name, at, count as i32,
                ),
                SE::ColDelete { at, count } => shift_formula_cols_sheet_aware(
                    &formula, this_sheet, edited_sheet_name, at, -(count as i32),
                ),
            };
            if updated == formula {
                continue;
            }
            // Only replace the AST when the rewrite still parses — a formula we
            // cannot re-parse is left exactly as it was rather than being
            // silently blanked.
            if let Ok(ast) = parser::parse(&updated) {
                previous.push(((r, c), Some(cell.clone())));
                let mut next = cell;
                next.ast = Some(Box::new(ast));
                grid.set_cell(r, c, next);
            }
        }

        if !previous.is_empty() {
            undo_stack.record_custom_restore(
                "obj_cross_sheet_formulas".to_string(),
                crate::undo_commands::cross_sheet_formulas_snapshot_bytes(idx, previous),
                "Shift cross-sheet formulas",
            );
        }
    }
}

/// Shift on-grid controls, moving their cell key and their object-script
/// binding TOGETHER.
///
/// This is why the key was previously left alone (see the note on
/// `shift_flat_cell_stores`). A control's identity IS its coordinate: the store
/// is keyed by `(sheet, row, col)`, and an attached object script is bound by
/// the derived instance id `control-<sheet>-<row>-<col>`. Moving the key on its
/// own renames the control out from under its script, which breaks more than
/// the drift it fixes — so both move here, in one undo entry.
///
/// A control whose row or column was deleted is dropped, and its script binding
/// is cleared rather than left pointing at a control that no longer exists.
///
/// PLACEMENT decides whether a control moves at all. Mirroring Excel's Format
/// Object -> Properties, a control marked `free` (fixed pixel position) is left
/// exactly where it is; anything else — every in-cell control, and any floating
/// control pinned to the grid — moves with its anchor. See
/// `controls::PLACEMENT_PROPERTY`.
///
/// The pixel x/y of a pinned floating control is recomputed by the frontend
/// from the anchor this shifts; the backend stores no pixel geometry.
fn shift_controls(
    state: &AppState,
    undo_stack: &mut engine::UndoStack,
    sheet_index: usize,
    edit: calp::writeback::StructuralEdit,
) {
    use crate::commands::coord_shift::shift_cell;

    let previous_controls: Vec<((usize, u32, u32), crate::controls::ControlMetadata)> = {
        let store = match state.controls.lock() { Ok(s) => s, Err(_) => return };
        if store.is_empty() {
            return;
        }
        store.iter().map(|(k, v)| (*k, v.clone())).collect()
    };

    // Decide the whole move first: old id -> new id (None = control deleted).
    let mut id_moves: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    let mut rebuilt: crate::controls::ControlStorage = std::collections::HashMap::new();
    let mut changed = false;

    for ((sheet, row, col), meta) in previous_controls.iter().cloned() {
        if sheet != sheet_index {
            rebuilt.insert((sheet, row, col), meta);
            continue;
        }
        // A FREE-placed floating control holds a fixed pixel position, so the
        // grid moving under it must not move the control. Re-anchoring it would
        // be worse than leaving it: the metadata would claim a cell the control
        // does not render over, and its script binding would be renamed for a
        // control the user sees in the same place. Absent property = moves,
        // which is what every in-cell control wants.
        if !crate::controls::moves_with_cells(&meta) {
            rebuilt.insert((sheet, row, col), meta);
            continue;
        }
        let old_id = format!("control-{}-{}-{}", sheet, row, col);
        match shift_cell(row, col, edit) {
            Some((new_row, new_col)) => {
                if (new_row, new_col) != (row, col) {
                    changed = true;
                    id_moves.insert(
                        old_id,
                        Some(format!("control-{}-{}-{}", sheet, new_row, new_col)),
                    );
                }
                rebuilt.insert((sheet, new_row, new_col), meta);
            }
            None => {
                changed = true;
                id_moves.insert(old_id, None);
            }
        }
    }

    if !changed {
        return;
    }

    // Re-key the object-script bindings that name these controls. Keyed by the
    // script's own stable id (see ControlsObjSnapshot) so a later script
    // deletion cannot make the undo payload target the wrong script.
    let previous_ids = {
        let mut scripts = match state.object_scripts.lock() { Ok(s) => s, Err(_) => return };
        let mut prev = Vec::new();
        for script in scripts.iter_mut() {
            let Some(current) = script.instance_id.clone() else { continue };
            if let Some(moved_to) = id_moves.get(&current) {
                prev.push((script.id.clone(), Some(current)));
                script.instance_id = moved_to.clone();
            }
        }
        prev
    };

    if let Ok(mut store) = state.controls.lock() {
        *store = rebuilt;
    }

    undo_stack.record_custom_restore(
        "obj_controls".to_string(),
        crate::undo_commands::controls_snapshot_bytes(previous_controls, previous_ids),
        "Shift controls",
    );
}

#[cfg(test)]
mod control_identity_tests {
    use crate::commands::coord_shift::{shift_cell, StructuralEdit};

    /// Mirror of the id derivation in `shift_controls` and the frontend's
    /// `makeFloatingControlId`. A control's identity IS its coordinate, which is
    /// exactly why the key and the script binding cannot move independently.
    fn control_id(sheet: usize, row: u32, col: u32) -> String {
        format!("control-{}-{}-{}", sheet, row, col)
    }

    #[test]
    fn a_shifted_control_gets_a_new_id_that_matches_its_new_cell() {
        let (row, col) = (5u32, 2u32);
        let before = control_id(0, row, col);
        let (nr, nc) = shift_cell(row, col, StructuralEdit::RowInsert { at: 0, count: 2 })
            .expect("cell survives");
        let after = control_id(0, nr, nc);

        assert_eq!(before, "control-0-5-2");
        assert_eq!(after, "control-0-7-2");
        assert_ne!(before, after, "the binding id must move with the key");
    }

    #[test]
    fn a_deleted_control_has_no_new_id_to_rebind_to() {
        // Its script binding is cleared rather than left pointing at a control
        // that no longer exists.
        assert!(shift_cell(5, 2, StructuralEdit::RowDelete { at: 5, count: 1 }).is_none());
    }

    #[test]
    fn a_control_above_the_edit_keeps_its_identity() {
        let (nr, nc) = shift_cell(1, 2, StructuralEdit::RowInsert { at: 5, count: 3 }).unwrap();
        assert_eq!(control_id(0, nr, nc), control_id(0, 1, 2), "unchanged");
    }
}
