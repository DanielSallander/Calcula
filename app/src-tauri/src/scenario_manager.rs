//! FILENAME: app/src-tauri/src/scenario_manager.rs
// PURPOSE: Scenario Manager - create, show, compare, and merge named scenarios.
// CONTEXT: Each scenario stores a set of changing cell values that can be applied
//          to the spreadsheet. Scenarios are stored per-sheet in AppState.

use std::collections::{HashMap, HashSet};
use tauri::State;

use crate::api_types::{
    CellData, MergedRegion, Scenario, ScenarioAddParams, ScenarioDeleteParams,
    ScenarioListResult, ScenarioResult, ScenarioShowParams, ScenarioShowResult,
    ScenarioSummaryParams, ScenarioSummaryResult, ScenarioSummaryRow,
};
use crate::{
    evaluate_formula_multi_sheet, format_cell_value, get_column_row_dependents,
    get_recalculation_order, AppState,
};
use engine::{Cell, CellValue, Grid, StyleRegistry};

// ============================================================================
// Helper: build CellData from grid
// ============================================================================

fn build_cell_data(
    grid: &Grid,
    styles: &StyleRegistry,
    merged_regions: &HashSet<MergedRegion>,
    r: u32,
    c: u32,
    locale: &engine::LocaleSettings,
) -> Option<CellData> {
    let cell = grid.get_cell(r, c)?;
    let style = styles.get(cell.style_index);
    let display = format_cell_value(&cell.value, style, locale);

    let merge = merged_regions
        .iter()
        .find(|m| m.start_row == r && m.start_col == c);
    let (row_span, col_span) = match merge {
        Some(m) => (m.end_row - m.start_row + 1, m.end_col - m.start_col + 1),
        None => (1, 1),
    };

    Some(CellData {
        row: r,
        col: c,
        display,
        display_color: None,
        formula: cell.formula.clone(),
        style_index: cell.style_index,
        row_span,
        col_span,
        sheet_index: None,
        rich_text: None,
        accounting_layout: None,
    })
}

/// Format a cell reference like "$A$1" from 0-based row/col.
fn format_cell_ref(row: u32, col: u32) -> String {
    let col_letter = crate::column_index_to_letter(col);
    format!("${}${}", col_letter, row + 1)
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// List all scenarios for a given sheet.
#[tauri::command]
pub fn scenario_list(
    state: State<AppState>,
    sheet_index: usize,
) -> ScenarioListResult {
    let scenarios = state.scenarios.lock().unwrap();
    let sheet_scenarios = scenarios.get(&sheet_index).cloned().unwrap_or_default();
    ScenarioListResult {
        scenarios: sheet_scenarios,
    }
}

/// Add or update a scenario.
#[tauri::command]
pub fn scenario_add(
    state: State<AppState>,
    params: ScenarioAddParams,
) -> ScenarioResult {
    crate::log_info!(
        "SCENARIO",
        "Adding scenario '{}' for sheet {}",
        params.name,
        params.sheet_index
    );

    if params.name.trim().is_empty() {
        return ScenarioResult {
            success: false,
            error: Some("Scenario name cannot be empty.".to_string()),
        };
    }

    if params.changing_cells.is_empty() {
        return ScenarioResult {
            success: false,
            error: Some("At least one changing cell is required.".to_string()),
        };
    }

    let mut scenarios = state.scenarios.lock().unwrap();
    let sheet_scenarios = scenarios.entry(params.sheet_index).or_default();

    // Check for duplicate name (case-insensitive)
    let name_upper = params.name.trim().to_uppercase();
    if let Some(existing) = sheet_scenarios
        .iter_mut()
        .find(|s| s.name.to_uppercase() == name_upper)
    {
        // Update existing scenario
        existing.changing_cells = params.changing_cells;
        existing.comment = params.comment;
        return ScenarioResult {
            success: true,
            error: None,
        };
    }

    // Add new scenario
    sheet_scenarios.push(Scenario {
        name: params.name.trim().to_string(),
        changing_cells: params.changing_cells,
        comment: params.comment,
        created_by: std::env::var("USERNAME").unwrap_or_else(|_| "User".to_string()),
        sheet_index: params.sheet_index,
    });

    ScenarioResult {
        success: true,
        error: None,
    }
}

/// Delete a scenario by name.
#[tauri::command]
pub fn scenario_delete(
    state: State<AppState>,
    params: ScenarioDeleteParams,
) -> ScenarioResult {
    crate::log_info!(
        "SCENARIO",
        "Deleting scenario '{}' from sheet {}",
        params.name,
        params.sheet_index
    );

    let mut scenarios = state.scenarios.lock().unwrap();
    let sheet_scenarios = scenarios.entry(params.sheet_index).or_default();

    let name_upper = params.name.to_uppercase();
    let original_len = sheet_scenarios.len();
    sheet_scenarios.retain(|s| s.name.to_uppercase() != name_upper);

    if sheet_scenarios.len() == original_len {
        ScenarioResult {
            success: false,
            error: Some(format!("Scenario '{}' not found.", params.name)),
        }
    } else {
        ScenarioResult {
            success: true,
            error: None,
        }
    }
}

/// Show (apply) a scenario: set the changing cells to the scenario values
/// and recalculate all dependents.
#[tauri::command]
pub fn scenario_show(
    state: State<AppState>,
    params: ScenarioShowParams,
) -> ScenarioShowResult {
    crate::log_info!(
        "SCENARIO",
        "Showing scenario '{}' on sheet {}",
        params.name,
        params.sheet_index
    );

    // Find the scenario
    let scenarios = state.scenarios.lock().unwrap();
    let sheet_scenarios = scenarios.get(&params.sheet_index);
    let scenario = sheet_scenarios.and_then(|ss| {
        let name_upper = params.name.to_uppercase();
        ss.iter().find(|s| s.name.to_uppercase() == name_upper)
    });

    let scenario = match scenario {
        Some(s) => s.clone(),
        None => {
            return ScenarioShowResult {
                updated_cells: Vec::new(),
                error: Some(format!("Scenario '{}' not found.", params.name)),
            };
        }
    };
    drop(scenarios);

    // Acquire grid locks
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let dependents_map = state.dependents.lock().unwrap();
    let column_dependents_map = state.column_dependents.lock().unwrap();
    let row_dependents_map = state.row_dependents.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    let sheet_idx = params.sheet_index;
    let mut all_affected = Vec::new();

    // Apply each changing cell value
    for sc in &scenario.changing_cells {
        let style_index = grids[sheet_idx]
            .get_cell(sc.row, sc.col)
            .map_or(0, |c| c.style_index);

        let cell_value = parse_scenario_value(&sc.value);
        let mut new_cell = match &cell_value {
            CellValue::Number(n) => Cell::new_number(*n),
            CellValue::Text(t) => Cell::new_text(t.clone()),
            CellValue::Boolean(b) => Cell::new_boolean(*b),
            _ => Cell::new_text(sc.value.clone()),
        };
        new_cell.style_index = style_index;

        grids[sheet_idx].set_cell(sc.row, sc.col, new_cell.clone());
        if sheet_idx == active_sheet {
            grid.set_cell(sc.row, sc.col, new_cell);
        }

        all_affected.push((sc.row, sc.col));

        // Collect dependents for recalculation
        let recalc = get_recalculation_order((sc.row, sc.col), &dependents_map);
        let extra =
            get_column_row_dependents((sc.row, sc.col), &column_dependents_map, &row_dependents_map);
        for dep in recalc.iter().chain(extra.iter()) {
            if !all_affected.contains(dep) {
                all_affected.push(*dep);
            }
        }
    }

    // Re-evaluate all affected formula cells
    for &(r, c) in &all_affected {
        if let Some(cell) = grids[sheet_idx].get_cell(r, c).cloned() {
            if let Some(formula) = &cell.formula {
                let new_value =
                    evaluate_formula_multi_sheet(&grids, &sheet_names, sheet_idx, formula);
                let mut updated = cell;
                updated.value = new_value;
                grids[sheet_idx].set_cell(r, c, updated.clone());
                if sheet_idx == active_sheet {
                    grid.set_cell(r, c, updated);
                }
            }
        }
    }

    // Build updated cells
    let mut updated_cells = Vec::new();
    for &(r, c) in &all_affected {
        if let Some(cd) = build_cell_data(&grids[sheet_idx], &styles, &merged_regions, r, c, &locale) {
            updated_cells.push(cd);
        }
    }

    ScenarioShowResult {
        updated_cells,
        error: None,
    }
}

/// Generate a scenario summary report comparing all scenarios.
#[tauri::command]
pub fn scenario_summary(
    state: State<AppState>,
    params: ScenarioSummaryParams,
) -> ScenarioSummaryResult {
    crate::log_info!("SCENARIO", "Generating summary for sheet {}", params.sheet_index);

    let scenarios_store = state.scenarios.lock().unwrap();
    let sheet_scenarios = match scenarios_store.get(&params.sheet_index) {
        Some(ss) if !ss.is_empty() => ss.clone(),
        _ => {
            return ScenarioSummaryResult {
                scenario_names: Vec::new(),
                rows: Vec::new(),
                error: Some("No scenarios defined for this sheet.".to_string()),
            };
        }
    };
    drop(scenarios_store);

    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let dependents_map = state.dependents.lock().unwrap();
    let column_dependents_map = state.column_dependents.lock().unwrap();
    let row_dependents_map = state.row_dependents.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    let sheet_idx = params.sheet_index;
    let scenario_names: Vec<String> = sheet_scenarios.iter().map(|s| s.name.clone()).collect();

    // Collect all unique changing cells across all scenarios
    let mut changing_cell_positions: Vec<(u32, u32)> = Vec::new();
    for scenario in &sheet_scenarios {
        for sc in &scenario.changing_cells {
            let pos = (sc.row, sc.col);
            if !changing_cell_positions.contains(&pos) {
                changing_cell_positions.push(pos);
            }
        }
    }

    // Save current values for all changing cells so we can restore
    let mut original_cells: Vec<((u32, u32), Option<Cell>)> = Vec::new();
    for &(r, c) in &changing_cell_positions {
        let cell = grids[sheet_idx].get_cell(r, c).cloned();
        original_cells.push(((r, c), cell));
    }

    // Also save current values of result cells
    let result_positions: Vec<(u32, u32)> = params
        .result_cells
        .iter()
        .map(|rc| (rc.row, rc.col))
        .collect();

    // Get current display values for all cells
    let mut current_changing_values: Vec<String> = Vec::new();
    for &(r, c) in &changing_cell_positions {
        let val = grids[sheet_idx]
            .get_cell(r, c)
            .map(|cell| {
                let style = styles.get(cell.style_index);
                format_cell_value(&cell.value, style, &locale)
            })
            .unwrap_or_default();
        current_changing_values.push(val);
    }

    let mut current_result_values: Vec<String> = Vec::new();
    for &(r, c) in &result_positions {
        let val = grids[sheet_idx]
            .get_cell(r, c)
            .map(|cell| {
                let style = styles.get(cell.style_index);
                format_cell_value(&cell.value, style, &locale)
            })
            .unwrap_or_default();
        current_result_values.push(val);
    }

    // For each scenario, apply values and evaluate result cells
    let mut scenario_changing_values: Vec<Vec<String>> = Vec::new();
    let mut scenario_result_values: Vec<Vec<String>> = Vec::new();

    for scenario in &sheet_scenarios {
        // Apply scenario values
        for &(r, c) in &changing_cell_positions {
            let sc_cell = scenario
                .changing_cells
                .iter()
                .find(|sc| sc.row == r && sc.col == c);
            if let Some(sc) = sc_cell {
                let style_index = grids[sheet_idx]
                    .get_cell(r, c)
                    .map_or(0, |c| c.style_index);
                let cell_value = parse_scenario_value(&sc.value);
                let mut new_cell = match &cell_value {
                    CellValue::Number(n) => Cell::new_number(*n),
                    CellValue::Text(t) => Cell::new_text(t.clone()),
                    CellValue::Boolean(b) => Cell::new_boolean(*b),
                    _ => Cell::new_text(sc.value.clone()),
                };
                new_cell.style_index = style_index;
                grids[sheet_idx].set_cell(r, c, new_cell);
            }
        }

        // Recalculate all dependents
        let mut all_deps = Vec::new();
        for &(r, c) in &changing_cell_positions {
            let recalc = get_recalculation_order((r, c), &dependents_map);
            let extra = get_column_row_dependents(
                (r, c),
                &column_dependents_map,
                &row_dependents_map,
            );
            for dep in recalc.iter().chain(extra.iter()) {
                if !all_deps.contains(dep) {
                    all_deps.push(*dep);
                }
            }
        }

        for &(r, c) in &all_deps {
            if let Some(cell) = grids[sheet_idx].get_cell(r, c).cloned() {
                if let Some(formula) = &cell.formula {
                    let new_value =
                        evaluate_formula_multi_sheet(&grids, &sheet_names, sheet_idx, formula);
                    let mut updated = cell;
                    updated.value = new_value;
                    grids[sheet_idx].set_cell(r, c, updated);
                }
            }
        }

        // Collect changing cell values for this scenario
        let mut changing_vals = Vec::new();
        for &(r, c) in &changing_cell_positions {
            let sc_cell = scenario
                .changing_cells
                .iter()
                .find(|sc| sc.row == r && sc.col == c);
            changing_vals.push(sc_cell.map_or(String::new(), |sc| sc.value.clone()));
        }
        scenario_changing_values.push(changing_vals);

        // Collect result cell values
        let mut result_vals = Vec::new();
        for &(r, c) in &result_positions {
            let val = grids[sheet_idx]
                .get_cell(r, c)
                .map(|cell| {
                    let style = styles.get(cell.style_index);
                    format_cell_value(&cell.value, style, &locale)
                })
                .unwrap_or_default();
            result_vals.push(val);
        }
        scenario_result_values.push(result_vals);

        // Restore original values
        for &((r, c), ref orig_cell) in &original_cells {
            match orig_cell {
                Some(cell) => grids[sheet_idx].set_cell(r, c, cell.clone()),
                None => {
                    grids[sheet_idx].set_cell(r, c, Cell::default());
                }
            }
        }

        // Recalculate after restore
        for &(r, c) in &all_deps {
            if let Some(cell) = grids[sheet_idx].get_cell(r, c).cloned() {
                if let Some(formula) = &cell.formula {
                    let new_value =
                        evaluate_formula_multi_sheet(&grids, &sheet_names, sheet_idx, formula);
                    let mut updated = cell;
                    updated.value = new_value;
                    grids[sheet_idx].set_cell(r, c, updated.clone());
                    if sheet_idx == active_sheet {
                        grid.set_cell(r, c, updated);
                    }
                }
            }
        }
    }

    // Build summary rows
    let mut rows = Vec::new();

    // Changing cell rows
    for (i, &(r, c)) in changing_cell_positions.iter().enumerate() {
        let scenario_values: Vec<String> = scenario_changing_values
            .iter()
            .map(|sv| sv[i].clone())
            .collect();
        rows.push(ScenarioSummaryRow {
            cell_ref: format_cell_ref(r, c),
            current_value: current_changing_values[i].clone(),
            scenario_values,
            is_changing_cell: true,
        });
    }

    // Result cell rows
    for (i, &(r, c)) in result_positions.iter().enumerate() {
        let scenario_values: Vec<String> = scenario_result_values
            .iter()
            .map(|sv| sv[i].clone())
            .collect();
        rows.push(ScenarioSummaryRow {
            cell_ref: format_cell_ref(r, c),
            current_value: current_result_values[i].clone(),
            scenario_values,
            is_changing_cell: false,
        });
    }

    ScenarioSummaryResult {
        scenario_names,
        rows,
        error: None,
    }
}

/// Merge scenarios from another sheet into the current sheet.
#[tauri::command]
pub fn scenario_merge(
    state: State<AppState>,
    source_sheet_index: usize,
    target_sheet_index: usize,
) -> ScenarioResult {
    crate::log_info!(
        "SCENARIO",
        "Merging scenarios from sheet {} to sheet {}",
        source_sheet_index,
        target_sheet_index
    );

    let mut scenarios = state.scenarios.lock().unwrap();
    let source_scenarios = scenarios
        .get(&source_sheet_index)
        .cloned()
        .unwrap_or_default();

    if source_scenarios.is_empty() {
        return ScenarioResult {
            success: false,
            error: Some("No scenarios to merge from source sheet.".to_string()),
        };
    }

    let target_scenarios = scenarios.entry(target_sheet_index).or_default();

    let mut merged_count = 0;
    for source in &source_scenarios {
        let name_upper = source.name.to_uppercase();
        let exists = target_scenarios
            .iter()
            .any(|s| s.name.to_uppercase() == name_upper);

        if !exists {
            let mut merged = source.clone();
            merged.sheet_index = target_sheet_index;
            target_scenarios.push(merged);
            merged_count += 1;
        }
    }

    ScenarioResult {
        success: true,
        error: if merged_count == 0 {
            Some("All scenarios already exist in target sheet (names match).".to_string())
        } else {
            None
        },
    }
}

// ============================================================================
// Helpers
// ============================================================================

/// Parse a string value into a CellValue.
fn parse_scenario_value(value: &str) -> CellValue {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return CellValue::Empty;
    }
    if let Ok(n) = trimmed.parse::<f64>() {
        return CellValue::Number(n);
    }
    match trimmed.to_uppercase().as_str() {
        "TRUE" => CellValue::Boolean(true),
        "FALSE" => CellValue::Boolean(false),
        _ => CellValue::Text(trimmed.to_string()),
    }
}
