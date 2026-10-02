//! FILENAME: app/src-tauri/src/undo_savepoint_tests.rs
//! PURPOSE: Owner decision B, follow-up F9 -- a run of an application's macro
//!          that a person started and that FAILS part-way is undone, all or
//!          nothing, like the module runtime. The run marks a savepoint in the
//!          open undo transaction when it starts (`begin_undo_savepoint_core`)
//!          and, if it fails, takes back exactly what was recorded after it
//!          (`roll_back_to_undo_savepoint_core`) through the restore Ctrl+Z uses.
//! CONTEXT: A child module of `undo_commands` (declared with `#[path]` there),
//!          so it reaches the ticket ledger the savepoint is keyed by. Cells
//!          are written the way every cell writer records them: the grid pair
//!          first, then `record_cell_change` with the cell's previous state --
//!          into the open transaction. The restore is the REAL `apply_changes`.

use super::*;
use crate::document_effect::test_seed_effect;
use crate::persistence::FileState;
use engine::CellValue;

struct Wb {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    pivots: PivotState,
    slicers: SlicerState,
    filters: RibbonFilterState,
    pane: PaneControlState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
}

impl Wb {
    fn new() -> Self {
        Wb {
            state: crate::create_app_state(),
            file: FileState::default(),
            files: UserFilesState::default(),
            pivots: PivotState::new(),
            slicers: SlicerState::new(),
            filters: RibbonFilterState::new(),
            pane: PaneControlState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    /// A cell write on the active sheet (0), recorded as every writer records
    /// it: into the open transaction, or as a step of its own when none is.
    fn write(&self, row: u32, col: u32, value: f64) {
        let effect = test_seed_effect();
        let previous = {
            let mut grid = self.state.grid.write(&effect).unwrap();
            let mut grids = self.state.grids.write(&effect).unwrap();
            let previous = grid.get_cell(row, col).cloned();
            grid.set_cell(row, col, engine::Cell::new_number(value));
            grids[0].set_cell(row, col, engine::Cell::new_number(value));
            previous
        };
        self.state.undo_stack.lock().unwrap().record_cell_change(0, row, col, previous);
    }

    /// What the grid holds at (row, col) -- the mirror and the sheet must agree.
    fn value(&self, row: u32, col: u32) -> CellValue {
        let mirror = self.state.grid.read().unwrap().get_cell(row, col).map(|c| c.value.clone());
        let sheet = self.state.grids.read().unwrap()[0].get_cell(row, col).map(|c| c.value.clone());
        assert_eq!(mirror, sheet, "the active-sheet mirror and the sheet disagree at ({row},{col})");
        mirror.unwrap_or(CellValue::Empty)
    }

    fn roll_back(&self, savepoint: UndoSavepoint) -> UndoResult {
        self.roll_back_full(savepoint).result
    }

    /// The whole answer: the restore's result AND the cells it took back.
    fn roll_back_full(&self, savepoint: UndoSavepoint) -> UndoRollback {
        roll_back_to_undo_savepoint_core(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.slicers,
            &self.filters,
            &self.pane,
            &self.timelines,
            savepoint,
        )
    }

    /// Ctrl+Z, through the real restore.
    fn undo(&self) -> UndoResult {
        let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("a step to undo");
        apply_changes(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.slicers,
            &self.filters,
            &self.pane,
            &self.timelines,
            transaction,
            true,
        )
    }

    fn depths(&self) -> (usize, usize) {
        let stack = self.state.undo_stack.lock().unwrap();
        (stack.undo_depth(), stack.redo_depth())
    }

    fn is_open(&self) -> bool {
        self.state.undo_stack.lock().unwrap().has_open_transaction()
    }
}

/// A frontend caller's begin, exactly as the Tauri `begin_undo_transaction`
/// command makes it.
fn caller_begin(state: &AppState, description: &str) -> Option<u64> {
    let description = description.to_string();
    open_or_join_undo_transaction(state, |stack| stack.begin_transaction_from_caller(description))
}

fn n(value: f64) -> CellValue {
    CellValue::Number(value)
}

// ---------------------------------------------------------------------------
// The run opened the step: everything it wrote is taken back
// ---------------------------------------------------------------------------

#[test]
fn a_run_that_throws_after_two_writes_is_taken_back_entirely_and_leaves_no_step() {
    let wb = Wb::new();
    wb.write(0, 0, 5.0); // the user's own earlier edit: a step of its own
    assert_eq!(wb.depths(), (1, 0));

    let begin = begin_undo_savepoint_core(&wb.state, "Run 'Owner B'".to_string());
    let ticket = begin.ticket.expect("nothing was open: the run's begin OPENS the step and is handed its ticket");
    let savepoint = begin.savepoint.expect("an opened step is always nameable");
    assert_eq!(savepoint, UndoSavepoint { transaction: ticket, changes: 0 });

    // The macro writes two cells -- one over the user's value -- and throws.
    wb.write(0, 0, 11.0);
    wb.write(3, 2, 22.0);
    assert_eq!(wb.value(0, 0), n(11.0));
    assert_eq!(wb.value(3, 2), n(22.0));

    // SABOTAGE: make `take_changes_after_undo_savepoint` split off nothing
    // (`split_off(open.changes.len())`) -> the run's cells stay written.
    let result = wb.roll_back(savepoint);
    assert!(result.success, "the rollback was refused: {:?}", result.refusal);
    assert_eq!(wb.value(0, 0), n(5.0), "the cell the run overwrote did not get the user's value back");
    assert_eq!(wb.value(3, 2), CellValue::Empty, "the cell the run created is still there");
    assert!(
        result.updated_cells.len() >= 2,
        "the view was not told which cells came back: {:?}",
        result.updated_cells
    );

    // NO STEP LEFT BEHIND: the user's own edit is still the only step, nothing
    // is redoable, and the run's own (now empty) step closes as nothing.
    assert!(wb.is_open(), "the rollback closed the step its opener still holds");
    assert!(commit_undo_transaction_core(&wb.state, Some(ticket)));
    assert_eq!(wb.depths(), (1, 0), "a taken-back run left an undo or a redo step");
    assert_eq!(
        wb.state.undo_stack.lock().unwrap().undo_description(),
        Some("Edit cell (0, 0)"),
        "the user's own step is no longer on top"
    );
    // ...and that step still undoes the user's edit.
    wb.undo();
    assert_eq!(wb.value(0, 0), CellValue::Empty);
}

#[test]
fn a_run_that_completes_is_one_step_its_opener_commits() {
    // POSITIVE CONTROL for the test above: the same writes, committed -- one step.
    let wb = Wb::new();
    let begin = begin_undo_savepoint_core(&wb.state, "Run 'Owner B'".to_string());
    wb.write(0, 0, 11.0);
    wb.write(3, 2, 22.0);
    assert!(commit_undo_transaction_core(&wb.state, begin.ticket));
    assert_eq!(wb.depths(), (1, 0), "a completed run is not ONE step");
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_description(), Some("Run 'Owner B'"));
    assert_eq!(wb.value(0, 0), n(11.0));
}

// ---------------------------------------------------------------------------
// The run joined a caller's step: only its own changes are taken back
// ---------------------------------------------------------------------------

#[test]
fn a_run_inside_a_command_line_batch_takes_back_only_its_own_changes() {
    let wb = Wb::new();
    // A command-line run of several lines holds ONE step open for all of them.
    let cli = caller_begin(&wb.state, "Command line run").expect("the batch opened");
    wb.write(0, 0, 1.0); // its first line

    let begin = begin_undo_savepoint_core(&wb.state, "Run 'Owner B'".to_string());
    assert_eq!(begin.ticket, None, "a JOINING begin was handed a ticket: it would close the batch's step");
    let savepoint = begin.savepoint.expect("the batch's step carries a ticket, so it is nameable");
    assert_eq!(savepoint, UndoSavepoint { transaction: cli, changes: 1 });
    assert!(
        wb.state.undo_stack.lock().unwrap().open_transaction_absorbed_begin(),
        "the join did not MARK the batch's step shared"
    );

    // The macro (the next line) writes two cells and throws.
    wb.write(0, 0, 2.0);
    wb.write(1, 0, 3.0);

    // SABOTAGE: split at 0 instead of `savepoint.changes` -> the batch's own
    // first line is taken back too (A1 empty instead of 1).
    let result = wb.roll_back(savepoint);
    assert!(result.success, "{:?}", result.refusal);
    assert_eq!(wb.value(0, 0), n(1.0), "the batch's own line was taken back with the run");
    assert_eq!(wb.value(1, 0), CellValue::Empty);
    assert!(wb.is_open(), "the rollback closed the batch's step");

    // The batch commits what it holds: its own line, as ONE step.
    assert!(commit_undo_transaction_core(&wb.state, Some(cli)));
    assert_eq!(wb.depths(), (1, 0));
    wb.undo();
    assert_eq!(wb.value(0, 0), CellValue::Empty, "the batch's step no longer undoes its own line");
}

// ---------------------------------------------------------------------------
// Refusals move nothing
// ---------------------------------------------------------------------------

#[test]
fn a_savepoint_into_a_history_that_ended_is_refused_and_moves_nothing() {
    let wb = Wb::new();
    let begin = begin_undo_savepoint_core(&wb.state, "Run 'Owner B'".to_string());
    let savepoint = begin.savepoint.unwrap();
    wb.write(0, 0, 7.0);
    // A sheet add ENDS the history, the run's step with it (Excel parity).
    crate::sheets::add_sheet_inner(&wb.state, &wb.file, None, ::persistence::SheetKind::Worksheet)
        .expect("add a sheet");
    assert!(!wb.is_open(), "fixture: a sheet add ends the open transaction");
    // Somebody opens the slot again: the savepoint must not reach into it.
    let stranger = caller_begin(&wb.state, "Move chart").expect("opened");
    wb.write(1, 1, 9.0);

    // The stranger's begin was handed a NEW ticket, so the ledger no longer
    // names the run's: refused (the ticket conjunct is pinned on its own below).
    let result = wb.roll_back(savepoint);
    assert!(!result.success);
    assert_eq!(result.refusal.as_deref(), Some(SAVEPOINT_STEP_GONE));
    assert!(result.updated_cells.is_empty());
    assert_eq!(wb.value(1, 1), n(9.0), "a refused rollback reached into a stranger's step");
    assert!(commit_undo_transaction_core(&wb.state, Some(stranger)));
}

#[test]
fn a_savepoint_naming_another_step_is_refused() {
    let wb = Wb::new();
    let begin = begin_undo_savepoint_core(&wb.state, "Run 'Owner B'".to_string());
    let mut savepoint = begin.savepoint.unwrap();
    wb.write(0, 0, 7.0);
    savepoint.transaction += 1000;
    // SABOTAGE: drop the `t.ticket == savepoint.transaction` conjunct -> the
    // forged point is honoured and A1 is taken back.
    let result = wb.roll_back(savepoint);
    assert_eq!(result.refusal.as_deref(), Some(SAVEPOINT_STEP_GONE));
    assert_eq!(wb.value(0, 0), n(7.0));
}

#[test]
fn a_savepoint_past_the_end_of_its_step_is_refused() {
    let wb = Wb::new();
    let begin = begin_undo_savepoint_core(&wb.state, "Run 'Owner B'".to_string());
    let mut savepoint = begin.savepoint.unwrap();
    wb.write(0, 0, 7.0);
    savepoint.changes = 5;
    let result = wb.roll_back(savepoint);
    assert_eq!(result.refusal.as_deref(), Some(SAVEPOINT_PAST_THE_STEP));
    assert_eq!(wb.value(0, 0), n(7.0));
}

#[test]
fn nothing_recorded_after_the_point_is_a_success_that_moves_nothing() {
    let wb = Wb::new();
    let begin = begin_undo_savepoint_core(&wb.state, "Run 'Owner B'".to_string());
    let result = wb.roll_back(begin.savepoint.unwrap());
    assert!(result.success);
    assert_eq!(result.refusal, None);
    assert!(result.updated_cells.is_empty());
    assert!(commit_undo_transaction_core(&wb.state, begin.ticket));
    assert_eq!(wb.depths(), (0, 0));
}

// ---------------------------------------------------------------------------
// The redo stack is left exactly as it was
// ---------------------------------------------------------------------------

#[test]
fn a_rolled_back_run_leaves_the_users_redo_history_alone() {
    let wb = Wb::new();
    wb.write(4, 4, 1.0);
    wb.undo(); // the user's step is now REDOABLE
    let redo_before: Vec<u64> = {
        let mut stack = wb.state.undo_stack.lock().unwrap();
        let top = stack.pop_redo().expect("a redo step");
        let seq = top.seq;
        stack.push_redo(top);
        vec![seq]
    };
    assert_eq!(wb.depths(), (0, 1));

    let begin = begin_undo_savepoint_core(&wb.state, "Run 'Owner B'".to_string());
    wb.write(0, 0, 11.0);
    // SABOTAGE: pass `keep_inverse: true` in the rollback's restore
    // (`roll_back_to_undo_savepoint_core`) -> redo depth 2, and Ctrl+Y would
    // write the failed run's cells back.
    let result = wb.roll_back(begin.savepoint.unwrap());
    assert!(result.success);
    assert!(commit_undo_transaction_core(&wb.state, begin.ticket));
    assert_eq!(wb.depths(), (0, 1), "the taken-back run is redoable, or the user's redo step is gone");
    let mut stack = wb.state.undo_stack.lock().unwrap();
    assert_eq!(stack.pop_redo().map(|t| t.seq), Some(redo_before[0]), "the user's redo step changed");
}

/// THE REDO STACK AT ITS CAP (review of M6b). The rollback used to push its
/// inverse onto the redo stack and take it off again -- and a push at the cap
/// evicts the OLDEST redo step first, so the user lost one redo step for good.
/// The restore now keeps its inverse out of the history altogether.
///
/// SABOTAGE: push the inverse anyway (`keep_inverse: true` in the rollback's
/// `apply_changes_with` call) -> the oldest redo step is gone (or the run is
/// redoable).
#[test]
fn a_rolled_back_run_at_the_redo_cap_evicts_none_of_the_users_redo_steps() {
    let wb = Wb::new();
    let cap = wb.state.undo_stack.lock().unwrap().max_size();
    // The user's redo history, FULL: `cap` steps, each with its own id. They
    // are never redone here, so a marker step is enough.
    {
        let mut stack = wb.state.undo_stack.lock().unwrap();
        for i in 0..cap {
            let mut step = Transaction::new(format!("User step {i}"));
            step.seq = 10_000 + i as u64;
            stack.push_redo(step);
        }
    }
    let redo_seqs = |wb: &Wb| -> Vec<u64> {
        let mut stack = wb.state.undo_stack.lock().unwrap();
        let mut popped = Vec::new();
        while let Some(t) = stack.pop_redo() {
            popped.push(t);
        }
        let seqs = popped.iter().map(|t| t.seq).collect();
        for t in popped.into_iter().rev() {
            stack.push_redo(t);
        }
        seqs
    };
    let before = redo_seqs(&wb);
    assert_eq!(before.len(), cap, "fixture: the redo stack is at its cap");

    let begin = begin_undo_savepoint_core(&wb.state, "Run 'Owner B'".to_string());
    wb.write(0, 0, 11.0);
    let result = wb.roll_back(begin.savepoint.unwrap());
    assert!(result.success, "{:?}", result.refusal);
    assert_eq!(wb.value(0, 0), CellValue::Empty, "the run was not taken back");
    assert!(commit_undo_transaction_core(&wb.state, begin.ticket));

    assert_eq!(redo_seqs(&wb), before, "a rollback changed the user's redo history");
    assert_eq!(wb.depths(), (0, cap));
}

// ---------------------------------------------------------------------------
// One run per step (review of M6b)
// ---------------------------------------------------------------------------

/// TWO GRANTED RUNS NEVER SHARE A STEP. A second savepoint asked for while the
/// first run's step is open used to JOIN it: the first run's rollback then took
/// the second run's writes back too, and its commit closed the step halfway
/// through the second -- which reported success. Now the second savepoint is
/// refused, touching nothing (the first step is not even marked shared), and
/// the first run's rollback takes back exactly its own writes.
///
/// SABOTAGE: drop the `t.by_savepoint` conjunct (or the whole guard) in
/// `begin_undo_savepoint_core` -> B is handed a point inside A's step.
#[test]
fn a_second_savepoint_never_joins_a_step_another_run_holds() {
    let wb = Wb::new();
    let a = begin_undo_savepoint_core(&wb.state, "Run 'A'".to_string());
    let a_ticket = a.ticket.expect("A opened its step");
    wb.write(0, 0, 1.0); // A's write

    let b = begin_undo_savepoint_core(&wb.state, "Run 'B'".to_string());
    assert_eq!(b.savepoint, None, "B was handed a point inside A's step");
    assert_eq!(b.ticket, None);
    assert_eq!(b.refused, Some(SAVEPOINT_STEP_HELD));
    assert!(
        !wb.state.undo_stack.lock().unwrap().open_transaction_absorbed_begin(),
        "the refused savepoint still JOINED A's step (marked it shared)"
    );
    // B never started; A fails: its rollback takes back what was recorded
    // after its point -- its own write, and nothing of B's.
    let rolled = wb.roll_back_full(a.savepoint.unwrap());
    assert!(rolled.result.success);
    assert_eq!(wb.value(0, 0), CellValue::Empty);
    assert!(commit_undo_transaction_core(&wb.state, Some(a_ticket)));

    // A has ended: B's turn now opens a step of its own.
    let b_again = begin_undo_savepoint_core(&wb.state, "Run 'B'".to_string());
    assert!(b_again.ticket.is_some() && b_again.savepoint.is_some(), "{b_again:?}");
    assert_eq!(b_again.refused, None);
    assert!(commit_undo_transaction_core(&wb.state, b_again.ticket));
}

/// POSITIVE CONTROL for the guard: a savepoint still JOINS a step a CALLER
/// opened through the ordinary begin (a command-line batch) -- only a step a
/// savepoint opened is a granted run's.
#[test]
fn a_savepoint_still_joins_a_step_an_ordinary_begin_opened() {
    let wb = Wb::new();
    let cli = caller_begin(&wb.state, "Command line run").expect("opened");
    let joined = begin_undo_savepoint_core(&wb.state, "Run 'A'".to_string());
    assert_eq!(joined.refused, None);
    assert_eq!(joined.savepoint, Some(UndoSavepoint { transaction: cli, changes: 0 }));
    assert!(commit_undo_transaction_core(&wb.state, Some(cli)));
}

// ---------------------------------------------------------------------------
// Which cells came back (review of M6b)
// ---------------------------------------------------------------------------

/// THE ROLLBACK NAMES EXACTLY THE CELLS IT TOOK BACK: those recorded after the
/// point, each once, by true sheet -- not the ones before the point, and not a
/// width (only cells). The page compares them with the run's own writes, so it
/// can tell the person when something ELSE written meanwhile was undone too.
///
/// SABOTAGE: answer an empty `taken_back_cells` -> red.
#[test]
fn the_rollback_names_exactly_the_cells_it_took_back() {
    let wb = Wb::new();
    let cli = caller_begin(&wb.state, "Command line run").expect("opened");
    wb.write(9, 9, 1.0); // before the point: not taken back
    let begin = begin_undo_savepoint_core(&wb.state, "Run 'A'".to_string());
    wb.write(0, 0, 2.0);
    wb.write(3, 2, 3.0);
    wb.write(0, 0, 4.0); // the same cell again: named once
    wb.state.undo_stack.lock().unwrap().record_column_width_change(0, 5, Some(80.0)); // not a cell
    let rolled = wb.roll_back_full(begin.savepoint.unwrap());
    assert!(rolled.result.success, "{:?}", rolled.result.refusal);
    assert_eq!(
        rolled.taken_back_cells,
        vec![UndoCellRef { sheet: 0, row: 0, col: 0 }, UndoCellRef { sheet: 0, row: 3, col: 2 }]
    );
    assert_eq!(
        serde_json::to_value(&rolled).unwrap()["takenBackCells"],
        serde_json::json!([{ "sheet": 0, "row": 0, "col": 0 }, { "sheet": 0, "row": 3, "col": 2 }]),
        "the wire does not carry the cells beside the restore's own fields"
    );
    assert_eq!(serde_json::to_value(&rolled).unwrap()["success"], true, "the restore's fields are not flattened");
    assert!(commit_undo_transaction_core(&wb.state, Some(cli)));
    // A refusal names none.
    let refused = wb.roll_back_full(UndoSavepoint { transaction: cli + 1000, changes: 0 });
    assert!(!refused.result.success);
    assert!(refused.taken_back_cells.is_empty());
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

#[test]
fn the_savepoint_wire_is_camel_case_and_closed() {
    let begin = UndoSavepointBegin {
        ticket: Some(4),
        savepoint: Some(UndoSavepoint { transaction: 4, changes: 2 }),
        refused: None,
    };
    assert_eq!(
        serde_json::to_value(begin).unwrap(),
        serde_json::json!({ "ticket": 4, "savepoint": { "transaction": 4, "changes": 2 } })
    );
    let held = UndoSavepointBegin { ticket: None, savepoint: None, refused: Some(SAVEPOINT_STEP_HELD) };
    assert_eq!(
        serde_json::to_value(held).unwrap(),
        serde_json::json!({ "ticket": null, "savepoint": null, "refused": SAVEPOINT_STEP_HELD })
    );
    let back: UndoSavepoint = serde_json::from_value(serde_json::json!({ "transaction": 4, "changes": 2 })).unwrap();
    assert_eq!(back, UndoSavepoint { transaction: 4, changes: 2 });
    assert!(
        serde_json::from_value::<UndoSavepoint>(serde_json::json!({ "transaction": 4, "changes": 2, "all": true }))
            .is_err(),
        "a savepoint with a field this door did not hand out was accepted"
    );
}

#[test]
fn both_doors_are_registered() {
    let lib = include_str!("lib.rs");
    for name in ["undo_commands::begin_undo_savepoint,", "undo_commands::roll_back_to_undo_savepoint,"] {
        assert!(lib.contains(name), "{name} is not in generate_handler!");
    }
}
