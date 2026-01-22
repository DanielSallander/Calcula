// FILENAME: src-tauri/src/calculation.rs
// PURPOSE: Calculation mode commands for manual/automatic recalculation.

use tauri::State;
use crate::{AppState, evaluate_formula, format_cell_value};
use crate::api_types::CellData;
use crate::{log_enter, log_exit, log_enter_info, log_exit_info, log_debug, log_warn};

// ============================================================================
// CALCULATION MODE COMMANDS
// ============================================================================

/// Set the calculation mode ("automatic" or "manual")
#[tauri::command]
pub fn set_calculation_mode(state: State<AppState>, mode: String) -> String {
    log_enter_info!("CMD", "set_calculation_mode", "mode={}", mode);
    
    let valid_mode = match mode.to_lowercase().as_str() {
        "automatic" | "auto" => "automatic".to_string(),
        "manual" => "manual".to_string(),
        _ => {
            log_warn!("CMD", "invalid calculation mode: {}, defaulting to automatic", mode);
            "automatic".to_string()
        }
    };
    
    let mut calc_mode = state.calculation_mode.lock().unwrap();
    *calc_mode = valid_mode.clone();
    
    log_exit_info!("CMD", "set_calculation_mode", "set to {}", valid_mode);
    valid_mode
}

/// Get the current calculation mode
#[tauri::command]
pub fn get_calculation_mode(state: State<AppState>) -> String {
    log_enter!("CMD", "get_calculation_mode");
    
    let calc_mode = state.calculation_mode.lock().unwrap();
    let mode = calc_mode.clone();
    
    log_exit!("CMD", "get_calculation_mode", "mode={}", mode);
    mode
}

/// Recalculate all formulas in the grid.
#[tauri::command]
pub fn calculate_now(state: State<AppState>) -> Result<Vec<CellData>, String> {
    use crate::{evaluate_formula_multi_sheet, format_cell_value};
    use crate::api_types::CellData;
    
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();

    let mut updated_cells = Vec::new();

    // Collect all cells with formulas
    let formula_cells: Vec<_> = grid
        .cells
        .iter()
        .filter_map(|(&(row, col), cell)| {
            cell.formula.as_ref().map(|f| (row, col, f.clone()))
        })
        .collect();

    // Re-evaluate each formula using multi-sheet context
    for (row, col, formula) in formula_cells {
        let result = evaluate_formula_multi_sheet(
            &grids,
            &sheet_names,
            active_sheet,
            &formula,
        );

        if let Some(cell) = grid.get_cell(row, col) {
            let mut updated = cell.clone();
            updated.value = result;
            grid.set_cell(row, col, updated.clone());
            
            // Keep grids vector in sync
            if active_sheet < grids.len() {
                grids[active_sheet].set_cell(row, col, updated.clone());
            }

            let style = styles.get(updated.style_index);
            let display = format_cell_value(&updated.value, style);

            updated_cells.push(CellData {
                row,
                col,
                display,
                formula: updated.formula,
                style_index: updated.style_index,
                row_span: 1,
                col_span: 1,
            });
        }
    }

    Ok(updated_cells)
}

/// Recalculate all formula cells in the current sheet (same as calculate_now for single-sheet)
#[tauri::command]
pub fn calculate_sheet(state: State<AppState>) -> Result<Vec<CellData>, String> {
    log_enter_info!("CMD", "calculate_sheet");
    
    // For now, calculate_sheet does the same as calculate_now since we have a single sheet
    let result = calculate_now(state);
    
    log_exit_info!("CMD", "calculate_sheet", "done");
    result
}