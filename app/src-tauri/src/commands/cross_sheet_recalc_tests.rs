//! FILENAME: app/src-tauri/src/commands/cross_sheet_recalc_tests.rs
//! PURPOSE: BUG-0019 — cross-sheet recalculation on the EDIT path.
//!
//! A child module of `commands::data` (declared with `#[path]` there), so it
//! reaches `update_cell_impl` and `cascade_cross_sheet_dependents`, both
//! private to that module. Both take plain `&State`-free references, so the
//! real edit path runs in-process with no Tauri runtime.
//!
//! THE DEFECT THESE PIN. `Sheet1!C9 = SUM(C4:C8)` and `Sheet2!B3 = Sheet1!C9`.
//! Editing `Sheet1!C5` recalculated `C9` and stopped: `Sheet2!B3` kept the old
//! total, and `Sheet2!B4 = B2-B3` kept the old balance. The FIRST-order case
//! (edit the referenced cell itself) always worked, which is why this survived
//! — every obvious cross-sheet test passes against the broken code. Two
//! independent causes, one per hop:
//!
//!   1. the walk's roots were only the cells the caller EDITED, never the ones
//!      the caller RECALCULATED, so `C9`'s cross-sheet dependents were never
//!      looked up (hop 1: `Sheet2!B3`);
//!   2. the walk expanded a non-active sheet's same-sheet dependents through
//!      the ACTIVE sheet's dependency map — a map with no sheet dimension that
//!      describes Sheet1 only (hop 2: `Sheet2!B4`).
//!
//! The load path was always right because it re-evaluates every formula on a
//! sheet in topological order (`recalculate_sheet_values`) instead of following
//! edges; `agrees_with_the_whole_sheet_recalculation` pins the two against each
//! other, which is the oracle that would have caught this on day one.

use super::*;
use crate::persistence::{FileState, UserFilesState};
use crate::pivot::types::PivotState;
use crate::slicer::SlicerState;
use engine::CellValue;
use std::collections::{HashMap, HashSet};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Workbook {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    slicer: SlicerState,
    pivots: PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
}

impl Workbook {
    /// `sheets` sheets named Sheet1..SheetN, sheet 0 active.
    fn new(sheets: usize) -> Self {
        assert!(sheets >= 1);
        let state = crate::create_app_state();
        for i in 1..sheets {
            state.grids.lock().unwrap().push(engine::Grid::new());
            state.sheet_names.lock().unwrap().push(format!("Sheet{}", i + 1));
            state.all_column_widths.lock().unwrap().push(HashMap::new());
            state.all_row_heights.lock().unwrap().push(HashMap::new());
            state.all_user_hidden_rows.lock().unwrap().push(HashSet::new());
            state.all_user_hidden_cols.lock().unwrap().push(HashSet::new());
            state
                .sheet_ids
                .lock()
                .unwrap()
                .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        }
        {
            let mut all = state.all_merged_regions.lock().unwrap();
            while all.len() < sheets {
                all.push(HashSet::new());
            }
        }
        Workbook {
            state,
            file: FileState::default(),
            files: UserFilesState::default(),
            slicer: SlicerState::new(),
            pivots: PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
        }
    }

    /// One edit through the REAL single-cell edit path.
    fn set(&self, row: u32, col: u32, value: &str) -> UpdateCellResult {
        update_cell_impl(
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
        .unwrap_or_else(|e| panic!("update_cell({},{}) failed: {}", row, col, e))
    }

    /// The recalculation-relevant half of `set_active_sheet` (which needs a
    /// `State<AppState>` and so cannot be called here): swap the active-sheet
    /// mirror, then rebuild the sheet-less dependency maps for the new sheet.
    /// That rebuild is BUG-0016's fix and is exactly what makes the cross-sheet
    /// maps the only surviving description of the sheets you left.
    fn switch_to(&self, index: usize) {
        {
            let mut grids = self.state.grids.lock().unwrap();
            let mut active = self.state.active_sheet.lock().unwrap();
            let mut mirror = self.state.grid.lock().unwrap();
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

    fn value(&self, sheet: usize, row: u32, col: u32) -> CellValue {
        self.state.grids.lock().unwrap()[sheet]
            .get_cell(row, col)
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    }

    fn number(&self, sheet: usize, row: u32, col: u32) -> f64 {
        match self.value(sheet, row, col) {
            CellValue::Number(n) => n,
            other => panic!(
                "sheet {} ({},{}) is {:?}, expected a number",
                sheet, row, col, other
            ),
        }
    }

    /// Reproduce exactly what `sort_range` does to the grid: move whole `Cell`
    /// structs to new positions in BOTH the active-sheet mirror and `grids`,
    /// touching nothing else — no dependency update, no recalculation.
    ///
    /// `sort_range` is a `#[tauri::command]` taking `State`, so it cannot run
    /// in-process here; this reproduces its WRITE, and
    /// `sort_range_recalculates_the_range_it_rewrote` pins from source that it
    /// still calls the recalculation afterwards.
    fn permute_active(&self, moves: &[((u32, u32), (u32, u32))]) {
        let mut grid = self.state.grid.lock().unwrap();
        let mut grids = self.state.grids.lock().unwrap();
        let active = *self.state.active_sheet.lock().unwrap();
        // Read every source cell BEFORE writing any destination, so a
        // permutation cannot read a cell another move already overwrote.
        let landed: Vec<((u32, u32), Option<engine::Cell>)> = moves
            .iter()
            .map(|&(from, to)| (to, grid.get_cell(from.0, from.1).cloned()))
            .collect();
        for ((row, col), cell) in landed {
            match cell {
                Some(cell) => {
                    grid.set_cell(row, col, cell.clone());
                    grids[active].set_cell(row, col, cell);
                }
                None => {
                    grid.cells.remove(&(row, col));
                    grids[active].cells.remove(&(row, col));
                }
            }
        }
    }

    /// The recalculation `sort_range` runs after its permutation.
    fn recalc_bulk(&self, seeds: &[(u32, u32)]) -> Vec<CellData> {
        let mut updated = Vec::new();
        recalc_after_active_sheet_bulk_rewrite(
            &self.state,
            &self.files,
            &self.pane,
            &self.filters,
            seeds,
            &mut updated,
        );
        updated
    }

    /// The LOAD path: re-evaluate every formula on every sheet from scratch,
    /// in topological order, ignoring the dependency edges entirely.
    fn recalculate_every_sheet(&self) {
        let sheets = self.state.sheet_names.lock().unwrap().len();
        for idx in 0..sheets {
            crate::calculation::recalculate_sheet_values(
                &self.state,
                &self.files,
                &self.pivots,
                idx,
                None,
            );
        }
    }
}

/// The budget-model workbook from `app/e2e/scenarios/budget-model.scenario.ts`,
/// phases 1/3/4 — the scenario that found BUG-0019, built through the same
/// gestures: fill Sheet1, add Sheet2 and write its cross-sheet formulas there,
/// switch back to Sheet1.
fn budget_workbook() -> Workbook {
    let wb = Workbook::new(2);
    // Sheet1 B4:B8 (budget) and C4:C8 (actual), rows 3..7, cols 1..2.
    let budget = [12000.0, 6000.0, 2500.0, 1800.0, 5000.0];
    let actual = [12000.0, 6450.0, 2100.0, 1750.0, 5000.0];
    for (i, (b, a)) in budget.iter().zip(actual.iter()).enumerate() {
        let row = 3 + i as u32;
        wb.set(row, 1, &b.to_string());
        wb.set(row, 2, &a.to_string());
    }
    wb.set(8, 1, "=SUM(B4:B8)");
    wb.set(8, 2, "=SUM(C4:C8)");
    assert_eq!(wb.number(0, 8, 1), 27300.0);
    assert_eq!(wb.number(0, 8, 2), 27300.0);

    // The summary sheet, authored while Sheet2 is active (as the user does).
    wb.switch_to(1);
    wb.set(1, 1, "=Sheet1!B9"); // B2 = total budget
    wb.set(2, 1, "=Sheet1!C9"); // B3 = total actual
    wb.set(3, 1, "=B2-B3"); // B4 = balance
    assert_eq!(wb.number(1, 1, 1), 27300.0);
    assert_eq!(wb.number(1, 3, 1), 0.0);

    wb.switch_to(0);
    wb
}

// ---------------------------------------------------------------------------
// BUG-0019 — the repro, hop by hop
// ---------------------------------------------------------------------------

#[test]
fn second_order_cross_sheet_chain_recalculates_in_memory() {
    let wb = budget_workbook();

    // Food actuals go up by 500. C9 is a same-sheet dependent of C5;
    // Sheet2!B3 is a cross-sheet dependent of C9; Sheet2!B4 of B3.
    wb.set(4, 2, "6950");

    assert_eq!(wb.number(0, 8, 2), 27800.0, "Sheet1!C9 (first-order, same sheet)");
    assert_eq!(
        wb.number(1, 2, 1),
        27800.0,
        "Sheet2!B3 = Sheet1!C9 — the cross-sheet dependent of a cell that changed \
         as a DEPENDENT, not as the edit itself (BUG-0019 hop 1)"
    );
    assert_eq!(
        wb.number(1, 3, 1),
        -500.0,
        "Sheet2!B4 = B2-B3 — a same-sheet dependent on the NON-ACTIVE sheet, \
         which has to be resolved against Sheet2's own graph (BUG-0019 hop 2)"
    );
}

#[test]
fn the_edit_reports_the_off_sheet_cells_it_changed() {
    // Correct values in `grids` are not enough: the frontend only repaints and
    // re-caches what the command returns, and off-sheet cells must carry their
    // own sheet index (same-sheet cells carry None).
    let wb = budget_workbook();
    let result = wb.set(4, 2, "6950");

    let off_sheet: Vec<(u32, u32)> = result
        .cells
        .iter()
        .filter(|c| c.sheet_index == Some(1))
        .map(|c| (c.row, c.col))
        .collect();
    assert!(
        off_sheet.contains(&(2, 1)),
        "Sheet2!B3 missing from the reported cells: {:?}",
        off_sheet
    );
    assert!(
        off_sheet.contains(&(3, 1)),
        "Sheet2!B4 missing from the reported cells: {:?}",
        off_sheet
    );
}

#[test]
fn agrees_with_the_whole_sheet_recalculation() {
    // THE ORACLE THAT DEFINES THE BUG. Whatever the incremental edit path
    // produces must equal what a from-scratch recalculation of every sheet
    // produces. Before the fix, saving and reloading "corrected" the numbers —
    // proof the formulas and the persisted state were right and the in-memory
    // traversal was wrong.
    let wb = budget_workbook();
    wb.set(4, 2, "6950");

    let incremental: Vec<CellValue> = (0..2)
        .flat_map(|s| (0..10).map(move |r| (s, r)))
        .map(|(s, r)| wb.value(s, r, 1))
        .collect();
    let incremental_c: Vec<CellValue> = (0..10).map(|r| wb.value(0, r, 2)).collect();

    wb.recalculate_every_sheet();

    let reloaded: Vec<CellValue> = (0..2)
        .flat_map(|s| (0..10).map(move |r| (s, r)))
        .map(|(s, r)| wb.value(s, r, 1))
        .collect();
    let reloaded_c: Vec<CellValue> = (0..10).map(|r| wb.value(0, r, 2)).collect();

    assert_eq!(incremental, reloaded, "column B drifted from the load path");
    assert_eq!(incremental_c, reloaded_c, "column C drifted from the load path");
}

// ---------------------------------------------------------------------------
// The boundary: which hop was actually broken
// ---------------------------------------------------------------------------

#[test]
fn first_order_cross_sheet_dependent_recalculates() {
    // The case that ALWAYS worked, kept so a future rewrite cannot lose it
    // while "fixing" the second-order one.
    let wb = Workbook::new(2);
    wb.set(0, 0, "5");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1*2");
    assert_eq!(wb.number(1, 0, 0), 10.0);

    wb.switch_to(0);
    wb.set(0, 0, "7");
    assert_eq!(wb.number(1, 0, 0), 14.0);
}

#[test]
fn revisiting_a_sheet_does_not_lose_its_cross_sheet_dependents() {
    // FOUND LIVE ON THE RUNNING APP, 2026-08-07, after BUG-0019 was "fixed".
    //
    // Every cross-sheet test above visits the referencing sheet exactly ONCE
    // — go there, type the formula, come back. A real user opens the summary
    // sheet again to look at it. That second visit rebuilt Sheet2's edges from
    // the AST, and the AST keeps the sheet name AS TYPED while
    // `cascade_cross_sheet_dependents` looks a cell up under the workbook's
    // official name. The keys stopped matching and cross-sheet recalculation
    // stopped entirely — silently, for the rest of the session, with the
    // summary sheet showing stale numbers.
    //
    // The formula is deliberately written in a DIFFERENT case from the sheet's
    // real name, because that is the whole mechanism: identical spelling would
    // pass against the broken code.
    let wb = Workbook::new(2);
    wb.set(0, 0, "100");
    wb.set(1, 0, "=A1*2");

    wb.switch_to(1);
    wb.set(0, 0, "=sheet1!A2"); // lower-case s: Sheet1 is the official name
    wb.set(1, 0, "=A1+1");
    assert_eq!(wb.number(1, 0, 0), 200.0, "fixture");
    assert_eq!(wb.number(1, 1, 0), 201.0, "fixture");

    // The user goes back to Sheet1, then returns to Sheet2 to look at it, then
    // returns to Sheet1 to make the edit. THIS is the sequence that broke.
    wb.switch_to(0);
    wb.switch_to(1);
    wb.switch_to(0);

    wb.set(0, 0, "250");
    assert_eq!(wb.number(0, 1, 0), 500.0, "Sheet1!A2, same sheet");
    assert_eq!(
        wb.number(1, 0, 0),
        500.0,
        "Sheet2!A1 must still follow Sheet1 after Sheet2 has been visited twice"
    );
    assert_eq!(
        wb.number(1, 1, 0),
        501.0,
        "and its own dependent must follow it"
    );
}

#[test]
fn a_cross_sheet_reference_registers_under_the_official_sheet_name() {
    // The unit-level statement of the same rule, so a regression names its
    // cause instead of only its symptom. Whatever case the formula is written
    // in, the dependents map must be keyed by the workbook's own spelling —
    // that key is what the cascade looks up.
    let wb = Workbook::new(2);
    wb.set(0, 0, "1");
    wb.switch_to(1);
    wb.set(0, 0, "=SHEET1!A1");

    for label in ["after the edit", "after a rebuild"] {
        let dependents = wb.state.cross_sheet_dependents.lock().unwrap();
        assert!(
            dependents.contains_key(&("Sheet1".to_string(), 0, 0)),
            "{}: no dependent registered under the official name \"Sheet1\" \
             (keys present: {:?})",
            label,
            dependents.keys().collect::<Vec<_>>()
        );
        drop(dependents);
        // The rebuild that runs on every sheet switch must preserve the key.
        crate::undo_commands::rebuild_all_dependencies(&wb.state);
    }
}

#[test]
fn three_sheet_chain_propagates_through_every_hop() {
    let wb = Workbook::new(3);
    wb.set(0, 0, "2");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1*3");
    wb.switch_to(2);
    wb.set(0, 0, "=Sheet2!A1+1");
    assert_eq!(wb.number(2, 0, 0), 7.0);

    wb.switch_to(0);
    wb.set(0, 0, "5");
    assert_eq!(wb.number(1, 0, 0), 15.0, "Sheet2 (hop 1)");
    assert_eq!(wb.number(2, 0, 0), 16.0, "Sheet3 (hop 2, sheet-to-sheet)");
}

#[test]
fn a_chain_that_returns_to_the_active_sheet_updates_the_mirror_too() {
    // Sheet1!A1 -> Sheet2!A1 -> Sheet1!C1. The last hop lands back on the
    // ACTIVE sheet, which has two representations (the `grid` mirror and
    // `grids[active]`); letting them diverge is BUG-0016's failure mode.
    let wb = Workbook::new(2);
    wb.set(0, 0, "2");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1*3");
    wb.switch_to(0);
    wb.set(0, 2, "=Sheet2!A1+1");
    assert_eq!(wb.number(0, 0, 2), 7.0);

    wb.set(0, 0, "5");
    assert_eq!(wb.number(0, 0, 2), 16.0, "grids[0]");
    let mirror = wb
        .state
        .grid
        .lock()
        .unwrap()
        .get_cell(0, 2)
        .map(|c| c.value.clone())
        .unwrap_or(CellValue::Empty);
    assert_eq!(mirror, CellValue::Number(16.0), "active-sheet mirror");
}

// ---------------------------------------------------------------------------
// The non-active sheet's own graph
// ---------------------------------------------------------------------------

#[test]
fn off_sheet_dependents_evaluate_in_dependency_order() {
    // A diamond on the non-active sheet: B3 reads BOTH B1 (fresh) and B2
    // (derived from B1). Expanding dependents in arbitrary order computes B3
    // from a stale B2 and never revisits it, so this is the test that forces a
    // topological expansion rather than a plain breadth-first sweep.
    let wb = Workbook::new(2);
    wb.set(0, 0, "2");
    wb.switch_to(1);
    wb.set(0, 1, "=Sheet1!A1"); // B1
    wb.set(1, 1, "=B1*10"); // B2
    wb.set(2, 1, "=B1+B2"); // B3
    assert_eq!(wb.number(1, 2, 1), 22.0);

    wb.switch_to(0);
    wb.set(0, 0, "3");
    assert_eq!(wb.number(1, 0, 1), 3.0, "B1");
    assert_eq!(wb.number(1, 1, 1), 30.0, "B2");
    assert_eq!(wb.number(1, 2, 1), 33.0, "B3 read a stale B2");
}

#[test]
fn sibling_cross_sheet_dependents_that_feed_each_other_evaluate_in_order() {
    // B1 and B2 are BOTH direct cross-sheet dependents of Sheet1!A1, and B2
    // also reads B1. `cross_sheet_dependents` is a hash SET, so iterating it
    // gives no order: evaluate B2 first and it reads a stale B1, after which
    // the visited-set stops it ever being corrected. Ten runs because a hash
    // set can spell the right order by luck once.
    for _ in 0..10 {
        let wb = Workbook::new(2);
        wb.set(0, 0, "2");
        wb.switch_to(1);
        wb.set(0, 1, "=Sheet1!A1"); // B1
        wb.set(1, 1, "=Sheet1!A1+B1"); // B2 — sibling AND dependent
        assert_eq!(wb.number(1, 1, 1), 4.0);

        wb.switch_to(0);
        wb.set(0, 0, "5");
        assert_eq!(wb.number(1, 0, 1), 5.0, "B1");
        assert_eq!(wb.number(1, 1, 1), 10.0, "B2 read a stale sibling");
    }
}

#[test]
fn off_sheet_whole_column_dependents_recalculate() {
    // Whole-column/row references live in their own stripe maps, which are
    // per-sheet in exactly the same way the cell map is. Missing them would
    // leave a summary sheet's SUM(B:B) stale while its inputs moved.
    let wb = Workbook::new(2);
    wb.set(0, 0, "4");
    wb.switch_to(1);
    wb.set(0, 1, "=Sheet1!A1"); // B1
    wb.set(0, 2, "=SUM(B:B)"); // C1
    assert_eq!(wb.number(1, 0, 2), 4.0);

    wb.switch_to(0);
    wb.set(0, 0, "9");
    assert_eq!(wb.number(1, 0, 1), 9.0, "B1");
    assert_eq!(wb.number(1, 0, 2), 9.0, "C1 = SUM(B:B)");
}

#[test]
fn off_sheet_dependents_of_dependents_chain_within_the_sheet() {
    // Four hops entirely inside the non-active sheet, downstream of one
    // cross-sheet edge.
    let wb = Workbook::new(2);
    wb.set(0, 0, "1");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1+1"); // A1 = 2
    wb.set(1, 0, "=A1+1"); // A2 = 3
    wb.set(2, 0, "=A2+1"); // A3 = 4
    wb.set(3, 0, "=A3+1"); // A4 = 5
    assert_eq!(wb.number(1, 3, 0), 5.0);

    wb.switch_to(0);
    wb.set(0, 0, "10");
    assert_eq!(wb.number(1, 3, 0), 14.0);
}

// ---------------------------------------------------------------------------
// Termination and cycles
// ---------------------------------------------------------------------------

#[test]
fn a_cycle_across_sheets_terminates_without_repeating_a_cell() {
    // Sheet1!A1 = Sheet2!A1 + 1 and Sheet2!A1 = Sheet1!A1 + 1. The walk's
    // `processed` set is the only thing standing between this workbook and an
    // infinite loop, and widening the walk's roots (the BUG-0019 fix) makes
    // more of the graph reachable — so termination has to be asserted, not
    // assumed.
    //
    // KNOWN GAP, deliberately pinned as-is rather than asserted away: a cycle
    // that crosses a sheet boundary is NOT detected as circular anywhere.
    // `partition_formula_cells` runs Kahn's algorithm over ONE sheet's local
    // dependency map, so it sees no cycle here, and the edit path has no
    // cross-sheet cycle check at all — the result below is a plain number
    // whose value depends on evaluation order. Detecting it needs a
    // sheet-dimensioned dependency graph, which this fix deliberately does not
    // introduce. Same before and after; recorded so a future graph rewrite
    // knows this test encodes a gap, not a contract.
    let wb = Workbook::new(2);
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1+1");
    wb.switch_to(0);
    let result = wb.set(0, 0, "=Sheet2!A1+1"); // returns => no infinite loop

    let off_sheet_hits = result
        .cells
        .iter()
        .filter(|c| c.sheet_index == Some(1) && (c.row, c.col) == (0, 0))
        .count();
    assert!(
        off_sheet_hits <= 1,
        "Sheet2!A1 was recalculated {} times — the cycle guard is not holding",
        off_sheet_hits
    );
    assert!(
        matches!(wb.value(0, 0, 0), CellValue::Number(_)),
        "expected the (undetected) cross-sheet cycle to settle on a number, got {:?}",
        wb.value(0, 0, 0)
    );
}

#[test]
fn a_self_referencing_off_sheet_dependent_does_not_loop() {
    let wb = Workbook::new(2);
    wb.set(0, 0, "1");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1");
    wb.set(1, 0, "=A2+A1"); // A2 reads itself
    wb.switch_to(0);
    let _ = wb.set(0, 0, "2"); // must return
    assert_eq!(wb.number(1, 0, 0), 2.0);
}

// ---------------------------------------------------------------------------
// SORT — the entry point that recalculated nothing at all
// ---------------------------------------------------------------------------

/// Sheet1 col A holds a sortable block; a same-sheet formula reads the top of
/// it, and Sheet2 reads that formula (so the cross-sheet walk has a second hop
/// to make).
fn sortable_workbook() -> Workbook {
    let wb = Workbook::new(2);
    // Sheet1 A1:A3 = 3, 1, 2 — deliberately unsorted.
    wb.set(0, 0, "3");
    wb.set(1, 0, "1");
    wb.set(2, 0, "2");
    // B1 reads the TOP of the block: its value depends on the ORDER, which is
    // the whole point — a range aggregate like SUM would survive a permutation
    // and prove nothing.
    wb.set(0, 1, "=A1");
    assert_eq!(wb.number(0, 0, 1), 3.0);

    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!B1"); // Sheet2!A1
    wb.set(1, 0, "=A1*10"); // Sheet2!A2 — second hop, on Sheet2's own graph
    assert_eq!(wb.number(1, 0, 0), 3.0);
    assert_eq!(wb.number(1, 1, 0), 30.0);

    wb.switch_to(0);
    wb
}

#[test]
fn a_sort_recalculates_its_same_sheet_and_cross_sheet_dependents() {
    // THE DEFECT. `sort_range` permuted its range, rebuilt the dependency maps
    // and returned — it re-evaluated NOTHING. `Sheet1!B1 = A1` kept the
    // pre-sort 3 and `Sheet2!A1` kept it too, until some unrelated later edit
    // happened to touch them. The non-active-sheet sibling
    // (`sort_range_off_sheet`) always recalculated, so sorting a sheet you were
    // NOT looking at was right while sorting the one in front of you was not.
    let wb = sortable_workbook();

    // Ascending sort of A1:A3 (3,1,2) -> (1,2,3).
    wb.permute_active(&[((1, 0), (0, 0)), ((2, 0), (1, 0)), ((0, 0), (2, 0))]);

    // The permutation ALONE — which is all `sort_range` used to do. Pinning the
    // stale values here is what makes the assertions below meaningful: without
    // it this test would still pass if the recalculation became a no-op and the
    // values happened to be right already.
    assert_eq!(
        wb.number(0, 0, 1),
        3.0,
        "precondition: the permutation alone leaves B1 stale"
    );
    assert_eq!(
        wb.number(1, 0, 0),
        3.0,
        "precondition: the permutation alone leaves Sheet2!A1 stale"
    );

    let seeds = [(0, 0), (1, 0), (2, 0)];
    wb.recalc_bulk(&seeds);

    assert_eq!(wb.number(0, 0, 0), 1.0, "the permutation itself");
    assert_eq!(
        wb.number(0, 0, 1),
        1.0,
        "Sheet1!B1 = A1 — the sorted range's own same-sheet dependent"
    );
    assert_eq!(
        wb.number(1, 0, 0),
        1.0,
        "Sheet2!A1 = Sheet1!B1 — a cross-sheet dependent of a cell that changed \
         as a DEPENDENT of the sort, not as a sorted cell (BUG-0019 hop 1)"
    );
    assert_eq!(
        wb.number(1, 1, 0),
        10.0,
        "Sheet2!A2 = A1*10 — resolved against Sheet2's OWN graph (hop 2)"
    );
}

#[test]
fn a_sort_reports_every_cell_it_recalculated() {
    // Correct values in `grids` are not enough: `sort_range` returns
    // `updatedCells` and the frontend repaints only what it is told about, so a
    // recalculated dependent that is not reported stays stale ON SCREEN.
    let wb = sortable_workbook();
    wb.permute_active(&[((1, 0), (0, 0)), ((2, 0), (1, 0)), ((0, 0), (2, 0))]);
    let updated = wb.recalc_bulk(&[(0, 0), (1, 0), (2, 0)]);

    assert!(
        updated
            .iter()
            .any(|c| c.sheet_index.is_none() && (c.row, c.col) == (0, 1)),
        "Sheet1!B1 recalculated but never reported: {:?}",
        updated
            .iter()
            .map(|c| (c.sheet_index, c.row, c.col))
            .collect::<Vec<_>>()
    );
    assert!(
        updated
            .iter()
            .any(|c| c.sheet_index == Some(1) && (c.row, c.col) == (0, 0)),
        "Sheet2!A1 recalculated but never reported"
    );
}

#[test]
fn a_sort_agrees_with_the_whole_sheet_recalculation() {
    // The same oracle that would have caught BUG-0019 on day one, applied to
    // the sort path: the incremental answer must equal the load path's.
    let wb = sortable_workbook();
    wb.permute_active(&[((1, 0), (0, 0)), ((2, 0), (1, 0)), ((0, 0), (2, 0))]);
    wb.recalc_bulk(&[(0, 0), (1, 0), (2, 0)]);

    let incremental = [
        wb.number(0, 0, 1),
        wb.number(1, 0, 0),
        wb.number(1, 1, 0),
    ];
    wb.recalculate_every_sheet();
    let from_scratch = [
        wb.number(0, 0, 1),
        wb.number(1, 0, 0),
        wb.number(1, 1, 0),
    ];
    assert_eq!(
        incremental, from_scratch,
        "the sort's incremental recalculation disagrees with a full recalculation"
    );
}

#[test]
fn a_sort_that_moved_nothing_recalculates_nothing() {
    // `sorted_count == 0` must stay free: no seeds, no work.
    let wb = sortable_workbook();
    assert!(
        wb.recalc_bulk(&[]).is_empty(),
        "an empty seed set still did work"
    );
}

// ---------------------------------------------------------------------------
// UNDO — what the restore does and does NOT propagate
// ---------------------------------------------------------------------------

/// Pop one undo transaction and apply it through the REAL restore
/// (`undo_commands::apply_changes`, which `undo`/`redo` both delegate to).
fn undo_once(wb: &Workbook) {
    let transaction = wb
        .state
        .undo_stack
        .lock()
        .unwrap()
        .pop_undo()
        .expect("nothing on the undo stack");
    crate::undo_commands::apply_changes(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.slicer,
        &wb.filters,
        &wb.pane,
        transaction,
        true,
    );
}

#[test]
fn undo_restores_the_edited_cell() {
    // The half that works, pinned so the assertion below is unambiguous about
    // WHICH half is broken.
    let wb = budget_workbook();
    wb.set(4, 2, "6950");
    assert_eq!(wb.number(0, 4, 2), 6950.0);

    undo_once(&wb);
    assert_eq!(wb.number(0, 4, 2), 6450.0, "the edited cell is restored");
}

/// KNOWN GAP, pinned rather than asserted away — undo is a value RESTORE, not a
/// recalculation, and only the cells the caller explicitly recorded
/// (`record_cell_change`) are in the transaction. The dependents that the
/// forward cascade re-evaluated were never recorded, and `apply_changes`
/// re-evaluates nothing for a plain cell restore (its only recalc is the
/// whole-sheet pass for `script_grid_cells` / `sheet_merge_regions` /
/// `sheet_structural_snapshot` off-sheet restores).
///
/// So after undoing an edit, EVERY dependent keeps its post-edit value —
/// same-sheet first, so this is not a cross-sheet defect and BUG-0019's fix
/// neither caused it nor could have fixed it. It is recorded here because
/// "undo" is on the list of edit paths a cross-sheet cascade must cover, and
/// the honest answer is that undo does not cascade at all.
///
/// Fixing it means either recording cascade dependents into the transaction or
/// re-cascading from the restored cells after `apply_changes` — a decision with
/// undo-size and correctness trade-offs that belongs to whoever owns undo.
#[test]
fn undo_does_not_recalculate_dependents_pinning_a_known_gap() {
    let wb = budget_workbook();
    wb.set(4, 2, "6950"); // Sheet1!C5

    // The forward cascade did its job, on both sheets.
    assert_eq!(wb.number(0, 8, 2), 27800.0);
    assert_eq!(wb.number(1, 2, 1), 27800.0);

    undo_once(&wb);

    assert_eq!(wb.number(0, 4, 2), 6450.0, "the edited cell IS restored");
    assert_eq!(
        wb.number(0, 8, 2),
        27800.0,
        "KNOWN GAP: Sheet1!C9 keeps its post-edit total — undo restores \
         recorded cells only and re-evaluates nothing. Same-sheet, so this is \
         not a cross-sheet defect. If this assertion starts failing, undo \
         learned to cascade: delete the pin and assert 27300 instead."
    );
    assert_eq!(
        wb.number(1, 2, 1),
        27800.0,
        "KNOWN GAP: and Sheet2!B3 with it"
    );

    // The load path still disagrees with the restored state, which is the
    // cheapest possible statement of the gap.
    wb.recalculate_every_sheet();
    assert_eq!(
        wb.number(0, 8, 2),
        27300.0,
        "a full recalculation DOES produce the pre-edit total, so the values \
         above are stale rather than correct-by-another-route"
    );
}

// ---------------------------------------------------------------------------
// Every edit path uses ONE walk
// ---------------------------------------------------------------------------

#[test]
fn sort_range_recalculates_the_range_it_rewrote() {
    // `a_sort_recalculates_its_same_sheet_and_cross_sheet_dependents` proves the
    // recalculation is correct; this proves `sort_range` still CALLS it. The
    // command takes `State` and cannot run in-process, and the failure mode
    // being guarded is silent (stale values, no error), so the wiring is
    // asserted from source.
    const DATA_RS: &str = include_str!("data.rs");
    let body = body_of(DATA_RS, "sort_range");
    assert!(
        body.contains("recalc_after_active_sheet_bulk_rewrite("),
        "`sort_range` rewrites its range without recalculating any dependent — \
         it rebuilt the dependency maps and returned, so `=A1` beside the range \
         and every off-sheet reader kept their pre-sort values"
    );
}

/// The body of a top-level `fn <name>(` in `source`, up to the next item at
/// column 0.
fn body_of<'a>(source: &'a str, name: &str) -> &'a str {
    let needle = format!("fn {}(", name);
    let start = source
        .find(&needle)
        .unwrap_or_else(|| panic!("no `fn {}(` in data.rs", name));
    let rest = &source[start + needle.len()..];
    let end = rest
        .find("\n#[tauri::command]")
        .into_iter()
        .chain(rest.find("\npub fn "))
        .chain(rest.find("\npub(crate) fn "))
        .chain(rest.find("\nfn "))
        .chain(rest.find("\n#[cfg(test)]"))
        .min()
        .unwrap_or(rest.len());
    &rest[..end]
}

#[test]
fn every_cross_sheet_registration_uses_the_shared_normalizer() {
    // There were FOUR hand-copied `eq_ignore_ascii_case` loops canonicalising
    // the parsed sheet name, and one place that simply forgot — the dependency
    // rebuild — which cost all cross-sheet recalculation the moment a sheet was
    // visited twice. One copy now; this fails if a second appears anywhere.
    const SOURCES: [(&str, &str); 3] = [
        ("commands/data.rs", include_str!("data.rs")),
        ("commands/structure.rs", include_str!("structure.rs")),
        ("undo_commands.rs", include_str!("../undo_commands.rs")),
    ];
    for (name, src) in SOURCES {
        assert!(
            !src.contains("eq_ignore_ascii_case(parsed"),
            "`{}` hand-rolls the cross-sheet name canonicalisation again instead of \
             calling `normalize_cross_sheet_refs` — the copy that drifted WAS the bug",
            name
        );
        assert!(
            src.contains("normalize_cross_sheet_refs("),
            "`{}` registers cross-sheet dependencies without canonicalising the sheet \
             name; the cascade looks them up under the workbook's official spelling",
            name
        );
    }
}

#[test]
fn every_cascade_path_uses_the_shared_cross_sheet_walk() {
    // The batch (paste) and fill paths each carried a hand-copied SUBSET of the
    // walk: seeded from the edited cells only and with no same-sheet expansion
    // off the active sheet. Copies drift — that is how one code path ended up
    // two hops short of another. This fails the moment a third copy appears.
    const DATA_RS: &str = include_str!("data.rs");

    for command in ["update_cell_impl", "update_cells_batch_core", "fill_range"] {
        let body = body_of(DATA_RS, command);
        assert!(
            body.contains("cascade_cross_sheet_dependents("),
            "`{}` recalculates dependents without the shared cross-sheet walk",
            command
        );
        assert!(
            !body.contains("work_queue"),
            "`{}` hand-rolls a cross-sheet work queue again instead of calling \
             `cascade_cross_sheet_dependents` — that duplication WAS BUG-0019",
            command
        );
    }
}
