//! FILENAME: app/src-tauri/src/tracing.rs
// PURPOSE: Trace Precedents / Trace Dependents commands.
// CONTEXT: Exposes the existing dependency graph to the frontend for
//          visual formula auditing (blue/red arrows on the grid).

use std::collections::HashSet;
use tauri::State;

use crate::api_types::{TraceCellRef, TraceCrossSheetRef, TraceRange, TraceResult};
use crate::{format_cell_value, AppState};
use engine::{CellValue, Grid, StyleRegistry};

// ============================================================================
// Helpers
// ============================================================================

/// Check whether a cell's current value is an error.
fn cell_is_error(grid: &Grid, row: u32, col: u32) -> bool {
    grid.cells
        .get(&(row, col))
        .map(|c| matches!(c.value, CellValue::Error(_)))
        .unwrap_or(false)
}

/// Get the display string for a cell (used for tooltips).
fn cell_display(grid: &Grid, styles: &StyleRegistry, row: u32, col: u32) -> String {
    if let Some(cell) = grid.cells.get(&(row, col)) {
        let style = styles.get(cell.style_index);
        format_cell_value(&cell.value, style)
    } else {
        String::new()
    }
}

/// Group a set of (row, col) positions into contiguous rectangular ranges.
/// Returns (ranges, remaining_singles) where singles are cells that don't
/// belong to any multi-cell range.
fn group_into_ranges(
    cells: &HashSet<(u32, u32)>,
    grid: &Grid,
) -> (Vec<TraceRange>, Vec<(u32, u32)>) {
    if cells.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let mut sorted: Vec<(u32, u32)> = cells.iter().copied().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    let mut visited = HashSet::new();
    let mut ranges = Vec::new();
    let mut singles = Vec::new();

    for &(r, c) in &sorted {
        if visited.contains(&(r, c)) {
            continue;
        }

        // Expand right as far as possible
        let mut end_col = c;
        while cells.contains(&(r, end_col + 1)) && !visited.contains(&(r, end_col + 1)) {
            end_col += 1;
        }

        // Expand down as far as the full row-width remains
        let mut end_row = r;
        'outer: loop {
            let next_row = end_row + 1;
            for col in c..=end_col {
                if !cells.contains(&(next_row, col)) || visited.contains(&(next_row, col)) {
                    break 'outer;
                }
            }
            end_row = next_row;
        }

        // Mark all cells in this rectangle as visited
        for rr in r..=end_row {
            for cc in c..=end_col {
                visited.insert((rr, cc));
            }
        }

        // Only emit as range if it's more than a single cell
        if end_row > r || end_col > c {
            let has_error = (r..=end_row).any(|rr| {
                (c..=end_col).any(|cc| cell_is_error(grid, rr, cc))
            });
            ranges.push(TraceRange {
                start_row: r,
                start_col: c,
                end_row,
                end_col,
                has_error,
            });
        } else {
            singles.push((r, c));
        }
    }

    (ranges, singles)
}

// ============================================================================
// Trace Precedents
// ============================================================================

/// Returns the cells and ranges that supply data TO the given cell's formula.
/// Reads from the `dependencies` map (what this formula references).
#[tauri::command]
pub fn trace_precedents(state: State<AppState>, row: u32, col: u32) -> TraceResult {
    let grid = state.grid.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let dependencies = state.dependencies.lock().unwrap();
    let column_dependencies = state.column_dependencies.lock().unwrap();
    let row_dependencies = state.row_dependencies.lock().unwrap();
    let cross_sheet_deps = state.cross_sheet_dependencies.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();

    let source_is_error = cell_is_error(&grid, row, col);

    // Same-sheet cell dependencies
    let mut same_sheet_cells: HashSet<(u32, u32)> = HashSet::new();
    if let Some(deps) = dependencies.get(&(row, col)) {
        same_sheet_cells.extend(deps);
    }

    // Column-level dependencies (formula references entire columns like A:A)
    if let Some(col_deps) = column_dependencies.get(&(row, col)) {
        for &dep_col in col_deps.iter() {
            // Add all occupied cells in that column
            for (&(r, c), _) in grid.cells.iter() {
                if c == dep_col {
                    same_sheet_cells.insert((r, c));
                }
            }
        }
    }

    // Row-level dependencies (formula references entire rows like 1:1)
    if let Some(row_deps) = row_dependencies.get(&(row, col)) {
        for &dep_row in row_deps.iter() {
            for (&(r, c), _) in grid.cells.iter() {
                if r == dep_row {
                    same_sheet_cells.insert((r, c));
                }
            }
        }
    }

    // Group contiguous cells into ranges
    let (ranges, singles) = group_into_ranges(&same_sheet_cells, &grid);

    // Build individual cell refs from the remaining singles
    let cells: Vec<TraceCellRef> = singles
        .iter()
        .map(|&(r, c)| TraceCellRef {
            row: r,
            col: c,
            is_error: cell_is_error(&grid, r, c),
            display: cell_display(&grid, &styles, r, c),
        })
        .collect();

    // Cross-sheet dependencies
    let mut cross_sheet_refs = Vec::new();
    if let Some(cs_deps) = cross_sheet_deps.get(&(active_sheet, row, col)) {
        for &(ref sheet_name, cs_row, cs_col) in cs_deps.iter() {
            // Find the sheet index for this sheet name
            let sheet_idx = sheet_names
                .iter()
                .position(|n| n == sheet_name)
                .unwrap_or(0);

            // Check if the referenced cell is an error
            // We need to look at the other grid if it exists
            let grids = state.grids.lock().unwrap();
            let is_error = if sheet_idx < grids.len() {
                cell_is_error(&grids[sheet_idx], cs_row, cs_col)
            } else {
                false
            };

            cross_sheet_refs.push(TraceCrossSheetRef {
                sheet_name: sheet_name.clone(),
                sheet_index: sheet_idx,
                row: cs_row,
                col: cs_col,
                is_error,
            });
        }
    }

    TraceResult {
        source_row: row,
        source_col: col,
        cells,
        ranges,
        cross_sheet_refs,
        source_is_error,
    }
}

// ============================================================================
// Trace Dependents
// ============================================================================

/// Returns the formula cells that rely ON the given cell.
/// Reads from the `dependents` map (what formulas reference this cell).
#[tauri::command]
pub fn trace_dependents(state: State<AppState>, row: u32, col: u32) -> TraceResult {
    let grid = state.grid.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let dependents = state.dependents.lock().unwrap();
    let column_dependents = state.column_dependents.lock().unwrap();
    let row_dependents = state.row_dependents.lock().unwrap();
    let cross_sheet_deps = state.cross_sheet_dependents.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();

    let source_is_error = cell_is_error(&grid, row, col);

    // Same-sheet cell dependents
    let mut same_sheet_cells: HashSet<(u32, u32)> = HashSet::new();
    if let Some(deps) = dependents.get(&(row, col)) {
        same_sheet_cells.extend(deps);
    }

    // Column-level dependents (formulas that reference the entire column this cell is in)
    if let Some(col_deps) = column_dependents.get(&col) {
        same_sheet_cells.extend(col_deps);
    }

    // Row-level dependents (formulas that reference the entire row this cell is in)
    if let Some(row_deps) = row_dependents.get(&row) {
        same_sheet_cells.extend(row_deps);
    }

    // Group contiguous cells into ranges
    let (ranges, singles) = group_into_ranges(&same_sheet_cells, &grid);

    // Build individual cell refs from the remaining singles
    let cells: Vec<TraceCellRef> = singles
        .iter()
        .map(|&(r, c)| TraceCellRef {
            row: r,
            col: c,
            is_error: cell_is_error(&grid, r, c),
            display: cell_display(&grid, &styles, r, c),
        })
        .collect();

    // Cross-sheet dependents
    let mut cross_sheet_refs = Vec::new();
    let current_sheet_name = if active_sheet < sheet_names.len() {
        &sheet_names[active_sheet]
    } else {
        return TraceResult {
            source_row: row,
            source_col: col,
            cells,
            ranges,
            cross_sheet_refs,
            source_is_error,
        };
    };

    if let Some(cs_deps) = cross_sheet_deps.get(&(current_sheet_name.clone(), row, col)) {
        for &(sheet_idx, cs_row, cs_col) in cs_deps.iter() {
            let sheet_name = if sheet_idx < sheet_names.len() {
                sheet_names[sheet_idx].clone()
            } else {
                format!("Sheet{}", sheet_idx + 1)
            };

            // Check if the dependent cell is an error
            let grids = state.grids.lock().unwrap();
            let is_error = if sheet_idx < grids.len() {
                cell_is_error(&grids[sheet_idx], cs_row, cs_col)
            } else {
                false
            };

            cross_sheet_refs.push(TraceCrossSheetRef {
                sheet_name,
                sheet_index: sheet_idx,
                row: cs_row,
                col: cs_col,
                is_error,
            });
        }
    }

    TraceResult {
        source_row: row,
        source_col: col,
        cells,
        ranges,
        cross_sheet_refs,
        source_is_error,
    }
}
