//! FILENAME: app/src-tauri/src/whatif_recalc.rs
//! PURPOSE: The ONE write-and-recalculate step every what-if route takes:
//!          Goal Seek, Solver, Scenario Show / Summary, data tables and the
//!          animation frames (BUG-0613).
//!
//! THE DEFECT THIS CLOSES. Each of those routes wrote its input cells and then
//! re-evaluated "the dependents" itself: the ACTIVE sheet's same-sheet map,
//! walked from the written cell, each formula evaluated through
//! `evaluate_formula_multi_sheet` -- a string parse with NO position (so
//! `ROW()`, implicit intersection and a cube or custom-function cell's
//! preserve answered for nowhere) -- and nothing at all on any other sheet.
//! So `Sheet2!B1 = Sheet1!A1*2` kept its old value after Goal Seek, Solver or
//! Scenario Show changed `Sheet1!A1`; a Goal Seek target or a data table whose
//! formula reached the input through ANOTHER cell (`=B10` with
//! `B10 = Sheet2!B10+100`) read a value no trial ever recalculated, so the
//! table filled with one stale number and Goal Seek saw a flat function; and
//! because the save / F9 pass keeps a stored cube or custom-function value
//! that nothing it reads changed IN THAT PASS, such a stale value was then
//! saved as if it were current.
//!
//! Excel [LIVE, 2026-10-30, Excel 16 over COM]: Goal Seek on
//! `Sheet1!C1 = Sheet2!B1+1` with `Sheet2!B1 = Sheet1!A1*2` finds A1 = 5 and
//! leaves `Sheet2!B1` = 10 and `Sheet2!D1 = Sheet1!C1*10` = 110; Scenario Show
//! of `Sheet1!A5` = 100 leaves `Sheet2!B5 = Sheet1!A5*3` = 300; a data table
//! `=TABLE(,A10)` over `=B10`, `B10 = Sheet2!B10+100`, `Sheet2!B10 =
//! Sheet1!A10*2` fills 110 for input 5 and 114 for 7, with A10 and Sheet2!B10
//! back at 1 and 2 afterwards. Every input change recalculates exactly as if
//! the user had typed the value.
//!
//! So every route now writes through [`write_cells_and_recalc`], which writes
//! the cells and then recalculates through the SHARED cascade -- the same two
//! entry points an ordinary edit ends in (`recalc_after_active_sheet_bulk_rewrite`
//! for the active sheet, `recalc_after_off_sheet_write` for any other; under
//! manual calculation a trial on another sheet takes the seeded
//! `cascade_seeded_on_sheet` instead, see `recalc_background_sheet`) -- with
//! every guard dropped first, because the cascade takes the same grid and
//! dependency mutexes and std mutexes are not reentrant. Because the cascade
//! re-evaluates each dependent at its own cell, a cube or custom-function
//! dependent is answered from the results cache for exactly the arguments it
//! now has, or refused -- never left holding the previous arguments' answer for
//! the full pass's keep rule to vouch for.
//!
//! A TRIAL (one Goal Seek or Solver step, one data-table substitution) is the
//! same write: the route then reads the target cell's STORED value, which the
//! cascade has just recalculated through the real dependency chain, on every
//! sheet. It costs one cascade per trial -- the price of the right answer, and
//! the same thing Excel does. Under MANUAL calculation a Goal Seek or Solver
//! run then ends with ONE workbook pass, so it leaves every sheet calculated as
//! Excel's does (`calculate_workbook_at_run_end`, round 18 [LIVE]).

use std::collections::HashSet;

use crate::api_types::CellData;
use crate::document_effect::DocumentEffect;
use crate::persistence::UserFilesState;
use crate::AppState;
use engine::{Cell, CellValue};

/// The Tauri-managed states the shared cascade needs besides `AppState`. A
/// what-if command takes them as `State<..>` parameters and lends them here, so
/// its body runs without a Tauri runtime in tests.
pub(crate) struct WhatIfStates<'a> {
    pub user_files: &'a UserFilesState,
    pub pivots: &'a crate::pivot::types::PivotState,
    pub pane_control: &'a crate::pane_control::PaneControlState,
    pub ribbon_filter: &'a crate::ribbon_filter::RibbonFilterState,
}

/// Whether a write recalculates under MANUAL calculation.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum RecalcMode {
    /// As a typed value would: recalculated under automatic calculation, left
    /// for F9 under manual, on the active sheet and on any other (Scenario
    /// Show, Scenario Summary, a data table's body). Excel [LIVE, 2026-10-30]:
    /// under manual calculation Scenario Show and Scenario Summary recalculate
    /// nothing -- the summary reports the result cells' stored values.
    AsAnEdit,
    /// Always: the route reads the result back (a Goal Seek or Solver trial, a
    /// data-table substitution, an animation frame), so the cells that depend
    /// on the written ones are recalculated whatever the mode -- the seeded
    /// cascade, never the whole sheet, so ONE TRIAL stays cheap and a value the
    /// user left stale for F9 that does not depend on it is not touched by it.
    /// What a whole Goal Seek or Solver run leaves under manual calculation is
    /// decided once, when it ends ([`calculate_workbook_at_run_end`]): Excel
    /// leaves the whole workbook calculated [LIVE]. A data table and an
    /// animation do not take that step.
    Always,
}

/// Write `writes` onto `sheet` -- `Some(cell)` stores the cell, `None` clears
/// it -- and recalculate every dependent, on every sheet, through the shared
/// cascade. `updated_cells` receives the written cells and every cell the
/// cascade re-evaluated (a cell on a sheet other than the active one carries
/// its `sheet_index`).
///
/// The caller must hold NO `AppState` lock: the write takes `grid` then
/// `grids` (canonical order) and drops them, and the cascade takes everything
/// it needs itself. `effect` is the caller's: `mutates` for a route that
/// changes the document, `transient` for an animation frame. The cascade's own
/// value writes are its recalculation companion's and dirty nothing.
pub(crate) fn write_cells_and_recalc(
    state: &AppState,
    states: &WhatIfStates<'_>,
    effect: &DocumentEffect,
    sheet: usize,
    writes: &[((u32, u32), Option<Cell>)],
    mode: RecalcMode,
    updated_cells: &mut Vec<CellData>,
) -> Result<(), String> {
    match write_cells_and_recalc_on(state, states, effect, &|| Some(sheet), writes, mode, updated_cells)? {
        Some(_) => Ok(()),
        None => Err(format!("Sheet index {} out of range", sheet)),
    }
}

/// [`write_cells_and_recalc`] for a caller that names its sheet by something
/// that can MOVE (an animation snapshot's stable id): `resolve` runs under the
/// grid locks, so the index it returns is the sheet's position at the moment of
/// the write. Returns the sheet written, or `None` -- nothing written -- when
/// `resolve` finds no sheet.
pub(crate) fn write_cells_and_recalc_on(
    state: &AppState,
    states: &WhatIfStates<'_>,
    effect: &DocumentEffect,
    resolve: &dyn Fn() -> Option<usize>,
    writes: &[((u32, u32), Option<Cell>)],
    mode: RecalcMode,
    updated_cells: &mut Vec<CellData>,
) -> Result<Option<usize>, String> {
    // PHASE A: the write, both halves of the mirror, then every guard dropped.
    let (sheet, active_sheet, sheet_id) = {
        let mut grid = state.grid.write(effect).map_err(|e| e.to_string())?;
        let mut grids = state.grids.write(effect).map_err(|e| e.to_string())?;
        let Some(sheet) = resolve() else {
            return Ok(None);
        };
        // Canonical order: grid, grids, sheet_ids, active_sheet.
        let sheet_id = state.sheet_ids.read().map_err(|e| e.to_string())?.get(sheet).copied();
        let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;
        if sheet >= grids.len() {
            return Ok(None);
        }
        if writes.is_empty() {
            return Ok(Some(sheet));
        }
        for ((row, col), cell) in writes {
            match cell {
                Some(cell) => {
                    grids[sheet].set_cell(*row, *col, cell.clone());
                    if sheet == active_sheet {
                        grid.set_cell(*row, *col, cell.clone());
                    }
                }
                None => {
                    grids[sheet].clear_cell(*row, *col);
                    if sheet == active_sheet {
                        grid.clear_cell(*row, *col);
                    }
                }
            }
        }
        // A background sheet is recalculated whole (`recalc_after_off_sheet_write`),
        // which visits only cells that still hold a formula: an ORIGIN this
        // write replaced would keep its spill claim forever (§2y). The active
        // sheet's cascade tears that down from its seeds itself.
        if sheet != active_sheet {
            crate::commands::data::release_spills_orphaned_by_grid(state, sheet, &grids[sheet]);
        }
        (sheet, active_sheet, sheet_id)
    };

    // PHASE B: the shared cascade, holding nothing.
    let automatic = state
        .calculation_mode
        .lock()
        .map(|m| *m == "automatic")
        .unwrap_or(true);
    let mut seeds: Vec<(u32, u32)> = Vec::with_capacity(writes.len());
    let mut seen: HashSet<(u32, u32)> = HashSet::with_capacity(writes.len());
    for ((row, col), _) in writes {
        if seen.insert((*row, *col)) {
            seeds.push((*row, *col));
        }
    }
    let recalculate = automatic || mode == RecalcMode::Always;
    if sheet == active_sheet {
        if recalculate {
            // The SEEDED cascade -- the cells that read the written ones, on
            // every sheet, and nothing else -- whatever the calculation mode. A
            // trial under manual calculation used to run this edit cascade (which
            // stops at the mode) and then two whole-sheet passes over this sheet
            // and every sheet reading it, and format every formula cell of the
            // sheet into a reply the trial threw away: thousands of evaluations
            // per Goal Seek or Solver step on a big model, on the UI thread, and
            // every value the user had left stale for F9 recalculated behind
            // their back.
            //
            // THE SHEET IS CHECKED AGAIN under the cascade's own grid locks:
            // "active" was decided under Phase A's, and a sheet switch while
            // no lock is held (the window stays live during an `(async)` run)
            // made the seeds' coordinates address the newly active sheet --
            // the real target was never recalculated and the trial read a
            // stale value. When another sheet is active now, the written
            // sheet is recalculated as the background sheet it has become.
            let ran = crate::commands::data::cascade_whatever_the_mode(
                state,
                states.user_files,
                states.pane_control,
                states.ribbon_filter,
                sheet_id,
                &seeds,
                updated_cells,
            );
            if !ran {
                if let Some(now) = resolve() {
                    if let Ok(grids) = state.grids.read() {
                        if let Some(g) = grids.get(now) {
                            crate::commands::data::release_spills_orphaned_by_grid(state, now, g);
                        }
                    }
                    recalc_background_sheet(state, states, automatic, resolve, &seeds, updated_cells);
                }
            }
        } else {
            // MANUAL calculation, a write that behaves as a typed value: the edit
            // cascade honours the mode -- it releases a vacated spill origin,
            // which it does before it looks at the mode, and leaves the
            // dependents for F9 [LIVE: Scenario Show under manual calculation
            // leaves `=C1*3` at its old value].
            crate::commands::data::recalc_after_active_sheet_bulk_rewrite(
                state,
                states.user_files,
                states.pane_control,
                states.ribbon_filter,
                &seeds,
                updated_cells,
            );
        }
    } else if recalculate {
        // A background sheet (see `recalc_background_sheet`).
        recalc_background_sheet(state, states, automatic, resolve, &seeds, updated_cells);
    } else {
        // A background sheet under MANUAL calculation, written as a typed value
        // would be: nothing recalculated, exactly as on the active sheet. Excel
        // [LIVE, 2026-10-30]: Scenario Show of a scenario on Sheet2 while
        // Sheet1 is active, under manual calculation, leaves Sheet2's
        // `=A1*2` at its old value. The sheet's values are marked as possibly
        // stale (they already are: entering manual calculation marks every
        // sheet), so a full pass does not vouch for them.
        if let Ok(grids) = state.grids.read() {
            if let Some(g) = grids.get(sheet) {
                g.call_memo().note_values_may_be_stale();
            }
        }
    }

    // The written cells themselves (the cascade reports only what it
    // re-evaluated). A cleared cell is reported blank so a repaint shows it
    // empty instead of keeping the last value. One pass over the reply builds
    // the set of what it already holds, so this is linear in its length. The
    // sheet and the active one as they are NOW (either may have moved since
    // Phase A), so the repaint lands where the cells are.
    let sheet = resolve().unwrap_or(sheet);
    let active_sheet = state.active_sheet.read().map(|a| *a).unwrap_or(active_sheet);
    let reported: HashSet<(u32, u32)> = updated_cells
        .iter()
        .filter(|cd| cd_sheet(cd, active_sheet) == sheet)
        .map(|cd| (cd.row, cd.col))
        .collect();
    for &(row, col) in &seeds {
        if reported.contains(&(row, col)) {
            continue;
        }
        if let Some(cd) = cell_data(state, sheet, active_sheet, row, col) {
            updated_cells.push(cd);
        }
    }
    Ok(Some(sheet))
}

/// Recalculate a write on a sheet that is NOT the active one (or stopped being
/// it between the write and the cascade): every guard is dropped on entry.
///
/// Under AUTOMATIC calculation the sheet and its readers are recalculated whole,
/// as an off-sheet write is (`update_cell_on_sheets`) -- nothing is stale there
/// for that to disturb. Under MANUAL calculation (a trial that reads its result
/// back) it is the SEEDED cascade rooted on that sheet
/// (`cascade_seeded_on_sheet`): the written cells' readers, on every sheet, and
/// nothing else. The whole-sheet pass used to run here too, and freshened every
/// value the user had left stale for F9 on the run's sheet, its readers and the
/// active sheet -- the very thing the active-sheet trial stopped doing.
fn recalc_background_sheet(
    state: &AppState,
    states: &WhatIfStates<'_>,
    automatic: bool,
    resolve: &dyn Fn() -> Option<usize>,
    seeds: &[(u32, u32)],
    updated_cells: &mut Vec<CellData>,
) {
    if automatic {
        if let Some(now) = resolve() {
            crate::commands::data::recalc_after_off_sheet_write(
                state,
                states.user_files,
                states.pivots,
                states.pane_control,
                states.ribbon_filter,
                &[now],
            );
        }
    } else {
        crate::commands::data::cascade_seeded_on_sheet(
            state,
            states.user_files,
            states.pane_control,
            states.ribbon_filter,
            resolve,
            seeds,
            updated_cells,
        );
    }
}

/// THE END OF A GOAL SEEK OR SOLVER RUN: the whole workbook calculated.
///
/// Excel [LIVE, 2026-10-31, Excel 16 over COM, fresh instance per probe, manual
/// calculation, stale `Sheet1!G1 = D1` and `Sheet2!E1 = D1` that read nothing
/// the run touches, CalculationState xlPending before]: every one of these ends
/// with G1 and E1 recalculated and CalculationState xlDone --
/// - Goal Seek that finds its value (`B1 = A1*2` to 10 by A1), from the
///   active sheet and from a background one (`Sheet2!B1.GoalSeek` with Sheet1
///   active), through COM and through the dialog's OK;
/// - Goal Seek that finds NOTHING (`C1 = A1^2+1` to 0);
/// - Goal Seek's status-dialog CANCEL (A1 put back to 1, B1 back to 2);
/// - Solver kept (`SolverFinish KeepFinal:=1`), Solver RESTORED
///   (`KeepFinal:=2`: A1 back to 1, B1 back to 2), and a Solver run that
///   finds no feasible solution.
/// A Data Table created under manual calculation recalculates nothing -- not
/// even its own body, which shows 0 until F9 -- and stays xlPending, so the
/// data-table routes do not call this; nor do an animation frame (no Excel
/// counterpart, CLAUDE.md rule 6) or Scenario Show / Summary (measured to
/// recalculate nothing under manual).
///
/// Each TRIAL stays the seeded cascade (`RecalcMode::Always`), so a run costs
/// one cascade per trial and ONE workbook pass at its end, never a pass per
/// trial. Under automatic calculation nothing is stale, and the pass runs only
/// when a cancelled Calculate Now left a remainder (the workbook is "pending").
///
/// The caller holds NO lock. The pass is Calculate Now's own
/// (`run_calculation_pass_with`, told the document was edited: the run just
/// wrote it), so it vouches for every sheet's values and clears the
/// "calculation incomplete" mark exactly as F9 does; a Cancel raised DURING it
/// leaves F9's honest remainder. A stop aimed at the run's search (Solver's
/// Esc) is over by now and is cleared first, or the pass would end before it
/// began. Every cell it recalculated joins `updated_cells` (the newer value
/// replaces a trial's report of the same cell).
pub(crate) fn calculate_workbook_at_run_end(
    state: &AppState,
    states: &WhatIfStates<'_>,
    updated_cells: &mut Vec<CellData>,
) {
    let manual = state.calculation_mode.lock().map(|m| *m == "manual").unwrap_or(false);
    if !manual && crate::calculation::calculation_state_impl(state) != "pending" {
        return;
    }
    if state.calc_cancel.is_cancelled() {
        state.calc_cancel.reset();
    }
    match crate::calculation::run_calculation_pass_with(
        crate::calculation::CalcScope::Workbook,
        None,
        state,
        states.user_files,
        states.pivots,
        states.pane_control,
        states.ribbon_filter,
        None,
        false,
    ) {
        Ok(recalculated) => {
            let active = state.active_sheet.read().map(|a| *a).unwrap_or(0);
            let fresh: HashSet<(usize, u32, u32)> =
                recalculated.iter().map(|cd| (cd_sheet(cd, active), cd.row, cd.col)).collect();
            updated_cells.retain(|cd| !fresh.contains(&(cd_sheet(cd, active), cd.row, cd.col)));
            updated_cells.extend(recalculated);
        }
        Err(e) => crate::log_warn!("WHATIF", "the workbook pass at the end of the run failed: {}", e),
    }
}

/// Why a what-if command was refused: another run is still writing trials.
pub(crate) const WHATIF_RUN_BUSY: &str =
    "Another what-if analysis (Data Table, Goal Seek, Solver or a scenario) is still running. Wait for it to finish.";

/// Why a what-if command was refused: an animation holds a restore buffer.
///
/// It names WHERE Stop is: a finished animation no longer holds a buffer (the
/// clock restores at the end of the range), and one a reloaded page left behind
/// is restored when the Animation extension starts, so what remains is an
/// animation the user is playing or has paused -- one the transport's Stop
/// ends.
pub(crate) const WHATIF_ANIMATION_LIVE: &str =
    "An animation is playing or paused, and its cells are on loan until it stops. Press Stop on the animation's playback controls (the Animation pane or the status bar), then run the what-if analysis again.";

/// Why an animation could not start: a what-if run is writing trials.
pub(crate) const ANIMATION_WHATIF_BUSY: &str =
    "A what-if analysis (Data Table, Goal Seek, Solver or a scenario) is running. Wait for it to finish, then play the animation.";

/// Why a run stopped: its sheet is gone.
pub(crate) const WHATIF_SHEET_GONE: &str = "The sheet this what-if analysis runs on was deleted while it ran.";

/// THE WHAT-IF SINGLE-FLIGHT, held for one run (`AppState::whatif_run`).
///
/// Data Table, Goal Seek and Solver are `(async)`: each run is many trials,
/// each a write of the borrowed input cell, a recalculation and a read-back,
/// with every lock dropped in between. Two runs therefore OVERLAPPED (Enter
/// twice in the dialog): the second snapshotted the first's trial value as the
/// cell's "original", its trials interleaved with the first's (a table cell
/// could hold the formula's value for the OTHER run's input), and it restored
/// that trial value last -- so the input cell kept a trial value for good, and
/// Goal Seek's Cancel put back a trial. Excel's what-if runs are modal. A run
/// takes this guard FIRST, before any gate, and a second run is refused with
/// [`WHATIF_RUN_BUSY`]; it is released when the guard drops, on every exit
/// path including a panic.
pub(crate) struct WhatIfRun<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for WhatIfRun<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

/// Take the what-if single-flight, or refuse.
///
/// ANIMATION AND SCENARIOS SHARE IT. Scenario Show and Summary take it too (they
/// write the changing cells, and Summary puts them back), and so does an
/// animation's snapshot, for the moment it files its restore buffer
/// ([`claim_whatif_flag`]). A run is ALSO refused while any animation restore
/// buffer is on file ([`WHATIF_ANIMATION_LIVE`]): a playing or paused animation
/// puts its cells back on Stop, so a run that borrowed one of them in between
/// would have its restore overwritten (or overwrite the animation's), the same
/// interleaving the single-flight exists to stop. The flag is claimed BEFORE the
/// buffer check and the snapshot files its buffer while holding it, so the two
/// can never both pass: whichever claims the flag first wins.
pub(crate) fn begin_whatif_run(state: &AppState) -> Result<WhatIfRun<'_>, String> {
    let run = claim_whatif_flag(state).map_err(|_| WHATIF_RUN_BUSY.to_string())?;
    let animation_live = state
        .animation_snapshots
        .lock()
        .map(|snapshots| !snapshots.is_empty())
        .unwrap_or(true);
    if animation_live {
        return Err(WHATIF_ANIMATION_LIVE.to_string());
    }
    Ok(run)
}

/// The bare flag, with no animation check: the animation snapshot holds it
/// while it files a restore buffer (so no run can start in between), and
/// [`begin_whatif_run`] builds on it.
pub(crate) fn claim_whatif_flag(state: &AppState) -> Result<WhatIfRun<'_>, ()> {
    use std::sync::atomic::Ordering;
    state
        .whatif_run
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| WhatIfRun(&state.whatif_run))
        .map_err(|_| ())
}

/// THE SHEET A WHAT-IF RUN WORKS ON, by STABLE ID. A run used to name it by the
/// index it had when the run started, and the window stays live during an
/// `(async)` run: insert a sheet before it, or drag its tab, and later trials,
/// the read-backs and the restore of the borrowed input landed on whatever sheet
/// had that index now. Every trial resolves it again under the grid locks (as an
/// animation frame does). `id` is `None` only for a sheet with no stable id on
/// file, which then keeps its index.
#[derive(Clone, Copy, Debug)]
pub(crate) struct RunSheet {
    id: Option<identity::SheetId>,
    index: usize,
}

impl RunSheet {
    /// The sheet now at `index`. Reads `sheet_ids` alone (a caller holding the
    /// grid locks keeps the canonical order: grid, grids, sheet_ids).
    pub(crate) fn at(state: &AppState, index: usize) -> RunSheet {
        let id = state.sheet_ids.read().ok().and_then(|ids| ids.get(index).copied());
        RunSheet { id, index }
    }

    /// The sheet with this stable id, wherever it is (a caller that was handed
    /// the id, such as Solver's Restore).
    pub(crate) fn with_id(id: identity::SheetId) -> RunSheet {
        RunSheet { id: Some(id), index: usize::MAX }
    }

    /// The sheet's stable id, when it has one.
    pub(crate) fn id(&self) -> Option<identity::SheetId> {
        self.id
    }

    /// Where the sheet is NOW, or `None` when it is gone.
    pub(crate) fn index(&self, state: &AppState) -> Option<usize> {
        match self.id {
            Some(id) => state.sheet_ids.read().ok()?.iter().position(|s| *s == id),
            None => Some(self.index),
        }
    }
}

/// A what-if run's PROTECTION GATE, asked of the very sheet the run will
/// write: the caller holds `grid` and `grids` (its validation section) and
/// resolves `sheet_index` under them, so a tab moved between the gate and the
/// run can no longer gate one sheet and run on another (rev13A: the gates read
/// the sheet by index BEFORE taking the locks the run then used).
///
/// Takes, under the caller's grid guards and in the canonical order after
/// them, `sheet_kinds` (copied and released), `active_sheet`, `style_registry`
/// and `sheet_protection` -- the order `protection::check_sheet_protection_cells`
/// uses. `check` is the pure form (`check_sheet_protection_cells_in` or its
/// range twin); the active sheet is judged on its `grid` mirror, a background
/// sheet on `grids`, as the unheld wrappers do.
pub(crate) fn check_run_protection_held(
    state: &AppState,
    grid: &engine::Grid,
    grids: &[engine::Grid],
    sheet_index: usize,
    check: impl FnOnce(
        &[::persistence::SheetKind],
        &crate::protection::ProtectionStorage,
        &engine::Grid,
        &engine::StyleRegistry,
    ) -> Result<(), String>,
) -> Result<(), String> {
    let kinds = state.sheet_kinds.read().map_err(|e| e.to_string())?.clone();
    let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
    let styles = state.style_registry.read().map_err(|e| e.to_string())?;
    let protection = state.sheet_protection.read().map_err(|e| e.to_string())?;
    let sheet = if sheet_index == active {
        grid
    } else {
        match grids.get(sheet_index) {
            Some(sheet) => sheet,
            // The caller refuses a missing sheet itself, by its own words.
            None => return Ok(()),
        }
    };
    check(&kinds, &protection, sheet, &styles)
}

/// [`write_cells_and_recalc`] on a run's sheet, wherever it is now. Answers the
/// index written, or [`WHATIF_SHEET_GONE`].
pub(crate) fn write_cells_and_recalc_in(
    state: &AppState,
    states: &WhatIfStates<'_>,
    effect: &DocumentEffect,
    sheet: RunSheet,
    writes: &[((u32, u32), Option<Cell>)],
    mode: RecalcMode,
    updated_cells: &mut Vec<CellData>,
) -> Result<usize, String> {
    write_cells_and_recalc_on(state, states, effect, &|| sheet.index(state), writes, mode, updated_cells)?
        .ok_or_else(|| WHATIF_SHEET_GONE.to_string())
}

/// The stored value of a cell on a run's sheet, wherever it is now (`grids`
/// then `sheet_ids`, held together so the pair describes one moment).
pub(crate) fn stored_value_in(state: &AppState, sheet: RunSheet, row: u32, col: u32) -> CellValue {
    let Ok(grids) = state.grids.read() else {
        return CellValue::Empty;
    };
    sheet
        .index(state)
        .and_then(|i| grids.get(i))
        .and_then(|g| g.get_cell(row, col))
        .map(|c| c.value.clone())
        .unwrap_or(CellValue::Empty)
}

/// [`stored_value_in`] as a finite number, or `None`.
pub(crate) fn stored_number_in(state: &AppState, sheet: RunSheet, row: u32, col: u32) -> Option<f64> {
    match stored_value_in(state, sheet, row, col) {
        CellValue::Number(n) if n.is_finite() => Some(n),
        _ => None,
    }
}

/// The cell as it is stored now on a run's sheet (a restore buffer, a style).
pub(crate) fn stored_cell_in(state: &AppState, sheet: RunSheet, row: u32, col: u32) -> Option<Cell> {
    let grids = state.grids.read().ok()?;
    let i = sheet.index(state)?;
    grids.get(i).and_then(|g| g.get_cell(row, col)).cloned()
}

/// THE STORED VALUE OF EVERY FORMULA CELL, on every sheet, named by stable sheet
/// id -- taken before a TRANSIENT run under MANUAL calculation, so its restore
/// can put back exactly what the user was looking at.
///
/// A transient run (an animation) recalculates the cells that depend on its
/// driver for every frame (`RecalcMode::Always`). Under manual calculation some
/// of those may have been STALE before the run -- `A1` changed with no F9, so
/// `B1 = A1*2` still shows the old answer -- and a restore that recalculated
/// them showed the new answer after Stop, which the user never asked for: a
/// transient write must leave the workbook exactly as it was. Excel's own
/// transient what-if (Scenario Summary) recalculates nothing under manual
/// calculation [LIVE, 2026-10-30], so nothing it does is ever visible after it.
///
/// WHAT THE RESTORE MAY TAKE BACK: only what the RUN put there. A run can be
/// paused, and the user works in between: re-typing `B1` from `=A1*2` to
/// `=A1*3` (Enter evaluates it), or pressing F9. The restore used to put the
/// journalled value back on every formula cell whose value differed, so the
/// re-typed `=A1*3` showed the old formula's number and the F9's fresh values
/// went back to the stale ones -- the user's own work undone by Stop. The
/// transient-write rule is "restore what the preview wrote", never "roll the
/// workbook back to a moment": so a cell is restored only while it still holds
/// the FORMULA it had when the run began AND the value the run's last frame
/// LEFT in it (`left`, filled by every frame from the cells it recalculated).
/// A frame that recalculated a background sheet reports no cells (a whole-sheet
/// pass), so such a run falls back to the formula check alone (`whole_sheets`).
#[derive(Debug, Clone, Default)]
pub(crate) struct ValueJournal {
    sheets: Vec<(
        Option<identity::SheetId>,
        std::collections::HashMap<(u32, u32), (Option<Box<parser::ast::Expression>>, CellValue)>,
    )>,
    /// The value the run's last frame left in each cell it recalculated.
    left: std::collections::HashMap<(Option<identity::SheetId>, u32, u32), CellValue>,
    /// A frame recalculated cells it could not report (see above).
    whole_sheets: bool,
}

impl ValueJournal {
    /// Record what one frame left: `left` from [`frame_left_values`], and
    /// whether the frame ran as a background-sheet pass that reports nothing.
    pub(crate) fn note_frame(
        &mut self,
        left: Vec<((Option<identity::SheetId>, u32, u32), CellValue)>,
        unreported: bool,
    ) {
        self.left.extend(left);
        self.whole_sheets |= unreported;
    }
}

/// The values a frame left in the cells its reply reports, keyed by stable
/// sheet id. Reads `grids`, `sheet_ids`, `active_sheet` (canonical order); the
/// caller holds none of them.
pub(crate) fn frame_left_values(
    state: &AppState,
    reported: &[CellData],
) -> Vec<((Option<identity::SheetId>, u32, u32), CellValue)> {
    let Ok(grids) = state.grids.read() else { return Vec::new() };
    let Ok(sheet_ids) = state.sheet_ids.read() else { return Vec::new() };
    let Ok(active) = state.active_sheet.read() else { return Vec::new() };
    let active = *active;
    reported
        .iter()
        .filter_map(|cd| {
            let sheet = cd.sheet_index.unwrap_or(active);
            let cell = grids.get(sheet)?.get_cell(cd.row, cd.col)?;
            cell.has_formula()
                .then(|| ((sheet_ids.get(sheet).copied(), cd.row, cd.col), cell.value.clone()))
        })
        .collect()
}

/// Take a [`ValueJournal`]. Reads `grids` then `sheet_ids` (canonical order);
/// the caller holds neither.
pub(crate) fn journal_formula_values(state: &AppState) -> ValueJournal {
    let Ok(grids) = state.grids.read() else {
        return ValueJournal::default();
    };
    let Ok(sheet_ids) = state.sheet_ids.read() else {
        return ValueJournal::default();
    };
    ValueJournal {
        sheets: grids
            .iter()
            .enumerate()
            .map(|(i, g)| {
                (
                    sheet_ids.get(i).copied(),
                    g.cells
                        .iter()
                        .filter(|(_, c)| c.has_formula())
                        .map(|(&pos, c)| (pos, (c.ast.clone(), c.value.clone())))
                        .collect(),
                )
            })
            .collect(),
        left: std::collections::HashMap::new(),
        whole_sheets: false,
    }
}

/// Put back every formula cell's journalled value that a transient run
/// changed, recalculating NOTHING (the values are the ones the workbook held,
/// stale or not). A cell that no longer holds a formula, holds a DIFFERENT
/// formula, or holds a value the run did not leave there (see [`ValueJournal`])
/// is the user's and is left alone. Reports each restored cell in
/// `updated_cells`. The caller holds no `AppState` lock; `effect` is the run's
/// own (`transient` for an animation).
pub(crate) fn restore_journal_values(
    state: &AppState,
    effect: &DocumentEffect,
    journal: &ValueJournal,
    updated_cells: &mut Vec<CellData>,
) {
    let mut restored: Vec<(usize, u32, u32)> = Vec::new();
    let active_sheet = {
        // Canonical order: grid, grids, sheet_ids, active_sheet.
        let Ok(mut grid) = state.grid.write(effect) else { return };
        let Ok(mut grids) = state.grids.write(effect) else { return };
        let Ok(sheet_ids) = state.sheet_ids.read() else { return };
        let Ok(active) = state.active_sheet.read() else { return };
        let active_sheet = *active;
        for (id, values) in &journal.sheets {
            let Some(idx) = (match id {
                Some(id) => sheet_ids.iter().position(|s| s == id),
                None => None,
            }) else {
                continue;
            };
            if idx >= grids.len() {
                continue;
            }
            for (&(row, col), (ast, value)) in values {
                let Some(mut cell) = grids[idx].get_cell(row, col).cloned() else { continue };
                if !cell.has_formula() || cell.value == *value {
                    continue;
                }
                // Re-typed while the run was paused: the user's cell now.
                if cell.ast != *ast {
                    continue;
                }
                // A value the run did not leave (an F9 while paused): the user's.
                if !journal.whole_sheets && journal.left.get(&(*id, row, col)) != Some(&cell.value) {
                    continue;
                }
                cell.value = value.clone();
                if idx == active_sheet {
                    grid.set_cell(row, col, cell.clone());
                }
                grids[idx].set_cell(row, col, cell);
                restored.push((idx, row, col));
            }
        }
        active_sheet
    };
    let mut repaint = Vec::with_capacity(restored.len());
    for (sheet, row, col) in restored {
        if let Some(cd) = cell_data(state, sheet, active_sheet, row, col) {
            repaint.push(cd);
        }
    }
    // A restored cell the caller's reply already reports is replaced (its
    // entry was formatted from the recalculated value).
    let replaced: HashSet<(Option<usize>, u32, u32)> =
        repaint.iter().map(|cd| (cd.sheet_index, cd.row, cd.col)).collect();
    updated_cells.retain(|cd| !replaced.contains(&(cd.sheet_index, cd.row, cd.col)));
    updated_cells.extend(repaint);
}

/// Append `extra` to `into`, skipping a cell `into` already reports -- in one
/// pass over each (a reply can hold every dependent of a big model).
pub(crate) fn merge_reported_cells(into: &mut Vec<CellData>, extra: Vec<CellData>) {
    let mut reported: HashSet<(Option<usize>, u32, u32)> =
        into.iter().map(|cd| (cd.sheet_index, cd.row, cd.col)).collect();
    for cd in extra {
        if reported.insert((cd.sheet_index, cd.row, cd.col)) {
            into.push(cd);
        }
    }
}

/// AN APPLICATION UPDATE'S READERS (BUG-0613). `calp_commands::apply_refresh_payloads`
/// installs the refreshed sheets and recalculates THEM
/// (`recalculate_installed_sheet_values`), and nothing else: a formula on one of
/// the subscriber's OWN sheets that reads a refreshed cell (`=Report!B5*2` beside
/// a subscribed `Report`) kept the previous version's number -- and the save's
/// keep rule, seeing nothing it reads change in ITS pass, could then vouch for a
/// stale cube or custom-function value there. In Excel a changed cell's readers
/// on every sheet recalculate.
///
/// Recalculates every sheet that reads, directly or through other sheets, a
/// cell on `installed` -- the transitive closure over the cross-sheet map, keyed
/// by the workbook's official sheet names -- other than `installed` itself
/// (their own pass, with the update's keep rule, has just run and must not be
/// redone without it). Each reader sheet is a whole-sheet recalculation
/// (`recalculate_sheet_values`, the one an off-sheet write uses), in two passes
/// so a chain of reader sheets settles whatever their index order, as
/// `recalc_after_off_sheet_write` does. Callers hold no lock. Returns the
/// sheets recalculated.
pub(crate) fn recalc_readers_of_installed_sheets(
    state: &AppState,
    user_files: &UserFilesState,
    pivots: &crate::pivot::types::PivotState,
    controls: Option<(&crate::pane_control::PaneControlState, &crate::ribbon_filter::RibbonFilterState)>,
    installed: &[usize],
) -> Vec<usize> {
    // Sequential locks (snapshot, drop, lock, drop): no ordering edge.
    let sheet_names: Vec<String> = match state.sheet_names.read() {
        Ok(names) => names.clone(),
        Err(_) => return Vec::new(),
    };
    let readers: Vec<usize> = {
        let Ok(dependents) = state.cross_sheet_dependents.lock() else {
            return Vec::new();
        };
        let mut in_set: std::collections::BTreeSet<usize> = installed.iter().copied().collect();
        loop {
            let names_in_set: HashSet<&str> = in_set
                .iter()
                .filter_map(|&i| sheet_names.get(i).map(|s| s.as_str()))
                .collect();
            let mut grew = false;
            for ((precedent_name, _r, _c), deps) in dependents.iter() {
                if names_in_set.contains(precedent_name.as_str()) {
                    for &(dep_sheet, _dr, _dc) in deps.iter() {
                        if dep_sheet < sheet_names.len() && in_set.insert(dep_sheet) {
                            grew = true;
                        }
                    }
                }
            }
            if !grew {
                break;
            }
        }
        in_set.into_iter().filter(|i| !installed.contains(i)).collect()
    };
    if readers.is_empty() {
        return readers;
    }
    let _circular_pass = crate::calculation::begin_circular_pass();
    for _pass in 0..2 {
        for &idx in &readers {
            crate::calculation::recalculate_sheet_values(state, user_files, pivots, idx, controls);
        }
    }
    readers
}

/// The cell as it is stored now (a restore buffer for a borrowed input).
pub(crate) fn stored_cell(state: &AppState, sheet: usize, row: u32, col: u32) -> Option<Cell> {
    state
        .grids
        .read()
        .ok()
        .and_then(|grids| grids.get(sheet).and_then(|g| g.get_cell(row, col)).cloned())
}

/// The sheet a `CellData` row belongs to.
fn cd_sheet(cd: &CellData, active_sheet: usize) -> usize {
    cd.sheet_index.unwrap_or(active_sheet)
}

/// One cell's repaint record: the formatted value at its effective style, an
/// explicit blank for an empty cell. `sheet_index` is `None` on the active
/// sheet (the convention every edit reply uses) and the sheet otherwise.
pub(crate) fn cell_data(
    state: &AppState,
    sheet: usize,
    active_sheet: usize,
    row: u32,
    col: u32,
) -> Option<CellData> {
    // Canonical order: grids, style_registry, merged_regions, locale.
    let grids = state.grids.read().ok()?;
    let g = grids.get(sheet)?;
    let styles = state.style_registry.read().ok()?;
    let (row_span, col_span) = if sheet == active_sheet {
        state
            .merged_regions
            .read()
            .ok()
            .and_then(|merged| {
                merged
                    .iter()
                    .find(|m| m.start_row == row && m.start_col == col)
                    .map(|m| (m.end_row - m.start_row + 1, m.end_col - m.start_col + 1))
            })
            .unwrap_or((1, 1))
    } else {
        (1, 1)
    };
    let locale = state.locale.lock().ok()?;
    let effective_style_index = g.effective_style_index(row, col);
    let (display, overflow, formula) = match g.get_cell(row, col) {
        Some(cell) => {
            let style = styles.get(effective_style_index);
            let (display, overflow) = crate::format_cell_value_and_class(&cell.value, style, &locale);
            (display, overflow, cell.formula_string().map(|f| format!("={}", f)))
        }
        None => (String::new(), crate::api_types::OverflowClass::Text, None),
    };
    Some(CellData {
        row,
        col,
        display,
        overflow,
        display_color: None,
        formula,
        style_index: effective_style_index,
        row_span,
        col_span,
        sheet_index: if sheet == active_sheet { None } else { Some(sheet) },
        rich_text: None,
        accounting_layout: None,
    })
}

#[cfg(test)]
#[path = "whatif_recalc_tests.rs"]
mod whatif_recalc_tests;
