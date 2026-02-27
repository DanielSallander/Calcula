//! FILENAME: app/src-tauri/src/calculation.rs
// PURPOSE: Calculation mode commands for manual/automatic recalculation.

use tauri::State;
use crate::{AppState, evaluate_formula, format_cell_value};
use crate::api_types::CellData;
use crate::{log_enter, log_exit, log_enter_info, log_exit_info, log_debug, log_warn};
use engine;

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
    use crate::{evaluate_formula_with_effects, clear_ui_effects_for_cell, process_ui_effects, format_cell_value};
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

    // Lock table state once for all formula evaluations
    let tables_map = state.tables.lock().unwrap();
    let table_names_map = state.table_names.lock().unwrap();
    let named_ranges_map = state.named_ranges.lock().unwrap();
    let mut ui_registry = state.ui_effect_registry.lock().unwrap();
    let mut row_heights = state.row_heights.lock().unwrap();
    let mut column_widths = state.column_widths.lock().unwrap();

    // Re-evaluate each formula using multi-sheet context
    for (row, col, formula) in formula_cells {
        // Build EvalContext for this cell
        let eval_ctx = engine::EvalContext {
            current_row: Some(row),
            current_col: Some(col),
            row_heights: Some(row_heights.clone()),
            column_widths: Some(column_widths.clone()),
        };

        // Parse, resolve names and table refs, then evaluate
        let (result, effects) = match parser::parse(&formula) {
            Ok(parsed) => {
                // Resolve named references
                let resolved = if crate::ast_has_named_refs(&parsed) {
                    let mut visited = std::collections::HashSet::new();
                    crate::resolve_names_in_ast(&parsed, &named_ranges_map, active_sheet, &mut visited)
                } else {
                    parsed
                };

                // Resolve structured table references
                let resolved = if crate::ast_has_table_refs(&resolved) {
                    let ctx = crate::TableRefContext {
                        tables: &tables_map,
                        table_names: &table_names_map,
                        current_sheet_index: active_sheet,
                        current_row: row,
                    };
                    crate::resolve_table_refs_in_ast(&resolved, &ctx)
                } else {
                    resolved
                };

                let engine_ast = crate::convert_expr(&resolved);
                evaluate_formula_with_effects(
                    &grids,
                    &sheet_names,
                    active_sheet,
                    &engine_ast,
                    eval_ctx,
                    Some(&styles),
                )
            }
            Err(_) => (engine::CellValue::Error(engine::CellError::Value), Vec::new()),
        };

        // Process UI effects
        let mut final_result = result;
        if !effects.is_empty() {
            clear_ui_effects_for_cell((active_sheet, row, col), &mut ui_registry);
            let effect_result = process_ui_effects(
                &effects,
                (active_sheet, row, col),
                &mut ui_registry,
                &mut row_heights,
                &mut column_widths,
            );
            if effect_result.has_conflict {
                final_result = engine::CellValue::Error(engine::CellError::Conflict);
            }
        }

        if let Some(cell) = grid.get_cell(row, col) {
            let mut updated = cell.clone();
            updated.value = final_result;
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
                display_color: None,
                formula: updated.formula,
                style_index: updated.style_index,
                row_span: 1,
                col_span: 1,
                sheet_index: None,
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
