// PURPOSE: Navigation logic (e.g., Ctrl+Arrow).

use crate::AppState;
use engine::CellValue;
use tauri::State;

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