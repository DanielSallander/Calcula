//! FILENAME: app/src-tauri/src/data_tables.rs
// PURPOSE: Data Tables (What-If Analysis) - one-variable and two-variable data
//          tables, LIVE: the body recalculates with the workbook (BUG-0652).
// CONTEXT: Tabulates formula results for varying inputs. The formula cell is at
//          a fixed position, and input values are substituted one at a time.
//
// A LIVE TABLE, AS EXCEL'S IS [LIVE, Excel 16 over COM, 2026-11-04]. Excel
// writes the body as the array formula `{=TABLE(row_input, col_input)}`
// (`=TABLE(,A1)` for a column input cell, `=TABLE(A1,)` for a row input cell,
// `=TABLE(A1,D1)` for both) and recalculates it with the workbook:
// - AUTOMATIC calculation: a change to an input value in the table's header
//   line, to the table's formula, or to anything that formula reads refreshes
//   the body (`K2` 5 -> 9 turned `=B1`'s 10 into 18; `B1` re-typed `=A1*3`
//   turned it into 27);
// - MANUAL calculation: the body is left for F9 (the workbook xlPending), and
//   a table CREATED under manual shows 0 until then; Calculate Sheet
//   (Shift+F9) refreshes the sheet's tables, Calculate Now (F9) every one;
// - every body cell is part of ONE array: editing, clearing, pasting onto or
//   sorting part of it, inserting a row or column inside it, or deleting part
//   of it is refused ("Cannot change part of a data table."); replacing or
//   clearing the WHOLE body removes the table;
// - `=TABLE(..)` cannot be typed ("That function isn't valid.");
// - `.xlsx` stores it as `<f t="dataTable" ref=.. dt2D dtr r1 [r2]/>` on the
//   body's top-left cell, values only on the others.
//
// Calcula used to write the results as LITERAL VALUES whatever the mode, so a
// table never followed its model and under manual calculation computed what
// Excel leaves for F9. The body now holds the `TABLE(..)` marker
// (`engine::data_table`); the evaluator answers it with the stored value, and
// the values are computed HERE, by the substitution the Data Table command has
// always run, from these places:
// - the command itself (under automatic calculation; under manual it writes
//   the marker with 0 and leaves the workbook pending, as Excel does);
// - every full calculation pass (`calculation::run_calculation_pass_with`,
//   F9 / Shift+F9 / leaving manual / calculate-before-save), whatever the mode;
// - under AUTOMATIC calculation, the end of an edit ([`refresh_after_edit`]:
//   typing, a paste, a clear, undo / redo, a fill, a sort, a grouped or
//   off-sheet entry, a script's writes, a move's relocation, a sheet delete),
//   every table of the workbook, as Excel's one-variable tables are
//   "calculate always" (`ca="1"`);
// - under AUTOMATIC calculation, the end of every shared recalculation entry
//   point ([`refresh_after_recalc`]: an AutoFilter, a pivot, a table command, a
//   clear, Find & Replace, a hidden row, a writeback, ...), so a command that
//   recalculates refreshes without having to remember to (NEW-dt-refresh-root);
// - the end of a Goal Seek or Solver run, whatever the mode
//   ([`refresh_at_run_end`], under the run's own single-flight).
//
// EACH SUBSTITUTION IS A REAL WRITE (BUG-0613). The input cell is written and
// every dependent recalculated through the shared cascade (`whatif_recalc`);
// the table's formula cell is then read as its STORED value, which the cascade
// has just recalculated through the real dependency chain, on every sheet.
// Excel [LIVE]: `=TABLE(,A10)` over `=B10`, `B10 = Sheet2!B10+100`,
// `Sheet2!B10 = Sheet1!A10*2` fills 110 for input 5 and 114 for 7, and leaves
// A10 = 1 and Sheet2!B10 = 2 afterwards.
//
// ONE WHAT-IF RUN AT A TIME. A refresh borrows the input cells exactly as the
// command does, so it takes the what-if single-flight (`begin_whatif_run`);
// while Goal Seek, Solver, a scenario or an animation holds it, a refresh is
// skipped (that run's own trials must not see another writer's substitutions).

use tauri::State;

use crate::api_types::{CellData, DataTableCell, DataTableOneVarParams, DataTableResult, DataTableTwoVarParams};
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::whatif_recalc::{
    begin_whatif_run, check_run_protection_held, stored_cell_in, stored_value_in, write_cells_and_recalc_in,
    RecalcMode, RunSheet, WhatIfRun, WhatIfStates,
};
use crate::AppState;
use engine::data_table::{DataTableBody, TableInput, TableInputs};
use engine::{Cell, CellError, CellValue};
use parser::ast::Expression;

/// Extract numeric value from a CellValue
fn cell_value_to_f64(val: &CellValue) -> Option<f64> {
    match val {
        CellValue::Number(n) => Some(*n),
        _ => None,
    }
}

/// Format a CellValue for display
fn cell_value_to_string(val: &CellValue) -> String {
    match val {
        CellValue::Number(n) => {
            if *n == (*n as i64) as f64 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        CellValue::Text(t) => t.clone(),
        CellValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        CellValue::Error(e) => e.as_literal().to_string(),
        CellValue::Empty => String::new(),
        CellValue::List(_) | CellValue::Dict(_) => String::from("[collection]"),
    }
}

/// The input cell holding `value`, keeping the style the cell has now.
fn input_cell(state: &AppState, sheet: RunSheet, row: u32, col: u32, value: &CellValue) -> Cell {
    let style_index = stored_cell_in(state, sheet, row, col).map_or(0, |c| c.style_index);
    let mut cell = match value {
        CellValue::Number(n) => Cell::new_number(*n),
        CellValue::Text(t) => Cell::new_text(t.clone()),
        CellValue::Boolean(b) => Cell::new_boolean(*b),
        CellValue::Empty => Cell::default(),
        CellValue::Error(_) => {
            let mut cell = Cell::new();
            cell.value = value.clone();
            cell
        }
        _ => Cell::new_text(cell_value_to_string(value)),
    };
    cell.style_index = style_index;
    cell
}

/// A computed result as the body stores it -- with its REAL type. Every
/// non-number used to be written as TEXT through `cell_value_to_string`, so an
/// error came out as the text "Div0" (its Debug name) and a boolean as the text
/// "TRUE": `=ISERROR(E12)` answered FALSE and a `SUM` over the body skipped the
/// cell. Excel's `{=TABLE()}` body holds the formula's own value: `#DIV/0!`
/// (ISERROR TRUE), TRUE / FALSE as booleans. A blank result is Excel's 0 (a
/// formula that reads an empty cell).
fn body_value(value: CellValue) -> CellValue {
    match value {
        CellValue::Empty => CellValue::Number(0.0),
        CellValue::List(_) | CellValue::Dict(_) => CellValue::Text(cell_value_to_string(&value)),
        other => other,
    }
}

/// One substitution: write the inputs, recalculate, read each formula cell.
fn substitute_and_read(
    state: &AppState,
    states: &WhatIfStates<'_>,
    effect: &DocumentEffect,
    sheet: RunSheet,
    inputs: &[((u32, u32), Option<Cell>)],
    formula_cells: &[(u32, u32)],
) -> Result<Vec<CellValue>, String> {
    let mut sink = Vec::new();
    write_cells_and_recalc_in(state, states, effect, sheet, inputs, RecalcMode::Always, &mut sink)?;
    Ok(formula_cells
        .iter()
        .map(|&(r, c)| stored_value_in(state, sheet, r, c))
        .collect())
}

/// An input of a table as a cell, `None` when omitted; `Err` when it cannot be
/// computed (`#REF!` after the input cell was deleted).
fn resolved(input: TableInput) -> Result<Option<(u32, u32)>, ()> {
    match input {
        TableInput::Omitted => Ok(None),
        TableInput::Cell(r, c) => Ok(Some((r, c))),
        TableInput::Invalid => Err(()),
    }
}

/// One trial of a table: the inputs to write (value per input cell) and, for
/// each formula cell it reads, the body cell that receives the answer.
struct Trial {
    inputs: Vec<((u32, u32), CellValue)>,
    reads: Vec<((u32, u32), (u32, u32))>,
}

/// The trials of `body`, read from the header line / column under one `grids`
/// read, with the input cells as they are stored now (the restore buffer).
/// `Err(())` for a table that cannot be computed.
#[allow(clippy::type_complexity)]
fn plan_trials(
    state: &AppState,
    sheet: RunSheet,
    body: &DataTableBody,
) -> Result<(Vec<Trial>, Vec<((u32, u32), Option<Cell>)>), ()> {
    let row_in = resolved(body.inputs.row_input)?;
    let col_in = resolved(body.inputs.col_input)?;
    if body.start_row == 0 || body.start_col == 0 || (row_in.is_none() && col_in.is_none()) {
        return Err(());
    }
    let grids = state.grids.read().map_err(|_| ())?;
    let index = sheet.index(state).ok_or(())?;
    let grid = grids.get(index).ok_or(())?;
    let value_at = |r: u32, c: u32| grid.get_cell(r, c).map(|cell| cell.value.clone()).unwrap_or(CellValue::Empty);
    let (hr, hc) = (body.start_row - 1, body.start_col - 1);
    let rows = body.start_row..=body.end_row;
    let cols = body.start_col..=body.end_col;
    let mut trials = Vec::new();
    match (row_in, col_in) {
        // Column input: one trial per body ROW, its value in the input column;
        // the formulas sit in the header row, one per body column.
        (None, Some(ci)) => {
            for r in rows {
                trials.push(Trial {
                    inputs: vec![(ci, value_at(r, hc))],
                    reads: cols.clone().map(|c| ((hr, c), (r, c))).collect(),
                });
            }
        }
        // Row input: one trial per body COLUMN, its value in the header row;
        // the formulas sit in the input column, one per body row.
        (Some(ri), None) => {
            for c in cols {
                trials.push(Trial {
                    inputs: vec![(ri, value_at(hr, c))],
                    reads: rows.clone().map(|r| ((r, hc), (r, c))).collect(),
                });
            }
        }
        // Two variables: one trial per body CELL; the column input's value in
        // the input column, the row input's in the header row, the formula in
        // the corner. When both inputs are the same cell, the row input's
        // value lands last.
        (Some(ri), Some(ci)) => {
            for r in rows {
                for c in cols.clone() {
                    let mut inputs = vec![(ci, value_at(r, hc)), (ri, value_at(hr, c))];
                    if ri == ci {
                        inputs.remove(0);
                    }
                    trials.push(Trial { inputs, reads: vec![((hr, hc), (r, c))] });
                }
            }
        }
        (None, None) => return Err(()),
    }
    let mut originals: Vec<((u32, u32), Option<Cell>)> = Vec::new();
    for pos in [row_in, col_in].into_iter().flatten() {
        if !originals.iter().any(|(p, _)| *p == pos) {
            originals.push((pos, grid.get_cell(pos.0, pos.1).cloned()));
        }
    }
    Ok((trials, originals))
}

#[cfg(test)]
thread_local! {
    /// Test stand-in for a writer on another thread: after the trial with this
    /// index, `compute_body` writes the number into the cell of the table's
    /// sheet as an entry would land between two trials (rev-dt2-3).
    pub(crate) static ENTRY_AFTER_TRIAL_FOR_TEST: std::cell::Cell<Option<(usize, (u32, u32), f64)>> =
        const { std::cell::Cell::new(None) };
}

/// THE VALUES OF A TABLE'S BODY: every trial written and read back, then the
/// borrowed input cells put back (and their dependents recalculated) on every
/// exit path. `updated_cells` receives the restore's repaints. A table that
/// cannot be computed answers `#REF!` in every body cell.
fn compute_body(
    state: &AppState,
    states: &WhatIfStates<'_>,
    effect: &DocumentEffect,
    sheet: RunSheet,
    body: &DataTableBody,
    updated_cells: &mut Vec<CellData>,
) -> Result<Vec<((u32, u32), CellValue)>, String> {
    let Ok((trials, originals)) = plan_trials(state, sheet, body) else {
        let mut all = Vec::new();
        for r in body.start_row..=body.end_row {
            for c in body.start_col..=body.end_col {
                all.push(((r, c), CellValue::Error(CellError::Ref)));
            }
        }
        return Ok(all);
    };
    /// Why a refresh leaves a table: an input cell changed under its trials.
    const INPUT_CHANGED_DURING_REFRESH: &str = "an input cell of the data table changed during its refresh";
    let mut computed: Vec<((u32, u32), CellValue)> = Vec::with_capacity(body.cell_count() as usize);
    let mut failure: Option<String> = None;
    // What each input cell holds as far as this refresh knows: the original
    // until a trial writes it, then the cell the last trial wrote -- its value,
    // its formula and its style, never the value alone (rev-dt2-3). The restore
    // puts back only an input cell that still holds exactly what the last trial
    // wrote (see `cells_to_restore`).
    type Held = (CellValue, Option<Expression>, usize);
    let held_of = |cell: Option<&Cell>| -> Held {
        cell.map_or((CellValue::Empty, None, 0), |c| (c.value.clone(), c.ast.as_deref().cloned(), c.style_index))
    };
    let mut last_trial: Vec<((u32, u32), Held)> = Vec::new();
    // A cell somebody else wrote while no lock was held (the trials drop every
    // lock between them): `Some` once one is found. The NEXT trial would have
    // overwritten that entry, so the trials stop there, the body is left for a
    // later calculation (the refresh reports it incomplete, so the workbook
    // stays pending), and the entry is left as they typed it.
    let foreign_write = |last_trial: &[((u32, u32), Held)]| -> bool {
        originals.iter().any(|(pos, original)| {
            let expected = match last_trial.iter().find(|(p, _)| p == pos) {
                Some((_, wrote)) => wrote.clone(),
                None => held_of(original.as_ref()),
            };
            held_of(stored_cell_in(state, sheet, pos.0, pos.1).as_ref()) != expected
        })
    };
    for (_index, trial) in trials.iter().enumerate() {
        #[cfg(test)]
        if _index > 0 {
            if let Some((after, (r, c), n)) = ENTRY_AFTER_TRIAL_FOR_TEST.with(|h| h.get()) {
                if after + 1 == _index {
                    ENTRY_AFTER_TRIAL_FOR_TEST.with(|h| h.set(None));
                    let entry = [((r, c), Some(Cell::new_number(n)))];
                    let mut sink = Vec::new();
                    write_cells_and_recalc_in(state, states, effect, sheet, &entry, RecalcMode::AsAnEdit, &mut sink)
                        .expect("the stand-in entry");
                }
            }
        }
        if foreign_write(&last_trial) {
            failure = Some(INPUT_CHANGED_DURING_REFRESH.to_string());
            break;
        }
        let writes: Vec<((u32, u32), Option<Cell>)> = trial
            .inputs
            .iter()
            .map(|(pos, v)| (*pos, Some(input_cell(state, sheet, pos.0, pos.1, v))))
            .collect();
        let formula_cells: Vec<(u32, u32)> = trial.reads.iter().map(|(f, _)| *f).collect();
        for (pos, cell) in &writes {
            let wrote = held_of(cell.as_ref());
            match last_trial.iter_mut().find(|(p, _)| p == pos) {
                Some(entry) => entry.1 = wrote,
                None => last_trial.push((*pos, wrote)),
            }
        }
        match substitute_and_read(state, states, effect, sheet, &writes, &formula_cells) {
            Ok(values) => {
                for (&(_, target), value) in trial.reads.iter().zip(values) {
                    computed.push((target, body_value(value)));
                }
            }
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    // The last trial's results were read after its cascade: an entry that
    // landed during it made them a mixture, so they are not kept either.
    if failure.is_none() && foreign_write(&last_trial) {
        failure = Some(INPUT_CHANGED_DURING_REFRESH.to_string());
    }
    let originals =
        cells_to_restore(originals, &last_trial, |(r, c)| held_of(stored_cell_in(state, sheet, r, c).as_ref()));
    let restored = write_cells_and_recalc_in(state, states, effect, sheet, &originals, RecalcMode::Always, updated_cells);
    if let Some(e) = failure {
        return Err(e);
    }
    restored?;
    Ok(computed)
}

/// THE RESTORE TAKES BACK ONLY WHAT THE TRIALS PUT THERE (rev-dt-5). A refresh
/// drops every lock between its trials (the F9 pass that runs it is an async
/// command), so the user can type into an input cell meanwhile; putting the
/// cell's ORIGINAL contents back then overwrote that entry while its undo step
/// stayed. An input cell is restored only when it still holds what the last
/// trial wrote (`last_trial`: the compute compares the whole cell -- value,
/// formula and style -- rev-dt2-3); one that holds anything else was changed
/// by someone else and is left as they left it. One that NO trial wrote (the
/// trials stopped before reaching it) holds its original or somebody else's
/// entry, and nothing is put back into it.
///
/// What a comparison cannot see: an entry of EXACTLY what the last trial wrote,
/// typed after it, is taken for the trial's own and restored -- telling the two
/// apart needs a per-cell write generation no store keeps. The trials stop at
/// the first entry they find (`compute_body`), so the window is the last
/// trial's alone, no longer every trial's.
pub(crate) fn cells_to_restore<K: PartialEq>(
    originals: Vec<((u32, u32), Option<Cell>)>,
    last_trial: &[((u32, u32), K)],
    current: impl Fn((u32, u32)) -> K,
) -> Vec<((u32, u32), Option<Cell>)> {
    originals
        .into_iter()
        .filter(|(pos, _)| match last_trial.iter().find(|(p, _)| p == pos) {
            Some((_, wrote)) => current(*pos) == *wrote,
            None => false,
        })
        .collect()
}

/// Write a computed body: each cell holds `marker` (the table's `TABLE(..)`
/// call) and its value, keeping its style. A cell already holding exactly that
/// is not rewritten, so a refresh that changes nothing repaints nothing and
/// recalculates no reader. The readers of what did change are recalculated
/// whatever the mode (this is a calculation's own result).
/// `mode` is `Always` for a refresh (a calculation's own result) and
/// `AsAnEdit` for a table CREATED under manual calculation, whose zeros Excel
/// writes without recalculating their readers (rev-dt-11).
#[allow(clippy::too_many_arguments)]
fn write_body(
    state: &AppState,
    states: &WhatIfStates<'_>,
    effect: &DocumentEffect,
    sheet: RunSheet,
    marker: &Expression,
    values: Vec<((u32, u32), CellValue)>,
    mode: RecalcMode,
    updated_cells: &mut Vec<CellData>,
) -> Result<bool, String> {
    let writes: Vec<((u32, u32), Option<Cell>)> = values
        .into_iter()
        .filter_map(|((r, c), value)| {
            let existing = stored_cell_in(state, sheet, r, c);
            if existing
                .as_ref()
                .is_some_and(|cell| cell.value == value && cell.ast.as_deref() == Some(marker))
            {
                return None;
            }
            let mut cell = Cell::new_formula_with_ast(marker.clone());
            cell.value = value;
            cell.style_index = existing.map_or(0, |c| c.style_index);
            Some(((r, c), Some(cell)))
        })
        .collect();
    if writes.is_empty() {
        return Ok(false);
    }
    write_cells_and_recalc_in(state, states, effect, sheet, &writes, mode, updated_cells).map(|_| true)
}

/// Why the Data Table command refuses a body inside a table (Insert > Table).
pub(crate) const DATA_TABLE_IN_TABLE: &str = "Multi-cell array formulas aren't allowed in tables.";

fn as_input(pos: Option<(u32, u32)>) -> TableInput {
    match pos {
        Some((r, c)) => TableInput::Cell(r, c),
        None => TableInput::Omitted,
    }
}

/// Whether calculation is AUTOMATIC now.
fn automatic(state: &AppState) -> bool {
    state.calculation_mode.lock().map(|m| *m == "automatic").unwrap_or(true)
}

/// The shared body of both commands, past the single-flight and the shape
/// checks: gate, write the marker, and compute it (automatic) or leave it for
/// F9 (manual). `body` is the table's body rectangle; `rect` the whole selected
/// range, which the protection gate covers.
fn create_data_table(
    state: &AppState,
    file_state: &FileState,
    states: &WhatIfStates<'_>,
    sheet_idx: usize,
    rect: (u32, u32, u32, u32),
    row_input: Option<(u32, u32)>,
    col_input: Option<(u32, u32)>,
    require_corner_formula: bool,
) -> DataTableResult {
    let refuse = |e: String| DataTableResult { cells: Vec::new(), updated_cells: Vec::new(), error: Some(e) };
    let (start_row, start_col, end_row, end_col) = rect;
    if end_row <= start_row || end_col <= start_col {
        return refuse("Select a table range of at least two rows and two columns.".to_string());
    }
    let mut body = DataTableBody {
        start_row: start_row + 1,
        start_col: start_col + 1,
        end_row,
        end_col,
        inputs: TableInputs { row_input: as_input(row_input), col_input: as_input(col_input), anchor: None },
    };
    // Excel refuses an input cell inside the table it drives ("Input cell
    // reference is not valid.") -- except its top-left corner [LIVE,
    // whatifcalc/probe5: K2 and L1 refused for K1:L3, K1 accepted].
    for (r, c) in [row_input, col_input].into_iter().flatten() {
        if r >= start_row && r <= end_row && c >= start_col && c <= end_col && (r, c) != (start_row, start_col) {
            return refuse("Input cell reference is not valid.".to_string());
        }
    }

    // The table's shape and its gates, read under the grid locks; every guard
    // dropped before a substitution writes (the cascade takes them itself).
    let (effect, run_sheet) = {
        let grid = state.grid.lock_pending().unwrap();
        let grids = state.grids.lock_pending().unwrap();
        let Some(sheet) = grids.get(sheet_idx) else {
            return refuse(format!("Sheet index {} out of range", sheet_idx));
        };
        // Sheet protection over the table rectangle, which this command
        // rewrites (and whose input cell it overwrites temporarily), on a
        // protected background sheet too -- asked HERE, under the guards the
        // run reads its cells under, so it judges the sheet the table is
        // computed on (rev13A: a tab moved between an earlier gate and these
        // locks gated one sheet and ran on another).
        if let Err(e) = check_run_protection_held(state, &grid, &grids, sheet_idx, |kinds, protection, sheet, styles| {
            crate::protection::check_sheet_protection_range_in(
                kinds, protection, sheet, styles, sheet_idx, start_row, start_col, end_row, end_col,
            )
        }) {
            return refuse(e);
        }
        let active = state.active_sheet.read().map(|a| *a).unwrap_or(0);
        let judged: &engine::Grid = if sheet_idx == active { &grid } else { sheet };
        // A new table over PART of an existing one is a change to part of it;
        // over the whole of one it replaces it, as Excel does.
        if engine::data_table::partly_covered_table(judged, body.start_row, body.start_col, body.end_row, body.end_col)
            .is_some()
        {
            return refuse(engine::data_table::PART_OF_DATA_TABLE.to_string());
        }
        // A body inside a TABLE (Insert > Table, the table store) is refused:
        // Excel refuses `Range.Table` over a ListObject's body, and a file with
        // a `dataTable` formula inside a table's `ref` is one Excel will not
        // open [LIVE, rev-xlsx-1]. Asked under the held grid guards (canonical
        // order: grid, grids, then the stores).
        {
            let tables = state.tables.read().unwrap();
            let inside = tables.get(&sheet_idx).is_some_and(|sheet_tables| {
                sheet_tables.values().any(|t| body.overlaps(t.start_row, t.start_col, t.end_row, t.end_col))
            });
            if inside {
                return refuse(DATA_TABLE_IN_TABLE.to_string());
            }
        }
        // A table is the maximal rectangle of ONE `TABLE(..)` call, so a body
        // touching another table's body with the same inputs would be read
        // back as one merged table and computed from the wrong input line
        // (rev-dt-9). Excel [LIVE, dtfollow/probe4.ps1] allows it and keeps each
        // table's range, so this one's marker names its identity (its body's
        // top-left cell, `TABLE(,A1,M2)`; `engine::data_table`).
        if engine::data_table::touching_table_with_same_inputs(judged, &body).is_some() {
            body.inputs.anchor = Some((body.start_row, body.start_col));
        }
        if require_corner_formula
            && judged.get_cell(start_row, start_col).and_then(|cell| cell.formula_string()).is_none()
        {
            return refuse("The top-left cell of the table must contain a formula.".to_string());
        }
        // The run's sheet by stable id, under the same guards as its cells.
        let run_sheet = RunSheet::at(state, sheet_idx);
        // Past every gate: the body is written below.
        let effect = DocumentEffect::mutates(file_state);
        let _grid = grid.authorize(&effect);
        let _grids = grids.authorize(&effect);
        (effect, run_sheet)
    };

    let marker = engine::data_table::table_call_anchored(row_input, col_input, body.inputs.anchor);
    let mut updated_cells = Vec::new();
    let values = if automatic(state) {
        match compute_body(state, states, &effect, run_sheet, &body, &mut updated_cells) {
            Ok(values) => values,
            Err(e) => return DataTableResult { cells: Vec::new(), updated_cells, error: Some(e) },
        }
    } else {
        // MANUAL calculation: Excel writes the table and calculates nothing --
        // not even its own body, which shows 0 until F9 -- and the workbook is
        // pending [LIVE: a table created under manual showed 0 and
        // CalculationState xlPending].
        let mut zeros = Vec::with_capacity(body.cell_count() as usize);
        for r in body.start_row..=body.end_row {
            for c in body.start_col..=body.end_col {
                zeros.push(((r, c), CellValue::Number(0.0)));
            }
        }
        zeros
    };
    let cells: Vec<DataTableCell> = values
        .iter()
        .map(|((r, c), v)| DataTableCell {
            row: *r,
            col: *c,
            value: cell_value_to_string(v),
            numeric_value: cell_value_to_f64(v),
        })
        .collect();
    let mut written = Vec::new();
    // Under manual calculation the zeros are written as an edit is: the body's
    // readers are left for F9 [LIVE, dtfollow/probe4.ps1: `N1 = SUM(L2:L3)`
    // read 50 before a table over L2:L3 was created under manual, and still
    // read 50 after, the body 0, xlPending] (rev-dt-11).
    let body_mode = if automatic(state) { RecalcMode::Always } else { RecalcMode::AsAnEdit };
    let error = write_body(state, states, &effect, run_sheet, &marker, values, body_mode, &mut written).err();
    if !automatic(state) {
        // The body is uncalculated: the workbook's values may be stale until a
        // completed Calculate Now (Excel's xlPending). Every sheet is marked
        // (over-reporting staleness is safe; the mirror shares the active
        // sheet's cache). Takes `grid` then `grids`, the canonical order.
        crate::calculation::note_stored_values_may_be_stale(state);
    }
    crate::whatif_recalc::merge_reported_cells(&mut written, updated_cells);
    DataTableResult { cells, updated_cells: written, error }
}

// ============================================================================
// One-Variable Data Table
// ============================================================================

/// Create a one-variable data table.
///
/// Layout (column-oriented, col_input provided):
///   - Top-left cell (start_row, start_col): formula cell (or empty)
///   - Column start_col, rows start_row+1..end_row: input values
///   - Columns start_col+1..end_col, row start_row: formula cells
///   - Body (start_row+1..end_row, start_col+1..end_col): `=TABLE(,input)`
///
/// Layout (row-oriented, row_input provided):
///   - Top-left cell (start_row, start_col): formula cell (or empty)
///   - Row start_row, cols start_col+1..end_col: input values
///   - Column start_col, rows start_row+1..end_row: formula cells
///   - Body (start_row+1..end_row, start_col+1..end_col): `=TABLE(input,)`
/// `(async)`: a run is many trials, each a recalculation of the changing
/// cells' dependents; as a sync command the whole run sat on the WebView2 UI
/// thread and the window showed Not Responding until it ended.
#[tauri::command(async)]
pub fn data_table_one_var(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: DataTableOneVarParams,
) -> DataTableResult {
    let states = WhatIfStates {
        user_files: &user_files_state,
        pivots: &pivot_state,
        pane_control: &pane_control_state,
        ribbon_filter: &ribbon_filter_state,
    };
    data_table_one_var_impl(&state, &file_state, &states, params)
}

/// The body of [`data_table_one_var`], callable without a Tauri runtime.
pub(crate) fn data_table_one_var_impl(
    state: &AppState,
    file_state: &FileState,
    states: &WhatIfStates<'_>,
    params: DataTableOneVarParams,
) -> DataTableResult {
    // ONE what-if run at a time, taken before every gate (see `begin_whatif_run`).
    let _run = match begin_whatif_run(state) {
        Ok(run) => run,
        Err(e) => return DataTableResult { cells: Vec::new(), updated_cells: Vec::new(), error: Some(e) },
    };
    // BACKGROUND: a what-if table is rows x cols full evaluations driven by a
    // caller-supplied rectangle, and every result is WRITTEN into the grid — so
    // the persisting ceiling, not a tighter one, and cancellable because the
    // rectangle can be large.
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Background,
        &state.calc_cancel,
    );
    crate::log_info!(
        "DATATABLE",
        "One-var: range=({},{})..({},{}) sheet={}",
        params.start_row,
        params.start_col,
        params.end_row,
        params.end_col,
        params.sheet_index
    );

    // Orientation: a column input cell wins when both are given (the
    // two-variable command takes both).
    let col_input = params.col_input_row.zip(params.col_input_col);
    let row_input = params.row_input_row.zip(params.row_input_col);
    let (row_input, col_input) = match (col_input, row_input) {
        (Some(pos), _) => (None, Some(pos)),
        (None, Some(pos)) => (Some(pos), None),
        (None, None) => {
            return DataTableResult {
                cells: Vec::new(),
                updated_cells: Vec::new(),
                error: Some("Must specify either row input cell or column input cell.".to_string()),
            };
        }
    };
    let rect = (
        params.start_row.min(params.end_row),
        params.start_col.min(params.end_col),
        params.start_row.max(params.end_row),
        params.start_col.max(params.end_col),
    );
    // The protection gate sits in `create_data_table`, under the run's locks:
    // state.grids.lock_pending() -> check_run_protection_held(.
    create_data_table(state, file_state, states, params.sheet_index, rect, row_input, col_input, false)
}

// ============================================================================
// Two-Variable Data Table
// ============================================================================

/// Create a two-variable data table.
///
/// Layout:
///   - Top-left cell (start_row, start_col): the formula cell
///   - Top row (start_row, start_col+1..end_col): row input values
///   - Left column (start_row+1..end_row, start_col): column input values
///   - Body (start_row+1..end_row, start_col+1..end_col): `=TABLE(row, col)`
/// `(async)`: a run is many trials, each a recalculation of the changing
/// cells' dependents; as a sync command the whole run sat on the WebView2 UI
/// thread and the window showed Not Responding until it ended.
#[tauri::command(async)]
pub fn data_table_two_var(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: DataTableTwoVarParams,
) -> DataTableResult {
    let states = WhatIfStates {
        user_files: &user_files_state,
        pivots: &pivot_state,
        pane_control: &pane_control_state,
        ribbon_filter: &ribbon_filter_state,
    };
    data_table_two_var_impl(&state, &file_state, &states, params)
}

/// The body of [`data_table_two_var`], callable without a Tauri runtime.
pub(crate) fn data_table_two_var_impl(
    state: &AppState,
    file_state: &FileState,
    states: &WhatIfStates<'_>,
    params: DataTableTwoVarParams,
) -> DataTableResult {
    // ONE what-if run at a time, taken before every gate (see `begin_whatif_run`).
    let _run = match begin_whatif_run(state) {
        Ok(run) => run,
        Err(e) => return DataTableResult { cells: Vec::new(), updated_cells: Vec::new(), error: Some(e) },
    };
    // See data_table_one_var: same surface, quadratically more of it.
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Background,
        &state.calc_cancel,
    );
    crate::log_info!(
        "DATATABLE",
        "Two-var: range=({},{})..({},{}) sheet={}",
        params.start_row,
        params.start_col,
        params.end_row,
        params.end_col,
        params.sheet_index
    );
    let rect = (
        params.start_row.min(params.end_row),
        params.start_col.min(params.end_col),
        params.start_row.max(params.end_row),
        params.start_col.max(params.end_col),
    );
    // The protection gate sits in `create_data_table`, under the run's locks:
    // state.grids.lock_pending() -> check_run_protection_held(.
    create_data_table(
        state,
        file_state,
        states,
        params.sheet_index,
        rect,
        Some((params.row_input_row, params.row_input_col)),
        Some((params.col_input_row, params.col_input_col)),
        true,
    )
}

// ============================================================================
// The live refresh
// ============================================================================

/// Which tables a refresh recalculates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TableScope {
    /// Every table of the workbook (Calculate Now, an edit under automatic).
    Workbook,
    /// The tables on the sheet at this index (Calculate Sheet).
    Sheet(usize),
}

/// The tables in `scope`, by sheet (stable id) -- the active sheet read from
/// its mirror, the source of truth. Takes `grid`, `grids`, then `sheet_ids` and
/// `active_sheet` (reads, canonical order).
fn tables_in_scope(state: &AppState, scope: TableScope) -> Vec<(RunSheet, Vec<DataTableBody>)> {
    let Ok(grid) = state.grid.read() else { return Vec::new() };
    let Ok(grids) = state.grids.read() else { return Vec::new() };
    let active = state.active_sheet.read().map(|a| *a).unwrap_or(0);
    let mut out = Vec::new();
    for i in 0..grids.len() {
        if let TableScope::Sheet(s) = scope {
            if s != i {
                continue;
            }
        }
        let g: &engine::Grid = if i == active { &grid } else { &grids[i] };
        if !engine::data_table::has_data_tables(g) {
            continue;
        }
        out.push((i, engine::data_table::data_tables_in(g)));
    }
    drop(grids);
    drop(grid);
    out.into_iter().map(|(i, tables)| (RunSheet::at(state, i), tables)).collect()
}

/// The marker a body's cells hold now (its top-left cell's formula), or `None`
/// when that cell no longer holds a `TABLE` call (the table was removed since
/// it was found).
fn current_marker(state: &AppState, sheet: RunSheet, body: &DataTableBody) -> Option<Expression> {
    let cell = stored_cell_in(state, sheet, body.start_row, body.start_col)?;
    let ast = cell.ast?;
    (engine::data_table::table_inputs(&ast) == Some(body.inputs)).then(|| *ast)
}

/// REFRESH every live data table in `scope`: each body recomputed by the
/// substitution and written where it changed. The caller holds the what-if
/// single-flight (`run`) and NO `AppState` lock. A recalculation, so it dirties
/// nothing (`RecalcCompanion`: the entry command owns the flag). Repaints join
/// `updated_cells`. Answers how many tables were refreshed.
pub(crate) fn refresh_live_tables_held(
    state: &AppState,
    states: &WhatIfStates<'_>,
    _run: &WhatIfRun<'_>,
    scope: TableScope,
    updated_cells: &mut Vec<CellData>,
) -> usize {
    let tables = tables_in_scope(state, scope);
    if tables.is_empty() {
        return 0;
    }
    #[cfg(test)]
    REFRESHES_FOR_TEST.with(|count| count.set(count.get() + 1));
    let _pass = crate::eval_budget::begin_pass(crate::eval_budget::EvalSurface::Background, &state.calc_cancel);
    let effect = DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::RecalcCompanion);
    // Every table once, by sheet and position.
    let flat: Vec<(RunSheet, &DataTableBody)> =
        tables.iter().flat_map(|(sheet, bodies)| bodies.iter().map(move |body| (*sheet, body))).collect();
    let table_count = flat.len();
    // What each table READS besides its model's own precedents: its formula
    // cells (the header row's, the input column's or the corner), its input
    // values (the header line and column) and its input cells -- any of them
    // can be another table's body. Positions on the table's sheet.
    let reads_of = |body: &DataTableBody| -> Vec<(u32, u32)> {
        let (hr, hc) = (body.start_row.saturating_sub(1), body.start_col.saturating_sub(1));
        let mut cells: Vec<(u32, u32)> = vec![(hr, hc)];
        cells.extend((body.start_col..=body.end_col).map(|c| (hr, c)));
        cells.extend((body.start_row..=body.end_row).map(|r| (r, hc)));
        for input in [body.inputs.row_input, body.inputs.col_input] {
            if let TableInput::Cell(r, c) = input {
                cells.push((r, c));
            }
        }
        cells
    };
    let reads: Vec<(Option<usize>, Vec<(u32, u32)>)> =
        flat.iter().map(|(sheet, body)| (sheet.index(state), reads_of(body))).collect();
    // A body that CHANGED, in the order of the refresh: `step` orders it among
    // the computes, and `touched` is every cell its write recalculated (the
    // shared cascade reports each cell it re-evaluated, by sheet) -- `None`
    // when the body is on a sheet that is not the active one, whose cascade
    // (the background-sheet recalculation) reports nothing, so any table may
    // have read it.
    struct Changed {
        step: usize,
        table: usize,
        touched: Option<std::collections::HashSet<(usize, u32, u32)>>,
    }
    let mut changes: Vec<Changed> = Vec::new();
    let mut computed_at: Vec<Option<usize>> = vec![None; table_count];
    let mut step = 0usize;
    let mut refreshed = 0;
    let mut incomplete = false;
    // ROUNDS (rev-dt-10), each table computed again only when it reads a body
    // that changed AFTER its own last compute (rev-dt2-5): the tables are
    // visited by sheet and position, so a table whose model reads a LATER
    // table's body computed from that body's old values, and is computed again
    // in the next round; one that reads no changed body is not recomputed. A
    // chain of k tables settles in k rounds, and the rounds stop at the number
    // of tables.
    //
    // A table is never recomputed for its OWN body (rev-dt2-4). A body that
    // reads itself -- `L1 = B1+L4` over the table K1:L4 -- is computed ONCE per
    // refresh from its previous values, which is what Excel does [LIVE, Excel
    // 16 over COM, 2026-11-05, dtrefresh/probe1.ps1 and probe3.ps1]: no
    // circular-reference warning, CalculationState xlDone, inputs 5 / 7 / 9 over
    // `B1 = A1*2` give 10 / 14 / 18 when the table is made (L4 was empty) and
    // 30 / 32 / 36 after K2 = 6; with two other tables on the sheet, a change to
    // a cell both models read stepped it once (10 / 14 / 18 -> 29 / 33 / 37).
    // Recomputing it in every round made it step once per table instead.
    for round in 0..table_count.max(1) {
        let mut any = false;
        for (i, (sheet, body)) in flat.iter().enumerate() {
            if round > 0 {
                let (sheet_index, cells) = &reads[i];
                let since = computed_at[i].unwrap_or(0);
                let stale = changes.iter().any(|ch| {
                    ch.step > since
                        && ch.table != i
                        && match (&ch.touched, sheet_index) {
                            (Some(touched), Some(s)) => cells.iter().any(|&(r, c)| touched.contains(&(*s, r, c))),
                            _ => true,
                        }
                });
                if !stale {
                    continue;
                }
            }
            let Some(marker) = current_marker(state, *sheet, body) else { continue };
            any = true;
            step += 1;
            computed_at[i] = Some(step);
            let mut reported = Vec::new();
            match compute_body(state, states, &effect, *sheet, body, &mut reported) {
                Ok(values) => {
                    let mut written = Vec::new();
                    match write_body(state, states, &effect, *sheet, &marker, values, RecalcMode::Always, &mut written) {
                        Ok(wrote) => {
                            if wrote {
                                step += 1;
                                let active = state.active_sheet.read().map(|a| *a).unwrap_or(0);
                                let touched = (sheet.index(state) == Some(active)).then(|| {
                                    written.iter().map(|cd| (cd.sheet_index.unwrap_or(active), cd.row, cd.col)).collect()
                                });
                                changes.push(Changed { step, table: i, touched });
                            }
                            if round == 0 {
                                refreshed += 1;
                            }
                        }
                        Err(e) => {
                            crate::log_warn!("DATATABLE", "refresh could not write a table body: {}", e);
                            incomplete = true;
                        }
                    }
                    replace_reported_cells(&mut reported, written);
                }
                Err(e) => {
                    crate::log_warn!("DATATABLE", "refresh of a data table stopped: {}", e);
                    incomplete = true;
                }
            }
            replace_reported_cells(updated_cells, reported);
        }
        // Nothing left that read a changed body, or a table left uncalculated.
        if !any || incomplete {
            break;
        }
    }
    // A table left uncalculated leaves the workbook pending (rev-dt-8): a save
    // must not vouch for it.
    if incomplete {
        crate::calculation::note_stored_values_may_be_stale(state);
    }
    refreshed
}

/// Append `fresh` to `into`, REPLACING an entry `into` already holds for the same
/// cell: a refresh reports the newer value of a body cell or a reader the
/// caller's own reply had formatted before the table changed.
pub(crate) fn replace_reported_cells(into: &mut Vec<CellData>, fresh: Vec<CellData>) {
    if fresh.is_empty() {
        return;
    }
    let keys: std::collections::HashSet<(Option<usize>, u32, u32)> =
        fresh.iter().map(|cd| (cd.sheet_index, cd.row, cd.col)).collect();
    into.retain(|cd| !keys.contains(&(cd.sheet_index, cd.row, cd.col)));
    into.extend(fresh);
}

/// [`refresh_live_tables_held`], taking the what-if single-flight itself. A
/// workbook without a data table pays one scan and takes nothing. While another
/// what-if run (or an animation) holds the single-flight the refresh is skipped
/// and answers 0: its trials own the input cells.
pub(crate) fn refresh_live_tables(
    state: &AppState,
    states: &WhatIfStates<'_>,
    scope: TableScope,
    updated_cells: &mut Vec<CellData>,
) -> usize {
    if tables_in_scope_is_empty(state, scope) {
        return 0;
    }
    // The workbook pass that ENDS a Goal Seek or Solver run: that run holds
    // the single-flight and refreshes every table itself right after the pass
    // (`refresh_at_run_end`), so this one is not a skipped refresh.
    if RUN_END_PASS.with(|flag| flag.get()) {
        return 0;
    }
    match begin_whatif_run(state) {
        Ok(run) => refresh_live_tables_held(state, states, &run, scope, updated_cells),
        Err(e) => {
            // The tables are left as they were, so the workbook does not claim
            // to be calculated: a pass that has just cleared the stale mark
            // would otherwise let a save vouch for uncalculated bodies (the
            // version-12 lie, rev-dt-8). A completed Calculate Now refreshes them.
            crate::log_info!("DATATABLE", "data tables not refreshed: {}", e);
            crate::calculation::note_stored_values_may_be_stale(state);
            0
        }
    }
}

fn tables_in_scope_is_empty(state: &AppState, scope: TableScope) -> bool {
    let Ok(grid) = state.grid.read() else { return true };
    let Ok(grids) = state.grids.read() else { return true };
    let active = state.active_sheet.read().map(|a| *a).unwrap_or(0);
    !(0..grids.len()).any(|i| {
        let in_scope = match scope {
            TableScope::Workbook => true,
            TableScope::Sheet(s) => s == i,
        };
        in_scope && engine::data_table::has_data_tables(if i == active { &grid } else { &grids[i] })
    })
}

/// THE END OF AN EDIT under AUTOMATIC calculation: every data table of the
/// workbook refreshed, as Excel's are on every recalculation (its one-variable
/// tables are "calculate always", `ca="1"` in `.xlsx`) [LIVE: changing an input
/// value in the header, or the formula the table reads, refreshed the body at
/// once]. Under manual calculation an edit leaves the tables for F9. The caller
/// (an edit command's outermost body) holds no lock.
pub(crate) fn refresh_after_edit(
    state: &AppState,
    user_files: &crate::persistence::UserFilesState,
    pivots: &crate::pivot::types::PivotState,
    pane_control: &crate::pane_control::PaneControlState,
    ribbon_filter: &crate::ribbon_filter::RibbonFilterState,
    updated_cells: &mut Vec<CellData>,
) {
    if !automatic(state) {
        return;
    }
    let states = WhatIfStates { user_files, pivots, pane_control, ribbon_filter };
    refresh_live_tables(state, &states, TableScope::Workbook, updated_cells);
}

/// THE END OF A FULL CALCULATION PASS (F9 = workbook, Shift+F9 = the active
/// sheet, the pass that leaves manual, calculate-before-save), whatever the
/// mode: the tables the pass covered refreshed [LIVE: under manual calculation
/// Shift+F9 refreshed the sheet's table and F9 every one; a table created
/// under manual showed 0 until then]. A pass that was CANCELLED leaves them:
/// its remainder is F9's to finish. The caller holds no lock.
pub(crate) fn refresh_after_calculation_pass(
    state: &AppState,
    states: &WhatIfStates<'_>,
    workbook: bool,
    updated_cells: &mut Vec<CellData>,
) {
    let cancelled = state
        .pending_recalc
        .read()
        .ok()
        .is_some_and(|p| p.as_ref().is_some_and(|pr| !pr.is_empty()));
    if cancelled {
        return;
    }
    let scope = if workbook {
        TableScope::Workbook
    } else {
        TableScope::Sheet(state.active_sheet.read().map(|a| *a).unwrap_or(0))
    };
    let mut reported = Vec::new();
    refresh_live_tables(state, states, scope, &mut reported);
    // The pass reported each cell with the value it computed; a refreshed body
    // cell (or a reader of one) replaces that entry.
    let active = state.active_sheet.read().map(|a| *a).unwrap_or(0);
    let fresh: std::collections::HashSet<(usize, u32, u32)> =
        reported.iter().map(|cd| (cd.sheet_index.unwrap_or(active), cd.row, cd.col)).collect();
    updated_cells.retain(|cd| !fresh.contains(&(cd.sheet_index.unwrap_or(active), cd.row, cd.col)));
    updated_cells.extend(reported);
}

/// THE END OF A GOAL SEEK OR SOLVER RUN, whatever the mode: every table of the
/// workbook refreshed, under the run's OWN single-flight (`run`) -- the
/// workbook pass that ends the run cannot take it, so its refresh was skipped
/// and a table created under manual calculation still showed 0 after the run
/// (BUG-0652 follow-up). Excel [LIVE, Excel 16 over COM, 2026-11-05,
/// dtfollow/probe2.ps1, manual calculation]: a table created under manual
/// (body 0, xlPending) shows 10 / 14 after `GoalSeek` and after Solver's
/// `SolverFinish KeepFinal:=1`, xlDone; a table whose model reads the changing
/// cell follows the answer (`B1 = A1*2+F1`, Goal Seek F1 = 4: 10 -> 14). Under
/// automatic calculation the run's writes are edits like any other, and a
/// table follows them as it follows an edit. A run whose end-of-run pass was
/// CANCELLED leaves its tables for F9 with the rest of the remainder. The
/// caller holds no lock. Repaints join `updated_cells`, replacing older reports
/// of the same cells.
thread_local! {
    /// Set while a Goal Seek or Solver run's end-of-run workbook pass runs on
    /// this thread ([`during_run_end_pass`]).
    static RUN_END_PASS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Run `pass` -- the workbook pass that ends a Goal Seek or Solver run -- with
/// the pass's own data-table refresh standing down: the run holds the
/// single-flight, so that refresh would be skipped and mark the workbook
/// pending (rev-dt-8), and the run refreshes every table itself right after
/// ([`refresh_at_run_end`]).
pub(crate) fn during_run_end_pass<T>(pass: impl FnOnce() -> T) -> T {
    struct Reset(bool);
    impl Drop for Reset {
        fn drop(&mut self) {
            let was = self.0;
            RUN_END_PASS.with(|flag| flag.set(was));
        }
    }
    let _reset = Reset(RUN_END_PASS.with(|flag| flag.replace(true)));
    pass()
}

pub(crate) fn refresh_at_run_end(
    state: &AppState,
    states: &WhatIfStates<'_>,
    run: &WhatIfRun<'_>,
    updated_cells: &mut Vec<CellData>,
) {
    let cancelled = state
        .pending_recalc
        .read()
        .ok()
        .is_some_and(|p| p.as_ref().is_some_and(|pr| !pr.is_empty()));
    if cancelled {
        return;
    }
    let mut reported = Vec::new();
    refresh_live_tables_held(state, states, run, TableScope::Workbook, &mut reported);
    let active = state.active_sheet.read().map(|a| *a).unwrap_or(0);
    let fresh: std::collections::HashSet<(usize, u32, u32)> =
        reported.iter().map(|cd| (cd.sheet_index.unwrap_or(active), cd.row, cd.col)).collect();
    updated_cells.retain(|cd| !fresh.contains(&(cd.sheet_index.unwrap_or(active), cd.row, cd.col)));
    updated_cells.extend(reported);
}

// ============================================================================
// The refresh at the shared recalculation entry points (NEW-dt-refresh-root)
// ============================================================================
//
// EVERY RECALCULATION REFRESHES THE LIVE TABLES. Excel recalculates a data
// table with the workbook, whatever made the workbook recalculate [LIVE, Excel
// 16 over COM, 2026-11-05, dtroot/probe1.ps1, automatic calculation: A1 = 1,
// C10:C12 = 1 / 2 / 3, `B1 = A1*SUBTOTAL(109,C10:C12)`, `L1 = B1`, the table
// K1:L3 over K2 = 5 / K3 = 7 with column input A1, body 30 / 42 -- an AutoFilter
// hiding row 11, `Rows(11).Hidden`, an outline collapsed over row 11 and
// clearing C11 each gave B1 = 4 and the body 20 / 28; Replace 2 -> 5 in C10:C12
// gave 45 / 63; xlDone every time]. Calcula refreshed only where a command
// remembered to (an edit's tail, `refresh_after_edit`), and 82 commands that
// recalculate -- AutoFilter, the pivots, the tables, grouping, the slicers, Find
// & Replace, the clears, a hidden row, a BI insert, a writeback, ... -- left the
// body stale and the workbook claiming to be calculated.
//
// The refresh now runs at the END of the shared recalculation entry points
// themselves (`recalc_after_active_sheet_bulk_rewrite`,
// `recalc_after_off_sheet_write`, `recalc_visibility_dependents_core`,
// `recalc_control_dependents_core`, `recalc_after_name_change`), once their own
// guards are dropped, through [`begin_recalc`] / [`refresh_after_recalc`]: a
// command that recalculates through one of them refreshes without having to
// remember. `cascade_cross_sheet_dependents` is the one entry point that runs
// under its caller's grid locks, so its callers refresh at their tails (an
// edit's `refresh_after_edit`), as they did.
//
// ONE REFRESH PER RECALCULATION. The entry points nest (a name change runs the
// off-sheet and the active-sheet cascade; a refresh's own trials run both), so
// a thread-local depth counts the open ones and only the OUTERMOST refreshes.
// That is also what keeps a refresh from re-entering itself: its trials run
// inside it. A what-if write ([`begin_what_if_write`]: every trial, restore and
// body write of Data Table, Goal Seek, Solver, a scenario and an animation
// frame) is a scope too, so a recalculation inside it never refreshes -- the
// run owns the input cells, and a Goal Seek or Solver run refreshes at its end
// (`refresh_at_run_end`) while an animation frame is transient by design
// (CLAUDE.md rule 6). A helper whose every caller refreshes at its own tail
// ([`defer_refresh_to_caller`]) leaves it to that tail. The counter is a guard
// that is not `Send`: it opens and closes on one thread, on every exit path, a
// panic included.
//
// MANUAL CALCULATION never refreshes here (F9 does,
// `refresh_after_calculation_pass`): the workbook is marked pending instead
// whenever it holds a data table, since a body may now be stale [LIVE,
// dtroot/probe1.ps1, manual calculation: after Calculate the AutoFilter left
// B1 = 6 and the body 30 / 42, xlPending, and F9 gave 4 / 20 / 28, xlDone].
// Over-reporting is the safe direction: a save must not vouch for a body.
// (The visibility recalculation does not ask this: under manual it marks the
// workbook pending only when a SUBTOTAL / AGGREGATE could read the change,
// which covers every table whose model reads a hidden row -- Excel stays
// xlDone after hiding a row nothing reads, table or no table.)
//
// COST. A workbook without a data table pays one scan of its cells per
// outermost recalculation (`tables_in_scope_is_empty`, the check every edit's
// tail already made), and nothing else.

thread_local! {
    /// How many shared recalculations, what-if writes and deferring helpers
    /// are open on this thread ([`RecalcScope`]).
    static RECALC_DEPTH: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// One shared recalculation open on this thread. Opened at an entry point's
/// top ([`begin_recalc`]) and handed to [`refresh_after_recalc`] at its end;
/// dropping it closes it on every exit path. Not `Send` (the raw-pointer
/// marker), so it can never be closed on another Tauri worker thread than the
/// one that opened it.
pub(crate) struct RecalcScope {
    outermost: bool,
    _thread_bound: std::marker::PhantomData<*const ()>,
}

impl RecalcScope {
    fn open() -> Self {
        let before = RECALC_DEPTH.with(|depth| depth.replace(depth.get().saturating_add(1)));
        RecalcScope { outermost: before == 0, _thread_bound: std::marker::PhantomData }
    }
}

impl Drop for RecalcScope {
    fn drop(&mut self) {
        RECALC_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

/// Open a shared recalculation: the entry point's caller holds no lock, and
/// the entry point hands the scope to [`refresh_after_recalc`] once its own
/// guards are dropped.
pub(crate) fn begin_recalc() -> RecalcScope {
    RecalcScope::open()
}

/// A what-if write: a trial, a restore or a body write of Data Table, Goal
/// Seek, Solver or a scenario, or an animation frame. Every recalculation
/// inside it is nested, so none refreshes a table (`whatif_recalc`).
pub(crate) struct WhatIfWrite(#[allow(dead_code)] RecalcScope);

/// Open a [`WhatIfWrite`] (`whatif_recalc::write_cells_and_recalc_on`).
pub(crate) fn begin_what_if_write() -> WhatIfWrite {
    WhatIfWrite(RecalcScope::open())
}

/// A helper whose every caller refreshes at its own tail: the recalculations
/// inside it do not refresh, the caller's `refresh_after_edit` does (the
/// census in `data_table_refresh_tests` holds every command that reaches one
/// of these to an explicit refresh).
///
/// ONE REFRESH PER COMMAND (NEW-double-refresh): a command that ends in an
/// explicit refresh AND recalculates through a refreshing entry point opens
/// one of these around that recalculation, or the tables are computed twice
/// -- the results were right, the work doubled (a structural edit, a merge,
/// a grouped write, a script's batch, undo / redo, an anchored control). The
/// census `no_command_refreshes_the_live_data_tables_twice` holds every such
/// function to it. A command whose tail directly followed one entry point
/// (Sort, Remove Duplicates, Consolidate) dropped the tail instead.
pub(crate) struct DeferredRefresh(#[allow(dead_code)] RecalcScope);

#[cfg(test)]
thread_local! {
    /// How many refreshes computed at least one table on this thread (a test
    /// counts a command's refreshes with it).
    pub(crate) static REFRESHES_FOR_TEST: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Open a [`DeferredRefresh`].
pub(crate) fn defer_refresh_to_caller() -> DeferredRefresh {
    DeferredRefresh(RecalcScope::open())
}

thread_local! {
    /// The pivots a refresh reads when its entry point was handed none and no
    /// app is running (a unit test): the active-sheet cascade an entry point
    /// without them runs (`recalc_after_active_sheet_bulk_rewrite`) has no
    /// pivot lookup either.
    static NO_PIVOTS: crate::pivot::types::PivotState = crate::pivot::types::PivotState::new();
    /// The control stores a refresh reads when its entry point was handed none
    /// (`recalc_visibility_dependents_core(.., None)`, a unit test's call).
    static NO_CONTROLS: (crate::pane_control::PaneControlState, crate::ribbon_filter::RibbonFilterState) =
        (crate::pane_control::PaneControlState::new(), crate::ribbon_filter::RibbonFilterState::new());
}

/// THE END OF A SHARED RECALCULATION: under AUTOMATIC calculation every data
/// table of the workbook refreshed, when `scope` is the outermost one open on
/// this thread; under MANUAL calculation the workbook marked pending when it
/// holds a data table (see the section comment). The caller holds no lock.
/// `pivots`: the entry point's pivot store, or `None` for one that has none
/// (the app's own is used, so a trial on a background sheet answers
/// GETPIVOTDATA as the off-sheet recalculation does). `controls`: likewise.
/// Repaints join `updated_cells`, replacing older reports of the same cells.
pub(crate) fn refresh_after_recalc(
    scope: RecalcScope,
    state: &AppState,
    user_files: &crate::persistence::UserFilesState,
    pivots: Option<&crate::pivot::types::PivotState>,
    controls: Option<(&crate::pane_control::PaneControlState, &crate::ribbon_filter::RibbonFilterState)>,
    updated_cells: &mut Vec<CellData>,
) {
    if !scope.outermost || std::thread::panicking() {
        return;
    }
    let automatic = automatic(state);
    if tables_in_scope_is_empty(state, TableScope::Workbook) {
        return;
    }
    if !automatic {
        crate::calculation::note_stored_values_may_be_stale(state);
        return;
    }
    // The scope stays open through the refresh: the cascades its trials run
    // are nested in it.
    let run = |pivots: &crate::pivot::types::PivotState| {
        let mut reported = Vec::new();
        let mut refresh = |pane_control: &crate::pane_control::PaneControlState,
                           ribbon_filter: &crate::ribbon_filter::RibbonFilterState| {
            let states = WhatIfStates { user_files, pivots, pane_control, ribbon_filter };
            refresh_live_tables(state, &states, TableScope::Workbook, &mut reported);
        };
        match controls {
            Some((pane, ribbon)) => refresh(pane, ribbon),
            None => NO_CONTROLS.with(|(pane, ribbon)| refresh(pane, ribbon)),
        }
        reported
    };
    // No store handed in: the one the shared cascade answers GETPIVOTDATA from
    // (a caller's scope, else the app's managed one -- NEW-getpivotdata-trials),
    // so a refresh's trials read the same pivots its entry point's cascade did.
    let reported = match pivots {
        Some(pivots) => run(pivots),
        None => crate::pivot::operations::with_cascade_pivot_store(|store| match store {
            Some(pivots) => run(pivots),
            None => NO_PIVOTS.with(|pivots| run(pivots)),
        }),
    };
    replace_reported_cells(updated_cells, reported);
    drop(scope);
}

// ============================================================================
// The protected body
// ============================================================================

/// THE ONE-CELL EDIT GATE: typing into a cell of a data table's body edits
/// part of the table, and a typed `=TABLE(..)` is not a formula a person may
/// enter [LIVE: both refused]. `sheet` is the grid the edit lands on; `typed`
/// the entry as typed. The caller holds that grid.
pub(crate) fn check_cell_edit(sheet: &engine::Grid, row: u32, col: u32, typed: &str) -> Result<(), String> {
    // The body first: re-entering a body cell's own `=TABLE(,A1)` (F2, Enter)
    // is a change to part of the table, as Excel words it.
    if let Some(cell) = sheet.get_cell(row, col) {
        if engine::data_table::is_data_table_cell(cell)
            && engine::data_table::partly_written_table(sheet, &[(row, col)]).is_some()
        {
            return Err(engine::data_table::PART_OF_DATA_TABLE.to_string());
        }
    }
    if typed_formula_calls_table(typed) {
        return Err(engine::data_table::TABLE_NOT_VALID.to_string());
    }
    Ok(())
}

/// THE MANY-CELL WRITE GATE (a paste, a batch of edits, a fill): refused when it
/// writes SOME but not all of a table's body, or enters a `=TABLE(..)` formula.
/// Writing every body cell replaces the table, as Excel allows.
pub(crate) fn check_cells_write<'a>(
    sheet: &engine::Grid,
    writes: impl Iterator<Item = (u32, u32, &'a str)>,
) -> Result<(), String> {
    check_cells_write_moving(sheet, writes, &[])
}

/// [`check_cells_write`] for a batch that MOVES the tables `moving` (bodies on
/// `sheet`, see [`whole_table_moves`]): a write over part of a table being
/// moved is not a change to part of it -- the move clears whatever of it the
/// batch does not overwrite (a table moved one column right lands on its own
/// body). Every other table is judged as before.
pub(crate) fn check_cells_write_moving<'a>(
    sheet: &engine::Grid,
    writes: impl Iterator<Item = (u32, u32, &'a str)>,
    moving: &[DataTableBody],
) -> Result<(), String> {
    let mut cells = Vec::new();
    for (r, c, typed) in writes {
        if typed_formula_calls_table(typed) {
            return Err(engine::data_table::TABLE_NOT_VALID.to_string());
        }
        cells.push((r, c));
    }
    let partly = if moving.is_empty() {
        engine::data_table::partly_written_table(sheet, &cells).is_some()
    } else if cells.is_empty() || !engine::data_table::has_data_tables(sheet) {
        false
    } else {
        let written: std::collections::HashSet<(u32, u32)> = cells.iter().copied().collect();
        engine::data_table::data_tables_in(sheet).into_iter().filter(|t| !moving.contains(t)).any(|t| {
            let hit = written.iter().filter(|&&(r, c)| t.contains(r, c)).count() as u64;
            hit > 0 && hit < t.cell_count()
        })
    };
    if partly {
        return Err(engine::data_table::PART_OF_DATA_TABLE.to_string());
    }
    Ok(())
}

/// One MOVE claim of a batch, as [`whole_table_moves`] reads it: the claimed
/// source cell (its sheet, row, column) and the cell the write lands on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MoveClaim {
    pub sheet: usize,
    pub from: (u32, u32),
    pub to: (u32, u32),
}

/// A CUT OF A WHOLE DATA TABLE MOVES IT. Excel [LIVE, Excel 16 over COM,
/// 2026-11-05, dtfollow/probe1.ps1, table K1:L4 = formula row L1, input column
/// K2:K4, body L2:L4 `=TABLE(,A1)`]: cutting K1:L4 to P10 leaves `=TABLE(,A1)`
/// in Q11:Q13 and nothing in L2 -- the table moved, its input reference (A1,
/// outside the block) unchanged -- while cutting L2, the body L2:L4, the inputs
/// and body K2:L4 or the formula row and body L1:L4 is refused ("Can't change
/// part of a data table.").
///
/// Given a batch's move claims (one per write, `None` for a write that moves
/// nothing), the indices of the writes that land a BODY cell of a table whose
/// WHOLE RANGE -- the body, the formula row above it and the input column left
/// of it -- the batch moves, every cell by one offset; and those tables (by
/// source sheet). `grid_of(sheet)` is a claimed source sheet's grid, held by the
/// caller. A table the batch moves only part of is not listed: its marker
/// writes stay refused. A cell of the range that holds nothing (a one-variable
/// table's empty top-left corner) need not be claimed: a row or column move
/// writes only the cells holding something, and Excel moves a whole table with
/// its rows as with Cut + Paste (NEW-drag-move-whole-table).
pub(crate) fn whole_table_moves<'g>(
    claims: &[Option<MoveClaim>],
    grid_of: impl Fn(usize) -> Option<&'g engine::Grid>,
) -> (std::collections::HashSet<usize>, Vec<(usize, DataTableBody)>) {
    use std::collections::{HashMap, HashSet};
    let mut by_sheet: HashMap<usize, HashMap<(u32, u32), (usize, (u32, u32))>> = HashMap::new();
    for (index, claim) in claims.iter().enumerate() {
        if let Some(claim) = claim {
            by_sheet.entry(claim.sheet).or_default().insert(claim.from, (index, claim.to));
        }
    }
    let mut cells = HashSet::new();
    let mut tables = Vec::new();
    let mut sheets: Vec<usize> = by_sheet.keys().copied().collect();
    sheets.sort_unstable();
    for sheet in sheets {
        let claimed = &by_sheet[&sheet];
        let Some(grid) = grid_of(sheet) else { continue };
        if !engine::data_table::has_data_tables(grid) {
            continue;
        }
        for table in engine::data_table::data_tables_in(grid) {
            if !claimed.keys().any(|&(r, c)| table.contains(r, c)) {
                continue;
            }
            let (r0, c0) = (table.start_row.saturating_sub(1), table.start_col.saturating_sub(1));
            // The move's offset: the corner's claim, or -- for a move that
            // writes only the cells holding something (a row or column move,
            // NEW-drag-move-whole-table) and so claims no EMPTY corner -- the
            // first claimed cell of the range.
            let offset_of = |r: u32, c: u32| {
                claimed.get(&(r, c)).map(|&(_, (tr, tc))| (tr as i64 - r as i64, tc as i64 - c as i64))
            };
            let Some(offset) = offset_of(r0, c0)
                .or_else(|| (r0..=table.end_row).flat_map(|r| (c0..=table.end_col).map(move |c| (r, c))).find_map(|(r, c)| offset_of(r, c)))
            else {
                continue;
            };
            // Every cell of the range moves by that offset; a cell that holds
            // NOTHING (no value, no formula) moves trivially when the batch
            // does not claim it.
            let empty = |r: u32, c: u32| {
                grid.get_cell(r, c).is_none_or(|cell| cell.ast.is_none() && cell.value == CellValue::Empty)
            };
            let whole = (r0..=table.end_row).all(|r| {
                (c0..=table.end_col).all(|c| match offset_of(r, c) {
                    Some(o) => o == offset,
                    None => empty(r, c),
                })
            });
            if !whole {
                continue;
            }
            for r in table.start_row..=table.end_row {
                for c in table.start_col..=table.end_col {
                    if let Some(&(index, _)) = claimed.get(&(r, c)) {
                        cells.insert(index);
                    }
                }
            }
            tables.push((sheet, table));
        }
    }
    (cells, tables)
}

/// THE RECTANGLE GATE (a clear, a sort, a delete of cells): refused when the
/// rectangle covers part of a table's body. Clearing a rectangle that holds the
/// whole body removes the table [LIVE].
pub(crate) fn check_range_change(
    sheet: &engine::Grid,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<(), String> {
    match engine::data_table::partly_covered_table(sheet, start_row, start_col, end_row, end_col) {
        Some(_) => Err(engine::data_table::PART_OF_DATA_TABLE.to_string()),
        None => Ok(()),
    }
}

/// THE STRUCTURAL GATE (Insert / Delete Rows, Columns and Cells, on the active
/// sheet and off it): refused when the edit would move or delete PART of a
/// table's range -- its body, formula row and input column -- without deleting
/// the whole body [LIVE: "Can't change part of a data table.", the cases in
/// `engine::data_table::band_edit_cuts_table`]. `edit` is the band edit and
/// `band_start..=band_end` its band (`0..=u32::MAX` for whole lines). The
/// caller holds (or has just read) `sheet`, the grid the edit lands on, and
/// asks BEFORE any `DocumentEffect` exists.
pub(crate) fn check_structural_edit(
    sheet: &engine::Grid,
    edit: calp::writeback::StructuralEdit,
    band_start: u32,
    band_end: u32,
) -> Result<(), String> {
    use calp::writeback::StructuralEdit as SE;
    let (along_rows, insert, at, count) = match edit {
        SE::RowInsert { at, count } => (true, true, at, count),
        SE::RowDelete { at, count } => (true, false, at, count),
        SE::ColInsert { at, count } => (false, true, at, count),
        SE::ColDelete { at, count } => (false, false, at, count),
    };
    match engine::data_table::band_edit_cuts_table(sheet, along_rows, insert, at, count, band_start, band_end) {
        Some(_) => Err(engine::data_table::PART_OF_DATA_TABLE.to_string()),
        None => Ok(()),
    }
}

/// Whether a typed entry is a formula calling `TABLE`: the name, as a whole
/// word outside any quoted text or quoted sheet name, followed by `(`. Read off
/// the TEXT rather than a parse, so a locale's spelling (`=TABLE(;A1)` with the
/// semicolon list separator) is judged the same as the invariant one.
pub(crate) fn typed_formula_calls_table(typed: &str) -> bool {
    let t = typed.trim_start();
    if !(t.starts_with('=') || t.starts_with('+')) || !t.to_ascii_uppercase().contains("TABLE") {
        return false;
    }
    let chars: Vec<char> = t.chars().collect();
    let mut i = 1;
    let mut quote: Option<char> = None;
    while i < chars.len() {
        let ch = chars[i];
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            i += 1;
            continue;
        }
        let word = |c: char| c.is_alphanumeric() || c == '_' || c == '.' || c == '\\';
        if word(ch) && !word(chars[i - 1]) {
            let start = i;
            while i < chars.len() && word(chars[i]) {
                i += 1;
            }
            let name: String = chars[start..i].iter().collect();
            let mut j = i;
            while j < chars.len() && chars[j] == ' ' {
                j += 1;
            }
            if name.eq_ignore_ascii_case(engine::data_table::TABLE_FUNCTION) && j < chars.len() && chars[j] == '(' {
                return true;
            }
            continue;
        }
        i += 1;
    }
    false
}
