//! FILENAME: app/src-tauri/src/commands/data.rs
// PURPOSE: Core operations for reading and writing cell data.

use crate::log_debug;
use crate::api_types::{
    CellData, ClearApplyTo, ClearRangeParams, ClearRangeResult, DimensionData, MergedRegion,
    RemoveDuplicatesParams, RemoveDuplicatesResult, SortDataOption, SortField, SortOn,
    SortOrientation, SortRangeParams, SortRangeResult, SpillRangeInfo, UpdateCellResult,
    UsedRangeResult,
};
use crate::{
    evaluate_formula_multi_sheet_with_files,
    evaluate_formula_raw_with_files_and_pivot,
    entry_format_at, extract_all_references, format_cell_value, get_column_row_dependents,
    get_recalculation_order, is_text_format, parse_cell_input, parse_cell_input_in_format,
    parse_cell_input_invariant, parse_cell_input_invariant_in_format,
    update_column_dependencies, update_cross_sheet_dependencies,
    update_dependencies, update_row_dependencies, AppState, log_perf
};
use engine::{self, EvalResult, Grid, StyleRegistry};
use crate::persistence::{FileState, UserFilesState};
use crate::slicer::SlicerState;
use std::collections::HashSet;
use tauri::State;

// Note: Assuming parser is available in the crate root based on usage context
// If 'parser' is a module, ensure it is imported via `use crate::parser;` if needed.

/// Returns the formula display string with "=" prefix for the frontend.
/// `Cell::formula_string()` renders the AST without the leading "=";
/// this helper adds it so the formula bar shows "=A1+B1" not "A1+B1".
pub(crate) fn formula_display(cell: &engine::Cell, locale: &engine::LocaleSettings) -> Option<String> {
    cell.formula_string()
        .map(|f| format!("={}", engine::localize_formula(&f, locale)))
}

/// Cascade payload trim (PERF-20): dependents recalculated by an edit only
/// need `display` + style for repaint — the grid refetches visible cells and
/// the formula bar fetches on selection. Rendering + localizing an AST per
/// dependent and shipping it as JSON dominates wide-cascade IPC payloads, so
/// formulas are included only for small cascades (where UI consumers keep
/// their exact current behavior) and dropped for wide ones.
pub(crate) const CASCADE_FORMULA_LIMIT: usize = 64;

/// What a caller does with a spill whose ORIGIN lies inside its OWN rectangle
/// (§2y). This is a decision each call site has to make explicitly, because the
/// two answers differ in exactly the way that produced §2y: a guard that always
/// refuses makes "select the spill and press Delete" impossible, and a guard
/// that always allows lets a command move or overwrite an origin while the map
/// keeps claiming cells no formula produces.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SpillOriginPolicy {
    /// The caller RELEASES a spill it swallows whole: the origin goes, and the
    /// spilled cells go with it through `take_spills_owned_*` (directly, or via
    /// the shared cascade's tear-down phase). Deleting a spilled block is the
    /// gesture this exists for — the origin is inside the selection, so there
    /// is nothing left to "edit or delete in the source cell".
    ReleasedByCaller,
    /// The caller cannot release it, so a spilled cell is refused exactly as if
    /// its origin were somewhere else. `sort_range` is the case: permuting a
    /// block that contains part of an array would shuffle values no formula
    /// owns, and swallowing the origin does not make that meaningful.
    Refuse,
}

/// Check if any cell in the given range is a spilled value (not the spill origin).
/// Returns Ok(()) if the range is safe to modify, or Err with a user-facing message
/// identifying the origin formula cell.
///
/// `policy` decides the ORIGIN-INSIDE case; see [`SpillOriginPolicy`]. Every
/// `ReleasedByCaller` site is required by
/// `every_release_policy_call_site_actually_releases_the_spill` to reach a
/// tear-down, so the exemption can never be taken without the removal it
/// promises.
fn check_spill_protection(
    spill_hosts: &std::collections::HashMap<(usize, u32, u32), (u32, u32)>,
    active_sheet: usize,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    policy: SpillOriginPolicy,
) -> Result<(), String> {
    fn spill_err(origin_r: u32, origin_c: u32) -> String {
        let col_letter = crate::pivot::utils::col_index_to_letter(origin_c);
        let cell_ref = format!("{}{}", col_letter, origin_r + 1);
        format!(
            "We can't delete this value\n\nThe value contained in this cell is spilled from the formula in {}. To delete this value, you will need to modify that formula.",
            cell_ref
        )
    }

    // An ORIGIN inside the rectangle is released by the caller, so the cells it
    // owns are not obstacles — they are about to leave with it. The origin is
    // never itself a `spill_hosts` key (`reevaluate_formula_cell` skips the
    // (0,0) offset), so this can only ever exempt a cell the same gesture takes.
    let origin_released = |origin_r: u32, origin_c: u32| {
        policy == SpillOriginPolicy::ReleasedByCaller
            && origin_r >= start_row
            && origin_r <= end_row
            && origin_c >= start_col
            && origin_c <= end_col
    };

    // Fast path: single-cell ranges (batch writes and clear_cell check one
    // cell at a time) — the map key IS the cell, so one probe replaces a scan
    // over every spilled cell in the workbook. The origin of a spilled cell is
    // never that cell itself, so `origin_released` cannot fire here.
    if start_row == end_row && start_col == end_col {
        if let Some(&(origin_r, origin_c)) =
            spill_hosts.get(&(active_sheet, start_row, start_col))
        {
            return Err(spill_err(origin_r, origin_c));
        }
        return Ok(());
    }

    // Inverted ranges match nothing (empty interval) — same as the old scan.
    if end_row < start_row || end_col < start_col {
        return Ok(());
    }

    // Adaptive: probe each coordinate when the rect is smaller than the map;
    // otherwise scan the map once (previous behavior — covers whole-column
    // selections without iterating 4 billion coordinates).
    let area = (end_row as u64 - start_row as u64 + 1)
        .saturating_mul(end_col as u64 - start_col as u64 + 1);
    if area <= spill_hosts.len() as u64 {
        for r in start_row..=end_row {
            for c in start_col..=end_col {
                if let Some(&(origin_r, origin_c)) = spill_hosts.get(&(active_sheet, r, c)) {
                    if origin_released(origin_r, origin_c) {
                        continue;
                    }
                    return Err(spill_err(origin_r, origin_c));
                }
            }
        }
        return Ok(());
    }

    for (&(sheet, r, c), &(origin_r, origin_c)) in spill_hosts.iter() {
        if sheet == active_sheet
            && r >= start_row && r <= end_row
            && c >= start_col && c <= end_col
        {
            if origin_released(origin_r, origin_c) {
                continue;
            }
            return Err(spill_err(origin_r, origin_c));
        }
    }
    Ok(())
}

/// THE ONE PLACE the spill map is torn down (§2y).
///
/// Removes every `spill_ranges` entry on `sheet` whose ORIGIN satisfies
/// `origin_affected`, drops the `spill_hosts` claims those entries made, and
/// returns the spilled coordinates that are now unowned so the caller can erase
/// them from the grid.
///
/// COST. It iterates `spill_ranges`, never the caller's rectangle or seed list:
/// the map holds one entry per SPILLING FORMULA in the workbook, which is zero
/// in every document that uses no dynamic array and a handful in one that does,
/// while a caller's rectangle can be a whole column and its seed list can be a
/// ten-thousand-cell block. The empty-map case — the overwhelmingly common one,
/// and the one on the Delete key's hot path — costs one lock and one
/// `is_empty()`, and never touches `spill_hosts` at all.
///
/// LOCKING. Takes `spill_ranges` then `spill_hosts`, the order `update_cell`
/// and `reevaluate_formula_cell` already use, and takes neither while the other
/// is held by the caller. Callers may hold the grid guards (these two are
/// acquired AFTER the grid everywhere in this module).
fn take_spills_where(
    state: &AppState,
    sheet: usize,
    origin_affected: impl Fn(u32, u32) -> bool,
) -> Vec<(u32, u32)> {
    // RECALC COMPANION. Tearing down a spill claim is never an act of its own: it
    // happens because an origin was cleared, overwritten or re-evaluated, and THAT
    // command owns the dirty flag. Naming `mutates` here would dirty a document on a
    // pure F9, which is the failure the `RecalcCompanion` variant exists to prevent.
    let teardown = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::RecalcCompanion,
    );
    let mut spill_ranges = state.spill_ranges.write(&teardown).unwrap();
    if spill_ranges.is_empty() {
        return Vec::new();
    }
    let origins: Vec<(usize, u32, u32)> = spill_ranges
        .keys()
        .filter(|&&(s, r, c)| s == sheet && origin_affected(r, c))
        .copied()
        .collect();
    if origins.is_empty() {
        return Vec::new();
    }
    let mut spill_hosts = state.spill_hosts.lock().unwrap();
    let mut released: Vec<(u32, u32)> = Vec::new();
    for key in origins {
        let Some(cells) = spill_ranges.remove(&key) else {
            continue;
        };
        for (r, c) in cells {
            spill_hosts.remove(&(sheet, r, c));
            released.push((r, c));
        }
    }
    released.sort_unstable();
    released.dedup();
    released
}

/// Record — or clear — WHAT is blocking the dynamic array at `(row, col)`.
///
/// `#SPILL!` exists as a distinct error precisely because its remedy is
/// specific: "clear the cells the array needs", not "fix the argument". That
/// remedy is unsayable without an ADDRESS, and `CellValue::Error` carries no
/// payload, so the address is kept beside the value in `AppState.spill_blocks`
/// and read back by the error-checking pane
/// (`error_checking::error_explanation`). Excel does the same thing — its
/// error menu offers "Select Obstructing Cells".
///
/// THE THREE CALL SITES ARE THE THREE PLACES A SPILL IS DECIDED, and they must
/// stay symmetric: `Some(blocker)` on the blocked branch, `None` on the branch
/// that spills successfully. Recording without clearing would leave a stale
/// address to be named the next time the same origin blocked for a DIFFERENT
/// reason.
pub(crate) fn note_spill_block(
    state: &AppState,
    sheet: usize,
    row: u32,
    col: u32,
    blocker: Option<(u32, u32)>,
) {
    let Ok(mut blocks) = state.spill_blocks.lock() else {
        return;
    };
    match blocker {
        Some(at) => {
            blocks.insert((sheet, row, col), at);
        }
        None => {
            blocks.remove(&(sheet, row, col));
        }
    }
}

/// The dynamic-array origins currently reporting `#SPILL!` BECAUSE of the cell
/// at `(row, col)`.
///
/// The reverse of [`note_spill_block`], and the reason that map is worth
/// keeping beyond the error message: it is the only way to find the array a
/// given cell is obstructing without re-evaluating every formula on the sheet.
/// Costs one lock and an `is_empty()` on a workbook with no blocked array.
pub(crate) fn origins_blocked_by(
    state: &AppState,
    sheet: usize,
    row: u32,
    col: u32,
) -> Vec<(u32, u32)> {
    let Ok(blocks) = state.spill_blocks.lock() else {
        return Vec::new();
    };
    if blocks.is_empty() {
        return Vec::new();
    }
    let mut origins: Vec<(u32, u32)> = blocks
        .iter()
        .filter(|(&(s, _, _), &at)| s == sheet && at == (row, col))
        .map(|(&(_, r, c), _)| (r, c))
        .collect();
    // Deterministic order: the cascade's shape must not depend on HashMap
    // iteration, or two identical workbooks recalculate differently.
    origins.sort_unstable();
    origins
}

/// [`origins_blocked_by`] for a SET of written cells -- the shape a batch write
/// (a paste, a script's setValues, an MCP block write) has.
///
/// Pasting a blank over the cell that blocks a dynamic array is the remedy
/// `#SPILL!` names, exactly as typing Delete there is, and Excel re-spills the
/// instant the obstruction goes [LIVE, Excel 16]. The array does not DEPEND on
/// the cell that was in its way, so no dependency edge reaches it: without
/// this, `update_cell` re-spilled it and the batch left it `#SPILL!` until the
/// next F9. One `spill_blocks` lock and an `is_empty()` on a workbook with no
/// blocked array; the written cells are hashed only once something is blocked.
pub(crate) fn origins_blocked_by_any(
    state: &AppState,
    sheet: usize,
    cells: &[(u32, u32)],
) -> Vec<(u32, u32)> {
    let Ok(blocks) = state.spill_blocks.lock() else {
        return Vec::new();
    };
    if blocks.is_empty() || cells.is_empty() {
        return Vec::new();
    }
    let written: crate::CoordSet = cells.iter().copied().collect();
    let mut origins: Vec<(u32, u32)> = blocks
        .iter()
        .filter(|(&(s, _, _), at)| s == sheet && written.contains(*at))
        .map(|(&(_, r, c), _)| (r, c))
        .collect();
    // Deterministic, for the reason `origins_blocked_by` sorts.
    origins.sort_unstable();
    origins.dedup();
    origins
}

/// A batch is about to write `(row, col)`, a cell a dynamic array SPILLED INTO
/// EARLIER IN THE SAME BATCH: release that array's spill through the ONE
/// tear-down and erase its other spilled values -- but NOT this cell, which is
/// the write's. "Drop the claim, leave the cell", for the one cell that is
/// somebody's data.
///
/// The batch's own spill guard runs before anything is written, so the only
/// claim a written cell can carry is one an earlier write of the same batch
/// made: a pasted `=SEQUENCE(3)` in D1 spills over D2:D3 the moment it is
/// written, and then the batch writes the literal that was copied for D3.
/// Left under D1's claim, the literal was ERASED by the cascade's re-decision
/// of D1 (the tear-down erases every cell an origin owned) and D1 spilled over
/// it -- the user's "x" gone, with no error anywhere. With the claim gone, the
/// re-decision finds D3 occupied and D1 reports `#SPILL!`, as Excel does for
/// the same paste [LIVE, Excel 16]. The other spilled values are DERIVED, so
/// erasing them loses nothing: the re-decision puts them back when the array
/// can land, and leaving them would block it as foreign data.
///
/// Costs one `spill_hosts` lock and one `is_empty()` per written cell on a
/// workbook with no dynamic array. Takes the leaf spill locks after the grid
/// guards the caller holds, never nested inside each other.
fn release_fresh_spill_under_write(
    state: &AppState,
    grid: &mut Grid,
    grids: &mut [Grid],
    sheet: usize,
    row: u32,
    col: u32,
    updated_cells: &mut Vec<CellData>,
) {
    let origin = {
        let spill_hosts = state.spill_hosts.lock().unwrap();
        if spill_hosts.is_empty() {
            return;
        }
        spill_hosts.get(&(sheet, row, col)).copied()
    };
    let Some((origin_row, origin_col)) = origin else {
        return;
    };
    let released = take_spills_owned_within(state, sheet, origin_row, origin_col, origin_row, origin_col);
    let others: Vec<(u32, u32)> = released.into_iter().filter(|&cell| cell != (row, col)).collect();
    erase_released_spill_cells(grid, grids, sheet, sheet, &others, updated_cells);
}

/// The ACTIVE SHEET's VOLATILE cells: every cell whose stored formula calls
/// NOW, TODAY, RAND, RANDBETWEEN, RANDARRAY, OFFSET, INDIRECT or CELL.
/// `engine::volatility` names them and records WHY each one qualifies (the
/// clock/RNG reason and the untrackable-target reason are different reasons).
///
/// WHY THIS IS A SCAN AND NOT A LOOKUP. Volatility is precisely the property
/// the dependency maps CANNOT express: `=NOW()` reads no cell, so it has no
/// entry in `dependents` at all, and `=OFFSET(A1,B1,0)` has one that names the
/// wrong cells. There is nothing to look it up in, so it is read back off the
/// stored ASTs.
///
/// COST — the whole difficulty of this feature, and the reason PERF-19 was
/// deferred rather than forgotten. Per edit, in automatic mode only:
///   - **No volatile formula anywhere:** one pass over the active sheet's cell
///     map. `cell.ast` is `None` for every data cell (one branch), and a
///     formula that opens with a non-volatile call returns false at its root.
///     The result `Vec` stays empty, so nothing reaches the heap.
///   - **A handful:** the same pass, plus those cells and everything downstream
///     of them joining the cascade the edit was already running.
///
/// This is the SOUND answer, not the cheap one, and the difference is worth
/// stating. The cheap answer is a registry maintained wherever a formula is
/// written, so a workbook with no volatile function pays literally nothing —
/// the way `udf_volatile_cells` is `None` for a workbook with no volatile UDF.
/// That registry cannot be built from this file: formulas enter the grid from a
/// dozen others (`lib.rs`, `tables.rs`, `commands/structure.rs`,
/// `named_ranges.rs`, `scripting/commands.rs`, `commands/nav.rs`, ...), and a
/// registry only some of them update is STALE — which restores the frozen
/// `=NOW()` for exactly the cells nobody thought about, silently. A scan that
/// costs is better than an index that lies.
///
/// ACTIVE SHEET ONLY, matching `udf_volatile_cells` (whose coordinates cross
/// the wire as active-sheet cells). A volatile cell on another sheet still
/// refreshes only on a full pass.
fn volatile_cells_on_active_sheet(grid: &Grid) -> Vec<(u32, u32)> {
    // THIS SCANS THE ACTIVE SHEET ON EVERY EDIT, and the cost is deliberate
    // rather than overlooked. Roughly 0.05-0.1 ms on a 10k-cell sheet and
    // 5-10 ms on a millon-cell one: one branch per data cell, one AST walk that
    // returns false at the root per formula cell, no allocation when nothing is
    // volatile.
    //
    // A CACHE WAS TRIED AND REMOVED, because every cheap key for it is unsound.
    // Keying on a grid write-epoch looks right and is not: `grids[i].cells =
    // other.cells.clone()` and `*current_grid = grids[i].clone()` replace a
    // sheet's contents WITHOUT going through any `Grid` mutator, and they are
    // how sheet switch, undo, file open and pivot refresh all work
    // (`sheets.rs`, `undo_commands.rs`, `persistence.rs`, `pivot/commands.rs` —
    // 16 sites). A cache keyed that way serves the previous sheet's answer for
    // the new one, and the symptom is `=NOW()` silently freezing again — the
    // exact defect this splice exists to fix, reintroduced somewhere nobody
    // would look.
    //
    // The two designs that ARE sound, if this ever shows up in a profile:
    // maintain the set beside the DEPENDENCY maps (a formula not registered
    // there does not recalculate anyway, so the invariant is self-enforcing),
    // or give `Grid` a private cell map so no assignment can bypass a stamp.
    // Both are larger than this function.
    let mut cells: Vec<(u32, u32)> = grid
        .cells
        .iter()
        .filter(|(_, cell)| {
            cell.ast
                .as_deref()
                .is_some_and(engine::volatility::contains_volatile_call)
        })
        .map(|(&coord, _)| coord)
        .collect();
    // Deterministic order, for the reason `origins_blocked_by` sorts: the
    // cascade's shape must not depend on HashMap iteration order, or two
    // identical workbooks recalculate differently.
    cells.sort_unstable();
    cells
}

/// Splice the active sheet's volatile cells — and everything downstream of them
/// — into a cascade root set that has already been ordered for the edit itself.
///
/// WHY EVERY EDIT AND NOT JUST F9. "Recalculates on every worksheet change" is
/// the definition of a volatile function, not an optimisation of it. Without
/// this splice a `=NOW()` cell sat FROZEN while the user typed around it, and
/// froze showing a plausible timestamp rather than an error — a wrong answer
/// that looks authoritative. Same for a `=RAND()` column and for an `=OFFSET()`
/// window whose base moved.
///
/// DEPENDENTS TOO. `A1 = NOW()` refreshing while `B1 = A1+1` does not leaves B1
/// disagreeing with the cell it reads, which is worse than both being stale.
/// The roots go through `recalc_order_from_seeds` as ORDERING MEMBERS, so the
/// whole volatile closure comes back topologically ordered from the one shared
/// helper — never a hand-rolled walk, which is how three copies of the
/// cross-sheet cascade drifted apart. Whole-column/row readers (`=SUM(A:A)`
/// over a RAND column) live in the stripe maps instead of `dependents` and are
/// appended the same way the edit path appends them for the edited cell.
///
/// `already_evaluated` is the single-cell edit's own cell: `update_cell`
/// evaluates it before the cascade starts and its convention is that it is not
/// a member of the recalc order. The batch path passes `None` — its cells ARE
/// members of the ordering.
///
/// No dirty decision belongs here. This runs inside a cascade the user's own
/// edit already owns; refreshing NOW() is not itself a document mutation (see
/// `CleanReason::RecalcCompanion`, which exists because a workbook holding
/// NOW()/RAND() must not prompt to save merely for being looked at).
fn splice_volatile_cascade_roots(
    grid: &Grid,
    dependents_map: &crate::DependencyMap,
    column_dependents_map: &crate::StripeDependentsMap,
    row_dependents_map: &crate::StripeDependentsMap,
    already_evaluated: Option<(u32, u32)>,
    recalc_order: &mut Vec<(u32, u32)>,
    recalc_set: &mut crate::CoordSet,
) {
    let roots = volatile_cells_on_active_sheet(grid);
    if roots.is_empty() {
        return;
    }
    for cell in crate::recalc_order_from_seeds(&roots, dependents_map, true) {
        if Some(cell) != already_evaluated && recalc_set.insert(cell) {
            recalc_order.push(cell);
        }
    }
    for &root in &roots {
        for dep in get_column_row_dependents(root, column_dependents_map, row_dependents_map) {
            if Some(dep) != already_evaluated && recalc_set.insert(dep) {
                recalc_order.push(dep);
            }
        }
    }
}

/// The cells an active-sheet write's same-sheet cascade starts from.
#[derive(Debug, Clone, Copy)]
pub(crate) enum CascadeSeeds<'a> {
    /// `update_cell`: the one edited cell. It is evaluated BEFORE the cascade
    /// and is not a member of the order (unless a cycle leads back to it).
    Edited((u32, u32)),
    /// `update_cells_batch`: every written cell, each a MEMBER of the order,
    /// so a formula the batch wrote is re-evaluated after the cells it reads.
    Written(&'a [(u32, u32)]),
}

/// THE CELLS AN ACTIVE-SHEET WRITE'S DEPENDENT CASCADE EVALUATES, in the order
/// it evaluates them -- the ONE answer, for `update_cell_impl`,
/// `update_cells_batch_core` and the CUBE pre-fetch (`bi::cube::
/// build_cube_prefetch`) alike.
///
/// In order: the seeds' transitive dependents (one multi-root traversal for
/// the whole write, never one per written cell), their whole-column/row
/// readers, the volatile custom-function cells the frontend's UDF pass found,
/// the volatile built-ins and everything downstream of them
/// (`splice_volatile_cascade_roots`), and the dynamic-array origins this write
/// unblocked with their dependents (`unblocked_origins`: `origins_blocked_by`
/// for an edit, `origins_blocked_by_any` over the written cells for a batch).
///
/// WHY THE PRE-FETCH CALLS THIS TOO (BUG-0476 follow-up). The cascade
/// evaluates every one of these cells WITH the write's cube data in hand, and
/// a cube cell the pre-fetch held no results for answered `#N/A`. The pre-fetch
/// used to compute its own, smaller set -- each edit's dependents, one full
/// traversal per edit -- so a `CUBEVALUE` fed by a `TODAY()` cell (the volatile
/// splice), or wrapped in `=IF(COUNTA(A:A)>0, CUBEVALUE(...))` (a column
/// reader), went `#N/A` on an ordinary edit. Two copies of "which cells does
/// this write recalculate" cannot stay in agreement; one function can.
///
/// The pre-fetch calls it BEFORE the write, over the pre-write dependency maps
/// and grid, which yields the same set once the written cells themselves are
/// added: a write only changes edges that point AT a written cell (a cell's
/// dependents do not change when its own formula does), and the written cells
/// are seeds -- so nothing reachable from them moves. Order may differ; the
/// set does not.
#[allow(clippy::too_many_arguments)]
pub(crate) fn active_sheet_write_cascade(
    grid: &Grid,
    seeds: CascadeSeeds<'_>,
    dependents_map: &crate::DependencyMap,
    column_dependents_map: &crate::StripeDependentsMap,
    row_dependents_map: &crate::StripeDependentsMap,
    udf_volatile_cells: Option<&[crate::scripting::udf::UdfCellRef]>,
    unblocked_origins: &[(u32, u32)],
) -> Vec<(u32, u32)> {
    let edited_buf: [(u32, u32); 1];
    let (seed_cells, members, already_evaluated): (&[(u32, u32)], bool, Option<(u32, u32)>) =
        match seeds {
            CascadeSeeds::Edited(cell) => {
                edited_buf = [cell];
                (&edited_buf[..], false, Some(cell))
            }
            CascadeSeeds::Written(cells) => (cells, true, None),
        };

    let mut order = crate::recalc_order_from_seeds(seed_cells, dependents_map, members);
    let mut set: crate::CoordSet = order.iter().copied().collect();

    // Whole-column/row readers (formulas with column or row references) live
    // in the stripe maps, not `dependents`: appended after the topological
    // order. `get_column_row_dependents` never returns its own seed.
    for &seed in seed_cells {
        for dep in get_column_row_dependents(seed, column_dependents_map, row_dependents_map) {
            if Some(dep) != already_evaluated && set.insert(dep) {
                order.push(dep);
            }
        }
    }

    // VOLATILE UDF cells (Excel's Application.Volatile): cells calling a
    // function the author marked volatile recalculate on every edit even
    // though no dependency edge reaches them. The frontend's UDF pass found
    // them and already resolved their calls. `None` for every workbook without
    // a volatile UDF, and for Rust-side writers.
    if let Some(volatile) = udf_volatile_cells {
        for v in volatile {
            if Some((v.row, v.col)) != already_evaluated && set.insert((v.row, v.col)) {
                order.push((v.row, v.col));
            }
        }
    }

    // VOLATILE BUILT-INS (NOW/TODAY/RAND/RANDBETWEEN/RANDARRAY/OFFSET/
    // INDIRECT/CELL): the same rule for the functions Excel makes volatile
    // itself, read back off the stored ASTs. See
    // `splice_volatile_cascade_roots` for the cost.
    splice_volatile_cascade_roots(
        grid,
        dependents_map,
        column_dependents_map,
        row_dependents_map,
        already_evaluated,
        &mut order,
        &mut set,
    );

    // ARRAYS THIS WRITE UNBLOCKED. A dynamic array blocked by an occupied
    // cell is `#SPILL!`, and clearing the obstruction is the remedy the error
    // names -- but the origin does not DEPEND on the cell that was in its way,
    // so no dependency edge reaches it. (Excel re-spills the instant the
    // blocker is cleared.) Convergent when several cells block one array: the
    // re-evaluation records the next blocker and stays `#SPILL!`.
    for &origin in unblocked_origins {
        if Some(origin) != already_evaluated && set.insert(origin) {
            order.push(origin);
            // ...and whatever reads the array, which was reading an error.
            for dep in get_recalculation_order(origin, dependents_map) {
                if set.insert(dep) {
                    order.push(dep);
                }
            }
        }
    }

    order
}

/// EXCEL'S `xlPending` UNDER MANUAL CALCULATION: a write that a formula
/// depends on leaves that formula un-recalculated, so the workbook's values may
/// be stale until a completed Calculate Now. Marks the active sheet's results
/// cache (`CallMemo::note_values_may_be_stale`), which is what
/// `calculation::get_calculation_state` reports as "pending" (the status bar's
/// "Calculate"), what a save writes as `Workbook::calculation_incomplete`, and
/// what a completed Calculate Now clears.
///
/// [LIVE] Excel 16, manual calculation: entering a value into a cell no
/// formula reads, or changing only a format, leaves `CalculationState` at
/// xlDone; changing a precedent of `=A1*2` makes it xlPending; with a volatile
/// `=RAND()` anywhere on the sheet ANY entry makes it xlPending. So the test is
/// the cascade automatic calculation would have run -- the one
/// [`active_sheet_write_cascade`] -- minus the written cells themselves (a
/// formula a write enters is evaluated by the write), plus the edited cells'
/// cross-sheet readers. Called only under manual calculation, with the grid and
/// the dependency maps the write already holds.
pub(crate) fn note_manual_write_left_formulas_uncalculated(
    grid: &Grid,
    written: &[(u32, u32)],
    sheet_name: &str,
    dependents_map: &crate::DependencyMap,
    column_dependents_map: &crate::StripeDependentsMap,
    row_dependents_map: &crate::StripeDependentsMap,
    cross_sheet_dependents_map: &crate::CrossSheetDependentsMap,
) -> bool {
    if written.is_empty() {
        return false;
    }
    let written_set: crate::CoordSet = written.iter().copied().collect();
    let same_sheet = active_sheet_write_cascade(
        grid,
        CascadeSeeds::Written(written),
        dependents_map,
        column_dependents_map,
        row_dependents_map,
        None,
        &[],
    )
    .into_iter()
    .any(|cell| !written_set.contains(&cell));
    // By cell, whole column, whole row or a 3D span that includes this sheet:
    // `extract_references_recursive` keys all four in the cross-sheet map
    // (calcref, round 18 -- `=SUM(Sheet2!G:G)` on Sheet1 was no key there, so
    // a manual write on Sheet2!G5 reported done; Excel says xlPending [LIVE]).
    let cross_sheet = || {
        written.iter().any(|&(row, col)| {
            crate::cross_sheet_readers(cross_sheet_dependents_map, sheet_name, row, col).is_some()
        })
    };
    let left_stale = same_sheet || cross_sheet();
    if left_stale {
        grid.call_memo().note_values_may_be_stale();
    }
    left_stale
}

/// [`take_spills_where`] for a RECTANGLE of origins — the shape every clear and
/// every single-cell rewrite has.
pub(crate) fn take_spills_owned_within(
    state: &AppState,
    sheet: usize,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Vec<(u32, u32)> {
    take_spills_where(state, sheet, |r, c| {
        r >= start_row && r <= end_row && c >= start_col && c <= end_col
    })
}

/// [`take_spills_where`] for an arbitrary SET of origins — the shape a cascade
/// seed list has, where the cells a command rewrote are not a rectangle.
pub(crate) fn take_spills_owned_by_any(
    state: &AppState,
    sheet: usize,
    cells: &crate::CoordSet,
) -> Vec<(u32, u32)> {
    take_spills_where(state, sheet, |r, c| cells.contains(&(r, c)))
}

/// Drop the spill claims of every ORIGIN on `sheet` that no longer holds a
/// formula in `grid`.
///
/// FOR WHOLESALE WRITERS — the ones that install a whole grid or write straight
/// into a background sheet and then recalculate it end to end: the script
/// surface's non-active-sheet install, and the three `.calp` override commands.
/// They cannot use the seed-based tear-down in
/// `recalc_after_active_sheet_bulk_rewrite` because they never produce seeds,
/// and `recalculate_sheet_values` — spill-aware since §3bm — only VISITS cells
/// that still hold a formula, so an origin whose formula the wholesale write
/// replaced is never reached and its claim would survive forever.
///
/// IT DROPS THE CLAIM AND LEAVES THE CELLS. That is the deliberate difference
/// from `take_spills_owned_within` + `erase_released_spill_cells`. The grid
/// being installed is authoritative about cell CONTENT — a script may have
/// written its own values into the coordinates the old array covered — so
/// erasing them would destroy the write this function is cleaning up after.
/// Dropping the claim is what removes §2y's dead end: the cells stop being
/// uneditable and undeletable, and stop naming an empty source cell. What they
/// do NOT do is come back as an array, which is the same residual a reload
/// leaves (§2ab) and has the same fix.
///
/// Returns the coordinates whose claim was dropped, for logging/reporting.
/// Costs one lock and one `is_empty()` on a workbook with no dynamic array.
pub(crate) fn release_spills_orphaned_by_grid(
    state: &AppState,
    sheet: usize,
    grid: &Grid,
) -> Vec<(u32, u32)> {
    take_spills_where(state, sheet, |r, c| {
        grid.get_cell(r, c)
            .is_none_or(|cell| cell.formula_string().is_none())
    })
}

/// Refuse a gesture whose target CELLS include a spilled value.
///
/// The match-list form of [`check_spill_protection`], for commands that act on
/// a set of cells rather than a rectangle — Replace All and Replace, which are
/// checked against their match list for exactly the reason the writeback and
/// sheet-protection gates are (a bounding box would refuse replaces that never
/// land in the array).
///
/// The ORIGIN never needs a policy here: both replace paths skip formula cells
/// outright ("Skip formula cells for safety"), so the only spill cell they can
/// reach is a spilled VALUE, whose origin is by definition somewhere else.
///
/// WHY IT IS A REFUSAL AND NOT A SKIP. Rewriting a spilled value in place is
/// allowed nowhere else in the product — typing into that cell is refused with
/// a message naming the source formula — and the write does not even survive:
/// the map still says the array owns the cell, so the next recalculation of the
/// origin puts the old value back and the user's replacement is gone with no
/// error. Refusing the whole gesture is also the policy this command already
/// applies to locked cells and writeback claims, argued there at length: a
/// Replace All applied to the allowed subset is half a job dressed up as
/// success.
pub(crate) fn check_spill_protection_cells(
    state: &AppState,
    sheet: usize,
    cells: &[(u32, u32)],
) -> Result<(), String> {
    let spill_hosts = state.spill_hosts.lock().unwrap();
    if spill_hosts.is_empty() {
        return Ok(());
    }
    for &(row, col) in cells {
        check_spill_protection(
            &spill_hosts, sheet, row, col, row, col,
            SpillOriginPolicy::Refuse,
        )?;
    }
    Ok(())
}

/// Refuse a rectangle that holds ANY part of a dynamic array — a spilled cell
/// or the ORIGIN formula that produces them.
///
/// THE GUARD FOR COMMANDS THAT CANNOT CARRY AN ARRAY. `sort_range` permutes its
/// rectangle, `fill_range` overwrites it cell by cell, `merge_cells` deletes
/// every cell but one: none of those is a meaningful thing to do to half an
/// array, and none of them can re-derive one. So they refuse, exactly as Excel
/// does ("You can't change part of an array"), and in exchange they never have
/// to maintain the spill map at all.
///
/// BOTH questions are needed, and this is the point of the helper. The
/// spilled-CELL check alone lets through the arrangement where every spilled
/// cell lies outside the rectangle and only the origin is inside it — a
/// horizontal array in row 1 is entirely outside any rectangle over column A
/// except for its origin. Sorting column A would then move the FORMULA to
/// another row while B1:D1 stayed where they were.
///
/// Costs two locks and two `is_empty()` calls on a workbook with no dynamic
/// array, which is every workbook that uses none.
pub(crate) fn check_no_array_within(
    state: &AppState,
    sheet: usize,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<(), String> {
    {
        let spill_hosts = state.spill_hosts.lock().unwrap();
        check_spill_protection(
            &spill_hosts, sheet, start_row, start_col, end_row, end_col,
            SpillOriginPolicy::Refuse,
        )?;
    }
    check_no_spill_origin_within(state, sheet, start_row, start_col, end_row, end_col)
}

/// The ORIGIN half of [`check_no_array_within`], separate so the two questions
/// can be tested against each other — the spilled-cell check is deliberately
/// blind to the arrangement this one catches.
fn check_no_spill_origin_within(
    state: &AppState,
    sheet: usize,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<(), String> {
    let spill_ranges = state.spill_ranges.read().unwrap();
    if spill_ranges.is_empty() {
        return Ok(());
    }
    if let Some(&(_, r, c)) = spill_ranges.keys().find(|&&(s, r, c)| {
        s == sheet && r >= start_row && r <= end_row && c >= start_col && c <= end_col
    }) {
        let cell_ref = format!("{}{}", crate::pivot::utils::col_index_to_letter(c), r + 1);
        return Err(format!(
            "We can't change part of an array\n\nThe formula in {} produces a spilled array. Move or remove it before rearranging these cells.",
            cell_ref
        ));
    }
    Ok(())
}

/// Read-only companion to [`take_spills_owned_within`]: which cells a clear
/// must NOT record for undo, because they are spilled values whose origin the
/// same gesture is removing.
///
/// WHY THEY GET NO UNDO ENTRY, which is the half of §2y most likely to be got
/// backwards. A spilled cell is DERIVED state — it carries no formula, no rich
/// text and style 0 — and recording it would not restore the spill, it would
/// BREAK it: `apply_changes` puts every recorded cell back before it
/// recalculates, so the restored literals would be sitting in A2:A4 when the
/// restored `=SEQUENCE(4)` in A1 re-evaluates, `reevaluate_formula_cell` would
/// see occupied cells that are not its own spill (the map entry went with the
/// clear), and the undo would land on `#VALUE!` instead of the array. Undo
/// restores the ORIGIN, and the shared cascade re-spills it — the same route by
/// which `update_cell(A1, "")` has always undone correctly.
fn spilled_cells_owned_within(
    state: &AppState,
    sheet: usize,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> crate::CoordSet {
    let spill_ranges = state.spill_ranges.read().unwrap();
    if spill_ranges.is_empty() {
        return crate::CoordSet::default();
    }
    spill_ranges
        .iter()
        .filter(|(&(s, r, c), _)| {
            s == sheet && r >= start_row && r <= end_row && c >= start_col && c <= end_col
        })
        .flat_map(|(_, cells)| cells.iter().copied())
        .collect()
}

/// Erase cells released by [`take_spills_owned_within`] from the sheet that
/// owned them — and from the active-sheet mirror when that IS the sheet —
/// reporting each as blank so the caller's IPC reply repaints it.
///
/// `sheet` names the sheet the released cells live on; `active_sheet` names the
/// mirror. They are separate parameters and not one, because the recalculation
/// pass reaches sheets the user is not looking at: removing `(r, c)` from the
/// mirror because a BACKGROUND sheet released it would erase an unrelated cell
/// on screen. Every edit-path caller passes the same index twice, which is what
/// it always did.
fn erase_released_spill_cells(
    grid: &mut Grid,
    grids: &mut [Grid],
    active_sheet: usize,
    sheet: usize,
    released: &[(u32, u32)],
    updated_cells: &mut Vec<CellData>,
) {
    for &(r, c) in released {
        if sheet == active_sheet {
            grid.cells.remove(&(r, c));
        }
        if sheet < grids.len() {
            grids[sheet].cells.remove(&(r, c));
        }
        updated_cells.push(CellData {
            row: r,
            col: c,
            display: String::new(),
            // Empty: nothing to overflow, and text never marks.
            overflow: crate::api_types::OverflowClass::Text,
            display_color: None,
            formula: None,
            style_index: 0,
            row_span: 1,
            col_span: 1,
            // NAMED for an off-sheet erase, so Core cannot paint a background
            // sheet's blank onto the sheet on screen (the same rule
            // `mark_off_sheet_circular_cells` follows).
            sheet_index: if sheet == active_sheet { None } else { Some(sheet) },
            rich_text: None,
            accounting_layout: None,
        });
    }
}

/// Release the dynamic array the formula at `(row, col)` owns, on any sheet:
/// drop its `spill_ranges` / `spill_hosts` claims and erase the cells it gave
/// up. The tear-down half of [`apply_spill_decision`], separate only because a
/// value that is written WITHOUT evaluating a result — the `#CIRCULAR!` stamp a
/// recalculation pass writes over a cycle's members — owes the same release and
/// has no `EvalResult` to hand it.
///
/// COST on a workbook with no dynamic array: one `spill_ranges` lock and one
/// `is_empty()` (see [`take_spills_where`]).
pub(crate) fn release_origin_spill(
    state: &AppState,
    grid: &mut Grid,
    grids: &mut [Grid],
    active_sheet: usize,
    sheet: usize,
    row: u32,
    col: u32,
    updated_cells: &mut Vec<CellData>,
) {
    let released = take_spills_owned_within(state, sheet, row, col, row, col);
    erase_released_spill_cells(grid, grids, active_sheet, sheet, &released, updated_cells);
}

/// **THE ONE SPILL DECISION.** Given the raw result of ONE formula cell, decide
/// whether it spills, write whatever it spills, maintain the ownership maps,
/// and return the value the ORIGIN cell must hold.
///
/// # Why this is one function
///
/// It was three, character for character: `update_cell_impl`, the cascade's
/// `reevaluate_formula_cell` and `update_cells_batch_core` each carried their
/// own copy, and [`note_spill_block`]'s doc had to *ask* the three to stay
/// symmetric. They did not stay symmetric — only one of them consulted
/// `spill_hosts` for an own-spill target — and, worse, the RECALCULATION pass
/// (F9, Shift+F9 and every save through `calculate_before_save`) had no copy at
/// all: it wrote `EvalResult::to_cell_value()`, which collapses an array to its
/// first element. A blocked array's `#SPILL!` became a plausible number on
/// save, and a shrunk array kept its stale tail while `spill_ranges` still
/// claimed the old rectangle (§3bm). A fourth copy would have been the fourth
/// place to get it wrong, so there is now exactly one, and
/// `only_one_function_decides_a_spill` in `spill_map_tests` pins that.
///
/// # What it does, in order
///
/// 1. **Releases what this origin used to own**, through the ONE tear-down
///    (§2y), and erases the cells it gave up. This is what makes a SHRINKING
///    array correct: `=SEQUENCE(2)` where `=SEQUENCE(4)` was must leave rows 3
///    and 4 empty and unclaimed.
/// 2. **Refuses where blocked.** A target cell holding anything this origin
///    does not own means the array cannot land: the origin reports `#SPILL!`
///    and the blocker's ADDRESS is recorded for the error pane. Nothing is
///    written, so the blocker's own content is never overwritten.
/// 3. **Spills**, writing each cell with `ast: None` and style 0 (= inherit, so
///    the row/column tiers decide the display), claiming them in `spill_hosts`
///    and recording the extent in `spill_ranges`.
///
/// A scalar result takes step 1 and then clears any `#SPILL!` address the
/// origin had recorded — an array that becomes a number is no longer blocked by
/// anything, and a stale address would be named the next time it blocked.
///
/// # Sheets
///
/// `sheet` is the sheet the formula lives on; `active_sheet` is the mirror
/// (`state.grid`). Writes always land in `grids[sheet]`, and additionally in
/// the mirror when the two are the same. That separation is the whole reason
/// the recalculation pass can use this at all: it plans the WORKBOOK, and the
/// three edit-path callers were all active-sheet-bound.
///
/// Locking: takes `spill_ranges` then `spill_hosts` (the canonical order), and
/// `spill_blocks` separately — all leaf mutexes, all acquired AFTER the grid
/// guards the caller holds.
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_spill_decision(
    state: &AppState,
    grid: &mut Grid,
    grids: &mut [Grid],
    active_sheet: usize,
    sheet: usize,
    row: u32,
    col: u32,
    raw_result: &EvalResult,
    styles: &StyleRegistry,
    locale: &engine::LocaleSettings,
    updated_cells: &mut Vec<CellData>,
) -> engine::CellValue {
    // 1. The range this origin used to own dies here, whatever replaces it.
    release_origin_spill(
        state,
        grid,
        grids,
        active_sheet,
        sheet,
        row,
        col,
        updated_cells,
    );

    let (spill_rows, spill_cols) = raw_result.spill_dimensions();
    if spill_rows <= 1 && spill_cols <= 1 {
        note_spill_block(state, sheet, row, col, None);
        return raw_result.to_cell_value();
    }

    let spill_values = raw_result.to_spill_values();

    // 2. Is anything in the way? Step 1 already erased this origin's own former
    // footprint, so an occupied target is somebody else's — but `spill_hosts`
    // is still consulted, because a target claimed by a DIFFERENT origin whose
    // own re-evaluation is still ahead of us in the plan must block, and a cell
    // this origin still owns must not.
    let mut spill_blocked: Option<(u32, u32)> = None;
    for &(dr, dc, _) in &spill_values {
        if dr == 0 && dc == 0 {
            continue; // the origin itself
        }
        let target_r = row + dr;
        let target_c = col + dc;
        let occupied = sheet < grids.len()
            && grids[sheet]
                .get_cell(target_r, target_c)
                .is_some_and(|existing| existing.value != engine::CellValue::Empty);
        if occupied {
            let is_own_spill = state
                .spill_hosts
                .lock()
                .unwrap()
                .get(&(sheet, target_r, target_c))
                .is_some_and(|origin| *origin == (row, col));
            if !is_own_spill {
                spill_blocked = Some((target_r, target_c));
                break;
            }
        }
    }

    if let Some(blocker) = spill_blocked {
        note_spill_block(state, sheet, row, col, Some(blocker));
        return engine::CellValue::Error(engine::CellError::Spill);
    }

    // 3. It spills.
    note_spill_block(state, sheet, row, col, None);
    let mut new_spill_cells = Vec::new();
    {
        // RECALC COMPANION, for the same reason as `take_spills_where`: the extent is
        // a consequence of the origin's re-evaluation, and the edit or the recalc
        // command that triggered it has already decided about dirtiness.
        let claim = crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::RecalcCompanion,
        );
        let mut spill_ranges = state.spill_ranges.write(&claim).unwrap();
        let mut spill_hosts = state.spill_hosts.lock().unwrap();

        for (dr, dc, cv) in &spill_values {
            if *dr == 0 && *dc == 0 {
                continue; // the origin keeps its own formula and value
            }
            let target_r = row + dr;
            let target_c = col + dc;

            let spill_cell = engine::Cell {
                ast: None,
                value: cv.clone(),
                style_index: 0,
                rich_text: None,
            };
            if sheet < grids.len() {
                grids[sheet].set_cell(target_r, target_c, spill_cell.clone());
            }
            if sheet == active_sheet {
                grid.set_cell(target_r, target_c, spill_cell);
            }

            // Spill cells carry style 0 (= inherit), so the row/column tiers
            // decide how they are displayed. Resolved on the cell's OWN sheet.
            let effective = if sheet == active_sheet {
                grid.effective_style_index(target_r, target_c)
            } else if sheet < grids.len() {
                grids[sheet].effective_style_index(target_r, target_c)
            } else {
                0
            };
            let (display, overflow) = crate::format_cell_value_and_class(cv, styles.get(effective), locale);
            updated_cells.push(CellData {
                row: target_r,
                col: target_c,
                display,
                overflow,
                display_color: None,
                formula: None,
                style_index: 0,
                row_span: 1,
                col_span: 1,
                sheet_index: if sheet == active_sheet { None } else { Some(sheet) },
                rich_text: None,
                accounting_layout: None,
            });

            new_spill_cells.push((target_r, target_c));
            spill_hosts.insert((sheet, target_r, target_c), (row, col));
        }

        if !new_spill_cells.is_empty() {
            spill_ranges.insert((sheet, row, col), new_spill_cells);
        }
    }

    raw_result.to_cell_value()
}

/// User-facing name of a protected region's owner object.
fn region_display_name(region_type: &str) -> &str {
    match region_type {
        "pivot" => "pivot table",
        "report" => "report",
        other => other,
    }
}

/// Reject a write when the RANGE intersects any protected object-output region
/// (pivot table, grid report, ...). Mirrors the single-cell check in
/// `update_cell_impl` for the range/batch surfaces (paste, fill, delete-key
/// clear) — an object's output can only be changed through the object itself.
fn check_region_range_protection(
    state: &AppState,
    sheet_index: usize,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<(), String> {
    let regions = state.protected_regions.lock().unwrap();
    if let Some(region) = regions.iter().find(|r| {
        r.sheet_index == sheet_index
            && r.start_row <= end_row
            && r.end_row >= start_row
            && r.start_col <= end_col
            && r.end_col >= start_col
    }) {
        let what = region_display_name(&region.region_type);
        return Err(format!(
            "Cannot change these cells: the range overlaps a {}. Use the {}'s own tools (refresh, edit, delete) to modify it.",
            what, what
        ));
    }
    Ok(())
}

/// Reject a batch write when ANY of its target cells lies inside a protected
/// object-output region. One region-list lock for the whole batch; skips the
/// scan entirely when the active sheet has no regions.
pub(crate) fn check_region_cells_protection<'a>(
    state: &AppState,
    sheet_index: usize,
    mut cells: impl Iterator<Item = (u32, u32)> + 'a,
) -> Result<(), String> {
    let regions = state.protected_regions.lock().unwrap();
    let sheet_regions: Vec<&crate::ProtectedRegion> = regions
        .iter()
        .filter(|r| r.sheet_index == sheet_index)
        .collect();
    if sheet_regions.is_empty() {
        return Ok(());
    }
    if let Some((row, col, region)) = cells.find_map(|(row, col)| {
        sheet_regions
            .iter()
            .find(|r| {
                row >= r.start_row && row <= r.end_row && col >= r.start_col && col <= r.end_col
            })
            .map(|r| (row, col, *r))
    }) {
        let what = region_display_name(&region.region_type);
        return Err(format!(
            "Cannot change cell ({}, {}): it is part of a {}. Use the {}'s own tools (refresh, edit, delete) to modify it.",
            row + 1,
            col + 1,
            what,
            what
        ));
    }
    Ok(())
}

/// Get spill ranges for the active sheet.
/// Returns the bounding box of each spill range for visual rendering.
#[tauri::command]
pub fn get_spill_ranges(state: State<AppState>) -> Vec<SpillRangeInfo> {
    let active_sheet = *state.active_sheet.read().unwrap();
    let spill_ranges = state.spill_ranges.read().unwrap();
    let mut result = Vec::new();

    for (&(sheet_idx, origin_row, origin_col), spill_cells) in spill_ranges.iter() {
        if sheet_idx != active_sheet {
            continue;
        }
        let mut end_row = origin_row;
        let mut end_col = origin_col;
        for &(sr, sc) in spill_cells {
            end_row = end_row.max(sr);
            end_col = end_col.max(sc);
        }
        result.push(SpillRangeInfo {
            origin_row,
            origin_col,
            end_row,
            end_col,
        });
    }

    result
}

/// Get cells for a viewport range.
/// Now includes merged cell span information.
#[tauri::command]
pub fn get_viewport_cells(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Vec<CellData> {
    use std::collections::HashMap;
    use std::time::Instant;
    let perf_t0 = Instant::now();

    let grid = state.grid.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let protection = state.sheet_protection.read().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();
    // One probe for the whole viewport: formula hiding only bites on a
    // protected sheet, so an unprotected one skips the per-cell check entirely.
    let sheet_protected = {
        // Deref-and-drop: no guard is held across the grid locks above.
        let active = *state.active_sheet.read().unwrap();
        protection.get(&active).map(|p| p.protected).unwrap_or(false)
    };
    let perf_t1_locks = Instant::now();

    // Build O(1) merge lookup by master cell (same pattern as update_cells_batch)
    let merge_lookup: HashMap<(u32, u32), &MergedRegion> = merged_regions
        .iter()
        .map(|r| ((r.start_row, r.start_col), r))
        .collect();

    // Track which cells are "slave" cells (part of a merge but not the master)
    let mut slave_cells: HashSet<(u32, u32)> = HashSet::new();

    // First pass: identify all slave cells within the viewport
    for region in merged_regions.iter() {
        // Check if this region overlaps with the viewport
        if region.end_row < start_row
            || region.start_row > end_row
            || region.end_col < start_col
            || region.start_col > end_col
        {
            continue;
        }

        // Mark all cells except the master as slaves
        for r in region.start_row..=region.end_row {
            for c in region.start_col..=region.end_col {
                if r == region.start_row && c == region.start_col {
                    continue; // Skip master cell
                }
                slave_cells.insert((r, c));
            }
        }
    }

    let mut cells = Vec::new();

    for row in start_row..=end_row {
        for col in start_col..=end_col {
            // Skip slave cells - they shouldn't be returned
            if slave_cells.contains(&(row, col)) {
                continue;
            }

            // O(1) merge span lookup instead of linear scan
            let (row_span, col_span) = if let Some(region) = merge_lookup.get(&(row, col)) {
                (
                    region.end_row - region.start_row + 1,
                    region.end_col - region.start_col + 1,
                )
            } else {
                (1, 1)
            };

            let cell = grid.get_cell(row, col);

            // The style that actually applies here, honouring the row/column
            // tiers. Resolved once and used for BOTH value formatting and the
            // index handed to the frontend, so the renderer needs no knowledge
            // of the tiers at all.
            let effective_style_index = grid.effective_style_index(row, col);

            // An empty cell is still worth sending when a row or column style
            // gives it an appearance — otherwise a styled column would be
            // invisible everywhere it has no data.
            if cell.is_none() && row_span == 1 && col_span == 1 && effective_style_index == 0 {
                continue;
            }

            let (display, display_color, formula, style_index, rich_text, accounting_layout, overflow) = if let Some(c) = cell {
                let style = styles.get(effective_style_index);
                let result = crate::format_cell_value_with_color(&c.value, style, &locale);
                let rt = c.rich_text.as_ref().map(|runs| {
                    crate::api_types::rich_text_runs_to_data(runs)
                });
                let acct = result.accounting.map(|a| crate::api_types::AccountingLayout {
                    symbol: a.symbol,
                    symbol_before: a.symbol_before,
                    value: a.value,
                });
                // Withhold the formula for cells marked hidden on a protected
                // sheet. Value and formatting still render.
                let formula = if sheet_protected
                    && styles.get(effective_style_index).formula_hidden
                {
                    None
                } else {
                    formula_display(&c, &locale)
                };
                (result.text, result.color, formula, effective_style_index, rt, acct, result.overflow)
            } else {
                (String::new(), None, None, effective_style_index, None, None, crate::api_types::OverflowClass::Text)
            };

            cells.push(CellData {
                row,
                col,
                display,
                overflow,
                display_color,
                formula,
                style_index,
                row_span,
                col_span,
                sheet_index: None,
                rich_text,
                accounting_layout,
            });
        }
    }

    let perf_tend = Instant::now();
    let lock_ms = perf_t1_locks.duration_since(perf_t0).as_secs_f64() * 1000.0;
    let process_ms = perf_tend.duration_since(perf_t1_locks).as_secs_f64() * 1000.0;
    let total_ms = perf_tend.duration_since(perf_t0).as_secs_f64() * 1000.0;
    if total_ms > 5.0 {
        log_perf!("VIEWPORT",
            "get_viewport_cells({},{})..({},{}) => {} cells | lock_wait={:.2}ms process={:.2}ms TOTAL={:.2}ms",
            start_row, start_col, end_row, end_col, cells.len(),
            lock_ms, process_ms, total_ms
        );
    }

    cells
}

/// Get a single cell's data.
#[tauri::command]
pub fn get_cell(state: State<AppState>, row: u32, col: u32) -> Option<CellData> {
    let active_sheet = *state.active_sheet.read().unwrap();
    let grid = state.grid.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let protection = state.sheet_protection.read().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();
    // Withhold the formula when the sheet is protected and the cell is marked
    // hidden — the value and formatting still come through.
    let hide = crate::protection::formula_is_hidden(
        &protection, &grid, &styles, active_sheet, row, col,
    );
    crate::commands::utils::get_cell_internal_with_merge_hiding(
        &grid, &styles, &merged_regions, row, col, &locale, hide,
    )
}

/// Maximum cells one typed range read may cover. Mirrors the script broker's
/// `api.updateCellsBatch` ceiling so bulk read and bulk write share one limit.
pub const MAX_TYPED_RANGE_CELLS: usize = 100_000;

/// Map an engine `CellValue` to the (type, JSON value) pair of `TypedCellData`.
/// `display` is only consulted for collection cells, which have no JSON scalar
/// form. A non-finite number (NaN / infinity) has no JSON representation either
/// and surfaces as type "number" with a null value.
fn typed_cell_value(
    value: &engine::CellValue,
    display: &str,
) -> (&'static str, serde_json::Value) {
    match value {
        engine::CellValue::Empty => ("empty", serde_json::Value::Null),
        engine::CellValue::Number(n) => (
            "number",
            serde_json::Number::from_f64(*n)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null),
        ),
        engine::CellValue::Text(s) => ("text", serde_json::Value::String(s.clone())),
        engine::CellValue::Boolean(b) => ("boolean", serde_json::Value::Bool(*b)),
        engine::CellValue::Error(e) => (
            "error",
            serde_json::Value::String(
                crate::scripting::udf::cell_error_to_str(e).to_string(),
            ),
        ),
        engine::CellValue::List(_) | engine::CellValue::Dict(_) => {
            ("text", serde_json::Value::String(display.to_string()))
        }
    }
}

/// Read a rectangle of cells with their VALUE TYPES preserved, in ONE call.
///
/// This is the typed counterpart of `get_viewport_cells`: scripts and other
/// bulk consumers need to tell the number 5 from the text "5", read a formula
/// without clobbering it on write-back, and detect an error as an error — none
/// of which the display-string shape can express.
///
/// SPARSE: only cells that exist in the grid are returned; the caller fills the
/// rectangle. `sheet_index` defaults to the active sheet (whose live grid is
/// `state.grid` — `grids[active_sheet]` is stale). Formula hiding on a protected
/// sheet applies exactly as it does in `get_cell`.
#[tauri::command]
pub fn get_range_cells_typed(
    state: State<AppState>,
    sheet_index: Option<usize>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<Vec<crate::api_types::TypedCellData>, String> {
    range_cells_typed(&state, sheet_index, start_row, start_col, end_row, end_col)
}

/// The body of [`get_range_cells_typed`] over a plain reference, so the tests
/// drive the real read with no Tauri runtime.
pub(crate) fn range_cells_typed(
    state: &AppState,
    sheet_index: Option<usize>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<Vec<crate::api_types::TypedCellData>, String> {
    if end_row < start_row || end_col < start_col {
        return Err("invalid range: end before start".to_string());
    }
    let rows = (end_row - start_row) as usize + 1;
    let cols = (end_col - start_col) as usize + 1;
    let count = rows.saturating_mul(cols);
    if count > MAX_TYPED_RANGE_CELLS {
        return Err(format!(
            "range too large: {} cells (max {})",
            count, MAX_TYPED_RANGE_CELLS
        ));
    }

    let active_sheet = *state.active_sheet.read().unwrap();
    let target_sheet = sheet_index.unwrap_or(active_sheet);
    let active_grid = state.grid.read().unwrap();
    let grids = state.grids.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let protection = state.sheet_protection.read().unwrap();
    let locale = state.locale.lock().unwrap();

    let grid: &Grid = if target_sheet == active_sheet {
        &active_grid
    } else if target_sheet < grids.len() {
        &grids[target_sheet]
    } else {
        return Err(format!("sheet index out of range: {}", target_sheet));
    };

    let mut out: Vec<crate::api_types::TypedCellData> = Vec::new();
    for row in start_row..=end_row {
        for col in start_col..=end_col {
            let Some(cell) = grid.get_cell(row, col) else {
                continue;
            };
            let style = styles.get(grid.effective_style_index(row, col));
            let display = format_cell_value(&cell.value, style, &locale);
            let (kind, value) = typed_cell_value(&cell.value, &display);
            let hide = crate::protection::formula_is_hidden(
                &protection,
                grid,
                &styles,
                target_sheet,
                row,
                col,
            );
            let stored_formula = formula_display(cell, &locale);
            // WITHHELD: the cell holds a formula this read does not return. A
            // hidden-format cell holding a constant or nothing withholds
            // nothing -- an operation paste may compute over it (Excel does).
            let formula_withheld = hide && stored_formula.is_some();
            let formula = if hide {
                None
            } else {
                stored_formula
            };
            // A style-only cell (no value, no formula) adds nothing the caller's
            // empty fill does not already say — keep the payload sparse. A
            // withheld formula is never "nothing", whatever it evaluates to.
            if kind == "empty" && formula.is_none() && !formula_withheld && display.is_empty() {
                continue;
            }
            out.push(crate::api_types::TypedCellData {
                row,
                col,
                value,
                display,
                formula,
                formula_withheld,
                r#type: kind.to_string(),
            });
        }
    }
    Ok(out)
}

/// Batch-get cell display values from arbitrary sheets (for Watch Window).
/// Takes a list of (sheetIndex, row, col) and returns parallel list of results.
/// Note: grids[active_sheet] is stale; we use state.grid for the active sheet.
#[tauri::command]
pub fn get_watch_cells(
    state: State<AppState>,
    requests: Vec<(usize, u32, u32)>,
) -> Vec<Option<CellData>> {
    let active_grid = state.grid.read().unwrap();
    let grids = state.grids.read().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let locale = state.locale.lock().unwrap();

    fn read_cell(
        grid: &Grid,
        styles: &StyleRegistry,
        sheet_index: usize,
        row: u32,
        col: u32,
        locale: &engine::LocaleSettings,
    ) -> Option<CellData> {
        grid.get_cell(row, col).map(|c| {
            let style = styles.get(grid.effective_style_index(row, col));
            let r = crate::format_cell_value_with_color(&c.value, style, locale);
            CellData {
                row,
                col,
                display: r.text, overflow: r.overflow,
                display_color: r.color,
                formula: formula_display(&c, locale),
                style_index: grid.effective_style_index(row, col),
                row_span: 1,
                col_span: 1,
                sheet_index: Some(sheet_index),
                rich_text: None,
                accounting_layout: None,
            }
        })
    }

    requests
        .iter()
        .map(|&(sheet_index, row, col)| {
            if sheet_index == active_sheet {
                read_cell(&active_grid, &styles, sheet_index, row, col, &locale)
            } else if sheet_index < grids.len() {
                read_cell(&grids[sheet_index], &styles, sheet_index, row, col, &locale)
            } else {
                None
            }
        })
        .collect()
}

/// Get the structured contents of a List or Dict cell for preview.
///
/// The preview is DISPLAY text, so its numbers (scalars and number keys) read
/// in the app locale (P2 S5). The clipboard twin, `get_collection_texts`,
/// stays JSON: machine text, invariant on purpose.
#[tauri::command]
pub fn get_cell_collection(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> crate::api_types::CollectionPreviewResult {
    // The app locale first (leaf lock: take, clone, drop), before the grid.
    let locale = state.locale.lock().map(|g| g.clone()).unwrap_or_else(|e| e.into_inner().clone());
    let grid = state.grid.read().unwrap();
    collection_preview(grid.get_cell(row, col).map(|cell| &cell.value), &locale)
}

/// The preview of one cell's value: a List or a Dict, else "none".
pub(crate) fn collection_preview(
    value: Option<&engine::cell::CellValue>,
    locale: &engine::LocaleSettings,
) -> crate::api_types::CollectionPreviewResult {
    use crate::api_types::{CollectionEntry, CollectionItem, CollectionPreviewResult};
    use engine::cell::{CellValue, DictKey};

    fn number_display(n: f64, locale: &engine::LocaleSettings) -> String {
        crate::format_cell_value_display(&CellValue::Number(n), locale)
    }

    fn key_display(k: &DictKey, locale: &engine::LocaleSettings) -> String {
        match k {
            DictKey::Text(s) => format!("\"{}\"", s),
            DictKey::Number(n) => number_display(*n, locale),
            DictKey::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        }
    }

    fn entries_of(
        entries: &[(DictKey, CellValue)],
        depth: usize,
        locale: &engine::LocaleSettings,
    ) -> Vec<CollectionEntry> {
        entries
            .iter()
            .map(|(k, v)| CollectionEntry {
                key: key_display(k, locale),
                value: cell_value_to_item(v, depth, locale),
            })
            .collect()
    }

    fn cell_value_to_item(val: &CellValue, depth: usize, locale: &engine::LocaleSettings) -> CollectionItem {
        if depth > 32 {
            return CollectionItem::Scalar {
                display: "...".to_string(),
            };
        }
        match val {
            CellValue::List(items) => CollectionItem::List {
                count: items.len(),
                items: items.iter().map(|i| cell_value_to_item(i, depth + 1, locale)).collect(),
            },
            CellValue::Dict(entries) => CollectionItem::Dict {
                count: entries.len(),
                entries: entries_of(entries, depth + 1, locale),
            },
            CellValue::Empty => CollectionItem::Scalar {
                display: String::new(),
            },
            CellValue::Number(n) => CollectionItem::Scalar {
                display: number_display(*n, locale),
            },
            CellValue::Text(s) => CollectionItem::Scalar {
                display: format!("\"{}\"", s),
            },
            CellValue::Boolean(b) => CollectionItem::Scalar {
                display: if *b { "TRUE" } else { "FALSE" }.to_string(),
            },
            CellValue::Error(e) => CollectionItem::Scalar {
                display: crate::cell_error_display(e),
            },
        }
    }

    match value {
        Some(CellValue::List(items)) => CollectionPreviewResult {
            cell_type: "list".to_string(),
            root: Some(CollectionItem::List {
                count: items.len(),
                items: items.iter().map(|i| cell_value_to_item(i, 0, locale)).collect(),
            }),
        },
        Some(CellValue::Dict(entries)) => CollectionPreviewResult {
            cell_type: "dict".to_string(),
            root: Some(CollectionItem::Dict {
                count: entries.len(),
                entries: entries_of(entries, 0, locale),
            }),
        },
        _ => CollectionPreviewResult {
            cell_type: "none".to_string(),
            root: None,
        },
    }
}

/// Batch-get JSON text representations for collection cells.
/// Input: list of {row, col} coordinates.
/// Output: parallel list of JSON strings (empty string for non-collection cells).
/// Used by the clipboard system to serialize List/Dict cells for the system clipboard.
#[tauri::command]
pub fn get_collection_texts(
    state: State<AppState>,
    cells: Vec<(u32, u32)>,
) -> Vec<String> {
    use engine::cell::{CellValue, DictKey};

    let grid = state.grid.read().unwrap();

    fn cell_value_to_json(val: &CellValue, depth: usize) -> serde_json::Value {
        if depth > 32 {
            return serde_json::Value::String("...".to_string());
        }
        match val {
            CellValue::Number(n) => {
                serde_json::Value::Number(serde_json::Number::from_f64(*n).unwrap_or(serde_json::Number::from(0)))
            }
            CellValue::Text(s) => serde_json::Value::String(s.clone()),
            CellValue::Boolean(b) => serde_json::Value::Bool(*b),
            CellValue::Empty => serde_json::Value::Null,
            CellValue::Error(e) => serde_json::Value::String(crate::cell_error_display(e)),
            CellValue::List(items) => {
                let arr: Vec<serde_json::Value> = items.iter().map(|i| cell_value_to_json(i, depth + 1)).collect();
                serde_json::Value::Array(arr)
            }
            CellValue::Dict(entries) => {
                let mut map = serde_json::Map::new();
                for (k, v) in entries.iter() {
                    let key = match k {
                        DictKey::Text(s) => s.clone(),
                        DictKey::Number(n) => {
                            if n.fract() == 0.0 && n.abs() < 1e15 {
                                format!("{:.0}", n)
                            } else {
                                format!("{}", n)
                            }
                        }
                        DictKey::Boolean(b) => if *b { "true" } else { "false" }.to_string(),
                    };
                    map.insert(key, cell_value_to_json(v, depth + 1));
                }
                serde_json::Value::Object(map)
            }
        }
    }

    cells.iter().map(|(row, col)| {
        match grid.get_cell(*row, *col) {
            Some(cell) => match &cell.value {
                CellValue::List(_) | CellValue::Dict(_) => {
                    let json_val = cell_value_to_json(&cell.value, 0);
                    serde_json::to_string(&json_val).unwrap_or_default()
                }
                _ => String::new(),
            },
            None => String::new(),
        }
    }).collect()
}

/// Internal helper for getting cell data without merge info (for backward compatibility).
#[allow(dead_code)]
fn get_cell_internal(grid: &Grid, styles: &StyleRegistry, row: u32, col: u32, locale: &engine::LocaleSettings) -> Option<CellData> {
    let cell = grid.get_cell(row, col)?;
    let style = styles.get(grid.effective_style_index(row, col));
    let (display, overflow) = crate::format_cell_value_and_class(&cell.value, style, locale);

    Some(CellData {
        row,
        col,
        display,
        overflow,
        display_color: None,
        formula: formula_display(&cell, locale),
        style_index: grid.effective_style_index(row, col),
        row_span: 1,
        col_span: 1,
        sheet_index: None,
        rich_text: cell.rich_text.as_ref().map(|runs| {
            crate::api_types::rich_text_runs_to_data(runs)
        }),
        accounting_layout: None,
    })
}

/// Update a cell with new content.
/// Returns all cells that were updated (including dependent cells),
/// plus any dimension changes triggered by UI formulas.
///
/// Thin command wrapper: the body lives in `update_cell_impl`. Afterwards, if
/// the edited cell is the ANCHOR of a NAMED on-grid control (a control whose
/// properties carry a static "name"), the shared targeted control recalc
/// refreshes GET.CONTROLVALUE("name") dependents — the dependency maps carry
/// no control-name -> formula-cell edges, so the main cascade cannot see
/// them. The anchor probe costs one HashMap lookup on the hot path; the
/// recalc core acquires its own locks (every guard of `update_cell_impl` has
/// dropped by then) and cannot recurse by construction — it only re-evaluates
/// formulas (reevaluate_formula_cell / recalculate_sheet_values) and never
/// re-enters update_cell or this anchor check.
#[tauri::command]
pub fn update_cell(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    slicer_state: State<SlicerState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    row: u32,
    col: u32,
    value: String,
    udf_results: Option<std::collections::HashMap<String, crate::scripting::udf::UdfValue>>,
    udf_volatile_cells: Option<Vec<crate::scripting::udf::UdfCellRef>>,
    cube_results: Option<engine::CubePrefetch>,
    // A GROUPED entry: the OTHER grouped sheets to replicate the entry to, in
    // the same call and the same undo step (see `update_cell_grouped`), and
    // their cube data aligned with them (`update_cell_on_sheets`'s rule).
    group_sheets: Option<Vec<usize>>,
    group_cube_results: Option<Vec<engine::CubePrefetch>>,
) -> Result<UpdateCellResult, String> {
    if let Some(group) = group_sheets.filter(|g| !g.is_empty()) {
        return update_cell_grouped(
            &state,
            &file_state,
            &user_files_state,
            &slicer_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
            row,
            col,
            value,
            udf_results,
            udf_volatile_cells,
            cube_results,
            group,
            group_cube_results,
        );
    }
    update_cell_core(
        &state,
        &file_state,
        &user_files_state,
        &slicer_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        row,
        col,
        value,
        udf_results,
        udf_volatile_cells,
        cube_results,
    )
}

/// A GROUPED entry as ONE backend call (misc19, round 19): the edit's own
/// sheet through `update_cell_core`, then every other grouped sheet through
/// `update_cell_on_sheets_inner`, inside ONE undo transaction this call opens
/// and closes itself. The frontend used to open that transaction, then await
/// `update_cell`, an event emit and `update_cell_on_sheets` before closing it,
/// so any write that landed in that window (a scheduled job, a script, an AI
/// tool, a listener of the emit) joined "Typing on grouped sheets" and one
/// Ctrl+Z undid it too. Excel [LIVE, whatif4 round 16]: one Ctrl+Z undoes the
/// whole grouped entry and lands on the sheet active at it -- the edit's own
/// sheet is recorded first, so it is restored last and the undo lands there.
///
/// A REFUSED REPLICATION (a grouped sheet protects the cell, a writeback claim,
/// a spill) leaves the edit's own sheet written, as before, and is answered in
/// `group_error`, never as an `Err` of a call whose first write happened. The
/// transaction is closed on every path (`commit_owned`; a caller that already
/// holds one open is joined, never closed).
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_cell_grouped(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    slicer_state: &SlicerState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    row: u32,
    col: u32,
    value: String,
    udf_results: Option<std::collections::HashMap<String, crate::scripting::udf::UdfValue>>,
    udf_volatile_cells: Option<Vec<crate::scripting::udf::UdfCellRef>>,
    cube_results: Option<engine::CubePrefetch>,
    group_sheets: Vec<usize>,
    group_cube_results: Option<Vec<engine::CubePrefetch>>,
) -> Result<UpdateCellResult, String> {
    // The undo lock is taken and RELEASED around the step's begin and commit:
    // both writes below take it again themselves.
    let transaction = {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_owned_transaction("Typing on grouped sheets")
    };
    let outcome = update_cell_core(
        state,
        file_state,
        user_files_state,
        slicer_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        row,
        col,
        value.clone(),
        udf_results,
        udf_volatile_cells,
        cube_results,
    )
    .map(|mut result| {
        match update_cell_on_sheets_inner(
            state,
            file_state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            group_sheets,
            row,
            col,
            value,
            None,
            None,
            group_cube_results,
        ) {
            Ok(wrote) => result.group_written = Some(wrote),
            Err(e) => result.group_error = Some(e),
        }
        result
    });
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.commit_owned(transaction);
    }
    outcome
}

/// The body of [`update_cell`] for one entry on the active sheet (and the
/// control-anchor recalculation it owes), over plain references.
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_cell_core(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    slicer_state: &SlicerState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    row: u32,
    col: u32,
    value: String,
    udf_results: Option<std::collections::HashMap<String, crate::scripting::udf::UdfValue>>,
    udf_volatile_cells: Option<Vec<crate::scripting::udf::UdfCellRef>>,
    cube_results: Option<engine::CubePrefetch>,
) -> Result<UpdateCellResult, String> {
    // Anchor probe BEFORE the edit (the name lives in the control's
    // properties, not the cell, so before/after is equivalent — probing first
    // keeps the hot path front-loaded and branch-free afterwards).
    let anchor_control_name = named_control_anchor_name(&state, row, col);

    let mut result = update_cell_impl(
        &state,
        &file_state,
        &user_files_state,
        &slicer_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        row,
        col,
        value,
        udf_results,
        udf_volatile_cells,
        cube_results,
    )?;

    if let Some(name) = anchor_control_name {
        let extra = crate::control_values::recalc_control_dependents_core(
            &state,
            &user_files_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
            Some(vec![name]),
        )?;
        result.cells.extend(extra);
    }

    Ok(result)
}

/// One-probe hot-path lookup: the static, non-empty "name" of the on-grid
/// control anchored at (active_sheet, row, col), or None (the overwhelmingly
/// common case — a single HashMap probe under a brief lock).
fn named_control_anchor_name(state: &AppState, row: u32, col: u32) -> Option<String> {
    let active_sheet = *state.active_sheet.read().unwrap();
    let controls = state.controls.read().unwrap();
    controls
        .get(&(active_sheet, row, col))
        .and_then(crate::control_values::static_control_name)
}

/// Body of `update_cell` — every lock is acquired AND dropped inside, so the
/// command wrapper can run the named-anchor control recalc afterwards without
/// lock re-entry. `pub(crate)` so the style tests (format_home_tests.rs) can
/// type into a formatted line through the REAL entry path (BUG-0354).
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_cell_impl(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    slicer_state: &SlicerState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    row: u32,
    col: u32,
    value: String,
    udf_results: Option<std::collections::HashMap<String, crate::scripting::udf::UdfValue>>,
    udf_volatile_cells: Option<Vec<crate::scripting::udf::UdfCellRef>>,
    cube_results: Option<engine::CubePrefetch>,
) -> Result<UpdateCellResult, String> {
    // WRITEBACK ANTI-BYPASS (authoritative backstop). A cell claimed by a
    // PUBLISHED .calp writeback region is the publisher's input form: its value
    // must pass `calp_save_writeback_draft` (schema + lifecycle + one-shot
    // rules) before it may appear in the grid. The interactive editor's commit
    // guard drafts first and only then commits, so it passes here; a script
    // reaching `update_cell` directly does not, unless it went through
    // `script_writeback` action `cellGuard`. Short-circuits on an empty
    // writeback index, so a normal workbook pays one lock.
    crate::calp_commands::ensure_writeback_draft_before_write(state, row, col)?;

    // PERF-03: one lookup-index cache for the whole pass (lookup_cache.rs).
    let _lookup_pass = engine::begin_lookup_pass();
    // SUBTOTAL/AGGREGATE row-visibility snapshot: built ONCE for this
    // pass (never per formula) and read by the evaluator through the
    // thread-local pass scope. Built BEFORE any grid lock is taken.
    let _visibility_pass = crate::row_visibility::begin_pass(state);
    // THE INTERACTIVE SURFACE. This edit and every dependent it cascades into
    // gets `DEFAULT_CELL_FUEL` — the reference ceiling that every other
    // cell-writing surface is defined as EQUAL to, so a formula's value never
    // depends on which code path last recalculated it. Cancellable through the
    // workbook token, so an edit that turns out to trigger an enormous cascade
    // can still be stopped.
    //
    // Also: an edit that recalculates a cell removes it from any pending set a
    // cancelled pass left behind, so the stale marker shrinks as the user works
    // rather than lying about cells that are now fresh.
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Interactive,
        &state.calc_cancel,
    );
    // RECALC COMPANION: this drops a cell from the stale set BECAUSE it was just
    // re-evaluated, which is the recalculation's own bookkeeping.
    let recalc = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::RecalcCompanion,
    );
    if let Ok(mut pending) = state.pending_recalc.write(&recalc) {
        if let Some(pr) = pending.as_mut() {
            pr.remove_cell(row, col);
            if pr.is_empty() {
                *pending = None;
            }
        }
    }
    use std::time::Instant;
    let perf_t0 = Instant::now();

    // Build the apply-time UDF resolver from the pre-fetched results table (if
    // any). When the frontend omits udfResults, this is None -> behavior is
    // identical to before (the engine emits #NAME? for any UDF call).
    let udf_resolver = udf_results.as_ref().map(|t| crate::scripting::udf::make_udf_resolver(t));

    // Pre-fetched CUBE data (CUBEVALUE/CUBEMEMBER/...) for this edit, resolved by
    // the async `cube_prefetch` command before this synchronous recalc. Shared via
    // Arc so the main eval and the dependent-recalc cascade both serve it cheaply.
    let cube_arc = cube_results.map(std::sync::Arc::new);

    // GET.CONTROLVALUE snapshot: built ONCE per edit, BEFORE the grid locks
    // below (canonical lock order: control stores first, grids last). Shared
    // via Arc by the main eval and the dependent-recalc cascade.
    let control_values = crate::control_values::build_control_values(
        &state, &pane_control_state, &ribbon_filter_state,
    );

    // NOTE: user files (FILEREAD/FILELINES/FILEEXISTS) are locked BELOW, after
    // the grid locks. They used to be locked here, which held them across the
    // `state.grid` acquisition -- the inverted order, because the recalculation
    // pass holds both grid locks and then takes `files` on a background thread.

    // Check sheet protection: a locked cell on a protected sheet is refused.
    let active_sheet_for_region_check = *state.active_sheet.read().unwrap();
    crate::protection::check_sheet_protection_cells(
        &state,
        active_sheet_for_region_check,
        std::iter::once((row, col)),
    )?;

    // Check if cell is in a protected region (e.g., pivot table, chart)
    if let Some(region) = state.get_region_at_cell(active_sheet_for_region_check, row, col) {
        return Err(format!(
            "Cannot edit cell ({}, {}): it is part of a protected {} region (id: {}).",
            row + 1,
            col + 1,
            region.region_type,
            region.id
        ));
    }

    // Check if cell is a spill cell (part of a dynamic array result)
    {
        let spill_hosts = state.spill_hosts.lock().unwrap();
        if let Some((origin_r, origin_c)) = spill_hosts.get(&(active_sheet_for_region_check, row, col)) {
            return Err(format!(
                "Cannot edit cell ({}, {}): it contains a spilled array value from cell ({}, {}). Edit or delete the formula in the source cell instead.",
                row + 1, col + 1, origin_r + 1, origin_c + 1
            ));
        }
    }

    // Every gate above has passed; from here this command commits. Constructed
    // HERE and not at the top so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    // CANONICAL LOCK ORDER: both grid locks FIRST, then everything else.
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let user_files = user_files_state.files.lock().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let mut styles = state.style_registry.write(&effect).unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    // DEFINED-NAME edges. Locked in the same phase as the other dependency maps
    // and in declaration order, so the canonical lock order stays one sequence.
    let mut name_dependents_map = state.name_dependents.lock().unwrap();
    let mut name_dependencies_map = state.name_dependencies.lock().unwrap();
    let mut table_dependents_map = state.table_dependents.lock().unwrap();
    let mut table_dependencies_map = state.table_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let calc_mode = state.calculation_mode.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    // Lock pivot state for GETPIVOTDATA support
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let pivot_views = pivot_state.views.lock().unwrap();
    let pivot_data_fn = |data_field: &str, pivot_sheet: Option<&str>, pivot_row: u32, pivot_col: u32, pairs: &[(&str, &str)]| -> Option<f64> {
        crate::pivot::operations::lookup_pivot_data(
            &pivot_tables,
            &pivot_views,
            data_field,
            pivot_sheet,
            pivot_row,
            pivot_col,
            pairs,
        )
    };

    // Pre-fetch writeback submissions so GATHER formulas see current data
    // (empty map, no registry I/O, when the workbook has no writeback regions).
    let gather_data = crate::calp_commands::build_gather_data(&state);
    let gather_fn = |region_id: &str| -> engine::GatherRegionData {
        gather_data.get(region_id).cloned().unwrap_or_default()
    };

    let perf_t1_locks = Instant::now();

    let mut updated_cells = Vec::new();
    let mut dimension_changes: Vec<DimensionData> = Vec::new();
    let mut needs_style_refresh = false;

    // Record previous state for undo BEFORE making any changes
    let previous_cell = grid.get_cell(row, col).cloned();

    // ---- THE SPILL THIS CELL USED TO OWN DIES HERE, WHATEVER REPLACES IT ---
    //
    // ONE release for every branch below, hoisted out of them (§2y). It used to
    // sit in TWO places — the empty-value branch, and deep inside
    // `if let Some(formula) = ... { match parser::parse(&formula) { Ok(..) =>`
    // — which left two ways to overwrite a spill ORIGIN and keep its claim:
    //
    //   * type a LITERAL over it (`7` where `=SEQUENCE(4)` was). No formula, so
    //     neither branch ran; A2:A4 kept showing 2 3 4 that nothing produced,
    //     uneditable and undeletable for the session. §2y through the command
    //     the register named as the map's one correct maintainer.
    //   * type a formula that does not PARSE. Same leak, one level deeper.
    //
    // Hoisting also fixes an ORDER-DEPENDENT value, which is the worse half.
    // The formula branch released the old range AFTER evaluating the new
    // formula, so `=A2*10` typed over the origin of a spill covering A2 read
    // the OLD spilled 2 and stored 20 — then erased A2. Recalculating the same
    // workbook produced 0. A number that depends on the order the edit happened
    // to run in is precisely what the recalculation work exists to eliminate;
    // the array ceases to exist the moment its formula is replaced, so the new
    // formula must evaluate against cells that are already empty.
    {
        let released = take_spills_owned_within(&state, active_sheet, row, col, row, col);
        erase_released_spill_cells(
            &mut grid,
            &mut grids,
            active_sheet,
            active_sheet,
            &released,
            &mut updated_cells,
        );
    }

    // ---- CLEAR AND WRITE BOTH FALL THROUGH TO THE ONE CASCADE -------------
    //
    // The clear branch used to `return Ok(...)` at the end of this block --
    // BEFORE the recalculation below -- so clearing a cell left every dependent
    // holding its old value. Measured, not inferred: A1 = 5 and B1 = `=A1+1`
    // reads 6; press Delete on A1 and B1 still reads 6, where Excel reads 1.
    // The stale number is not merely displayed, it is what the next save
    // writes, and Delete is the single most-used editing key there is.
    //
    // The two branches are alternatives, not an early exit: each does its own
    // grid write, dependency-map maintenance, `updated_cells` entry, override
    // record and undo entry, and then BOTH reach the cascade. Nothing else in
    // this function distinguishes them -- which is the point, because a second
    // exit from a function that owns the cascade is how the cascade got skipped
    // in the first place.
    let clearing = value.trim().is_empty();
    // Hoisted out of the write branch so the perf line below has them on both
    // paths.
    let perf_t2_parsed;
    let perf_t3_stored;

    if clearing {
        grid.clear_cell(row, col);
        // Also update the grids vector
        if active_sheet < grids.len() {
            grids[active_sheet].clear_cell(row, col);
        }
        // Clear cross-sheet dependencies for this cell
        update_cross_sheet_dependencies(
            (active_sheet, row, col),
            Default::default(),
            &mut cross_sheet_dependencies_map,
            &mut cross_sheet_dependents_map,
        );
        update_dependencies(
            (row, col),
            Default::default(),
            &mut dependencies_map,
            &mut dependents_map,
        );
        update_column_dependencies(
            (row, col),
            Default::default(),
            &mut column_dependencies_map,
            &mut column_dependents_map,
        );
        update_row_dependencies(
            (row, col),
            Default::default(),
            &mut row_dependencies_map,
            &mut row_dependents_map,
        );
        crate::name_resolution::update_name_dependencies(
            (row, col),
            Default::default(),
            &mut name_dependencies_map,
            &mut name_dependents_map,
        );
        crate::table_deps::update_table_dependencies(
            (row, col),
            Default::default(),
            &mut table_dependencies_map,
            &mut table_dependents_map,
        );

        // Get merge span info for the cleared cell
        let merge_info = merged_regions
            .iter()
            .find(|r| r.start_row == row && r.start_col == col);
        let (row_span, col_span) = if let Some(region) = merge_info {
            (
                region.end_row - region.start_row + 1,
                region.end_col - region.start_col + 1,
            )
        } else {
            (1, 1)
        };

        updated_cells.push(CellData {
            row,
            col,
            display: String::new(),
            // Empty: nothing to overflow, and text never marks.
            overflow: crate::api_types::OverflowClass::Text,
            display_color: None,
            formula: None,
            style_index: 0,
            row_span,
            col_span,
            sheet_index: None,
            rich_text: None,
            accounting_layout: None,
        });

        // Record subscriber override for the cleared cell (subscribed sheets only)
        crate::calp_commands::record_subscription_override_edits(
            &state,
            &effect,
            active_sheet,
            &[(row, col, previous_cell.clone(), grid.get_cell(row, col).cloned())],
        );

        // Record undo after successful change
        undo_stack.record_cell_change(active_sheet, row, col, previous_cell);

        // Mark workbook as dirty
        // Already dirtied by the `effect` bound above -- one `mutates` per
        // command, not one per branch. See DocumentEffect::mutates.

        // The cleared cell is stored and its edges are gone; the
        // cascade below is what makes its DEPENDENTS agree.
        perf_t2_parsed = Instant::now();
        perf_t3_stored = Instant::now();
    } else {
        // Parse the input, and take the NUMBER FORMAT the entry implies with it.
        //
        // Typing "6/1/2020" or "50%" produces a plain number — a date serial,
        // or 0.5 — and without the implied format the cell shows `43983` and
        // `0.5`. Excel applies the format the entry implied, which is what makes
        // a typed date look like the date the user typed.
        //
        // AND THE FORMAT THE ENTRY IS LANDING IN, which is the mirror image of
        // that and the half that used to LOSE data. The Text format `@` read
        // nothing on any entry path, so `007` typed into a Text-formatted cell
        // was stored as the number 7 and then re-rendered through `General`:
        // the cell displayed "7", leading zeros gone, ISTEXT false. It is the
        // EFFECTIVE format (`entry_format_at`), because a column formatted as
        // Text is how a column of part numbers gets protected and every cell in
        // it still carries style index 0.
        let target_format = entry_format_at(&grid, &styles, row, col);
        let (mut cell, implied_format) =
            parse_cell_input_in_format(&value, &locale, Some(&target_format));

        // Preserve existing style
        if let Some(existing) = grid.get_cell(row, col) {
            cell.style_index = existing.style_index;
        }

        // ONLY OVER `General`. A cell the user has already formatted keeps that
        // format: typing a date into a cell explicitly set to Text, or into one
        // already carrying a chosen date format, must not silently re-format it.
        // `General` is the "nobody has said otherwise" state, and it is the only
        // one an implied format may claim.
        if let Some(fmt) = implied_format {
            if styles.get(cell.style_index).number_format == engine::NumberFormat::General {
                let restyled = styles.get(cell.style_index).clone().with_number_format(fmt);
                cell.style_index = styles.get_or_create(restyled);
            }
        }

        // If it's a formula, evaluate it using multi-sheet context
        if let Some(formula) = cell.formula_string() {
            // Extract references for dependency tracking AND cache the AST
            match parser::parse(&formula) {
                Ok(parsed) => {
                    // THE CELL KEEPS THE NAME (Excel parity, D2). `stored` is what
                    // this cell will hold and what the formula bar will show;
                    // `evaluated()` is the same tree with defined names spliced in,
                    // which is what this edit evaluates and what dependency
                    // extraction reads. See `split_entered_formula`.
                    let entered = crate::split_entered_formula(&state, &parsed, active_sheet, row, col, &sheet_names);
                    let resolved = entered.evaluated();

                    let refs = extract_all_references(resolved, &grid);

                    log_debug!("DEPS", "update_cell({},{}) formula='{}' extracted_refs: cells={:?} cross_sheet={:?} columns={:?} rows={:?}",
                        row, col, formula, refs.cells, refs.cross_sheet_cells, refs.columns, refs.rows);

                    update_dependencies(
                        (row, col),
                        refs.cells,
                        &mut dependencies_map,
                        &mut dependents_map,
                    );
                    update_column_dependencies(
                        (row, col),
                        refs.columns,
                        &mut column_dependencies_map,
                        &mut column_dependents_map,
                    );
                    update_row_dependencies(
                        (row, col),
                        refs.rows,
                        &mut row_dependencies_map,
                        &mut row_dependents_map,
                    );

                    // Track cross-sheet dependencies, under the workbook's OFFICIAL
                    // sheet spelling (see normalize_cross_sheet_refs).
                    update_cross_sheet_dependencies(
                        (active_sheet, row, col),
                        crate::normalize_cross_sheet_refs(&refs.cross_sheet_cells, &sheet_names),
                        &mut cross_sheet_dependencies_map,
                        &mut cross_sheet_dependents_map,
                    );

                    // DEFINED-NAME edges, read from the tree the cell KEEPS — the
                    // expanded one no longer mentions the name at all.
                    {
                        let mut names = crate::name_resolution::NameSet::default();
                        crate::name_resolution::collect_names(&entered.stored, &mut names);
                        crate::name_resolution::update_name_dependencies(
                            (row, col),
                            names,
                            &mut name_dependencies_map,
                            &mut name_dependents_map,
                        );
                    }

                    // STRUCTURED-REFERENCE edges, the same argument one authority
                    // over (§2aj): the cell keeps `Sales[Amount]`, and a resize
                    // changes what that means without touching any cell the
                    // cell-level edges above mention.
                    {
                        let mut tables = crate::table_deps::TableSet::default();
                        crate::table_deps::collect_table_names(&entered.stored, &mut tables);
                        crate::table_deps::update_table_dependencies(
                            (row, col),
                            tables,
                            &mut table_dependencies_map,
                            &mut table_dependents_map,
                        );
                    }

                    // PERF: Convert the already-parsed AST directly instead of re-parsing.
                    // The cell keeps the NAME-BEARING tree; only the evaluation
                    // below sees the expansion.
                    let engine_ast = crate::convert_expr(resolved);
                    cell.set_cached_ast(crate::convert_expr(&entered.stored));
                    // Build EvalContext with current cell position and dimension state
                    let rh_map = state.row_heights.read().unwrap().clone();
                    let cw_map = state.column_widths.read().unwrap().clone();
                    let eval_ctx = engine::EvalContext {
                        cube_prefetch: cube_arc.clone(),
                        current_row: Some(row),
                        current_col: Some(col),
                        row_heights: Some(rh_map),
                        column_widths: Some(cw_map),
                        hidden_rows: None,
                        control_values: Some(control_values.clone()),
                    };
                    let raw_result = evaluate_formula_raw_with_files_and_pivot(
                        &grids,
                        &sheet_names,
                        active_sheet,
                        &engine_ast,
                        eval_ctx,
                        Some(&styles),
                        &user_files,
                        Some(&pivot_data_fn),
                        Some(&gather_fn),
                        udf_resolver.as_ref().map(|r| r as &dyn Fn(&str, &[EvalResult]) -> Option<EvalResult>),
                    );

                    // The range this cell used to own was already released, above,
                    // BEFORE the formula was evaluated — see the hoisted
                    // tear-down. THE ONE SPILL DECISION runs its own release
                    // too, which finds nothing left to release here (one
                    // `spill_ranges` lock and an `is_empty()`), and then decides
                    // the spill.
                    cell.value = apply_spill_decision(
                        state,
                        &mut grid,
                        &mut grids,
                        active_sheet,
                        active_sheet,
                        row,
                        col,
                        &raw_result,
                        &styles,
                        &locale,
                        &mut updated_cells,
                    );
                }
                Err(_e) => {
                    // Formula parse error - dependencies won't be tracked
                    // Still try to evaluate (will return error)
                    let result =
                        evaluate_formula_multi_sheet_with_files(&grids, &sheet_names, active_sheet, &formula, &user_files);
                    cell.value = result;
                }
            }
        } else {
            // Clear dependencies for non-formula cells
            update_dependencies(
                (row, col),
                Default::default(),
                &mut dependencies_map,
                &mut dependents_map,
            );
            // Clear cross-sheet dependencies for non-formula cells
            update_cross_sheet_dependencies(
                (active_sheet, row, col),
                Default::default(),
                &mut cross_sheet_dependencies_map,
                &mut cross_sheet_dependents_map,
            );
            update_column_dependencies(
                (row, col),
                Default::default(),
                &mut column_dependencies_map,
                &mut column_dependents_map,
            );
            update_row_dependencies(
                (row, col),
                Default::default(),
                &mut row_dependencies_map,
                &mut row_dependents_map,
            );
        }

        perf_t2_parsed = Instant::now();

        // Store the cell
        grid.set_cell(row, col, cell.clone());
        // Also update the grids vector to keep them in sync
        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(row, col, cell.clone());
        }

        // Get the display value
        let style = styles.get(grid.effective_style_index(row, col));
        let (display, overflow) = crate::format_cell_value_and_class(&cell.value, style, &locale);
        perf_t3_stored = Instant::now();

        // Get merge span info
        let merge_info = merged_regions
            .iter()
            .find(|r| r.start_row == row && r.start_col == col);
        let (row_span, col_span) = if let Some(region) = merge_info {
            (
                region.end_row - region.start_row + 1,
                region.end_col - region.start_col + 1,
            )
        } else {
            (1, 1)
        };

        updated_cells.push(CellData {
            row,
            col,
            display,
            overflow,
            display_color: None,
            formula: formula_display(&cell, &locale),
            style_index: grid.effective_style_index(row, col),
            row_span,
            col_span,
            sheet_index: None, // Current active sheet
            rich_text: None,
            accounting_layout: None,
        });

        // Record subscriber override for the edited cell (subscribed sheets only)
        crate::calp_commands::record_subscription_override_edits(
            &state,
                &effect,
            active_sheet,
            &[(row, col, previous_cell.clone(), grid.get_cell(row, col).cloned())],
        );

        // Record undo after successful change
        undo_stack.record_cell_change(active_sheet, row, col, previous_cell);

    }

    // Manual calculation: the dependents stay as they are, and the workbook
    // says so (Excel's xlPending -> the status bar's "Calculate").
    if *calc_mode != "automatic" {
        note_manual_write_left_formulas_uncalculated(
            &grid,
            &[(row, col)],
            sheet_names.get(active_sheet).map(String::as_str).unwrap_or(""),
            &dependents_map,
            &column_dependents_map,
            &row_dependents_map,
            &cross_sheet_dependents_map,
        );
    }

    // Recalculate dependents if automatic mode
    if *calc_mode == "automatic" {
        // Build a HashMap for O(1) merge region lookup instead of O(n) linear search
        let merge_lookup: std::collections::HashMap<(u32, u32), &MergedRegion> = merged_regions
            .iter()
            .map(|r| ((r.start_row, r.start_col), r))
            .collect();

        // Lock table state for cascade recalculation (needed to resolve table refs in slow path)
        let cascade_tables = state.tables.read().unwrap();
        let cascade_table_names = state.table_names.read().unwrap();
        let cascade_named_ranges = state.named_ranges.read().unwrap();

        // THE CASCADE, from the one function the CUBE pre-fetch computes its
        // result set with (`active_sheet_write_cascade`): the edit's
        // dependents, its whole-column/row readers, the volatile UDF cells
        // `collect_udf_calls` found (already resolved into `udf_results`), the
        // volatile built-ins and everything downstream of them, and the arrays
        // this edit unblocked. `spill_blocks` makes the last one cheap: it
        // already records WHICH cell blocked each origin, so unblocking is a
        // reverse lookup on a map that is empty in every workbook with no
        // blocked array.
        let unblocked_origins = origins_blocked_by(&state, active_sheet, row, col);
        let recalc_order = active_sheet_write_cascade(
            &grid,
            CascadeSeeds::Edited((row, col)),
            &dependents_map,
            &column_dependents_map,
            &row_dependents_map,
            udf_volatile_cells.as_deref(),
            &unblocked_origins,
        );

        log_debug!("DEPS", "cascade for ({},{}) recalc_order={:?} dependents_entry={:?}",
            row, col, recalc_order, dependents_map.get(&(row, col)));
        let perf_t4_recalc_order = Instant::now();
        let perf_same_sheet_count = recalc_order.len();
        let mut perf_cache_hits: u32 = 0;
        let mut perf_cache_misses: u32 = 0;
        let mut perf_eval_total = std::time::Duration::ZERO;
        // PERF-20: skip per-dependent formula render + IPC payload for wide cascades.
        let include_cascade_formulas = recalc_order.len() <= CASCADE_FORMULA_LIMIT;

        for &(dep_row, dep_col) in &recalc_order {
            // Clone dep_cell upfront to release the immutable borrow on grid,
            // allowing mutable access for spill cell writes below.
            let dep_cell_opt = grid.get_cell(dep_row, dep_col).cloned();
            if let Some(dep_cell) = dep_cell_opt {
                if let Some(formula) = dep_cell.formula_string() {
                    let perf_eval_start = Instant::now();
                    // Shared spill-aware cascade body (also used by the
                    // targeted control recalc); evaluates with the dependent's
                    // own position so cube/UDF preserve semantics engage.
                    reevaluate_formula_cell(
                        &state,
                        &mut grid,
                        &mut grids,
                        &sheet_names,
                        active_sheet,
                        dep_row,
                        dep_col,
                        &dep_cell,
                        &formula,
                        &user_files,
                        udf_resolver.as_ref().map(|r| r as &dyn Fn(&str, &[EvalResult]) -> Option<EvalResult>),
                        cube_arc.as_ref(),
                        Some(&control_values),
                        &styles,
                        &locale,
                        &merge_lookup,
                        &cascade_tables,
                        &cascade_table_names,
                        &cascade_named_ranges,
                        &mut updated_cells,
                        &mut perf_cache_hits,
                        &mut perf_cache_misses,
                        include_cascade_formulas,
                    );
                    perf_eval_total += perf_eval_start.elapsed();
                }
            }
        }
        let perf_t5_same_sheet = Instant::now();

        // Also recalculate cross-sheet dependents (formulas on OTHER sheets
        // that reference the edited cell), cascading across sheets — shared
        // walk, also used by the targeted control recalc
        // (recalc_control_dependents in control_values.rs).
        cascade_cross_sheet_dependents(
            state,
            &mut grid,
            &mut grids,
            &sheet_names,
            active_sheet,
            &cross_sheet_dependents_map,
            &user_files,
            &control_values,
            &styles,
            &locale,
            &merge_lookup,
            crate::name_resolution::NameTables {
                named_ranges: &cascade_named_ranges,
                tables: &cascade_tables,
                table_names: &cascade_table_names,
                sheet_names: &sheet_names,
                spill_ranges: &state.spill_ranges,
            },
            &[(row, col)],
            &recalc_order,
            &mut updated_cells,
            include_cascade_formulas,
        );
        let perf_t6_cross_sheet = Instant::now();
        let perf_cross_sheet_count = updated_cells.len().saturating_sub(1 + perf_same_sheet_count);

        log_perf!("CELL",
            "update_cell({},{}) cells={} | locks={:.2}ms parse+deps={:.2}ms store={:.2}ms recalc_order={:.2}ms same_sheet={:.2}ms({}cells, {}hits/{}miss, eval={:.2}ms) cross_sheet={:.2}ms({}cells) TOTAL={:.2}ms",
            row, col, updated_cells.len(),
            perf_t1_locks.duration_since(perf_t0).as_secs_f64() * 1000.0,
            perf_t2_parsed.duration_since(perf_t1_locks).as_secs_f64() * 1000.0,
            perf_t3_stored.duration_since(perf_t2_parsed).as_secs_f64() * 1000.0,
            perf_t4_recalc_order.duration_since(perf_t3_stored).as_secs_f64() * 1000.0,
            perf_t5_same_sheet.duration_since(perf_t4_recalc_order).as_secs_f64() * 1000.0,
            perf_same_sheet_count, perf_cache_hits, perf_cache_misses,
            perf_eval_total.as_secs_f64() * 1000.0,
            perf_t6_cross_sheet.duration_since(perf_t5_same_sheet).as_secs_f64() * 1000.0,
            perf_cross_sheet_count,
            perf_t6_cross_sheet.duration_since(perf_t0).as_secs_f64() * 1000.0
        );
    } else {
        // Manual calc mode - just log basic timing
        let perf_tend = Instant::now();
        log_perf!("CELL",
            "update_cell({},{}) manual_mode | locks={:.2}ms parse+deps={:.2}ms store={:.2}ms TOTAL={:.2}ms",
            row, col,
            perf_t1_locks.duration_since(perf_t0).as_secs_f64() * 1000.0,
            perf_t2_parsed.duration_since(perf_t1_locks).as_secs_f64() * 1000.0,
            perf_t3_stored.duration_since(perf_t2_parsed).as_secs_f64() * 1000.0,
            perf_tend.duration_since(perf_t0).as_secs_f64() * 1000.0
        );
    }

    // Re-evaluate computed properties affected by changed cells
    {
        let cp_dependents = state.computed_prop_dependents.lock().unwrap();
        if !cp_dependents.is_empty() {
            // Collect all cells that changed (primary + recalculated dependents)
            let changed_cells: Vec<(usize, u32, u32)> = updated_cells.iter()
                .map(|c| (c.sheet_index.unwrap_or(active_sheet), c.row, c.col))
                .collect();

            // Computed properties are persisted (user_files/computed_properties.json)
            // and re-evaluating them here can rewrite them. This runs inside
            // `update_cell_impl`, which already marked the document dirty for the cell
            // edit that triggered it; reuse that decision rather than making a second.
            let cp_effect = crate::document_effect::DocumentEffect::mutates(file_state);
            let mut cp_storage = state.computed_properties.write(&cp_effect).unwrap();
            let mut rh = state.row_heights.write(&cp_effect).unwrap();
            let mut cw = state.column_widths.write(&cp_effect).unwrap();

            let (cp_dim_changes, cp_style_refresh) =
                crate::computed_properties::re_evaluate_for_changed_cells(
                    &changed_cells,
                    &mut cp_storage,
                    &cp_dependents,
                    &mut grids,
                    &mut grid,
                    &sheet_names,
                    active_sheet,
                    &mut rh,
                    &mut cw,
                    &mut styles,
                    Some(&control_values),
                );

            dimension_changes.extend(cp_dim_changes);
            needs_style_refresh = needs_style_refresh || cp_style_refresh;
        }
    }

    // Re-evaluate slicer computed properties affected by changed cells
    let slicer_changed = {
        let rev_deps = slicer_state.computed_prop_dependents.lock().unwrap();
        if rev_deps.is_empty() {
            false
        } else {
            drop(rev_deps);
            let changed_cells: Vec<(usize, u32, u32)> = updated_cells.iter()
                .map(|c| (c.sheet_index.unwrap_or(active_sheet), c.row, c.col))
                .collect();

            let rh = state.row_heights.read().unwrap();
            let cw = state.column_widths.read().unwrap();

            // Slicer computed-property caches are persisted with the slicer. This runs
            // inside `update_cell_impl`, which already dirtied for the triggering cell
            // edit; this is the same user action, so it takes a mutates token too.
            let slicer_cp_effect = crate::document_effect::DocumentEffect::mutates(file_state);
            let modified = crate::slicer::computed::re_evaluate_slicer_computed_properties(
                &slicer_cp_effect,
                &changed_cells,
                &grids,
                &sheet_names,
                &rh,
                &cw,
                &styles,
                &slicer_state,
                Some(&control_values),
            );
            !modified.is_empty()
        }
    };

    // NOT a second dirty mark. The `effect` bound above -- unconditional, after
    // every gate, and the token that authorised both grid writes -- already set
    // the flag for this command. A trailing `mark_workbook_modified` used to sit
    // here from before `DocumentEffect` existed; it was redundant the moment the
    // grid became `Persisted<T>`, and this is the per-KEYSTROKE path, so a
    // pointless extra `Mutex<bool>` acquisition is worth not having.

    Ok(UpdateCellResult {
        cells: updated_cells,
        dimension_changes,
        needs_style_refresh,
        slicer_changed,
        group_written: None,
        group_error: None,
    })
}

/// Re-evaluate ONE formula cell on the ACTIVE sheet with full spill handling —
/// the shared body of `update_cell`'s dependent cascade, extracted so targeted
/// recalc paths (`recalc_control_dependents` in control_values.rs) reuse the
/// exact same spill-aware logic. `update_cell` remains the hottest path: keep
/// this mechanical.
///
/// Each cell is evaluated with an `EvalContext` carrying ITS OWN position
/// (`current_row`/`current_col`) — required by ROW()/COLUMN(), implicit
/// intersection and a scoped cube prefetch's `covers`. With no cube prefetch /
/// UDF resolver, `preserved_cube_value` / `preserved_udf_value` (evaluator.rs)
/// answer each call -- the whole formula or any part of it -- from the
/// sheet's results cache (`engine::cube::CallMemo`): the answer recorded for
/// exactly the arguments it has now, and #N/A (#NAME? for a custom function)
/// when none is. The cell's stored value is never read back (rev3A#3).
///
/// Steps: evaluate the cached AST (or, on a cache miss, parse + resolve
/// names/tables/spill refs and cache the converted AST), clear the cell's
/// previous spill range, spill new array results (or mark the origin #VALUE!
/// when blocked), write the result to both `grid` (active-sheet mirror) and
/// `grids[active_sheet]`, and append `CellData` for every touched cell
/// (cleared spill cells, new spill cells, origin) to `updated_cells`.
///
/// Locking: takes `state.spill_ranges` / `state.spill_hosts` briefly, AFTER
/// the caller's grid locks — the same order `update_cell` uses. The caller
/// holds grid/grids/styles/locale/tables/... and passes the guards' contents.
#[allow(clippy::too_many_arguments)]
pub(crate) fn reevaluate_formula_cell(
    state: &AppState,
    grid: &mut Grid,
    grids: &mut Vec<Grid>,
    sheet_names: &[String],
    active_sheet: usize,
    dep_row: u32,
    dep_col: u32,
    dep_cell: &engine::Cell,
    formula: &str,
    user_files: &std::collections::HashMap<String, Vec<u8>>,
    udf_resolver: Option<&dyn Fn(&str, &[EvalResult]) -> Option<EvalResult>>,
    cube: Option<&std::sync::Arc<engine::CubePrefetch>>,
    control_values: Option<&std::sync::Arc<crate::control_values::ControlValuesMap>>,
    styles: &StyleRegistry,
    locale: &engine::LocaleSettings,
    merge_lookup: &std::collections::HashMap<(u32, u32), &MergedRegion>,
    tables: &crate::tables::TableStorage,
    table_names: &crate::tables::TableNameRegistry,
    named_ranges: &std::collections::HashMap<String, crate::named_ranges::NamedRange>,
    updated_cells: &mut Vec<CellData>,
    cache_hits: &mut u32,
    cache_misses: &mut u32,
    include_formula: bool,
) {
    // The dependent-cascade body, shared by update_cell, the batch writer and
    // the control-value cascade. It INHERITS the surface its caller declared
    // (Interactive for an edit, Background for a `.calp` refresh) rather than
    // overriding it, so the ceiling stays the caller's and cancellation keeps
    // reaching down here. Called directly with nothing installed, it declares
    // Interactive — the right default for a cell that is about to be written.
    let _governor = crate::eval_budget::inherit_or(crate::eval_budget::EvalSurface::Interactive);
    // Per-cell EvalContext with the dependent's OWN position — current_row/
    // current_col MUST be set so the preserve semantics can engage (see the
    // fn doc). Mirrors the main-edit EvalContext in update_cell, except
    // row_heights/column_widths stay None: cloning those maps per dependent
    // is too expensive on this hot path, so GET.ROW.HEIGHT-style dependents
    // keep their fallback behavior.
    let eval_ctx = engine::EvalContext {
        cube_prefetch: cube.cloned(),
        current_row: Some(dep_row),
        current_col: Some(dep_col),
        row_heights: None,
        column_widths: None,
        hidden_rows: None,
        control_values: control_values.cloned(),
    };

    // Get the AST (cached or freshly parsed) and evaluate to raw EvalResult
    let (raw_result, ast_to_cache) = if let Some(cached_ast) = dep_cell.get_cached_ast() {
        *cache_hits += 1;
        // A STORED formula keeps its defined names (D2), so they are expanded
        // HERE, on the way into the evaluator — never written back into the
        // cell. Borrowed, at no cost, for a formula that names nothing.
        let name_ctx = crate::name_resolution::NameEvalCtx {
            named_ranges,
            tables,
            table_names,
            sheet_names: sheet_names,
            spill_ranges: &state.spill_ranges,
            sheet_index: active_sheet,
            row: dep_row,
            col: dep_col,
        };
        let eval_target = crate::name_resolution::eval_ast(cached_ast, &name_ctx);
        let result = evaluate_formula_raw_with_files_and_pivot(
            &*grids,
            sheet_names,
            active_sheet,
            &eval_target,
            eval_ctx,
            Some(styles),
            user_files,
            None, // pivot lookup: not wired on this path (unchanged)
            None, // gather lookup: not wired on this path (unchanged)
            udf_resolver,
        );
        (result, None)
    } else {
        // UNREACHABLE in practice, and deliberately kept: `formula_string()` and
        // `get_cached_ast()` read the SAME `Cell::ast` field, so a cell that
        // produced a formula string above always has an AST here. Left as the
        // string-shaped fallback it has always been.
        //
        // NOTE it does NOT splice names into what it caches: whatever this path
        // stores must keep the name, exactly as the entry path does (D2). It
        // resolves names only for the value it returns.
        *cache_misses += 1;
        // Re-parsed, then expanded through the SAME `eval_ast` the cached path
        // uses — names, structured references and `A1#` alike. It used to
        // hand-roll all three, which is how the two halves of this function
        // could disagree about what a formula meant; §3bf added the third
        // indirection and made a second copy indefensible.
        if let Ok(parsed) = parser::parse(formula).map_err(|e| format!("{}", e)) {
            let name_ctx = crate::name_resolution::NameEvalCtx {
                named_ranges,
                tables,
                table_names,
                sheet_names: sheet_names,
                spill_ranges: &state.spill_ranges,
                sheet_index: active_sheet,
                row: dep_row,
                col: dep_col,
            };
            let engine_ast = crate::name_resolution::eval_ast(&parsed, &name_ctx).into_owned();
            let result = evaluate_formula_raw_with_files_and_pivot(
                &*grids,
                sheet_names,
                active_sheet,
                &engine_ast,
                eval_ctx,
                Some(styles),
                user_files,
                None, // pivot lookup: not wired on this path (unchanged)
                None, // gather lookup: not wired on this path (unchanged)
                udf_resolver,
            );
            // The AST cached back is the one the cell must KEEP, so it is
            // re-derived from the formula text without the name splice — never
            // `engine_ast`, which is the expanded form this call evaluated.
            (result, parser::parse(formula).ok().map(|p| crate::convert_expr(&p)))
        } else {
            // Fallback to string-based evaluation (no spill support)
            // (GET.CONTROLVALUE unavailable here (v1): string path)
            let cv = evaluate_formula_multi_sheet_with_files(
                &*grids, sheet_names, active_sheet, formula, user_files,
            );
            let er = match cv {
                engine::CellValue::Number(n) => engine::EvalResult::Number(n),
                engine::CellValue::Text(s) => engine::EvalResult::Text(s),
                engine::CellValue::Boolean(b) => engine::EvalResult::Boolean(b),
                engine::CellValue::Error(e) => engine::EvalResult::Error(e),
                _ => engine::EvalResult::Text(String::new()),
            };
            (er, None)
        }
    };

    // Tear-down, blocked-check and spill, through THE ONE SPILL DECISION.
    let cell_value = apply_spill_decision(
        state,
        grid,
        grids,
        active_sheet,
        active_sheet,
        dep_row,
        dep_col,
        &raw_result,
        styles,
        locale,
        updated_cells,
    );

    // Update the origin cell
    let mut updated_dep = dep_cell.clone();
    updated_dep.value = cell_value;
    if let Some(ast) = ast_to_cache {
        updated_dep.set_cached_ast(ast);
    }
    grid.set_cell(dep_row, dep_col, updated_dep.clone());
    if active_sheet < grids.len() {
        grids[active_sheet].set_cell(dep_row, dep_col, updated_dep.clone());
    }

    let dep_style = styles.get(grid.effective_style_index(dep_row, dep_col));
    let (dep_display, dep_overflow) = crate::format_cell_value_and_class(&updated_dep.value, dep_style, locale);

    let (dep_row_span, dep_col_span) =
        if let Some(region) = merge_lookup.get(&(dep_row, dep_col)) {
            (
                region.end_row - region.start_row + 1,
                region.end_col - region.start_col + 1,
            )
        } else {
            (1, 1)
        };

    updated_cells.push(CellData {
        row: dep_row,
        col: dep_col,
        display: dep_display, overflow: dep_overflow,
        display_color: None,
        formula: if include_formula {
            formula_display(&updated_dep, locale)
        } else {
            None
        },
        style_index: grid.effective_style_index(dep_row, dep_col),
        row_span: dep_row_span,
        col_span: dep_col_span,
        sheet_index: None,
        rich_text: None,
        accounting_layout: None,
    });
}

/// The same-sheet dependent edges of ONE sheet, derived on demand from that
/// sheet's own formula ASTs.
///
/// WHY THIS EXISTS (BUG-0019, half two). `AppState`'s `dependents` /
/// `column_dependents` / `row_dependents` maps are keyed by `(row, col)` with
/// **no sheet dimension**: they describe the ACTIVE sheet only and are cleared
/// and rebuilt on every sheet switch (`rebuild_all_dependencies`). The walk
/// below has to continue a cascade on a sheet the user is NOT looking at, and
/// consulting the active sheet's map there answers a question about the wrong
/// sheet. That is not a theoretical mismatch: with `Sheet2!B3 = Sheet1!C9` and
/// `Sheet2!B4 = B2-B3`, reaching `Sheet2!B3` asked *Sheet1* what depends on
/// `(row 2, col 1)` — nothing did — so `B4` kept a stale balance forever.
///
/// Built lazily and memoised for the duration of one cascade: an edit that
/// reaches no other sheet pays nothing, and one that does pays a single AST
/// scan per sheet it actually reaches (strictly cheaper than
/// `recalculate_sheet_values`, the existing whole-sheet answer to the same
/// problem, which scans AND re-evaluates every formula on the sheet).
struct SheetDependencyIndex {
    /// precedent cell -> formula cells on this sheet that read it.
    cells: crate::DependencyMap,
    /// column index -> formula cells with a whole-column reference to it.
    columns: crate::StripeDependentsMap,
    /// row index -> formula cells with a whole-row reference to it.
    rows: crate::StripeDependentsMap,
}

impl SheetDependencyIndex {
    /// `name_tables` and `sheet_index` are not decoration. A stored formula
    /// keeps its defined names (D2) and its structured references (§2aj), and
    /// `extract_all_references` can see through neither -- so an off-sheet
    /// `=SUM(Sales[Amount])` built straight from `cell.ast` would look like a
    /// formula that reads nothing and sort as an INPUT, computing from whatever
    /// the table held before this cascade started.
    fn build(
        grid: &Grid,
        sheet_index: usize,
        name_tables: crate::name_resolution::NameTables<'_>,
    ) -> Self {
        let mut index = SheetDependencyIndex {
            cells: crate::DependencyMap::default(),
            columns: crate::StripeDependentsMap::default(),
            rows: crate::StripeDependentsMap::default(),
        };
        for (&(row, col), cell) in &grid.cells {
            let Some(ast) = &cell.ast else { continue };
            let refs = crate::stored_ast_references(ast, grid, name_tables, sheet_index, row, col);
            for precedent in refs.cells {
                index.cells.entry(precedent).or_default().insert((row, col));
            }
            for c in refs.columns {
                index.columns.entry(c).or_default().insert((row, col));
            }
            for r in refs.rows {
                index.rows.entry(r).or_default().insert((row, col));
            }
        }
        index
    }

    /// `seeds` and all their transitive dependents on this sheet, precedents
    /// before dependents, with whole-column/row dependents appended — the same
    /// shape `update_cells_batch` builds for the active sheet.
    ///
    /// The seeds are MEMBERS of the ordering, not just expansion roots, because
    /// they can feed each other: `Sheet2!B1 = Sheet1!A1` and
    /// `Sheet2!B2 = Sheet1!A1 + B1` are both direct cross-sheet dependents of
    /// one edit, and `cross_sheet_dependents` is a hash SET, so without this
    /// `B2` could be computed from a stale `B1` and then never revisited.
    fn recalc_order(&self, seeds: &[(u32, u32)]) -> Vec<(u32, u32)> {
        let mut order = crate::recalc_order_from_seeds(seeds, &self.cells, true);
        let mut seen: crate::CoordSet = order.iter().copied().collect();
        for &seed in seeds {
            for dep in get_column_row_dependents(seed, &self.columns, &self.rows) {
                if seen.insert(dep) {
                    order.push(dep);
                }
            }
        }
        order
    }
}

/// Re-evaluate ONE formula cell reached by the cross-sheet walk, write it to
/// its own sheet (and the active-sheet mirror when they are the same sheet),
/// and record it in `updated_cells`. Returns `false` when the cell is missing
/// or holds no formula — nothing changed, so nothing propagates from it.
///
/// SPILLS, through the shared [`apply_spill_decision`]. It did not use to: it
/// wrote `to_cell_value()`, so a dynamic array on a sheet the user was not
/// looking at collapsed to its first element the moment an edit on another
/// sheet reached it. That was tolerable only while NOTHING off the active sheet
/// spilled; §3bm gave the recalculation pass the decision for every sheet it
/// plans, and leaving this one scalar would have made the same workbook hold
/// different values depending on whether F9 or an edit last ran — the exact
/// path-dependence `EvalSurface`'s doc forbids.
///
/// AT ITS OWN CELL, too, for the same reason: it evaluated through a
/// positionless entry point, so an off-sheet `=ROW()*Sheet1!A1` went #VALUE!,
/// `=@Sheet1!A1:A10` intersected row 1, and a cube or custom-function cell was
/// clobbered to #N/A / #NAME? instead of keeping its value -- on every edit,
/// paste, fill, undo and bulk rewrite, since they all end in this walk.
#[allow(clippy::too_many_arguments)]
fn recalc_walked_cell(
    state: &AppState,
    grid: &mut Grid,
    grids: &mut [Grid],
    sheet_names: &[String],
    active_sheet: usize,
    dep_sheet_idx: usize,
    dep_row: u32,
    dep_col: u32,
    user_files: &std::collections::HashMap<String, Vec<u8>>,
    control_values: &std::sync::Arc<crate::control_values::ControlValuesMap>,
    styles: &StyleRegistry,
    locale: &engine::LocaleSettings,
    merge_lookup: &std::collections::HashMap<(u32, u32), &MergedRegion>,
    name_tables: crate::name_resolution::NameTables<'_>,
    updated_cells: &mut Vec<CellData>,
    include_formulas: bool,
) -> bool {
    if dep_sheet_idx >= grids.len() {
        return false;
    }
    let Some(dep_cell) = grids[dep_sheet_idx].get_cell(dep_row, dep_col).cloned() else {
        return false;
    };
    let Some(formula) = dep_cell.formula_string() else {
        return false;
    };

    // The dependent's OWN cell, exactly as `reevaluate_formula_cell` gives it:
    // argument-less ROW()/COLUMN(), implicit intersection (`@`) and the cube and
    // custom-function preserve all ask where the formula sits. No caller hands
    // this walk cube data or a UDF resolver, so without the position a cube cell
    // on another sheet was clobbered to #N/A and a custom-function one to #NAME?
    // by every edit of a cell they read, and `=ROW()*Sheet1!A1` went #VALUE!.
    // Evaluated on the dependent's own sheet, so the preserve reads THAT sheet's
    // stored value and THAT sheet's served-call memo: the value is kept only
    // when the call is the whole formula and the edit left its arguments as
    // they were; otherwise #N/A / #NAME? (rev3A#3), never the old member's
    // number beside the new member's name.
    let eval_ctx = engine::EvalContext {
        cube_prefetch: None,
        current_row: Some(dep_row),
        current_col: Some(dep_col),
        row_heights: None,
        column_widths: None,
        hidden_rows: None,
        control_values: Some(control_values.clone()),
    };

    // Use the cached AST if available; otherwise re-parse the rendered string.
    let raw_result = if let Some(cached_ast) = dep_cell.get_cached_ast() {
        // Defined names are expanded on the way into the evaluator (D2), against
        // the DEPENDENT'S OWN sheet — a sheet-scoped name means something
        // different over there, and this walk is on another sheet by definition.
        let eval_target = crate::name_resolution::eval_ast(
            cached_ast,
            &name_tables.at(dep_sheet_idx, dep_row, dep_col),
        );
        evaluate_formula_raw_with_files_and_pivot(
            &*grids,
            sheet_names,
            dep_sheet_idx,
            &eval_target,
            eval_ctx,
            Some(styles),
            user_files,
            None, // pivot lookup: not wired on this path (unchanged)
            None, // gather lookup: not wired on this path (unchanged)
            None, // UDF resolver: none reaches the walk; the position keeps the value
        )
    } else {
        // (GET.CONTROLVALUE unavailable here (v1): string path)
        match evaluate_formula_multi_sheet_with_files(
            &*grids,
            sheet_names,
            dep_sheet_idx,
            &formula,
            user_files,
        ) {
            engine::CellValue::Number(n) => engine::EvalResult::Number(n),
            engine::CellValue::Text(s) => engine::EvalResult::Text(s),
            engine::CellValue::Boolean(b) => engine::EvalResult::Boolean(b),
            engine::CellValue::Error(e) => engine::EvalResult::Error(e),
            _ => engine::EvalResult::Text(String::new()),
        }
    };

    let result = apply_spill_decision(
        state,
        grid,
        grids,
        active_sheet,
        dep_sheet_idx,
        dep_row,
        dep_col,
        &raw_result,
        styles,
        locale,
        updated_cells,
    );

    let mut updated_dep = dep_cell;
    updated_dep.value = result;
    grids[dep_sheet_idx].set_cell(dep_row, dep_col, updated_dep.clone());

    // A dependent that lives on the ACTIVE sheet must also land in the
    // active-sheet mirror or the two diverge (the stale-mirror hazard that was
    // BUG-0016). Happens when a named range's refers_to carries a sheet prefix
    // pointing at the same sheet (e.g. =Sheet1!$E$2*10), and whenever the walk
    // re-enters the active sheet from another one.
    let is_same_sheet = dep_sheet_idx == active_sheet;
    if is_same_sheet {
        grid.set_cell(dep_row, dep_col, updated_dep.clone());
    }

    // Resolve the style tiers on the dependent's OWN sheet.
    let dep_style = styles.get(grids[dep_sheet_idx].effective_style_index(dep_row, dep_col));
    let (dep_display, dep_overflow) = crate::format_cell_value_and_class(&updated_dep.value, dep_style, locale);

    // Same-sheet deps: merge span info and sheet_index=None so the frontend
    // emits cell events for re-rendering. Cross-sheet deps: default span (1,1)
    // and sheet_index=Some, since they are fetched on sheet switch.
    let (dep_row_span, dep_col_span, dep_sheet_index) = if is_same_sheet {
        let span = if let Some(region) = merge_lookup.get(&(dep_row, dep_col)) {
            (
                region.end_row - region.start_row + 1,
                region.end_col - region.start_col + 1,
            )
        } else {
            (1, 1)
        };
        (span.0, span.1, None)
    } else {
        (1, 1, Some(dep_sheet_idx))
    };

    updated_cells.push(CellData {
        row: dep_row,
        col: dep_col,
        display: dep_display, overflow: dep_overflow,
        display_color: None,
        formula: if include_formulas {
            formula_display(&updated_dep, locale)
        } else {
            None
        },
        style_index: grids[dep_sheet_idx].effective_style_index(dep_row, dep_col),
        row_span: dep_row_span,
        col_span: dep_col_span,
        sheet_index: dep_sheet_index,
        rich_text: None,
        accounting_layout: None,
    });

    true
}

/// Cascade value changes to their cross-sheet dependents — the shared body of
/// every edit path's cross-sheet walk (`update_cell`, `update_cells_batch`,
/// `fill_range`, the targeted control recalc in control_values.rs and the
/// visibility recalc in calculation.rs all call exactly this).
///
/// Walks `cross_sheet_dependents_map` with a work queue: each changed cell's
/// dependents on OTHER sheets are re-evaluated and queued, so chains
/// (Sheet1 -> Sheet2 -> Sheet3 -> ...) propagate; and every cell the walk
/// itself reaches expands into its own sheet's same-sheet dependents, in
/// topological order, through `SheetDependencyIndex` — that sheet's graph, not
/// the active sheet's.
///
/// Dependents re-evaluated by this walk spill through the shared
/// [`apply_spill_decision`], on their own sheet, and are evaluated at their own
/// cell (position and the cube/custom-function preserve) — see
/// `recalc_walked_cell`.
///
/// # BUG-0019
///
/// `initial_changed` are the cells the caller edited; `already_recalced` are
/// the active-sheet cells the caller's own same-sheet cascade re-evaluated.
/// **BOTH are walk roots.** They used to differ: only `initial_changed` seeded
/// the queue and `already_recalced` was merely marked processed, so a cell that
/// changed *as a dependent* never had its cross-sheet dependents looked up. With
/// `Sheet1!C9 = SUM(C4:C8)` and `Sheet2!B3 = Sheet1!C9`, editing `Sheet1!C5`
/// recalculated `C9` and stopped dead at the sheet boundary — the first-order
/// case worked, which is exactly why it survived so long. Roots are still marked
/// processed, so seeding them costs one map probe each and can never re-evaluate
/// a cell the caller already did.
#[allow(clippy::too_many_arguments)]
pub(crate) fn cascade_cross_sheet_dependents(
    state: &AppState,
    grid: &mut Grid,
    grids: &mut Vec<Grid>,
    sheet_names: &[String],
    active_sheet: usize,
    cross_sheet_dependents_map: &crate::CrossSheetDependentsMap,
    user_files: &std::collections::HashMap<String, Vec<u8>>,
    control_values: &std::sync::Arc<crate::control_values::ControlValuesMap>,
    styles: &StyleRegistry,
    locale: &engine::LocaleSettings,
    merge_lookup: &std::collections::HashMap<(u32, u32), &MergedRegion>,
    name_tables: crate::name_resolution::NameTables<'_>,
    initial_changed: &[(u32, u32)],
    already_recalced: &[(u32, u32)],
    updated_cells: &mut Vec<CellData>,
    include_formulas: bool,
) {
    cascade_cross_sheet_dependents_from(
        state,
        grid,
        grids,
        sheet_names,
        active_sheet,
        active_sheet,
        cross_sheet_dependents_map,
        user_files,
        control_values,
        styles,
        locale,
        merge_lookup,
        name_tables,
        initial_changed,
        already_recalced,
        updated_cells,
        include_formulas,
    );
}

/// [`cascade_cross_sheet_dependents`] with its roots on `root_sheet`, which
/// need not be the active sheet: the walk itself never cared (every hop lands
/// on "another sheet" by definition), only its roots were pinned to the active
/// one. [`cascade_seeded_on_sheet`] roots it on a BACKGROUND sheet.
#[allow(clippy::too_many_arguments)]
fn cascade_cross_sheet_dependents_from(
    state: &AppState,
    grid: &mut Grid,
    grids: &mut Vec<Grid>,
    sheet_names: &[String],
    active_sheet: usize,
    root_sheet: usize,
    cross_sheet_dependents_map: &crate::CrossSheetDependentsMap,
    user_files: &std::collections::HashMap<String, Vec<u8>>,
    control_values: &std::sync::Arc<crate::control_values::ControlValuesMap>,
    styles: &StyleRegistry,
    locale: &engine::LocaleSettings,
    merge_lookup: &std::collections::HashMap<(u32, u32), &MergedRegion>,
    name_tables: crate::name_resolution::NameTables<'_>,
    initial_changed: &[(u32, u32)],
    already_recalced: &[(u32, u32)],
    updated_cells: &mut Vec<CellData>,
    include_formulas: bool,
) {
    // The cross-sheet half of the dependent cascade. Takes no `AppState`, so it
    // cannot install a token of its own — it inherits its caller's surface,
    // which is exactly right: this is the same edit, continuing onto another
    // sheet, and it must not get a different ceiling for having crossed one.
    let _governor = crate::eval_budget::inherit_or(crate::eval_budget::EvalSurface::Interactive);
    let current_sheet_name = sheet_names.get(root_sheet).cloned().unwrap_or_default();

    // The queue holds cells whose CROSS-sheet dependents have not been visited
    // yet: (sheet_index, sheet_name, row, col). Each pop crosses exactly one
    // sheet boundary; the same-sheet closure on the far side is handled in that
    // same step, so nothing needs a second kind of work item.
    let mut work_queue: Vec<(usize, String, u32, u32)> = Vec::new();
    let mut processed: HashSet<(usize, u32, u32)> = HashSet::new();
    let mut queued: HashSet<(usize, u32, u32)> = HashSet::new();

    // BUG-0019: the caller's recalculated dependents are roots too, not merely
    // "already done" — their own cross-sheet dependents have never been visited.
    for &(r, c) in initial_changed.iter().chain(already_recalced.iter()) {
        processed.insert((root_sheet, r, c));
        if queued.insert((root_sheet, r, c)) {
            work_queue.push((root_sheet, current_sheet_name.clone(), r, c));
        }
    }

    // Per-sheet dependency indexes, built on first use (see SheetDependencyIndex).
    let mut sheet_indexes: std::collections::HashMap<usize, SheetDependencyIndex> =
        std::collections::HashMap::new();

    while let Some((_source_sheet_idx, source_sheet_name, source_row, source_col)) =
        work_queue.pop()
    {
        // By the cell, its whole column or its whole row (`=SUM(Sheet2!G:G)`
        // on another sheet keys `WHOLE_LINE`, see `crate::cross_sheet_readers`).
        let Some(cross_deps) = crate::cross_sheet_readers(
            cross_sheet_dependents_map,
            &source_sheet_name,
            source_row,
            source_col,
        ) else {
            continue;
        };

        // Group this cell's cross-sheet dependents by the sheet they live on,
        // then recalculate each sheet's group AND that group's own same-sheet
        // closure in ONE topological pass over that sheet's graph. Doing it per
        // sheet rather than per cell is what makes the ordering right: the
        // dependents of a single edit can feed each other within the target
        // sheet, and `cross_sheet_dependents` is an unordered hash set.
        //
        // BTreeMap + sorted seeds so a workbook recalculates identically on
        // every run; hash iteration order must not reach cell values.
        let mut by_sheet: std::collections::BTreeMap<usize, Vec<(u32, u32)>> =
            std::collections::BTreeMap::new();
        for &(dep_sheet_idx, dep_row, dep_col) in cross_deps.iter() {
            if dep_sheet_idx < grids.len() {
                by_sheet
                    .entry(dep_sheet_idx)
                    .or_default()
                    .push((dep_row, dep_col));
            }
        }

        for (dep_sheet_idx, mut seeds) in by_sheet {
            seeds.sort_unstable();
            if !sheet_indexes.contains_key(&dep_sheet_idx) {
                let built =
                    SheetDependencyIndex::build(&grids[dep_sheet_idx], dep_sheet_idx, name_tables);
                sheet_indexes.insert(dep_sheet_idx, built);
            }
            let order = sheet_indexes[&dep_sheet_idx].recalc_order(&seeds);

            for (dep_row, dep_col) in order {
                if !processed.insert((dep_sheet_idx, dep_row, dep_col)) {
                    continue;
                }
                let changed = recalc_walked_cell(
                    state,
                    grid,
                    grids,
                    sheet_names,
                    active_sheet,
                    dep_sheet_idx,
                    dep_row,
                    dep_col,
                    user_files,
                    control_values,
                    styles,
                    locale,
                    merge_lookup,
                    name_tables,
                    updated_cells,
                    include_formulas,
                );
                // Queued for its CROSS-sheet dependents only — its same-sheet
                // half was just covered by this sheet's topological order.
                if changed {
                    if let Some(dep_sheet_name) = sheet_names.get(dep_sheet_idx) {
                        if queued.insert((dep_sheet_idx, dep_row, dep_col)) {
                            work_queue.push((
                                dep_sheet_idx,
                                dep_sheet_name.clone(),
                                dep_row,
                                dep_col,
                            ));
                        }
                    }
                }
            }
        }
    }
}

/// Batch update multiple cells in a single operation.
/// This is significantly faster than calling update_cell multiple times
/// because it acquires locks once and processes all cells together.
/// Recalculation of dependents happens once at the end, after all cells are updated.
///
/// Thin command wrapper around `update_cells_batch_with_controls`; afterwards,
/// if any edited cell is the ANCHOR of a NAMED on-grid control, the shared
/// targeted control recalc refreshes GET.CONTROLVALUE dependents of those
/// names (see `update_cell` for the rationale and the recursion argument).
///
/// `cube_results` (BUG-0476): the cube data the async `cube_prefetch` resolved
/// for THIS batch's writes (its `edits` shape), exactly as `update_cell` takes
/// the single edit's: every cube cell the batch evaluates, its cascade
/// included (`active_sheet_write_cascade`). The frontend sends it for a batch
/// that writes a CUBE formula and, once the session has seen one, for every
/// batch (a paste into a cube argument cell re-evaluates the cube cell), so a
/// workbook with no cube stays one call; without it a script's or an
/// extension's `=CUBEVALUE(...)` showed #N/A.
#[tauri::command]
pub fn update_cells_batch(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    updates: Vec<crate::api_types::CellUpdateInput>,
    udf_results: Option<std::collections::HashMap<String, crate::scripting::udf::UdfValue>>,
    udf_volatile_cells: Option<Vec<crate::scripting::udf::UdfCellRef>>,
    cube_results: Option<engine::CubePrefetch>,
    target: Option<crate::api_types::CellTargetRef>,
) -> Result<Vec<CellData>, String> {
    // P3: an OBJECT's cells (a paste, AutoSum or Fill Series into a floating
    // grid). A route of its own, BEFORE the active-sheet body: that body's
    // protection check, control-anchor probe and core are all keyed on the
    // active sheet. The target route carries literal values and formulas
    // only, so no UDF results ride along.
    if let Some(target) = target.as_ref() {
        return crate::cell_target::update_cells_batch_on_target(
            &state,
            &file_state,
            &user_files_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
            target,
            updates,
            "Paste",
        );
    }
    // Protected-region guard (paste / fill / multi-edit): reject the WHOLE
    // batch before any mutation when a target cell sits inside a pivot/report
    // output region — the single-cell edit path (update_cell_impl) already
    // rejects these, and a partial paste would be worse than none.
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        check_region_cells_protection(&state, active_sheet, updates.iter().map(|u| (u.row, u.col)))?;
    }

    // PERF-03: one lookup-index cache for the whole pass (lookup_cache.rs).
    let _lookup_pass = engine::begin_lookup_pass();
    // SUBTOTAL/AGGREGATE row-visibility snapshot: built ONCE for this
    // pass (never per formula) and read by the evaluator through the
    // thread-local pass scope. Built BEFORE any grid lock is taken.
    let _visibility_pass = crate::row_visibility::begin_pass(&state);
    // GET.CONTROLVALUE snapshot: built ONCE per batch, BEFORE the grid locks
    // in the core (canonical lock order); shared across every evaluation.
    let control_values = crate::control_values::build_control_values(
        &state, &pane_control_state, &ribbon_filter_state,
    );

    // Anchor probe for NAMED on-grid controls (one map probe per edited cell,
    // skipped entirely when the workbook has no on-grid controls): editing an
    // anchor changes that control's GET.CONTROLVALUE value, which the
    // dependency maps cannot see. Names are collected BEFORE the batch core
    // runs; the targeted recalc runs AFTER it, once every core lock dropped.
    let anchor_names: Vec<String> = {
        let active_sheet = *state.active_sheet.read().unwrap();
        let controls = state.controls.read().unwrap();
        if controls.is_empty() {
            Vec::new()
        } else {
            let mut names: Vec<String> = updates
                .iter()
                .filter_map(|u| {
                    controls
                        .get(&(active_sheet, u.row, u.col))
                        .and_then(crate::control_values::static_control_name)
                })
                .collect();
            names.sort();
            names.dedup();
            names
        }
    };

    // Plain refs (tauri's State::inner returns &'r T) for the core and the
    // post-batch recalc.
    let state_ref = state.inner();
    let user_files_ref = user_files_state.inner();
    let pivot_ref = pivot_state.inner();
    let pane_ref = pane_control_state.inner();
    let ribbon_ref = ribbon_filter_state.inner();

    let mut cells = update_cells_batch_core(
        state_ref,
        file_state.inner(),
        user_files_ref,
        pivot_ref,
        updates,
        udf_results,
        udf_volatile_cells,
        Some(control_values),
        cube_results,
    )?;

    // Named-anchor edits: refresh GET.CONTROLVALUE dependents of the edited
    // controls. No recursion by construction — the recalc core only
    // re-evaluates formulas; it never re-enters update_cell(s_batch) or the
    // anchor probe above.
    if !anchor_names.is_empty() {
        let extra = crate::control_values::recalc_control_dependents_core(
            state_ref,
            user_files_ref,
            pivot_ref,
            pane_ref,
            ribbon_ref,
            Some(anchor_names),
        )?;
        cells.extend(extra);
    }

    Ok(cells)
}

/// Core of `update_cells_batch`, callable from Rust-side paths that cannot
/// reach the pane-control/ribbon-filter states (the script apply path is also
/// invoked from mcp/tools.rs, owned by a parallel workstream).
/// `control_values: None` => GET.CONTROLVALUE evaluates to #N/A in this pass (v1).
///
/// Rust-side callers have no UDF pre-fetch (they cannot run JS off-thread), so
/// they get no volatile-UDF splice either — exactly as before. Nor a cube
/// pre-fetch (the BI model is async; these callers are synchronous): a CUBE
/// formula one of them writes keeps the preserve-or-#N/A behaviour.
pub(crate) fn update_cells_batch_with_controls(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    updates: Vec<crate::api_types::CellUpdateInput>,
    udf_results: Option<std::collections::HashMap<String, crate::scripting::udf::UdfValue>>,
    control_values: Option<std::sync::Arc<crate::control_values::ControlValuesMap>>,
) -> Result<Vec<CellData>, String> {
    update_cells_batch_core(
        state.inner(),
        file_state.inner(),
        user_files_state.inner(),
        pivot_state.inner(),
        updates,
        udf_results,
        None,
        control_values,
        None,
    )
}

/// Which MOVE claims of a batch are honoured (`CellUpdateInput::moved`), one
/// flag per update. A claim names its source cell; it is honoured only when
/// that cell -- on the named sheet (the active one read from its mirror),
/// read under the batch's held grid guards and BEFORE any of the batch's
/// writes -- shows exactly the style the write carries (its displayed index,
/// `effective_style_index`, which is what the cut route sends). A claim with
/// no style, a sheet that does not exist, or a source showing another style is
/// NOT honoured, and the write is a copy: on a protected sheet without Format
/// Cells its format is dropped. This is what keeps `moved` from being a way to
/// land an arbitrary style on an unlocked cell of a protected sheet: a move can
/// carry only a format some cell holds, as a real cut does.
///
/// `source_sheets`: each update's source SHEET index
/// ([`move_claim_source_sheets`]): the named sheet, or for an OBJECT source (a
/// floating grid's cell) its backing sheet, whose cells are the object's own.
pub(crate) fn honoured_move_claims(
    updates: &[crate::api_types::CellUpdateInput],
    source_sheets: &[Option<usize>],
    active_grid: &Grid,
    grids: &[Grid],
    active_sheet: usize,
) -> Vec<bool> {
    updates
        .iter()
        .zip(source_sheets.iter().copied().chain(std::iter::repeat(None)))
        .map(|(update, sheet)| {
            let (Some(from), Some(style), Some(sheet)) = (update.moved.as_ref(), update.style_index, sheet) else {
                return false;
            };
            let source = if sheet == active_sheet { Some(active_grid) } else { grids.get(sheet) };
            source.is_some_and(|grid| grid.effective_style_index(from.row, from.col) == style)
        })
        .collect()
}

/// The source sheet of each update's MOVE claim, resolved holding NOTHING
/// (before the batch takes its guards): the claim's `sheet_index`, or for an
/// object source the backing sheet `resolve_cell_target` names; `None` with no
/// claim or a target that does not resolve (that claim is then a copy).
pub(crate) fn move_claim_source_sheets(
    state: &AppState,
    updates: &[crate::api_types::CellUpdateInput],
) -> Vec<Option<usize>> {
    let mut resolved: Vec<(crate::api_types::CellTargetRef, Option<usize>)> = Vec::new();
    updates
        .iter()
        .map(|update| {
            let from = update.moved.as_ref()?;
            let Some(target) = &from.target else {
                return Some(from.sheet_index);
            };
            if let Some((_, sheet)) = resolved.iter().find(|(t, _)| t == target) {
                return *sheet;
            }
            let sheet = crate::cell_target::resolve_cell_target(state, target).ok().map(|t| t.backing_index);
            resolved.push((target.clone(), sheet));
            sheet
        })
        .collect()
}

/// The batch body. Split from `update_cells_batch_with_controls` so the Tauri
/// command can pass the volatile-UDF cell list the frontend's pre-fetch found
/// (and the cube data, BUG-0476) without changing the signature Rust-side
/// callers (script apply / MCP tools) already use. Over plain references, so
/// the tests drive the real body with no Tauri runtime.
///
/// `cube_results`: the batch's cube pre-fetch (`cube_prefetch` with `edits`),
/// served to the written cells' own evaluation -- under manual calculation
/// too, as `update_cell` serves the edited cell -- and to the dependent
/// cascade, which re-evaluates the written cells after every write has
/// landed. `None` is exactly the behaviour before it existed.
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_cells_batch_core(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    updates: Vec<crate::api_types::CellUpdateInput>,
    udf_results: Option<std::collections::HashMap<String, crate::scripting::udf::UdfValue>>,
    udf_volatile_cells: Option<Vec<crate::scripting::udf::UdfCellRef>>,
    control_values: Option<std::sync::Arc<crate::control_values::ControlValuesMap>>,
    cube_results: Option<engine::CubePrefetch>,
) -> Result<Vec<CellData>, String> {
    // Batch cell writes are still an interactive edit — a paste, a script's
    // setValues, a fill — and every result is persisted, so the same ceiling as
    // a single edit. Note the list here is NOT caller-supplied in the sense
    // that matters for BATCH_FUEL: the cells written are cells, and their
    // dependents are the workbook's own.
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Interactive,
        &state.calc_cancel,
    );
    use std::collections::HashMap;
    use std::time::Instant;
    let perf_t0 = Instant::now();

    // An absent snapshot behaves exactly like an empty one (every lookup
    // misses -> #N/A/default), so normalize to keep the eval sites uniform.
    let control_values = control_values.unwrap_or_default();

    // Build the apply-time UDF resolver from the pre-fetched results table (if
    // any). Omitting udfResults -> None -> behavior identical to before.
    let udf_resolver = udf_results.as_ref().map(|t| crate::scripting::udf::make_udf_resolver(t));
    // The batch's pre-fetched CUBE data (BUG-0476), shared by the written
    // cells' evaluation and the dependent cascade, as in `update_cell_impl`.
    let cube_arc = cube_results.map(std::sync::Arc::new);
    // NOTE: user files are locked BELOW, after the grid locks -- canonical lock
    // order. Locked here, they were held across `state.grid`, which is the
    // order the recalculation pass takes on a background thread inverted.
    let perf_batch_size = updates.len();

    // Early return for empty batch
    if updates.is_empty() {
        return Ok(Vec::new());
    }

    // Sheet protection. Deliberately checked HERE, in the shared core, rather
    // than in the `update_cells_batch` wrapper: the script host and the MCP
    // tools call this function directly (scripting/commands.rs), so a gate in
    // the wrapper would leave exactly those surfaces unenforced — which is how
    // the region check above ended up with that hole.
    //
    // Scripts are gated like any other writer. Excel's VBA equivalent is
    // `Protect(UserInterfaceOnly:=True)`, which defaults to False; enforcing by
    // default is both the Excel-faithful and the secure choice, and Calcula's
    // script surfaces are sandboxed precisely so they do not get ambient
    // authority the user did not grant.
    //
    // WHOLE-BATCH rejection, not partial: `CellUpdateInput` carries no sheet
    // field, so a batch is one sheet's worth of one user gesture (a paste, a
    // fill). Excel refuses such a gesture outright rather than applying the part
    // that happens to land on unlocked cells.
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        crate::protection::check_sheet_protection_cells(
            &state,
            active_sheet,
            updates.iter().map(|u| (u.row, u.col)),
        )?;
    }

    // Check if any target cell is a spilled value (before acquiring other locks)
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        let spill_hosts = state.spill_hosts.lock().unwrap();
        for update in &updates {
            // Single cell: `Refuse` and `ReleasedByCaller` are the same answer
            // here (a spilled cell's origin is never that cell), and this
            // writer replaces content rather than swallowing a block.
            check_spill_protection(
                &spill_hosts, active_sheet,
                update.row, update.col, update.row, update.col,
                SpillOriginPolicy::Refuse,
            )?;
        }
    }

    // Filter out cells in writeback regions (partial-success semantics)
    let (updates, skipped_writeback) = {
        let wb_index = state.writeback_index.lock().unwrap();
        if wb_index.is_empty() {
            (updates, 0usize)
        } else {
            let active_sheet = *state.active_sheet.read().unwrap();
            let sheet_ids = state.sheet_ids.read().unwrap();
            if let Some(&sid) = sheet_ids.get(active_sheet) {
                let mut kept = Vec::with_capacity(updates.len());
                let mut skipped = 0usize;
                for u in updates {
                    if wb_index.contains(sid, u.row, u.col) {
                        skipped += 1;
                    } else {
                        kept.push(u);
                    }
                }
                (kept, skipped)
            } else {
                (updates, 0usize)
            }
        }
    };

    // After writeback filtering, batch may be empty
    if updates.is_empty() {
        // TODO(v1.1): surface skipped_writeback in writeback side pane
        let _ = skipped_writeback;
        return Ok(Vec::new());
    }

    // A MOVE claim's object source resolves to its backing sheet HERE, holding
    // nothing (`resolve_cell_target` takes guards of its own); the claim is
    // judged under the guards below (`honoured_move_claims`).
    let move_source_sheets = move_claim_source_sheets(state, &updates);

    // Every gate above has passed; from here this command commits. Constructed
    // HERE and not at the top so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    // CANONICAL LOCK ORDER: both grid locks FIRST, then everything else.
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let user_files = user_files_state.files.lock().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    // WRITE, not read: a typed date or percentage interns the number format
    // its entry implies, exactly as `update_cell_impl` does. Same lock in the
    // same position of the canonical order, just exclusive — and it has to be
    // taken that way HERE, because `Persisted<T>` wraps a std `Mutex` and is
    // not reentrant, so upgrading it mid-loop would deadlock.
    let mut styles = state.style_registry.write(&effect).unwrap();
    // A PROTECTED SHEET'S FORMATTING (Excel parity), decided HERE under the
    // held grid and style guards -- never from a read taken before them -- and
    // released at once (`sheet_protection` after `style_registry`, the order
    // `format_protection_under_guards` uses). A pasted / filled `styleIndex` is
    // a FORMAT: written only when the sheet allows Format Cells, else the value
    // lands and the cell keeps its own format; and every written cell keeps
    // the Locked flag it had (`keep_cell_lock`). Excel [LIVE, Excel 16 COM,
    // 2026-10-30, fmtprot/probe1-2.ps1]: Paste All of a bold, locked C1 onto an
    // unlocked A3 -- Format Cells not allowed: A3 = 5, not bold, unlocked, no
    // error; allowed: A3 = 5, bold 0.00, still unlocked.
    let (sheet_protected, format_allowed) = {
        let protection = state.sheet_protection.read().unwrap();
        match protection.get(&active_sheet) {
            Some(p) if p.protected => (true, p.is_action_allowed("formatCells")),
            _ => (false, true),
        }
    };
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    // DEFINED-NAME edges. Locked in the same phase as the other dependency maps
    // and in declaration order, so the canonical lock order stays one sequence.
    let mut name_dependents_map = state.name_dependents.lock().unwrap();
    let mut name_dependencies_map = state.name_dependencies.lock().unwrap();
    let mut table_dependents_map = state.table_dependents.lock().unwrap();
    let mut table_dependencies_map = state.table_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let calc_mode = state.calculation_mode.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    // Lock pivot state for GETPIVOTDATA support
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let pivot_views = pivot_state.views.lock().unwrap();
    let pivot_data_fn = |data_field: &str, pivot_sheet: Option<&str>, pivot_row: u32, pivot_col: u32, pairs: &[(&str, &str)]| -> Option<f64> {
        crate::pivot::operations::lookup_pivot_data(
            &pivot_tables,
            &pivot_views,
            data_field,
            pivot_sheet,
            pivot_row,
            pivot_col,
            pairs,
        )
    };

    // Pre-fetch writeback submissions so GATHER formulas see current data
    // (empty map, no registry I/O, when the workbook has no writeback regions).
    let gather_data = crate::calp_commands::build_gather_data(&state);
    let gather_fn = |region_id: &str| -> engine::GatherRegionData {
        gather_data.get(region_id).cloned().unwrap_or_default()
    };

    // Only open a new undo transaction if one isn't already open
    // (e.g. the frontend may have called beginUndoTransaction for cut+paste)
    let opened_transaction = !undo_stack.has_open_transaction();
    if opened_transaction {
        undo_stack.begin_transaction(format!("Batch update {} cells", updates.len()));
    }
    let perf_t1_locks = Instant::now();

    let mut updated_cells = Vec::new();
    let mut cells_needing_recalc: Vec<(u32, u32)> = Vec::new();
    // Pre/post cell states collected for subscriber override capture.
    let mut override_edits: Vec<(u32, u32, Option<engine::Cell>, Option<engine::Cell>)> = Vec::new();

    // Build merge lookup once for efficiency
    let merge_lookup: HashMap<(u32, u32), &MergedRegion> = merged_regions
        .iter()
        .map(|r| ((r.start_row, r.start_col), r))
        .collect();

    // Which MOVE claims this batch honours (`CellUpdateInput::moved`), decided
    // once, BEFORE any write: a move whose source overlaps its destination
    // would otherwise read a source cell this same batch already overwrote.
    let honoured_moves = honoured_move_claims(&updates, &move_source_sheets, &grid, &grids, active_sheet);

    // Process each update
    for (update_index, update) in updates.iter().enumerate() {
        let row = update.row;
        let col = update.col;
        let value = &update.value;

        // Check if cell is in a protected region
        // Note: We skip the check here since fill operations should not target protected cells
        // and checking 240 cells individually would be slow. The frontend should validate.

        // Record previous state for undo
        let previous_cell = grid.get_cell(row, col).cloned();
        // The format this write carries (none when the protected sheet does
        // not allow Format Cells), and -- on a protected sheet -- the Locked
        // flag the cell has NOW, which it keeps whatever the write brings.
        // A MOVED cell's format moves with it whatever the option says
        // (`CellUpdateInput::moved`; Excel [LIVE, rev14A/probe-cut.ps1]: a
        // bold 0.00 cell cut to an unlocked cell of a protected sheet lands
        // bold 0.00 with Format Cells off or on -- only a COPY drops it). The
        // claim is honoured only when its source holds that style
        // (`honoured_move_claims`); an unbound claim is a copy.
        let requested_style =
            if format_allowed || honoured_moves[update_index] { update.style_index } else { None };
        let locked_before =
            sheet_protected && crate::protection::cell_is_locked(&grid, &styles, row, col);

        // The spill this cell used to own dies here, whatever replaces it —
        // one release for every branch below, exactly as in `update_cell_impl`
        // and for the same two reasons (§2y). This is the PASTE path, and it
        // had no release outside the formula branch at all: pasting a literal
        // over the origin of a dynamic array left the map claiming cells that
        // no formula produced. One `spill_ranges` lock and one `is_empty()` per
        // written cell when the workbook holds no array.
        {
            let released = take_spills_owned_within(&state, active_sheet, row, col, row, col);
            erase_released_spill_cells(
                &mut grid,
                &mut grids,
                active_sheet,
                active_sheet,
                &released,
                &mut updated_cells,
            );
        }

        // ...and a cell an EARLIER write of this batch spilled into stops
        // being that array's: its spill is released, the cell is this write's
        // (`release_fresh_spill_under_write`). Pasting B1:B3 = (=SEQUENCE(3)
        // showing #SPILL!, blank, "x") at D1 spilled D1 over D2:D3 and then
        // wrote "x" into D3 under D1's claim, and the cascade's re-decision
        // released the claim by ERASING D3 -- the user's "x" was gone and D1
        // showed 1,2,3. With the claim gone, the re-decision finds D3 occupied
        // and D1 is #SPILL!, as in Excel.
        release_fresh_spill_under_write(
            &state,
            &mut grid,
            &mut grids,
            active_sheet,
            row,
            col,
            &mut updated_cells,
        );

        // Handle empty value - clear the cell
        if value.trim().is_empty() {
            // A writer that names a style for a BLANK -- a pasted, filled or
            // moved empty position, which sends the source's displayed index --
            // names its LOOK (BUG-0354 follow-up): the position keeps it as an
            // empty cell of that style wherever the row/column format there
            // would show something else [LIVE, Excel 16: an empty plain
            // position cut or copied into a bold row stays plain]. The same
            // look as the line: cleared. No style named: see below.
            let blank_style = match requested_style {
                Some(requested) => crate::commands::styles::carried_line_format(
                    &mut styles,
                    requested,
                    crate::commands::styles::line_format_index_at(&grid, row, col),
                ),
                // No style named -- a script's `setValues("")`, an empty field
                // of pasted text -- or the named one refused (Format Cells not
                // allowed): the value goes and the position keeps its OWN
                // format, as a pasted value does. Excel [LIVE, Excel 16 COM,
                // 2026-10-31, cutfmt/probe1.ps1]: `Range.Value2 = ""` on a bold
                // 0.00 unlocked cell leaves it bold 0.00 and unlocked, on an
                // unprotected sheet and on a protected one with Format Cells
                // off or on. This used to clear the whole cell (style 0), so a
                // protected sheet's lock keep then cloned the LINE format.
                None => previous_cell.as_ref().map_or(0, |c| c.style_index),
            };
            // A protected sheet: the position keeps its Locked flag -- a
            // cleared UNLOCKED cell used to come back locked (the default).
            let blank_style = if sheet_protected {
                crate::commands::styles::keep_cell_lock(&mut styles, &grid, row, col, blank_style, locked_before)
            } else {
                blank_style
            };
            if blank_style != 0 {
                grid.set_cell(row, col, blank_cell_with_style(blank_style));
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(row, col, blank_cell_with_style(blank_style));
                }
            } else {
                grid.clear_cell(row, col);
                if active_sheet < grids.len() {
                    grids[active_sheet].clear_cell(row, col);
                }
            }
            // Clear dependencies
            update_cross_sheet_dependencies(
                (active_sheet, row, col),
                Default::default(),
                &mut cross_sheet_dependencies_map,
                &mut cross_sheet_dependents_map,
            );
            update_dependencies(
                (row, col),
                Default::default(),
                &mut dependencies_map,
                &mut dependents_map,
            );
            update_column_dependencies(
                (row, col),
                Default::default(),
                &mut column_dependencies_map,
                &mut column_dependents_map,
            );
            update_row_dependencies(
                (row, col),
                Default::default(),
                &mut row_dependencies_map,
                &mut row_dependents_map,
            );

            let (row_span, col_span) = if let Some(region) = merge_lookup.get(&(row, col)) {
                (
                    region.end_row - region.start_row + 1,
                    region.end_col - region.start_col + 1,
                )
            } else {
                (1, 1)
            };

            updated_cells.push(CellData {
                row,
                col,
                display: String::new(),
                // Empty: nothing to overflow, and text never marks.
                overflow: crate::api_types::OverflowClass::Text,
                display_color: None,
                formula: None,
                // What the position SHOWS: its blank's style, else its line's.
                style_index: grid.effective_style_index(row, col),
                row_span,
                col_span,
                sheet_index: None,
                rich_text: None,
                accounting_layout: None,
            });

            override_edits.push((row, col, previous_cell.clone(), grid.get_cell(row, col).cloned()));
            undo_stack.record_cell_change(active_sheet, row, col, previous_cell);
            cells_needing_recalc.push((row, col));
            continue;
        }

        // Parse the input. When invariant=true, skip delocalization (formula already in US format).
        //
        // The INVARIANT branch takes no implied format: it is a script's typed
        // write in canonical US form, and a script that means to write a date
        // says so with a format of its own rather than having one inferred from
        // the string it passed.
        //
        // BOTH branches are told the format the entry LANDS in, which is the
        // opposite direction and applies to a script as much as to a paste: an
        // `@` cell stores what it was given, verbatim (see the ladder). An
        // explicit `styleIndex` on the update wins, because that IS the cell's
        // format once this write completes; otherwise it is the format that
        // effectively applies at the position, row and column tiers included.
        //
        // A PASTE is not an entry (`CellUpdateInput::pasted`): the ladder is
        // told no destination format, so its Text rung -- the only rung the
        // format moves -- stays out of it, and a pasted formula or number
        // stays one in an `@` cell, as in Excel. This replaced three frontend
        // detours that rewrote the cell under General and put the `@` back;
        // Paste Special's sent `styleIndex: 0`, which also replaced the
        // cell's PROTECTION flags, so an unlocked input cell on a protected
        // sheet came back locked.
        let target_format = match requested_style {
            Some(idx) => styles.get(idx).number_format.clone(),
            None => entry_format_at(&grid, &styles, row, col),
        };
        // (Never on one line as `{ None } else { .. }`: the lock-order census
        // applies a line's closes before its opens, and two closes here would
        // drop it below the grid guard's block and lose track of the guard.)
        let ladder_format = if update.is_paste() {
            None
        } else {
            Some(&target_format)
        };
        let (mut cell, implied_format) = if update.invariant.unwrap_or(false) {
            (
                parse_cell_input_invariant_in_format(value, &locale, ladder_format),
                None,
            )
        } else {
            parse_cell_input_in_format(value, &locale, ladder_format)
        };

        // Apply explicit style from input if provided, otherwise preserve
        // existing. An explicit index names the LOOK the cell must show -- a
        // paste, a fill, a script's paste "all" send the source cell's
        // DISPLAYED index -- so index 0 (Normal) under a row/column format is
        // the explicit Normal, never "inherit" (BUG-0354 follow-up; Excel
        // [LIVE]: a plain cell copied, cut or filled into a bold row stays
        // plain). With no index the cell keeps its own, so a typed value
        // under a line format still inherits it.
        if let Some(explicit_style) = requested_style {
            cell.style_index = crate::commands::styles::own_index_for_requested_look(
                &mut styles,
                &grid,
                row,
                col,
                explicit_style,
            );
        } else if let Some(existing) = grid.get_cell(row, col) {
            cell.style_index = existing.style_index;
        }

        // The implied format claims only a `General` cell, and never one the
        // caller styled explicitly — see the same rule in `update_cell_impl`.
        if let Some(fmt) = implied_format {
            if requested_style.is_none()
                && styles.get(cell.style_index).number_format == engine::NumberFormat::General
            {
                let restyled = styles.get(cell.style_index).clone().with_number_format(fmt);
                cell.style_index = styles.get_or_create(restyled);
            }
        }

        // A protected sheet: the cell keeps the Locked flag it had, whatever
        // format the write brought (Excel [LIVE], see `format_allowed` above).
        if sheet_protected {
            cell.style_index = crate::commands::styles::keep_cell_lock(
                &mut styles,
                &grid,
                row,
                col,
                cell.style_index,
                locked_before,
            );
        }

        // If it's a formula, evaluate it
        if let Some(formula) = cell.formula_string() {
            match parser::parse(&formula) {
                Ok(parsed) => {
                    // THE CELL KEEPS THE NAME (Excel parity, D2) — one recipe,
                    // shared with update_cell and fill_range.
                    let entered =
                        crate::split_entered_formula(&state, &parsed, active_sheet, row, col, &sheet_names);
                    let resolved = entered.evaluated();

                    let refs = extract_all_references(resolved, &grid);

                    update_dependencies(
                        (row, col),
                        refs.cells,
                        &mut dependencies_map,
                        &mut dependents_map,
                    );
                    update_column_dependencies(
                        (row, col),
                        refs.columns,
                        &mut column_dependencies_map,
                        &mut column_dependents_map,
                    );
                    update_row_dependencies(
                        (row, col),
                        refs.rows,
                        &mut row_dependencies_map,
                        &mut row_dependents_map,
                    );

                    // Normalize cross-sheet references
                    update_cross_sheet_dependencies(
                        (active_sheet, row, col),
                        crate::normalize_cross_sheet_refs(&refs.cross_sheet_cells, &sheet_names),
                        &mut cross_sheet_dependencies_map,
                        &mut cross_sheet_dependents_map,
                    );

                    // DEFINED-NAME edges, from the tree the cell KEEPS.
                    {
                        let mut names = crate::name_resolution::NameSet::default();
                        crate::name_resolution::collect_names(&entered.stored, &mut names);
                        crate::name_resolution::update_name_dependencies(
                            (row, col),
                            names,
                            &mut name_dependencies_map,
                            &mut name_dependents_map,
                        );
                    }

                    // STRUCTURED-REFERENCE edges (§2aj), same tree.
                    {
                        let mut tables = crate::table_deps::TableSet::default();
                        crate::table_deps::collect_table_names(&entered.stored, &mut tables);
                        crate::table_deps::update_table_dependencies(
                            (row, col),
                            tables,
                            &mut table_dependencies_map,
                            &mut table_dependents_map,
                        );
                    }

                    // PERF: Convert the already-parsed AST directly instead of re-parsing.
                    // This eliminates a redundant parse_formula() call per cell.
                    let engine_ast = crate::convert_expr(resolved);
                    cell.set_cached_ast(crate::convert_expr(&entered.stored));

                    // Use raw evaluation to get EvalResult for spill handling.
                    // The batch's cube data serves a CUBE formula it writes --
                    // in either calculation mode, like the single edit's.
                    let eval_ctx = engine::EvalContext {
                        cube_prefetch: cube_arc.clone(),
                        current_row: Some(row),
                        current_col: Some(col),
                        row_heights: None,
                        column_widths: None,
                        hidden_rows: None,
                        control_values: Some(control_values.clone()),
                    };
                    let raw_result = crate::evaluate_formula_raw_with_files_and_pivot(
                        &grids,
                        &sheet_names,
                        active_sheet,
                        &engine_ast,
                        eval_ctx,
                        Some(&styles),
                        &user_files,
                        Some(&pivot_data_fn),
                        Some(&gather_fn),
                        udf_resolver.as_ref().map(|r| r as &dyn Fn(&str, &[EvalResult]) -> Option<EvalResult>),
                    );

                    // The range this cell used to own was already released, at
                    // the top of the loop, BEFORE the formula was evaluated —
                    // see the hoisted tear-down there. THE ONE SPILL DECISION
                    // releases again (finding nothing) and then decides.
                    cell.value = apply_spill_decision(
                        &state,
                        &mut grid,
                        &mut grids,
                        active_sheet,
                        active_sheet,
                        row,
                        col,
                        &raw_result,
                        &styles,
                        &locale,
                        &mut updated_cells,
                    );
                }
                Err(_e) => {
                    let result =
                        evaluate_formula_multi_sheet_with_files(&grids, &sheet_names, active_sheet, &formula, &user_files);
                    cell.value = result;
                }
            }
        } else {
            // Clear dependencies for non-formula cells
            update_dependencies(
                (row, col),
                Default::default(),
                &mut dependencies_map,
                &mut dependents_map,
            );
            update_cross_sheet_dependencies(
                (active_sheet, row, col),
                Default::default(),
                &mut cross_sheet_dependencies_map,
                &mut cross_sheet_dependents_map,
            );
            update_column_dependencies(
                (row, col),
                Default::default(),
                &mut column_dependencies_map,
                &mut column_dependents_map,
            );
            update_row_dependencies(
                (row, col),
                Default::default(),
                &mut row_dependencies_map,
                &mut row_dependents_map,
            );
        }

        // Store the cell
        grid.set_cell(row, col, cell.clone());
        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(row, col, cell.clone());
        }

        // Get the display value
        let style = styles.get(grid.effective_style_index(row, col));
        let (display, overflow) = crate::format_cell_value_and_class(&cell.value, style, &locale);

        let (row_span, col_span) = if let Some(region) = merge_lookup.get(&(row, col)) {
            (
                region.end_row - region.start_row + 1,
                region.end_col - region.start_col + 1,
            )
        } else {
            (1, 1)
        };

        updated_cells.push(CellData {
            row,
            col,
            display,
            overflow,
            display_color: None,
            formula: formula_display(&cell, &locale),
            style_index: grid.effective_style_index(row, col),
            row_span,
            col_span,
            sheet_index: None,
            rich_text: None,
            accounting_layout: None,
        });

        override_edits.push((row, col, previous_cell.clone(), grid.get_cell(row, col).cloned()));
        undo_stack.record_cell_change(active_sheet, row, col, previous_cell);
        cells_needing_recalc.push((row, col));
    }

    // Record subscriber overrides for all edited cells (subscribed sheets only)
    crate::calp_commands::record_subscription_override_edits(&state, &crate::document_effect::DocumentEffect::mutates(&file_state), active_sheet, &override_edits);

    let perf_t2_processed = Instant::now();

    // Manual calculation: the dependents stay as they are, and the workbook
    // says so (Excel's xlPending -> the status bar's "Calculate").
    if *calc_mode != "automatic" {
        note_manual_write_left_formulas_uncalculated(
            &grid,
            &cells_needing_recalc,
            sheet_names.get(active_sheet).map(String::as_str).unwrap_or(""),
            &dependents_map,
            &column_dependents_map,
            &row_dependents_map,
            &cross_sheet_dependents_map,
        );
    }

    // Recalculate dependents if automatic mode - do this ONCE after all updates
    if *calc_mode == "automatic" {
        // THE CASCADE, from the one function `update_cell_impl` and the CUBE
        // pre-fetch use (`active_sheet_write_cascade`): ONE multi-root
        // traversal for the whole batch (never one full pass per written cell),
        // with the written cells as MEMBERS of the ordering, so a formula this
        // batch wrote is re-evaluated AFTER the batch cells it reads (value-only
        // batch cells are skipped by the formula check below); then the
        // whole-column/row readers, the volatile UDF cells (None for every
        // workbook with no volatile UDF, and for Rust-side callers) and the
        // volatile built-ins -- a paste is a worksheet change like any other --
        // and the dynamic arrays a written cell was BLOCKING: pasting a blank
        // over the obstruction re-spills them, as a typed Delete does
        // (`origins_blocked_by_any`; Excel [LIVE] re-spills at once).
        let unblocked_origins =
            origins_blocked_by_any(&state, active_sheet, &cells_needing_recalc);
        let all_recalc_order: Vec<(u32, u32)> = active_sheet_write_cascade(
            &grid,
            CascadeSeeds::Written(&cells_needing_recalc),
            &dependents_map,
            &column_dependents_map,
            &row_dependents_map,
            udf_volatile_cells.as_deref(),
            &unblocked_origins,
        );

        // Lock table state for cascade recalculation
        let batch_tables = state.tables.read().unwrap();
        let batch_table_names = state.table_names.read().unwrap();
        let batch_named_ranges = state.named_ranges.read().unwrap();

        // PERF-20: skip per-dependent formula render + IPC payload for wide cascades.
        let include_cascade_formulas = all_recalc_order.len() <= CASCADE_FORMULA_LIMIT;

        // Every dependent is re-evaluated through `reevaluate_formula_cell`, the
        // ONE per-cell evaluator `update_cell` and the bulk-rewrite recalculation
        // already use. It gives the dependent its OWN position -- argument-less
        // ROW()/COLUMN(), implicit intersection (`@`) and the cube and
        // custom-function preserve all ask where the formula sits -- serves the
        // pre-fetched UDF resolver and cube data when this batch carries them
        // (BUG-0476; `build_cube_prefetch` computes its result set with the same
        // `active_sheet_write_cascade`, so it covers exactly this recalc order),
        // and ends in THE ONE SPILL DECISION.
        //
        // This loop used to be a hand copy that evaluated through a POSITIONLESS
        // entry point and wrote `to_cell_value()`. A paste into A1 turned
        // `=ROW()*A1` into #VALUE!, reduced `=@A1:A10` against row 1, clobbered a
        // cube cell to #N/A and a Rust-side batch's custom-function cells to
        // #NAME? (`preserved_cube_value` / `preserved_udf_value` read the stored
        // value AT the position, so with none they had nothing to keep), and
        // collapsed a dynamic-array dependent to its first element. The written
        // cells are members of this order, so even a pasted `=ROW()` was
        // overwritten with #VALUE! by its own cascade.
        let batch_udf: Option<&dyn Fn(&str, &[EvalResult]) -> Option<EvalResult>> =
            udf_resolver.as_ref().map(|r| r as &dyn Fn(&str, &[EvalResult]) -> Option<EvalResult>);
        let mut cache_hits: u32 = 0;
        let mut cache_misses: u32 = 0;
        for &(dep_row, dep_col) in &all_recalc_order {
            let Some(dep_cell) = grid.get_cell(dep_row, dep_col).cloned() else {
                continue;
            };
            let Some(formula) = dep_cell.formula_string() else {
                continue;
            };
            reevaluate_formula_cell(
                state,
                &mut grid,
                &mut grids,
                &sheet_names,
                active_sheet,
                dep_row,
                dep_col,
                &dep_cell,
                &formula,
                &user_files,
                batch_udf,
                cube_arc.as_ref(),
                Some(&control_values),
                &styles,
                &locale,
                &merge_lookup,
                &batch_tables,
                &batch_table_names,
                &batch_named_ranges,
                &mut updated_cells,
                &mut cache_hits,
                &mut cache_misses,
                include_cascade_formulas,
            );
        }

        // Cross-sheet dependents — the SHARED walk (see BUG-0019 on
        // `cascade_cross_sheet_dependents`). This used to be a hand-copied
        // subset of it that seeded only the edited cells and never expanded a
        // non-active sheet's own dependents, so a paste feeding a summary sheet
        // updated the first hop and nothing beyond it.
        cascade_cross_sheet_dependents(
            &state,
            &mut grid,
            &mut grids,
            &sheet_names,
            active_sheet,
            &cross_sheet_dependents_map,
            &user_files,
            &control_values,
            &styles,
            &locale,
            &merge_lookup,
            crate::name_resolution::NameTables {
                named_ranges: &batch_named_ranges,
                tables: &batch_tables,
                table_names: &batch_table_names,
                sheet_names: &sheet_names,
                spill_ranges: &state.spill_ranges,
            },
            &cells_needing_recalc,
            &all_recalc_order,
            &mut updated_cells,
            include_cascade_formulas,
        );

        let perf_tend = Instant::now();
        log_perf!("BATCH",
            "update_cells_batch(N={}) cells={} | locks={:.2}ms process={:.2}ms recalc+cross={:.2}ms TOTAL={:.2}ms",
            perf_batch_size, updated_cells.len(),
            perf_t1_locks.duration_since(perf_t0).as_secs_f64() * 1000.0,
            perf_t2_processed.duration_since(perf_t1_locks).as_secs_f64() * 1000.0,
            perf_tend.duration_since(perf_t2_processed).as_secs_f64() * 1000.0,
            perf_tend.duration_since(perf_t0).as_secs_f64() * 1000.0
        );
    } else {
        let perf_tend = Instant::now();
        log_perf!("BATCH",
            "update_cells_batch(N={}) manual_mode | locks={:.2}ms process={:.2}ms TOTAL={:.2}ms",
            perf_batch_size,
            perf_t1_locks.duration_since(perf_t0).as_secs_f64() * 1000.0,
            perf_t2_processed.duration_since(perf_t1_locks).as_secs_f64() * 1000.0,
            perf_tend.duration_since(perf_t0).as_secs_f64() * 1000.0
        );
    }

    // Only commit if we opened the transaction ourselves
    if opened_transaction {
        undo_stack.commit_transaction();
    }

    // Mark workbook as dirty
    let _ = crate::document_effect::DocumentEffect::mutates(&file_state);

    Ok(updated_cells)
}

/// Clear a cell.
#[tauri::command]
/// DEPENDENTS RECALCULATE (§2c). The single-cell twin of `clear_range`, and it
/// carried the same defect: clearing one cell propagated to nothing at all.
pub fn clear_cell(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<'_, UserFilesState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    row: u32,
    col: u32,
) -> Result<(), String> {
    let active_sheet = *state.active_sheet.read().unwrap();

    // Check if cell is a spilled value
    {
        let spill_hosts = state.spill_hosts.lock().unwrap();
        // Single cell: see the note in `update_cells_batch_core`. Clearing the
        // ORIGIN is allowed (it is not a `spill_hosts` key) and the spill it
        // owns is released by the shared cascade this command seeds.
        check_spill_protection(
            &spill_hosts, active_sheet, row, col, row, col,
            SpillOriginPolicy::Refuse,
        )?;
    }

    // Sheet protection (clearing a locked cell on a protected sheet).
    crate::protection::check_sheet_protection_range(&state, active_sheet, row, col, row, col)?;

    // Object-output protection (clearing a pivot/report cell).
    check_region_range_protection(&state, active_sheet, row, col, row, col)?;

    // WRITEBACK CLAIM GUARD. `clear_cell` bypasses `update_cell_impl`
    // entirely, so erasing a respondent's answer would leave the writeback
    // layer still asserting it. Deleting an answer is a writeback-form action,
    // not a grid action — hence the range guard (which ignores drafts) rather
    // than the single-cell draft guard.
    crate::calp_commands::ensure_range_unclaimed(&state, "clear this cell", row, col, row, col)?;

    // Every gate above has passed; from here this command commits. Constructed
    // HERE and not at the top so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Record previous state for undo
    let previous_cell = grid.get_cell(row, col).cloned();

    grid.clear_cell(row, col);
    // Also update the grids vector
    if active_sheet < grids.len() {
        grids[active_sheet].clear_cell(row, col);
    }

    // Clear cross-sheet dependencies
    update_cross_sheet_dependencies(
        (active_sheet, row, col),
        Default::default(),
        &mut cross_sheet_dependencies_map,
        &mut cross_sheet_dependents_map,
    );

    update_dependencies(
        (row, col),
        Default::default(),
        &mut dependencies_map,
        &mut dependents_map,
    );
    update_column_dependencies(
        (row, col),
        Default::default(),
        &mut column_dependencies_map,
        &mut column_dependents_map,
    );
    update_row_dependencies(
        (row, col),
        Default::default(),
        &mut row_dependencies_map,
        &mut row_dependents_map,
    );

    // Record subscriber override for the cleared cell (subscribed sheets only)
    if previous_cell.is_some() {
        crate::calp_commands::record_subscription_override_edits(
            &state,
            &crate::document_effect::DocumentEffect::mutates(&file_state),
            active_sheet,
            &[(row, col, previous_cell.clone(), grid.get_cell(row, col).cloned())],
        );
    }

    // Record undo if there was actually a cell to clear
    let had_content = previous_cell.is_some();
    if had_content {
        undo_stack.record_cell_change(active_sheet, row, col, previous_cell);
        // Mark workbook as dirty
        let _ = crate::document_effect::DocumentEffect::mutates(&file_state);
    }

    // PHASE B — dependents, after every guard above is released (std mutexes
    // are not reentrant; the recalc takes the same grid + dependency maps).
    drop(undo_stack);
    drop(cross_sheet_dependencies_map);
    drop(cross_sheet_dependents_map);
    drop(row_dependencies_map);
    drop(row_dependents_map);
    drop(column_dependencies_map);
    drop(column_dependents_map);
    drop(dependencies_map);
    drop(dependents_map);
    drop(grids);
    drop(grid);

    if had_content {
        let mut recalculated = Vec::new();
        recalc_after_active_sheet_bulk_rewrite(
            &state,
            &user_files_state,
            &pane_control_state,
            &ribbon_filter_state,
            &[(row, col)],
            &mut recalculated,
        );
    }

    Ok(())
}

/// Clear a range of cells efficiently.
/// Only clears cells that actually exist within the range.
/// Returns an error if any cell in the range is a spilled value (not the origin).
///
/// DEPENDENTS RECALCULATE (§2c). This is the Delete key, and it used to
/// recalculate NOTHING — not cross-sheet, not even same-sheet. Erasing the
/// inputs of `=SUM(...)` left the total at its pre-delete number until some
/// unrelated later edit happened to sweep it up. Exactly the `sort_range`
/// defect: a bulk range command that rewrites cells and never seeds the
/// cascade. Every cell that actually held content is a seed for the ONE shared
/// `recalc_after_active_sheet_bulk_rewrite`.
#[tauri::command]
pub fn clear_range(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<'_, UserFilesState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<u32, String> {
    let active_sheet = *state.active_sheet.read().unwrap();

    // Check if any cell in the range is a spill host (part of a spilled array, not the origin)
    {
        let spill_hosts = state.spill_hosts.lock().unwrap();
        check_spill_protection(
            &spill_hosts, active_sheet, start_row, start_col, end_row, end_col,
            SpillOriginPolicy::ReleasedByCaller,
        )?;
    }

    // Sheet protection (delete-key clear over locked cells).
    crate::protection::check_sheet_protection_range(
        &state, active_sheet, start_row, start_col, end_row, end_col,
    )?;

    // Object-output protection (delete-key clear over a pivot/report region).
    check_region_range_protection(&state, active_sheet, start_row, start_col, end_row, end_col)?;

    // WRITEBACK CLAIM GUARD (see clear_cell / calp_commands.rs policy note).
    crate::calp_commands::ensure_range_unclaimed(
        &state, "clear this range", start_row, start_col, end_row, end_col,
    )?;

    // Every gate above has passed; from here this command commits. Constructed
    // HERE and not at the top so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Clamp to grid bounds to avoid iterating beyond used range
    let effective_end_row = end_row.min(grid.max_row);
    let effective_end_col = end_col.min(grid.max_col);

    // SPILLED VALUES ARE NOT THIS LOOP'S BUSINESS (§2y). The guard above let
    // the rectangle through because it swallows the ORIGIN, so the cells that
    // origin owns leave with it — released from the map and erased from the
    // grid by the shared cascade's tear-down phase. They are excluded here so
    // they get no `record_cell_change`: restoring a spilled LITERAL is not
    // undoing the delete, it is blocking the re-spill that undoing the delete
    // performs (see `spilled_cells_owned_within` for the full argument).
    //
    // Empty in every workbook with no dynamic array, at the cost of one lock
    // and one `is_empty()`.
    let owned_spill = spilled_cells_owned_within(
        &state, active_sheet, start_row, start_col, effective_end_row, effective_end_col,
    );

    // Collect cells to clear (we need to collect first to avoid borrow issues)
    let cells_to_clear: Vec<(u32, u32)> = grid
        .cells
        .keys()
        .filter(|(r, c)| {
            *r >= start_row && *r <= effective_end_row && *c >= start_col && *c <= effective_end_col
        })
        .filter(|coord| !owned_spill.contains(coord))
        .cloned()
        .collect();

    let count = cells_to_clear.len() as u32;

    // Begin undo transaction for batch operation -- OWNED: inside a caller's
    // open step (a script batch) it joins, and the close below leaves that step
    // for its owner (engine::OwnedTransaction).
    let owned_txn = if count > 0 {
        undo_stack.begin_owned_transaction(format!(
            "Clear range ({},{}) to ({},{})",
            start_row, start_col, end_row, end_col
        ))
    } else {
        engine::OwnedTransaction::not_opened()
    };

    // Pre/post cell states collected for subscriber override capture.
    let mut override_edits: Vec<(u32, u32, Option<engine::Cell>, Option<engine::Cell>)> = Vec::new();

    // Clear each cell
    for (row, col) in cells_to_clear {
        // Record previous state for undo
        let previous_cell = grid.get_cell(row, col).cloned();
        if previous_cell.is_some() {
            override_edits.push((row, col, previous_cell.clone(), None));
            undo_stack.record_cell_change(active_sheet, row, col, previous_cell);
        }

        grid.clear_cell(row, col);

        if active_sheet < grids.len() {
            grids[active_sheet].clear_cell(row, col);
        }

        // Clear dependencies
        update_cross_sheet_dependencies(
            (active_sheet, row, col),
            Default::default(),
            &mut cross_sheet_dependencies_map,
            &mut cross_sheet_dependents_map,
        );
        update_dependencies(
            (row, col),
            Default::default(),
            &mut dependencies_map,
            &mut dependents_map,
        );
        update_column_dependencies(
            (row, col),
            Default::default(),
            &mut column_dependencies_map,
            &mut column_dependents_map,
        );
        update_row_dependencies(
            (row, col),
            Default::default(),
            &mut row_dependencies_map,
            &mut row_dependents_map,
        );
    }

    // Record subscriber overrides for all cleared cells (subscribed sheets only)
    crate::calp_commands::record_subscription_override_edits(&state, &crate::document_effect::DocumentEffect::mutates(&file_state), active_sheet, &override_edits);

    // Commit undo transaction
    if count > 0 {
        undo_stack.commit_owned(owned_txn);
        // Mark workbook as dirty
        let _ = crate::document_effect::DocumentEffect::mutates(&file_state);
    }

    // PHASE B — dependents. Seeds are the cells that actually HELD content
    // (`override_edits` is pushed only when `previous_cell.is_some()`), so an
    // empty selection costs one `is_empty` check. Cleared cells have no formula
    // of their own, so the shared cascade skips them as seeds and re-evaluates
    // only what READ them — same-sheet through the dependency maps, other
    // sheets through `cascade_cross_sheet_dependents`.
    //
    // The guards above must be released first: the recalc takes the same
    // grid/dependency mutexes and std mutexes are not reentrant. Same second-
    // lock-phase shape as `sort_range`.
    let seeds: Vec<(u32, u32)> = override_edits.iter().map(|(r, c, _, _)| (*r, *c)).collect();
    drop(undo_stack);
    drop(cross_sheet_dependencies_map);
    drop(cross_sheet_dependents_map);
    drop(row_dependencies_map);
    drop(row_dependents_map);
    drop(column_dependencies_map);
    drop(column_dependents_map);
    drop(dependencies_map);
    drop(dependents_map);
    drop(grids);
    drop(grid);

    if !seeds.is_empty() {
        let mut recalculated = Vec::new();
        recalc_after_active_sheet_bulk_rewrite(
            &state,
            &user_files_state,
            &pane_control_state,
            &ribbon_filter_state,
            &seeds,
            &mut recalculated,
        );
    }

    Ok(count)
}

// ============================================================================
// CLEAR FORMATS OVER ROW AND COLUMN FORMATS (BUG-0354 follow-up, review A#1)
// ============================================================================
//
// Since BUG-0354 a whole-line format (Bold on a clicked column header, Ctrl+A
// then Fill) is ONE row or column TIER (`Grid::row_styles` /
// `Grid::column_styles`), not a million cells. Clear Formats and Clear All
// only ever reset the style of the cells that were STORED, so the tier
// survived them: Ctrl+B on column C, then Clear Formats on C, and the column
// stayed bold -- and so did a value typed there afterwards.
//
// Excel's rule [LIVE, Excel 16, 2026-10-29: fresh unsaved workbooks,
// Range.ClearFormats / Range.Clear read back through Font.Bold / Font.Italic
// and UsedRange]: after the clear EVERY position of the rectangle shows the
// Normal style, whatever row or column format it sits under --
//   - column C bold, Clear Formats on C: no column format left (C100 plain);
//   - row 5 bold, Clear Formats on column C: C5 plain, D5 still bold;
//   - column C bold, Clear Formats on C1:C10: C1:C10 plain, C11 bold, and the
//     used range becomes C1:C10 (each position is written as a cell);
//   - column C bold, Clear Formats on row 5: C5 plain, C6 bold;
//   - row 5 bold over column C italic, Rows(5).Clear: C5 plain and empty;
//   - Select All bold, Select All Clear Formats: nothing left (used range A1).
//
// Here, in that order of rank (a cell outranks its row, a row its column):
//   - a WHOLE COLUMN's tier is removed -- the lowest rank, so removing it can
//     never expose anything;
//   - a WHOLE ROW's tier is removed too, unless a column format remains that
//     would then show through it: the row then gets an EXPLICIT Normal tier,
//     which outranks every column (Excel's own record for that case is
//     `<row customFormat="1">` with no style);
//   - every position a remaining tier would still paint gets an explicit-
//     Normal cell of its own, exactly the cells Excel writes.
// O(tiers + stored cells + those positions), never O(rows x columns) -- the
// Formats branch used to walk every position of the rectangle with a
// `Vec::contains` per position.
//
// AN ALMOST-WHOLE RECTANGLE IS CLEARED AS WHOLE LINES PLUS EXCEPTIONS (round-3
// review rev3A#2), the route the formatting planner takes
// (`styles::line_extent_of`). Click C2, Ctrl+Shift+Down, Clear Formats under a
// bold column C: C2:C1048576 is one row short of the column, and it was planned
// as a PARTIAL clear -- one explicit-Normal cell per position, a million cells,
// a million undo records and a million-row reply, the used range run to row
// 1,048,576 -- and A2:B1048576 under bold A:B was refused outright. Excel 16
// [LIVE, 2026-10-29, rev3A probe-clear-almost.ps1 and lane clearfmt probe.ps1,
// each saved and its sheet XML read back]: the column format is removed and the
// excluded position keeps its look as a cell (`<c r=C1 s=bold>`; A1:D1 for
// A2:D1048576 under bold A:D; Clear All the same, C1's value kept). Here the
// whole lines' tiers are cleared as above, and each EXCLUDED position whose
// look that would change keeps it as its own style (`ClearFormatsPlan::kept`)
// -- or, for an excluded row where every column shows one format, as a ROW
// format (`kept_row_tiers`, rev3A#7: every column bold, then B2:XFD1048576
// Clear Formats, is `<row r=1 s=bold customFormat=1/>` in Excel, no cell).
// Rows 5:10 bold, then B5:XFD10 Clear Formats, is the row axis: the row
// formats go and A5:A10 keep bold as cells, as in Excel.

/// Above this many positions to write, a clear's formats half is refused
/// rather than materialised (the shape of `BORDER_TIER_CROSSING_LIMIT` in
/// styles.rs; a Calcula-only bound -- Excel has none).
const CLEAR_FORMATS_CELL_LIMIT: u64 = 2_000_000;

/// What becomes of the row tiers of a WHOLE-ROW clear.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum ClearedRows {
    /// Not a whole-row clear: every row keeps its tier.
    #[default]
    Untouched,
    /// The rows' tiers are removed: no column format remains to show through.
    Removed,
    /// Every row of the rectangle shows an explicit Normal tier: a column
    /// format remains, and a removed row tier would expose it.
    ExplicitNormal,
}

/// Everything the FORMATS half of a clear will write on one sheet, decided
/// before anything is touched, so its one refusal
/// ([`CLEAR_FORMATS_CELL_LIMIT`]) costs nothing.
#[derive(Debug, Default)]
pub(crate) struct ClearFormatsPlan {
    /// The cleared rectangle, normalised: (min_row, min_col, max_row, max_col).
    rect: (u32, u32, u32, u32),
    /// The rectangle spans every row: its columns' tiers go.
    whole_columns: bool,
    rows: ClearedRows,
    /// Column tiers this clear removes (whole columns only).
    removed_columns: Vec<u32>,
    /// Row tiers this clear rewrites: (row, explicit Normal?) -- `false`
    /// removes the tier.
    row_tiers: Vec<(u32, bool)>,
    /// Positions holding NO cell that a remaining tier would still paint:
    /// each gets an empty cell with the explicit Normal style.
    blanks: Vec<(u32, u32)>,
    /// THE EXCEPTIONS of an almost-whole clear (round-3 review rev3A#2): the
    /// positions of the whole lines OUTSIDE the cleared rectangle whose look
    /// the removed line formats would change, with the style each shows now
    /// -- written as that position's own style (an empty cell where none is
    /// stored), so it keeps its look.
    kept: Vec<((u32, u32), usize)>,
    /// Excluded ROWS that keep their look as a row format instead (rev3A#7,
    /// `styles::excluded_row_format`): (row, the style it shows now).
    kept_row_tiers: Vec<(u32, usize)>,
}

impl ClearFormatsPlan {
    fn changes_tiers(&self) -> bool {
        !self.removed_columns.is_empty() || !self.row_tiers.is_empty() || !self.kept_row_tiers.is_empty()
    }

    /// Whether the plan writes any CELL: a blank under a remaining tier, or an
    /// excluded position that keeps its look.
    fn writes_cells(&self) -> bool {
        !self.blanks.is_empty() || !self.kept.is_empty()
    }

    /// Whether `(row, col)` -- with no style of its own -- still shows a
    /// format other than Normal once this plan's tiers have landed. Asked of
    /// every stored cell the clear restyles: such a cell needs the explicit
    /// Normal style, because index 0 means "inherit" (`Grid::effective_style_index`).
    fn painted_after(&self, grid: &Grid, styles: &StyleRegistry, row: u32, col: u32) -> bool {
        let (r0, c0, r1, c1) = self.rect;
        let in_rows = row >= r0 && row <= r1;
        match self.rows {
            ClearedRows::ExplicitNormal if in_rows => return false,
            // The row's tier is gone: the column decides.
            ClearedRows::Removed if in_rows => {}
            _ => {
                let own = grid.row_styles.get(&row).copied().unwrap_or(0);
                if own != 0 {
                    return !is_normal_style(styles, own);
                }
            }
        }
        if self.whole_columns && col >= c0 && col <= c1 {
            return false;
        }
        let tier = grid.column_styles.get(&col).copied().unwrap_or(0);
        tier != 0 && !is_normal_style(styles, tier)
    }
}

/// Whether style `index` LOOKS like Normal (index 0, or an explicit copy of it).
fn is_normal_style(styles: &StyleRegistry, index: usize) -> bool {
    index == 0 || styles.get(index) == styles.default_style()
}

/// Plan the FORMATS half of Clear Formats / Clear All over `rect`
/// (normalised) on `grid`: see the section comment above for the rules.
pub(crate) fn plan_clear_formats(
    grid: &Grid,
    styles: &StyleRegistry,
    rect: (u32, u32, u32, u32),
) -> Result<ClearFormatsPlan, String> {
    let (r0, c0, r1, c1) = rect;
    // The WHOLE lines this clear goes through: `rect` itself for whole rows,
    // whole columns or Select All; the whole columns (or rows) an ALMOST-whole
    // `rect` nearly fills (rev3A#2) -- their tiers are cleared, and the
    // positions outside `rect` are planned as exceptions at the end. `rect`
    // still bounds every position this clear makes Normal.
    let line = crate::commands::styles::line_extent_of(rect);
    let (lr0, lc0, lr1, lc1) = line.unwrap_or(rect);
    let whole_columns = lr0 == 0 && lr1 >= engine::EXCEL_MAX_ROW_INDEX;
    let whole_rows = lc0 == 0 && lc1 >= engine::EXCEL_MAX_COL_INDEX;
    let mut plan = ClearFormatsPlan { rect, whole_columns, ..Default::default() };

    if whole_columns {
        plan.removed_columns = grid
            .column_styles
            .iter()
            .filter(|(c, idx)| **idx != 0 && **c >= c0 && **c <= c1)
            .map(|(c, _)| *c)
            .collect();
        plan.removed_columns.sort_unstable();
    }

    if whole_rows {
        // A column format OUTSIDE what this clear removes would show through a
        // removed row tier.
        let column_shows = grid.column_styles.iter().any(|(c, idx)| {
            !(whole_columns && *c >= c0 && *c <= c1) && !is_normal_style(styles, *idx)
        });
        if column_shows {
            plan.rows = ClearedRows::ExplicitNormal;
            for row in r0..=r1 {
                let own = grid.row_styles.get(&row).copied().unwrap_or(0);
                if own == 0 || !is_normal_style(styles, own) {
                    plan.row_tiers.push((row, true));
                }
            }
        } else {
            plan.rows = ClearedRows::Removed;
            plan.row_tiers = grid
                .row_styles
                .iter()
                .filter(|(r, idx)| **idx != 0 && **r >= r0 && **r <= r1)
                .map(|(r, _)| (*r, false))
                .collect();
            plan.row_tiers.sort_unstable();
        }
        // Every row of the rectangle now shows Normal through its own tier (or
        // through nothing): no position needs a cell of its own -- only an
        // almost-whole clear's excluded columns keep their look.
        plan_clear_exceptions(grid, styles, &mut plan, line);
        return Ok(plan);
    }

    // Positions with no cell that a REMAINING tier still paints: the rows
    // with a non-Normal format across the rectangle's columns, and the columns
    // with one down the rectangle's rows that have no row format (a row format
    // of any kind hides the column's).
    let mut painted_rows: Vec<u32> = grid
        .row_styles
        .iter()
        .filter(|(r, idx)| **r >= r0 && **r <= r1 && !is_normal_style(styles, **idx))
        .map(|(r, _)| *r)
        .collect();
    painted_rows.sort_unstable();
    let mut painted_cols: Vec<u32> = if whole_columns {
        Vec::new()
    } else {
        grid.column_styles
            .iter()
            .filter(|(c, idx)| **c >= c0 && **c <= c1 && !is_normal_style(styles, **idx))
            .map(|(c, _)| *c)
            .collect()
    };
    painted_cols.sort_unstable();
    let width = u64::from(c1 - c0) + 1;
    let height = u64::from(r1 - r0) + 1;
    let rows_with_a_tier = grid
        .row_styles
        .iter()
        .filter(|(r, idx)| **idx != 0 && **r >= r0 && **r <= r1)
        .count() as u64;
    let positions = painted_rows.len() as u64 * width
        + painted_cols.len() as u64 * height.saturating_sub(rows_with_a_tier);
    if positions > CLEAR_FORMATS_CELL_LIMIT {
        return Err(format!(
            "Clearing the formats here would have to write {} separate cells where \
             whole-row or whole-column formats cross the selection; select a smaller range.",
            positions
        ));
    }
    for &row in &painted_rows {
        for col in c0..=c1 {
            if !grid.cells.contains_key(&(row, col)) {
                plan.blanks.push((row, col));
            }
        }
    }
    if !painted_cols.is_empty() {
        for row in r0..=r1 {
            if grid.row_styles.get(&row).copied().unwrap_or(0) != 0 {
                continue;
            }
            for &col in &painted_cols {
                if !grid.cells.contains_key(&(row, col)) {
                    plan.blanks.push((row, col));
                }
            }
        }
    }
    plan_clear_exceptions(grid, styles, &mut plan, line);
    Ok(plan)
}

/// THE EXCEPTIONS of an almost-whole clear (rev3A#2, rev3A#7): every position
/// of `line` (the whole lines `styles::line_extent_of` gave) outside the
/// plan's rectangle whose look the cleared line formats would change keeps
/// that look. Nothing for an ordinary clear (`line` is `None` or the
/// rectangle itself). Bounded by the formatting planner's
/// `ALMOST_WHOLE_EXCEPTION_LIMIT`: `line_extent_of` answers only when the
/// excluded positions are at most that many. Asked of the plan's own tier
/// decisions, so it runs after them.
fn plan_clear_exceptions(
    grid: &Grid,
    styles: &StyleRegistry,
    plan: &mut ClearFormatsPlan,
    line: Option<(u32, u32, u32, u32)>,
) {
    let Some(line) = line.filter(|l| *l != plan.rect) else { return };
    let (r0, c0, r1, c1) = plan.rect;
    let (lr0, lc0, lr1, lc1) = line;
    // The style `(row, col)` shows now when the clear would change it: its own
    // style outranks every tier, and a position the plan's remaining tiers
    // still paint shows that tier unchanged (an excluded row's own format).
    let keeps = |plan: &ClearFormatsPlan, row: u32, col: u32| -> Option<usize> {
        if grid.get_cell(row, col).is_some_and(|c| c.style_index != 0) {
            return None;
        }
        let before = grid.effective_style_index(row, col);
        if is_normal_style(styles, before) || plan.painted_after(grid, styles, row, col) {
            return None;
        }
        Some(before)
    };
    if plan.whole_columns {
        // An excluded row with a format of its own outranks the column
        // formats this clear removes: it shows that format, before and after.
        let untiered: Vec<u32> = (lr0..r0)
            .chain(r1.saturating_add(1)..=lr1)
            .filter(|row| grid.row_styles.get(row).copied().unwrap_or(0) == 0)
            .collect();
        if untiered.is_empty() {
            return;
        }
        // Every column shows ONE non-Normal format on these rows: each keeps it
        // as a row format, the crossings it would hide as cells (rev3A#7).
        let row_format = crate::commands::styles::excluded_row_format(grid, styles, c0, c1)
            .filter(|format| !is_normal_style(styles, format.look));
        if let Some(format) = row_format {
            for &row in &untiered {
                plan.kept_row_tiers.push((row, format.look));
                for &(col, tier) in &format.crossings {
                    if !grid.get_cell(row, col).is_some_and(|c| c.style_index != 0) {
                        plan.kept.push(((row, col), tier));
                    }
                }
            }
            return;
        }
        for &row in &untiered {
            for col in c0..=c1 {
                if let Some(index) = keeps(plan, row, col) {
                    plan.kept.push(((row, col), index));
                }
            }
        }
    } else {
        // Almost-whole ROWS: the excluded columns of the cleared rows.
        let excluded_cols: Vec<u32> = (lc0..c0).chain(c1.saturating_add(1)..=lc1).collect();
        for row in r0..=r1 {
            for &col in &excluded_cols {
                if let Some(index) = keeps(plan, row, col) {
                    plan.kept.push(((row, col), index));
                }
            }
        }
    }
}

/// The explicit Normal style, interned on first use. Index 0 means INHERIT on
/// a cell or a tier, so a position that must SHOW Normal over a remaining
/// tier needs a non-zero index whose style is Normal
/// (`StyleRegistry::get_or_create_explicit`, memoised in the registry).
#[derive(Default)]
struct ExplicitNormal(Option<usize>);

impl ExplicitNormal {
    fn index(&mut self, styles: &mut StyleRegistry) -> usize {
        *self.0.get_or_insert_with(|| {
            let normal = styles.default_style().clone();
            styles.get_or_create_explicit(normal)
        })
    }
}

/// An empty cell carrying `style_index` (a cleared position under a tier).
fn blank_cell_with_style(style_index: usize) -> engine::Cell {
    let mut cell = engine::Cell::new();
    cell.style_index = style_index;
    cell
}

/// Write a plan's TIER half to one sheet -- and to `mirror`, the second copy
/// of the ACTIVE sheet (`grids[active]` beside `state.grid`) -- returning each
/// axis's undo snapshot `(is_column, previous)` for the caller to record as an
/// `obj_style_tiers` restore in its open step (the record `write_range_style_plan`
/// makes for the formatting commands).
fn write_cleared_tiers(
    grid: &mut Grid,
    mut mirror: Option<&mut Grid>,
    plan: &ClearFormatsPlan,
    styles: &mut StyleRegistry,
    explicit: &mut ExplicitNormal,
) -> Vec<(bool, Vec<(u32, usize)>)> {
    let mut snapshots = Vec::new();
    if !plan.removed_columns.is_empty() {
        let previous: Vec<(u32, usize)> = plan
            .removed_columns
            .iter()
            .map(|c| (*c, grid.column_styles.get(c).copied().unwrap_or(0)))
            .collect();
        for &col in &plan.removed_columns {
            grid.set_column_style(col, 0);
            if let Some(m) = mirror.as_deref_mut() {
                m.set_column_style(col, 0);
            }
        }
        snapshots.push((true, previous));
    }
    if !plan.row_tiers.is_empty() || !plan.kept_row_tiers.is_empty() {
        // ONE row snapshot for both kinds (an almost-whole clear's excluded
        // rows keeping their look, rev3A#7, beside the cleared rows' tiers).
        let previous: Vec<(u32, usize)> = plan
            .row_tiers
            .iter()
            .map(|(r, _)| *r)
            .chain(plan.kept_row_tiers.iter().map(|(r, _)| *r))
            .map(|r| (r, grid.row_styles.get(&r).copied().unwrap_or(0)))
            .collect();
        for &(row, explicit_normal) in &plan.row_tiers {
            let index = if explicit_normal { explicit.index(styles) } else { 0 };
            grid.set_row_style(row, index);
            if let Some(m) = mirror.as_deref_mut() {
                m.set_row_style(row, index);
            }
        }
        for &(row, index) in &plan.kept_row_tiers {
            grid.set_row_style(row, index);
            if let Some(m) = mirror.as_deref_mut() {
                m.set_row_style(row, index);
            }
        }
        snapshots.push((false, previous));
    }
    snapshots
}

/// The cell an almost-whole clear's KEPT position (rev3A#2) becomes: the
/// stored cell -- or an empty one -- carrying `index`, the style it showed
/// before, as its own. `None` when the position holds a style of its own by
/// now: that already outranks every tier (an earlier, overlapping area of the
/// same grouped clear may have written it), so it is left alone.
fn kept_cell(previous: Option<&engine::Cell>, index: usize) -> Option<engine::Cell> {
    if previous.is_some_and(|c| c.style_index != 0) {
        return None;
    }
    let mut cell = previous.cloned().unwrap_or_else(engine::Cell::new);
    cell.style_index = index;
    Some(cell)
}

/// What a clear changed on ONE sheet that is not the active one, for the
/// caller's one undo step, its subscriber overrides and its recalculation.
#[derive(Default)]
struct BackgroundClear {
    /// (row, col, previous cell) for the `script_grid_cells` restore -- the
    /// FIRST previous of each position only, since several areas may overlap.
    previous: Vec<(u32, u32, Option<engine::Cell>)>,
    recorded: crate::CoordSet,
    /// (row, col, pre, post) for `record_subscription_override_edits`.
    override_edits: Vec<(u32, u32, Option<engine::Cell>, Option<engine::Cell>)>,
    /// Tier snapshots `(is_column, previous)`, in write order.
    tiers: Vec<(bool, Vec<(u32, usize)>)>,
    /// Cells and tier entries changed (the command's `count`).
    count: u32,
    /// Whether CONTENT left the sheet (a released spill included): the
    /// recalculation question.
    content_changed: bool,
}

impl BackgroundClear {
    fn remember(&mut self, row: u32, col: u32, previous: Option<engine::Cell>) {
        if self.recorded.insert((row, col)) {
            self.previous.push((row, col, previous));
        }
    }

    fn changed_anything(&self) -> bool {
        !self.previous.is_empty() || !self.tiers.is_empty()
    }

    /// Record this sheet's changes in the caller's OPEN step: one exact cell
    /// restore (`script_grid_cells`, sheet-tagged, so undo never switches the
    /// user to this sheet: a CustomRestore names no target sheet) and one
    /// tier restore per axis.
    fn record_into(&mut self, undo_stack: &mut engine::UndoStack, sheet: usize, label: &str) {
        if !self.previous.is_empty() {
            undo_stack.record_custom_restore(
                "script_grid_cells".to_string(),
                crate::undo_commands::script_grid_cells_snapshot_bytes(
                    sheet,
                    std::mem::take(&mut self.previous),
                ),
                label,
            );
        }
        for (is_column, previous) in std::mem::take(&mut self.tiers) {
            undo_stack.record_custom_restore(
                "obj_style_tiers".to_string(),
                crate::undo_commands::style_tiers_snapshot_bytes(sheet, is_column, previous),
                label,
            );
        }
    }
}

/// Clear ONE rectangle of `grid`, a sheet that is NOT the active one, already
/// gated, under the caller's held `grids` and style guards: the shared body of
/// `clear_range_with_options_off_sheet_at` (a script's or the command line's
/// addressed clear, a floating grid's backing sheet) and `clear_range_on_sheets_inner`
/// (the sheet group). `released_spill` is the caller's SPILL TEAR-DOWN for a
/// content clear (§2y): the cells of every spill whose origin the rectangle
/// swallows, already released from the maps by `take_spills_owned_within` in
/// the same critical section (the off-sheet recalc is not spill-aware); they
/// are erased here and never recorded for undo (see `spilled_cells_owned_within`).
/// `plan` is the formats half for All / ResetContents / Formats. Nothing is
/// recorded here: `out` collects it, and BOTH callers recalculate through
/// `recalc_after_off_sheet_write` once their guards are dropped.
#[allow(clippy::too_many_arguments)]
fn clear_rect_on_background_sheet(
    grid: &mut Grid,
    styles: &mut StyleRegistry,
    explicit: &mut ExplicitNormal,
    rect: (u32, u32, u32, u32),
    apply_to: ClearApplyTo,
    released_spill: &[(u32, u32)],
    plan: Option<&ClearFormatsPlan>,
    out: &mut BackgroundClear,
) {
    let (min_row, min_col, max_row, max_col) = rect;
    let effective_end_row = max_row.min(grid.max_row);
    let effective_end_col = max_col.min(grid.max_col);

    let released_set: crate::CoordSet = released_spill.iter().copied().collect();
    for &(r, c) in released_spill {
        grid.cells.remove(&(r, c));
    }
    if !released_spill.is_empty() {
        out.content_changed = true;
    }

    if let Some(plan) = plan {
        let snapshots = write_cleared_tiers(grid, None, plan, styles, explicit);
        out.count += snapshots.iter().map(|(_, entries)| entries.len() as u32).sum::<u32>();
        out.tiers.extend(snapshots);
    }

    let mut stored: Vec<(u32, u32)> = grid
        .cells
        .keys()
        .filter(|(r, c)| *r >= min_row && *r <= effective_end_row && *c >= min_col && *c <= effective_end_col)
        .filter(|coord| !released_set.contains(coord))
        .cloned()
        .collect();
    stored.sort_unstable();

    for (row, col) in stored {
        let Some(cell) = grid.get_cell(row, col).cloned() else { continue };
        match apply_to {
            ClearApplyTo::All | ClearApplyTo::ResetContents => {
                let painted = plan.is_some_and(|p| p.painted_after(grid, styles, row, col));
                out.override_edits.push((row, col, Some(cell.clone()), None));
                out.remember(row, col, Some(cell));
                grid.clear_cell(row, col);
                if painted {
                    let index = explicit.index(styles);
                    grid.set_cell(row, col, blank_cell_with_style(index));
                }
                out.count += 1;
                out.content_changed = true;
            }
            ClearApplyTo::Contents => {
                let new_cell = blank_cell_with_style(cell.style_index);
                out.override_edits.push((row, col, Some(cell.clone()), Some(new_cell.clone())));
                out.remember(row, col, Some(cell));
                grid.set_cell(row, col, new_cell);
                out.count += 1;
                out.content_changed = true;
            }
            ClearApplyTo::Formats => {
                let target = if plan.is_some_and(|p| p.painted_after(grid, styles, row, col)) {
                    explicit.index(styles)
                } else {
                    0
                };
                if cell.style_index == target {
                    continue;
                }
                let mut new_cell = cell.clone();
                new_cell.style_index = target;
                out.remember(row, col, Some(cell));
                grid.set_cell(row, col, new_cell);
                out.count += 1;
            }
            // Refused by every caller before anything is locked.
            ClearApplyTo::Hyperlinks | ClearApplyTo::RemoveHyperlinks => {}
        }
    }

    if let Some(plan) = plan {
        for &(row, col) in &plan.blanks {
            // A position that holds a cell now was restyled above (or by an
            // earlier, overlapping area of the same clear).
            if grid.cells.contains_key(&(row, col)) {
                continue;
            }
            out.remember(row, col, None);
            let index = explicit.index(styles);
            grid.set_cell(row, col, blank_cell_with_style(index));
            out.count += 1;
        }
        // An almost-whole clear's excluded positions keep their look (rev3A#2).
        for &((row, col), index) in &plan.kept {
            let previous = grid.get_cell(row, col).cloned();
            let Some(cell) = kept_cell(previous.as_ref(), index) else { continue };
            out.remember(row, col, previous);
            grid.set_cell(row, col, cell);
            out.count += 1;
        }
    }
}

/// Whether `apply_to` clears FORMATS (and so plans the tiers).
fn clear_kind_clears_formats(apply_to: ClearApplyTo) -> bool {
    matches!(apply_to, ClearApplyTo::All | ClearApplyTo::ResetContents | ClearApplyTo::Formats)
}

/// Clear-with-options on a NON-ACTIVE sheet (Wave 3 cross-sheet ops): the
/// same guard chain as the active path — sheet protection, spill hosts,
/// object-region protection and the writeback claim guard for content clears
/// — re-anchored to the TARGET sheet, mutating `grids[target]`. Undo is one
/// sheet-tagged "script_grid_cells" CustomRestore (exact cell restore, no
/// recalc needed for the restored cells); subscriber overrides are recorded
/// for the target sheet; dependents recalculate via
/// `recalc_after_off_sheet_write`.
pub(crate) fn clear_range_with_options_off_sheet(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    target: usize,
    params: ClearRangeParams,
) -> Result<ClearRangeResult, String> {
    clear_range_with_options_off_sheet_at(
        state,
        file_state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        target,
        params,
        None,
    )
}

/// [`clear_range_with_options_off_sheet`] that, for an OBJECT's cells (P3),
/// re-checks under the held `grids` guard that `target` is still the
/// object's backing sheet (`cell_target::ensure_target_still_at`).
#[allow(clippy::too_many_arguments)]
fn clear_range_with_options_off_sheet_at(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    target: usize,
    params: ClearRangeParams,
    expect: Option<&crate::cell_target::ResolvedCellTarget>,
) -> Result<ClearRangeResult, String> {
    let min_row = params.start_row.min(params.end_row);
    let max_row = params.start_row.max(params.end_row);
    let min_col = params.start_col.min(params.end_col);
    let max_col = params.start_col.max(params.end_col);
    let apply_to = params.apply_to;

    // The hyperlink store is read and cleared on the ACTIVE sheet (the
    // hyperlinks module has no sheet-addressed clear), so these two are refused
    // here rather than half-done. Nothing sends them: the script validator and
    // the command line accept only all / contents / formats.
    if matches!(apply_to, ClearApplyTo::Hyperlinks | ClearApplyTo::RemoveHyperlinks) {
        return Err("Clear Hyperlinks and Remove Hyperlinks work on the active sheet only.".to_string());
    }

    // Sheet protection applies to FORMAT clears too (see the active twin).
    crate::protection::check_sheet_protection_range(
        state, target, min_row, min_col, max_row, max_col,
    )?;

    if !matches!(apply_to, ClearApplyTo::Formats) {
        {
            let spill_hosts = state.spill_hosts.lock().unwrap();
            check_spill_protection(
                &spill_hosts, target, min_row, min_col, max_row, max_col,
                SpillOriginPolicy::ReleasedByCaller,
            )?;
        }
        check_region_range_protection(state, target, min_row, min_col, max_row, max_col)?;
        crate::calp_commands::ensure_range_unclaimed_on_sheets(
            state, "clear this range", &[target], min_row, min_col, max_row, max_col,
        )?;
    }

    let rect = (min_row, min_col, max_row, max_col);
    let mut out = BackgroundClear::default();
    // Read BEFORE any guard below is taken (never nested under them): the
    // reply's display text for the cells this clear changed.
    let locale = state.locale.lock().unwrap().clone();
    let (effect, updated_cells) = {
        // Bounds check under a read-only view; the effect is built only once it
        // has passed, so a bad sheet index cannot leave the document dirty. One
        // lock throughout -- see Persisted::lock_pending. Canonical order:
        // grids, then the style registry.
        let grids = state.grids.lock_pending().unwrap();
        if target >= grids.len() {
            return Err(format!("Sheet index {} out of range", target));
        }
        if let Some(t) = expect {
            crate::cell_target::ensure_target_still_at(state, t)?;
        }
        let styles = state.style_registry.lock_pending().unwrap();
        // The formats half is PLANNED before the effect: its one refusal (too
        // many positions to write) must leave the document clean.
        let plan = if clear_kind_clears_formats(apply_to) {
            Some(plan_clear_formats(&grids[target], &styles, rect)?)
        } else {
            None
        };
        let effect = crate::document_effect::DocumentEffect::mutates(file_state);
        let mut grids = grids.authorize(&effect);
        let mut styles = styles.authorize(&effect);
        let mut undo_stack = state.undo_stack.lock().unwrap();
        let mut explicit = ExplicitNormal::default();

        // SPILL TEAR-DOWN, off-sheet half (§2y). The active twin gets this from
        // `recalc_after_active_sheet_bulk_rewrite`; this path recalculates
        // through `recalc_after_off_sheet_write`, which is whole-sheet and NOT
        // spill-aware, so the release happens here, in the same critical
        // section as the clear.
        let released_spill = if matches!(apply_to, ClearApplyTo::Formats) {
            Vec::new()
        } else {
            take_spills_owned_within(state, target, min_row, min_col, max_row, max_col)
        };
        // The rectangle's contents, formats and the row / column formats it
        // covers (`clear_rect_on_background_sheet`).
        clear_rect_on_background_sheet(
            &mut grids[target],
            &mut styles,
            &mut explicit,
            rect,
            apply_to,
            &released_spill,
            plan.as_ref(),
            &mut out,
        );

        if out.changed_anything() {
            let desc = match apply_to {
                ClearApplyTo::All => "Clear all",
                ClearApplyTo::Contents => "Clear contents",
                ClearApplyTo::Formats => "Clear formats",
                ClearApplyTo::Hyperlinks => "Clear hyperlinks",
                ClearApplyTo::RemoveHyperlinks => "Remove hyperlinks",
                ClearApplyTo::ResetContents => "Reset contents",
            };
            let owned_txn = undo_stack.begin_owned_transaction(format!(
                "{} on sheet {} ({},{}) to ({},{})",
                desc, target + 1, min_row, min_col, max_row, max_col
            ));
            out.record_into(&mut undo_stack, target, desc);
            undo_stack.commit_owned(owned_txn);
        }
        drop(undo_stack);

        // THE CELLS IT CHANGED, as they stand now (BUG-0616 #2). The reply was
        // always empty off the active sheet, so a caller could not say which
        // cells a clear changed there: a script's off-sheet clear went
        // unattributed, and an approved macro's run (owner decision B), which
        // records every cell it changed on the persistent trail, could not
        // record these. Row / column format changes are not cells and are not
        // listed; the positions the clear wrote are (`out.recorded`).
        let grid = &grids[target];
        let mut positions: Vec<(u32, u32)> = out.recorded.iter().copied().collect();
        positions.sort_unstable();
        let updated_cells: Vec<CellData> = positions
            .into_iter()
            .map(|(row, col)| {
                let style_index = grid.effective_style_index(row, col);
                match grid.get_cell(row, col) {
                    Some(cell) => {
                        let shown = crate::format_cell_value_with_color(&cell.value, styles.get(style_index), &locale);
                        CellData {
                            row,
                            col,
                            display: shown.text,
                            overflow: shown.overflow,
                            display_color: shown.color,
                            formula: formula_display(cell, &locale),
                            style_index,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: Some(target),
                            rich_text: None,
                            accounting_layout: None,
                        }
                    }
                    None => CellData {
                        row,
                        col,
                        display: String::new(),
                        overflow: crate::api_types::OverflowClass::Text,
                        display_color: None,
                        formula: None,
                        style_index,
                        row_span: 1,
                        col_span: 1,
                        sheet_index: Some(target),
                        rich_text: None,
                        accounting_layout: None,
                    },
                }
            })
            .collect();

        (effect, updated_cells)
    };

    // Subscriber overrides for the TARGET sheet (no-op when not subscribed).
    crate::calp_commands::record_subscription_override_edits(state, &effect, target, &out.override_edits);

    // Dependents (anywhere) of the cleared cells recalculate now.
    if out.content_changed {
        crate::commands::data::recalc_after_off_sheet_write(
            state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &[target],
        );
    }

    Ok(ClearRangeResult {
        count: out.count,
        updated_cells,
    })
}

/// Clear-with-options on an OBJECT's cells (P3, owner finding G3: the Clear
/// menu and Delete on a floating grid). Every gate runs holding nothing and
/// before any effect: target-with-sheet refusal, the write extent, and the
/// HOST's protection over the backing cells' lock flags. Then the off-sheet
/// twin clears the BACKING sheet as ONE sheet-tagged undo step (an N-cell
/// Delete is one Ctrl+Z) and recalculates dependents anywhere -- a host
/// formula reading the grid included.
///
/// Clear Hyperlinks / Remove Hyperlinks: a floating grid's cells cannot hold a
/// link (Insert Hyperlink refuses them), so with no link in the range there
/// is nothing to clear and the answer is an honest 0; should one ever exist,
/// the gesture is refused rather than half-done (the hyperlink store's clear
/// is active-sheet-only).
pub(crate) fn clear_range_on_target(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    params: ClearRangeParams,
) -> Result<ClearRangeResult, String> {
    crate::cell_target::refuse_target_with_sheet(&params.target, params.sheet_index.is_some())?;
    let Some(target_ref) = params.target.clone() else {
        return Err("clear_range_on_target needs a target".to_string());
    };
    let t = crate::cell_target::resolve_cell_target(state, &target_ref)?;
    let (r0, c0) = (params.start_row.min(params.end_row), params.start_col.min(params.end_col));
    let (r1, c1) = (params.start_row.max(params.end_row), params.start_col.max(params.end_col));
    crate::cell_target::ensure_in_extent(&t, r0, c0, r1, c1)?;
    if matches!(params.apply_to, ClearApplyTo::Hyperlinks | ClearApplyTo::RemoveHyperlinks) {
        let linked = state
            .hyperlinks
            .read()
            .map_err(|e| e.to_string())?
            .get(&t.backing_index)
            .map(|links| links.keys().any(|&(r, c)| r >= r0 && r <= r1 && c >= c0 && c <= c1))
            .unwrap_or(false);
        if linked {
            return Err(
                "Clear Hyperlinks is not available inside a floating grid yet. Nothing was changed."
                    .to_string(),
            );
        }
        return Ok(ClearRangeResult { count: 0, updated_cells: Vec::new() });
    }
    crate::cell_target::gate_target_cells(
        state,
        &t,
        (r0, c0, r1, c1),
        crate::cell_target::EDIT_CELLS,
        "clear these cells",
    )?;
    let backing = t.backing_index;
    clear_range_with_options_off_sheet_at(
        state,
        file_state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        backing,
        ClearRangeParams { sheet_index: None, target: None, ..params },
        Some(&t),
    )
}

/// `applyTo` "hyperlinks" and "removeHyperlinks" on the ACTIVE sheet, Excel's
/// two hyperlink clears (measured live, core-grid lane, 2026-10-04):
///
/// - Clear Hyperlinks removes every link in the range and KEEPS every format.
/// - Remove Hyperlinks, on each cell that HOLDS a link, removes the link AND
///   the cell's own format (bold, fill, number format, alignment, borders: back
///   to Normal -- here, style index 0, which inherits the row/column tier as
///   Clear Formats does). A cell without a link keeps its format; values stay.
///
/// ONE undo step either way (the hyperlink range clear records its removals
/// inside the transaction this opens). A range holding no link changes
/// nothing, records nothing and leaves the document clean -- Excel greys both
/// items then. The Home tab's Remove Hyperlinks runs the same two halves from
/// TypeScript (`core/lib/clearGestures`, which reads the linked cells first);
/// this is the command's own answer for any caller that asks for it by name.
fn clear_hyperlinks_apply_to(
    state: &AppState,
    file_state: &FileState,
    active_sheet: usize,
    params: &ClearRangeParams,
) -> Result<ClearRangeResult, String> {
    let min_row = params.start_row.min(params.end_row);
    let max_row = params.start_row.max(params.end_row);
    let min_col = params.start_col.min(params.end_col);
    let max_col = params.start_col.max(params.end_col);
    let remove_formats = params.apply_to == ClearApplyTo::RemoveHyperlinks;

    let mut linked: Vec<(u32, u32)> = state
        .hyperlinks
        .read()
        .map_err(|e| e.to_string())?
        .get(&active_sheet)
        .map(|links| {
            links
                .keys()
                .filter(|(r, c)| *r >= min_row && *r <= max_row && *c >= min_col && *c <= max_col)
                .copied()
                .collect()
        })
        .unwrap_or_default();
    if linked.is_empty() {
        return Ok(ClearRangeResult { count: 0, updated_cells: Vec::new() });
    }
    linked.sort_unstable();

    if !remove_formats {
        let count = crate::hyperlinks::clear_hyperlinks_in_range_impl(state, file_state, min_row, min_col, max_row, max_col);
        return Ok(ClearRangeResult { count, updated_cells: Vec::new() });
    }

    // Remove Hyperlinks: the formats of the linked cells, then the links, as
    // ONE step. The begin is OWNED: inside a script's batch it joins and the
    // commit below closes nothing that is not its own.
    let owned = {
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        undo_stack.begin_owned_transaction("Remove Hyperlinks".to_string())
    };
    let mut updated_cells: Vec<CellData> = Vec::new();
    {
        let grid = state.grid.lock_pending().map_err(|e| e.to_string())?;
        let restyle: Vec<(u32, u32, engine::Cell)> = linked
            .iter()
            .filter_map(|&(r, c)| grid.get_cell(r, c).filter(|cell| cell.style_index != 0).map(|cell| (r, c, cell.clone())))
            .collect();
        if !restyle.is_empty() {
            // Every gate passed (sheet protection, before this function) and
            // something changes: committed.
            let effect = crate::document_effect::DocumentEffect::mutates(file_state);
            let mut grid = grid.authorize(&effect);
            let mut grids = state.grids.write(&effect).map_err(|e| e.to_string())?;
            let style_registry = state.style_registry.read().map_err(|e| e.to_string())?;
            let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
            let merged_regions = state.merged_regions.read().map_err(|e| e.to_string())?;
            let locale = state.locale.lock().map_err(|e| e.to_string())?;
            for (row, col, cell) in restyle {
                undo_stack.record_cell_change(active_sheet, row, col, Some(cell.clone()));
                // Index 0 = INHERIT; see the note in the Formats branch below.
                let mut new_cell = cell.clone();
                new_cell.style_index = 0;
                grid.set_cell(row, col, new_cell.clone());
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(row, col, new_cell);
                }
                let default_style = style_registry.get(grid.effective_style_index(row, col));
                let (display, overflow) = crate::format_cell_value_and_class(&cell.value, default_style, &locale);
                let (row_span, col_span) = merged_regions
                    .iter()
                    .find(|m| m.start_row == row && m.start_col == col)
                    .map(|m| (m.end_row - m.start_row + 1, m.end_col - m.start_col + 1))
                    .unwrap_or((1, 1));
                updated_cells.push(CellData {
                    row,
                    col,
                    display,
                    overflow,
                    display_color: None,
                    formula: formula_display(&cell, &locale),
                    style_index: 0,
                    row_span,
                    col_span,
                    sheet_index: None,
                    rich_text: None,
                    accounting_layout: None,
                });
            }
        }
    }
    // The links themselves (records its own removals into the open step and
    // marks the document modified).
    crate::hyperlinks::clear_hyperlinks_in_range_impl(state, file_state, min_row, min_col, max_row, max_col);
    {
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        undo_stack.commit_owned(owned);
    }
    Ok(ClearRangeResult { count: linked.len() as u32, updated_cells })
}

/// Clear a range of cells with options for what to clear.
/// Supports Excel-compatible ClearApplyTo options:
/// - All: Clear both content and formatting (default)
/// - Contents: Clear values only, keep formatting
/// - Formats: Clear formatting only, keep values
/// - Hyperlinks: Clear the links, keep formatting (`clear_hyperlinks_apply_to`)
/// - RemoveHyperlinks: Remove the links AND the linked cells' formatting, keep
///   content (`clear_hyperlinks_apply_to`)
/// - ResetContents: Reset to default state
///
/// The body is `clear_range_with_options_inner` (testability split: it takes
/// plain references, so the tests drive the real command in-process).
#[tauri::command]
pub fn clear_range_with_options(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<'_, UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: ClearRangeParams,
) -> Result<ClearRangeResult, String> {
    clear_range_with_options_inner(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        params,
    )
}

/// The body of `clear_range_with_options`.
///
/// Clear Formats, Clear All and Reset Contents also clear the ROW and COLUMN
/// formats the rectangle covers (`plan_clear_formats`; review A#1): every
/// position of the rectangle shows Normal afterwards, as in Excel. A
/// rectangle that ALMOST covers whole lines (C2:C1048576) clears those lines'
/// formats too, and the few positions it leaves out keep their look
/// (rev3A#2).
pub fn clear_range_with_options_inner(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    params: ClearRangeParams,
) -> Result<ClearRangeResult, String> {
    // P3: an OBJECT's cells (a floating grid) -- its backing sheet only.
    if params.target.is_some() {
        return clear_range_on_target(
            state,
            file_state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            params,
        );
    }
    let active_sheet = *state.active_sheet.read().unwrap();

    // Wave 3: an explicit non-active target takes the off-sheet path.
    if let Some(target) = params.sheet_index {
        if target != active_sheet {
            let count = state.sheet_names.read().unwrap().len();
            if target >= count {
                return Err(format!(
                    "Sheet index {} out of range: workbook has {} sheet(s)",
                    target, count
                ));
            }
            return clear_range_with_options_off_sheet(
                &state,
                &file_state,
                &user_files_state,
                &pivot_state,
                &pane_control_state,
                &ribbon_filter_state,
                target,
                params,
            );
        }
    }

    // Sheet protection applies to FORMAT clears too, unlike the region check
    // below — hence it sits outside that `if`. Excel defaults allowFormatCells
    // to false, so restyling a locked cell on a protected sheet is refused
    // exactly like changing its value.
    crate::protection::check_sheet_protection_range(
        &state,
        active_sheet,
        params.start_row.min(params.end_row),
        params.start_col.min(params.end_col),
        params.start_row.max(params.end_row),
        params.start_col.max(params.end_col),
    )?;

    // Clear Hyperlinks / Remove Hyperlinks touch links and (Remove) the linked
    // cells' formats -- no content, nothing a formula reads -- so they skip the
    // content gates below, exactly as a Formats clear does, and run on their
    // own path. (They were a PLACEHOLDER here until 2026-10-04: "hyperlinks"
    // changed nothing yet dirtied the document and opened an undo step, and
    // "removeHyperlinks" reset the style of EVERY cell in the range and removed
    // no link.)
    if matches!(params.apply_to, ClearApplyTo::Hyperlinks | ClearApplyTo::RemoveHyperlinks) {
        return clear_hyperlinks_apply_to(&state, &file_state, active_sheet, &params);
    }

    // Check if any cell in the range is a spill host (not the origin) — block content-clearing operations
    if !matches!(params.apply_to, ClearApplyTo::Formats) {
        let spill_hosts = state.spill_hosts.lock().unwrap();
        let min_row = params.start_row.min(params.end_row);
        let max_row = params.start_row.max(params.end_row);
        let min_col = params.start_col.min(params.end_col);
        let max_col = params.start_col.max(params.end_col);
        check_spill_protection(
            &spill_hosts, active_sheet, min_row, min_col, max_row, max_col,
            SpillOriginPolicy::ReleasedByCaller,
        )?;
        // Object-output protection: content clears cannot touch a pivot/report
        // region (format-only clears stay allowed, matching Excel).
        check_region_range_protection(&state, active_sheet, min_row, min_col, max_row, max_col)?;
        // WRITEBACK CLAIM GUARD, scoped to the same `if` for the same reason:
        // a FORMAT-only clear cannot destroy a value. Writeback drafts carry
        // typed values, not styles, so restyling a claimed cell changes nothing
        // the respondent is answerable for — that is the deliberate answer to
        // "should range formatting be guarded too?": only when it can destroy
        // content, which is exactly the non-Formats branch.
        crate::calp_commands::ensure_range_unclaimed(
            &state, "clear this range", min_row, min_col, max_row, max_col,
        )?;
    }

    let ClearRangeParams {
        start_row,
        start_col,
        end_row,
        end_col,
        apply_to,
        sheet_index: _,
        target: _,
    } = params;

    // Normalize coordinates
    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    // The grid, its mirror and the style registry are taken PENDING (canonical
    // order: grid, grids, then the rest) so the formats half can be PLANNED
    // before the effect: its one refusal (too many positions to write where
    // row / column formats cross the rectangle) must leave the document clean.
    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let style_registry = state.style_registry.lock_pending().unwrap();
    let plan = if clear_kind_clears_formats(apply_to) {
        Some(plan_clear_formats(&grid, &style_registry, (min_row, min_col, max_row, max_col))?)
    } else {
        None
    };

    // Clamp to grid bounds
    let effective_end_row = max_row.min(grid.max_row);
    let effective_end_col = max_col.min(grid.max_col);

    // Spilled values whose ORIGIN this rectangle swallows: excluded from the
    // loop for the same reason as in `clear_range` (§2y) — the cascade releases
    // them, and recording them for undo would block the re-spill. A FORMATS
    // clear removes no origin, so it keeps restyling them.
    let owned_spill = if matches!(apply_to, ClearApplyTo::Formats) {
        crate::CoordSet::default()
    } else {
        spilled_cells_owned_within(
            &state, active_sheet, min_row, min_col, effective_end_row, effective_end_col,
        )
    };

    // The STORED cells of the rectangle. Formats mode used to add every empty
    // POSITION too (and test each against this list with `Vec::contains`,
    // quadratic in the used area) only to rewrite nothing at them; the
    // positions a row / column format still paints are the plan's `blanks`.
    let mut cells_in_range: Vec<(u32, u32)> = grid
        .cells
        .keys()
        .filter(|(r, c)| {
            *r >= min_row && *r <= effective_end_row && *c >= min_col && *c <= effective_end_col
        })
        .filter(|coord| !owned_spill.contains(coord))
        .cloned()
        .collect();
    cells_in_range.sort_unstable();

    // A NO-OP writes nothing and records no undo step -- decided HERE, under
    // the same pending guards the write takes, so nothing can slip in between.
    // A clear changes something when its plan rewrites a row / column format
    // or writes a cell, when it clears the content of any stored cell, or -- a
    // Formats clear -- when some stored cell does not already show Normal
    // through index 0. (A cell under a row / column format that stays is
    // counted as a change: it may already carry the explicit Normal copy,
    // which costs an empty undo step at worst, never a skipped write.)
    //
    // A no-op that passed every gate STILL dirties the document, because
    // Excel does (round 11, overruling round 10's BUG-0359 "stays clean"):
    // [LIVE, Excel 16] Delete on an empty cell or an empty B2:D6, Home > Clear
    // > Clear Formats / Clear All on an empty cell and Clear Formats on a
    // plain number all set Workbook.Saved = False, through the UI (SendKeys /
    // ExecuteMso) as through Range.Clear*. A REFUSAL above stays clean.
    let plan_writes = plan.as_ref().is_some_and(|p| p.changes_tiers() || p.writes_cells());
    let changes_something = plan_writes
        || match apply_to {
            ClearApplyTo::Formats => cells_in_range.iter().any(|&(row, col)| {
                grid.get_cell(row, col).is_some_and(|cell| {
                    cell.style_index != 0
                        || plan
                            .as_ref()
                            .is_some_and(|p| p.painted_after(&grid, &style_registry, row, col))
                })
            }),
            _ => !cells_in_range.is_empty(),
        };
    // Every gate above has passed; from here this command commits (Excel
    // dirties even a no-op clear, see above). Constructed HERE and not at the
    // top so a refusal cannot leave a spuriously dirty document -- see
    // DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    if !changes_something {
        return Ok(ClearRangeResult {
            count: 0,
            updated_cells: Vec::new(),
        });
    }
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut style_registry = style_registry.authorize(&effect);
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    let mut count = cells_in_range.len() as u32;
    let mut updated_cells = Vec::new();
    let mut explicit = ExplicitNormal::default();

    // OWNED: a script's createNamedStyle clears its scratch cell through here
    // INSIDE the script's open batch, and the unconditional commit below
    // closed that batch halfway -- the script's next write became a step of
    // its own (found live 2026-09-29, e2e fixall-calp X6).
    let owned_txn = if count > 0 || plan_writes {
        let desc = match apply_to {
            ClearApplyTo::All => "Clear all",
            ClearApplyTo::Contents => "Clear contents",
            ClearApplyTo::Formats => "Clear formats",
            ClearApplyTo::Hyperlinks => "Clear hyperlinks",
            ClearApplyTo::RemoveHyperlinks => "Remove hyperlinks",
            ClearApplyTo::ResetContents => "Reset contents",
        };
        undo_stack.begin_owned_transaction(format!(
            "{} ({},{}) to ({},{})",
            desc, min_row, min_col, max_row, max_col
        ))
    } else {
        engine::OwnedTransaction::not_opened()
    };

    // Pre/post cell states collected for subscriber override capture.
    let mut override_edits: Vec<(u32, u32, Option<engine::Cell>, Option<engine::Cell>)> = Vec::new();

    // The ROW / COLUMN formats the rectangle covers go first (both mirrors),
    // each axis one `obj_style_tiers` restore in this step -- the record the
    // formatting commands make -- so the cells below resolve against them.
    if let Some(plan) = plan.as_ref() {
        let snapshots =
            write_cleared_tiers(&mut grid, grids.get_mut(active_sheet), plan, &mut style_registry, &mut explicit);
        for (is_column, previous) in snapshots {
            count += previous.len() as u32;
            undo_stack.record_custom_restore(
                "obj_style_tiers".to_string(),
                crate::undo_commands::style_tiers_snapshot_bytes(active_sheet, is_column, previous),
                "Clear formats",
            );
        }
    }

    for (row, col) in cells_in_range {
        // Record previous state for undo
        let previous_cell = grid.get_cell(row, col).cloned();

        match apply_to {
            ClearApplyTo::All | ClearApplyTo::ResetContents => {
                // Clear everything - same as existing clear_range
                if previous_cell.is_some() {
                    override_edits.push((row, col, previous_cell.clone(), None));
                    undo_stack.record_cell_change(active_sheet, row, col, previous_cell);
                }
                grid.clear_cell(row, col);
                if active_sheet < grids.len() {
                    grids[active_sheet].clear_cell(row, col);
                }
                // Under a row / column format that stays, the cleared position
                // must still SHOW Normal: an empty cell with the explicit Normal
                // style (index 0 would inherit the format back).
                let painted = plan
                    .as_ref()
                    .is_some_and(|p| p.painted_after(&grid, &style_registry, row, col));
                let shown_style = if painted {
                    let index = explicit.index(&mut style_registry);
                    grid.set_cell(row, col, blank_cell_with_style(index));
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(row, col, blank_cell_with_style(index));
                    }
                    index
                } else {
                    0
                };

                // Clear dependencies
                update_cross_sheet_dependencies(
                    (active_sheet, row, col),
                    Default::default(),
                    &mut cross_sheet_dependencies_map,
                    &mut cross_sheet_dependents_map,
                );
                update_dependencies(
                    (row, col),
                    Default::default(),
                    &mut dependencies_map,
                    &mut dependents_map,
                );
                update_column_dependencies(
                    (row, col),
                    Default::default(),
                    &mut column_dependencies_map,
                    &mut column_dependents_map,
                );
                update_row_dependencies(
                    (row, col),
                    Default::default(),
                    &mut row_dependencies_map,
                    &mut row_dependents_map,
                );

                // Get merge span info
                let merge_info = merged_regions
                    .iter()
                    .find(|r| r.start_row == row && r.start_col == col);
                let (row_span, col_span) = if let Some(region) = merge_info {
                    (
                        region.end_row - region.start_row + 1,
                        region.end_col - region.start_col + 1,
                    )
                } else {
                    (1, 1)
                };

                updated_cells.push(CellData {
                    row,
                    col,
                    display: String::new(),
                    // Empty: nothing to overflow, and text never marks.
                    overflow: crate::api_types::OverflowClass::Text,
                    display_color: None,
                    formula: None,
                    style_index: shown_style,
                    row_span,
                    col_span,
                    sheet_index: None,
                    rich_text: None,
                    accounting_layout: None,
                });
            }
            ClearApplyTo::Contents => {
                // Clear values and formulas, keep formatting
                if let Some(ref cell) = previous_cell {
                    undo_stack.record_cell_change(active_sheet, row, col, previous_cell.clone());

                    let style_index = cell.style_index;
                    let mut new_cell = engine::Cell::new();
                    new_cell.style_index = style_index;

                    override_edits.push((row, col, previous_cell.clone(), Some(new_cell.clone())));

                    grid.set_cell(row, col, new_cell.clone());
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(row, col, new_cell);
                    }

                    // Clear dependencies since formula is gone
                    update_cross_sheet_dependencies(
                        (active_sheet, row, col),
                        Default::default(),
                        &mut cross_sheet_dependencies_map,
                        &mut cross_sheet_dependents_map,
                    );
                    update_dependencies(
                        (row, col),
                        Default::default(),
                        &mut dependencies_map,
                        &mut dependents_map,
                    );
                    update_column_dependencies(
                        (row, col),
                        Default::default(),
                        &mut column_dependencies_map,
                        &mut column_dependents_map,
                    );
                    update_row_dependencies(
                        (row, col),
                        Default::default(),
                        &mut row_dependencies_map,
                        &mut row_dependents_map,
                    );

                    // Get merge span info
                    let merge_info = merged_regions
                        .iter()
                        .find(|r| r.start_row == row && r.start_col == col);
                    let (row_span, col_span) = if let Some(region) = merge_info {
                        (
                            region.end_row - region.start_row + 1,
                            region.end_col - region.start_col + 1,
                        )
                    } else {
                        (1, 1)
                    };

                    updated_cells.push(CellData {
                        row,
                        col,
                        display: String::new(),
                        // Empty: nothing to overflow, and text never marks.
                        overflow: crate::api_types::OverflowClass::Text,
                        display_color: None,
                        formula: None,
                        style_index,
                        row_span,
                        col_span,
                        sheet_index: None,
                        rich_text: None,
                        accounting_layout: None,
                    });
                }
            }
            ClearApplyTo::Formats => {
                // Clear formatting, keep values
                if let Some(ref cell) = previous_cell {
                    // The cell SHOWS Normal afterwards (Excel [LIVE]): index 0
                    // (inherit) where nothing would show through, the explicit
                    // Normal style under a row / column format this clear
                    // leaves in place (a partial clear inside a formatted
                    // column, a column crossing a formatted row). Clear Formats
                    // therefore also clears any per-cell LOCK override -- the
                    // cell falls back to the default: locked.
                    let target_style = if plan
                        .as_ref()
                        .is_some_and(|p| p.painted_after(&grid, &style_registry, row, col))
                    {
                        explicit.index(&mut style_registry)
                    } else {
                        0
                    };
                    if cell.style_index == target_style {
                        // Already showing Normal: nothing to write or record.
                        count -= 1;
                        continue;
                    }
                    undo_stack.record_cell_change(active_sheet, row, col, previous_cell.clone());

                    let mut new_cell = cell.clone();
                    new_cell.style_index = target_style;

                    grid.set_cell(row, col, new_cell.clone());
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(row, col, new_cell);
                    }

                    let default_style = style_registry.get(grid.effective_style_index(row, col));
                    let (display, overflow) = crate::format_cell_value_and_class(&cell.value, default_style, &locale);

                    // Get merge span info
                    let merge_info = merged_regions
                        .iter()
                        .find(|r| r.start_row == row && r.start_col == col);
                    let (row_span, col_span) = if let Some(region) = merge_info {
                        (
                            region.end_row - region.start_row + 1,
                            region.end_col - region.start_col + 1,
                        )
                    } else {
                        (1, 1)
                    };

                    updated_cells.push(CellData {
                        row,
                        col,
                        display,
                        overflow,
                        display_color: None,
                        formula: formula_display(&cell, &locale),
                        style_index: target_style,
                        row_span,
                        col_span,
                        sheet_index: None,
                        rich_text: None,
                        accounting_layout: None,
                    });
                }
            }
            // Dispatched to `clear_hyperlinks_apply_to` before this loop.
            ClearApplyTo::Hyperlinks | ClearApplyTo::RemoveHyperlinks => {}
        }
    }

    // The EMPTY positions a row / column format that stays would still paint
    // (a partial clear inside a formatted column, whole columns crossing a
    // formatted row): each gets an empty explicit-Normal cell, the cells Excel
    // writes there [LIVE: the used range grows to them].
    if let Some(plan) = plan.as_ref() {
        for &(row, col) in &plan.blanks {
            if grid.cells.contains_key(&(row, col)) {
                continue;
            }
            let index = explicit.index(&mut style_registry);
            undo_stack.record_cell_change(active_sheet, row, col, None);
            grid.set_cell(row, col, blank_cell_with_style(index));
            if active_sheet < grids.len() {
                grids[active_sheet].set_cell(row, col, blank_cell_with_style(index));
            }
            let (row_span, col_span) = merged_regions
                .iter()
                .find(|m| m.start_row == row && m.start_col == col)
                .map(|m| (m.end_row - m.start_row + 1, m.end_col - m.start_col + 1))
                .unwrap_or((1, 1));
            updated_cells.push(CellData {
                row,
                col,
                display: String::new(),
                overflow: crate::api_types::OverflowClass::Text,
                display_color: None,
                formula: None,
                style_index: index,
                row_span,
                col_span,
                sheet_index: None,
                rich_text: None,
                accounting_layout: None,
            });
            count += 1;
        }

        // An almost-whole clear's EXCLUDED positions (outside the rectangle,
        // inside its whole lines) keep the look they showed (rev3A#2): a
        // handful of cells, where the clear used to write one per position.
        for &((row, col), index) in &plan.kept {
            let previous = grid.get_cell(row, col).cloned();
            let Some(cell) = kept_cell(previous.as_ref(), index) else { continue };
            undo_stack.record_cell_change(active_sheet, row, col, previous);
            grid.set_cell(row, col, cell.clone());
            if active_sheet < grids.len() {
                grids[active_sheet].set_cell(row, col, cell.clone());
            }
            let (display, overflow) =
                crate::format_cell_value_and_class(&cell.value, style_registry.get(index), &locale);
            let (row_span, col_span) = merged_regions
                .iter()
                .find(|m| m.start_row == row && m.start_col == col)
                .map(|m| (m.end_row - m.start_row + 1, m.end_col - m.start_col + 1))
                .unwrap_or((1, 1));
            updated_cells.push(CellData {
                row,
                col,
                display,
                overflow,
                display_color: None,
                formula: formula_display(&cell, &locale),
                style_index: index,
                row_span,
                col_span,
                sheet_index: None,
                rich_text: None,
                accounting_layout: None,
            });
            count += 1;
        }
    }

    // Record subscriber overrides for all cleared cells (subscribed sheets only)
    crate::calp_commands::record_subscription_override_edits(&state, &effect, active_sheet, &override_edits);

    // An empty step (nothing changed) is dropped by the commit.
    undo_stack.commit_owned(owned_txn);

    // PHASE B — dependents (§2c), the active-sheet half of what
    // `clear_range_with_options_off_sheet` has always done through
    // `recalc_after_off_sheet_write`. Same asymmetry as `sort_range`: clearing
    // a sheet you were NOT looking at recalculated, clearing the one in front
    // of you did not.
    //
    // Seeds are the CONTENT-clearing branches only. `override_edits` is pushed
    // exactly by All/ResetContents/Contents; Formats, Hyperlinks and
    // RemoveHyperlinks change `style_index` and nothing a formula can read, so
    // they seed nothing and the cascade returns on the empty check. That is
    // deliberately tighter than the off-sheet twin, which excludes only Formats.
    let seeds: Vec<(u32, u32)> = override_edits.iter().map(|(r, c, _, _)| (*r, *c)).collect();
    drop(locale);
    drop(merged_regions);
    drop(undo_stack);
    drop(cross_sheet_dependencies_map);
    drop(cross_sheet_dependents_map);
    drop(row_dependencies_map);
    drop(row_dependents_map);
    drop(column_dependencies_map);
    drop(column_dependents_map);
    drop(dependencies_map);
    drop(dependents_map);
    drop(style_registry);
    drop(grids);
    drop(grid);

    if !seeds.is_empty() {
        recalc_after_active_sheet_bulk_rewrite(
            &state,
            &user_files_state,
            &pane_control_state,
            &ribbon_filter_state,
            &seeds,
            &mut updated_cells,
        );
    }

    Ok(ClearRangeResult {
        count,
        updated_cells,
    })
}

/// Sort a range of cells by one or more criteria.
/// Supports Excel-compatible sorting options:
/// - Multiple sort fields (primary, secondary, etc.)
/// - Ascending/descending order
/// - Case sensitivity
/// - Header row handling
/// - Row or column orientation
/// Sort a range on a NON-ACTIVE sheet (Wave 3 cross-sheet ops): the same
/// guard chain as the active path (allowSort option + per-cell protection +
/// spill + writeback claim + merged-cell refusal) re-anchored to the TARGET
/// sheet, permuting `grids[target]`. Undo is one sheet-tagged
/// "script_grid_cells" CustomRestore over the data range; relative formula
/// references are shifted with the move exactly like the active path
/// (BUG-0010 semantics), and dependents recalculate through
/// `recalc_after_off_sheet_write`.
pub(crate) fn sort_range_off_sheet(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    target: usize,
    params: SortRangeParams,
) -> Result<SortRangeResult, String> {
    sort_range_off_sheet_at(
        state,
        file_state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        target,
        params,
        None,
    )
}

/// Sort on an OBJECT's cells (P3: Sort A-Z / Z-A / Custom Sort on a floating
/// grid). Holding nothing and before any effect: target-with-sheet refusal,
/// the write extent, and the HOST's protection (the Sort option plus the
/// backing cells' lock flags). Then the off-sheet twin permutes the BACKING
/// sheet, its rules snapshot (icon sorts) taken from the backing sheet, as one
/// sheet-tagged undo step, and recalculates dependents anywhere. Excel's sort
/// moves values and never rewrites references from OTHER cells, so a host
/// formula reading the grid keeps its text and reads the value that arrived.
pub(crate) fn sort_range_on_target(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    params: SortRangeParams,
) -> Result<SortRangeResult, String> {
    crate::cell_target::refuse_target_with_sheet(&params.target, params.sheet_index.is_some())?;
    let Some(target_ref) = params.target.clone() else {
        return Err("sort_range_on_target needs a target".to_string());
    };
    let t = crate::cell_target::resolve_cell_target(state, &target_ref)?;
    let (r0, c0) = (params.start_row.min(params.end_row), params.start_col.min(params.end_col));
    let (r1, c1) = (params.start_row.max(params.end_row), params.start_col.max(params.end_col));
    crate::cell_target::ensure_in_extent(&t, r0, c0, r1, c1)?;
    crate::cell_target::gate_target_cells(state, &t, (r0, c0, r1, c1), "sort", "sort")?;
    let backing = t.backing_index;
    sort_range_off_sheet_at(
        state,
        file_state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        backing,
        SortRangeParams { sheet_index: None, target: None, ..params },
        Some(&t),
    )
}

/// [`sort_range_off_sheet`] with the P3 TOCTOU re-check under the held
/// `grids` guard (see `clear_range_with_options_off_sheet_at`).
#[allow(clippy::too_many_arguments)]
fn sort_range_off_sheet_at(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    target: usize,
    params: SortRangeParams,
    expect: Option<&crate::cell_target::ResolvedCellTarget>,
) -> Result<SortRangeResult, String> {
    {
        let rules = crate::conditional_formatting::rules_snapshot(state, target);
        validate_sort_fields(&params.fields, &rules)?;
    }
    crate::protection::check_sheet_action(state, target, "sort", "sort")?;
    crate::protection::check_sheet_protection_range(
        state, target,
        params.start_row.min(params.end_row), params.start_col.min(params.end_col),
        params.start_row.max(params.end_row), params.start_col.max(params.end_col),
    )?;
    // A sort PERMUTES the block, so it refuses any rectangle holding part of an
    // array — cells or origin — rather than trying to carry one. The
    // recalculation behind this path (`recalc_after_off_sheet_write` ->
    // `recalculate_sheet_values`) re-lays an array whose ORIGIN still holds its
    // formula (§3bm), but a permutation MOVES the origin, and a moved origin's
    // old claim has no seed to release it — so the refusal stands.
    check_no_array_within(
        state, target,
        params.start_row.min(params.end_row), params.start_col.min(params.end_col),
        params.start_row.max(params.end_row), params.start_col.max(params.end_col),
    )?;
    crate::calp_commands::ensure_range_unclaimed_on_sheets(
        state, "sort this range", &[target],
        params.start_row, params.start_col, params.end_row, params.end_col,
    )?;

    let SortRangeParams {
        start_row,
        start_col,
        end_row,
        end_col,
        fields,
        match_case,
        has_headers,
        orientation,
        sheet_index: _,
        target: _,
    } = params;

    if fields.is_empty() {
        return Ok(SortRangeResult {
            success: false,
            sorted_count: 0,
            updated_cells: vec![],
            error: Some("At least one sort field is required".to_string()),
        });
    }

    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    // Merged-cell refusal against the TARGET sheet's merge set.
    let partial_merge = crate::report::with_sheet_merges(state, target, |merged| {
        merged.iter().any(|region| {
            let overlaps = region.start_row <= max_row
                && region.end_row >= min_row
                && region.start_col <= max_col
                && region.end_col >= min_col;
            let fully_inside = region.start_row >= min_row
                && region.end_row <= max_row
                && region.start_col >= min_col
                && region.end_col <= max_col;
            overlaps && !fully_inside
        })
    });
    if partial_merge {
        return Ok(SortRangeResult {
            success: false,
            sorted_count: 0,
            updated_cells: vec![],
            error: Some(
                "Cannot sort a range that partially overlaps with merged cells".to_string(),
            ),
        });
    }

    // Taken BEFORE any grids guard. This path never read sheet names before, and
    // an icon sort needs both them and the rules while the grid guard is held.
    let sheet_names_for_icons = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let cf_rules_for_sort = crate::conditional_formatting::rules_snapshot(state, target);
    // The app locale (leaf lock: take, clone, drop) resolves the built-in
    // custom lists' local month/day names, once for the whole sort.
    let custom_orders = {
        let locale = state.locale.lock().map_err(|e| e.to_string())?.clone();
        resolve_custom_orders(&fields, &locale)
    };

    let sorted_count = {
        // Bounds check under a read-only view; the effect is built only once it
        // has passed, so a bad sheet index cannot leave the document dirty. One
        // lock throughout -- see Persisted::lock_pending.
        let grids = state.grids.lock_pending().unwrap();
        if target >= grids.len() {
            return Err(format!("Sheet index {} out of range", target));
        }
        if let Some(t) = expect {
            crate::cell_target::ensure_target_still_at(state, t)?;
        }
        let effect = crate::document_effect::DocumentEffect::mutates(file_state);
        let mut grids = grids.authorize(&effect);
        // WRITE: a moved cell may need the explicit Normal interned (see
        // `carried_line_format`).
        let mut styles = state.style_registry.write(&effect).unwrap();
        let mut undo_stack = state.undo_stack.lock().unwrap();

        // BEFORE the mutable borrow below: `resolve_icons` needs `&Grid` AND
        // `&[Grid]` at once, which `&mut grids[target]` makes impossible. The row
        // list is the sort range itself, so it is known without extracting yet.
        let icon_sets = {
            // Same header rule the row extraction applies below; computed here
            // because that binding does not exist yet at this point.
            let first_data_row = if has_headers { min_row + 1 } else { min_row };
            let lines: Vec<u32> = if first_data_row > max_row {
                Vec::new()
            } else {
                (first_data_row..=max_row).collect()
            };
            build_icon_match_sets(
                &fields,
                &grids[target],
                &grids,
                &sheet_names_for_icons,
                target,
                &cf_rules_for_sort,
                &lines,
                true,
                min_col,
            )
        };

        // The column orientation keys on the OTHER axis, so it needs its own set.
        let icon_sets_cols = {
            let first_data_col = if has_headers { min_col + 1 } else { min_col };
            let lines: Vec<u32> = if first_data_col > max_col {
                Vec::new()
            } else {
                (first_data_col..=max_col).collect()
            };
            build_icon_match_sets(
                &fields,
                &grids[target],
                &grids,
                &sheet_names_for_icons,
                target,
                &cf_rules_for_sort,
                &lines,
                false,
                min_row,
            )
        };

        let grid = &mut grids[target];

        let color_sort = fields
            .iter()
            .any(|f| matches!(f.sort_on, SortOn::CellColor | SortOn::FontColor));

        let sorted_count: u32;
        let mut previous_cells: Vec<(u32, u32, Option<engine::Cell>)> = Vec::new();

        match orientation {
            SortOrientation::Rows => {
                let data_start_row = if has_headers { min_row + 1 } else { min_row };
                if data_start_row > max_row {
                    return Ok(SortRangeResult {
                        success: true,
                        sorted_count: 0,
                        updated_cells: vec![],
                        error: None,
                    });
                }

                // Extract rows (with tier materialization for color sorts,
                // same rule as the active path), and which cells INHERIT
                // their line's format, so each carries its look where it lands.
                let mut rows: Vec<(u32, Vec<Option<engine::Cell>>, Vec<bool>)> = Vec::new();
                for row in data_start_row..=max_row {
                    let mut row_data: Vec<Option<engine::Cell>> = Vec::new();
                    let mut inherits: Vec<bool> = Vec::new();
                    for col in min_col..=max_col {
                        let mut cell = grid.get_cell(row, col).cloned();
                        inherits.push(cell.as_ref().is_some_and(|c| c.style_index == 0));
                        if color_sort {
                            if let Some(c) = cell.as_mut() {
                                if c.style_index == 0 {
                                    c.style_index = grid.effective_style_index(row, col);
                                }
                            }
                        }
                        row_data.push(cell);
                    }
                    rows.push((row, row_data, inherits));
                }

                rows.sort_by(|a, b| {
                    compare_rows_by_fields(
                        &a.1, &b.1, a.0, b.0, &icon_sets, &custom_orders, &fields, min_col, match_case, &styles,
                    )
                });

                // Capture the whole data range for undo BEFORE rewriting.
                for row in data_start_row..=max_row {
                    for col in min_col..=max_col {
                        previous_cells.push((row, col, grid.get_cell(row, col).cloned()));
                    }
                }

                sorted_count = rows.len() as u32;
                for (new_row_idx, (original_row, row_data, inherits)) in rows.iter().enumerate() {
                    let target_row = data_start_row + new_row_idx as u32;
                    let row_delta = target_row as i32 - *original_row as i32;
                    for (col_offset, cell_opt) in row_data.iter().enumerate() {
                        let target_col = min_col + col_offset as u32;
                        if let Some(cell) = cell_opt {
                            let mut cell = cell.clone();
                            // The record keeps the look it showed (BUG-0354
                            // follow-up): an inheriting cell carries its old
                            // row's format off it, or explicit Normal onto a
                            // formatted row. Tiers never move in a sort.
                            if inherits[col_offset] {
                                cell.style_index = crate::commands::styles::carried_line_format(
                                    &mut styles,
                                    crate::commands::styles::line_format_index_at(grid, *original_row, target_col),
                                    crate::commands::styles::line_format_index_at(grid, target_row, target_col),
                                );
                            }
                            if row_delta != 0 {
                                if let Some(formula) =
                                    crate::commands::structure::formula_to_rewrite(&cell)
                                {
                                    let shifted = crate::commands::structure::shift_formula_internal(
                                        &formula, row_delta, 0,
                                    );
                                    crate::commands::structure::store_rewritten_formula(
                                        &mut cell, &shifted, "sort", target_row, target_col,
                                    );
                                }
                            }
                            grid.set_cell(target_row, target_col, cell);
                        } else {
                            grid.clear_cell(target_row, target_col);
                        }
                    }
                }
            }
            SortOrientation::Columns => {
                let data_start_col = if has_headers { min_col + 1 } else { min_col };
                if data_start_col > max_col {
                    return Ok(SortRangeResult {
                        success: true,
                        sorted_count: 0,
                        updated_cells: vec![],
                        error: None,
                    });
                }

                let mut cols: Vec<(u32, Vec<Option<engine::Cell>>, Vec<bool>)> = Vec::new();
                for col in data_start_col..=max_col {
                    let mut col_data: Vec<Option<engine::Cell>> = Vec::new();
                    let mut inherits: Vec<bool> = Vec::new();
                    for row in min_row..=max_row {
                        let mut cell = grid.get_cell(row, col).cloned();
                        inherits.push(cell.as_ref().is_some_and(|c| c.style_index == 0));
                        if color_sort {
                            if let Some(c) = cell.as_mut() {
                                if c.style_index == 0 {
                                    c.style_index = grid.effective_style_index(row, col);
                                }
                            }
                        }
                        col_data.push(cell);
                    }
                    cols.push((col, col_data, inherits));
                }

                cols.sort_by(|a, b| {
                    compare_cols_by_fields(
                        &a.1, &b.1, a.0, b.0, &icon_sets_cols, &custom_orders, &fields, min_row, match_case,
                        &styles,
                    )
                });

                for row in min_row..=max_row {
                    for col in data_start_col..=max_col {
                        previous_cells.push((row, col, grid.get_cell(row, col).cloned()));
                    }
                }

                sorted_count = cols.len() as u32;
                for (new_col_idx, (original_col, col_data, inherits)) in cols.iter().enumerate() {
                    let target_col = data_start_col + new_col_idx as u32;
                    let col_delta = target_col as i32 - *original_col as i32;
                    for (row_offset, cell_opt) in col_data.iter().enumerate() {
                        let target_row = min_row + row_offset as u32;
                        if let Some(cell) = cell_opt {
                            let mut cell = cell.clone();
                            // The record keeps its look (see the row arm).
                            if inherits[row_offset] {
                                cell.style_index = crate::commands::styles::carried_line_format(
                                    &mut styles,
                                    crate::commands::styles::line_format_index_at(grid, target_row, *original_col),
                                    crate::commands::styles::line_format_index_at(grid, target_row, target_col),
                                );
                            }
                            if col_delta != 0 {
                                if let Some(formula) =
                                    crate::commands::structure::formula_to_rewrite(&cell)
                                {
                                    let shifted = crate::commands::structure::shift_formula_internal(
                                        &formula, 0, col_delta,
                                    );
                                    crate::commands::structure::store_rewritten_formula(
                                        &mut cell, &shifted, "sort", target_row, target_col,
                                    );
                                }
                            }
                            grid.set_cell(target_row, target_col, cell);
                        } else {
                            grid.clear_cell(target_row, target_col);
                        }
                    }
                }
            }
        }

        if sorted_count > 0 {
            let owned_txn = undo_stack.begin_owned_transaction(format!(
                "Sort range on sheet {} ({},{}) to ({},{})",
                target + 1, min_row, min_col, max_row, max_col
            ));
            undo_stack.record_custom_restore(
                "script_grid_cells".to_string(),
                crate::undo_commands::script_grid_cells_snapshot_bytes(target, previous_cells),
                "Sort range",
            );
            undo_stack.commit_owned(owned_txn);
        }

        sorted_count
    };

    // Moved formulas may feed (or be fed by) cells anywhere — recalculate.
    if sorted_count > 0 {
        crate::commands::data::recalc_after_off_sheet_write(
            state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &[target],
        );
        let _ = crate::document_effect::DocumentEffect::mutates(&file_state);
    }

    Ok(SortRangeResult {
        success: true,
        sorted_count,
        updated_cells: Vec::new(),
        error: None,
    })
}

/// Which lines show the icon a given sort field asks for.
///
/// One entry per sort field, in the SAME order as `fields`, so the comparator can
/// index the two together. `None` means "not an icon sort"; for an icon sort the
/// set holds the ORIGINAL row (or column) indices whose cell displays that icon.
///
/// Keying on the ORIGINAL index is what gives Excel's semantics: the sort orders
/// by the icon that was on screen when the sort was invoked. It cannot be
/// otherwise — a sort permutes the rows a percentile rule is computed over, so
/// "the icon after sorting" is not a fixed target.
type IconMatchSets = Vec<Option<std::collections::HashSet<u32>>>;

/// Build the per-level icon key: which lines display the icon each level asks for.
///
/// Resolved ONCE, before the permutation, for exactly the cells the sort keys on.
/// Doing it per comparison would be both slow and wrong — a comparator is called
/// O(n log n) times, and by the time the permutation is under way the rows a
/// percentile rule is computed over have moved.
///
/// Returns one entry per field so the comparator can index the two together;
/// `None` for levels that are not icon sorts.
fn build_icon_match_sets(
    fields: &[SortField],
    grid: &engine::Grid,
    grids: &[engine::Grid],
    sheet_names: &[String],
    sheet_index: usize,
    rules: &[crate::conditional_formatting::ConditionalFormatDefinition],
    // The lines being sorted, and how to turn (line, field.key) into a cell.
    lines: &[u32],
    by_row: bool,
    base: u32,
) -> IconMatchSets {
    fields
        .iter()
        .map(|field| {
            let wanted = match (field.sort_on, field.icon) {
                (SortOn::Icon, Some(icon)) => icon,
                // Not an icon level. `validate_sort_fields` has already refused an
                // icon level with no icon, so the second arm cannot be an icon
                // sort that lost its icon.
                _ => return None,
            };
            // For a ROW sort, field.key selects a COLUMN offset; for a column sort
            // it selects a row offset. The line index supplies the other axis.
            let cells: Vec<(u32, u32)> = lines
                .iter()
                .map(|&line| {
                    if by_row {
                        (line, base + field.key)
                    } else {
                        (base + field.key, line)
                    }
                })
                .collect();
            let resolved = crate::conditional_formatting::resolve_icons(
                grid,
                grids,
                sheet_names,
                sheet_index,
                rules,
                &cells,
                // INTERACTIVE, not Transient: on a repaint a tripped fuel budget
                // costs a highlight, here it would cost a wrong ORDER.
                crate::eval_budget::EvalSurface::Interactive,
            );
            let mut set = std::collections::HashSet::new();
            for (&line, cell) in lines.iter().zip(cells.iter()) {
                if resolved.get(cell).copied().flatten() == Some(wanted) {
                    set.insert(line);
                }
            }
            Some(set)
        })
        .collect()
}

/// Refuse a sort the engine cannot HONOUR, rather than performing a different one
/// and reporting success.
///
/// Replaces the blanket `SortOn::Icon` refusal that shipped while icon sorting was
/// unimplemented (BUG-0104). Icon sorting now works, so what remains are three
/// cases that are genuinely unanswerable — and each REFUSES rather than guessing,
/// because a sort that silently orders by the wrong key is harder for a user to
/// catch than an error: the rows really did move.
///
/// Checks EVERY level, not just the first. Excel sorts on up to 64, and a guard
/// reading `fields[0]` would honour level 1 and silently mis-sort level 2 — the
/// same defect one level down.
fn validate_sort_fields(
    fields: &[SortField],
    rules: &[crate::conditional_formatting::ConditionalFormatDefinition],
) -> Result<(), String> {
    let any_icon_rule = rules.iter().any(|r| {
        r.enabled && matches!(r.rule, crate::conditional_formatting::ConditionalFormatRule::IconSet(_))
    });

    for (level, field) in fields.iter().enumerate() {
        if field.sort_on != SortOn::Icon {
            continue;
        }
        // 1. No icon named. There is no default: "sort by icon" without saying
        //    WHICH icon has no meaning, and picking one for the user would be a
        //    guess presented as an answer.
        if field.icon.is_none() {
            return Err(format!(
                "Sort level {} asks to sort by conditional-formatting icon but names no icon. \
                 Choose which icon to bring to the top.",
                level + 1
            ));
        }
        // 2. A custom order cannot apply to an icon. The Sort dialog lets both be
        //    chosen today, and silently ignoring one of them is the defect class
        //    this whole entry is about.
        if field.custom_order.is_some() {
            return Err(format!(
                "Sort level {} combines a conditional-formatting icon with a custom order. \
                 Choose one.",
                level + 1
            ));
        }
        // 3. Nothing in range can produce an icon. A sort that legitimately cannot
        //    move anything is indistinguishable from the silent no-op this entry
        //    replaced, so it has to speak.
        if !any_icon_rule {
            return Err(format!(
                "Sort level {} sorts by conditional-formatting icon, but no enabled icon-set rule \
                 applies here, so no cell shows an icon.",
                level + 1
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn sort_range(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<'_, UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: SortRangeParams,
) -> Result<SortRangeResult, String> {
    // P3: an OBJECT's cells (a floating grid) -- its backing sheet only.
    if params.target.is_some() {
        return sort_range_on_target(
            &state,
            &file_state,
            &user_files_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
            params,
        );
    }
    // The rule snapshot is taken and released here, BEFORE any long-lived guard.
    // Sorting holds the grid guards for its whole two-phase pass and undo restore
    // writes the CF store, so a CF guard held across either is a deadlock waiting
    // for the right interleaving.
    {
        let target = params
            .sheet_index
            .unwrap_or_else(|| *state.active_sheet.read().unwrap());
        let rules = crate::conditional_formatting::rules_snapshot(&state, target);
        validate_sort_fields(&params.fields, &rules)?;
    }
    // Wave 3: an explicit non-active target takes the off-sheet path.
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        if let Some(target) = params.sheet_index {
            if target != active_sheet {
                let count = state.sheet_names.read().unwrap().len();
                if target >= count {
                    return Err(format!(
                        "Sheet index {} out of range: workbook has {} sheet(s)",
                        target, count
                    ));
                }
                return sort_range_off_sheet(
                    &state,
                    &file_state,
                    &user_files_state,
                    &pivot_state,
                    &pane_control_state,
                    &ribbon_filter_state,
                    target,
                    params,
                );
            }
        }
    }
    // Sheet protection, BOTH axes: the allowSort option must permit sorting at
    // all, and every cell in the range must be writable (a sort rewrites them).
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        crate::protection::check_sheet_action(&state, active_sheet, "sort", "sort")?;
        crate::protection::check_sheet_protection_range(
            &state, active_sheet,
            params.start_row.min(params.end_row), params.start_col.min(params.end_col),
            params.start_row.max(params.end_row), params.start_col.max(params.end_col),
        )?;
    }

    // A permutation cannot carry an array: refuse a range holding any part of
    // one, cells or origin. See the off-sheet twin.
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        check_no_array_within(
            &state, active_sheet,
            params.start_row.min(params.end_row), params.start_col.min(params.end_col),
            params.start_row.max(params.end_row), params.start_col.max(params.end_col),
        )?;
    }

    // WRITEBACK CLAIM GUARD. A sort rewrites every cell of the range in a
    // permuted order without ever touching `update_cell_impl`, so nothing else
    // stands between a script's `api.sortRange` and a published writeback
    // region. Refused for the whole range before any lock or transaction is
    // taken — a permutation cannot be applied "partially" and the drafts are
    // keyed by (row, col), so sorting would silently re-point every answer at
    // a different respondent's cell. See the policy note in calp_commands.rs.
    crate::calp_commands::ensure_range_unclaimed(
        &state,
        "sort this range",
        params.start_row,
        params.start_col,
        params.end_row,
        params.end_col,
    )?;

    // Cloned before the long-lived locks: the dependency rebuild below needs
    // the official sheet names to canonicalise cross-sheet keys.
    let sheet_names_for_rebuild = state.sheet_names.read().unwrap().clone();
    // Cloned HERE, next to sheet_names and before the grid guards, for the same
    // reason: an icon sort needs the rules while it holds those guards, and undo
    // restore writes the CF store -- so the guard must not still be held.
    let cf_rules_for_sort = {
        let sheet = params.sheet_index.unwrap_or(*state.active_sheet.read().unwrap());
        crate::conditional_formatting::rules_snapshot(&state, sheet)
    };
    // Every gate above has passed; from here this command commits. Constructed
    // HERE and not at the top so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    // WRITE: a moved cell may need the explicit Normal interned (see
    // `carried_line_format`).
    let mut styles = state.style_registry.write(&effect).unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    let SortRangeParams {
        start_row,
        start_col,
        end_row,
        end_col,
        fields,
        match_case,
        has_headers,
        orientation,
        sheet_index: _,
        target: _,
    } = params;
    // Built-in custom lists also match the app locale's month/day names.
    let custom_orders = resolve_custom_orders(&fields, &locale);

    // Validate sort fields
    if fields.is_empty() {
        return Ok(SortRangeResult {
            success: false,
            sorted_count: 0,
            updated_cells: vec![],
            error: Some("At least one sort field is required".to_string()),
        });
    }

    // Normalize coordinates
    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    // Check for merged cells in the sort range - sorting with merged cells is complex
    for region in merged_regions.iter() {
        if region.start_row <= max_row
            && region.end_row >= min_row
            && region.start_col <= max_col
            && region.end_col >= min_col
        {
            // Check if merge is completely within or completely outside
            let fully_inside = region.start_row >= min_row
                && region.end_row <= max_row
                && region.start_col >= min_col
                && region.end_col <= max_col;
            if !fully_inside {
                return Ok(SortRangeResult {
                    success: false,
                    sorted_count: 0,
                    updated_cells: vec![],
                    error: Some(
                        "Cannot sort a range that partially overlaps with merged cells".to_string(),
                    ),
                });
            }
        }
    }

    // PHASE A — permute. Yields the sorted cells; the dependent recalculation
    // is PHASE B below, after these guards are released.
    let (sorted_count, mut updated_cells) = match orientation {
        SortOrientation::Rows => {
            // Sort by rows (typical case - sort data vertically)
            let data_start_row = if has_headers { min_row + 1 } else { min_row };

            if data_start_row > max_row {
                return Ok(SortRangeResult {
                    success: true,
                    sorted_count: 0,
                    updated_cells: vec![],
                    error: None,
                });
            }

            // Collect all rows as vectors of cell data. For COLOR sorts,
            // materialize the effective style onto each extracted cell: the
            // rows are flattened here, so the comparator can no longer resolve
            // row/column tiers — without this, a fill inherited from a tier is
            // invisible to Sort by Cell Color / Font Color. `inherits` marks
            // the cells with no style of their own, for EVERY sort: each one
            // keeps the look it showed where it lands (below), which is what
            // Excel does when sort moves cells.
            let color_sort = fields
                .iter()
                .any(|f| matches!(f.sort_on, SortOn::CellColor | SortOn::FontColor));
            let mut rows: Vec<(u32, Vec<Option<engine::Cell>>, Vec<bool>)> = Vec::new();
            for row in data_start_row..=max_row {
                let mut row_data: Vec<Option<engine::Cell>> = Vec::new();
                let mut inherits: Vec<bool> = Vec::new();
                for col in min_col..=max_col {
                    let mut cell = grid.get_cell(row, col).cloned();
                    inherits.push(cell.as_ref().is_some_and(|c| c.style_index == 0));
                    if color_sort {
                        if let Some(c) = cell.as_mut() {
                            if c.style_index == 0 {
                                c.style_index = grid.effective_style_index(row, col);
                            }
                        }
                    }
                    row_data.push(cell);
                }
                rows.push((row, row_data, inherits));
            }

            // Resolve the icon key ONCE, before the permutation, over exactly the
            // cells the sort keys on. Excel semantics: order by the icon that was on
            // screen when the sort was invoked.
            let icon_sets = build_icon_match_sets(
                &fields,
                &grid,
                &grids,
                &sheet_names_for_rebuild,
                active_sheet,
                &cf_rules_for_sort,
                &rows.iter().map(|(r, _, _)| *r).collect::<Vec<u32>>(),
                true,
                min_col,
            );

            // Sort the rows using the sort fields
            rows.sort_by(|a, b| {
                compare_rows_by_fields(
                    &a.1, &b.1, a.0, b.0, &icon_sets, &custom_orders, &fields, min_col, match_case, &styles,
                )
            });

            // Begin undo transaction
            let owned_txn = undo_stack.begin_owned_transaction(format!(
                "Sort range ({},{}) to ({},{})",
                min_row, min_col, max_row, max_col
            ));

            // Apply the sorted order back to the grid
            let mut updated_cells = Vec::new();
            let sorted_count = rows.len() as u32;

            for (new_row_idx, (original_row, row_data, inherits)) in rows.iter().enumerate() {
                let target_row = data_start_row + new_row_idx as u32;
                let row_delta = target_row as i32 - *original_row as i32;

                for (col_offset, cell_opt) in row_data.iter().enumerate() {
                    let target_col = min_col + col_offset as u32;

                    // Record undo for the target cell
                    let prev_cell = grid.get_cell(target_row, target_col).cloned();
                    undo_stack.record_cell_change(active_sheet, target_row, target_col, prev_cell);

                    if let Some(cell) = cell_opt {
                        // A moved formula must keep referring to its own row:
                        // shift relative row references by the move delta
                        // (Excel sort semantics). Without this, the displayed
                        // value looks right but the next recalculation
                        // computes from the wrong rows (BUG-0010).
                        let mut cell = cell.clone();
                        // The record keeps the look it showed (BUG-0354
                        // follow-up): an inheriting cell carries its old row's
                        // format off it, or explicit Normal onto a formatted
                        // row. Tiers never move in a sort.
                        if inherits[col_offset] {
                            cell.style_index = crate::commands::styles::carried_line_format(
                                &mut styles,
                                crate::commands::styles::line_format_index_at(&grid, *original_row, target_col),
                                crate::commands::styles::line_format_index_at(&grid, target_row, target_col),
                            );
                        }
                        if row_delta != 0 {
                            if let Some(formula) =
                                crate::commands::structure::formula_to_rewrite(&cell)
                            {
                                let shifted = crate::commands::structure::shift_formula_internal(
                                    &formula, row_delta, 0,
                                );
                                crate::commands::structure::store_rewritten_formula(
                                    &mut cell, &shifted, "sort", target_row, target_col,
                                );
                            }
                        }
                        let cell = &cell;

                        grid.set_cell(target_row, target_col, cell.clone());
                        if active_sheet < grids.len() {
                            grids[active_sheet].set_cell(target_row, target_col, cell.clone());
                        }

                        let style = styles.get(grid.effective_style_index(target_row, target_col));
                        let (display, overflow) = crate::format_cell_value_and_class(&cell.value, style, &locale);

                        updated_cells.push(CellData {
                            row: target_row,
                            col: target_col,
                            display,
                            overflow,
                            display_color: None,
                            formula: formula_display(&cell, &locale),
                            style_index: grid.effective_style_index(target_row, target_col),
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                            rich_text: None,
                            accounting_layout: None,
                        });
                    } else {
                        grid.clear_cell(target_row, target_col);
                        if active_sheet < grids.len() {
                            grids[active_sheet].clear_cell(target_row, target_col);
                        }

                        updated_cells.push(CellData {
                            row: target_row,
                            col: target_col,
                            display: String::new(),
                            // Empty: nothing to overflow, and text never marks.
                            overflow: crate::api_types::OverflowClass::Text,
                            display_color: None,
                            formula: None,
                            style_index: 0,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                            rich_text: None,
                            accounting_layout: None,
                        });
                    }
                }
            }

            undo_stack.commit_owned(owned_txn);

            // Formula cells moved (and their references were shifted) —
            // rebuild the dependency maps so incremental recalc keeps
            // working against the new positions (BUG-0010).
            // Name tables acquired HERE, at the call site, like `sheet_names`:
            // the rebuild must expand defined names before extracting cell
            // references, and a caller holding one of these must not deadlock.
            let rebuild_named_ranges = state.named_ranges.read().unwrap();
            let rebuild_tables = state.tables.read().unwrap();
            let rebuild_table_names = state.table_names.read().unwrap();
            crate::undo_commands::rebuild_all_dependencies_from_grid(
                &grid,
                active_sheet,
                &sheet_names_for_rebuild,
                crate::name_resolution::NameTables {
                    named_ranges: &rebuild_named_ranges,
                    tables: &rebuild_tables,
                    table_names: &rebuild_table_names,
                    sheet_names: &sheet_names_for_rebuild,
                    spill_ranges: &state.spill_ranges,
                },
                &state,
            );

            // Mark workbook as dirty
            let _ = crate::document_effect::DocumentEffect::mutates(&file_state);

            (sorted_count, updated_cells)
        }
        SortOrientation::Columns => {
            // Sort by columns (sort data horizontally)
            let data_start_col = if has_headers { min_col + 1 } else { min_col };

            if data_start_col > max_col {
                return Ok(SortRangeResult {
                    success: true,
                    sorted_count: 0,
                    updated_cells: vec![],
                    error: None,
                });
            }

            // Collect all columns as vectors of cell data (same tier
            // materialization rule, and the same `inherits` marks, as the row
            // sort above).
            let color_sort = fields
                .iter()
                .any(|f| matches!(f.sort_on, SortOn::CellColor | SortOn::FontColor));
            let mut cols: Vec<(u32, Vec<Option<engine::Cell>>, Vec<bool>)> = Vec::new();
            for col in data_start_col..=max_col {
                let mut col_data: Vec<Option<engine::Cell>> = Vec::new();
                let mut inherits: Vec<bool> = Vec::new();
                for row in min_row..=max_row {
                    let mut cell = grid.get_cell(row, col).cloned();
                    inherits.push(cell.as_ref().is_some_and(|c| c.style_index == 0));
                    if color_sort {
                        if let Some(c) = cell.as_mut() {
                            if c.style_index == 0 {
                                c.style_index = grid.effective_style_index(row, col);
                            }
                        }
                    }
                    col_data.push(cell);
                }
                cols.push((col, col_data, inherits));
            }

            // Sort the columns using the sort fields (treating rows as keys)
            let icon_sets = build_icon_match_sets(
                &fields,
                &grid,
                &grids,
                &sheet_names_for_rebuild,
                active_sheet,
                &cf_rules_for_sort,
                &cols.iter().map(|(c, _, _)| *c).collect::<Vec<u32>>(),
                // by_row = false: for a column sort `field.key` selects a ROW
                // offset, and the line index supplies the column.
                false,
                min_row,
            );

            cols.sort_by(|a, b| {
                compare_cols_by_fields(
                    &a.1, &b.1, a.0, b.0, &icon_sets, &custom_orders, &fields, min_row, match_case, &styles,
                )
            });

            // Begin undo transaction
            let owned_txn = undo_stack.begin_owned_transaction(format!(
                "Sort columns ({},{}) to ({},{})",
                min_row, min_col, max_row, max_col
            ));

            // Apply the sorted order back to the grid
            let mut updated_cells = Vec::new();
            let sorted_count = cols.len() as u32;

            for (new_col_idx, (original_col, col_data, inherits)) in cols.iter().enumerate() {
                let target_col = data_start_col + new_col_idx as u32;
                let col_delta = target_col as i32 - *original_col as i32;

                for (row_offset, cell_opt) in col_data.iter().enumerate() {
                    let target_row = min_row + row_offset as u32;

                    // Record undo for the target cell
                    let prev_cell = grid.get_cell(target_row, target_col).cloned();
                    undo_stack.record_cell_change(active_sheet, target_row, target_col, prev_cell);

                    if let Some(cell) = cell_opt {
                        // Shift relative column references with the move
                        // (Excel sort semantics; see the row-sort arm /
                        // BUG-0010).
                        let mut cell = cell.clone();
                        // The record keeps its look (see the row-sort arm).
                        if inherits[row_offset] {
                            cell.style_index = crate::commands::styles::carried_line_format(
                                &mut styles,
                                crate::commands::styles::line_format_index_at(&grid, target_row, *original_col),
                                crate::commands::styles::line_format_index_at(&grid, target_row, target_col),
                            );
                        }
                        if col_delta != 0 {
                            if let Some(formula) =
                                crate::commands::structure::formula_to_rewrite(&cell)
                            {
                                let shifted = crate::commands::structure::shift_formula_internal(
                                    &formula, 0, col_delta,
                                );
                                crate::commands::structure::store_rewritten_formula(
                                    &mut cell, &shifted, "sort", target_row, target_col,
                                );
                            }
                        }
                        let cell = &cell;

                        grid.set_cell(target_row, target_col, cell.clone());
                        if active_sheet < grids.len() {
                            grids[active_sheet].set_cell(target_row, target_col, cell.clone());
                        }

                        let style = styles.get(grid.effective_style_index(target_row, target_col));
                        let (display, overflow) = crate::format_cell_value_and_class(&cell.value, style, &locale);

                        updated_cells.push(CellData {
                            row: target_row,
                            col: target_col,
                            display,
                            overflow,
                            display_color: None,
                            formula: formula_display(&cell, &locale),
                            style_index: grid.effective_style_index(target_row, target_col),
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                            rich_text: None,
                            accounting_layout: None,
                        });
                    } else {
                        grid.clear_cell(target_row, target_col);
                        if active_sheet < grids.len() {
                            grids[active_sheet].clear_cell(target_row, target_col);
                        }

                        updated_cells.push(CellData {
                            row: target_row,
                            col: target_col,
                            display: String::new(),
                            // Empty: nothing to overflow, and text never marks.
                            overflow: crate::api_types::OverflowClass::Text,
                            display_color: None,
                            formula: None,
                            style_index: 0,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                            rich_text: None,
                            accounting_layout: None,
                        });
                    }
                }
            }

            undo_stack.commit_owned(owned_txn);

            // Formula cells moved (and their references were shifted) —
            // rebuild the dependency maps so incremental recalc keeps
            // working against the new positions (BUG-0010).
            // Name tables acquired HERE, at the call site, like `sheet_names`:
            // the rebuild must expand defined names before extracting cell
            // references, and a caller holding one of these must not deadlock.
            let rebuild_named_ranges = state.named_ranges.read().unwrap();
            let rebuild_tables = state.tables.read().unwrap();
            let rebuild_table_names = state.table_names.read().unwrap();
            crate::undo_commands::rebuild_all_dependencies_from_grid(
                &grid,
                active_sheet,
                &sheet_names_for_rebuild,
                crate::name_resolution::NameTables {
                    named_ranges: &rebuild_named_ranges,
                    tables: &rebuild_tables,
                    table_names: &rebuild_table_names,
                    sheet_names: &sheet_names_for_rebuild,
                    spill_ranges: &state.spill_ranges,
                },
                &state,
            );

            // Mark workbook as dirty
            let _ = crate::document_effect::DocumentEffect::mutates(&file_state);

            (sorted_count, updated_cells)
        }
    };

    // PHASE B — dependents. A sort REWRITES every cell of its range, so every
    // one of them is a seed; without this the range's own dependents (and any
    // formula on another sheet reading it) kept their pre-sort values, while
    // the non-active-sheet sibling `sort_range_off_sheet` recalculated
    // correctly. See `recalc_after_active_sheet_bulk_rewrite`.
    //
    // The guards above must be released first: the recalc takes the same
    // grid/styles/merged_regions/locale mutexes PLUS the dependency maps that
    // `rebuild_all_dependencies_from_grid` just used, std mutexes are not
    // reentrant, and acquiring the dependency maps after `undo_stack` (which
    // `update_cell_impl` takes in the opposite order) would invert the
    // canonical lock order.
    drop(locale);
    drop(merged_regions);
    drop(undo_stack);
    drop(styles);
    drop(grids);
    drop(grid);

    if sorted_count > 0 {
        let seeds: Vec<(u32, u32)> = (min_row..=max_row)
            .flat_map(|r| (min_col..=max_col).map(move |c| (r, c)))
            .collect();
        recalc_after_active_sheet_bulk_rewrite(
            &state,
            &user_files_state,
            &pane_control_state,
            &ribbon_filter_state,
            &seeds,
            &mut updated_cells,
        );
    }

    Ok(SortRangeResult {
        success: true,
        sorted_count,
        updated_cells,
        error: None,
    })
}

/// Compare two rows by the given sort fields.
fn compare_rows_by_fields(
    row_a: &[Option<engine::Cell>],
    row_b: &[Option<engine::Cell>],
    // The ORIGINAL row indices, which are the snapshot key an icon sort reads.
    // Required rather than optional so that every call site had to be updated
    // when icon sorting landed — a comparator silently missing the key would
    // order every row Equal and look like a stable sort that did nothing.
    orig_a: u32,
    orig_b: u32,
    icon_sets: &IconMatchSets,
    custom_orders: &CustomOrders,
    fields: &[SortField],
    _min_col: u32,
    match_case: bool,
    styles: &StyleRegistry,
) -> std::cmp::Ordering {
    for (level, field) in fields.iter().enumerate() {
        if field.sort_on == SortOn::Icon {
            let ordering = compare_by_icon(icon_sets, level, orig_a, orig_b);
            if ordering != std::cmp::Ordering::Equal {
                return if field.ascending { ordering } else { ordering.reverse() };
            }
            continue;
        }
        let col_idx = field.key as usize;
        if col_idx >= row_a.len() || col_idx >= row_b.len() {
            continue;
        }

        let cell_a = &row_a[col_idx];
        let cell_b = &row_b[col_idx];

        let custom_order = custom_orders.get(level).and_then(Option::as_ref);
        let ordering = compare_cells(cell_a, cell_b, field, custom_order, match_case, styles);

        if ordering != std::cmp::Ordering::Equal {
            return if field.ascending {
                ordering
            } else {
                ordering.reverse()
            };
        }
    }
    std::cmp::Ordering::Equal
}

/// Compare two columns by the given sort fields.
/// Order two lines by whether each shows the icon a level asks for.
///
/// `Match` sorts BEFORE `Other` — which under `ascending` (Excel's "On Top")
/// brings the chosen icon to the top, and the existing `.reverse()` gives "On
/// Bottom" for free.
///
/// Two lines that both match, or both do not, compare Equal: the next sort level
/// decides, and if none does, `sort_by`'s stability preserves the original order.
/// That is Excel's residue behaviour, and it is why this must NOT fall back to
/// comparing values — the old `SortOn::Icon` arm did exactly that and silently
/// produced a value sort labelled as an icon sort (BUG-0104).
fn compare_by_icon(
    icon_sets: &IconMatchSets,
    level: usize,
    orig_a: u32,
    orig_b: u32,
) -> std::cmp::Ordering {
    let Some(Some(set)) = icon_sets.get(level) else {
        // Unreachable: `validate_sort_fields` refuses an icon level with no icon,
        // and the key builder emits one entry per field. Loud in tests, inert in
        // release, and never a value comparison.
        debug_assert!(false, "icon sort level {level} has no precomputed key");
        return std::cmp::Ordering::Equal;
    };
    match (set.contains(&orig_a), set.contains(&orig_b)) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    }
}

fn compare_cols_by_fields(
    col_a: &[Option<engine::Cell>],
    col_b: &[Option<engine::Cell>],
    // The ORIGINAL column indices — the snapshot key, exactly as for rows.
    orig_a: u32,
    orig_b: u32,
    icon_sets: &IconMatchSets,
    custom_orders: &CustomOrders,
    fields: &[SortField],
    _min_row: u32,
    match_case: bool,
    styles: &StyleRegistry,
) -> std::cmp::Ordering {
    for (level, field) in fields.iter().enumerate() {
        if field.sort_on == SortOn::Icon {
            let ordering = compare_by_icon(icon_sets, level, orig_a, orig_b);
            if ordering != std::cmp::Ordering::Equal {
                return if field.ascending { ordering } else { ordering.reverse() };
            }
            continue;
        }
        let row_idx = field.key as usize;
        if row_idx >= col_a.len() || row_idx >= col_b.len() {
            continue;
        }

        let cell_a = &col_a[row_idx];
        let cell_b = &col_b[row_idx];

        let custom_order = custom_orders.get(level).and_then(Option::as_ref);
        let ordering = compare_cells(cell_a, cell_b, field, custom_order, match_case, styles);

        if ordering != std::cmp::Ordering::Equal {
            return if field.ascending {
                ordering
            } else {
                ordering.reverse()
            };
        }
    }
    std::cmp::Ordering::Equal
}

/// Compare two cells based on sort field settings.
fn compare_cells(
    cell_a: &Option<engine::Cell>,
    cell_b: &Option<engine::Cell>,
    field: &SortField,
    // `field.custom_order` resolved ONCE per sort (`resolve_custom_orders`);
    // None when the level has no custom list or the list is empty.
    custom_order: Option<&CustomOrder>,
    match_case: bool,
    styles: &StyleRegistry,
) -> std::cmp::Ordering {
    match field.sort_on {
        SortOn::Value => {
            // Check for custom sort order
            if let Some(list) = custom_order {
                let text_a = cell_a.as_ref().and_then(|c| match &c.value {
                    engine::CellValue::Text(s) => Some(s.as_str()),
                    _ => None,
                });
                let text_b = cell_b.as_ref().and_then(|c| match &c.value {
                    engine::CellValue::Text(s) => Some(s.as_str()),
                    _ => None,
                });

                return match (text_a, text_b) {
                    (None, None) => std::cmp::Ordering::Equal,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (Some(a), Some(b)) => {
                        let key_a = custom_sort_key(a, list);
                        let key_b = custom_sort_key(b, list);
                        key_a.cmp(&key_b)
                    }
                };
            }

            // Compare by cell value
            let val_a = cell_a.as_ref().map(|c| &c.value);
            let val_b = cell_b.as_ref().map(|c| &c.value);

            match (val_a, val_b) {
                (None, None) => std::cmp::Ordering::Equal,
                (None, Some(_)) => std::cmp::Ordering::Greater, // Empty cells sort last
                (Some(_), None) => std::cmp::Ordering::Less,
                (Some(a), Some(b)) => compare_cell_values(a, b, match_case, field.data_option),
            }
        }
        SortOn::CellColor => {
            // Compare by background color (derived from fill)
            let color_a = cell_a.as_ref().map(|c| {
                let style = styles.get(c.style_index);
                style.fill.background_color().to_css_default()
            });
            let color_b = cell_b.as_ref().map(|c| {
                let style = styles.get(c.style_index);
                style.fill.background_color().to_css_default()
            });

            match (color_a, color_b, &field.color) {
                (Some(a), Some(b), Some(target)) => {
                    // Sort by whether the color matches the target
                    let a_matches = a.eq_ignore_ascii_case(target);
                    let b_matches = b.eq_ignore_ascii_case(target);
                    match (a_matches, b_matches) {
                        (true, false) => std::cmp::Ordering::Less,
                        (false, true) => std::cmp::Ordering::Greater,
                        _ => a.cmp(&b),
                    }
                }
                (Some(a), Some(b), None) => a.cmp(&b),
                (None, Some(_), _) => std::cmp::Ordering::Greater,
                (Some(_), None, _) => std::cmp::Ordering::Less,
                (None, None, _) => std::cmp::Ordering::Equal,
            }
        }
        SortOn::FontColor => {
            // Compare by font color
            let color_a = cell_a.as_ref().map(|c| {
                let style = styles.get(c.style_index);
                style.font.color.to_css_default()
            });
            let color_b = cell_b.as_ref().map(|c| {
                let style = styles.get(c.style_index);
                style.font.color.to_css_default()
            });

            match (color_a, color_b, &field.color) {
                (Some(a), Some(b), Some(target)) => {
                    let a_matches = a.eq_ignore_ascii_case(target);
                    let b_matches = b.eq_ignore_ascii_case(target);
                    match (a_matches, b_matches) {
                        (true, false) => std::cmp::Ordering::Less,
                        (false, true) => std::cmp::Ordering::Greater,
                        _ => a.cmp(&b),
                    }
                }
                (Some(a), Some(b), None) => a.cmp(&b),
                (None, Some(_), _) => std::cmp::Ordering::Greater,
                (Some(_), None, _) => std::cmp::Ordering::Less,
                (None, None, _) => std::cmp::Ordering::Equal,
            }
        }
        SortOn::Icon => {
            // NEVER A VALUE COMPARISON. An icon level is handled by
            // `compare_by_icon` from a key precomputed before the permutation, so
            // both row and column comparators `continue` past this function for
            // `SortOn::Icon` and this arm exists only to keep the match total.
            //
            // It used to hold the value-comparison body, which WAS the defect
            // (BUG-0104): the user asked for an icon sort, the rows reordered by
            // value, and success was reported. Reaching it now means a level was
            // not keyed — loud in tests, and Equal in release so the sort merely
            // leaves that level's order alone instead of inventing one from the
            // wrong column.
            debug_assert!(
                false,
                "SortOn::Icon reached compare_cells: the level was not keyed by \
                 build_icon_match_sets, so the icon key is missing"
            );
            std::cmp::Ordering::Equal
        }
    }
}

// ============================================================================
// Built-in Custom Sort Lists
// ============================================================================

const WEEKDAYS: &[&str] = &["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_SHORT: &[&str] = &["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: &[&str] = &["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT: &[&str] = &["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// One custom sort list, resolved for a sort: position `i` holds every
/// spelling (lower-cased) that sorts at `i`.
pub(crate) struct CustomOrder {
    positions: Vec<Vec<String>>,
}

/// One entry per sort level, parallel to `fields`.
type CustomOrders = Vec<Option<CustomOrder>>;

/// Resolve every level's `custom_order` ONCE per sort, in the app locale.
/// An empty list is None, so that level compares by value as before.
fn resolve_custom_orders(fields: &[SortField], locale: &engine::LocaleSettings) -> CustomOrders {
    fields
        .iter()
        .map(|f| {
            f.custom_order
                .as_deref()
                .map(|order| resolve_custom_order(order, locale))
                .filter(|order| !order.positions.is_empty())
        })
        .collect()
}

/// Resolve a custom_order string into its positions.
/// Built-in names: "weekdays", "weekdaysShort", "months", "monthsShort".
/// Otherwise treated as a comma-separated list of custom values.
///
/// A built-in list keeps the ENGLISH names and adds the app locale's own
/// calendar names (`locale.calendar()`) at the same position, so "mars"
/// sorts as March under sv-SE while "March" is still recognised (P2 S5).
/// Both are matched case-insensitively.
fn resolve_custom_order(custom_order: &str, locale: &engine::LocaleSettings) -> CustomOrder {
    let calendar = locale.calendar();
    let built_in = |english: &[&str], local: &[&str]| -> Vec<Vec<String>> {
        english
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let mut spellings = vec![name.to_lowercase()];
                if let Some(own) = local.get(i) {
                    let own = own.to_lowercase();
                    if !spellings.contains(&own) {
                        spellings.push(own);
                    }
                }
                spellings
            })
            .collect()
    };
    let positions = match custom_order {
        "weekdays" => built_in(WEEKDAYS, &calendar.days_full),
        "weekdaysShort" => built_in(WEEKDAYS_SHORT, &calendar.days_short),
        "months" => built_in(MONTHS, &calendar.months_full),
        "monthsShort" => built_in(MONTHS_SHORT, &calendar.months_short),
        _ => custom_order
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| vec![s.to_lowercase()])
            .collect(),
    };
    CustomOrder { positions }
}

/// Get the sort position of a value in a custom list (case-insensitive).
/// Values not found in the list sort after all list values (usize::MAX).
fn custom_sort_key(value: &str, list: &CustomOrder) -> usize {
    let value = value.to_lowercase();
    list.positions
        .iter()
        .position(|spellings| spellings.iter().any(|s| *s == value))
        .unwrap_or(usize::MAX)
}

/// Compare two cell values with support for different data types and options.
fn compare_cell_values(
    a: &engine::CellValue,
    b: &engine::CellValue,
    match_case: bool,
    data_option: SortDataOption,
) -> std::cmp::Ordering {
    use engine::CellValue;

    // Type ordering: Numbers < Text < Booleans < Errors < Empty
    fn type_order(v: &CellValue) -> u8 {
        match v {
            CellValue::Number(_) => 0,
            CellValue::Text(_) => 1,
            CellValue::Boolean(_) => 2,
            CellValue::Error(_) => 3,
            CellValue::List(_) | CellValue::Dict(_) => 3, // Sort alongside errors
            CellValue::Empty => 4,
        }
    }

    match (a, b) {
        (CellValue::Number(n1), CellValue::Number(n2)) => {
            n1.partial_cmp(n2).unwrap_or(std::cmp::Ordering::Equal)
        }
        (CellValue::Text(s1), CellValue::Text(s2)) => {
            // Check if we should treat text as numbers
            if data_option == SortDataOption::TextAsNumber {
                if let (Ok(n1), Ok(n2)) = (s1.parse::<f64>(), s2.parse::<f64>()) {
                    return n1.partial_cmp(&n2).unwrap_or(std::cmp::Ordering::Equal);
                }
            }

            if match_case {
                s1.cmp(s2)
            } else {
                s1.to_lowercase().cmp(&s2.to_lowercase())
            }
        }
        (CellValue::Text(s), CellValue::Number(n)) => {
            // Text with TextAsNumber option
            if data_option == SortDataOption::TextAsNumber {
                if let Ok(sn) = s.parse::<f64>() {
                    return sn.partial_cmp(n).unwrap_or(std::cmp::Ordering::Equal);
                }
            }
            // Default: number comes before text
            std::cmp::Ordering::Greater
        }
        (CellValue::Number(n), CellValue::Text(s)) => {
            if data_option == SortDataOption::TextAsNumber {
                if let Ok(sn) = s.parse::<f64>() {
                    return n.partial_cmp(&sn).unwrap_or(std::cmp::Ordering::Equal);
                }
            }
            std::cmp::Ordering::Less
        }
        (CellValue::Boolean(b1), CellValue::Boolean(b2)) => {
            // FALSE < TRUE
            b1.cmp(b2)
        }
        (CellValue::Error(e1), CellValue::Error(e2)) => {
            // Errors sort by their debug representation
            format!("{:?}", e1).cmp(&format!("{:?}", e2))
        }
        (CellValue::Empty, CellValue::Empty) => std::cmp::Ordering::Equal,
        _ => {
            // Different types - use type ordering
            type_order(a).cmp(&type_order(b))
        }
    }
}

/// Get the grid bounds (max row and col with data).
#[tauri::command]
pub fn get_grid_bounds(state: State<AppState>) -> (u32, u32) {
    let grid = state.grid.read().unwrap();
    (grid.max_row, grid.max_col)
}

/// Get the total number of non-empty cells.
#[tauri::command]
pub fn get_cell_count(state: State<AppState>) -> usize {
    let grid = state.grid.read().unwrap();
    grid.cells.len()
}

/// Get the bounding box (used range) of all stored cells on a sheet.
///
/// `sheet_index` defaults to the active sheet (whose live grid is `state.grid`
/// — `grids[active]` is stale). The algorithm is engine::navigation::used_range,
/// shared with the QuickJS getUsedRange op.
#[tauri::command]
pub fn get_used_range(
    state: State<AppState>,
    sheet_index: Option<usize>,
) -> Result<UsedRangeResult, String> {
    let active_sheet = *state.active_sheet.read().unwrap();
    let target_sheet = sheet_index.unwrap_or(active_sheet);
    let active_grid = state.grid.read().unwrap();
    let grids = state.grids.read().unwrap();
    let grid: &Grid = if target_sheet == active_sheet {
        &active_grid
    } else if target_sheet < grids.len() {
        &grids[target_sheet]
    } else {
        return Err(format!("sheet index out of range: {}", target_sheet));
    };
    Ok(match engine::navigation::used_range(grid) {
        Some((start_row, start_col, end_row, end_col)) => UsedRangeResult {
            start_row,
            start_col,
            end_row,
            end_col,
            empty: false,
        },
        None => UsedRangeResult {
            start_row: 0,
            start_col: 0,
            end_row: 0,
            end_col: 0,
            empty: true,
        },
    })
}

/// Get all non-empty cells in a row range (sparse iteration).
/// Much faster than get_viewport_cells for full-width row reads because
/// it iterates only the sparse cell map instead of every possible coordinate.
#[tauri::command]
pub fn get_cells_in_rows(
    state: State<AppState>,
    start_row: u32,
    end_row: u32,
) -> Vec<CellData> {
    let grid = state.grid.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let protection = state.sheet_protection.read().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();
    // One probe for the whole viewport: formula hiding only bites on a
    // protected sheet, so an unprotected one skips the per-cell check entirely.
    let sheet_protected = {
        // Deref-and-drop: no guard is held across the grid locks above.
        let active = *state.active_sheet.read().unwrap();
        protection.get(&active).map(|p| p.protected).unwrap_or(false)
    };
    let mut cells = Vec::new();

    for &(row, col) in grid.cells.keys() {
        if row >= start_row && row <= end_row {
            if let Some(cell_data) =
                crate::commands::utils::get_cell_internal_with_merge_hiding(
                    &grid, &styles, &merged_regions, row, col, &locale,
                    sheet_protected && styles.get(grid.effective_style_index(row, col)).formula_hidden,
                )
            {
                cells.push(cell_data);
            }
        }
    }

    cells
}

/// Get all non-empty cells in a column range (sparse iteration).
/// Much faster than get_viewport_cells for full-height column reads because
/// it iterates only the sparse cell map instead of every possible coordinate.
#[tauri::command]
pub fn get_cells_in_cols(
    state: State<AppState>,
    start_col: u32,
    end_col: u32,
) -> Vec<CellData> {
    let grid = state.grid.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let protection = state.sheet_protection.read().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();
    // One probe for the whole viewport: formula hiding only bites on a
    // protected sheet, so an unprotected one skips the per-cell check entirely.
    let sheet_protected = {
        // Deref-and-drop: no guard is held across the grid locks above.
        let active = *state.active_sheet.read().unwrap();
        protection.get(&active).map(|p| p.protected).unwrap_or(false)
    };
    let mut cells = Vec::new();

    for &(row, col) in grid.cells.keys() {
        if col >= start_col && col <= end_col {
            if let Some(cell_data) =
                crate::commands::utils::get_cell_internal_with_merge_hiding(
                    &grid, &styles, &merged_regions, row, col, &locale,
                    sheet_protected && styles.get(grid.effective_style_index(row, col)).formula_hidden,
                )
            {
                cells.push(cell_data);
            }
        }
    }

    cells
}

/// Check if any non-empty cells with actual content exist in a range.
/// Returns true as soon as one cell with a value or formula is found.
/// Ignores cells that only have styling but no content.
#[tauri::command]
pub fn has_content_in_range(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> bool {
    let grid = state.grid.read().unwrap();

    grid.cells.iter().any(|(&(row, col), cell)| {
        row >= start_row
            && row <= end_row
            && col >= start_col
            && col <= end_col
            && (cell.has_formula() || !matches!(cell.value, engine::CellValue::Empty))
    })
}

// ============================================================================
// Remove Duplicates
// ============================================================================

/// Remove duplicate rows from a range based on specified key columns.
/// Keeps the first occurrence of each unique combination and removes subsequent matches.
/// Comparison is case-insensitive, value-based (not formatting), and whitespace-sensitive.
#[tauri::command]
pub fn remove_duplicates(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    user_files_state: State<'_, UserFilesState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: RemoveDuplicatesParams,
) -> RemoveDuplicatesResult {
    // LOCKED BUT UNDECIDED. Four exits below change nothing -- no key column,
    // a range cutting a merged block, a header-only range, no duplicates --
    // and `DocumentEffect::mutates` dirties at construction, so minting it
    // here marked the workbook modified for a refusal or a "no duplicates
    // found" (Excel leaves `Workbook.Saved` alone for both). The grid locks are
    // taken PENDING: the gates and the duplicate scan read through them, and
    // the effect is decided once rows are really removed, in the same critical
    // section.
    let pending_grid = state.grid.lock_pending().unwrap();
    let pending_grids = state.grids.lock_pending().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    // `sheet_names` BEFORE `style_registry`. The recalculation pass takes them
    // in that order on a BACKGROUND thread, so taking them the other way round
    // here closes a cycle that hangs the app with no panic and no log line
    // (BUG-0045). Cloned, so nothing is held; the rebuild below reads it.
    let sheet_names_for_rebuild = state.sheet_names.read().unwrap().clone();
    let styles = state.style_registry.read().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // SHEET PROTECTION, over the guards this command HOLDS (rev3B#8): removing
    // duplicates rewrites the whole range. The gate used to run first, through
    // `check_sheet_protection_range`, which takes and RELEASES its own grid,
    // style and protection locks -- so a `protect_sheet` (it takes
    // `sheet_protection` alone) or a cell-lock change landing between that gate
    // and the pending grid locks above let the rows be compacted on a sheet
    // that had just become protected. It now reads the pending grid this
    // command will write, and `sheet_protection` stays held until the rows are
    // written. The kinds (the canvas refusal) are copied first and released;
    // the order is `search.rs`'s held-guard gate's. Reported through the
    // result's `error` field, since this command does not return Result.
    let sheet_kinds = state.sheet_kinds.read().unwrap().clone();
    let protection_storage = state.sheet_protection.read().unwrap();
    if let Err(e) = crate::protection::check_sheet_protection_range_in(
        &sheet_kinds,
        &protection_storage,
        &pending_grid,
        &styles,
        active_sheet,
        params.start_row.min(params.end_row),
        params.start_col.min(params.end_col),
        params.start_row.max(params.end_row),
        params.start_col.max(params.end_col),
    ) {
        return RemoveDuplicatesResult {
            success: false,
            duplicates_removed: 0,
            unique_remaining: 0,
            updated_cells: Vec::new(),
            error: Some(e),
        };
    }

    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    let RemoveDuplicatesParams {
        start_row,
        start_col,
        end_row,
        end_col,
        key_columns,
        has_headers,
    } = params;

    // Validate key_columns
    if key_columns.is_empty() {
        return RemoveDuplicatesResult {
            success: false,
            duplicates_removed: 0,
            unique_remaining: 0,
            updated_cells: vec![],
            error: Some("At least one column must be selected".to_string()),
        };
    }

    // Normalize coordinates
    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    // Check for merged cells in the range
    for region in merged_regions.iter() {
        if region.start_row <= max_row
            && region.end_row >= min_row
            && region.start_col <= max_col
            && region.end_col >= min_col
        {
            let fully_inside = region.start_row >= min_row
                && region.end_row <= max_row
                && region.start_col >= min_col
                && region.end_col <= max_col;
            if !fully_inside {
                return RemoveDuplicatesResult {
                    success: false,
                    duplicates_removed: 0,
                    unique_remaining: 0,
                    updated_cells: vec![],
                    error: Some(
                        "Cannot remove duplicates in a range that partially overlaps with merged cells"
                            .to_string(),
                    ),
                };
            }
        }
    }

    // Determine data start row (skip header if present)
    let data_start_row = if has_headers { min_row + 1 } else { min_row };

    if data_start_row > max_row {
        return RemoveDuplicatesResult {
            success: true,
            duplicates_removed: 0,
            unique_remaining: 0,
            updated_cells: vec![],
            error: None,
        };
    }

    // Collect all data rows with their cell data
    let mut rows: Vec<(u32, Vec<Option<engine::Cell>>)> = Vec::new();
    for row in data_start_row..=max_row {
        let mut row_data: Vec<Option<engine::Cell>> = Vec::new();
        for col in min_col..=max_col {
            row_data.push(pending_grid.get_cell(row, col).cloned());
        }
        rows.push((row, row_data));
    }

    // Build comparison keys and identify unique rows
    // Key = lowercase display values of key columns
    let mut seen: HashSet<Vec<String>> = HashSet::new();
    let mut unique_indices: Vec<usize> = Vec::new();

    for (idx, (_row, row_data)) in rows.iter().enumerate() {
        let key: Vec<String> = key_columns
            .iter()
            .map(|&abs_col| {
                if abs_col < min_col || abs_col > max_col {
                    return String::new();
                }
                let col_offset = (abs_col - min_col) as usize;
                match row_data.get(col_offset) {
                    Some(Some(cell)) => {
                        // Use simple value format (no formatting applied) for comparison
                        // This ensures $10.00 (Currency) matches 10 (General)
                        crate::format_cell_value_simple(&cell.value).to_lowercase()
                    }
                    _ => String::new(), // Empty cells are valid values
                }
            })
            .collect();

        if seen.insert(key) {
            // First occurrence - keep this row
            unique_indices.push(idx);
        }
    }

    let total_rows = rows.len() as u32;
    let unique_count = unique_indices.len() as u32;
    let duplicates_removed = total_rows - unique_count;

    // If no duplicates, return early
    if duplicates_removed == 0 {
        return RemoveDuplicatesResult {
            success: true,
            duplicates_removed: 0,
            unique_remaining: total_rows,
            updated_cells: vec![],
            error: None,
        };
    }

    // Every gate has passed and rows really go: from here this command commits.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = pending_grid.authorize(&effect);
    let mut grids = pending_grids.authorize(&effect);

    // Begin undo transaction
    let owned_txn = undo_stack.begin_owned_transaction(format!(
        "Remove duplicates ({},{}) to ({},{})",
        min_row, min_col, max_row, max_col
    ));

    // Compact: write unique rows back to the top of the data range
    let mut updated_cells = Vec::new();

    for (new_idx, &orig_idx) in unique_indices.iter().enumerate() {
        let target_row = data_start_row + new_idx as u32;
        let row_data = &rows[orig_idx].1;

        for (col_offset, cell_opt) in row_data.iter().enumerate() {
            let target_col = min_col + col_offset as u32;

            // Record undo for the target cell
            let prev_cell = grid.get_cell(target_row, target_col).cloned();
            undo_stack.record_cell_change(active_sheet, target_row, target_col, prev_cell);

            if let Some(cell) = cell_opt {
                grid.set_cell(target_row, target_col, cell.clone());
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(target_row, target_col, cell.clone());
                }

                let style = styles.get(grid.effective_style_index(target_row, target_col));
                let (display, overflow) = crate::format_cell_value_and_class(&cell.value, style, &locale);

                updated_cells.push(CellData {
                    row: target_row,
                    col: target_col,
                    display,
                    overflow,
                    display_color: None,
                    formula: formula_display(&cell, &locale),
                    style_index: grid.effective_style_index(target_row, target_col),
                    row_span: 1,
                    col_span: 1,
                    sheet_index: None,
                    rich_text: None,
                    accounting_layout: None,
                });
            } else {
                grid.clear_cell(target_row, target_col);
                if active_sheet < grids.len() {
                    grids[active_sheet].clear_cell(target_row, target_col);
                }

                updated_cells.push(CellData {
                    row: target_row,
                    col: target_col,
                    display: String::new(),
                    // Empty: nothing to overflow, and text never marks.
                    overflow: crate::api_types::OverflowClass::Text,
                    display_color: None,
                    formula: None,
                    style_index: 0,
                    row_span: 1,
                    col_span: 1,
                    sheet_index: None,
                    rich_text: None,
                    accounting_layout: None,
                });
            }
        }
    }

    // Clear leftover rows at the bottom (rows that were compacted away)
    let first_empty_row = data_start_row + unique_count;
    for row in first_empty_row..=max_row {
        for col in min_col..=max_col {
            let prev_cell = grid.get_cell(row, col).cloned();
            if prev_cell.is_some() {
                undo_stack.record_cell_change(active_sheet, row, col, prev_cell);
                grid.clear_cell(row, col);
                if active_sheet < grids.len() {
                    grids[active_sheet].clear_cell(row, col);
                }
            }

            updated_cells.push(CellData {
                row,
                col,
                display: String::new(),
                // Empty: nothing to overflow, and text never marks.
                overflow: crate::api_types::OverflowClass::Text,
                display_color: None,
                formula: None,
                style_index: 0,
                row_span: 1,
                col_span: 1,
                sheet_index: None,
                rich_text: None,
                accounting_layout: None,
            });
        }
    }

    undo_stack.commit_owned(owned_txn);
    // The rows are written: the protection the gate judged has done its job.
    drop(protection_storage);

    // Formula cells were COMPACTED UPWARDS into new positions, so the
    // dependency maps still describe where they used to live — the same
    // BUG-0010 hazard `sort_range` rebuilds for. Rebuild before seeding, or the
    // cascade below would walk stale edges. (`sheet_names_for_rebuild` was
    // cloned at the top, before `style_registry` — see the note there.)
    // THE BRACES ARE LOAD-BEARING — do not un-nest them.
    //
    // Name tables are acquired HERE, at the call site, like `sheet_names`: the
    // rebuild must expand defined names before extracting cell references, and
    // a caller already holding one of these must not deadlock inside. What that
    // rule also demands, and what this function was missing, is that the guards
    // END HERE. Phase B below calls `recalc_after_active_sheet_bulk_rewrite`,
    // which takes `tables` / `table_names` / `named_ranges` for READ itself.
    // Leaving these guards alive across that call means the same thread asks a
    // writer-preferring `RwLock` for a second read while still holding the
    // first — and any writer that queues in between (a name or table edit from
    // another command) wedges the thread permanently, taking every later
    // command down with it because they all wait behind it.
    //
    // MEASURED, not theorised: `api.removeDuplicates` never returned, the macro
    // that called it never wrote its result, and while it was stuck EVERY other
    // Tauri command timed out — grid reads, `get_sheets`, even
    // `get_calculation_mode`. That is §2u (`vba-idioms-wave4` tests 7 and 8
    // "hanging" for their full 10-minute timeout); the tests were not slow, the
    // backend was wedged. `sort_range`, which owns the same rebuild-then-seed
    // shape, already scopes its guards this way — this one did not.
    //
    // COPIES, not guards (BUG-0592): no name store is held while the rebuild
    // takes the dependency maps. A cell writer (`update_cell_impl`,
    // `update_cells_batch_core`, `fill_range` -- off the main thread for the
    // MCP server, the AI chat and the notebook) takes the dependency maps
    // BEFORE `tables` / `table_names` / `named_ranges`, so holding the name
    // tables across the rebuild was the writers' order inside out. Only the
    // grid locks held above kept it from closing a cycle; a copy closes none
    // whatever else is held. The tables are small next to the grid walk.
    {
        let rebuild_named_ranges = state.named_ranges.read().unwrap().clone();
        let rebuild_tables = state.tables.read().unwrap().clone();
        let rebuild_table_names = state.table_names.read().unwrap().clone();
        crate::undo_commands::rebuild_all_dependencies_from_grid(
            &grid,
            active_sheet,
            &sheet_names_for_rebuild,
            crate::name_resolution::NameTables {
                named_ranges: &rebuild_named_ranges,
                tables: &rebuild_tables,
                table_names: &rebuild_table_names,
                sheet_names: &sheet_names_for_rebuild,
                spill_ranges: &state.spill_ranges,
            },
            &state,
        );
    }

    // PHASE B — dependents (§2c). Remove-duplicates rewrites EVERY cell of its
    // range (compact up, then clear the tail), so every position in the range
    // is a seed. Second lock phase for the usual reason: the recalc needs the
    // dependency maps `rebuild_all_dependencies_from_grid` just held.
    drop(locale);
    drop(merged_regions);
    drop(undo_stack);
    drop(styles);
    drop(grids);
    drop(grid);

    if duplicates_removed > 0 {
        let seeds: Vec<(u32, u32)> = (min_row..=max_row)
            .flat_map(|r| (min_col..=max_col).map(move |c| (r, c)))
            .collect();
        recalc_after_active_sheet_bulk_rewrite(
            &state,
            &user_files_state,
            &pane_control_state,
            &ribbon_filter_state,
            &seeds,
            &mut updated_cells,
        );
    }

    RemoveDuplicatesResult {
        success: true,
        duplicates_removed,
        unique_remaining: unique_count,
        updated_cells,
        error: None,
    }
}

/// Recalculate the dependents of a BULK rewrite of the ACTIVE sheet and cascade
/// the result across sheets, appending every re-evaluated cell to
/// `updated_cells` so the caller's IPC reply repaints them.
///
/// THE BUG THIS CLOSES. `sort_range` permuted every cell of its range and
/// rebuilt the dependency maps, then returned without re-evaluating ANYTHING.
/// A `=B2` beside the range, a `=SUM()` over part of it, or a `Sheet2!`
/// formula reading it all kept their pre-sort values until some unrelated
/// later edit happened to touch them. The off-sheet sibling
/// `sort_range_off_sheet` has always recalculated (through
/// `recalc_after_off_sheet_write`), so sorting a sheet you were NOT looking at
/// produced the right answer while sorting the one in front of you did not.
///
/// Same shape as the dependent cascade in `update_cells_batch_core` —
/// `recalc_order_from_seeds` over the active sheet's map, whole-column/row
/// dependents appended, `reevaluate_formula_cell` per cell, then the ONE shared
/// `cascade_cross_sheet_dependents` walk. It REUSES those helpers rather than
/// copying them: hand-copying that walk is precisely what BUG-0019 was, and
/// `every_cascade_path_uses_the_shared_cross_sheet_walk` fails if a copy
/// reappears.
///
/// Seeds are MEMBERS of the ordering (`include_seeds: true`), and that is
/// load-bearing for both callers:
///
/// - a sorted block routinely contains formulas reading other cells of the same
///   block, and after a permutation those must be re-evaluated in dependency
///   order too;
/// - an undo/redo restore hands back cells whose CACHED values can be stale for
///   a reason peculiar to transactions — see `apply_changes`.
///
/// Re-evaluating a seed is never destructive: the loop below skips any seed
/// with no formula, so a restored or moved LITERAL keeps exactly the value the
/// caller wrote. Only DERIVED cells are re-derived, from precedents the caller
/// has already finished writing.
///
/// No UDF resolver and no cube prefetch are supplied. That is safe rather than
/// lossy because `preserved_udf_value` / `preserved_cube_value` answer each
/// call from the sheet's results cache instead of collapsing to #NAME? / #N/A
/// -- for a call whose arguments the rewrite left as they were (or moved back
/// to ones already answered); one whose arguments it changed to ones never
/// answered is refused, never shown with the old arguments' answer (see their
/// doc comments).
///
/// LOCKING: acquires everything itself, in the canonical order (control stores
/// and user files first, then `sheet_names` -> `grid` -> `grids` ->
/// `active_sheet` -> `style_registry` -> dependency maps -> `calculation_mode`
/// -> `merged_regions` -> `locale`), so the caller must hold NONE of them.
/// `sort_range` therefore runs it as a separate phase after dropping its own
/// guards: `rebuild_all_dependencies_from_grid` takes the same dependency maps
/// and std mutexes are not reentrant.
pub(crate) fn recalc_after_active_sheet_bulk_rewrite(
    state: &AppState,
    user_files_state: &UserFilesState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    seeds: &[(u32, u32)],
    updated_cells: &mut Vec<CellData>,
) {
    if seeds.is_empty() {
        return;
    }

    // Control snapshot BEFORE the grid locks -- it takes control stores and
    // releases them, so it holds nothing when the grid locks are taken. USER
    // FILES are locked AFTER them: the canonical order is grid, grids, then
    // everything else, and the recalculation pass takes `files` on a background
    // thread only once it holds both.
    let control_values = crate::control_values::build_control_values(
        state,
        pane_control_state,
        ribbon_filter_state,
    );

    // SUBTOTAL/AGGREGATE ROW-VISIBILITY SNAPSHOT, built BEFORE any grid lock and
    // held for the whole pass — the same guard `update_cell_impl` and
    // `recalculate_sheet_values` install, and the reason they agree with each
    // other about what is hidden.
    //
    // THIS ENTRY POINT WAS MISSING IT, and the omission did not merely leave a
    // value stale, it WROTE A WRONG ONE. With no guard installed
    // `row_visibility::active()` is None and the visibility-aware aggregates
    // "behave as if nothing is hidden" (row_visibility.rs), so every cell this
    // cascade re-evaluated was computed against a workbook with nothing hidden.
    // Found in the D8 integration pass, by probe rather than by reading: hide a
    // row, settle `=SUBTOTAL(109;A1:A5)` at the correct 130, insert a row, and
    // this cascade re-evaluated it to 150 — it OVERWROTE a right answer with a
    // wrong one, and saved it that way. Every caller was affected (`sort_range`,
    // `relocate_cell_references`, D3's eight); D8 made it common by adding the
    // four structural edits, which is how it finally showed up.
    //
    // The sibling `recalc_after_off_sheet_write` never had the bug: it delegates
    // to `recalculate_sheet_values`, which installs the guard itself.
    let _visibility_pass = crate::row_visibility::begin_pass(state);

    // RECALC COMPANION. This pass re-derives cell VALUES from inputs that are
    // themselves persisted (formulas, literals, locale, control values), so it
    // must not dirty on its own account: the ENTRY command that made those
    // values stale already owns the flag, and dirtying here would make a
    // workbook holding NOW()/RAND() prompt to save merely for being looked at.
    // See CleanReason::RecalcCompanion.
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::RecalcCompanion,
    );
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    // A caller that decided "these seeds are on the active sheet" BEFORE this
    // took the grid locks (a what-if trial, `cascade_whatever_the_mode`) names
    // that sheet by stable id: a sheet switch in between would otherwise make
    // the seeds' coordinates address another sheet. Checked under the grid
    // locks (a switch takes them), in the canonical order grid, grids,
    // sheet_ids, active_sheet; each read guard is dropped at once.
    if let Some(expected) = CASCADE_EXPECTS_ACTIVE.with(|f| f.get()) {
        let active_id = {
            let sheet_ids = state.sheet_ids.read().unwrap();
            let active = *state.active_sheet.read().unwrap();
            sheet_ids.get(active).copied()
        };
        if active_id != Some(expected) {
            CASCADE_SAW_ANOTHER_SHEET.with(|f| f.set(true));
            return;
        }
    }
    let sheet_names = state.sheet_names.read().unwrap();
    let user_files = user_files_state.files.lock().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let dependents_map = state.dependents.lock().unwrap();
    let column_dependents_map = state.column_dependents.lock().unwrap();
    let row_dependents_map = state.row_dependents.lock().unwrap();
    let cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let calc_mode = state.calculation_mode.lock().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    // ---- SPILL TEAR-DOWN, THE CHOKE POINT (§2y) --------------------------
    //
    // A spill lives only as long as the FORMULA that produced it. Every path
    // that removes or overwrites a spill ORIGIN used to have to remember to
    // tear the map down itself, and only `update_cell` ever did — so the Delete
    // key (`clear_range`), Clear Contents, a sort that moved the origin, an
    // undo that cleared it and the redo that cleared it again all left
    // `spill_ranges` claiming cells no formula produces. Those cells then
    // refused every edit AND every delete, naming a source cell that was
    // already empty, and saved as orphan literals (§2y).
    //
    // Rather than another list of commands to remember, the removal happens
    // HERE, where every one of them already ends up: a seed that no longer
    // holds a formula cannot own a spill, so whatever it owned is released and
    // erased. Seeds that DO hold a formula are handled downstream by
    // `reevaluate_formula_cell`, which tears the old range down and re-spills
    // the new one — the two halves together cover "the origin went away" and
    // "the origin changed", which is the whole of the maintenance problem.
    //
    // It runs BEFORE the manual-calculation return, deliberately. Manual mode
    // means the user accepted STALE VALUES; it never meant a map that claims
    // cells for a formula that is gone, which is corruption rather than
    // staleness and cannot be resolved by pressing F9.
    //
    // COST on the Delete key, which is the hottest path in the suite: one
    // `spill_ranges` lock and one `is_empty()` when the workbook has no dynamic
    // array (`take_spills_owned_by_any` returns before it looks at anything
    // else). The seed set is only projected into a `CoordSet` once that check
    // has already found something to release — so a 10,000-cell remove-
    // duplicates seed list is never hashed for nothing.
    {
        let has_spills = !state.spill_ranges.read().unwrap().is_empty();
        if has_spills {
            let vacated: crate::CoordSet = seeds
                .iter()
                .copied()
                .filter(|&(r, c)| {
                    grid.get_cell(r, c)
                        .is_none_or(|cell| cell.formula_string().is_none())
                })
                .collect();
            let released = take_spills_owned_by_any(state, active_sheet, &vacated);
            erase_released_spill_cells(
                &mut grid,
                &mut grids,
                active_sheet,
                active_sheet,
                &released,
                updated_cells,
            );
        }
    }

    // Manual calculation mode: the user asked for stale values until F9 --
    // and the workbook says so (Excel's xlPending, the status bar's
    // "Calculate"). A what-if TRIAL that reads its result back runs this same
    // seeded cascade whatever the mode (`cascade_whatever_the_mode`).
    if *calc_mode != "automatic" && !CASCADE_WHATEVER_THE_MODE.with(|f| f.get()) {
        note_manual_write_left_formulas_uncalculated(
            &grid,
            seeds,
            sheet_names.get(active_sheet).map(String::as_str).unwrap_or(""),
            &dependents_map,
            &column_dependents_map,
            &row_dependents_map,
            &cross_sheet_dependents_map,
        );
        return;
    }

    let tables = state.tables.read().unwrap();
    let table_names = state.table_names.read().unwrap();
    let named_ranges = state.named_ranges.read().unwrap();

    let merge_lookup: std::collections::HashMap<(u32, u32), &MergedRegion> = merged_regions
        .iter()
        .map(|r| ((r.start_row, r.start_col), r))
        .collect();

    // COST GATE (D3). A pivot block is 10k+ cells and every one of them is a
    // LITERAL, so passing the raw block as seeds made the walk itself the
    // expensive part: `recalc_order_from_seeds` admitted all 12,500 as members
    // and the loop below cloned each one only to discover it had no formula.
    // Measured at 500x25: 54.19ms, against 22.75ms for the whole-sheet pass the
    // pivot module already runs on every other mutation — i.e. seeding was
    // WORSE than the thing it replaces, which is what the D3 cost question was
    // actually about.
    //
    // A seed that holds no formula AND has no dependents provably contributes
    // nothing: it would be admitted as a member, skipped by the evaluation loop
    // for having no formula, and expanded from to nothing. Dropping those here
    // is behaviour-preserving and makes the cost proportional to the number of
    // READERS instead of the size of the block.
    //
    //
    // The cross-sheet walk is included in the SAME filter rather than being
    // handed the raw list, because it pays a String CLONE per root: seeding it
    // with 12,500 literals allocated 12,500 sheet names to discover that none
    // of them had an off-sheet reader. Its keys carry the sheet name, so the
    // active sheet's entries are projected down to coordinates once here.
    let active_sheet_name = sheet_names.get(active_sheet).cloned().unwrap_or_default();
    let cross_sheet_read_on_active: crate::CoordSet = cross_sheet_dependents_map
        .keys()
        .filter(|(name, _, _)| *name == active_sheet_name)
        .map(|(_, r, c)| (*r, *c))
        .collect();

    let live_seeds: Vec<(u32, u32)> = seeds
        .iter()
        .copied()
        .filter(|&(r, c)| {
            dependents_map.contains_key(&(r, c))
                || column_dependents_map.contains_key(&c)
                || row_dependents_map.contains_key(&r)
                || cross_sheet_read_on_active.contains(&(r, c))
                || grid
                    .get_cell(r, c)
                    .is_some_and(|cell| cell.formula_string().is_some())
        })
        .collect();

    let mut recalc_order = crate::recalc_order_from_seeds(&live_seeds, &dependents_map, true);
    let mut recalc_set: crate::CoordSet = recalc_order.iter().copied().collect();
    for &seed in &live_seeds {
        for dep in get_column_row_dependents(seed, &column_dependents_map, &row_dependents_map) {
            if recalc_set.insert(dep) {
                recalc_order.push(dep);
            }
        }
    }

    // PERF-20: skip per-dependent formula render + IPC payload for wide cascades.
    let include_cascade_formulas = recalc_order.len() <= CASCADE_FORMULA_LIMIT;
    let mut cache_hits: u32 = 0;
    let mut cache_misses: u32 = 0;

    for &(dep_row, dep_col) in &recalc_order {
        let Some(dep_cell) = grid.get_cell(dep_row, dep_col).cloned() else {
            continue;
        };
        let Some(formula) = dep_cell.formula_string() else {
            continue;
        };
        reevaluate_formula_cell(
            state,
            &mut grid,
            &mut grids,
            &sheet_names,
            active_sheet,
            dep_row,
            dep_col,
            &dep_cell,
            &formula,
            &user_files,
            None,
            None,
            Some(&control_values),
            &styles,
            &locale,
            &merge_lookup,
            &tables,
            &table_names,
            &named_ranges,
            updated_cells,
            &mut cache_hits,
            &mut cache_misses,
            include_cascade_formulas,
        );
    }

    cascade_cross_sheet_dependents(
        state,
        &mut grid,
        &mut grids,
        &sheet_names,
        active_sheet,
        &cross_sheet_dependents_map,
        &user_files,
        &control_values,
        &styles,
        &locale,
        &merge_lookup,
        crate::name_resolution::NameTables {
            named_ranges: &named_ranges,
            tables: &tables,
            table_names: &table_names,
            sheet_names: &sheet_names,
            spill_ranges: &state.spill_ranges,
        },
        &live_seeds,
        &recalc_order,
        updated_cells,
        include_cascade_formulas,
    );
}

thread_local! {
    /// Set only for the duration of [`cascade_whatever_the_mode`].
    static CASCADE_WHATEVER_THE_MODE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// The sheet [`cascade_whatever_the_mode`]'s caller expects to be ACTIVE,
    /// set only for the duration of that call.
    static CASCADE_EXPECTS_ACTIVE: std::cell::Cell<Option<identity::SheetId>> = const { std::cell::Cell::new(None) };
    /// Raised when the cascade found another sheet active and did nothing.
    static CASCADE_SAW_ANOTHER_SHEET: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// [`recalc_after_active_sheet_bulk_rewrite`] run as automatic calculation
/// would run it, even under MANUAL calculation: the seeded dependents cascade,
/// proportional to the cells that read the seeds. For a what-if TRIAL (a Goal
/// Seek or Solver step, a data-table substitution, an animation frame) that
/// reads its result back: it used to get two whole-sheet passes over the active
/// sheet and every sheet reading it under manual calculation, per trial
/// (`whatif_recalc`). Cells that do not depend on the seeds are not touched, so
/// a value the user left stale for F9 stays exactly as it was.
///
/// `expected_active` is the sheet the seeds are on, by stable id: the caller
/// decided it was the active sheet under ITS locks and dropped them, and a
/// sheet switch in between would make the seeds address another sheet. The
/// cascade checks it again under the grid locks and, when another sheet is
/// active, does NOTHING and answers `false` -- the caller then recalculates the
/// seeds' sheet as the background sheet it has become. `true` otherwise.
pub(crate) fn cascade_whatever_the_mode(
    state: &AppState,
    user_files_state: &UserFilesState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    expected_active: Option<identity::SheetId>,
    seeds: &[(u32, u32)],
    updated_cells: &mut Vec<CellData>,
) -> bool {
    struct Reset(bool, Option<identity::SheetId>);
    impl Drop for Reset {
        fn drop(&mut self) {
            let previous = self.0;
            let expected = self.1;
            CASCADE_WHATEVER_THE_MODE.with(|f| f.set(previous));
            CASCADE_EXPECTS_ACTIVE.with(|f| f.set(expected));
        }
    }
    let _reset = Reset(
        CASCADE_WHATEVER_THE_MODE.with(|f| f.replace(true)),
        CASCADE_EXPECTS_ACTIVE.with(|f| f.replace(expected_active)),
    );
    CASCADE_SAW_ANOTHER_SHEET.with(|f| f.set(false));
    recalc_after_active_sheet_bulk_rewrite(
        state,
        user_files_state,
        pane_control_state,
        ribbon_filter_state,
        seeds,
        updated_cells,
    );
    !CASCADE_SAW_ANOTHER_SHEET.with(|f| f.replace(false))
}

/// THE SEEDED CASCADE ROOTED ON ANY SHEET, the active one or not: `seeds` (just
/// written on the sheet `resolve` names) and the cells that read them -- on that
/// sheet, in its own topological order, and on every other sheet through the
/// shared cross-sheet walk -- and NOTHING else, whatever the calculation mode.
///
/// [`cascade_whatever_the_mode`] can only root its walk at the ACTIVE sheet,
/// because its same-sheet half is the active sheet's dependency map. A what-if
/// trial whose sheet is a background sheet (or stopped being the active one
/// while the trial's locks were dropped) used to fall back to
/// [`recalc_after_off_sheet_write`]: two whole-sheet passes over that sheet,
/// every sheet reading it and the active sheet. Under MANUAL calculation that
/// freshened every value the user had left stale for F9, on all of them. This
/// is the far-side step of [`cascade_cross_sheet_dependents`] taken from the
/// seeds' own sheet: [`SheetDependencyIndex`] for the sheet's own graph and
/// [`recalc_walked_cell`] per dependent, then the walk rooted there.
///
/// `resolve` runs under the grid locks (canonical order: grid, grids, then the
/// `sheet_ids` it reads), so the index is where the sheet is at that moment.
/// Returns that index, or `None` -- nothing evaluated -- when the sheet is gone.
///
/// LOCKING: takes everything itself, in the order
/// [`recalc_after_active_sheet_bulk_rewrite`] does; the caller holds NONE.
/// Spill claims of an origin the write replaced are the caller's to release
/// (`release_spills_orphaned_by_grid`), as for the whole-sheet fallback.
pub(crate) fn cascade_seeded_on_sheet(
    state: &AppState,
    user_files_state: &UserFilesState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    resolve: &dyn Fn() -> Option<usize>,
    seeds: &[(u32, u32)],
    updated_cells: &mut Vec<CellData>,
) -> Option<usize> {
    // Before any grid lock, as in `recalc_after_active_sheet_bulk_rewrite`.
    let control_values = crate::control_values::build_control_values(
        state,
        pane_control_state,
        ribbon_filter_state,
    );
    let _visibility_pass = crate::row_visibility::begin_pass(state);
    // RECALC COMPANION: re-derives values from persisted inputs; the trial's own
    // effect already decided the flag.
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::RecalcCompanion,
    );
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let root = resolve()?;
    if root >= grids.len() {
        return None;
    }
    if seeds.is_empty() {
        return Some(root);
    }
    let sheet_names = state.sheet_names.read().unwrap();
    let user_files = user_files_state.files.lock().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();
    let tables = state.tables.read().unwrap();
    let table_names = state.table_names.read().unwrap();
    let named_ranges = state.named_ranges.read().unwrap();

    let merge_lookup: std::collections::HashMap<(u32, u32), &MergedRegion> = merged_regions
        .iter()
        .map(|r| ((r.start_row, r.start_col), r))
        .collect();
    let name_tables = crate::name_resolution::NameTables {
        named_ranges: &named_ranges,
        tables: &tables,
        table_names: &table_names,
        sheet_names: &sheet_names,
        spill_ranges: &state.spill_ranges,
    };

    // The seeds' own sheet: its graph, not the active sheet's map.
    let order = SheetDependencyIndex::build(&grids[root], root, name_tables).recalc_order(seeds);
    let include_formulas = order.len() <= CASCADE_FORMULA_LIMIT;
    let mut recalced: Vec<(u32, u32)> = Vec::new();
    for &(row, col) in &order {
        // A seed that holds no literal formula is skipped (`false`): the value
        // the caller wrote stays exactly as written.
        if recalc_walked_cell(
            state,
            &mut grid,
            &mut grids,
            &sheet_names,
            active_sheet,
            root,
            row,
            col,
            &user_files,
            &control_values,
            &styles,
            &locale,
            &merge_lookup,
            name_tables,
            updated_cells,
            include_formulas,
        ) {
            recalced.push((row, col));
        }
    }

    // Every other sheet: the ONE shared walk, rooted at the seeds' sheet.
    cascade_cross_sheet_dependents_from(
        state,
        &mut grid,
        &mut grids,
        &sheet_names,
        active_sheet,
        root,
        &cross_sheet_dependents_map,
        &user_files,
        &control_values,
        &styles,
        &locale,
        &merge_lookup,
        name_tables,
        seeds,
        &recalced,
        updated_cells,
        include_formulas,
    );
    Some(root)
}

/// Recalculate every sheet a cross-sheet write touched, plus the active sheet.
///
/// THE BUG THIS CLOSES (found live, vba-idioms-wave1.spec.ts): a script's
/// off-sheet write went through `update_cell_on_sheets`, which stored the cell
/// and returned — no dependency propagation at all. A formula NEXT TO the
/// written cell (`=R61*2` beside a `range("Sheet1!R61").setValue(42)`) kept its
/// stale value indefinitely, because that command was built for sheet-grouping
/// replication and nothing downstream ever recalculated. The QuickJS script
/// surface already solved this (scripting/commands.rs): evaluate each written
/// sheet, then the active sheet, TWICE — the second pass propagates one more
/// cross-sheet hop. Same pattern here, shared by the write command below and
/// the `recalculate_sheets_after_script_write` command the bulk path calls once
/// after its per-cell writes.
///
/// Callers must hold NO AppState locks — `recalculate_sheet_values` takes its
/// own.
pub(crate) fn recalc_after_off_sheet_write(
    state: &AppState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    sheet_indices: &[usize],
) {
    let active_sheet = *state.active_sheet.read().unwrap();
    // OBJECT-BACKED SHEETS (floating range cell stores) join every off-sheet
    // recalc pass. They are never the active sheet and never in a caller's
    // touched list unless written directly — but their formulas read the
    // sheets this pass is re-evaluating, and no sheet VISIT ever heals them
    // (a backing sheet cannot be activated, so the lazy rebuild-on-switch
    // that repairs ordinary sheets never runs for them). Their grids are
    // window-sized, so the extra evaluations are cheap.
    let object_sheets: Vec<usize> = {
        let visibility = state.sheet_visibility.read().unwrap();
        (0..visibility.len())
            .filter(|&i| !crate::sheets::is_user_sheet(&visibility, i))
            .filter(|i| !sheet_indices.contains(i))
            .collect()
    };
    // BUG-0058: sheets holding CROSS-SHEET DEPENDENTS of anything on the
    // written (or object) sheets. This pass re-evaluated the written sheets,
    // the object sheets and the ACTIVE sheet — and no other user sheet, so a
    // formula on a sheet the user was not looking at that read a floating
    // range (or any off-sheet-written cell) stayed stale until F9 or a visit.
    // Found by the first mixed floating+sheet soak walk: the dependent on the
    // ACTIVE sheet updated while its twin on a non-active sheet held its old
    // value. The closure is TRANSITIVE (a repaired dependent can feed a
    // formula on yet another sheet), computed to a fixpoint over sheet NAMES
    // — the dependents map is keyed by the workbook's official spelling.
    //
    // LOCKS ARE STRICTLY SEQUENTIAL here (snapshot, drop, lock, drop): this
    // function's callers hold nothing, and taking `sheet_names` and the
    // dependents map one after the other — never nested — contributes no
    // ordering edge to the crate's lock graph.
    let dependent_sheets: Vec<usize> = {
        let sheet_names_snapshot: Vec<String> = state.sheet_names.read().unwrap().clone();
        let dependents = state.cross_sheet_dependents.lock().unwrap();
        let mut in_set: std::collections::BTreeSet<usize> = sheet_indices
            .iter()
            .copied()
            .chain(object_sheets.iter().copied())
            .collect();
        loop {
            let names_in_set: std::collections::HashSet<&str> = in_set
                .iter()
                .filter_map(|&i| sheet_names_snapshot.get(i).map(|s| s.as_str()))
                .collect();
            let mut grew = false;
            for ((precedent_name, _r, _c), deps) in dependents.iter() {
                if names_in_set.contains(precedent_name.as_str()) {
                    for &(dep_sheet, _dr, _dc) in deps.iter() {
                        if dep_sheet < sheet_names_snapshot.len() && in_set.insert(dep_sheet) {
                            grew = true;
                        }
                    }
                }
            }
            if !grew {
                break;
            }
        }
        in_set
            .into_iter()
            .filter(|i| {
                !sheet_indices.contains(i) && !object_sheets.contains(i) && *i != active_sheet
            })
            .collect()
    };
    // Cross-sheet cycle detection is memoised for this whole scope: the loop
    // below calls `recalculate_sheet_values` 2*(sheets+1) times and the answer
    // is a function of the ASTs, which recalculation never changes. Without
    // this the workbook-level graph would be rebuilt on every one of those
    // calls. See calculation.rs `begin_circular_pass`.
    let _circular_pass = crate::calculation::begin_circular_pass();
    for _pass in 0..2 {
        for &idx in sheet_indices
            .iter()
            .chain(object_sheets.iter())
            .chain(dependent_sheets.iter())
        {
            if idx == active_sheet {
                continue;
            }
            crate::calculation::recalculate_sheet_values(
                state,
                user_files_state,
                pivot_state,
                idx,
                Some((pane_control_state, ribbon_filter_state)),
            );
        }
        crate::calculation::recalculate_sheet_values(
            state,
            user_files_state,
            pivot_state,
            active_sheet,
            Some((pane_control_state, ribbon_filter_state)),
        );
    }
}

/// Replace the registered cross-sheet edges of ONE off-sheet cell (GAP A).
/// Locks the two maps in the canonical order (`dependents` then
/// `dependencies` — the `rebuild_all_dependencies_from_grid` order); callers
/// may hold grid locks (the maps come after them crate-wide) but not these.
fn register_off_sheet_cell_edges(
    state: &AppState,
    sheet_idx: usize,
    row: u32,
    col: u32,
    new_refs: rustc_hash::FxHashSet<(String, u32, u32)>,
) {
    let mut dependents = state.cross_sheet_dependents.lock().unwrap();
    let mut dependencies = state.cross_sheet_dependencies.lock().unwrap();
    crate::update_cross_sheet_dependencies(
        (sheet_idx, row, col),
        new_refs,
        &mut dependencies,
        &mut dependents,
    );
}

/// The recalc half of `update_cell_on_sheets`, callable on its own: the script
/// host's BULK off-sheet write loops `update_cell_on_sheets` per cell with
/// `recalc: false` (a full sheet evaluation per cell would be quadratic), then
/// invokes this ONCE for the whole block.
#[tauri::command]
pub fn recalculate_sheets_after_script_write(
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    sheet_indices: Vec<usize>,
) -> Result<(), String> {
    recalc_after_off_sheet_write(
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &sheet_indices,
    );
    Ok(())
}

/// Replicate a cell value update to multiple non-active sheets.
/// Used for sheet grouping (a value entered on the active sheet is replicated
/// to grouped sheets) AND as the script host's off-sheet single-cell write.
/// Handles literals directly and formulas by evaluating in each sheet's context.
///
/// After the write, dependent formulas are recalculated (written sheets + the
/// active sheet — see `recalc_after_off_sheet_write`) unless `recalc` is
/// `Some(false)`, which the bulk script path uses to batch one recalc per block.
///
/// RETURNS THE SHEETS IT ACTUALLY WROTE. The ACTIVE sheet is skipped: for the
/// sheet-GROUPING caller that is correct (the active sheet was already written
/// by `update_cell`), but a SCRIPT's off-sheet write has no such prior write —
/// so a skip there silently DROPS the value. That is not hypothetical: the
/// script host decides "this is off-sheet" from a `get_sheets` snapshot, and if
/// the active sheet changes before this command runs (a macro writing sheet A
/// while the user — or the macro itself — switches to sheet A) the write
/// vanished with no error anywhere. Caught live by vba-idioms-wave1.spec.ts.
/// Reporting the skip lets the host re-issue it through the active-sheet path
/// instead of losing it.
///
/// `cube_results` (BUG-0476): one cube pre-fetch PER TARGET SHEET, aligned
/// with `sheet_indices` (`cube_results[i]` serves `sheet_indices[i]`), each
/// resolved by `cube_prefetch` with `edits` and that `sheet_index` -- a cube
/// argument naming a cell reads THAT sheet's cell. The frontend sends it only
/// when `value` is a CUBE formula; a list of another length serves nothing.
#[tauri::command]
pub fn update_cell_on_sheets(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    sheet_indices: Vec<usize>,
    row: u32,
    col: u32,
    value: String,
    invariant: Option<bool>,
    recalc: Option<bool>,
    cube_results: Option<Vec<engine::CubePrefetch>>,
) -> Result<Vec<usize>, String> {
    update_cell_on_sheets_inner(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        sheet_indices,
        row,
        col,
        value,
        invariant,
        recalc,
        cube_results,
    )
}

/// Command body over plain references (the `hide_sheet_inner` split):
/// `update_floating_range_cell` writes a floating range's cells through this
/// exact path — the same protection/writeback/spill gates, the same GAP-A edge
/// registration, the same off-sheet recalc — because a backing sheet IS a
/// non-active sheet and a second write path would drift.
///
/// A CUBE formula is evaluated with its sheet's entry of `cube_results` (see
/// `update_cell_on_sheets`); the off-sheet recalculation that follows has no
/// cube data, and answers the call with what this write served (the results
/// cache, `engine::cube::CallMemo`, records every served call).
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_cell_on_sheets_inner(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    sheet_indices: Vec<usize>,
    row: u32,
    col: u32,
    value: String,
    invariant: Option<bool>,
    recalc: Option<bool>,
    cube_results: Option<Vec<engine::CubePrefetch>>,
) -> Result<Vec<usize>, String> {
    update_cell_on_sheets_as(
        state,
        file_state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        sheet_indices,
        row,
        col,
        value,
        invariant,
        recalc,
        cube_results,
        false,
    )
}

/// [`update_cell_on_sheets_inner`], told whether the write is a PASTE
/// (`CellUpdateInput::pasted`): a paste is not an entry, so a Text-formatted
/// (`@`) destination does not turn a pasted formula or number into text. The
/// one caller that pastes is a floating grid's batch
/// (`cell_target::update_cells_batch_on_target`); every typed or scripted write
/// goes through the wrapper above with `pasted = false`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_cell_on_sheets_as(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    sheet_indices: Vec<usize>,
    row: u32,
    col: u32,
    value: String,
    invariant: Option<bool>,
    recalc: Option<bool>,
    cube_results: Option<Vec<engine::CubePrefetch>>,
    pasted: bool,
) -> Result<Vec<usize>, String> {
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Interactive,
        &state.calc_cancel,
    );
    // Each target sheet's cube data, by sheet. Aligned positionally with
    // `sheet_indices`; a misaligned list is not guessed at.
    let cube_by_sheet: std::collections::HashMap<usize, std::sync::Arc<engine::CubePrefetch>> =
        match cube_results {
            Some(list) if list.len() == sheet_indices.len() => sheet_indices
                .iter()
                .copied()
                .zip(list.into_iter().map(std::sync::Arc::new))
                .collect(),
            _ => std::collections::HashMap::new(),
        };
    // Sheet protection on EVERY targeted sheet, before any other lock is taken.
    // Group edit is refused outright if any one sheet protects the cell — the
    // alternative (writing the sheets that allow it) would silently produce a
    // group edit that did not apply to the whole group.
    for &sheet_idx in &sheet_indices {
        crate::protection::check_sheet_protection_cells(
            &state,
            sheet_idx,
            std::iter::once((row, col)),
        )?;
    }

    // WRITEBACK ANTI-BYPASS, off-sheet half. The active-sheet guard in
    // `update_cell_impl` cannot see these sheets, and the writeback index is
    // keyed by SheetId — so every targeted sheet is asked individually. Refused
    // for the whole group (like protection above): a partial group edit is
    // exactly the silent divergence this guard exists to prevent.
    crate::calp_commands::ensure_writeback_draft_before_write_on_sheets(
        &state,
        &sheet_indices,
        row,
        col,
    )?;

    // SPILL PROTECTION, off-sheet half (§2y). The active twin
    // (`update_cell_impl`) has always refused to overwrite a spilled value; this
    // command reached the same cells with no check at all, so a script's
    // `range("Sheet2!A2").setValue(...)` could scribble over an array Sheet2
    // owns. Refused for the whole group, like protection and writeback above.
    {
        let spill_hosts = state.spill_hosts.lock().unwrap();
        for &sheet_idx in &sheet_indices {
            check_spill_protection(
                &spill_hosts, sheet_idx, row, col, row, col,
                SpillOriginPolicy::Refuse,
            )?;
        }
    }

    // Every AppState lock is scoped to this block: `recalc_after_off_sheet_write`
    // below takes its own locks and would deadlock against these.
    // Every gate above has passed; the group write below commits. This command
    // took NO `FileState` before `grids` became a `Persisted<T>`: writing the same
    // value across several sheets left the document looking unmodified.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let wrote: Vec<usize> = {
        // CANONICAL LOCK ORDER: `grids` first, then everything else.
        let mut grids = state.grids.write(&effect).unwrap();
        let locale = state.locale.lock().unwrap();
        let user_files = user_files_state.files.lock().unwrap();
        let sheet_names = state.sheet_names.read().unwrap();
        // READ-ONLY, and in the same position the canonical order gives it in
        // `update_cell_impl` (grids, sheet_names, user_files, then styles). Only
        // the Text-format decision below needs it: a group edit has one typed
        // string and N destinations, and the format that decides the VALUE is a
        // property of each destination.
        let styles = state.style_registry.read().unwrap();
        let active_sheet = *state.active_sheet.read().unwrap();

        // THE ENTERED VALUE, PARSED AND RESTAMPED BEFORE THE UNDO STACK IS
        // TAKEN (rev5C#1, BUG-0592). The restamp below reads `named_ranges`,
        // `tables` and `table_names`, and it used to run with the undo stack
        // already held. This function holds `grids` but never `grid`, so
        // nothing ordered it against a name writer -- `create_named_range_impl`
        // and its siblings, which the MCP server runs on its own thread, hold
        // the registry while they record their undo step. An AI defining a
        // name while the user typed a formula into a floating grid (or a
        // grouped sheet replicated an entry, or a script wrote another sheet)
        // left each thread holding what the other waited for: the window froze
        // and unsaved work was lost. The name stores are now released before
        // the stack is taken, so this function never holds the undo stack
        // while it takes one
        // (`no_function_holds_the_undo_stack_and_a_name_store_in_an_order_that_can_cycle`).
        // `None` for an empty value, which CLEARS the cell below.
        let entered: Option<engine::Cell> = if value.trim().is_empty() {
            None
        } else {
            // Parse the input (same logic as update_cell). When invariant=true the
            // value is a script's TYPED write in canonical US form ("42.5", "TRUE");
            // delocalizing it against the workbook locale would corrupt it (sv-SE
            // reads "42.5" as 425), so it takes the invariant parse — the same split
            // update_cells_batch makes.
            let mut cell_template = if invariant.unwrap_or(false) {
                parse_cell_input_invariant(&value, &locale)
            } else {
                parse_cell_input(&value, &locale)
            };

            // THE WORKBOOK'S OWN CAPITALISATION, on this door too (§2ai / §2t).
            // The lexer shouts bare identifiers, so `=Sheet1!E2` parses as
            // `SHEET1!E2`; the active-sheet door restamps names, tables and sheet
            // qualifiers in `split_entered_formula`, and this one never did -- so
            // every off-sheet write (a floating grid's cells, a script writing
            // another sheet, a grouped-sheet edit) stored and showed
            // `=SHEET1!E2`. Cosmetic for evaluation (every lookup uppercases);
            // it is what the formula bar shows.
            if let Some(ast) = cell_template.ast.as_deref_mut() {
                {
                    let named_ranges_map = state.named_ranges.read().unwrap();
                    crate::name_resolution::restamp_name_casing(ast, &named_ranges_map);
                }
                if crate::ast_has_table_refs(ast) {
                    let tables_map = state.tables.read().unwrap();
                    let table_names_map = state.table_names.read().unwrap();
                    crate::table_deps::restamp_table_casing(ast, &tables_map, &table_names_map);
                }
                crate::sheet_names::restamp_sheet_casing(ast, &sheet_names);
            }
            Some(cell_template)
        };

        let mut undo_stack = state.undo_stack.lock().unwrap();
        let mut wrote: Vec<usize> = Vec::new();

        // ONE UNDO ENTRY FOR THE WHOLE WRITE, AND NEVER SOMEONE ELSE'S.
        //
        // This used to open and commit a transaction around EACH sheet, with
        // no nesting guard — the guard every other mutator in this file takes
        // (see `update_cells_batch` and the fill command). Two things followed.
        // Called on its own, a group write left one undo entry per sheet, so
        // undoing a single user action took N presses. Called INSIDE a caller's
        // transaction — a script's `withScriptUndoBatch`, a form submit writing
        // several bound cells — it was worse than that: `begin_transaction` is
        // a no-op while one is open, but `commit_transaction` is not, so the
        // FIRST off-sheet cell PUSHED THE CALLER'S STILL-OPEN TRANSACTION to
        // the stack early, and everything the caller wrote after that landed in
        // entries of its own.
        let opened_transaction = !undo_stack.has_open_transaction();
        if opened_transaction {
            undo_stack.begin_transaction(if value.trim().is_empty() {
                format!("Clear cell on {} sheet(s)", sheet_indices.len())
            } else {
                format!("Update cell on {} sheet(s)", sheet_indices.len())
            });
        }

        // SPILL TEAR-DOWN, off-sheet single-cell half (§2y). Whether the cell
        // is cleared or overwritten, a spill it USED to own dies with the
        // formula. `recalc_after_off_sheet_write` is whole-sheet and not
        // spill-aware, so — as in `clear_range_with_options_off_sheet` — the
        // release happens in the same critical section as the write, and the
        // erased cells get no undo entry (the origin's entry plus a re-spill is
        // what undo restores; see `spilled_cells_owned_within`).
        for &sheet_idx in &sheet_indices {
            if sheet_idx == active_sheet || sheet_idx >= grids.len() {
                continue;
            }
            for (r, c) in take_spills_owned_within(&state, sheet_idx, row, col, row, col) {
                grids[sheet_idx].cells.remove(&(r, c));
            }
        }

        // A VALUE: write it on each target sheet (parsed and restamped above,
        // before the undo stack was taken).
        if let Some(cell_template) = entered {
            let is_formula = cell_template.has_formula();

            // Convert the AST once for reuse across sheets.
            //
            // FROM THE TREE, not from a render of it. This used to render
            // `cell_template` back to TEXT with `formula_string()` and parse that
            // text again -- a round trip through the display form, which
            // collapses a named-LAMBDA call's `__INVOKE__` marker and drops the
            // lambda (register §2ae). The template already holds the parsed tree
            // this needs, so the round trip bought nothing and could only lose.
            let engine_ast = cell_template.ast.as_deref().map(crate::convert_expr);

            for &sheet_idx in &sheet_indices {
                if sheet_idx == active_sheet || sheet_idx >= grids.len() {
                    continue;
                }

                let previous_cell = grids[sheet_idx].get_cell(row, col).cloned();

                // THE TEXT FORMAT DECIDES THE VALUE, AND IT DECIDES IT PER
                // SHEET. `cell_template` was parsed once with no destination in
                // view, which is fine for every other rung of the ladder but not
                // for this one: `007` on a group where Sheet2's column is
                // formatted as Text must be the string "007" there and the
                // number 7 elsewhere. Re-parsed rather than post-processed, so
                // the one ladder stays the one authority. A PASTE skips that
                // rung (`pasted`): the template is the stored value.
                let target_format =
                    entry_format_at(&grids[sheet_idx], &styles, row, col);
                let stored_as_text = !pasted && is_text_format(&target_format);
                let mut cell = if stored_as_text {
                    if invariant.unwrap_or(false) {
                        parse_cell_input_invariant_in_format(&value, &locale, Some(&target_format))
                    } else {
                        parse_cell_input_in_format(&value, &locale, Some(&target_format)).0
                    }
                } else {
                    cell_template.clone()
                };

                // Preserve existing style from target sheet
                if let Some(existing) = grids[sheet_idx].get_cell(row, col) {
                    cell.style_index = existing.style_index;
                }

                // If formula, evaluate in the context of the target sheet.
                // `stored_as_text` excluded: a formula typed into a Text cell is
                // the literal string on THAT sheet, and evaluating it would put
                // a value behind text the user asked to be left alone.
                //
                // A CUBE formula is served THIS sheet's pre-fetched cube data
                // (BUG-0476); with none it is exactly the evaluation it always
                // was (no cube data -> the cube functions' preserve-or-#N/A).
                if is_formula && !stored_as_text {
                    if let Some(ref ast) = engine_ast {
                        let result_value = crate::evaluate_formula_raw_with_ast_files_and_cube(
                            &grids,
                            &sheet_names,
                            sheet_idx,
                            ast,
                            &user_files,
                            None,
                            cube_by_sheet.get(&sheet_idx).cloned(),
                            None, // GET.CONTROLVALUE unavailable here (v1)
                        )
                        .to_cell_value();
                        cell.value = result_value;
                        cell.ast = Some(Box::new(ast.clone()));
                    }
                }

                grids[sheet_idx].set_cell(row, col, cell);
                undo_stack.record_cell_change(sheet_idx, row, col, previous_cell);

                // GAP A: this command stored formulas for years WITHOUT
                // registering their cross-sheet dependency edges, so an
                // off-sheet `=Sheet1!A1*2` written by a script (or into a
                // floating range) evaluated once and then went permanently
                // stale when its precedents changed — the cascade had no edge
                // to walk. Registered here for EVERY caller, through the same
                // normalize-then-update pair `update_cell_impl` uses. A
                // non-formula overwrite registers the empty set, which removes
                // whatever the previous formula had registered — and a formula
                // stored as TEXT on this sheet is a non-formula overwrite.
                let new_refs = if is_formula && !stored_as_text {
                    if let Some(ref ast) = engine_ast {
                        crate::normalize_cross_sheet_refs(
                            &crate::extract_all_references(ast, &grids[sheet_idx])
                                .cross_sheet_cells,
                            &sheet_names,
                        )
                    } else {
                        rustc_hash::FxHashSet::default()
                    }
                } else {
                    rustc_hash::FxHashSet::default()
                };
                register_off_sheet_cell_edges(&state, sheet_idx, row, col, new_refs);
                wrote.push(sheet_idx);
            }
            if opened_transaction {
                undo_stack.commit_transaction();
            }
            wrote
        } else {
            // Handle empty value - clear the cell on each target sheet. A clear
            // changes dependents exactly like a write, so it falls through to the
            // same recalc below instead of returning early.
            for &sheet_idx in &sheet_indices {
                if sheet_idx == active_sheet || sheet_idx >= grids.len() {
                    continue;
                }
                let previous_cell = grids[sheet_idx].get_cell(row, col).cloned();
                if previous_cell.is_some() {
                    undo_stack.record_cell_change(sheet_idx, row, col, previous_cell);
                    grids[sheet_idx].clear_cell(row, col);
                    // GAP A (cross-sheet edges, clear half): a cleared formula's
                    // registered cross-sheet edges must go with it, or the
                    // cascade keeps re-evaluating a cell that no longer exists.
                    register_off_sheet_cell_edges(
                        &state,
                        sheet_idx,
                        row,
                        col,
                        rustc_hash::FxHashSet::default(),
                    );
                }
                // A clear of an already-empty cell is still "handled": the
                // caller asked for empty and empty is what the sheet holds, so
                // it must NOT be reported as skipped (that would make the host
                // re-issue it against the active sheet).
                wrote.push(sheet_idx);
            }
            if opened_transaction {
                undo_stack.commit_transaction();
            }
            wrote
        }
    };

    // Dependent formulas — the neighbouring `=R61*2`, an active-sheet
    // `=Sheet2!A1`, a chain across sheets — recalculate now, exactly as the
    // QuickJS script surface does after ITS off-sheet writes. `recalc: false`
    // is the bulk path's opt-out (it batches one recalc per block).
    if !wrote.is_empty() && recalc.unwrap_or(true) {
        recalc_after_off_sheet_write(
            &state,
            &user_files_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
            &sheet_indices,
        );
    }

    Ok(wrote)
}

/// THE SHEET GROUP'S CLEAR: Delete, Clear Contents, Clear Formats and Clear
/// All with sheet tabs grouped (`core/lib/clearGestures`), over every area of
/// the selection. The body is `clear_range_on_sheets_inner` (testability
/// split). Returns the sheets it WROTE: every listed sheet but the active one,
/// which the gesture clears through its own command right after (the macro
/// recorder records one clear per returned sheet).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn clear_range_on_sheets(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    user_files_state: State<'_, UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    sheet_indices: Vec<usize>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    apply_to: Option<ClearApplyTo>,
    more_areas: Option<Vec<crate::api_types::ClearArea>>,
) -> Result<Vec<usize>, String> {
    let mut areas = vec![(start_row, start_col, end_row, end_col)];
    areas.extend(
        more_areas
            .unwrap_or_default()
            .into_iter()
            .map(|a| (a.start_row, a.start_col, a.end_row, a.end_col)),
    );
    clear_range_on_sheets_inner(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &sheet_indices,
        &areas,
        apply_to.unwrap_or(ClearApplyTo::Contents),
    )
}

/// The body of `clear_range_on_sheets`: clear `areas` on every sheet of
/// `sheet_indices` that is not the active one, as `apply_to` says
/// (contents, formats, all).
///
/// ALL OR NOTHING (review G#1). Every listed sheet -- the ACTIVE one included,
/// which the caller then clears through its own command -- is gated for every
/// area BEFORE anything is written anywhere: sheet protection, a pivot /
/// report region, a writeback claim and a spill cut in two (the content
/// gates only for a clear that removes content, as on the active sheet), and
/// for a clear that removes formats every sheet's formats PLAN -- the active
/// sheet's too (rev3A#5), whose one refusal (too many positions to write)
/// otherwise arrived from its own clear after the group had committed.
/// Excel [LIVE, Excel 16: Sheet2 protected, Sheet1 + Sheet2 grouped, Clear
/// Contents / Formats / All] clears NOTHING on any sheet; the gesture used to
/// clear the active sheet first and keep it when a grouped sheet refused.
/// Called with only the active sheet listed it writes nothing: a pure gate.
///
/// ONE STEP, ONE PASS (review G#9). Every sheet's every area is written under
/// one lock phase, as one undo step (joining the gesture's), each sheet's
/// cells as one sheet-tagged `script_grid_cells` restore -- which names no
/// target sheet, so undoing the group never switches the user to another
/// sheet -- and its row / column formats as `obj_style_tiers` restores; then
/// ONE `recalc_after_off_sheet_write` over the sheets that lost content. The
/// gesture used to make one call per area, each running the two-pass
/// whole-sheet recalculation.
///
/// SUBSCRIBED SHEETS (review G#8). Each sheet's cleared cells are recorded as
/// subscriber overrides (`record_subscription_override_edits`, a no-op on a
/// sheet no application owns), as the active sheet's clear records them, so an
/// application refresh does not put the cleared values back.
///
/// DEPENDENTS RECALCULATE (§2c): `recalc_after_off_sheet_write` evaluates each
/// written sheet plus the active one, which is also what puts a formula on the
/// ACTIVE sheet reading a cleared grouped sheet back in step.
#[allow(clippy::too_many_arguments)]
pub fn clear_range_on_sheets_inner(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    sheet_indices: &[usize],
    areas: &[(u32, u32, u32, u32)],
    apply_to: ClearApplyTo,
) -> Result<Vec<usize>, String> {
    // The hyperlink store has no sheet-addressed clear (see the off-sheet twin).
    if matches!(apply_to, ClearApplyTo::Hyperlinks | ClearApplyTo::RemoveHyperlinks) {
        return Err("Clear Hyperlinks and Remove Hyperlinks work on the active sheet only.".to_string());
    }
    let clears_content = !matches!(apply_to, ClearApplyTo::Formats);
    let areas: Vec<(u32, u32, u32, u32)> = areas
        .iter()
        .map(|&(r0, c0, r1, c1)| (r0.min(r1), c0.min(c1), r0.max(r1), c0.max(c1)))
        .collect();

    // ---- GATES: every sheet, every area, before any write ----
    for &(start_row, start_col, end_row, end_col) in &areas {
        for &sheet_idx in sheet_indices {
            // Sheet protection is per-sheet, so a group clear must be refused if
            // ANY targeted sheet protects those cells -- this is the cross-sheet
            // case the active-sheet-only `can_edit_cell` command could never
            // answer. It applies to FORMAT clears too (see the active twin).
            crate::protection::check_sheet_protection_range(
                state, sheet_idx, start_row, start_col, end_row, end_col,
            )?;
            // Object-output protection: a content clear must not punch through
            // a pivot/report region on a background sheet (format-only clears
            // stay allowed, as on the active sheet).
            if clears_content {
                check_region_range_protection(state, sheet_idx, start_row, start_col, end_row, end_col)?;
            }
        }
        if clears_content {
            // WRITEBACK CLAIM GUARD, off-sheet half. The index is keyed by
            // SheetId, so each targeted sheet is asked individually. Refused for
            // the whole group, like protection above: a group clear that
            // skipped one sheet is the silent partial mutation the guard exists
            // to prevent.
            crate::calp_commands::ensure_range_unclaimed_on_sheets(
                state, "clear this range", sheet_indices, start_row, start_col, end_row, end_col,
            )?;
            // SPILL PROTECTION, group half (§2y): refuse a rectangle that cuts
            // an array in two. `ReleasedByCaller`, like the single-sheet clears:
            // a rectangle that swallows the ORIGIN takes the whole spill with
            // it, released below.
            let spill_hosts = state.spill_hosts.lock().unwrap();
            for &sheet_idx in sheet_indices {
                check_spill_protection(
                    &spill_hosts, sheet_idx, start_row, start_col, end_row, end_col,
                    SpillOriginPolicy::ReleasedByCaller,
                )?;
            }
        }
    }

    // ---- PLAN, still holding nothing for writing ----
    let active_sheet = *state.active_sheet.read().unwrap();
    // THE ACTIVE SHEET'S FORMATS HALF IS GATED HERE TOO (round-3 review
    // rev3A#5). Its plan used to be refused only by its own clear, which the
    // gesture runs AFTER this call has written and committed the other sheets:
    // grouped Clear Formats with the active sheet's refusal (too many
    // positions to write) left the grouped sheets cleared and the active one
    // not -- the partial write G#1 set out to remove. Planned against the
    // active sheet's own grid, the one its clear plans against, under the
    // canonical lock order (grid, grids, then the rest), before anything is
    // written anywhere; the plans are dropped -- that clear makes its own.
    let active_grid = if clear_kind_clears_formats(apply_to) && sheet_indices.contains(&active_sheet) {
        Some(state.grid.lock_pending().unwrap())
    } else {
        None
    };
    let grids = state.grids.lock_pending().unwrap();
    let mut written: Vec<usize> = Vec::new();
    for &sheet_idx in sheet_indices {
        if sheet_idx != active_sheet && sheet_idx < grids.len() && !written.contains(&sheet_idx) {
            written.push(sheet_idx);
        }
    }
    let styles = state.style_registry.lock_pending().unwrap();
    if let Some(active_grid) = active_grid.as_ref() {
        for &area in &areas {
            plan_clear_formats(active_grid, &styles, area)?;
        }
    }
    // Released at once: the active sheet's own clear plans and writes it.
    drop(active_grid);
    if written.is_empty() {
        // Only the active sheet was listed (a pure gate): nothing is written,
        // and the document stays clean.
        return Ok(written);
    }
    // The formats half of every (sheet, area), planned before the effect: its
    // one refusal (too many positions to write) must write nothing anywhere.
    let mut plans: Vec<Vec<Option<ClearFormatsPlan>>> = Vec::with_capacity(written.len());
    for &sheet_idx in &written {
        let mut per_area = Vec::with_capacity(areas.len());
        for &area in &areas {
            per_area.push(if clear_kind_clears_formats(apply_to) {
                Some(plan_clear_formats(&grids[sheet_idx], &styles, area)?)
            } else {
                None
            });
        }
        plans.push(per_area);
    }

    // Past every per-sheet refusal above. This writes USER CONTENT (or
    // formats) to non-active sheets.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut grids = grids.authorize(&effect);
    let mut styles = styles.authorize(&effect);
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let mut explicit = ExplicitNormal::default();
    let mut per_sheet: Vec<(usize, BackgroundClear)> = Vec::with_capacity(written.len());
    for (sheet_slot, &sheet_idx) in written.iter().enumerate() {
        let mut out = BackgroundClear::default();
        for (area_slot, &(start_row, start_col, end_row, end_col)) in areas.iter().enumerate() {
            // SPILL TEAR-DOWN (§2y), in the same critical section as the clear.
            // `recalc_after_off_sheet_write` re-lays arrays whose origin still
            // holds a formula (§3bm), and a CLEAR is exactly the case it cannot
            // help with: the origin's formula is gone, so nothing visits it and
            // nothing would release its claim.
            let released_spill = if clears_content {
                take_spills_owned_within(state, sheet_idx, start_row, start_col, end_row, end_col)
            } else {
                Vec::new()
            };
            clear_rect_on_background_sheet(
                &mut grids[sheet_idx],
                &mut styles,
                &mut explicit,
                (start_row, start_col, end_row, end_col),
                apply_to,
                &released_spill,
                plans[sheet_slot][area_slot].as_ref(),
                &mut out,
            );
        }
        per_sheet.push((sheet_idx, out));
    }
    if per_sheet.iter().any(|(_, out)| out.changed_anything()) {
        let label = match apply_to {
            ClearApplyTo::Formats => "Clear formats on grouped sheets",
            ClearApplyTo::Contents => "Clear contents on grouped sheets",
            _ => "Clear all on grouped sheets",
        };
        let owned_txn = undo_stack.begin_owned_transaction(label.to_string());
        for (sheet_idx, out) in per_sheet.iter_mut() {
            out.record_into(&mut undo_stack, *sheet_idx, label);
        }
        undo_stack.commit_owned(owned_txn);
    }

    // PHASE B -- overrides, then dependents. `recalc_after_off_sheet_write`
    // takes its own locks (it calls `recalculate_sheet_values`), so the caller
    // must hold none.
    drop(undo_stack);
    drop(styles);
    drop(grids);

    for (sheet_idx, out) in &per_sheet {
        crate::calp_commands::record_subscription_override_edits(state, &effect, *sheet_idx, &out.override_edits);
    }

    let cleared_sheets: Vec<usize> = per_sheet
        .iter()
        .filter(|(_, out)| out.content_changed)
        .map(|(sheet_idx, _)| *sheet_idx)
        .collect();
    if !cleared_sheets.is_empty() {
        recalc_after_off_sheet_write(
            state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &cleared_sheets,
        );
    }

    Ok(written)
}

/// THE SOURCE OF A FILL, keyed by position relative to the source's top-left:
/// every stored cell of the rectangle EXCEPT a dynamic array's spilled values.
///
/// A spilled value is a stored cell (the array's output, `ast: None`), so a
/// verbatim collection copied it as a LITERAL. Ctrl+D over A1:B3 with
/// `A1 =SEQUENCE(1,2)` spilling into B1 then wrote `=SEQUENCE(1,2)` into A2 and
/// A3 and the literal 2 into B2 and B3 -- and since the fill cascade decides
/// every filled formula's spill, each filled origin was blocked by the copy of
/// its own spill and showed `#SPILL!`. Excel fills a spilled cell as BLANK,
/// whether or not its origin is in the source [LIVE, Excel 16: A1:B3 FillDown
/// spills in A2 and A3; B1:B3 FillDown leaves B2:B3 empty], so the copied
/// formulas spill again into room the fill itself cleared.
///
/// Costs one `spill_hosts` lock and one `is_empty()` on a workbook with no
/// dynamic array. A leaf lock, taken after the grid guards the caller holds.
pub(crate) fn fill_source_cells(
    state: &AppState,
    grid: &Grid,
    sheet: usize,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> std::collections::HashMap<(u32, u32), engine::Cell> {
    let spill_hosts = state.spill_hosts.lock().unwrap();
    // `source`, never `cells`: this is the fill's own lookup map, and the
    // spill / recalculation censuses read a `cells.insert(` as a grid write.
    let mut source = std::collections::HashMap::new();
    for r in start_row..=end_row {
        for c in start_col..=end_col {
            if !spill_hosts.is_empty() && spill_hosts.contains_key(&(sheet, r, c)) {
                continue; // a spilled value: filled as blank
            }
            if let Some(cell) = grid.get_cell(r, c) {
                source.insert((r - start_row, c - start_col), cell.clone());
            }
        }
    }
    source
}

/// Fill on an OBJECT's cells (P3): the same tiling and the same relative shift
/// as `fill_range` (a formula's references move by the distance from the
/// source cell it came from; everything else is copied verbatim, value and
/// style), written to the object's BACKING sheet only.
///
/// Every gate runs holding nothing, before any effect: both rectangles inside
/// the write extent, the HOST's protection over the destination's lock flags,
/// the writeback claim and the array guard on the backing sheet. The write is
/// ONE sheet-tagged undo step (`script_grid_cells`); each written formula's
/// cross-sheet edges are registered (a filled `=Sheet1!A1` keeps following
/// Sheet1), and dependents anywhere recalculate in a second lock phase.
/// Returns no cells: the object repaints from `get_cell_target_cells`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn fill_range_on_target(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    target: &crate::api_types::CellTargetRef,
    source: (u32, u32, u32, u32),
    dest: (u32, u32, u32, u32),
) -> Result<Vec<CellData>, String> {
    let norm = |r: (u32, u32, u32, u32)| (r.0.min(r.2), r.1.min(r.3), r.0.max(r.2), r.1.max(r.3));
    let (sr0, sc0, sr1, sc1) = norm(source);
    let (tr0, tc0, tr1, tc1) = norm(dest);
    let t = crate::cell_target::resolve_cell_target(state, target)?;
    crate::cell_target::ensure_in_extent(&t, sr0, sc0, sr1, sc1)?;
    crate::cell_target::ensure_in_extent(&t, tr0, tc0, tr1, tc1)?;
    crate::cell_target::gate_target_cells(
        state,
        &t,
        (tr0, tc0, tr1, tc1),
        crate::cell_target::EDIT_CELLS,
        "fill these cells",
    )?;
    let backing = t.backing_index;
    crate::calp_commands::ensure_range_unclaimed_on_sheets(
        state, "fill into this range", &[backing], tr0, tc0, tr1, tc1,
    )?;
    check_no_array_within(state, backing, tr0, tc0, tr1, tc1)?;

    // Read before the grid guard and released: `grids` comes first in the
    // canonical order, so nothing is nested here.
    let sheet_names: Vec<String> = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let (src_rows, src_cols) = (sr1 - sr0 + 1, sc1 - sc0 + 1);

    let mut edges: Vec<(u32, u32, rustc_hash::FxHashSet<(String, u32, u32)>)> = Vec::new();
    {
        let grids = state.grids.lock_pending().map_err(|e| e.to_string())?;
        if backing >= grids.len() {
            return Err("Floating range backing sheet is missing".to_string());
        }
        crate::cell_target::ensure_target_still_at(state, &t)?;
        // A PROTECTED HOST'S FORMATTING, decided under the held grid and style
        // guards (`format_protection_under_guards`), as on the sheet
        // (`fill_range_core`): the source's format only when the host allows
        // Format Cells, else each cell keeps its own; and every filled cell
        // keeps the Locked flag it had.
        let styles = state.style_registry.lock_pending().map_err(|e| e.to_string())?;
        let (host_protected, format_allowed) =
            match crate::commands::styles::format_protection_under_guards(state, Some(&t), backing, "format cells") {
                Ok(protected) => (protected, true),
                Err(_) => (true, false),
            };

        // The plan, against the backing grid as it stands: every destination
        // cell's previous and new state, and -- on a protected host -- the
        // Locked flag it keeps.
        let grid = &grids[backing];
        // A spilled value fills as blank, as on the sheet (`fill_source_cells`).
        let source_cells = fill_source_cells(state, grid, backing, sr0, sc0, sr1, sc1);
        let mut plan: Vec<(u32, u32, Option<engine::Cell>, Option<engine::Cell>, Option<bool>)> = Vec::new();
        for tr in tr0..=tr1 {
            for tc in tc0..=tc1 {
                let (rel_r, rel_c) = ((tr - tr0) % src_rows, (tc - tc0) % src_cols);
                let previous = grid.get_cell(tr, tc).cloned();
                let own_before = previous.as_ref().map_or(0, |c| c.style_index);
                let keep_lock =
                    host_protected.then(|| crate::protection::cell_is_locked(grid, &styles, tr, tc));
                let next = source_cells.get(&(rel_r, rel_c)).map(|src| {
                    let mut cell = src.clone();
                    cell.rich_text = None;
                    if let Some(formula) = crate::commands::structure::formula_to_rewrite(src) {
                        let row_delta = tr as i32 - (sr0 + rel_r) as i32;
                        let col_delta = tc as i32 - (sc0 + rel_c) as i32;
                        let shifted =
                            crate::commands::structure::shift_formula_internal(&formula, row_delta, col_delta);
                        if !crate::commands::structure::store_rewritten_formula(&mut cell, &shifted, "fill", tr, tc) {
                            // The fill's own rule (see `fill_range`): an
                            // unreadable shift is a VISIBLE #VALUE!, never the
                            // source's tree pointing at the wrong cells.
                            cell.ast = None;
                            cell.value = engine::CellValue::Error(engine::CellError::Value);
                        }
                    }
                    if !format_allowed {
                        cell.style_index = own_before;
                    }
                    cell
                });
                // An empty source on a protected host leaves a blank that keeps
                // the cell's own format when Format Cells is refused (the lock
                // is kept below).
                let next = match next {
                    None if keep_lock.is_some() && !format_allowed && own_before != 0 => {
                        Some(blank_cell_with_style(own_before))
                    }
                    other => other,
                };
                if previous.is_none() && next.is_none() {
                    continue;
                }
                plan.push((tr, tc, previous, next, keep_lock));
            }
        }
        if plan.is_empty() {
            return Ok(Vec::new());
        }

        // Every gate has passed and the fill changes cells: committed here,
        // in the same critical section as the plan.
        let effect = crate::document_effect::DocumentEffect::mutates(file_state);
        let mut grids = grids.authorize(&effect);
        let mut styles = styles.authorize(&effect);
        let grid = &mut grids[backing];
        let mut previous_cells: Vec<(u32, u32, Option<engine::Cell>)> = Vec::with_capacity(plan.len());
        for (row, col, previous, next, keep_lock) in plan {
            previous_cells.push((row, col, previous));
            // A protected host: the written look keeps the cell's Locked flag
            // (`keep_cell_lock`), an emptied cell included.
            let next = match keep_lock {
                Some(locked) => {
                    let mut cell = next.unwrap_or_else(engine::Cell::new);
                    cell.style_index = crate::commands::styles::keep_cell_lock(
                        &mut styles, grid, row, col, cell.style_index, locked,
                    );
                    let empty = cell.style_index == 0
                        && matches!(cell.value, engine::CellValue::Empty)
                        && cell.formula_string().is_none();
                    (!empty).then_some(cell)
                }
                None => next,
            };
            match next {
                Some(cell) => grid.set_cell(row, col, cell),
                None => grid.clear_cell(row, col),
            }
        }
        // Each destination's cross-sheet edges, from what it now holds (an
        // emptied or literal cell registers the empty set, which drops any
        // edge its previous formula had).
        for &(row, col, _) in &previous_cells {
            let refs = grid
                .get_cell(row, col)
                .and_then(|cell| cell.ast.as_deref())
                .map(|ast| {
                    let ast = crate::convert_expr(ast);
                    crate::normalize_cross_sheet_refs(
                        &crate::extract_all_references(&ast, grid).cross_sheet_cells,
                        &sheet_names,
                    )
                })
                .unwrap_or_default();
            edges.push((row, col, refs));
        }
        let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
        let owned = undo_stack.begin_owned_transaction(format!("Fill {} cells", previous_cells.len()));
        undo_stack.record_custom_restore(
            "script_grid_cells".to_string(),
            crate::undo_commands::script_grid_cells_snapshot_bytes(backing, previous_cells),
            "Fill",
        );
        undo_stack.commit_owned(owned);
    }

    // PHASE B, holding nothing from phase A.
    for (row, col, refs) in edges {
        register_off_sheet_cell_edges(state, backing, row, col, refs);
    }
    recalc_after_off_sheet_write(
        state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        &[backing],
    );
    Ok(Vec::new())
}

/// Fill a target range by copying/tiling source cells.
/// Formulas have their relative references shifted by the delta between source and target.
/// Non-formula cells are cloned verbatim (value + style).
/// This is the backend for Ctrl+D (Fill Down), Ctrl+R (Fill Right), etc.
#[tauri::command]
pub fn fill_range(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    source_start_row: u32,
    source_start_col: u32,
    source_end_row: u32,
    source_end_col: u32,
    target_start_row: u32,
    target_start_col: u32,
    target_end_row: u32,
    target_end_col: u32,
    target: Option<crate::api_types::CellTargetRef>,
) -> Result<Vec<CellData>, String> {
    // P3: an OBJECT's cells (Fill Down/Right/Up/Left on a floating grid). Both
    // rectangles are in the object's coordinates; `target_*` stays the FILL
    // destination, as before.
    if let Some(target) = target.as_ref() {
        return fill_range_on_target(
            &state,
            &file_state,
            &user_files_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
            target,
            (source_start_row, source_start_col, source_end_row, source_end_col),
            (target_start_row, target_start_col, target_end_row, target_end_col),
        );
    }
    fill_range_core(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        (source_start_row, source_start_col, source_end_row, source_end_col),
        (target_start_row, target_start_col, target_end_row, target_end_col),
    )
}

/// `fill_range` on the ACTIVE sheet without the Tauri wrappers (tests drive
/// the real body). `source` and `dest` are inclusive `(r0, c0, r1, c1)`.
///
/// A PROTECTED SHEET'S FORMATTING (Excel parity), decided under the held grid
/// and style guards: a filled cell's FORMAT is the source's only when the
/// sheet allows Format Cells -- otherwise the value lands and the cell keeps
/// its own format -- and every filled cell keeps the Locked flag it had
/// (`keep_cell_lock`). Excel [LIVE, Excel 16 COM, 2026-10-31,
/// protfill/probe1.ps1]: FillDown / AutoFill of a locked, bold, 0.00, yellow A1
/// over unlocked A2:A3 -- Format Cells not allowed: A2 = 5, plain, General,
/// unlocked, no error; allowed: A2 = 5, bold, 0.00, yellow, still UNLOCKED.
#[allow(clippy::too_many_arguments)]
pub fn fill_range_core(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    source: (u32, u32, u32, u32),
    dest: (u32, u32, u32, u32),
) -> Result<Vec<CellData>, String> {
    let (source_start_row, source_start_col, source_end_row, source_end_col) = source;
    let (target_start_row, target_start_col, target_end_row, target_end_col) = dest;
    // PERF-03: one lookup-index cache for the whole pass (lookup_cache.rs).
    let _lookup_pass = engine::begin_lookup_pass();
    // SUBTOTAL/AGGREGATE row-visibility snapshot: built ONCE for this
    // pass (never per formula) and read by the evaluator through the
    // thread-local pass scope. Built BEFORE any grid lock is taken.
    let _visibility_pass = crate::row_visibility::begin_pass(&state);
    // Fill/autofill writes and evaluates a whole rectangle of formulas —
    // Interactive ceiling, cancellable (a fill down a million rows is a
    // genuinely long operation started by one gesture).
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Interactive,
        &state.calc_cancel,
    );
    use std::collections::HashMap;
    use std::time::Instant;
    let perf_t0 = Instant::now();

    // GET.CONTROLVALUE snapshot: built ONCE per fill, BEFORE the grid locks
    // below (canonical lock order); shared across every evaluation.
    let control_values = crate::control_values::build_control_values(
        &state, &pane_control_state, &ribbon_filter_state,
    );
    // NOTE: user files are locked BELOW, after the grid locks -- canonical lock
    // order (the recalculation pass takes `files` only after both grid locks,
    // on a background thread).

    // Sheet protection over the FILL TARGET (the source is only read) is asked
    // BELOW, under the held grid and style guards (rev15C): asked here, holding
    // nothing, a sheet protected between the question and the write had its
    // LOCKED cells overwritten.

    // WRITEBACK CLAIM GUARD over the FILL TARGET (the source is only read).
    // This was the first range guard in the codebase and is now the shared one,
    // so sort/clear/merge/replace/insert/delete all refuse identically and the
    // message actually names the region and its A1 rectangle.
    crate::calp_commands::ensure_range_unclaimed(
        &state,
        "fill into this range",
        target_start_row,
        target_start_col,
        target_end_row,
        target_end_col,
    )?;

    // SPILL PROTECTION over the FILL TARGET (§2y). `fill_range` had NONE — the
    // one range-rewriting command in this file that could scribble straight
    // over a dynamic array. Ctrl+D across a spilled block overwrote cells the
    // array still claimed, and the map went on claiming them, so the next
    // recalculation of the origin put the array's values back and the fill was
    // gone with no error. Refused whole, like `sort_range`: a fill REPLACES the
    // target cell by cell, so an origin inside it would be overwritten one
    // moment and re-spilled by the same pass the next.
    {
        let active = *state.active_sheet.read().unwrap();
        check_no_array_within(
            &state,
            active,
            target_start_row.min(target_end_row),
            target_start_col.min(target_end_col),
            target_start_row.max(target_end_row),
            target_start_col.max(target_end_col),
        )?;
    }

    // CANONICAL LOCK ORDER: both grid locks FIRST, then everything else. Held
    // PENDING until the protection gate below has passed under them.
    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let user_files = user_files_state.files.lock().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    // WRITE once authorized, not read: a protected sheet's lock-keeping look
    // may have to be interned (`keep_cell_lock`, below).
    let styles = state.style_registry.lock_pending().unwrap();
    // SHEET PROTECTION over the FILL TARGET, asked over the guards this fill
    // HOLDS (the order `remove_duplicates` uses: the kinds copied and
    // released, then `sheet_protection` read and released): a LOCKED target
    // cell refuses the fill whole, before anything is written or dirtied.
    //
    // A PROTECTED SHEET'S FORMATTING is decided from the SAME read (misc19,
    // round 19): the fill carries the source's FORMAT only when the sheet
    // allows Format Cells, and every filled cell keeps its Locked flag (see
    // `fill_range_core`'s doc). It used to be a second read after `authorize`,
    // and `protect_sheet` takes no grid lock, so a Protect landing between the
    // two let the fill write LOCKED cells (the gate saw the sheet open) and
    // then drop the source formats (the second read saw it protected) -- a
    // result neither order of the two gestures gives. One read is one moment.
    let (sheet_protected, format_allowed) = {
        let sheet_kinds = state.sheet_kinds.read().unwrap().clone();
        let protection_storage = state.sheet_protection.read().unwrap();
        crate::protection::check_sheet_protection_range_in(
            &sheet_kinds,
            &protection_storage,
            &grid,
            &styles,
            active_sheet,
            target_start_row.min(target_end_row),
            target_start_col.min(target_end_col),
            target_start_row.max(target_end_row),
            target_start_col.max(target_end_col),
        )?;
        match protection_storage.get(&active_sheet) {
            Some(p) if p.protected => (true, p.is_action_allowed("formatCells")),
            _ => (false, true),
        }
    };
    // Every gate has passed; the fill below commits.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut styles = styles.authorize(&effect);
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    // DEFINED-NAME edges. Locked in the same phase as the other dependency maps
    // and in declaration order, so the canonical lock order stays one sequence.
    let mut name_dependents_map = state.name_dependents.lock().unwrap();
    let mut name_dependencies_map = state.name_dependencies.lock().unwrap();
    let mut table_dependents_map = state.table_dependents.lock().unwrap();
    let mut table_dependencies_map = state.table_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let calc_mode = state.calculation_mode.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    // Lock pivot state for GETPIVOTDATA support
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let pivot_views = pivot_state.views.lock().unwrap();
    let pivot_data_fn = |data_field: &str, pivot_sheet: Option<&str>, pivot_row: u32, pivot_col: u32, pairs: &[(&str, &str)]| -> Option<f64> {
        crate::pivot::operations::lookup_pivot_data(
            &pivot_tables,
            &pivot_views,
            data_field,
            pivot_sheet,
            pivot_row,
            pivot_col,
            pairs,
        )
    };

    // Pre-fetch writeback submissions so GATHER formulas see current data
    // (empty map, no registry I/O, when the workbook has no writeback regions).
    let gather_data = crate::calp_commands::build_gather_data(&state);
    let gather_fn = |region_id: &str| -> engine::GatherRegionData {
        gather_data.get(region_id).cloned().unwrap_or_default()
    };

    let perf_t1_locks = Instant::now();

    // Source range dimensions
    let src_rows = source_end_row - source_start_row + 1;
    let src_cols = source_end_col - source_start_col + 1;

    // Collect source cells into a lookup map (relative position -> Cell). A
    // dynamic array's spilled values are filled as BLANK, as Excel does, so a
    // filled origin spills again instead of being blocked by a literal copy of
    // its own spill (`fill_source_cells`).
    let source_cells: HashMap<(u32, u32), engine::Cell> = fill_source_cells(
        &state,
        &grid,
        active_sheet,
        source_start_row,
        source_start_col,
        source_end_row,
        source_end_col,
    );

    // Begin undo transaction
    let opened_transaction = !undo_stack.has_open_transaction();
    if opened_transaction {
        let fill_count = (target_end_row - target_start_row + 1) * (target_end_col - target_start_col + 1);
        undo_stack.begin_transaction(format!("Fill {} cells", fill_count));
    }

    // Build merge lookup for span info
    let merge_lookup: HashMap<(u32, u32), &MergedRegion> = merged_regions
        .iter()
        .map(|r| ((r.start_row, r.start_col), r))
        .collect();

    let mut updated_cells: Vec<CellData> = Vec::new();
    let mut cells_needing_recalc: Vec<(u32, u32)> = Vec::new();
    // Pre/post cell states collected for subscriber override capture.
    let mut override_edits: Vec<(u32, u32, Option<engine::Cell>, Option<engine::Cell>)> = Vec::new();

    // Iterate over target range
    for tr in target_start_row..=target_end_row {
        for tc in target_start_col..=target_end_col {
            // Map target cell to source cell using modular tiling
            let rel_r = (tr - target_start_row) % src_rows;
            let rel_c = (tc - target_start_col) % src_cols;

            // Record previous state for undo
            let previous_cell = grid.get_cell(tr, tc).cloned();
            let pre_for_override = previous_cell.clone();
            undo_stack.record_cell_change(active_sheet, tr, tc, previous_cell);
            // A protected sheet: the cell's OWN format (kept when Format Cells
            // is not allowed) and the Locked flag it has NOW, which it keeps
            // whatever the fill brings.
            let own_before = pre_for_override.as_ref().map_or(0, |c| c.style_index);
            let locked_before =
                sheet_protected && crate::protection::cell_is_locked(&grid, &styles, tr, tc);

            // Find the source cell
            let source_cell = source_cells.get(&(rel_r, rel_c));

            if let Some(src) = source_cell {
                // Compute the delta from the source cell's absolute position to the target
                let src_abs_r = source_start_row + rel_r;
                let src_abs_c = source_start_col + rel_c;
                let row_delta = tr as i32 - src_abs_r as i32;
                let col_delta = tc as i32 - src_abs_c as i32;

                let mut new_cell = src.clone();
                // Clear cached AST - it will be rebuilt
                new_cell.ast = None;
                // Clear rich text (not meaningful when filling)
                new_cell.rich_text = None;

                // If the source has a formula, shift the references
                if let Some(formula) = crate::commands::structure::formula_to_rewrite(src) {
                    // WITH the table registry, so a structured reference walks
                    // sideways the way Excel's does (Ctrl+R over `=[@Qty]` must
                    // land on `[@Price]`, not repeat the source column). The
                    // ANCHOR is the SOURCE cell: the unqualified `[@...]` form
                    // means "the table this formula is in", which only the cell
                    // it came from can answer. The resolver takes the table lock
                    // per question rather than holding it -- the cascade below
                    // takes `state.tables` itself.
                    let resolver = crate::commands::structure::WorkbookTableColumns {
                        state: &state,
                        sheet: active_sheet,
                        anchor: Some((src_abs_r, src_abs_c)),
                    };
                    let shifted = crate::commands::structure::shift_formula_internal_with_tables(
                        &formula,
                        row_delta,
                        col_delta,
                        Some(&resolver),
                    );
                    // RAW, not the display form: formula_string() collapses a
                    // named-LAMBDA call's __INVOKE__ marker, so filling one down
                    // a column re-parsed it as an unknown function and the whole
                    // fill produced #NAME?.
                    //
                    // The unparseable case is handled by the Err arm below -- it
                    // leaves the cell showing #VALUE!, which is a VISIBLE
                    // failure, so unlike the sort and insert paths there is
                    // nothing here to keep: the source cell's own AST would
                    // reference the wrong cells if it were carried over.
                    new_cell.ast = parser::parse(&shifted).ok().map(Box::new);

                    // Parse and evaluate the shifted formula
                    match parser::parse(&shifted) {
                        Ok(parsed) => {
                            // THE CELL KEEPS THE NAME (Excel parity, D2) — one
                            // recipe, shared with update_cell and the batch writer.
                            let entered = crate::split_entered_formula(
                                &state, &parsed, active_sheet, tr, tc, &sheet_names,
                            );
                            let resolved = entered.evaluated();

                            let refs = extract_all_references(resolved, &grid);

                            update_dependencies(
                                (tr, tc),
                                refs.cells,
                                &mut dependencies_map,
                                &mut dependents_map,
                            );
                            update_column_dependencies(
                                (tr, tc),
                                refs.columns,
                                &mut column_dependencies_map,
                                &mut column_dependents_map,
                            );
                            update_row_dependencies(
                                (tr, tc),
                                refs.rows,
                                &mut row_dependencies_map,
                                &mut row_dependents_map,
                            );

                            // Cross-sheet dependencies
                            update_cross_sheet_dependencies(
                                (active_sheet, tr, tc),
                                crate::normalize_cross_sheet_refs(
                                    &refs.cross_sheet_cells,
                                    &sheet_names,
                                ),
                                &mut cross_sheet_dependencies_map,
                                &mut cross_sheet_dependents_map,
                            );

                            // DEFINED-NAME edges, from the tree the cell KEEPS.
                            {
                                let mut names = crate::name_resolution::NameSet::default();
                                crate::name_resolution::collect_names(
                                    &entered.stored,
                                    &mut names,
                                );
                                crate::name_resolution::update_name_dependencies(
                                    (tr, tc),
                                    names,
                                    &mut name_dependencies_map,
                                    &mut name_dependents_map,
                                );
                            }

                            // STRUCTURED-REFERENCE edges (§2aj), same tree.
                            {
                                let mut tables = crate::table_deps::TableSet::default();
                                crate::table_deps::collect_table_names(
                                    &entered.stored,
                                    &mut tables,
                                );
                                crate::table_deps::update_table_dependencies(
                                    (tr, tc),
                                    tables,
                                    &mut table_dependencies_map,
                                    &mut table_dependents_map,
                                );
                            }

                            // Convert AST and evaluate
                            let engine_ast = crate::convert_expr(resolved);
                            new_cell.set_cached_ast(crate::convert_expr(&entered.stored));

                            let eval_ctx = engine::EvalContext {
                                cube_prefetch: None,
                                current_row: Some(tr),
                                current_col: Some(tc),
                                row_heights: None,
                                column_widths: None,
                                hidden_rows: None,
                                control_values: Some(control_values.clone()),
                            };
                            let raw_result = evaluate_formula_raw_with_files_and_pivot(
                                &grids,
                                &sheet_names,
                                active_sheet,
                                &engine_ast,
                                eval_ctx,
                                Some(&styles),
                                &user_files,
                                Some(&pivot_data_fn),
                                Some(&gather_fn),
                                None, // v1: fill/on-sheets path does not resolve UDFs
                            );

                            // The scalar result here; under automatic calculation the
                            // cascade below re-evaluates every filled formula (they are
                            // members of its order) through `reevaluate_formula_cell`,
                            // so an array result spills through THE ONE SPILL DECISION.
                            new_cell.value = raw_result.to_cell_value();
                        }
                        Err(e) => {
                            // If formula can't be parsed after shifting, store as
                            // error. LOUD (register section 3bc): text a rewrite
                            // produced and cannot read back is a defect in the
                            // rewriter, and it used to be filed at debug level
                            // where nobody would ever see it.
                            new_cell.value = engine::CellValue::Error(engine::CellError::Value);
                            crate::log_error!(
                                "FILL",
                                "fill produced unreadable formula text at {} -- the cell is #VALUE!: `{}` ({})",
                                calcula_format::cell_ref::to_a1(tr, tc),
                                shifted,
                                e
                            );
                        }
                    }
                }
                // else: non-formula cell - value and style already cloned from source

                // ...except on a PROTECTED sheet: the source's format only
                // when Format Cells is allowed, else the cell's own; and the
                // cell keeps its Locked flag either way.
                if sheet_protected {
                    let carried = if format_allowed { new_cell.style_index } else { own_before };
                    new_cell.style_index = crate::commands::styles::keep_cell_lock(
                        &mut styles, &grid, tr, tc, carried, locked_before,
                    );
                }

                // Write the cell
                grid.set_cell(tr, tc, new_cell.clone());
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(tr, tc, new_cell.clone());
                }

                // Build CellData for the response
                let style = styles.get(grid.effective_style_index(tr, tc));
                let (display, overflow) = crate::format_cell_value_and_class(&new_cell.value, style, &locale);

                let (row_span, col_span) = if let Some(region) = merge_lookup.get(&(tr, tc)) {
                    (
                        region.end_row - region.start_row + 1,
                        region.end_col - region.start_col + 1,
                    )
                } else {
                    (1, 1)
                };

                updated_cells.push(CellData {
                    row: tr,
                    col: tc,
                    display,
                    overflow,
                    display_color: None,
                    formula: formula_display(&new_cell, &locale),
                    style_index: grid.effective_style_index(tr, tc),
                    row_span,
                    col_span,
                    sheet_index: None,
                    rich_text: None,
                    accounting_layout: None,
                });
            } else {
                // Source cell is empty - clear the target cell. On a PROTECTED
                // sheet the cleared position keeps its Locked flag (and, when
                // Format Cells is not allowed, its own format) -- clearing an
                // unlocked input whole would bring it back LOCKED (the default).
                let blank_style = if sheet_protected {
                    let carried = if format_allowed { 0 } else { own_before };
                    crate::commands::styles::keep_cell_lock(&mut styles, &grid, tr, tc, carried, locked_before)
                } else {
                    0
                };
                if blank_style != 0 {
                    grid.set_cell(tr, tc, blank_cell_with_style(blank_style));
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(tr, tc, blank_cell_with_style(blank_style));
                    }
                } else {
                    grid.clear_cell(tr, tc);
                    if active_sheet < grids.len() {
                        grids[active_sheet].clear_cell(tr, tc);
                    }
                }

                // Clear dependencies for this cell
                update_cross_sheet_dependencies(
                    (active_sheet, tr, tc),
                    Default::default(),
                    &mut cross_sheet_dependencies_map,
                    &mut cross_sheet_dependents_map,
                );
                update_dependencies(
                    (tr, tc),
                    Default::default(),
                    &mut dependencies_map,
                    &mut dependents_map,
                );
                update_column_dependencies(
                    (tr, tc),
                    Default::default(),
                    &mut column_dependencies_map,
                    &mut column_dependents_map,
                );
                update_row_dependencies(
                    (tr, tc),
                    Default::default(),
                    &mut row_dependencies_map,
                    &mut row_dependents_map,
                );

                let (row_span, col_span) = if let Some(region) = merge_lookup.get(&(tr, tc)) {
                    (
                        region.end_row - region.start_row + 1,
                        region.end_col - region.start_col + 1,
                    )
                } else {
                    (1, 1)
                };

                updated_cells.push(CellData {
                    row: tr,
                    col: tc,
                    display: String::new(),
                    // Empty: nothing to overflow, and text never marks.
                    overflow: crate::api_types::OverflowClass::Text,
                    display_color: None,
                    formula: None,
                    // The look the position shows (a protected sheet's
                    // cleared position keeps its own, above).
                    style_index: grid.effective_style_index(tr, tc),
                    row_span,
                    col_span,
                    sheet_index: None,
                    rich_text: None,
                    accounting_layout: None,
                });
            }

            override_edits.push((tr, tc, pre_for_override, grid.get_cell(tr, tc).cloned()));
            cells_needing_recalc.push((tr, tc));
        }
    }

    // Record subscriber overrides for all filled cells (subscribed sheets only)
    crate::calp_commands::record_subscription_override_edits(&state, &crate::document_effect::DocumentEffect::mutates(&file_state), active_sheet, &override_edits);

    let perf_t2_processed = Instant::now();

    // Manual calculation: the dependents stay as they are, and the workbook
    // says so (Excel's xlPending -> the status bar's "Calculate").
    if *calc_mode != "automatic" {
        note_manual_write_left_formulas_uncalculated(
            &grid,
            &cells_needing_recalc,
            sheet_names.get(active_sheet).map(String::as_str).unwrap_or(""),
            &dependents_map,
            &column_dependents_map,
            &row_dependents_map,
            &cross_sheet_dependents_map,
        );
    }

    // Recalculate dependents if automatic mode
    if *calc_mode == "automatic" {
        // One multi-root traversal for the whole fill (see update_cells_batch):
        // fixes in-fill stale values and avoids one BFS + Kahn per filled cell.
        let mut all_recalc_order: Vec<(u32, u32)> =
            crate::recalc_order_from_seeds(&cells_needing_recalc, &dependents_map, true);
        let mut recalc_set: crate::CoordSet = all_recalc_order.iter().copied().collect();

        for (row, col) in &cells_needing_recalc {
            let col_row_deps =
                get_column_row_dependents((*row, *col), &column_dependents_map, &row_dependents_map);
            for dep in col_row_deps {
                if recalc_set.insert(dep) {
                    all_recalc_order.push(dep);
                }
            }
        }

        // Lock table state for cascade recalculation
        let batch_tables = state.tables.read().unwrap();
        let batch_table_names = state.table_names.read().unwrap();
        let batch_named_ranges = state.named_ranges.read().unwrap();

        // PERF-20: skip per-dependent formula render + IPC payload for wide cascades.
        let include_cascade_formulas = all_recalc_order.len() <= CASCADE_FORMULA_LIMIT;

        // The same per-cell evaluator as the batch above and `update_cell`:
        // `reevaluate_formula_cell` evaluates each dependent at its OWN cell
        // (ROW()/COLUMN(), `@`, and -- this path carries no UDF resolver and no
        // cube data -- the preserve that keeps a cube or custom-function cell's
        // value instead of clobbering it to #N/A / #NAME?), and spills it through
        // THE ONE SPILL DECISION. It was a second hand copy of the batch's
        // positionless loop, and the filled cells are members of this order, so
        // a `=ROW()` filled down came back #VALUE! from its own cascade.
        let mut cache_hits: u32 = 0;
        let mut cache_misses: u32 = 0;
        for &(dep_row, dep_col) in &all_recalc_order {
            let Some(dep_cell) = grid.get_cell(dep_row, dep_col).cloned() else {
                continue;
            };
            let Some(formula) = dep_cell.formula_string() else {
                continue;
            };
            reevaluate_formula_cell(
                &state,
                &mut grid,
                &mut grids,
                &sheet_names,
                active_sheet,
                dep_row,
                dep_col,
                &dep_cell,
                &formula,
                &user_files,
                None,
                None,
                Some(&control_values),
                &styles,
                &locale,
                &merge_lookup,
                &batch_tables,
                &batch_table_names,
                &batch_named_ranges,
                &mut updated_cells,
                &mut cache_hits,
                &mut cache_misses,
                include_cascade_formulas,
            );
        }

        // Cross-sheet dependents — the SHARED walk (see BUG-0019 on
        // `cascade_cross_sheet_dependents`). Was a second hand-copy of the same
        // partial walk; a fill that fed another sheet propagated one hop only.
        cascade_cross_sheet_dependents(
            &state,
            &mut grid,
            &mut grids,
            &sheet_names,
            active_sheet,
            &cross_sheet_dependents_map,
            &user_files,
            &control_values,
            &styles,
            &locale,
            &merge_lookup,
            crate::name_resolution::NameTables {
                named_ranges: &batch_named_ranges,
                tables: &batch_tables,
                table_names: &batch_table_names,
                sheet_names: &sheet_names,
                spill_ranges: &state.spill_ranges,
            },
            &cells_needing_recalc,
            &all_recalc_order,
            &mut updated_cells,
            include_cascade_formulas,
        );
    }

    // Commit undo transaction
    if opened_transaction {
        undo_stack.commit_transaction();
    }

    // Mark workbook as dirty
    let _ = crate::document_effect::DocumentEffect::mutates(&file_state);

    let perf_tend = Instant::now();
    log_perf!("FILL",
        "fill_range src=({},{})..({},{}) tgt=({},{})..({},{}) => {} cells | locks={:.2}ms process={:.2}ms recalc={:.2}ms TOTAL={:.2}ms",
        source_start_row, source_start_col, source_end_row, source_end_col,
        target_start_row, target_start_col, target_end_row, target_end_col,
        updated_cells.len(),
        perf_t1_locks.duration_since(perf_t0).as_secs_f64() * 1000.0,
        perf_t2_processed.duration_since(perf_t1_locks).as_secs_f64() * 1000.0,
        perf_tend.duration_since(perf_t2_processed).as_secs_f64() * 1000.0,
        perf_tend.duration_since(perf_t0).as_secs_f64() * 1000.0
    );

    Ok(updated_cells)
}

#[cfg(test)]
mod typed_range_tests {
    use super::typed_cell_value;
    use engine::{CellError, CellValue};

    #[test]
    fn maps_every_scalar_kind_to_its_json_value() {
        let (k, v) = typed_cell_value(&CellValue::Number(5.0), "5,00 kr");
        assert_eq!(k, "number");
        assert_eq!(v, serde_json::json!(5.0));

        let (k, v) = typed_cell_value(&CellValue::Text("5".into()), "5");
        assert_eq!(k, "text");
        assert_eq!(v, serde_json::json!("5"));

        let (k, v) = typed_cell_value(&CellValue::Boolean(true), "TRUE");
        assert_eq!(k, "boolean");
        assert_eq!(v, serde_json::json!(true));

        let (k, v) = typed_cell_value(&CellValue::Empty, "");
        assert_eq!(k, "empty");
        assert_eq!(v, serde_json::Value::Null);
    }

    #[test]
    fn errors_carry_their_excel_literal_not_the_display_text() {
        // The display argument is deliberately NOT a literal any surface
        // produces: the point is that the typed value comes from
        // `CellError::as_literal`, never from the text the grid was handed.
        let (k, v) = typed_cell_value(&CellValue::Error(CellError::Div0), "divided by zero");
        assert_eq!(k, "error");
        assert_eq!(v, serde_json::json!("#DIV/0!"));
    }

    #[test]
    fn collections_surface_as_text_with_their_display() {
        let list = CellValue::List(Box::new(vec![CellValue::Number(1.0)]));
        let (k, v) = typed_cell_value(&list, "{1}");
        assert_eq!(k, "text");
        assert_eq!(v, serde_json::json!("{1}"));
    }

    #[test]
    fn non_finite_numbers_have_no_json_form_and_report_null() {
        let (k, v) = typed_cell_value(&CellValue::Number(f64::NAN), "NaN");
        assert_eq!(k, "number");
        assert_eq!(v, serde_json::Value::Null);
    }
}

#[cfg(test)]
mod volatile_builtin_cascade_tests {
    //! VOLATILE BUILT-INS on the per-edit cascade (PERF-19 / glossary term
    //! "volatile-function").
    //!
    //! Excel recalculates NOW, TODAY, RAND, RANDBETWEEN, RANDARRAY, OFFSET,
    //! INDIRECT and CELL on EVERY worksheet change — that is what the term
    //! means. Calcula recalculated them only on an explicit full pass, so a
    //! `=NOW()` cell sat FROZEN while the user edited around it. The failure was
    //! a SILENT WRONG ANSWER, not an error: the cell went on displaying a
    //! plausible timestamp, and nothing on screen said it was hours old.
    //!
    //! Which functions are volatile is pinned next to the predicate
    //! (`engine::volatility`). What is pinned here is the ROOT SET the edit
    //! cascade is seeded with, and — as a source tripwire — that both apply
    //! paths still splice it.

    use super::*;
    use engine::{Cell, Grid};

    /// A grid from `(row, col, text)` triples; text starting with `=` becomes a
    /// formula cell (parsed to an AST, which is what the scan reads).
    fn grid_with(cells: &[(u32, u32, &str)]) -> Grid {
        let mut grid = Grid::new();
        for &(row, col, text) in cells {
            let cell = if text.starts_with('=') {
                Cell::new_formula(text.to_string())
            } else {
                Cell::new_text(text.to_string())
            };
            grid.set_cell(row, col, cell);
        }
        grid
    }

    fn dependents(edges: &[((u32, u32), (u32, u32))]) -> crate::DependencyMap {
        let mut map = crate::DependencyMap::default();
        for &(precedent, dependent) in edges {
            map.entry(precedent).or_default().insert(dependent);
        }
        map
    }

    fn stripe(edges: &[(u32, (u32, u32))]) -> crate::StripeDependentsMap {
        let mut map = crate::StripeDependentsMap::default();
        for &(index, dependent) in edges {
            map.entry(index).or_default().insert(dependent);
        }
        map
    }

    #[test]
    fn a_sheet_with_no_volatile_formula_produces_no_roots() {
        let grid = grid_with(&[
            (0, 0, "42"),
            (1, 0, "=SUM(A1:A1)"),
            (2, 0, "=IF(A1>0,A1,0)"),
            (3, 0, "text"),
        ]);
        assert!(volatile_cells_on_active_sheet(&grid).is_empty());
    }

    #[test]
    fn every_volatile_builtin_is_found_wherever_it_sits_in_the_formula() {
        let grid = grid_with(&[
            (0, 0, "=NOW()"),
            (1, 0, "=1+RAND()"),           // nested under an operator
            (2, 0, "=ROUND(TODAY(),0)"),   // nested under a call
            (3, 0, "=OFFSET(B1,1,0)"),
            (4, 0, "=SUM(B1:B9)"),         // not volatile
            (5, 0, "100"),                 // not a formula at all
        ]);
        assert_eq!(
            volatile_cells_on_active_sheet(&grid),
            vec![(0, 0), (1, 0), (2, 0), (3, 0)],
        );
    }

    #[test]
    fn the_roots_come_back_sorted_so_the_cascade_shape_is_deterministic() {
        // Hash iteration order must not decide which cell recalculates first,
        // or two identical workbooks recalculate differently.
        let grid = grid_with(&[
            (9, 3, "=RAND()"),
            (0, 0, "=NOW()"),
            (4, 1, "=TODAY()"),
        ]);
        assert_eq!(
            volatile_cells_on_active_sheet(&grid),
            vec![(0, 0), (4, 1), (9, 3)],
        );
    }

    #[test]
    fn the_splice_adds_the_volatile_cell_and_everything_downstream_of_it() {
        // A1 = NOW(), A2 = A1+1. Refreshing A1 without A2 would leave A2
        // disagreeing with the cell it reads — worse than both being stale.
        let grid = grid_with(&[(0, 0, "=NOW()"), (1, 0, "=A1+1")]);
        let deps = dependents(&[((0, 0), (1, 0))]);
        let mut order: Vec<(u32, u32)> = Vec::new();
        let mut set = crate::CoordSet::default();

        splice_volatile_cascade_roots(
            &grid,
            &deps,
            &crate::StripeDependentsMap::default(),
            &crate::StripeDependentsMap::default(),
            None,
            &mut order,
            &mut set,
        );

        assert_eq!(order, vec![(0, 0), (1, 0)], "precedent before dependent");
    }

    #[test]
    fn the_cell_the_edit_already_evaluated_is_not_added_again() {
        // `update_cell` evaluates the edited cell before the cascade starts and
        // its convention is that the cell is NOT a member of the recalc order.
        let grid = grid_with(&[(0, 0, "=NOW()"), (1, 0, "=A1+1")]);
        let deps = dependents(&[((0, 0), (1, 0))]);
        let mut order: Vec<(u32, u32)> = Vec::new();
        let mut set = crate::CoordSet::default();

        splice_volatile_cascade_roots(
            &grid,
            &deps,
            &crate::StripeDependentsMap::default(),
            &crate::StripeDependentsMap::default(),
            Some((0, 0)),
            &mut order,
            &mut set,
        );

        assert_eq!(order, vec![(1, 0)]);
    }

    #[test]
    fn a_whole_column_reader_of_a_volatile_cell_is_appended_too() {
        // `=SUM(A:A)` over a RAND column has no per-cell edge — the stripe maps
        // carry it, and they are consulted for the edited cell already.
        let grid = grid_with(&[(0, 0, "=RAND()"), (0, 5, "=SUM(A:A)")]);
        let mut order: Vec<(u32, u32)> = Vec::new();
        let mut set = crate::CoordSet::default();

        splice_volatile_cascade_roots(
            &grid,
            &crate::DependencyMap::default(),
            &stripe(&[(0, (0, 5))]),
            &crate::StripeDependentsMap::default(),
            None,
            &mut order,
            &mut set,
        );

        assert_eq!(order, vec![(0, 0), (0, 5)]);
    }

    #[test]
    fn a_sheet_with_no_volatile_formula_leaves_the_cascade_exactly_as_it_was() {
        // The zero-result path must not disturb an order the edit already built.
        let grid = grid_with(&[(0, 0, "1"), (1, 0, "=A1+1")]);
        let mut order = vec![(1, 0)];
        let mut set: crate::CoordSet = order.iter().copied().collect();

        splice_volatile_cascade_roots(
            &grid,
            &dependents(&[((0, 0), (1, 0))]),
            &crate::StripeDependentsMap::default(),
            &crate::StripeDependentsMap::default(),
            Some((0, 0)),
            &mut order,
            &mut set,
        );

        assert_eq!(order, vec![(1, 0)]);
    }

    #[test]
    fn both_apply_paths_still_splice_the_volatile_roots() {
        // A source tripwire, for the reason the writeback wiring test below has
        // one: these are the two places an edit becomes a cascade, they have
        // drifted apart before, and a volatile splice missing from ONE of them
        // means "NOW() refreshes when you type but not when you paste" — which
        // nothing in the UI would report.
        //
        // Since the BUG-0476 follow-up both paths -- and the CUBE pre-fetch,
        // which must cover exactly what they evaluate -- build the order through
        // `active_sheet_write_cascade`, so the splice is asserted there and the
        // two paths are asserted to call it.
        const DATA_RS: &str = include_str!("data.rs");
        let body_of = |func: &str| -> &str {
            let start = DATA_RS
                .find(func)
                .unwrap_or_else(|| panic!("no `{}` in source", func));
            let rest = &DATA_RS[start + func.len()..];
            let end = rest
                .find("\n#[tauri::command]")
                .into_iter()
                .chain(rest.find("\n#[cfg(test)]"))
                .chain(rest.find("\npub(crate) fn "))
                .chain(rest.find("\nfn "))
                .min()
                .unwrap_or(rest.len());
            &rest[..end]
        };
        assert!(
            body_of("fn active_sheet_write_cascade(").contains("splice_volatile_cascade_roots("),
            "the shared write cascade does not splice the volatile built-ins — \
             NOW()/RAND()/OFFSET() go stale on every edit and paste",
        );
        for func in ["fn update_cell_impl(", "fn update_cells_batch_core("] {
            assert!(
                body_of(func).contains("active_sheet_write_cascade("),
                "`{}` builds its cascade without the shared `active_sheet_write_cascade` \
                 — the volatile built-ins go stale through that path, and the CUBE \
                 pre-fetch no longer covers what it evaluates",
                func,
            );
        }
    }
}

#[cfg(test)]
mod writeback_range_guard_wiring_tests {
    //! WIRING proof for the range-level writeback claim guard.
    //!
    //! The guard's POLICY is unit-tested next to its definition
    //! (`calp_commands::writeback_claim_tests`). What cannot be tested there is
    //! that every grid-mutating command actually calls it: these are
    //! `#[tauri::command]` functions taking `State<AppState>`, and `tauri::State`
    //! has no constructor available to a unit test — there is no way to invoke
    //! `sort_range` or `delete_rows` in-process.
    //!
    //! So the wiring is asserted against the SOURCE. This is not a substitute
    //! for behaviour coverage; it is a tripwire for the one regression that
    //! actually happened before — a grid-mutating path shipped with no writeback
    //! check at all — and it fails loudly the moment someone deletes a guard
    //! call or adds a lock/undo transaction ahead of one.

    const DATA_RS: &str = include_str!("data.rs");
    const STRUCTURE_RS: &str = include_str!("structure.rs");
    const SEARCH_RS: &str = include_str!("search.rs");
    const MERGE_RS: &str = include_str!("../merge_commands.rs");

    /// The body of `pub fn {name}` up to the start of the next item.
    fn body_of<'a>(source: &'a str, name: &str) -> &'a str {
        let needle = format!("pub fn {}(", name);
        let start = source
            .find(&needle)
            .unwrap_or_else(|| panic!("no `pub fn {}(` in source", name));
        let rest = &source[start + needle.len()..];
        let end = rest
            .find("\n#[tauri::command]")
            .into_iter()
            .chain(rest.find("\npub fn "))
            .chain(rest.find("\n#[cfg(test)]"))
            .min()
            .unwrap_or(rest.len());
        &rest[..end]
    }

    /// Every grid-mutating command that can touch a rectangle without going
    /// through `update_cell_impl`, with the guard it must call.
    fn guarded_commands() -> Vec<(&'static str, &'static str, &'static str)> {
        vec![
            // (source, command, required guard call)
            (DATA_RS, "sort_range", "ensure_range_unclaimed("),
            (DATA_RS, "clear_cell", "ensure_range_unclaimed("),
            (DATA_RS, "clear_range", "ensure_range_unclaimed("),
            // The two commands delegate to these bodies (testability split).
            (DATA_RS, "clear_range_with_options_inner", "ensure_range_unclaimed("),
            (DATA_RS, "clear_range_on_sheets_inner", "ensure_range_unclaimed_on_sheets("),
            // The command delegates to this body (testability split).
            (DATA_RS, "fill_range_core", "ensure_range_unclaimed("),
            (STRUCTURE_RS, "insert_rows", "ensure_row_shift_unclaimed("),
            (STRUCTURE_RS, "delete_rows", "ensure_row_shift_unclaimed("),
            (STRUCTURE_RS, "insert_columns", "ensure_col_shift_unclaimed("),
            (STRUCTURE_RS, "delete_columns", "ensure_col_shift_unclaimed("),
            (SEARCH_RS, "replace_all", "ensure_cells_unclaimed("),
            (SEARCH_RS, "replace_single", "ensure_range_unclaimed("),
            // The commands delegate to these bodies (unit-testable twins).
            (MERGE_RS, "merge_cells_core", "ensure_range_unclaimed("),
            (MERGE_RS, "unmerge_cells_core", "ensure_range_unclaimed("),
        ]
    }

    #[test]
    fn every_range_mutating_command_calls_the_writeback_claim_guard() {
        for (source, command, guard) in guarded_commands() {
            let body = body_of(source, command);
            assert!(
                body.contains(guard),
                "`{}` mutates a range of the grid without calling `{}` — a script, \
                 the AI or any other caller could destroy a published writeback \
                 region through it",
                command,
                guard,
            );
        }
    }

    #[test]
    fn the_guard_runs_before_the_undo_transaction_is_opened() {
        // A refusal must be a clean no-op: never a half-applied mutation, never
        // a dangling open transaction. That holds only if the guard precedes
        // `begin_transaction` in the command body.
        let mut checked = 0;
        for (source, command, guard) in guarded_commands() {
            let body = body_of(source, command);
            // Either spelling of the begin: most commands open through the
            // owned door now (engine::OwnedTransaction), and the text
            // "begin_owned_transaction" does not contain "begin_transaction" --
            // searching for the old spelling alone would silently skip them.
            let Some(txn) = ["begin_owned_transaction(", "begin_transaction("]
                .iter()
                .filter_map(|needle| body.find(needle))
                .min()
            else {
                continue; // this command opens none
            };
            let guard_at = body.find(guard).expect("wiring test asserts presence");
            assert!(
                guard_at < txn,
                "`{}` opens its undo transaction before calling `{}` — a refusal \
                 would leave the transaction dangling",
                command,
                guard,
            );
            checked += 1;
        }
        // VACUITY FLOOR. The begin is found by its TEXT, and renaming the door
        // (it happened: begin_owned_transaction, 2026-09-29) makes every command
        // look as if it "opens none" -- a census that checks nothing and passes.
        assert!(
            checked >= 6,
            "only {} guarded command(s) were seen opening an undo transaction; the begin \
             search no longer matches how commands open one",
            checked
        );
    }

    #[test]
    fn no_guarded_command_still_carries_the_old_silent_skip() {
        // The pre-fix behaviour of `replace_all` / `replace_single` was to skip
        // claimed cells and say nothing actionable about it. Both now refuse the
        // whole gesture, so neither may reach into the index by hand again.
        for command in ["replace_all", "replace_single"] {
            let body = body_of(SEARCH_RS, command);
            assert!(
                !body.contains("state.writeback_index"),
                "`{}` reaches into the writeback index directly instead of using \
                 the shared guard — that is how the silent-skip behaviour came back",
                command,
            );
        }
        // `fill_range`'s hand-rolled guard was the original; it must stay folded
        // into the shared one so all these commands refuse identically.
        let fill = body_of(DATA_RS, "fill_range_core");
        assert!(
            !fill.contains("regions_overlapping"),
            "`fill_range` re-grew its own writeback check instead of using the \
             shared guard",
        );
    }
}

/// BUG-0019 — cross-sheet recalculation on the edit path. A CHILD module of
/// `data` (not a sibling under `commands`) because it drives `update_cell_impl`
/// and `cascade_cross_sheet_dependents`, both private here.
#[cfg(test)]
#[path = "cross_sheet_recalc_tests.rs"]
mod cross_sheet_recalc_tests;

#[cfg(test)]
#[path = "floating_range_lifecycle_tests.rs"]
mod floating_range_lifecycle_tests;

#[cfg(test)]
#[path = "floating_range_recalc_tests.rs"]
mod floating_range_recalc_tests;

/// P3 S2 -- cell targets: the resolver, the extent, HOST protection on every
/// door to a floating grid's cells, the styled read, and hidden lines on the
/// object row. A child of this module for the shared `Workbook` harness; the
/// file lives beside `cell_target.rs`.
#[cfg(test)]
#[path = "../cell_target_tests.rs"]
mod cell_target_tests;

/// P3 S4 -- content, clear, sort, fill, the batch write, merge, search, Go To
/// Special and conditional formatting on a CELL TARGET (a floating grid's
/// cells). A child of this module for the shared `Workbook` harness.
#[cfg(test)]
#[path = "cell_target_content_tests.rs"]
mod cell_target_content_tests;

/// P3 S5 -- whole rows/columns with table semantics, and line sizes and
/// hidden lines on a floating grid's own maps (a CELL TARGET's lines). A
/// child of this module for the shared `Workbook` harness.
#[cfg(test)]
#[path = "structure_target_tests.rs"]
mod structure_target_tests;

/// Canvas sheets (M1): the kind authority and the write-refusal doors. A CHILD
/// module of `data` for the same reason as above: it drives `update_cell_impl`.
#[cfg(test)]
#[path = "canvas_sheet_tests.rs"]
mod canvas_sheet_tests;

/// CONTRACT-CANVAS 4.7: a canvas's wallpaper and LOCK OBJECTS, and every
/// geometry door refusing a move on a locked page. A CHILD module of `data`
/// only to reuse the `cross_sheet_recalc_tests::Workbook` harness.
#[cfg(test)]
#[path = "canvas_objects_lock_tests.rs"]
mod canvas_objects_lock_tests;

/// WP-C S7 (D-FORMAT): the visual container through each family's own door
/// (slicer, timeline, floating grid, chart, control appearance batch). A CHILD
/// module of `data` only to reuse the `cross_sheet_recalc_tests::Workbook`
/// harness.
#[cfg(test)]
#[path = "visual_container_tests.rs"]
mod visual_container_tests;

/// §2c follow-on — bulk range commands that rewrite cells must seed the ONE
/// shared cascade, and cycles must be detected across sheet boundaries. Also a
/// CHILD module of `data` for the same reason as above.
#[cfg(test)]
#[path = "bulk_rewrite_recalc_tests.rs"]
mod bulk_rewrite_recalc_tests;

/// D1 — Calculate Now (F9) is the WORKBOOK and Calculate Sheet (Shift+F9) is the
/// active sheet, as in Excel. A CHILD module of `data` for the same reason as
/// above: it reuses the `Workbook` harness those two share.
#[cfg(test)]
#[path = "calculate_scope_tests.rs"]
mod calculate_scope_tests;

/// D3 — the pivot, table and cut/paste-relocation writes must seed the ONE
/// shared cascade. The last eight `EXEMPT` cell-writing functions. A CHILD
/// module of `data` for the same reason as above.
#[cfg(test)]
#[path = "d3_cascade_seed_tests.rs"]
mod d3_cascade_seed_tests;

/// D2 — a typed formula keeps its NAME and the name resolves at EVALUATION, as
/// in Excel, with a name -> dependents edge so repointing one moves every
/// formula that reads it. A CHILD module of `data` for the same reason as above.
#[cfg(test)]
#[path = "d2_named_range_tests.rs"]
mod d2_named_range_tests;

/// §2aj — a typed formula keeps its STRUCTURED REFERENCE and the specifier
/// resolves at EVALUATION, as in Excel, with a table -> dependents edge so
/// growing, shrinking, renaming or deleting a table moves every formula that
/// reads it. Carries §2ai (the sheet-qualifier restamp) too, because the two are
/// the same lexer defect with different authorities. A CHILD module of `data`
/// for the same reason as above.
#[cfg(test)]
#[path = "structured_ref_tests.rs"]
mod structured_ref_tests;

/// §2y — the spill map has ONE maintainer, and every path that removes or
/// overwrites a spill ORIGIN reaches it. A CHILD module of `data` for the same
/// reason as above: it drives `check_spill_protection`, the shared tear-down
/// and `recalc_after_active_sheet_bulk_rewrite`, all private here.
#[cfg(test)]
#[path = "spill_map_tests.rs"]
mod spill_map_tests;

/// §2ab — a dynamic array's OWNERSHIP survives a save and a reload, over a REAL
/// `.cala` round trip. A CHILD module of `data` for the same reason as above:
/// it reuses the `Workbook` harness and drives the shared cascade.
#[cfg(test)]
#[path = "spill_persistence_tests.rs"]
mod spill_persistence_tests;

/// §3bm — the RECALCULATION pass spills, exactly as an edit does: F9, Shift+F9,
/// the background whole-sheet pass and the cross-sheet walk all end in THE ONE
/// SPILL DECISION. A CHILD module of `data` for the same reason as above.
#[cfg(test)]
#[path = "recalc_spill_tests.rs"]
mod recalc_spill_tests;

/// Excel's xlPending under manual calculation: an edit a formula depends on
/// reports calculation incomplete until a completed Calculate Now. A CHILD
/// module of `data` for the same reason as above: it reuses the `Workbook`
/// harness and drives the real edit paths.
#[cfg(test)]
#[path = "manual_calc_state_tests.rs"]
mod manual_calc_state_tests;

/// §3bf — `A1#` is a LIVE reference: the stored formula keeps the `#` and it
/// resolves at EVALUATION against the current extent, with a dependency edge,
/// exactly as D2 does for a defined name and §2aj for a structured reference.
/// A CHILD module of `data` for the same reason as above.
#[cfg(test)]
#[path = "spill_ref_tests.rs"]
mod spill_ref_tests;

/// D8 / §2s — a structural edit must recalculate, because a formula whose value
/// depends on the SHAPE or POSITION of its reference (or of its own cell) goes
/// stale when rows or columns move under it. A CHILD module of `data` for the
/// same reason as above.
#[cfg(test)]
#[path = "d8_structural_recalc_tests.rs"]
mod d8_structural_recalc_tests;

/// Excel's Merge menu (2026-10-02): the `MergeOptions` the ribbon gestures pass
/// to `merge_cells` (across, absorb, the value rule, the probe), the range form
/// of `unmerge_cells` and the rectangle filter of `get_merged_regions`. A CHILD
/// module of `data` for the same reason as above: it drives the merge bodies
/// through the shared `Workbook` harness.
#[cfg(test)]
#[path = "merge_commands_tests.rs"]
mod merge_commands_tests;

/// BUG-0054 — a structural delete that fully covers a pivot region must give
/// the pivot the same death `delete_pivot_table` gives one (cascade, undo
/// restore, views/active cleanup). A CHILD module of `data` for the same
/// reason as above.
#[cfg(test)]
#[path = "pivot_structural_delete_tests.rs"]
mod pivot_structural_delete_tests;

/// BUG-0104 — sorting by conditional-formatting ICON orders by the icon on
/// screen, and refuses the three cases it cannot answer. A CHILD module of
/// `data` so it can reach `validate_sort_fields`.
#[cfg(test)]
#[path = "icon_sort_tests.rs"]
mod icon_sort_tests;

/// Clear Hyperlinks / Remove Hyperlinks through `clear_range_with_options`
/// (`applyTo` "hyperlinks" / "removeHyperlinks"): they were a placeholder that
/// removed no link (and, for Remove, reset EVERY cell's style). A CHILD module
/// of `data` so it can reach `clear_hyperlinks_apply_to`.
#[cfg(test)]
#[path = "clear_hyperlinks_tests.rs"]
mod clear_hyperlinks_tests;

/// Clear Formats / Clear All over row and column FORMATS (review A#1), and the
/// sheet group's all-or-nothing, one-call clear (review G#1 / G#8 / G#9). A
/// CHILD module of `data` so it can drive `clear_range_with_options_inner` and
/// `clear_range_on_sheets_inner` in-process.
#[cfg(test)]
#[path = "clear_tiers_tests.rs"]
mod clear_tiers_tests;

/// A DEPENDENT a cascade re-evaluates is evaluated AT ITS OWN CELL (ROW()/
/// COLUMN(), `@`, the cube and custom-function preserve) and spills -- the batch
/// cascade, the fill cascade and the cross-sheet walk. A CHILD module of `data`
/// for the same reason as above: it reuses the `Workbook` harness.
#[cfg(test)]
#[path = "cascade_position_tests.rs"]
mod cascade_position_tests;

/// A PASTE keeps its kind in a Text-formatted cell (`CellUpdateInput::pasted`,
/// on the sheet and on a floating grid), and the typed read marks exactly the
/// cells whose formula it withheld (`TypedCellData::formula_withheld`). A
/// CHILD module of `data` for the same reason as above.
#[cfg(test)]
#[path = "paste_kind_tests.rs"]
mod paste_kind_tests;

/// A sheet paste's FORMAT on a protected sheet (`update_cells_batch_core`): the
/// Format Cells option and the destination's Locked flag (Excel [LIVE]). A
/// CHILD module of `data` for the same reason as above.
#[cfg(test)]
#[path = "protected_paste_format_tests.rs"]
mod protected_paste_format_tests;

/// A MOVED cell's format on a protected sheet (`CellUpdateInput::moved`), a
/// blank write that names no style, and the style-only batch door
/// (`set_cell_styles_core`). A CHILD module of `data` for the same reason.
#[cfg(test)]
#[path = "protected_move_format_tests.rs"]
mod protected_move_format_tests;

/// A batch write keeps a literal it writes into a spill the same batch made,
/// and re-spills an array whose blocker it blanked; a fill copies a spilled
/// value as blank. A CHILD module of `data` for the same reason as above: it
/// drives `update_cells_batch_core` through the `Workbook` harness.
#[cfg(test)]
#[path = "spill_batch_fill_tests.rs"]
mod spill_batch_fill_tests;

/// A MOVE (drag, Cut + Paste) re-points references INTO the moved block --
/// in the moved formulas themselves, on every sheet and in defined names --
/// and leaves every other reference alone (`relocate_cell_references_core`).
/// A CHILD module of `data` for the same reason as above.
#[cfg(test)]
#[path = "move_relocation_tests.rs"]
mod move_relocation_tests;

/// Fill Right / Fill Down / Copy+Paste keep a LET / LAMBDA name spelled as a
/// column range (`b:b`) a name (`structure::shift_formula_internal_with_tables`).
/// A CHILD module of `data` for the same reason as above.
#[cfg(test)]
#[path = "let_name_fill_tests.rs"]
mod let_name_fill_tests;
