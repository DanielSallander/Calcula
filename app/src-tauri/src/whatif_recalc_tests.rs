//! FILENAME: app/src-tauri/src/whatif_recalc_tests.rs
//! PURPOSE: BUG-0613 -- every what-if route recalculates its dependents ON
//! EVERY SHEET, exactly as if the user had typed the value, and none leaves a
//! stale cube value for the save's keep rule to vouch for.
//!
//! A child module of `whatif_recalc` (declared with `#[path]` there). Each test
//! drives the route's REAL body (`*_impl` / `*_inner`, the command minus its
//! `tauri::State` wrappers) on a two-sheet workbook built through the real edit
//! path, and reads a dependent on the OTHER sheet. The Excel behaviour each one
//! pins was observed live (Excel 16 over COM, 2026-10-30): see the module
//! header of `whatif_recalc.rs`.

use crate::api_types::{
    AnimApplyFrameParams, AnimRestoreParams, AnimSnapshotParams, DataTableOneVarParams,
    DataTableTwoVarParams, GoalSeekParams, ScenarioAddParams, ScenarioCell, ScenarioShowParams,
    ScenarioSummaryParams, SolverMethod, SolverObjective, SolverParams, SolverVariableCell,
    TransientCellWrite,
};
use crate::persistence::{FileState, UserFilesState};
use crate::whatif_recalc::WhatIfStates;
use crate::AppState;
use engine::{CellError, CellValue};

struct Wb {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    slicer: crate::slicer::SlicerState,
    pivots: crate::pivot::types::PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
}

impl Wb {
    /// Sheet1 and Sheet2, Sheet1 active, en-US so the formulas read the same
    /// on every machine.
    fn new() -> Self {
        let state = crate::create_app_state();
        state
            .grids
            .write(&crate::document_effect::DocumentEffect::deliberately_clean(
                crate::document_effect::CleanReason::LoadingFromDisk,
            ))
            .unwrap()
            .push(engine::Grid::new());
        let seed = crate::document_effect::test_seed_effect();
        state.sheet_names.write(&seed).unwrap().push("Sheet2".to_string());
        state.all_column_widths.write(&seed).unwrap().push(Default::default());
        state.all_row_heights.write(&seed).unwrap().push(Default::default());
        state.all_user_hidden_rows.write(&seed).unwrap().push(Default::default());
        state.all_user_hidden_cols.write(&seed).unwrap().push(Default::default());
        state
            .sheet_ids
            .write(&seed)
            .unwrap()
            .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        {
            let mut all = state.all_merged_regions.write(&seed).unwrap();
            while all.len() < 2 {
                all.push(Default::default());
            }
        }
        *state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
        Wb {
            state,
            file: FileState::default(),
            files: UserFilesState::default(),
            slicer: crate::slicer::SlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
        }
    }

    fn states(&self) -> WhatIfStates<'_> {
        WhatIfStates {
            user_files: &self.files,
            pivots: &self.pivots,
            pane_control: &self.pane,
            ribbon_filter: &self.filters,
        }
    }

    /// One edit through the REAL single-cell edit path, on the active sheet.
    fn set(&self, row: u32, col: u32, value: &str) {
        crate::commands::data::update_cell_impl(
            &self.state,
            &self.file,
            &self.files,
            &self.slicer,
            &self.pivots,
            &self.pane,
            &self.filters,
            row,
            col,
            value.to_string(),
            None,
            None,
            None,
        )
        .unwrap_or_else(|e| panic!("update_cell({},{}) failed: {}", row, col, e));
    }

    /// `set_active_sheet`'s recalculation-relevant half (as the shared
    /// `cross_sheet_recalc_tests::Workbook` harness does it).
    fn switch_to(&self, index: usize) {
        {
            let clean = crate::document_effect::DocumentEffect::deliberately_clean(
                crate::document_effect::CleanReason::LoadingFromDisk,
            );
            let mut mirror = self.state.grid.write(&clean).unwrap();
            let mut grids = self.state.grids.write(&clean).unwrap();
            let mut active = self.state.active_sheet.write(&crate::document_effect::test_seed_effect()).unwrap();
            let old = *active;
            if old == index {
                return;
            }
            grids[old] = mirror.clone();
            *mirror = grids[index].clone();
            *active = index;
        }
        crate::undo_commands::rebuild_all_dependencies(&self.state);
    }

    /// Write `value` on `sheet` and come back to Sheet1.
    fn set_on(&self, sheet: usize, row: u32, col: u32, value: &str) {
        self.switch_to(sheet);
        self.set(row, col, value);
        self.switch_to(0);
    }

    fn value(&self, sheet: usize, row: u32, col: u32) -> CellValue {
        self.state.grids.read().unwrap()[sheet]
            .get_cell(row, col)
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    }

    fn number(&self, sheet: usize, row: u32, col: u32) -> f64 {
        match self.value(sheet, row, col) {
            CellValue::Number(n) => n,
            other => panic!("sheet {} ({},{}) is {:?}, expected a number", sheet, row, col, other),
        }
    }

    /// Put `value` behind a formula cell as a workbook opened from disk holds
    /// it, with the results cache's entry for its root cube calls (the open
    /// path's `remember_loaded_call_results`).
    fn stamp(&self, sheet: usize, row: u32, col: u32, value: CellValue) {
        {
            let clean = crate::document_effect::DocumentEffect::deliberately_clean(
                crate::document_effect::CleanReason::LoadingFromDisk,
            );
            let active = *self.state.active_sheet.read().unwrap();
            let mut grid = self.state.grid.write(&clean).unwrap();
            let mut grids = self.state.grids.write(&clean).unwrap();
            let mut cell = grids[sheet].get_cell(row, col).cloned().expect("stamp a formula cell");
            cell.value = value;
            if sheet == active {
                grid.set_cell(row, col, cell.clone());
            }
            grids[sheet].set_cell(row, col, cell);
        }
        crate::bi::cube::remember_loaded_call_results(&self.state);
    }

    /// Calculate Now -- the full pass a save runs, with no cube data.
    fn f9(&self) {
        crate::calculation::run_calculation_pass(
            crate::calculation::CalcScope::Workbook,
            None,
            &self.state,
            &self.files,
            &self.pivots,
            &self.pane,
            &self.filters,
            None,
        )
        .expect("the workbook pass");
    }

    fn add_scenario(&self, name: &str, cells: &[(u32, u32, &str)]) {
        let r = crate::scenario_manager::scenario_add_impl(
            &self.state,
            &self.file,
            ScenarioAddParams {
                name: name.to_string(),
                changing_cells: cells
                    .iter()
                    .map(|&(row, col, value)| ScenarioCell { row, col, value: value.to_string() })
                    .collect(),
                comment: String::new(),
                sheet_index: 0,
            },
        );
        assert!(r.success, "scenario_add: {:?}", r.error);
    }

    fn show(&self, name: &str) {
        let r = crate::scenario_manager::scenario_show_impl(
            &self.state,
            &self.file,
            &self.states(),
            ScenarioShowParams { name: name.to_string(), sheet_index: 0 },
        );
        assert!(r.error.is_none(), "scenario_show: {:?}", r.error);
    }
}

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

// ---------------------------------------------------------------------------
// Goal Seek
// ---------------------------------------------------------------------------

/// Excel [LIVE]: `Sheet1!C1 = Sheet2!B1+1`, `Sheet2!B1 = Sheet1!A1*2`, Goal
/// Seek C1 to 11 by A1 -> A1 = 5, Sheet2!B1 = 10, `Sheet2!D1 = Sheet1!C1*10`
/// = 110. The target reaches the changing cell only THROUGH another sheet.
#[test]
fn goal_seek_solves_through_another_sheet_and_recalculates_its_readers_there() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // Sheet1!A1
    wb.set_on(1, 0, 1, "=Sheet1!A1*2"); // Sheet2!B1
    wb.set(0, 2, "=Sheet2!B1+1"); // Sheet1!C1 (target)
    wb.set_on(1, 0, 3, "=Sheet1!C1*10"); // Sheet2!D1
    assert_eq!(wb.number(1, 0, 3), 30.0, "precondition");

    let r = crate::goal_seek::goal_seek_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        GoalSeekParams {
            target_row: 0,
            target_col: 2,
            target_value: 11.0,
            variable_row: 0,
            variable_col: 0,
            max_iterations: 100,
            tolerance: 0.001,
        },
    );
    assert!(r.error.is_none(), "goal seek refused: {:?}", r.error);
    assert!(
        close(wb.number(1, 0, 3), 110.0, 0.05),
        "Sheet2!D1 = Sheet1!C1*10 must follow the solved target on the OTHER sheet; it is {:?}",
        wb.value(1, 0, 3)
    );
    assert!(close(wb.number(1, 0, 1), 10.0, 0.01), "Sheet2!B1 = Sheet1!A1*2 at A1 = 5");
    assert!(r.found_solution, "Excel finds A1 = 5");
    assert!(close(wb.number(0, 0, 0), 5.0, 0.01), "A1 = {:?}", wb.value(0, 0, 0));
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

#[test]
fn solver_solves_through_another_sheet_and_revert_puts_its_readers_back() {
    let wb = Wb::new();
    wb.set(0, 0, "0"); // Sheet1!A1, the variable
    wb.set_on(1, 0, 1, "=Sheet1!A1*2"); // Sheet2!B1
    wb.set(0, 2, "=(Sheet2!B1-6)^2"); // Sheet1!C1, the objective (min at A1 = 3)
    wb.set_on(1, 0, 3, "=Sheet1!A1+100"); // Sheet2!D1, a reader of the answer

    let r = crate::solver::solver_solve_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        SolverParams {
            sheet_index: 0,
            objective_row: 0,
            objective_col: 2,
            objective: SolverObjective::Minimize,
            target_value: None,
            variable_cells: vec![SolverVariableCell { row: 0, col: 0 }],
            constraints: Vec::new(),
            method: SolverMethod::GrgNonlinear,
            max_iterations: 500,
            max_time: 100,
            tolerance: 1e-9,
        },
    );
    assert!(r.error.is_none(), "solver refused: {:?}", r.error);
    assert!(
        close(wb.number(1, 0, 3), 103.0, 0.05),
        "Sheet2!D1 = Sheet1!A1+100 must follow the solution on the OTHER sheet; it is {:?}",
        wb.value(1, 0, 3)
    );
    assert!(close(wb.number(0, 0, 0), 3.0, 0.05), "A1 = {:?}", wb.value(0, 0, 0));

    let sheet = r.sheet_id.expect("a run names its sheet by stable id");
    let back = crate::solver::solver_revert_impl(&wb.state, &wb.file, &wb.states(), sheet, r.original_values);
    assert!(back.error.is_none(), "revert: {:?}", back.error);
    assert_eq!(wb.number(0, 0, 0), 0.0, "A1 restored");
    assert_eq!(wb.number(1, 0, 3), 100.0, "Sheet2!D1 restored with it");
}

// ---------------------------------------------------------------------------
// Scenario Show / Summary
// ---------------------------------------------------------------------------

/// Excel [LIVE]: a scenario setting `Sheet1!A5` to 100 leaves
/// `Sheet2!B5 = Sheet1!A5*3` at 300 and `Sheet1!C5 = Sheet2!B5+1` at 301.
#[test]
fn scenario_show_recalculates_a_dependent_on_another_sheet() {
    let wb = Wb::new();
    wb.set(4, 0, "10"); // Sheet1!A5
    wb.set_on(1, 4, 1, "=Sheet1!A5*3"); // Sheet2!B5
    wb.set(4, 2, "=Sheet2!B5+1"); // Sheet1!C5
    wb.add_scenario("Hi", &[(4, 0, "100")]);

    wb.show("Hi");

    assert_eq!(wb.number(1, 4, 1), 300.0, "Sheet2!B5 = Sheet1!A5*3 kept its old value");
    assert_eq!(wb.number(0, 4, 2), 301.0, "Sheet1!C5 reads the scenario back through Sheet2");
}

#[test]
fn scenario_summary_reports_a_result_reached_through_another_sheet_and_restores() {
    let wb = Wb::new();
    wb.set(4, 0, "10"); // Sheet1!A5
    wb.set_on(1, 4, 1, "=Sheet1!A5*3"); // Sheet2!B5
    wb.set(4, 2, "=Sheet2!B5+1"); // Sheet1!C5, the result cell
    wb.add_scenario("Hi", &[(4, 0, "100")]);

    let r = crate::scenario_manager::scenario_summary_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        ScenarioSummaryParams {
            sheet_index: 0,
            result_cells: vec![ScenarioCell { row: 4, col: 2, value: String::new() }],
        },
    );
    assert!(r.error.is_none(), "summary: {:?}", r.error);
    let result_row = r.rows.iter().find(|row| !row.is_changing_cell).expect("a result row");
    assert_eq!(result_row.scenario_values, vec!["301".to_string()], "the result under 'Hi'");
    assert_eq!(wb.number(0, 4, 0), 10.0, "A5 restored");
    assert_eq!(wb.number(1, 4, 1), 30.0, "Sheet2!B5 restored with it");
    assert_eq!(wb.number(0, 4, 2), 31.0, "C5 restored with it");
}

/// THE KEEP RULE. `Sheet2!B2 = CUBEVALUE("Sales",Sheet1!A2)` served 225 for
/// [Revenue] and `Sheet2!C2` is a composite over the same call. A scenario
/// that changes the member must not leave Revenue's numbers in either -- and
/// the save's full pass (no cube data) must not then keep them as current.
#[test]
fn a_scenario_never_leaves_a_stale_cube_value_for_the_full_pass_to_keep() {
    let wb = Wb::new();
    wb.set(1, 0, "[Revenue]"); // Sheet1!A2
    wb.set_on(1, 1, 1, r#"=CUBEVALUE("Sales",Sheet1!A2)"#); // Sheet2!B2
    wb.set_on(1, 1, 2, r#"=CUBEVALUE("Sales",Sheet1!A2)/1000"#); // Sheet2!C2
    wb.stamp(1, 1, 1, CellValue::Number(225.0));
    wb.f9(); // C2 computed from the recorded answer
    assert_eq!(wb.number(1, 1, 2), 0.225, "precondition: the composite reads the served answer");
    wb.add_scenario("Cost", &[(1, 0, "[Cost]")]);
    wb.add_scenario("Revenue", &[(1, 0, "[Revenue]")]);

    wb.show("Cost");
    wb.f9();

    assert_ne!(
        wb.value(1, 1, 1),
        CellValue::Number(225.0),
        "Sheet2!B2 kept Revenue's number for [Cost] through the full pass"
    );
    assert_eq!(wb.value(1, 1, 1), CellValue::Error(CellError::NA), "no data for [Cost]: refused");
    assert_ne!(wb.value(1, 1, 2), CellValue::Number(0.225), "the composite kept Revenue's quotient");

    // Back to Revenue: its recorded answer serves both again.
    wb.show("Revenue");
    assert_eq!(wb.number(1, 1, 1), 225.0);
    assert_eq!(wb.number(1, 1, 2), 0.225);
}

// ---------------------------------------------------------------------------
// Data tables
// ---------------------------------------------------------------------------

/// Excel [LIVE]: `=TABLE(,A10)` over `E10 = B10`, `B10 = Sheet2!B10+100`,
/// `Sheet2!B10 = Sheet1!A10*2`, inputs 5 and 7 in D11:D12 -> E11 = 110,
/// E12 = 114, A10 = 1 and Sheet2!B10 = 2 afterwards.
#[test]
fn a_one_variable_data_table_substitutes_through_another_sheet() {
    let wb = Wb::new();
    wb.set(9, 0, "1"); // A10, the input cell
    wb.set_on(1, 9, 1, "=Sheet1!A10*2"); // Sheet2!B10
    wb.set(9, 1, "=Sheet2!B10+100"); // B10
    wb.set(9, 4, "=B10"); // E10, the table's formula
    wb.set(10, 3, "5"); // D11
    wb.set(11, 3, "7"); // D12
    wb.set_on(1, 0, 5, "=Sheet1!E11"); // Sheet2!F1, a reader of the table body

    let r = crate::data_tables::data_table_one_var_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        DataTableOneVarParams {
            sheet_index: 0,
            start_row: 9,
            start_col: 3,
            end_row: 11,
            end_col: 4,
            row_input_row: None,
            row_input_col: None,
            col_input_row: Some(9),
            col_input_col: Some(0),
        },
    );
    assert!(r.error.is_none(), "data table: {:?}", r.error);
    assert_eq!(wb.number(0, 10, 4), 110.0, "E11: input 5 through Sheet2 (5*2+100)");
    assert_eq!(wb.number(0, 11, 4), 114.0, "E12: input 7 through Sheet2 (7*2+100)");
    assert_eq!(wb.number(0, 9, 0), 1.0, "A10 restored");
    assert_eq!(wb.number(1, 9, 1), 2.0, "Sheet2!B10 restored with it");
    assert_eq!(wb.number(1, 0, 5), 110.0, "Sheet2!F1 reads the table body");
}

#[test]
fn a_two_variable_data_table_substitutes_through_another_sheet() {
    let wb = Wb::new();
    wb.set(19, 0, "1"); // A20, the row input
    wb.set(20, 0, "1"); // A21, the column input
    wb.set_on(1, 19, 1, "=Sheet1!A20*Sheet1!A21"); // Sheet2!B20
    wb.set(19, 1, "=Sheet2!B20+1"); // B20
    wb.set(19, 3, "=B20"); // D20, the table's formula
    wb.set(19, 4, "2"); // E20
    wb.set(19, 5, "3"); // F20
    wb.set(20, 3, "10"); // D21
    wb.set(21, 3, "20"); // D22

    let r = crate::data_tables::data_table_two_var_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        DataTableTwoVarParams {
            sheet_index: 0,
            start_row: 19,
            start_col: 3,
            end_row: 21,
            end_col: 5,
            row_input_row: 19,
            row_input_col: 0,
            col_input_row: 20,
            col_input_col: 0,
        },
    );
    assert!(r.error.is_none(), "data table: {:?}", r.error);
    assert_eq!(wb.number(0, 20, 4), 21.0, "E21 = 2*10+1");
    assert_eq!(wb.number(0, 20, 5), 31.0, "F21 = 3*10+1");
    assert_eq!(wb.number(0, 21, 4), 41.0, "E22 = 2*20+1");
    assert_eq!(wb.number(0, 21, 5), 61.0, "F22 = 3*20+1");
    assert_eq!(wb.number(1, 19, 1), 1.0, "Sheet2!B20 restored");
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

#[test]
fn an_animation_frame_moves_a_dependent_on_another_sheet_and_the_restore_puts_it_back() {
    let wb = Wb::new();
    wb.set(29, 0, "1"); // A30, the driver
    wb.set_on(1, 29, 1, "=Sheet1!A30*2"); // Sheet2!B30
    wb.set_on(1, 29, 2, "=COUNT(Sheet1!C30)"); // Sheet2!C30: reads a cell absent before the run

    let snap = crate::animation_commands::anim_snapshot_inner(
        &wb.state,
        AnimSnapshotParams { token: "run".to_string(), sheet_index: 0, cells: vec![(29, 0), (29, 2)] },
    );
    assert!(snap.success, "snapshot: {:?}", snap.error);
    crate::document_effect::mark_saved(&wb.file);

    let frame = crate::animation_commands::anim_apply_frame_inner(
        &wb.state,
        &wb.states(),
        AnimApplyFrameParams {
            token: "run".to_string(),
            sheet_index: 0,
            writes: vec![
                TransientCellWrite { row: 29, col: 0, value: "7".to_string() },
                TransientCellWrite { row: 29, col: 2, value: "5".to_string() },
            ],
        },
    );
    assert!(frame.error.is_none(), "frame: {:?}", frame.error);
    assert_eq!(wb.number(1, 29, 1), 14.0, "Sheet2!B30 = Sheet1!A30*2 did not move with the frame");
    assert_eq!(wb.number(1, 29, 2), 1.0, "Sheet2!C30 counts the frame's C30");
    assert!(
        frame.updated_cells.iter().any(|c| c.sheet_index == Some(1) && c.row == 29 && c.col == 1),
        "the frame's reply repaints the other sheet's dependent"
    );
    assert!(!wb.file.is_dirty(), "a frame is transient: it does not dirty the document");

    let back = crate::animation_commands::anim_restore_inner(
        &wb.state,
        &wb.states(),
        AnimRestoreParams { token: "run".to_string(), sheet_index: 0 },
    );
    assert!(back.error.is_none(), "restore: {:?}", back.error);
    assert_eq!(wb.number(0, 29, 0), 1.0, "A30 restored");
    assert_eq!(wb.value(0, 29, 2), CellValue::Empty, "C30 was absent and is absent again");
    assert_eq!(wb.number(1, 29, 1), 2.0, "Sheet2!B30 restored with it");
    assert_eq!(wb.number(1, 29, 2), 0.0, "Sheet2!C30 restored with it");
    assert!(!wb.file.is_dirty(), "the restore is transient too");
}

/// The Goal Seek status dialog's Cancel: the run records ONE undo step of its
/// own and hands back its id, and taking back THAT step puts the changing cell
/// back EXACTLY -- a TEXT original comes back as that text (it came back as 0
/// when the dialog retyped `originalVariableValue`), an EMPTY one as empty --
/// with the target recalculated.
#[test]
fn goal_seek_records_one_step_that_puts_the_changing_cell_back_exactly() {
    let run = |wb: &Wb| {
        crate::goal_seek::goal_seek_impl(
            &wb.state,
            &wb.file,
            &wb.states(),
            GoalSeekParams {
                target_row: 0,
                target_col: 1,
                target_value: 10.0,
                variable_row: 0,
                variable_col: 0,
                max_iterations: 100,
                tolerance: 0.001,
            },
        )
    };
    let undo_step = |wb: &Wb, seq: u64| {
        let transaction = {
            let mut stack = wb.state.undo_stack.lock().unwrap();
            assert_eq!(stack.top_undo_seq(), Some(seq), "the id handed back is the step on top");
            stack.pop_undo().expect("the Goal Seek step")
        };
        crate::undo_commands::apply_changes(
            &wb.state,
            &wb.file,
            &wb.files,
            &wb.pivots,
            &wb.slicer,
            &wb.filters,
            &wb.pane,
            &crate::timeline_slicer::TimelineSlicerState::new(),
            transaction,
            true,
        );
    };

    // A TEXT changing cell. (Round 12: the target must hold a NUMBER when the
    // run starts -- `=A1*2` over text is #VALUE!, which Excel refuses before
    // writing anything [LIVE] -- so the target reads the text as 0 instead.)
    let wb = Wb::new();
    wb.set(0, 0, "n/a"); // A1, text
    wb.set(0, 1, "=IF(ISNUMBER(A1),A1*2,0)"); // B1, the target: 0 over text
    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();
    let r = run(&wb);
    assert!(r.error.is_none(), "goal seek refused: {:?}", r.error);
    assert!(close(wb.number(0, 0, 0), 5.0, 0.01), "A1 solved to 5");
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_depth(), depth + 1, "ONE step for the run");
    let seq = r.undo_seq.expect("the run hands back its undo step's id");
    undo_step(&wb, seq);
    assert_eq!(wb.value(0, 0, 0), CellValue::Text("n/a".to_string()), "the text comes back, not 0");
    assert_eq!(wb.number(0, 0, 1), 0.0, "B1 recalculates over the text again");

    // An EMPTY changing cell.
    let wb = Wb::new();
    wb.set(0, 1, "=A1*2");
    let r = run(&wb);
    assert!(close(wb.number(0, 0, 0), 5.0, 0.01), "A1 solved to 5");
    undo_step(&wb, r.undo_seq.expect("an id"));
    assert_eq!(wb.value(0, 0, 0), CellValue::Empty, "the empty cell comes back empty, not 0");
    assert!(wb.state.grids.read().unwrap()[0].get_cell(0, 0).is_none(), "no cell is left behind at A1");
    assert_eq!(wb.number(0, 0, 1), 0.0, "B1 recalculates over the empty A1");

    // A refused run records nothing and hands back no id.
    let wb = Wb::new();
    wb.set(0, 1, "7"); // B1 holds no formula
    let r = run(&wb);
    assert!(r.error.is_some());
    assert_eq!(r.undo_seq, None);
}

// ---------------------------------------------------------------------------
// Round 11 (whatif2): manual calculation, the work a trial does, Solver's
// sheet, data-table value types, Goal Seek's last trial, animation keying.
// ---------------------------------------------------------------------------

impl Wb {
    /// A third (fourth, ...) sheet named `name`, appended.
    fn add_sheet(&self, name: &str) {
        self.state
            .grids
            .write(&crate::document_effect::DocumentEffect::deliberately_clean(
                crate::document_effect::CleanReason::LoadingFromDisk,
            ))
            .unwrap()
            .push(engine::Grid::new());
        let seed = crate::document_effect::test_seed_effect();
        self.state.sheet_names.write(&seed).unwrap().push(name.to_string());
        self.state.all_column_widths.write(&seed).unwrap().push(Default::default());
        self.state.all_row_heights.write(&seed).unwrap().push(Default::default());
        self.state.all_user_hidden_rows.write(&seed).unwrap().push(Default::default());
        self.state.all_user_hidden_cols.write(&seed).unwrap().push(Default::default());
        self.state
            .sheet_ids
            .write(&seed)
            .unwrap()
            .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        self.state.all_merged_regions.write(&seed).unwrap().push(Default::default());
    }

    fn manual(&self) {
        crate::calculation::set_calculation_mode_impl(&self.state, "manual");
    }
}

/// THE WORK A TRIAL DOES, under MANUAL calculation. A trial used to run the
/// edit cascade (which stops at the mode), then two whole-sheet passes over the
/// sheet and every sheet reading it, then format EVERY formula cell of the sheet
/// into a reply the trial threw away. Now it is the seeded cascade: the input,
/// the one cell that reads it, and nothing else -- so 300 unrelated formulas
/// are neither evaluated (each still shows the stale value the user left for
/// F9) nor reported. (A whole Goal Seek or Solver run then ends with ONE
/// workbook pass, as Excel's does -- `calculate_workbook_at_run_end`; this test
/// is the cost of a trial.)
#[test]
fn a_manual_mode_trial_evaluates_only_the_cells_that_read_its_input() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1, the input
    wb.set(0, 1, "=A1*2"); // B1, its one reader
    for r in 0..300u32 {
        wb.set(r, 24, "1"); // Y{r}
        wb.set(r, 25, &format!("=Y{}*2", r + 1)); // Z{r}, unrelated to A1
    }
    wb.manual();
    for r in 0..300u32 {
        wb.set(r, 24, "5"); // stale: Z still shows 2 until F9
    }
    assert_eq!(wb.number(0, 0, 25), 2.0, "precondition: Z1 is stale under manual calculation");

    let effect = crate::document_effect::DocumentEffect::mutates(&wb.file);
    let mut reply = Vec::new();
    crate::whatif_recalc::write_cells_and_recalc(
        &wb.state,
        &wb.states(),
        &effect,
        0,
        &[((0, 0), Some(engine::Cell::new_number(7.0)))],
        crate::whatif_recalc::RecalcMode::Always,
        &mut reply,
    )
    .expect("the trial");

    assert_eq!(wb.number(0, 0, 1), 14.0, "B1 = A1*2 is recalculated for the trial");
    assert_eq!(
        reply.len(),
        2,
        "one trial reports (and evaluates) the input and its one reader, not the sheet's 301 formulas: {:?}",
        reply.iter().map(|c| (c.row, c.col)).take(8).collect::<Vec<_>>()
    );
    assert!(
        (0..300u32).all(|r| wb.number(0, r, 25) == 2.0),
        "an unrelated formula the user left stale was recalculated by the trial"
    );
}

/// Goal Seek under MANUAL calculation solves (each trial recalculates the
/// target's chain) and ENDS WITH THE WHOLE WORKBOOK CALCULATED, as Excel's does.
/// Round 11 pinned the opposite (an unrelated stale B6 "stays so"), which no
/// probe had measured; changed deliberately (round 18). Excel [LIVE, 2026-10-31,
/// COM and the dialog's OK, fresh instance]: stale `Sheet1!G1 = D1` and
/// `Sheet2!E1 = D1`, neither reading the changing cell, are recalculated by the
/// run and CalculationState goes from xlPending to xlDone.
///
/// SABOTAGE: make `whatif_recalc::calculate_workbook_at_run_end` return at once.
#[test]
fn goal_seek_under_manual_calculation_ends_with_the_whole_workbook_calculated() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    wb.set(0, 2, "=B1+1"); // C1, the target
    wb.set(5, 0, "1"); // A6
    wb.set(5, 1, "=A6*2"); // B6, unrelated
    wb.set_on(1, 0, 3, "1"); // Sheet2!D1
    wb.set_on(1, 0, 4, "=D1*3"); // Sheet2!E1, unrelated, on another sheet
    wb.manual();
    wb.set(5, 0, "5"); // B6 stale at 2 until F9
    wb.set_on(1, 0, 3, "4"); // Sheet2!E1 stale at 3 until F9
    assert_eq!(wb.number(0, 5, 1), 2.0, "precondition: B6 stale");
    assert_eq!(wb.number(1, 0, 4), 3.0, "precondition: Sheet2!E1 stale");
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "pending", "precondition: pending");

    let r = crate::goal_seek::goal_seek_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        GoalSeekParams {
            target_row: 0,
            target_col: 2,
            target_value: 11.0,
            variable_row: 0,
            variable_col: 0,
            max_iterations: 100,
            tolerance: 0.001,
        },
    );
    assert!(r.error.is_none(), "{:?}", r.error);
    assert!(r.found_solution);
    assert!(close(wb.number(0, 0, 0), 5.0, 0.01), "A1 = {:?}", wb.value(0, 0, 0));
    assert!(close(wb.number(0, 0, 2), 11.0, 0.01), "C1 recalculated through B1");
    assert_eq!(wb.number(0, 5, 1), 10.0, "B6, stale before the run, is calculated at its end (Excel)");
    assert_eq!(wb.number(1, 0, 4), 12.0, "Sheet2!E1, stale on another sheet, is calculated at the run's end");
    assert_eq!(
        wb.state.grid.read().unwrap().get_cell(5, 1).map(|c| c.value.clone()),
        Some(CellValue::Number(10.0)),
        "the active sheet's mirror holds B6's calculated value too"
    );
    assert_eq!(
        crate::calculation::calculation_state_impl(&wb.state),
        "done",
        "the run leaves the workbook calculated, Excel's xlDone"
    );
    assert!(
        r.updated_cells.iter().any(|c| (c.row, c.col) == (5, 1) && c.sheet_index.unwrap_or(0) == 0),
        "the reply repaints B6"
    );
}

/// A GOAL SEEK THAT FINDS NOTHING, AND THE STATUS DIALOG'S CANCEL, also end with
/// the whole workbook calculated under manual calculation. Excel [LIVE,
/// 2026-10-31]: `C1 = A1^2+1` sought to 0 returns False and recalculates the
/// stale `G1`/`Sheet2!E1`, xlDone; Cancel in Goal Seek Status (driven through
/// the dialog on a visible instance) puts A1 back and does the same.
///
/// SABOTAGE: as for the test above (one sabotage proves both doors).
#[test]
fn a_goal_seek_that_finds_nothing_and_a_goal_seek_cancel_end_calculated_under_manual() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1, the changing cell
    wb.set(0, 2, "=A1^2+1"); // C1, never 0
    wb.set(0, 1, "=A1*2"); // B1, a second target
    wb.set(5, 0, "1"); // A6
    wb.set(5, 1, "=A6*2"); // B6, unrelated
    wb.manual();
    wb.set(5, 0, "5"); // B6 stale at 2
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "pending", "precondition: pending");

    let r = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((0, 2), 0.0, (0, 0)));
    assert!(r.error.is_none(), "{:?}", r.error);
    assert!(!r.found_solution, "precondition: nothing found");
    assert_eq!(wb.number(0, 5, 1), 10.0, "B6 is calculated at the end of a run that found nothing");
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "done", "xlDone after a not-found run");

    // A run that finds its value, then Cancel. B6 is left stale again first, so
    // only the Cancel's own end-of-run pass can calculate it.
    wb.set(0, 0, "1");
    let found = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((0, 1), 10.0, (0, 0)));
    assert!(found.error.is_none() && found.found_solution, "precondition: found {:?}", found.error);
    // A6 = 7 written behind the history's back (an edit would sit on top of
    // the run's step, and Cancel takes back only the newest step), with the
    // sheet marked as a manual edit marks it.
    {
        let clean = crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::LoadingFromDisk,
        );
        let mut grid = wb.state.grid.write(&clean).unwrap();
        let mut grids = wb.state.grids.write(&clean).unwrap();
        grid.set_cell(5, 0, engine::Cell::new_number(7.0));
        grids[0].set_cell(5, 0, engine::Cell::new_number(7.0));
        grid.call_memo().note_values_may_be_stale();
        grids[0].call_memo().note_values_may_be_stale();
    }
    assert_eq!(wb.number(0, 5, 1), 10.0, "precondition: B6 stale again");
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "pending", "precondition: pending again");
    let back = crate::goal_seek::cancel_goal_seek_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        found.undo_seq.expect("the run's step"),
    );
    assert!(back.error.is_none(), "Cancel: {:?}", back.error);
    assert_eq!(wb.number(0, 0, 0), 1.0, "A1 put back");
    assert_eq!(wb.number(0, 0, 1), 2.0, "B1 back with it");
    assert_eq!(wb.number(0, 5, 1), 14.0, "B6 is calculated by the Cancel too (Excel)");
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "done", "xlDone after Cancel");
}

/// Solver works on the sheet it is given (the dialog now sends the ACTIVE
/// sheet; it used to send 0). A run on Sheet3 solves Sheet3's model and
/// leaves Sheet1 -- which holds a formula at the same address -- untouched.
#[test]
fn solver_runs_on_the_sheet_it_is_given_and_leaves_sheet1_alone() {
    let wb = Wb::new();
    wb.add_sheet("Sheet3");
    wb.set(0, 0, "7"); // Sheet1!A1
    wb.set(0, 2, "=A1*1"); // Sheet1!C1, a formula at the objective's address
    wb.switch_to(2);
    wb.set(0, 0, "0"); // Sheet3!A1, the variable
    wb.set(0, 2, "=(A1-3)^2"); // Sheet3!C1, the objective

    let r = crate::solver::solver_solve_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        SolverParams {
            sheet_index: 2,
            objective_row: 0,
            objective_col: 2,
            objective: SolverObjective::Minimize,
            target_value: None,
            variable_cells: vec![SolverVariableCell { row: 0, col: 0 }],
            constraints: Vec::new(),
            method: SolverMethod::GrgNonlinear,
            max_iterations: 500,
            max_time: 100,
            tolerance: 1e-9,
        },
    );
    assert!(r.error.is_none(), "{:?}", r.error);
    assert!(close(wb.number(2, 0, 0), 3.0, 0.05), "Sheet3!A1 = {:?}", wb.value(2, 0, 0));
    assert_eq!(wb.number(0, 0, 0), 7.0, "Sheet1!A1 untouched");
    assert_eq!(wb.number(0, 0, 2), 7.0, "Sheet1!C1 untouched");
}

/// Esc in the Solver dialog cancels: the run stops between trials, keeps the
/// best point it had, says so, and the final write is a REAL recalculation
/// (the flag is cleared before it).
#[test]
fn a_stopped_solver_run_reports_it_and_writes_a_recalculated_answer() {
    let wb = Wb::new();
    wb.set(0, 0, "0"); // A1
    wb.set(0, 2, "=(A1-3)^2"); // C1
    // Tolerance 0: GRG never declares convergence, so only the stop ends it
    // before its (huge) iteration limit.
    const LIMIT: u32 = 2_000_000;
    let r = std::thread::scope(|scope| {
        let state = &wb.state;
        // Esc once the run is under way (its first trials have moved A1).
        scope.spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            while std::time::Instant::now() < deadline {
                let moved = state.grids.read().unwrap()[0]
                    .get_cell(0, 0)
                    .is_some_and(|c| c.value != CellValue::Number(0.0));
                if moved {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    state.calc_cancel.cancel();
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        });
        crate::solver::solver_solve_impl(
            &wb.state,
            &wb.file,
            &wb.states(),
            SolverParams {
                sheet_index: 0,
                objective_row: 0,
                objective_col: 2,
                objective: SolverObjective::Minimize,
                target_value: None,
                variable_cells: vec![SolverVariableCell { row: 0, col: 0 }],
                constraints: Vec::new(),
                method: SolverMethod::GrgNonlinear,
                max_iterations: LIMIT,
                max_time: 100,
                tolerance: 0.0,
            },
        )
    });
    assert!(r.error.is_none(), "{:?}", r.error);
    assert_eq!(r.status_message, "Solver stopped at user's request.");
    assert!(!r.found_solution);
    assert!(r.iterations < LIMIT, "the run stopped early ({} iterations)", r.iterations);
    assert!(!wb.state.calc_cancel.is_cancelled(), "the stop does not outlive the run");
    assert_eq!(wb.number(0, 0, 2), (wb.number(0, 0, 0) - 3.0).powi(2), "C1 recalculated for the answer");
    assert_eq!(r.objective_value, wb.number(0, 0, 2));
}

/// A data table's body holds each result with its REAL type, as Excel's
/// `{=TABLE()}` does: `#DIV/0!` is an error (ISERROR TRUE), a comparison a
/// boolean. They used to be written as the TEXT "Div0" and "TRUE".
#[test]
fn a_data_table_writes_errors_and_booleans_as_values_not_text() {
    let wb = Wb::new();
    wb.set(9, 0, "1"); // A10, the input
    wb.set(9, 4, "=1/(A10-5)"); // E10
    wb.set(9, 5, "=A10>6"); // F10
    wb.set(10, 3, "5"); // D11
    wb.set(11, 3, "7"); // D12
    wb.set(0, 7, "=ISERROR(E11)"); // H1

    let r = crate::data_tables::data_table_one_var_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        DataTableOneVarParams {
            sheet_index: 0,
            start_row: 9,
            start_col: 3,
            end_row: 11,
            end_col: 5,
            row_input_row: None,
            row_input_col: None,
            col_input_row: Some(9),
            col_input_col: Some(0),
        },
    );
    assert!(r.error.is_none(), "{:?}", r.error);
    assert_eq!(wb.value(0, 10, 4), CellValue::Error(CellError::Div0), "E11: 1/(5-5)");
    assert_eq!(wb.value(0, 10, 5), CellValue::Boolean(false), "F11: 5>6");
    assert_eq!(wb.value(0, 11, 5), CellValue::Boolean(true), "F12: 7>6");
    assert_eq!(wb.value(0, 0, 7), CellValue::Boolean(true), "H1 = ISERROR(E11) sees the error");
    let e11 = r.cells.iter().find(|c| c.row == 10 && c.col == 4).expect("E11 in the reply");
    assert_eq!(e11.value, "#DIV/0!", "the reply spells the error as Excel does");
}

/// Excel [LIVE]: Goal Seek of `G1 = 5` to 7 by F1 = 10 returns not-found and
/// leaves F1 at its LAST trial. It used to leave the best trial, which for a
/// flat target is the second probe, 10 * 1.001 = 10.01.
#[test]
fn a_goal_seek_that_finds_nothing_leaves_its_last_trial() {
    let wb = Wb::new();
    wb.set(0, 5, "10"); // F1
    wb.set(0, 6, "=5"); // G1, does not depend on F1
    let r = crate::goal_seek::goal_seek_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        GoalSeekParams {
            target_row: 0,
            target_col: 6,
            target_value: 7.0,
            variable_row: 0,
            variable_col: 5,
            max_iterations: 100,
            tolerance: 0.001,
        },
    );
    assert!(r.error.is_none(), "{:?}", r.error);
    assert!(!r.found_solution);
    // The flat search widens x by 10% per iteration from the second probe.
    let last = 10.01 * 1.1f64.powi(100);
    let f1 = wb.number(0, 0, 5);
    assert!((f1 - last).abs() <= last * 1e-9, "F1 = {} (expected the last trial {})", f1, last);
    assert_eq!(r.variable_value, f1);
}

/// THE FRAME FOLLOWS ITS SNAPSHOT'S SHEET. A frame names the index the sheet
/// had when playback started; a tab moved since then makes that index another
/// sheet. The frame now writes where the snapshot was taken (by stable id),
/// and a cell outside the snapshot is refused -- the restore could never put
/// it back, and the transient write would never dirty the document.
#[test]
fn an_animation_frame_writes_the_snapshots_sheet_and_only_its_cells() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // Sheet1!A1, the driver
    let snap = crate::animation_commands::anim_snapshot_inner(
        &wb.state,
        AnimSnapshotParams { token: "run".to_string(), sheet_index: 0, cells: vec![(0, 0)] },
    );
    assert!(snap.success);

    // The caller's index now names Sheet2 (as after a tab drag).
    let frame = crate::animation_commands::anim_apply_frame_inner(
        &wb.state,
        &wb.states(),
        AnimApplyFrameParams {
            token: "run".to_string(),
            sheet_index: 1,
            writes: vec![TransientCellWrite { row: 0, col: 0, value: "9".to_string() }],
        },
    );
    assert!(frame.error.is_none(), "{:?}", frame.error);
    assert_eq!(wb.number(0, 0, 0), 9.0, "the frame lands on the snapshot's sheet");
    assert_eq!(wb.value(1, 0, 0), CellValue::Empty, "Sheet2 is never written");

    let outside = crate::animation_commands::anim_apply_frame_inner(
        &wb.state,
        &wb.states(),
        AnimApplyFrameParams {
            token: "run".to_string(),
            sheet_index: 0,
            writes: vec![TransientCellWrite { row: 3, col: 3, value: "4".to_string() }],
        },
    );
    assert!(outside.error.is_some(), "a cell outside the snapshot is refused");
    assert_eq!(wb.value(0, 3, 3), CellValue::Empty, "and not written");

    let back = crate::animation_commands::anim_restore_inner(
        &wb.state,
        &wb.states(),
        AnimRestoreParams { token: "run".to_string(), sheet_index: 1 },
    );
    assert!(back.error.is_none(), "{:?}", back.error);
    assert_eq!(wb.number(0, 0, 0), 1.0, "restored");
}

/// MANUAL CALCULATION: Stop gives back EXACTLY what the user saw, stale values
/// included. `C1` was changed to 7 with no F9, so `D1 = C1*2` still shows 2;
/// `A1` likewise, so `B1 = A1*2` still shows 2. Frames move D1 (they must, to be
/// worth showing); the restore puts C1 back AND D1's stale 2, and B1 is never
/// touched. It used to show D1 = 14 after Stop -- a recalculation the user
/// never asked for.
#[test]
fn a_manual_mode_animation_restores_stale_values_exactly() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    wb.set(0, 2, "1"); // C1, the driver
    wb.set(0, 3, "=C1*2"); // D1
    wb.set_on(1, 0, 3, "=Sheet1!C1*10"); // Sheet2!D1
    wb.manual();
    wb.set(0, 0, "5");
    wb.set(0, 2, "7");
    assert_eq!(wb.number(0, 0, 3), 2.0, "precondition: D1 stale");
    assert_eq!(wb.number(0, 0, 1), 2.0, "precondition: B1 stale");

    let snap = crate::animation_commands::anim_snapshot_inner(
        &wb.state,
        AnimSnapshotParams { token: "run".to_string(), sheet_index: 0, cells: vec![(0, 2)] },
    );
    assert!(snap.success);
    crate::document_effect::mark_saved(&wb.file);
    let frame = crate::animation_commands::anim_apply_frame_inner(
        &wb.state,
        &wb.states(),
        AnimApplyFrameParams {
            token: "run".to_string(),
            sheet_index: 0,
            writes: vec![TransientCellWrite { row: 0, col: 2, value: "3".to_string() }],
        },
    );
    assert!(frame.error.is_none(), "{:?}", frame.error);
    assert_eq!(wb.number(0, 0, 3), 6.0, "the frame moves D1");
    assert_eq!(wb.number(1, 0, 3), 30.0, "and Sheet2!D1");
    assert_eq!(wb.number(0, 0, 1), 2.0, "B1 does not read the driver and is not touched");

    let back = crate::animation_commands::anim_restore_inner(
        &wb.state,
        &wb.states(),
        AnimRestoreParams { token: "run".to_string(), sheet_index: 0 },
    );
    assert!(back.error.is_none(), "{:?}", back.error);
    assert_eq!(wb.number(0, 0, 2), 7.0, "C1 restored");
    assert_eq!(wb.number(0, 0, 3), 2.0, "D1 is back at the stale 2 it showed before Play");
    assert_eq!(wb.number(1, 0, 3), 10.0, "Sheet2!D1 back at its stale 10");
    assert_eq!(wb.number(0, 0, 1), 2.0, "B1 still stale");
    assert!(
        back.updated_cells.iter().any(|c| c.row == 0 && c.col == 3 && c.sheet_index.is_none() && c.display == "2"),
        "the restore repaints D1 with its restored value"
    );
    assert!(!wb.file.is_dirty(), "still transient");
}

/// Excel [LIVE, 2026-10-30, manual calculation]: C1 changed to 7 with no F9 so
/// `D1 = C1*3` shows 3; a Scenario Summary of a scenario setting C1 to 100
/// reports D1 = 3 (stored, not recalculated) and leaves C1 = 7, D1 = 3 and an
/// unrelated stale `B1 = A1*2` = 2 exactly as they were.
#[test]
fn a_manual_mode_scenario_summary_recalculates_nothing() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    wb.set(0, 2, "1"); // C1
    wb.set(0, 3, "=C1*3"); // D1
    wb.manual();
    wb.set(0, 0, "5");
    wb.set(0, 2, "7");
    wb.add_scenario("S100", &[(0, 2, "100")]);

    let r = crate::scenario_manager::scenario_summary_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        ScenarioSummaryParams {
            sheet_index: 0,
            result_cells: vec![ScenarioCell { row: 0, col: 3, value: String::new() }],
        },
    );
    assert!(r.error.is_none(), "{:?}", r.error);
    let result_row = r.rows.iter().find(|row| !row.is_changing_cell).expect("a result row");
    assert_eq!(result_row.current_value, "3");
    assert_eq!(result_row.scenario_values, vec!["3".to_string()], "Excel reports the stored D1");
    assert_eq!(wb.number(0, 0, 2), 7.0, "C1 restored");
    assert_eq!(wb.number(0, 0, 3), 3.0, "D1 still its stale 3");
    assert_eq!(wb.number(0, 0, 1), 2.0, "B1 still its stale 2");
}

/// Excel [LIVE, 2026-10-30, manual calculation]: Scenario Show of a scenario
/// on Sheet2 while Sheet1 is active leaves Sheet2's `B1 = A1*2` at its old
/// value -- as Show on the active sheet does. It used to recalculate Sheet2
/// (the background write went through the whole-sheet pass whatever the mode).
#[test]
fn a_manual_mode_scenario_show_on_a_background_sheet_recalculates_nothing() {
    let wb = Wb::new();
    wb.set_on(1, 0, 0, "1"); // Sheet2!A1
    wb.set_on(1, 0, 1, "=A1*2"); // Sheet2!B1
    wb.manual();
    let added = crate::scenario_manager::scenario_add_impl(
        &wb.state,
        &wb.file,
        ScenarioAddParams {
            name: "T".to_string(),
            changing_cells: vec![ScenarioCell { row: 0, col: 0, value: "50".to_string() }],
            comment: String::new(),
            sheet_index: 1,
        },
    );
    assert!(added.success, "{:?}", added.error);
    let r = crate::scenario_manager::scenario_show_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        ScenarioShowParams { name: "T".to_string(), sheet_index: 1 },
    );
    assert!(r.error.is_none(), "{:?}", r.error);
    assert_eq!(wb.number(1, 0, 0), 50.0, "Sheet2!A1 shown");
    assert_eq!(wb.number(1, 0, 1), 2.0, "Sheet2!B1 left for F9");
    wb.f9();
    assert_eq!(wb.number(1, 0, 1), 100.0, "and F9 computes it");
}

// ---------------------------------------------------------------------------
// Round 12 (calc3): Goal Seek's Cancel and its non-numeric target, as Excel.
// ---------------------------------------------------------------------------

fn seek(target: (u32, u32), value: f64, variable: (u32, u32)) -> GoalSeekParams {
    GoalSeekParams {
        target_row: target.0,
        target_col: target.1,
        target_value: value,
        variable_row: variable.0,
        variable_col: variable.1,
        max_iterations: 100,
        tolerance: 0.001,
    }
}

/// THE STATUS DIALOG'S CANCEL LEAVES NOTHING TO REDO. [LIVE, Excel 16, a
/// visible instance driven by SendKeys: Goal Seek of `B1 = A1*2` to 10 by A1,
/// Cancel in Goal Seek Status -> A1 = 1, Undo and Redo both disabled
/// (`GetEnabledMso`), Ctrl+Y changes nothing, Workbook.Saved = False.] Cancel
/// was a scoped undo of the run's step, which put the step on the REDO stack:
/// Ctrl+Y re-applied the solver's value.
///
/// SABOTAGE: make `cancel_goal_seek_impl` push the popped step onto the redo
/// stack (what the scoped undo did).
#[test]
fn goal_seek_cancel_takes_the_run_back_and_leaves_nothing_to_redo() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();
    let r = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((0, 1), 10.0, (0, 0)));
    assert!(r.found_solution, "{:?}", r.error);
    assert!(close(wb.number(0, 0, 0), 5.0, 0.01));
    let seq = r.undo_seq.expect("the run's step");
    crate::document_effect::mark_saved(&wb.file);

    let c = crate::goal_seek::cancel_goal_seek_impl(&wb.state, &wb.file, &wb.states(), seq);
    assert!(c.error.is_none(), "Cancel refused: {:?}", c.error);
    assert_eq!(wb.number(0, 0, 0), 1.0, "Cancel put A1 back");
    assert_eq!(wb.number(0, 0, 1), 2.0, "and B1 with it");
    assert!(
        c.updated_cells.iter().any(|cd| cd.row == 0 && cd.col == 1),
        "the dependent is repainted"
    );
    {
        let stack = wb.state.undo_stack.lock().unwrap();
        assert_eq!(stack.undo_depth(), depth, "the run left no undo step behind");
        assert!(
            !stack.can_redo(),
            "Cancel left a redo step that re-applies the Goal Seek; Excel's Cancel leaves nothing to redo"
        );
    }
    assert!(wb.file.is_dirty(), "Excel's Cancel leaves the workbook changed (Saved = False)");

    // A text original comes back as that text.
    let wb = Wb::new();
    wb.set(0, 0, "n/a");
    wb.set(0, 1, "=IF(ISNUMBER(A1),A1*2,0)");
    let r = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((0, 1), 10.0, (0, 0)));
    let c = crate::goal_seek::cancel_goal_seek_impl(&wb.state, &wb.file, &wb.states(), r.undo_seq.unwrap());
    assert!(c.error.is_none(), "{:?}", c.error);
    assert_eq!(wb.value(0, 0, 0), CellValue::Text("n/a".to_string()));

    // Something else on top of the run's step: refused, nothing moves.
    let wb = Wb::new();
    wb.set(0, 0, "1");
    wb.set(0, 1, "=A1*2");
    let r = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((0, 1), 10.0, (0, 0)));
    wb.set(5, 5, "later");
    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();
    let c = crate::goal_seek::cancel_goal_seek_impl(&wb.state, &wb.file, &wb.states(), r.undo_seq.unwrap());
    assert_eq!(c.error.as_deref(), Some(crate::goal_seek::CANCEL_STEP_MOVED));
    assert!(close(wb.number(0, 0, 0), 5.0, 0.01), "a refused Cancel moves nothing");
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_depth(), depth);
}

/// rev12B (round 13): Cancel popped the run's step BEFORE writing the cell
/// back, so a write-back that failed (its sheet no longer there) lost the step
/// and left the cell unrestored. The cell goes back first; the step leaves the
/// history only after that, so a failed write leaves it for Undo.
///
/// The failing write is a Goal Seek step naming a sheet the workbook does not
/// have (the one way `write_cells_and_recalc` refuses).
///
/// SABOTAGE: pop the step before the write-back again -- fails at "STEP LOST".
#[test]
fn a_goal_seek_cancel_whose_write_back_fails_keeps_the_step() {
    let wb = Wb::new();
    wb.set(0, 0, "1");
    let mut step = engine::Transaction::new("Goal Seek");
    step.add_change(engine::CellChange::SetCell { sheet: 7, row: 0, col: 0, previous: None });
    let seq = {
        let mut stack = wb.state.undo_stack.lock().unwrap();
        stack.push_transaction_direct(step);
        stack.top_undo_seq().expect("the step")
    };
    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();

    let c = crate::goal_seek::cancel_goal_seek_impl(&wb.state, &wb.file, &wb.states(), seq);
    assert!(c.error.is_some(), "the write-back to a missing sheet must fail");
    let stack = wb.state.undo_stack.lock().unwrap();
    assert_eq!(stack.undo_depth(), depth, "STEP LOST: a failed write-back took the run's step off the history");
    assert_eq!(stack.top_undo_seq(), Some(seq), "the run's step is still the one Undo takes back");
    assert!(!stack.can_redo());
}

/// A TARGET THAT IS NOT A NUMBER IS REFUSED BEFORE ANYTHING IS WRITTEN, and a
/// logical counts as one. [LIVE, Excel 16 COM, Workbook.Saved = True before
/// each: `="x"&A2` (text) and `=1/A2` with A2 = 0 (an error) and `=IF(A5=1,"",
/// A5*2)` (empty text) are refused, the changing cell untouched and Saved
/// still True; `=A3>5` sought to 1 returns True with A3 = 6.12;
/// `=IF(A4>5,"big",A4)` sought to 10 returns False and leaves A4 =
/// 5.00000000022352, the trial that made it text.] The run used to write a
/// trial, find no number, put the cell back and report the error -- the
/// document dirtied with no undo step.
///
/// SABOTAGE: drop the numeric check on the target before the effect.
#[test]
fn a_goal_seek_target_that_is_not_a_number_is_refused_before_anything_is_written() {
    let wb = Wb::new();
    wb.set(1, 0, "1"); // A2
    wb.set(1, 1, "=\"x\"&A2"); // B2: text
    wb.set(2, 0, "0"); // A3
    wb.set(2, 1, "=1/A3"); // B3: #DIV/0!
    crate::document_effect::mark_saved(&wb.file);
    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();
    for (target, variable, what) in [((1, 1), (1, 0), "text"), ((2, 1), (2, 0), "an error")] {
        let before = wb.value(0, variable.0, variable.1);
        let r = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek(target, 7.0, variable));
        assert!(r.error.is_some(), "a target holding {} must be refused", what);
        assert_eq!(r.undo_seq, None);
        assert_eq!(wb.value(0, variable.0, variable.1), before, "the changing cell is untouched");
        assert!(
            !wb.file.is_dirty(),
            "a Goal Seek refused over a target holding {} dirtied the document; Excel leaves it saved",
            what
        );
        assert_eq!(wb.state.undo_stack.lock().unwrap().undo_depth(), depth);
    }

    // A logical is a number to Goal Seek (TRUE = 1).
    wb.set(3, 0, "1"); // A4
    wb.set(3, 1, "=A4>5"); // B4
    let r = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((3, 1), 1.0, (3, 0)));
    assert!(r.error.is_none(), "{:?}", r.error);
    assert!(r.found_solution, "Excel solves =A4>5 for TRUE");
    assert!(wb.number(0, 3, 0) > 5.0, "A4 = {}", wb.number(0, 3, 0));

    // A target that turns into text DURING the search: not found, the last
    // trial stays, and the run is one undo step like any other.
    wb.set(4, 0, "1"); // A5
    wb.set(4, 1, "=IF(A5>5,\"big\",A5)"); // B5
    let r = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((4, 1), 10.0, (4, 0)));
    assert!(r.error.is_none(), "{:?}", r.error);
    assert!(!r.found_solution);
    assert!(r.undo_seq.is_some(), "a run that wrote records its step");
    assert_eq!(wb.value(0, 4, 1), CellValue::Text("big".to_string()), "the last trial is the one that made it text");
}

// ---------------------------------------------------------------------------
// Round 13 (whatif3): one run at a time, the run's sheet by stable id, the
// Solver answer a second Esc cannot cut short, a paused animation's edits.
// ---------------------------------------------------------------------------

impl Wb {
    /// Where the sheet with this stable id is now.
    fn index_of(&self, id: identity::SheetId) -> usize {
        self.state.sheet_ids.read().unwrap().iter().position(|s| *s == id).expect("the sheet exists")
    }

    fn id_at(&self, index: usize) -> identity::SheetId {
        self.state.sheet_ids.read().unwrap()[index]
    }
}

/// ONE WHAT-IF RUN AT A TIME. The four what-if commands are `(async)`, and two
/// runs overlapped (Enter pressed twice in the dialog): the second snapshotted
/// the first's TRIAL value as the input cell's original and restored it last,
/// so the cell kept a trial value for good. While a run holds the single-flight
/// every other what-if command -- a data table of either kind, Goal Seek and its
/// Cancel, Solver and its Restore -- is refused before any gate: it writes
/// nothing and leaves the document clean. The guard is released when the run
/// ends, refused or not.
///
/// SABOTAGE: make `begin_whatif_run` succeed whatever the flag says.
#[test]
fn a_whatif_run_is_refused_while_another_is_running_and_writes_nothing() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    wb.set(9, 0, "1"); // A10, a table's input
    wb.set(9, 4, "=A10*3"); // E10
    wb.set(10, 3, "5"); // D11
    let r = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((0, 1), 10.0, (0, 0)));
    let seq = r.undo_seq.expect("a step to cancel");
    crate::document_effect::mark_saved(&wb.file);
    let before_a1 = wb.value(0, 0, 0);

    let running = crate::whatif_recalc::begin_whatif_run(&wb.state).expect("the first run takes the guard");
    let busy = Some(crate::whatif_recalc::WHATIF_RUN_BUSY.to_string());

    let table = crate::data_tables::data_table_one_var_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        DataTableOneVarParams {
            sheet_index: 0,
            start_row: 9,
            start_col: 3,
            end_row: 10,
            end_col: 4,
            row_input_row: None,
            row_input_col: None,
            col_input_row: Some(9),
            col_input_col: Some(0),
        },
    );
    assert_eq!(table.error, busy, "a second data table must be refused while a run is going");
    let table2 = crate::data_tables::data_table_two_var_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        DataTableTwoVarParams {
            sheet_index: 0,
            start_row: 9,
            start_col: 3,
            end_row: 10,
            end_col: 4,
            row_input_row: 9,
            row_input_col: 0,
            col_input_row: 9,
            col_input_col: 0,
        },
    );
    assert_eq!(table2.error, busy, "a two-variable table too");
    let gs = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((0, 1), 20.0, (0, 0)));
    assert_eq!(gs.error, busy, "a second Goal Seek too");
    let cancel = crate::goal_seek::cancel_goal_seek_impl(&wb.state, &wb.file, &wb.states(), seq);
    assert_eq!(cancel.error, busy, "and Goal Seek's Cancel");
    let solver = crate::solver::solver_solve_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        SolverParams {
            sheet_index: 0,
            objective_row: 0,
            objective_col: 1,
            objective: SolverObjective::Minimize,
            target_value: None,
            variable_cells: vec![SolverVariableCell { row: 0, col: 0 }],
            constraints: Vec::new(),
            method: SolverMethod::GrgNonlinear,
            max_iterations: 10,
            max_time: 100,
            tolerance: 1e-6,
        },
    );
    assert_eq!(solver.error, busy, "and Solver");
    let revert = crate::solver::solver_revert_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        wb.id_at(0),
        vec![crate::api_types::SolverVariableValue { row: 0, col: 0, value: 99.0 }],
    );
    assert_eq!(revert.error, busy, "and Solver's Restore");
    assert_eq!(wb.value(0, 0, 0), before_a1, "a refused run wrote nothing");
    assert_eq!(wb.value(0, 10, 4), CellValue::Empty, "no table body was written");
    assert!(!wb.file.is_dirty(), "a refused run leaves the document clean");

    drop(running);
    // Released: a refused-at-a-gate run releases it too, and the next one runs.
    let refused = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((5, 5), 1.0, (0, 0)));
    assert!(refused.error.is_some() && refused.error != busy, "{:?}", refused.error);
    let c = crate::goal_seek::cancel_goal_seek_impl(&wb.state, &wb.file, &wb.states(), seq);
    assert!(c.error.is_none(), "the run after the first is no longer refused: {:?}", c.error);
    assert_eq!(wb.number(0, 0, 0), 1.0);
    assert!(!wb.state.whatif_run.load(std::sync::atomic::Ordering::SeqCst), "the guard is released");
}

/// THE RUN FOLLOWS ITS SHEET BY STABLE ID. A data table on Sheet2 (the active
/// sheet) is running when Sheet3's tab is dragged to the front: Sheet2's index
/// becomes 2 and index 1 is now Sheet1. Every later trial, the read-back, the
/// body and the restore of the borrowed input used to land on index 1 --
/// Sheet1's A10 overwritten with trial values and Sheet1's E column filled.
///
/// SABOTAGE: make `RunSheet::index` answer the index the run started with.
#[test]
fn a_data_table_follows_its_sheet_when_a_tab_moves_mid_run() {
    const ROWS: u32 = 400;
    let wb = Wb::new();
    wb.add_sheet("Sheet3");
    wb.set(9, 0, "keep"); // Sheet1!A10, what the misdirected trials overwrote
    wb.switch_to(1);
    wb.set(9, 0, "1"); // Sheet2!A10, the input
    wb.set(9, 4, "=A10*2"); // Sheet2!E10, the table's formula
    for r in 0..ROWS {
        wb.set(10 + r, 3, &(r + 1).to_string()); // D11..
    }
    let sheet2 = wb.id_at(1);
    let timeline = crate::timeline_slicer::TimelineSlicerState::new();

    let moved_mid_run = std::thread::scope(|scope| {
        let wbr = &wb;
        let timeline = &timeline;
        let mover = scope.spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            while std::time::Instant::now() < deadline {
                let trial_written = {
                    let grids = wbr.state.grids.read().unwrap();
                    let idx = wbr.index_of(sheet2);
                    grids[idx].get_cell(9, 0).is_some_and(|c| c.value != CellValue::Number(1.0))
                };
                if trial_written {
                    crate::sheets::move_sheet_impl(
                        &wbr.state, &wbr.file, &wbr.slicer, timeline, &wbr.filters, 2, 0,
                    )
                    .expect("move Sheet3 to the front");
                    // Still mid-run: the body is written only after the last trial.
                    let grids = wbr.state.grids.read().unwrap();
                    let idx = wbr.index_of(sheet2);
                    return grids[idx].get_cell(10 + ROWS - 1, 4).is_none();
                }
                std::thread::sleep(std::time::Duration::from_micros(200));
            }
            false
        });
        let r = crate::data_tables::data_table_one_var_impl(
            &wb.state,
            &wb.file,
            &wb.states(),
            DataTableOneVarParams {
                sheet_index: 1,
                start_row: 9,
                start_col: 3,
                end_row: 9 + ROWS,
                end_col: 4,
                row_input_row: None,
                row_input_col: None,
                col_input_row: Some(9),
                col_input_col: Some(0),
            },
        );
        assert!(r.error.is_none(), "data table: {:?}", r.error);
        mover.join().unwrap()
    });
    assert!(moved_mid_run, "precondition: the tab moved while the table was still running");

    let s2 = wb.index_of(sheet2);
    assert_eq!(s2, 2, "Sheet2 is now third");
    assert_eq!(
        wb.value(1, 9, 0),
        CellValue::Text("keep".to_string()),
        "Sheet1!A10 (index 1 after the move) was overwritten by the run"
    );
    for r in 0..ROWS {
        assert_eq!(wb.value(1, 10 + r, 4), CellValue::Empty, "Sheet1!E{} was written by the run", 11 + r);
    }
    assert_eq!(wb.number(s2, 9, 0), 1.0, "Sheet2!A10 restored");
    for r in 0..ROWS {
        assert_eq!(wb.number(s2, 10 + r, 4), 2.0 * (r + 1) as f64, "Sheet2!E{}", 11 + r);
    }
}

/// THE SEEDED CASCADE CHECKS ITS SHEET UNDER ITS OWN LOCKS. A trial decides
/// "the written sheet is the active one" under its write's locks and drops
/// them before the cascade takes them again; a sheet switch in between made
/// the seeds' coordinates address the NEWLY active sheet, so the real target
/// was never recalculated and the trial read a stale value. The cascade now
/// names the sheet it expects by stable id and, when another one is active,
/// does nothing and says so (the trial then recalculates the written sheet as
/// a background sheet).
///
/// SABOTAGE: drop the expected-sheet check in
/// `recalc_after_active_sheet_bulk_rewrite`.
#[test]
fn the_seeded_cascade_refuses_seeds_meant_for_a_sheet_that_is_no_longer_active() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // Sheet1!A1
    wb.set(0, 1, "=A1*2"); // Sheet1!B1
    let sheet1 = wb.id_at(0);
    let sheet2 = wb.id_at(1);
    // A1 changed with no recalculation (the write half of a trial).
    {
        let effect = crate::document_effect::DocumentEffect::mutates(&wb.file);
        let mut grid = wb.state.grid.write(&effect).unwrap();
        let mut grids = wb.state.grids.write(&effect).unwrap();
        grid.set_cell(0, 0, engine::Cell::new_number(7.0));
        grids[0].set_cell(0, 0, engine::Cell::new_number(7.0));
    }
    let mut reply = Vec::new();
    let ran = crate::commands::data::cascade_whatever_the_mode(
        &wb.state, &wb.files, &wb.pane, &wb.filters, Some(sheet2), &[(0, 0)], &mut reply,
    );
    assert!(!ran, "seeds meant for Sheet2 were cascaded on Sheet1, the active sheet");
    assert!(reply.is_empty(), "nothing was evaluated: {:?}", reply.iter().map(|c| (c.row, c.col)).collect::<Vec<_>>());
    assert_eq!(wb.number(0, 0, 1), 2.0, "Sheet1!B1 untouched by a cascade aimed at another sheet");

    let ran = crate::commands::data::cascade_whatever_the_mode(
        &wb.state, &wb.files, &wb.pane, &wb.filters, Some(sheet1), &[(0, 0)], &mut reply,
    );
    assert!(ran);
    assert_eq!(wb.number(0, 0, 1), 14.0, "the cascade on the sheet it expects runs");
}

/// SOLVER'S ANSWER IS WRITTEN WHATEVER A SECOND ESC DOES. Esc stops a run; the
/// run clears the stop and writes its best point, but the dialog still showed
/// the run as going, so a second Esc raised the workbook cancel token again
/// during that write and the cascade evaluated the answer's dependents as
/// `#LIMIT!`. The answer's write runs under a private token nobody can raise.
///
/// SABOTAGE: drop the private governor in `solver::write_answer`.
#[test]
fn a_second_esc_cannot_cut_solvers_answer_short() {
    let wb = Wb::new();
    wb.set(0, 0, "0"); // A1, the variable
    wb.set(0, 2, "=(A1-3)^2"); // C1, the objective
    wb.set(0, 3, "=C1+1"); // D1, a dependent
    wb.set_on(1, 0, 0, "=Sheet1!D1*10"); // Sheet2!A1, a dependent on another sheet
    let effect = crate::document_effect::DocumentEffect::mutates(&wb.file);
    // The run's own pass owns the workbook token, as `solver_solve_impl`'s does.
    let run_pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Background,
        &wb.state.calc_cancel,
    );
    wb.state.calc_cancel.cancel(); // the second Esc, during the final write
    let mut reply = Vec::new();
    crate::solver::write_answer(
        &wb.state,
        &wb.states(),
        &effect,
        crate::whatif_recalc::RunSheet::at(&wb.state, 0),
        &[((0, 0), Some(engine::Cell::new_number(3.0)))],
        &mut reply,
    )
    .expect("the answer's write");
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(0.0), "C1 = (3-3)^2, not cut short");
    assert_eq!(wb.value(0, 0, 3), CellValue::Number(1.0), "D1 = C1+1, not cut short");
    assert_eq!(wb.value(1, 0, 0), CellValue::Number(10.0), "Sheet2!A1 = D1*10, not cut short");
    drop(run_pass);
    assert!(!wb.state.calc_cancel.is_cancelled(), "the stray Esc does not outlive the run");
}

/// A PAUSED ANIMATION'S STOP TAKES BACK ONLY WHAT THE RUN WROTE (manual
/// calculation). While paused the user re-types `D1` from `=C1*2` to `=C1*3`
/// (Enter evaluates it: 9 with the frame's C1 = 3) and presses F9, which
/// recalculates `B1 = A1*2` (left stale before Play) to 10. Stop put the
/// journalled 2 back on BOTH: the new formula showed the old formula's number,
/// and the user's F9 was undone. Now Stop restores C1 and every value the
/// frames left, and leaves the user's re-typed cell and recalculated values.
///
/// SABOTAGE: drop the formula and frame-left checks in `restore_journal_values`.
#[test]
fn a_paused_animations_stop_leaves_what_the_user_did_while_paused() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    wb.set(0, 2, "1"); // C1, the driver
    wb.set(0, 3, "=C1*2"); // D1
    wb.set(0, 4, "=C1*5"); // E1, untouched by the user
    wb.manual();
    wb.set(0, 0, "5"); // B1 stale at 2
    assert_eq!(wb.number(0, 0, 1), 2.0, "precondition: B1 stale");

    let snap = crate::animation_commands::anim_snapshot_inner(
        &wb.state,
        AnimSnapshotParams { token: "run".to_string(), sheet_index: 0, cells: vec![(0, 2)] },
    );
    assert!(snap.success);
    let frame = crate::animation_commands::anim_apply_frame_inner(
        &wb.state,
        &wb.states(),
        AnimApplyFrameParams {
            token: "run".to_string(),
            sheet_index: 0,
            writes: vec![TransientCellWrite { row: 0, col: 2, value: "3".to_string() }],
        },
    );
    assert!(frame.error.is_none(), "{:?}", frame.error);
    assert_eq!(wb.number(0, 0, 3), 6.0, "the frame moves D1");
    assert_eq!(wb.number(0, 0, 4), 15.0, "and E1");

    // Paused: the user re-types D1, then presses F9.
    wb.set(0, 3, "=C1*3");
    assert_eq!(wb.number(0, 0, 3), 9.0, "Enter evaluates the re-typed D1");
    wb.f9();
    assert_eq!(wb.number(0, 0, 1), 10.0, "F9 recalculates the stale B1");

    let back = crate::animation_commands::anim_restore_inner(
        &wb.state,
        &wb.states(),
        AnimRestoreParams { token: "run".to_string(), sheet_index: 0 },
    );
    assert!(back.error.is_none(), "{:?}", back.error);
    assert_eq!(wb.number(0, 0, 2), 1.0, "C1, the driver, restored");
    assert_eq!(wb.number(0, 0, 4), 5.0, "E1, a value the frame left, restored");
    assert_eq!(
        wb.number(0, 0, 3),
        9.0,
        "Stop put the old formula's value on the re-typed D1 (=C1*3)"
    );
    assert_eq!(wb.number(0, 0, 1), 10.0, "Stop undid the user's F9 on B1");
}

/// SCENARIOS TAKE THE WHAT-IF SINGLE-FLIGHT (NEW-anim-scenario-not-single-flight).
/// Scenario Show and Summary were sync commands that never asked whether an
/// async Data Table / Goal Seek / Solver run was between two trials, so a
/// scenario could write the very cell that run had borrowed (and Summary put
/// its own "original" -- a trial value -- back). Excel's what-if commands are
/// modal, so one cannot start while another runs. Each is now refused while a
/// run holds the guard, writes nothing, and leaves the document clean; once the
/// run ends both work.
///
/// SABOTAGE: drop the `begin_whatif_run` call from `scenario_show_impl` and
/// `scenario_summary_impl`.
#[test]
fn a_scenario_is_refused_while_a_whatif_run_is_writing_trials() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1, the changing cell
    wb.set(0, 1, "=A1*2"); // B1
    wb.add_scenario("High", &[(0, 0, "50")]);
    crate::document_effect::mark_saved(&wb.file);

    let running = crate::whatif_recalc::begin_whatif_run(&wb.state).expect("the run takes the guard");
    let busy = Some(crate::whatif_recalc::WHATIF_RUN_BUSY.to_string());

    let show = crate::scenario_manager::scenario_show_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        ScenarioShowParams { name: "High".to_string(), sheet_index: 0 },
    );
    assert_eq!(show.error, busy, "Scenario Show must be refused while a what-if run is going");
    let summary = crate::scenario_manager::scenario_summary_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        ScenarioSummaryParams {
            sheet_index: 0,
            result_cells: vec![ScenarioCell { row: 0, col: 1, value: String::new() }],
        },
    );
    assert_eq!(summary.error, busy, "Scenario Summary must be refused while a what-if run is going");
    assert_eq!(wb.number(0, 0, 0), 1.0, "a refused scenario wrote nothing");
    assert_eq!(wb.number(0, 0, 1), 2.0);
    assert!(!wb.file.is_dirty(), "a refused scenario leaves the document clean");

    drop(running);
    wb.show("High");
    assert_eq!(wb.number(0, 0, 1), 100.0, "after the run, Show works");
    assert!(!wb.state.whatif_run.load(std::sync::atomic::Ordering::SeqCst), "Show released the guard");
}

/// AN ANIMATION AND A WHAT-IF RUN EXCLUDE EACH OTHER, both ways.
/// (1) A snapshot taken while a run is between trials would file the run's
/// TRIAL value as the driver cell's original, and Stop would put that trial
/// back for good: the snapshot is refused and files no buffer. (2) While an
/// animation holds a restore buffer (playing or paused), a Goal Seek, Data
/// Table or Scenario Show that borrowed one of its cells would be undone by
/// Stop (or undo the animation's frame): each is refused, writes nothing, and
/// works again after Stop.
///
/// SABOTAGE (1): drop the `claim_whatif_flag` gate from `anim_snapshot_inner`.
/// SABOTAGE (2): drop the restore-buffer check from `begin_whatif_run`.
#[test]
fn an_animation_and_a_whatif_run_refuse_each_other() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1, the driver and the changing cell
    wb.set(0, 1, "=A1*2"); // B1
    wb.add_scenario("High", &[(0, 0, "50")]);
    crate::document_effect::mark_saved(&wb.file);

    // (1) A run is going: the animation cannot snapshot.
    {
        let _running = crate::whatif_recalc::begin_whatif_run(&wb.state).expect("the run takes the guard");
        let snap = crate::animation_commands::anim_snapshot_inner(
            &wb.state,
            AnimSnapshotParams { token: "run".to_string(), sheet_index: 0, cells: vec![(0, 0)] },
        );
        assert!(!snap.success, "an animation must not snapshot while a what-if run is going");
        assert_eq!(snap.error, Some(crate::whatif_recalc::ANIMATION_WHATIF_BUSY.to_string()));
        assert!(
            wb.state.animation_snapshots.lock().unwrap().is_empty(),
            "a refused snapshot files no restore buffer"
        );
    }

    // (2) The animation holds a buffer (paused mid-run): no what-if run starts.
    let snap = crate::animation_commands::anim_snapshot_inner(
        &wb.state,
        AnimSnapshotParams { token: "run".to_string(), sheet_index: 0, cells: vec![(0, 0)] },
    );
    assert!(snap.success, "with no run going the snapshot is taken: {:?}", snap.error);
    assert!(
        !wb.state.whatif_run.load(std::sync::atomic::Ordering::SeqCst),
        "the snapshot holds the flag only while it files its buffer"
    );
    let frame = crate::animation_commands::anim_apply_frame_inner(
        &wb.state,
        &wb.states(),
        AnimApplyFrameParams {
            token: "run".to_string(),
            sheet_index: 0,
            writes: vec![TransientCellWrite { row: 0, col: 0, value: "7".to_string() }],
        },
    );
    assert!(frame.error.is_none(), "frame: {:?}", frame.error);
    let live = Some(crate::whatif_recalc::WHATIF_ANIMATION_LIVE.to_string());

    let gs = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((0, 1), 40.0, (0, 0)));
    assert_eq!(gs.error, live, "Goal Seek must be refused while an animation holds a restore buffer");
    let table = crate::data_tables::data_table_one_var_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        DataTableOneVarParams {
            sheet_index: 0,
            start_row: 9,
            start_col: 3,
            end_row: 10,
            end_col: 4,
            row_input_row: None,
            row_input_col: None,
            col_input_row: Some(0),
            col_input_col: Some(0),
        },
    );
    assert_eq!(table.error, live, "a Data Table too");
    let show = crate::scenario_manager::scenario_show_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        ScenarioShowParams { name: "High".to_string(), sheet_index: 0 },
    );
    assert_eq!(show.error, live, "and Scenario Show");
    assert_eq!(wb.number(0, 0, 0), 7.0, "the refused runs left the animation's frame alone");
    assert!(!wb.file.is_dirty(), "a refused run leaves the document clean");
    assert!(
        !wb.state.whatif_run.load(std::sync::atomic::Ordering::SeqCst),
        "a run refused for the animation releases the guard"
    );

    // Stop: the buffer is gone and the run works.
    let back = crate::animation_commands::anim_restore_inner(
        &wb.state,
        &wb.states(),
        AnimRestoreParams { token: "run".to_string(), sheet_index: 0 },
    );
    assert!(back.error.is_none(), "restore: {:?}", back.error);
    assert_eq!(wb.number(0, 0, 0), 1.0, "Stop put the driver back");
    let gs = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((0, 1), 40.0, (0, 0)));
    assert!(gs.error.is_none(), "after Stop, Goal Seek runs: {:?}", gs.error);
    assert!(close(wb.number(0, 0, 0), 20.0, 1e-6), "Goal Seek solved A1");
}

// ---------------------------------------------------------------------------
// Round 15 (rev13A): a Goal Seek whose sheet goes, and the protection gates
// asked under the run's own locks.
// ---------------------------------------------------------------------------

/// GOAL SEEK ON A SHEET DELETED MID-RUN SAYS THE SHEET IS GONE. The trial
/// turned the write's `WHATIF_SHEET_GONE` into `None` -- "the target is no
/// number" -- so the run ended as "may not have found a solution" with a NaN
/// target and no error, and nothing said the sheet was gone.
///
/// SABOTAGE: in `goal_seek_impl`'s trial, turn the write's `)?;` back into
/// `).ok();` (the error is swallowed again, as before) -- the `error`
/// assertion fails with `None (found=false, target=NaN)`.
#[test]
fn a_goal_seek_whose_sheet_is_deleted_mid_run_reports_the_sheet_gone() {
    let wb = Wb::new();
    wb.switch_to(1);
    wb.set(0, 5, "10"); // Sheet2!F1, the changing cell
    wb.set(0, 6, "=5"); // Sheet2!G1, a target no trial can move to 7
    let sheet2 = wb.id_at(1);
    let timeline = crate::timeline_slicer::TimelineSlicerState::new();
    let mut params = seek((0, 6), 7.0, (0, 5));
    params.max_iterations = 5_000_000; // the run lasts until the sheet goes

    let (result, deleted) = std::thread::scope(|scope| {
        let wbr = &wb;
        let timeline = &timeline;
        let deleter = scope.spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            while std::time::Instant::now() < deadline {
                let trial_written = {
                    let grids = wbr.state.grids.read().unwrap();
                    grids.len() == 2 && grids[1].get_cell(0, 5).is_some_and(|c| c.value != CellValue::Number(10.0))
                };
                if trial_written {
                    crate::sheets::delete_sheet_impl(
                        &wbr.state,
                        &wbr.file,
                        &wbr.pivots,
                        &wbr.files,
                        &wbr.pane,
                        &wbr.filters,
                        &wbr.slicer,
                        timeline,
                        1,
                        false,
                        Some(sheet2),
                    )
                    .expect("delete Sheet2 mid-run");
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_micros(200));
            }
            false
        });
        let r = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), params);
        (r, deleter.join().unwrap())
    });
    assert!(deleted, "precondition: Sheet2 was deleted while the Goal Seek ran");
    assert_eq!(
        result.error.as_deref(),
        Some(crate::whatif_recalc::WHATIF_SHEET_GONE),
        "a Goal Seek whose sheet was deleted reported {:?} (found={}, target={})",
        result.error,
        result.found_solution,
        result.target_result
    );
    assert_eq!(result.undo_seq, None, "a step that names a deleted sheet was pushed");
    assert_eq!(wb.value(0, 0, 5), CellValue::Empty, "Sheet1 (now index 0) received a trial");
}

fn protect_sheet(wb: &Wb, sheet: usize) {
    wb.state.sheet_protection.write(&crate::document_effect::test_seed_effect()).unwrap().insert(
        sheet,
        crate::protection::SheetProtection {
            protected: true,
            password_hash: None,
            password_salt: None,
            options: Default::default(),
            allow_edit_ranges: Vec::new(),
        },
    );
}

/// THE PROTECTION GATES ARE ASKED UNDER THE RUN'S OWN LOCKS (rev13A). A Data
/// Table, Solver and Goal Seek each read the sheet's protection BY INDEX before
/// taking the grid locks the run then used, so a tab moved in between gated
/// one sheet and ran on another. Now each is asked inside the validation
/// section, of the sheet that section resolves -- and still refuses a locked
/// cell on a protected sheet, a background one included, before anything is
/// written.
///
/// SABOTAGE: make `whatif_recalc::check_run_protection_held` return `Ok(())`
/// at once -- every refusal below fails. (The source half fails if a
/// self-locking `check_sheet_protection_*` call comes back in front of the
/// locks.)
#[test]
fn the_what_if_protection_gates_refuse_under_the_runs_locks() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // Sheet1!A1
    wb.set(0, 1, "=A1*2"); // Sheet1!B1
    wb.set_on(1, 0, 0, "1"); // Sheet2!A1
    wb.set_on(1, 0, 2, "=(A1-3)^2"); // Sheet2!C1
    wb.set_on(1, 9, 4, "=A1*2"); // Sheet2!E10
    wb.set_on(1, 10, 3, "5"); // Sheet2!D11
    protect_sheet(&wb, 1); // the BACKGROUND sheet
    crate::document_effect::mark_saved(&wb.file);

    let table = crate::data_tables::data_table_one_var_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        DataTableOneVarParams {
            sheet_index: 1,
            start_row: 9,
            start_col: 3,
            end_row: 10,
            end_col: 4,
            row_input_row: None,
            row_input_col: None,
            col_input_row: Some(0),
            col_input_col: Some(0),
        },
    );
    assert!(
        table.error.as_deref().is_some_and(|e| e.contains("protected")),
        "a Data Table over a protected background sheet ran: {:?}",
        table.error
    );
    let two = crate::data_tables::data_table_two_var_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        DataTableTwoVarParams {
            sheet_index: 1,
            start_row: 9,
            start_col: 4,
            end_row: 10,
            end_col: 5,
            row_input_row: 0,
            row_input_col: 0,
            col_input_row: 0,
            col_input_col: 1,
        },
    );
    assert!(
        two.error.as_deref().is_some_and(|e| e.contains("protected")),
        "a two-variable Data Table over a protected background sheet ran: {:?}",
        two.error
    );
    let solver = crate::solver::solver_solve_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        SolverParams {
            sheet_index: 1,
            objective_row: 0,
            objective_col: 2,
            objective: SolverObjective::Minimize,
            target_value: None,
            variable_cells: vec![SolverVariableCell { row: 0, col: 0 }],
            constraints: Vec::new(),
            method: SolverMethod::GrgNonlinear,
            max_iterations: 50,
            max_time: 10,
            tolerance: 1e-6,
        },
    );
    assert!(
        solver.error.as_deref().is_some_and(|e| e.contains("protected")),
        "Solver on a protected background sheet ran: {:?}",
        solver.error
    );
    assert_eq!(wb.number(1, 0, 0), 1.0, "a refused run wrote Sheet2!A1");
    assert!(!wb.file.is_dirty(), "a refused run dirtied the document");

    // Goal Seek's gate is the ACTIVE sheet's: Sheet1 unprotected runs...
    let gs = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((0, 1), 10.0, (0, 0)));
    assert!(gs.error.is_none(), "Goal Seek on an unprotected sheet was refused: {:?}", gs.error);
    assert!(close(wb.number(0, 0, 0), 5.0, 1e-6));
    // ...and protected refuses.
    protect_sheet(&wb, 0);
    let gs = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), seek((0, 1), 20.0, (0, 0)));
    assert!(
        gs.error.as_deref().is_some_and(|e| e.contains("protected")),
        "Goal Seek on a protected sheet ran: {:?}",
        gs.error
    );
    assert!(close(wb.number(0, 0, 0), 5.0, 1e-6), "the refused Goal Seek wrote A1");

    // THE SOURCE HALF: no self-locking gate in front of the locks.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for (file, doors) in [
        ("src/data_tables.rs", &["pub(crate) fn data_table_one_var_impl(", "pub(crate) fn data_table_two_var_impl("][..]),
        ("src/solver.rs", &["pub(crate) fn solver_solve_impl("][..]),
        ("src/goal_seek.rs", &["pub(crate) fn goal_seek_impl("][..]),
    ] {
        let src: String = std::fs::read_to_string(root.join(file))
            .unwrap()
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for door in doors {
            let at = src.find(door).unwrap_or_else(|| panic!("`{door}` moved"));
            let end = src[at..].find("\n}").unwrap_or_else(|| panic!("`{door}` in {file} has no end"));
            let body = &src[at..at + end];
            assert!(
                !body.contains("check_sheet_protection_range(") && !body.contains("check_sheet_protection_cells("),
                "`{door}..` gates protection through a self-locking wrapper, outside the run's locks"
            );
            let locked = body.find("state.grids.lock_pending()").expect("the validation section moved");
            let gate = body.find("check_run_protection_held(").unwrap_or_else(|| panic!("`{door}..` lost its protection gate"));
            assert!(locked < gate, "`{door}..` gates protection before taking the run's locks");
        }
    }
}

// ---------------------------------------------------------------------------
// Round 16 (whatif4): the background-sheet trial under manual calculation,
// Solver's sheet gone mid-run, and Solver's Restore by stable sheet id.
// ---------------------------------------------------------------------------

/// A TRIAL ON A BACKGROUND SHEET, UNDER MANUAL CALCULATION, RECALCULATES ONLY
/// THE CELLS THAT READ ITS INPUT. A trial whose sheet is not the active one (a
/// Data Table or Solver run on another sheet, or a Goal Seek whose sheet the
/// user switched away from mid-run) fell back to two whole-sheet passes over
/// that sheet, every sheet reading it and the active sheet -- so every value
/// the user had left stale for F9 was quietly recalculated. It is now the
/// seeded cascade rooted on that sheet: the input's readers there and on every
/// other sheet, and nothing else.
///
/// This pins ONE TRIAL's cost, not what a run leaves: a Goal Seek or Solver run
/// ends with ONE workbook pass that calculates every stale cell, as Excel's
/// does (round 18; `solver_under_manual_calculation_ends_calculated_when_kept_and_when_restored`).
///
/// SABOTAGE: in `whatif_recalc::recalc_background_sheet`, call the whole-sheet
/// `recalc_after_off_sheet_write` under manual calculation too.
#[test]
fn a_background_sheet_trial_under_manual_recalculates_only_the_inputs_readers() {
    let wb = Wb::new();
    wb.set_on(1, 0, 0, "1"); // Sheet2!A1, the input
    wb.set_on(1, 0, 1, "=A1*2"); // Sheet2!B1, its reader
    wb.set_on(1, 0, 2, "=B1+A1"); // Sheet2!C1, a second-order reader
    wb.set_on(1, 0, 3, "1"); // Sheet2!D1
    wb.set_on(1, 0, 4, "=D1*2"); // Sheet2!E1, unrelated
    wb.set(0, 0, "=Sheet2!C1+100"); // Sheet1!A1, a reader on the ACTIVE sheet
    wb.set(0, 5, "1"); // Sheet1!F1
    wb.set(0, 6, "=F1*2"); // Sheet1!G1, unrelated, on the active sheet
    wb.set(0, 7, "=Sheet2!D1*3"); // Sheet1!H1, an unrelated cross-sheet reader
    wb.manual();
    wb.set_on(1, 0, 3, "5"); // E1 and H1 stale (2 and 3) until F9
    wb.set(0, 5, "5"); // G1 stale (2) until F9
    assert_eq!(wb.number(1, 0, 4), 2.0, "precondition: Sheet2!E1 stale");
    assert_eq!(wb.number(0, 0, 6), 2.0, "precondition: Sheet1!G1 stale");
    assert_eq!(wb.number(0, 0, 7), 3.0, "precondition: Sheet1!H1 stale");
    assert_eq!(*wb.state.active_sheet.read().unwrap(), 0, "precondition: Sheet1 active");

    let effect = crate::document_effect::DocumentEffect::mutates(&wb.file);
    let mut reply = Vec::new();
    crate::whatif_recalc::write_cells_and_recalc(
        &wb.state,
        &wb.states(),
        &effect,
        1,
        &[((0, 0), Some(engine::Cell::new_number(7.0)))],
        crate::whatif_recalc::RecalcMode::Always,
        &mut reply,
    )
    .expect("the trial");

    assert_eq!(wb.number(1, 0, 1), 14.0, "Sheet2!B1 = A1*2 is recalculated for the trial");
    assert_eq!(wb.number(1, 0, 2), 21.0, "Sheet2!C1 = B1+A1 after B1 (topological order)");
    assert_eq!(wb.number(0, 0, 0), 121.0, "Sheet1!A1 = Sheet2!C1+100, the reader on the active sheet");
    assert_eq!(
        wb.state.grid.read().unwrap().get_cell(0, 0).map(|c| c.value.clone()),
        Some(CellValue::Number(121.0)),
        "the active sheet's mirror holds the reader's new value too"
    );
    assert_eq!(wb.number(1, 0, 4), 2.0, "Sheet2!E1, left stale by the user, was recalculated by the trial");
    assert_eq!(wb.number(0, 0, 6), 2.0, "Sheet1!G1, left stale by the user, was recalculated by the trial");
    assert_eq!(wb.number(0, 0, 7), 3.0, "Sheet1!H1, left stale by the user, was recalculated by the trial");
    let sheet2_reported: Vec<(u32, u32)> =
        reply.iter().filter(|c| c.sheet_index == Some(1)).map(|c| (c.row, c.col)).collect();
    assert!(
        sheet2_reported.contains(&(0, 1)) && sheet2_reported.contains(&(0, 2)),
        "the trial's readers on Sheet2 are reported for the repaint: {:?}",
        sheet2_reported
    );

    // THE FALLBACK takes the same step: a trial whose sheet stopped being the
    // active one between its write and its cascade.
    let src = include_str!("whatif_recalc.rs");
    let at = src.find("if !ran {").expect("the fallback moved");
    let fallback = &src[at..at + src[at..].find("} else {").expect("the fallback's end")];
    assert!(
        fallback.contains("recalc_background_sheet(") && !fallback.contains("recalc_after_off_sheet_write("),
        "the sheet-switched-mid-run fallback no longer takes the background-sheet step"
    );
}

/// SOLVER ON A SHEET DELETED MID-RUN SAYS THE SHEET IS GONE, as Goal Seek does.
/// A trial's failed write (`WHATIF_SHEET_GONE`) became `None` -- "the
/// objective is no number" -- and the answer's write discarded its error, so
/// the run reported an ordinary stop or "no feasible solution".
///
/// SABOTAGE: in `solver_solve_impl`, drop the `model.failed` refusal and
/// ignore `write_answer`'s error (the pre-fix shape).
#[test]
fn a_solver_run_whose_sheet_is_deleted_mid_run_reports_the_sheet_gone() {
    let wb = Wb::new();
    wb.switch_to(1);
    wb.set(0, 0, "0"); // Sheet2!A1, the variable
    wb.set(0, 2, "=(A1-3)^2"); // Sheet2!C1, the objective
    let sheet2 = wb.id_at(1);
    let timeline = crate::timeline_slicer::TimelineSlicerState::new();

    let (result, deleted) = std::thread::scope(|scope| {
        let wbr = &wb;
        let timeline = &timeline;
        let deleter = scope.spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            while std::time::Instant::now() < deadline {
                let trial_written = {
                    let grids = wbr.state.grids.read().unwrap();
                    grids.len() == 2 && grids[1].get_cell(0, 0).is_some_and(|c| c.value != CellValue::Number(0.0))
                };
                if trial_written {
                    crate::sheets::delete_sheet_impl(
                        &wbr.state,
                        &wbr.file,
                        &wbr.pivots,
                        &wbr.files,
                        &wbr.pane,
                        &wbr.filters,
                        &wbr.slicer,
                        timeline,
                        1,
                        false,
                        Some(sheet2),
                    )
                    .expect("delete Sheet2 mid-run");
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_micros(200));
            }
            false
        });
        let r = crate::solver::solver_solve_impl(
            &wb.state,
            &wb.file,
            &wb.states(),
            SolverParams {
                sheet_index: 1,
                objective_row: 0,
                objective_col: 2,
                objective: SolverObjective::Minimize,
                target_value: None,
                variable_cells: vec![SolverVariableCell { row: 0, col: 0 }],
                constraints: Vec::new(),
                method: SolverMethod::GrgNonlinear,
                // Tolerance 0 and a huge limit: the run lasts until the sheet goes.
                max_iterations: 2_000_000,
                max_time: 100,
                tolerance: 0.0,
            },
        );
        (r, deleter.join().unwrap())
    });
    assert!(deleted, "precondition: Sheet2 was deleted while Solver ran");
    assert_eq!(
        result.error.as_deref(),
        Some(crate::whatif_recalc::WHATIF_SHEET_GONE),
        "a Solver run whose sheet was deleted reported {:?} ({:?})",
        result.error,
        result.status_message
    );
    assert!(result.original_values.is_empty(), "a run on a deleted sheet offers nothing to restore");
    assert_eq!(wb.value(0, 0, 0), CellValue::Empty, "Sheet1 (now index 0) received a trial");
}

/// SOLVER'S RESTORE NAMES ITS SHEET BY STABLE ID. The result dialog stays open
/// while the user can drag a tab; Restore Original Values sent the run's sheet
/// INDEX, so after a move it wrote the original values onto whichever sheet
/// held that position now. The run answers its sheet's id and Restore follows
/// it; a sheet deleted meanwhile is refused and nothing is written.
///
/// SABOTAGE: resolve `solver_revert_impl`'s sheet by the run's old index
/// (`RunSheet::at(state, 1)`) instead of the id it is given.
#[test]
fn solvers_restore_follows_its_sheet_by_stable_id() {
    let wb = Wb::new();
    wb.set(0, 0, "7"); // Sheet1!A1, at the variable's address
    wb.set_on(1, 0, 0, "0"); // Sheet2!A1, the variable
    wb.set_on(1, 0, 2, "=(A1-3)^2"); // Sheet2!C1, the objective
    wb.set_on(1, 0, 3, "=A1+100"); // Sheet2!D1, a reader
    let sheet2 = wb.id_at(1);
    let timeline = crate::timeline_slicer::TimelineSlicerState::new();

    let r = crate::solver::solver_solve_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        SolverParams {
            sheet_index: 1,
            objective_row: 0,
            objective_col: 2,
            objective: SolverObjective::Minimize,
            target_value: None,
            variable_cells: vec![SolverVariableCell { row: 0, col: 0 }],
            constraints: Vec::new(),
            method: SolverMethod::GrgNonlinear,
            max_iterations: 500,
            max_time: 100,
            tolerance: 1e-9,
        },
    );
    assert!(r.error.is_none(), "solver: {:?}", r.error);
    assert_eq!(r.sheet_id, Some(sheet2), "the run names its sheet by stable id");
    assert!(close(wb.number(1, 0, 0), 3.0, 0.05), "precondition: Sheet2!A1 solved");

    // The dialog is open; the user drags Sheet2 in front of Sheet1.
    crate::sheets::move_sheet_impl(&wb.state, &wb.file, &wb.slicer, &timeline, &wb.filters, 1, 0)
        .expect("move Sheet2 to the front");
    assert_eq!(wb.index_of(sheet2), 0, "precondition: Sheet2 is first now");

    let back = crate::solver::solver_revert_impl(&wb.state, &wb.file, &wb.states(), sheet2, r.original_values.clone());
    assert!(back.error.is_none(), "restore: {:?}", back.error);
    assert_eq!(wb.number(0, 0, 0), 0.0, "Sheet2!A1 (now index 0) restored to its original value");
    assert_eq!(wb.number(0, 0, 3), 100.0, "Sheet2!D1 = A1+100 recalculated with it");
    assert_eq!(wb.number(1, 0, 0), 7.0, "Sheet1!A1 (now index 1) was overwritten by the Restore");

    // A sheet deleted while the dialog was open: refused, nothing written.
    let gone = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let refused = crate::solver::solver_revert_impl(&wb.state, &wb.file, &wb.states(), gone, r.original_values);
    assert_eq!(refused.error.as_deref(), Some(crate::whatif_recalc::WHATIF_SHEET_GONE));
    assert_eq!(wb.number(1, 0, 0), 7.0, "a refused Restore wrote nothing");
}

// ---------------------------------------------------------------------------
// Round 18 (whatif5): what a whole run leaves under manual calculation,
// decided by live Excel (scratchpad whatif5/probe1..3.ps1, 2026-10-31).
// ---------------------------------------------------------------------------

impl Wb {
    /// Write a constant behind the history's back and mark every sheet as a
    /// manual-calculation edit marks it: its readers are stale, and no undo
    /// step lands on top of a run's own step.
    fn stale_write(&self, sheet: usize, row: u32, col: u32, value: f64) {
        let clean = crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::LoadingFromDisk,
        );
        let active = *self.state.active_sheet.read().unwrap();
        let mut grid = self.state.grid.write(&clean).unwrap();
        let mut grids = self.state.grids.write(&clean).unwrap();
        if sheet == active {
            grid.set_cell(row, col, engine::Cell::new_number(value));
        }
        grids[sheet].set_cell(row, col, engine::Cell::new_number(value));
        grid.call_memo().note_values_may_be_stale();
        for g in grids.iter() {
            g.call_memo().note_values_may_be_stale();
        }
    }
}

/// SOLVER UNDER MANUAL CALCULATION ENDS WITH THE WHOLE WORKBOOK CALCULATED, kept
/// or restored, on a BACKGROUND sheet too. Excel [LIVE, 2026-10-31, Solver
/// add-in over COM]: `SolverSolve` + `SolverFinish KeepFinal:=1` and
/// `KeepFinal:=2` (Restore Original Values) each recalculate stale cells that
/// never read the variable cells, on every sheet, and leave CalculationState
/// xlDone. Calcula kept them stale and the workbook "pending".
///
/// SABOTAGE: make `whatif_recalc::calculate_workbook_at_run_end` return at once.
#[test]
fn solver_under_manual_calculation_ends_calculated_when_kept_and_when_restored() {
    let wb = Wb::new();
    wb.set_on(1, 0, 0, "0"); // Sheet2!A1, the variable
    wb.set_on(1, 0, 2, "=(A1-3)^2"); // Sheet2!C1, the objective
    wb.set_on(1, 0, 3, "1"); // Sheet2!D1
    wb.set_on(1, 0, 4, "=D1*3"); // Sheet2!E1, unrelated, on the run's sheet
    wb.set(5, 0, "1"); // Sheet1!A6
    wb.set(5, 1, "=A6*2"); // Sheet1!B6, unrelated, on the ACTIVE sheet
    wb.manual();
    wb.set_on(1, 0, 3, "4"); // Sheet2!E1 stale at 3
    wb.set(5, 0, "5"); // Sheet1!B6 stale at 2
    assert_eq!(wb.number(1, 0, 4), 3.0, "precondition: Sheet2!E1 stale");
    assert_eq!(wb.number(0, 5, 1), 2.0, "precondition: Sheet1!B6 stale");
    assert_eq!(*wb.state.active_sheet.read().unwrap(), 0, "precondition: Sheet1 active, the run's sheet is background");
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "pending", "precondition: pending");

    let r = crate::solver::solver_solve_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        SolverParams {
            sheet_index: 1,
            objective_row: 0,
            objective_col: 2,
            objective: SolverObjective::Minimize,
            target_value: None,
            variable_cells: vec![SolverVariableCell { row: 0, col: 0 }],
            constraints: Vec::new(),
            method: SolverMethod::GrgNonlinear,
            max_iterations: 500,
            max_time: 100,
            tolerance: 1e-9,
        },
    );
    assert!(r.error.is_none(), "solver: {:?}", r.error);
    assert!(close(wb.number(1, 0, 0), 3.0, 0.05), "precondition: Sheet2!A1 solved");
    assert_eq!(wb.number(1, 0, 4), 12.0, "Sheet2!E1 is calculated at the end of the run (Excel)");
    assert_eq!(wb.number(0, 5, 1), 10.0, "Sheet1!B6 is calculated at the end of the run (Excel)");
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "done", "xlDone after the run");
    assert!(
        r.updated_cells.iter().any(|c| (c.row, c.col) == (5, 1) && c.sheet_index.unwrap_or(0) == 0),
        "the reply repaints Sheet1!B6"
    );

    // Restore Original Values, with both cells left stale again first.
    wb.stale_write(1, 0, 3, 6.0);
    wb.stale_write(0, 5, 0, 8.0);
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "pending", "precondition: pending again");
    let sheet2 = r.sheet_id.expect("the run's sheet id");
    let back = crate::solver::solver_revert_impl(&wb.state, &wb.file, &wb.states(), sheet2, r.original_values.clone());
    assert!(back.error.is_none(), "restore: {:?}", back.error);
    assert_eq!(wb.number(1, 0, 0), 0.0, "Sheet2!A1 restored");
    assert_eq!(wb.number(1, 0, 2), 9.0, "Sheet2!C1 = (0-3)^2 with it");
    assert_eq!(wb.number(1, 0, 4), 18.0, "Sheet2!E1 is calculated by the Restore too (Excel)");
    assert_eq!(wb.number(0, 5, 1), 16.0, "Sheet1!B6 is calculated by the Restore too (Excel)");
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "done", "xlDone after the Restore");
}

/// A DATA TABLE UNDER MANUAL CALCULATION RECALCULATES NOTHING ELSE. Excel [LIVE,
/// 2026-10-31]: `Range.Table` under manual calculation leaves an unrelated stale
/// cell stale and CalculationState xlPending (its own body shows 0 until F9 --
/// Calcula fills the body, see the round-18 report). So the data-table routes
/// do not take Goal Seek's and Solver's end-of-run workbook pass.
///
/// SABOTAGE: run the workbook pass at the end of `data_table_one_var_impl`.
#[test]
fn a_data_table_under_manual_calculation_leaves_unrelated_stale_cells_stale() {
    let wb = Wb::new();
    wb.set(9, 0, "1"); // A10, the input cell
    wb.set(9, 1, "=A10*2"); // B10
    wb.set(9, 4, "=B10"); // E10, the table's formula
    wb.set(10, 3, "5"); // D11
    wb.set(11, 3, "7"); // D12
    wb.set(5, 0, "1"); // A6
    wb.set(5, 1, "=A6*2"); // B6, unrelated
    wb.manual();
    wb.set(5, 0, "5"); // B6 stale at 2

    let r = crate::data_tables::data_table_one_var_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        DataTableOneVarParams {
            sheet_index: 0,
            start_row: 9,
            start_col: 3,
            end_row: 11,
            end_col: 4,
            row_input_row: None,
            row_input_col: None,
            col_input_row: Some(9),
            col_input_col: Some(0),
        },
    );
    assert!(r.error.is_none(), "data table: {:?}", r.error);
    assert_eq!(wb.number(0, 9, 0), 1.0, "A10 restored");
    assert_eq!(wb.number(0, 5, 1), 2.0, "B6, unrelated, stays stale after a data table (Excel)");
    assert_eq!(
        crate::calculation::calculation_state_impl(&wb.state),
        "pending",
        "a data table under manual leaves the workbook pending (Excel)"
    );
}
