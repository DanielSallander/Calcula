//! FILENAME: app/src-tauri/src/scenario_manager.rs
// PURPOSE: Scenario Manager - create, show, compare, and merge named scenarios.
// CONTEXT: Each scenario stores a set of changing cell values that can be applied
//          to the spreadsheet. Scenarios are stored per-sheet in AppState.

use tauri::State;

use crate::api_types::{
    Scenario, ScenarioAddParams, ScenarioDeleteParams,
    ScenarioListResult, ScenarioResult, ScenarioShowParams, ScenarioShowResult,
    ScenarioSummaryParams, ScenarioSummaryResult, ScenarioSummaryRow,
};
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::whatif_recalc::{stored_cell, write_cells_and_recalc, RecalcMode, WhatIfStates};
use crate::{format_cell_value, AppState};
use engine::{Cell, CellValue};

// SCENARIOS ARE PERSISTED (`workbook.scenarios`) AND SCENARIO_SHOW IS NOT TRANSIENT.
//
// `docs/design/animation-simulation.md` cites `scenario_show` as the transient-write
// precedent, and it is -- in the UNDO sense: it applies values without entering the
// undo stack. But transient in the DIRTY-FLAG sense means "there is a restore that runs
// unconditionally on stop and on BEFORE_SAVE", and there is no `scenario_restore`
// anywhere in this file. The values `scenario_show` writes stay in the cells and get
// saved, so it must dirty the document like any other cell write. Animation qualifies
// for the exemption (`anim_snapshot` files a restore buffer first and
// `TransientScope::prove_restore_registered` checks it); scenario_show cannot even
// construct a `TransientScope`, which is what makes the distinction structural rather
// than remembered.
//
// The same reasoning covers `scenario_summary`: it writes a summary report into fresh
// grid cells, and those cells are saved.

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
    let scenarios = state.scenarios.read().unwrap();
    let sheet_scenarios = scenarios.get(&sheet_index).cloned().unwrap_or_default();
    ScenarioListResult {
        scenarios: sheet_scenarios,
    }
}

/// Add or update a scenario.
#[tauri::command]
pub fn scenario_add(
    state: State<AppState>,
    file_state: State<FileState>,
    params: ScenarioAddParams,
) -> ScenarioResult {
    scenario_add_impl(&state, &file_state, params)
}

/// Command body over plain references, so both the "adds dirty" and the "a refused add
/// stays clean" contracts are unit-testable (see `document_effect_wave2_tests`).
pub(crate) fn scenario_add_impl(
    state: &AppState,
    file_state: &FileState,
    params: ScenarioAddParams,
) -> ScenarioResult {
    // allowEditScenarios option gate.
    if let Err(e) = crate::protection::check_sheet_action(
        &state, params.sheet_index, "editScenarios", "add or change scenarios",
    ) {
        return ScenarioResult { success: false, error: Some(e) };
    }
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

    // Past the allowEditScenarios gate and the name/changing-cell validation above.
    let effect = DocumentEffect::mutates(&file_state);
    let mut scenarios = state.scenarios.write(&effect).unwrap();
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
    file_state: State<FileState>,
    params: ScenarioDeleteParams,
) -> ScenarioResult {
    // allowEditScenarios option gate.
    if let Err(e) = crate::protection::check_sheet_action(
        &state, params.sheet_index, "editScenarios", "delete scenarios",
    ) {
        return ScenarioResult { success: false, error: Some(e) };
    }
    crate::log_info!(
        "SCENARIO",
        "Deleting scenario '{}' from sheet {}",
        params.name,
        params.sheet_index
    );

    // Past the allowEditScenarios gate above.
    let effect = DocumentEffect::mutates(&file_state);
    let mut scenarios = state.scenarios.write(&effect).unwrap();
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
    file_state: State<FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: ScenarioShowParams,
) -> ScenarioShowResult {
    let states = WhatIfStates {
        user_files: &user_files_state,
        pivots: &pivot_state,
        pane_control: &pane_control_state,
        ribbon_filter: &ribbon_filter_state,
    };
    scenario_show_impl(&state, &file_state, &states, params)
}

/// The body of [`scenario_show`], callable without a Tauri runtime.
///
/// The changing cells are written and EVERY dependent, on every sheet, is
/// recalculated through the shared cascade (`whatif_recalc`, BUG-0613), exactly
/// as if the user had typed the values. Excel [LIVE]: showing a scenario that
/// sets `Sheet1!A5` to 100 leaves `Sheet2!B5 = Sheet1!A5*3` at 300. This used to
/// re-evaluate only the scenario sheet's own dependents, positionlessly, through
/// the ACTIVE sheet's dependency map -- so a reader on another sheet kept its old
/// value, and the save's keep rule could then vouch for a stale cube or
/// custom-function value there.
pub(crate) fn scenario_show_impl(
    state: &AppState,
    file_state: &FileState,
    states: &WhatIfStates<'_>,
    params: ScenarioShowParams,
) -> ScenarioShowResult {
    // ONE what-if run at a time, taken before every gate (see `begin_whatif_run`):
    // a scenario shown between an async Data Table / Goal Seek / Solver run's
    // trials writes the cells that run borrowed and restores, and one shown
    // while an animation holds a restore buffer is undone by its Stop.
    let _run = match crate::whatif_recalc::begin_whatif_run(state) {
        Ok(run) => run,
        Err(e) => return ScenarioShowResult { updated_cells: Vec::new(), error: Some(e) },
    };
    // BACKGROUND. These results are written into cells the user reads, so they
    // get the persisting ceiling, not the tighter one.
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Background,
        &state.calc_cancel,
    );
    crate::log_info!(
        "SCENARIO",
        "Showing scenario '{}' on sheet {}",
        params.name,
        params.sheet_index
    );

    // A CANVAS has no cells for a scenario's changing cells to land in. The
    // store cannot hold one there any more (add and merge both refuse a
    // canvas), but a scenario that reached one before would otherwise write
    // straight into the hidden grid. Refused before the effect.
    if let Err(e) = crate::sheets::ensure_not_canvas_in_state(state, params.sheet_index, "show a scenario") {
        return ScenarioShowResult { updated_cells: Vec::new(), error: Some(e) };
    }

    // Find the scenario
    let scenario = {
        let scenarios = state.scenarios.read().unwrap();
        let name_upper = params.name.to_uppercase();
        scenarios
            .get(&params.sheet_index)
            .and_then(|ss| ss.iter().find(|s| s.name.to_uppercase() == name_upper))
            .cloned()
    };
    let scenario = match scenario {
        Some(s) => s,
        None => {
            return ScenarioShowResult {
                updated_cells: Vec::new(),
                error: Some(format!("Scenario '{}' not found.", params.name)),
            };
        }
    };

    // The scenario resolved, so the cell writes below WILL happen. They are permanent
    // (see the file header: there is no scenario_restore), so they change what a save
    // writes. Built here, past the not-found return above, so a bad scenario name
    // leaves the document clean.
    let effect = DocumentEffect::mutates(file_state);

    // Check writeback regions: skip changing cells that fall in writeback regions
    let writeback_skip: std::collections::HashSet<(u32, u32)> = {
        let wb_index = state.writeback_index.lock().unwrap();
        if wb_index.is_empty() {
            std::collections::HashSet::new()
        } else {
            let sheet_ids = state.sheet_ids.read().unwrap();
            if let Some(&sid) = sheet_ids.get(params.sheet_index) {
                scenario.changing_cells.iter()
                    .filter(|cc| wb_index.contains(sid, cc.row, cc.col))
                    .map(|cc| (cc.row, cc.col))
                    .collect()
            } else {
                std::collections::HashSet::new()
            }
        }
    };

    let sheet_idx = params.sheet_index;
    let writes: Vec<((u32, u32), Option<Cell>)> = scenario
        .changing_cells
        .iter()
        .filter(|sc| !writeback_skip.contains(&(sc.row, sc.col)))
        .map(|sc| ((sc.row, sc.col), Some(scenario_cell(state, sheet_idx, sc.row, sc.col, &sc.value))))
        .collect();

    let mut updated_cells = Vec::new();
    if let Err(e) = write_cells_and_recalc(
        state,
        states,
        &effect,
        sheet_idx,
        &writes,
        RecalcMode::AsAnEdit,
        &mut updated_cells,
    ) {
        return ScenarioShowResult { updated_cells, error: Some(e) };
    }

    // THE LIVE DATA TABLES FOLLOW THE SCENARIO (BUG-0755). Excel [LIVE, Excel
    // 16 over COM, 2026-11-06, dtable/probe4.ps1, `B1 = A1*2+C1`, table K1:L4
    // over `L1 = B1` with column input A1]: under automatic calculation
    // showing a scenario that sets C1 = 100 turned L2 from 10 into 110,
    // xlDone; under manual calculation it left the body for F9, xlPending. The
    // run holds the what-if single-flight, so the scenario's own writes never
    // refreshed a table (their recalculations are what-if writes) and the body
    // kept the old scenario's numbers; it is refreshed here, under the run's
    // own single-flight, once the scenario's cells are in.
    if crate::calculation::data_tables_recalculate_automatically(state) {
        crate::data_tables::refresh_live_tables_held(
            state,
            states,
            &_run,
            crate::data_tables::TableScope::Workbook,
            &mut updated_cells,
        );
    } else {
        crate::data_tables::note_tables_left_for_f9(state);
    }

    ScenarioShowResult {
        updated_cells,
        error: None,
    }
}

/// A changing cell holding `value`, keeping the style the cell has now.
fn scenario_cell(state: &AppState, sheet: usize, row: u32, col: u32, value: &str) -> Cell {
    let style_index = stored_cell(state, sheet, row, col).map_or(0, |c| c.style_index);
    let mut new_cell = match parse_scenario_value(value) {
        CellValue::Number(n) => Cell::new_number(n),
        CellValue::Text(t) => Cell::new_text(t),
        CellValue::Boolean(b) => Cell::new_boolean(b),
        _ => Cell::new_text(value.to_string()),
    };
    new_cell.style_index = style_index;
    new_cell
}

/// A cell's value as the sheet displays it (its effective style, the app locale).
fn display_of(state: &AppState, sheet: usize, row: u32, col: u32) -> String {
    let grids = state.grids.read().unwrap();
    let Some(g) = grids.get(sheet) else { return String::new() };
    let styles = state.style_registry.read().unwrap();
    let locale = state.locale.lock().unwrap();
    let effective_style_index = g.effective_style_index(row, col);
    g.get_cell(row, col)
        .map(|cell| format_cell_value(&cell.value, styles.get(effective_style_index), &locale))
        .unwrap_or_default()
}

/// Generate a scenario summary report comparing all scenarios.
#[tauri::command]
pub fn scenario_summary(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: ScenarioSummaryParams,
) -> ScenarioSummaryResult {
    let states = WhatIfStates {
        user_files: &user_files_state,
        pivots: &pivot_state,
        pane_control: &pane_control_state,
        ribbon_filter: &ribbon_filter_state,
    };
    scenario_summary_impl(&state, &file_state, &states, params)
}

/// The body of [`scenario_summary`], callable without a Tauri runtime.
///
/// Each scenario is shown (written and recalculated through the shared
/// cascade, as Scenario Show does), its result cells read, and the changing
/// cells put back exactly as they were -- recalculated again -- before the next
/// one; so a result cell that reaches a changing cell through another sheet
/// reports that scenario's value, and the workbook ends as it began.
///
/// UNDER MANUAL CALCULATION nothing is recalculated, as Scenario Show
/// recalculates nothing there (`RecalcMode::AsAnEdit`): the summary reports
/// the result cells' STORED values and every dependent ends exactly as it was,
/// stale or not. Excel [LIVE, 2026-10-30, manual calculation, `C1` changed
/// to 7 with no F9 so `D1 = C1*3` still shows 3]: the summary of a scenario
/// setting C1 to 100 reports D1 = 3 under both Current and the scenario, and
/// afterwards C1 = 7, D1 = 3 and an unrelated stale `B1 = A1*2` keep their
/// values. This used to recalculate each scenario and each restore whatever
/// the mode, so a value the user had left stale for F9 came back recalculated.
pub(crate) fn scenario_summary_impl(
    state: &AppState,
    file_state: &FileState,
    states: &WhatIfStates<'_>,
    params: ScenarioSummaryParams,
) -> ScenarioSummaryResult {
    // ONE what-if run at a time, taken before every gate (see `begin_whatif_run`):
    // the summary writes each scenario's changing cells and puts them back, the
    // same borrow-and-restore a Data Table run makes.
    let _run = match crate::whatif_recalc::begin_whatif_run(state) {
        Ok(run) => run,
        Err(e) => {
            return ScenarioSummaryResult { scenario_names: Vec::new(), rows: Vec::new(), error: Some(e) };
        }
    };
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Background,
        &state.calc_cancel,
    );
    crate::log_info!("SCENARIO", "Generating summary for sheet {}", params.sheet_index);

    // The summary applies each scenario into the sheet's grid and restores it,
    // leaving materialized cells behind: never on a canvas. Before the effect.
    if let Err(e) = crate::sheets::ensure_not_canvas_in_state(state, params.sheet_index, "summarize scenarios") {
        return ScenarioSummaryResult { scenario_names: Vec::new(), rows: Vec::new(), error: Some(e) };
    }

    let sheet_scenarios = {
        let scenarios_store = state.scenarios.read().unwrap();
        match scenarios_store.get(&params.sheet_index) {
            Some(ss) if !ss.is_empty() => ss.clone(),
            _ => {
                return ScenarioSummaryResult {
                    scenario_names: Vec::new(),
                    rows: Vec::new(),
                    error: Some("No scenarios defined for this sheet.".to_string()),
                };
            }
        }
    };

    // The scenarios are written into the grid and put back, and a volatile
    // dependent recalculated in between does not come back the same. Built past
    // the "no scenarios defined" return above, so that refusal stays clean.
    let effect = DocumentEffect::mutates(file_state);

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

    // Save current cells for all changing cells so we can restore
    let original_cells: Vec<((u32, u32), Option<Cell>)> = changing_cell_positions
        .iter()
        .map(|&(r, c)| ((r, c), stored_cell(state, sheet_idx, r, c)))
        .collect();

    let result_positions: Vec<(u32, u32)> = params
        .result_cells
        .iter()
        .map(|rc| (rc.row, rc.col))
        .collect();

    // Current display values
    let current_changing_values: Vec<String> = changing_cell_positions
        .iter()
        .map(|&(r, c)| display_of(state, sheet_idx, r, c))
        .collect();
    let current_result_values: Vec<String> = result_positions
        .iter()
        .map(|&(r, c)| display_of(state, sheet_idx, r, c))
        .collect();

    // For each scenario, show it, read the result cells, and put the sheet back
    let mut scenario_changing_values: Vec<Vec<String>> = Vec::new();
    let mut scenario_result_values: Vec<Vec<String>> = Vec::new();

    for scenario in &sheet_scenarios {
        let writes: Vec<((u32, u32), Option<Cell>)> = scenario
            .changing_cells
            .iter()
            .map(|sc| ((sc.row, sc.col), Some(scenario_cell(state, sheet_idx, sc.row, sc.col, &sc.value))))
            .collect();
        let mut sink = Vec::new();
        if let Err(e) = write_cells_and_recalc(state, states, &effect, sheet_idx, &writes, RecalcMode::AsAnEdit, &mut sink) {
            return ScenarioSummaryResult { scenario_names: Vec::new(), rows: Vec::new(), error: Some(e) };
        }

        // Collect changing cell values for this scenario
        let changing_vals: Vec<String> = changing_cell_positions
            .iter()
            .map(|&(r, c)| {
                scenario
                    .changing_cells
                    .iter()
                    .find(|sc| sc.row == r && sc.col == c)
                    .map_or(String::new(), |sc| sc.value.clone())
            })
            .collect();
        scenario_changing_values.push(changing_vals);

        // Collect result cell values
        scenario_result_values.push(
            result_positions
                .iter()
                .map(|&(r, c)| display_of(state, sheet_idx, r, c))
                .collect(),
        );

        // Restore original cells, and their dependents with them
        sink.clear();
        let _ = write_cells_and_recalc(state, states, &effect, sheet_idx, &original_cells, RecalcMode::AsAnEdit, &mut sink);
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
    file_state: State<FileState>,
    source_sheet_index: usize,
    target_sheet_index: usize,
) -> ScenarioResult {
    crate::log_info!(
        "SCENARIO",
        "Merging scenarios from sheet {} to sheet {}",
        source_sheet_index,
        target_sheet_index
    );

    // The same allowEditScenarios gate scenario_add passes -- merge was the one
    // way in without it, and so the one way a scenario could reach a CANVAS
    // (check_sheet_action refuses every cell-scope action there), after which
    // Show would write its cells into the canvas's hidden grid. Before the
    // effect, so a refusal leaves the document clean.
    if let Err(e) = crate::protection::check_sheet_action(
        &state, target_sheet_index, "editScenarios", "merge scenarios",
    ) {
        return ScenarioResult { success: false, error: Some(e) };
    }

    let effect = DocumentEffect::mutates(&file_state);
    let mut scenarios = state.scenarios.write(&effect).unwrap();
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
