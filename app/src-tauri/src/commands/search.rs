//! FILENAME: app/src-tauri/src/commands/search.rs
// PURPOSE: Find and replace functionality.

use crate::api_types::CellData;
use crate::commands::utils::get_cell_internal_with_merge;
use crate::{format_cell_value, AppState};
use engine::CellValue;
use tauri::State;

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

/// Find all cells matching the query.
#[tauri::command]
pub fn find_all(
    state: State<AppState>,
    query: String,
    case_sensitive: bool,
    match_entire_cell: bool,
    search_formulas: bool,
) -> FindResult {
    let grid = state.grid.lock().unwrap();
    let matches = grid.find_all(&query, case_sensitive, match_entire_cell, search_formulas);
    let total_count = matches.len();
    FindResult { matches, total_count }
}

/// Count matches without returning coordinates (faster for large grids).
#[tauri::command]
pub fn count_matches(
    state: State<AppState>,
    query: String,
    case_sensitive: bool,
    match_entire_cell: bool,
    search_formulas: bool,
) -> usize {
    let grid = state.grid.lock().unwrap();
    grid.count_matches(&query, case_sensitive, match_entire_cell, search_formulas)
}

/// Replace all occurrences of search text with replacement text.
/// This is an atomic operation - a single undo will revert all changes.
/// Returns the updated cells and count of replacements made.
#[tauri::command]
pub fn replace_all(
    state: State<AppState>,
    search: String,
    replacement: String,
    case_sensitive: bool,
    match_entire_cell: bool,
) -> Result<ReplaceResult, String> {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    // Find all matching cells first
    let matches = grid.find_all(&search, case_sensitive, match_entire_cell, false);
    
    if matches.is_empty() {
        return Ok(ReplaceResult {
            updated_cells: Vec::new(),
            replacement_count: 0,
        });
    }

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

    for (row, col) in matches {
        // Record previous state for undo
        let previous_cell = grid.get_cell(row, col).cloned();
        
        if let Some(cell) = grid.get_cell(row, col).cloned() {
            // Only replace in text values, not formulas
            if cell.formula.is_some() {
                continue; // Skip formula cells for safety
            }

            let new_value = match &cell.value {
                CellValue::Text(text) => {
                    let new_text = if case_sensitive {
                        text.replace(&search, &replacement)
                    } else {
                        // Case-insensitive replace
                        replace_case_insensitive(text, &search, &replacement)
                    };
                    
                    if match_entire_cell && new_text != replacement {
                        continue; // Skip if not exact match in entire-cell mode
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
                            // Replace entire number with replacement text
                            Some(CellValue::Text(replacement.clone()))
                        } else {
                            None
                        }
                    } else if text_normalized.contains(&search_normalized) {
                        let new_text = if case_sensitive {
                            text.replace(&search, &replacement)
                        } else {
                            replace_case_insensitive(&text, &search, &replacement)
                        };
                        // Try to parse as number, otherwise keep as text
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
                
                // Record undo
                undo_stack.record_cell_change(row, col, previous_cell);
                
                // Update grid
                grid.set_cell(row, col, new_cell.clone());
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(row, col, new_cell.clone());
                }

                // Get display value for frontend
                let style = styles.get(new_cell.style_index);
                let display = format_cell_value(&new_cell.value, style);

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
                    formula: new_cell.formula,
                    style_index: new_cell.style_index,
                    row_span,
                    col_span,
                    sheet_index: None,
                });

                replacement_count += 1;
            }
        }
    }

    // Commit the atomic transaction
    undo_stack.commit_transaction();

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

/// Replace a single cell's content (for Replace Next functionality).
#[tauri::command]
pub fn replace_single(
    state: State<AppState>,
    row: u32,
    col: u32,
    search: String,
    replacement: String,
    case_sensitive: bool,
) -> Result<Option<CellData>, String> {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    let previous_cell = grid.get_cell(row, col).cloned();
    
    if let Some(cell) = previous_cell.clone() {
        // Skip formula cells
        if cell.formula.is_some() {
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
            
            // Record undo
            undo_stack.record_cell_change(row, col, previous_cell);
            
            // Update grid
            grid.set_cell(row, col, new_cell.clone());
            if active_sheet < grids.len() {
                grids[active_sheet].set_cell(row, col, new_cell.clone());
            }

            let style = styles.get(new_cell.style_index);
            let display = format_cell_value(&new_cell.value, style);

            // Get merge span info
            let merge_info = merged_regions.iter().find(|r| r.start_row == row && r.start_col == col);
            let (row_span, col_span) = if let Some(region) = merge_info {
                (region.end_row - region.start_row + 1, region.end_col - region.start_col + 1)
            } else {
                (1, 1)
            };

            return Ok(Some(CellData {
                row,
                col,
                display,
                formula: new_cell.formula,
                style_index: new_cell.style_index,
                row_span,
                col_span,
                sheet_index: None,
            }));
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