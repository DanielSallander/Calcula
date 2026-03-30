//! FILENAME: app/src-tauri/src/commands/nav.rs
// PURPOSE: Navigation logic (e.g., Ctrl+Arrow, Go To Special).

use crate::AppState;
use engine::CellValue;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Detect the contiguous data region around a given cell (Excel's CurrentRegion).
///
/// Expands outward from the starting cell in all directions, stopping when
/// an entire row (within the current column span) or an entire column
/// (within the current row span) is empty. Iterates until stable because
/// expanding rows can reveal new columns and vice versa.
///
/// Returns `None` if the starting cell is empty and has no adjacent data.
#[tauri::command]
pub fn detect_data_region(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Option<(u32, u32, u32, u32)> {
    let grid = state.grid.lock().unwrap();

    // Helper: does this cell have content?
    let has_content = |r: u32, c: u32| -> bool {
        grid.get_cell(r, c)
            .map(|cell| cell.formula.is_some() || !matches!(cell.value, CellValue::Empty))
            .unwrap_or(false)
    };

    // Helper: is an entire row empty within a column range?
    let row_empty = |r: u32, sc: u32, ec: u32| -> bool {
        for c in sc..=ec {
            if has_content(r, c) {
                return false;
            }
        }
        true
    };

    // Helper: is an entire column empty within a row range?
    let col_empty = |c: u32, sr: u32, er: u32| -> bool {
        for r in sr..=er {
            if has_content(r, c) {
                return false;
            }
        }
        true
    };

    let mut sr = row;
    let mut er = row;
    let mut sc = col;
    let mut ec = col;

    loop {
        let prev = (sr, er, sc, ec);

        // Expand up
        while sr > 0 && !row_empty(sr - 1, sc, ec) {
            sr -= 1;
        }
        // Expand down
        while er < grid.max_row && !row_empty(er + 1, sc, ec) {
            er += 1;
        }
        // Expand left
        while sc > 0 && !col_empty(sc - 1, sr, er) {
            sc -= 1;
        }
        // Expand right
        while ec < grid.max_col && !col_empty(ec + 1, sr, er) {
            ec += 1;
        }

        if (sr, er, sc, ec) == prev {
            break;
        }
    }

    // If the region is just the starting cell and it's empty, no region found
    if sr == er && sc == ec && !has_content(row, col) {
        return None;
    }

    Some((sr, sc, er, ec))
}

/// Find the target cell for Ctrl+Arrow navigation (Excel-like behavior).
/// 
/// Excel's Ctrl+Arrow behavior:
/// - If current cell is empty: jump to the next non-empty cell (or edge if none)
/// - If current cell has content AND next cell is empty: jump to next non-empty (or edge)
/// - If current cell has content AND next cell has content: jump to end of contiguous block
#[tauri::command]
pub fn find_ctrl_arrow_target(
    state: State<AppState>,
    row: u32,
    col: u32,
    direction: String,
    max_row: u32,
    max_col: u32,
) -> (u32, u32) {
    let grid = state.grid.lock().unwrap();
    
    // Determine direction deltas
    let (d_row, d_col): (i32, i32) = match direction.as_str() {
        "up" => (-1, 0),
        "down" => (1, 0),
        "left" => (0, -1),
        "right" => (0, 1),
        _ => return (row, col),
    };
    
    // Helper to check if a cell has content
    let is_non_empty = |r: u32, c: u32| -> bool {
        grid.get_cell(r, c)
            .map(|cell| !matches!(cell.value, CellValue::Empty))
            .unwrap_or(false)
    };
    
    // Helper to check bounds
    let is_in_bounds = |r: i32, c: i32| -> bool {
        r >= 0 && r <= max_row as i32 && c >= 0 && c <= max_col as i32
    };
    
    let current_has_content = is_non_empty(row, col);
    
    // Check the next cell in direction
    let next_r = row as i32 + d_row;
    let next_c = col as i32 + d_col;
    
    // If already at edge, stay in place
    if !is_in_bounds(next_r, next_c) {
        return (row, col);
    }
    
    let next_has_content = is_non_empty(next_r as u32, next_c as u32);
    
    if current_has_content && next_has_content {
        // CASE 1: Both current and next have content
        // Find the end of the contiguous non-empty block
        let mut r = next_r;
        let mut c = next_c;
        
        loop {
            let peek_r = r + d_row;
            let peek_c = c + d_col;
            
            // If peek is out of bounds or empty, current position is the target
            if !is_in_bounds(peek_r, peek_c) || !is_non_empty(peek_r as u32, peek_c as u32) {
                return (r as u32, c as u32);
            }
            
            // Continue to next cell
            r = peek_r;
            c = peek_c;
        }
    } else {
        // CASE 2: Current is empty OR next is empty
        // Find the next non-empty cell (or jump to edge if none found)
        
        // Special case: current is empty but next is non-empty -> return next
        if !current_has_content && next_has_content {
            return (next_r as u32, next_c as u32);
        }
        
        // Search starting from after the next cell
        let mut r = next_r;
        let mut c = next_c;
        
        loop {
            r += d_row;
            c += d_col;
            
            // Hit the edge without finding a non-empty cell
            if !is_in_bounds(r, c) {
                // Return the edge position
                let edge_r = if d_row < 0 { 0 } else if d_row > 0 { max_row as i32 } else { row as i32 };
                let edge_c = if d_col < 0 { 0 } else if d_col > 0 { max_col as i32 } else { col as i32 };
                return (edge_r as u32, edge_c as u32);
            }
            
            // Found a non-empty cell
            if is_non_empty(r as u32, c as u32) {
                return (r as u32, c as u32);
            }
        }
    }
}

// ============================================================================
// Go To Special
// ============================================================================

/// A cell coordinate returned for Go To Special results.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellCoord {
    pub row: u32,
    pub col: u32,
}

/// Result of go_to_special command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoToSpecialResult {
    pub cells: Vec<CellCoord>,
}

/// Find cells matching specific criteria within the used range of the active sheet.
/// `criteria` can be: "blanks", "formulas", "constants", "errors", "comments", "notes",
///   "conditionalFormats", "dataValidation"
/// `search_range` is optional: (startRow, startCol, endRow, endCol). If None, uses entire used range.
#[tauri::command]
pub fn go_to_special(
    state: State<AppState>,
    criteria: String,
    search_range: Option<(u32, u32, u32, u32)>,
) -> GoToSpecialResult {
    let grid = state.grid.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();

    // Determine search bounds
    let (sr, sc, er, ec) = search_range.unwrap_or((0, 0, grid.max_row, grid.max_col));

    let mut cells = Vec::new();

    match criteria.as_str() {
        "blanks" => {
            for row in sr..=er {
                for col in sc..=ec {
                    let is_blank = grid.get_cell(row, col)
                        .map(|cell| cell.formula.is_none() && matches!(cell.value, CellValue::Empty))
                        .unwrap_or(true);
                    if is_blank {
                        cells.push(CellCoord { row, col });
                    }
                }
            }
        }
        "formulas" => {
            for row in sr..=er {
                for col in sc..=ec {
                    let has_formula = grid.get_cell(row, col)
                        .map(|cell| cell.formula.is_some())
                        .unwrap_or(false);
                    if has_formula {
                        cells.push(CellCoord { row, col });
                    }
                }
            }
        }
        "constants" => {
            for row in sr..=er {
                for col in sc..=ec {
                    let is_constant = grid.get_cell(row, col)
                        .map(|cell| cell.formula.is_none() && !matches!(cell.value, CellValue::Empty))
                        .unwrap_or(false);
                    if is_constant {
                        cells.push(CellCoord { row, col });
                    }
                }
            }
        }
        "errors" => {
            for row in sr..=er {
                for col in sc..=ec {
                    let is_error = grid.get_cell(row, col)
                        .map(|cell| matches!(cell.value, CellValue::Error(_)))
                        .unwrap_or(false);
                    if is_error {
                        cells.push(CellCoord { row, col });
                    }
                }
            }
        }
        "comments" => {
            let comments = state.comments.lock().unwrap();
            if let Some(sheet_comments) = comments.get(&active_sheet) {
                for (&(row, col), _) in sheet_comments {
                    if row >= sr && row <= er && col >= sc && col <= ec {
                        cells.push(CellCoord { row, col });
                    }
                }
            }
        }
        "notes" => {
            let notes = state.notes.lock().unwrap();
            if let Some(sheet_notes) = notes.get(&active_sheet) {
                for (&(row, col), _) in sheet_notes {
                    if row >= sr && row <= er && col >= sc && col <= ec {
                        cells.push(CellCoord { row, col });
                    }
                }
            }
        }
        "conditionalFormats" => {
            let cfs = state.conditional_formats.lock().unwrap();
            if let Some(sheet_cfs) = cfs.get(&active_sheet) {
                let mut cell_set = std::collections::HashSet::new();
                for cf in sheet_cfs {
                    for range in &cf.ranges {
                        for row in range.start_row..=range.end_row {
                            for col in range.start_col..=range.end_col {
                                if row >= sr && row <= er && col >= sc && col <= ec {
                                    cell_set.insert((row, col));
                                }
                            }
                        }
                    }
                }
                for (row, col) in cell_set {
                    cells.push(CellCoord { row, col });
                }
            }
        }
        "dataValidation" => {
            let validations = state.data_validations.lock().unwrap();
            if let Some(sheet_validations) = validations.get(&active_sheet) {
                let mut cell_set = std::collections::HashSet::new();
                for vr in sheet_validations {
                    for row in vr.start_row..=vr.end_row {
                        for col in vr.start_col..=vr.end_col {
                            if row >= sr && row <= er && col >= sc && col <= ec {
                                cell_set.insert((row, col));
                            }
                        }
                    }
                }
                for (row, col) in cell_set {
                    cells.push(CellCoord { row, col });
                }
            }
        }
        _ => {}
    }

    // Sort by row then col for consistent ordering
    cells.sort_by(|a, b| a.row.cmp(&b.row).then(a.col.cmp(&b.col)));

    GoToSpecialResult { cells }
}