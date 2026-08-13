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
    extract_all_references, format_cell_value, get_column_row_dependents,
    get_recalculation_order, parse_cell_input, parse_cell_input_invariant,
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
fn formula_display(cell: &engine::Cell, locale: &engine::LocaleSettings) -> Option<String> {
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
    let mut spill_ranges = state.spill_ranges.lock().unwrap();
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
    let spill_ranges = state.spill_ranges.lock().unwrap();
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
    let spill_ranges = state.spill_ranges.lock().unwrap();
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
        let mut spill_ranges = state.spill_ranges.lock().unwrap();
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
            let display = format_cell_value(cv, styles.get(effective), locale);
            updated_cells.push(CellData {
                row: target_r,
                col: target_c,
                display,
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
fn check_region_cells_protection<'a>(
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
    let spill_ranges = state.spill_ranges.lock().unwrap();
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

            let (display, display_color, formula, style_index, rich_text, accounting_layout) = if let Some(c) = cell {
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
                (result.text, result.color, formula, effective_style_index, rt, acct)
            } else {
                (String::new(), None, None, effective_style_index, None, None)
            };

            cells.push(CellData {
                row,
                col,
                display,
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
            let formula = if hide {
                None
            } else {
                formula_display(cell, &locale)
            };
            // A style-only cell (no value, no formula) adds nothing the caller's
            // empty fill does not already say — keep the payload sparse.
            if kind == "empty" && formula.is_none() && display.is_empty() {
                continue;
            }
            out.push(crate::api_types::TypedCellData {
                row,
                col,
                value,
                display,
                formula,
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
                display: r.text,
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
#[tauri::command]
pub fn get_cell_collection(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> crate::api_types::CollectionPreviewResult {
    use crate::api_types::{CollectionEntry, CollectionItem, CollectionPreviewResult};
    use engine::cell::{CellValue, DictKey};

    let grid = state.grid.read().unwrap();

    fn cell_value_to_item(val: &CellValue, depth: usize) -> CollectionItem {
        if depth > 32 {
            return CollectionItem::Scalar {
                display: "...".to_string(),
            };
        }
        match val {
            CellValue::List(items) => CollectionItem::List {
                count: items.len(),
                items: items.iter().map(|i| cell_value_to_item(i, depth + 1)).collect(),
            },
            CellValue::Dict(entries) => CollectionItem::Dict {
                count: entries.len(),
                entries: entries
                    .iter()
                    .map(|(k, v)| {
                        let key = match k {
                            DictKey::Text(s) => format!("\"{}\"", s),
                            DictKey::Number(n) => {
                                if n.fract() == 0.0 && n.abs() < 1e15 {
                                    format!("{:.0}", n)
                                } else {
                                    format!("{}", n)
                                }
                            }
                            DictKey::Boolean(b) => {
                                if *b { "TRUE" } else { "FALSE" }.to_string()
                            }
                        };
                        CollectionEntry {
                            key,
                            value: cell_value_to_item(v, depth + 1),
                        }
                    })
                    .collect(),
            },
            CellValue::Empty => CollectionItem::Scalar {
                display: String::new(),
            },
            CellValue::Number(n) => CollectionItem::Scalar {
                display: if n.fract() == 0.0 && n.abs() < 1e15 {
                    format!("{:.0}", n)
                } else {
                    format!("{}", n)
                },
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

    match grid.get_cell(row, col) {
        Some(cell) => match &cell.value {
            CellValue::List(items) => CollectionPreviewResult {
                cell_type: "list".to_string(),
                root: Some(CollectionItem::List {
                    count: items.len(),
                    items: items.iter().map(|i| cell_value_to_item(i, 0)).collect(),
                }),
            },
            CellValue::Dict(entries) => CollectionPreviewResult {
                cell_type: "dict".to_string(),
                root: Some(CollectionItem::Dict {
                    count: entries.len(),
                    entries: entries
                        .iter()
                        .map(|(k, v)| {
                            let key = match k {
                                DictKey::Text(s) => format!("\"{}\"", s),
                                DictKey::Number(n) => {
                                    if n.fract() == 0.0 && n.abs() < 1e15 {
                                        format!("{:.0}", n)
                                    } else {
                                        format!("{}", n)
                                    }
                                }
                                DictKey::Boolean(b) => {
                                    if *b { "TRUE" } else { "FALSE" }.to_string()
                                }
                            };
                            CollectionEntry {
                                key,
                                value: cell_value_to_item(v, 0),
                            }
                        })
                        .collect(),
                }),
            },
            _ => CollectionPreviewResult {
                cell_type: "none".to_string(),
                root: None,
            },
        },
        None => CollectionPreviewResult {
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
    let display = format_cell_value(&cell.value, style, locale);

    Some(CellData {
        row,
        col,
        display,
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
/// lock re-entry.
#[allow(clippy::too_many_arguments)]
fn update_cell_impl(
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
    if let Ok(mut pending) = state.pending_recalc.lock() {
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
    let pivot_data_fn = |data_field: &str, pivot_row: u32, pivot_col: u32, pairs: &[(&str, &str)]| -> Option<f64> {
        crate::pivot::operations::lookup_pivot_data(
            &pivot_tables,
            &pivot_views,
            data_field,
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
        // Parse the input
        let mut cell = parse_cell_input(&value, &locale);

        // Preserve existing style
        if let Some(existing) = grid.get_cell(row, col) {
            cell.style_index = existing.style_index;
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
        let display = format_cell_value(&cell.value, style, &locale);
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

        // Get direct cell dependents
        let mut recalc_order = get_recalculation_order((row, col), &dependents_map);

        log_debug!("DEPS", "cascade for ({},{}) recalc_order={:?} dependents_entry={:?}",
            row, col, recalc_order, dependents_map.get(&(row, col)));

        // Also get column/row dependents (formulas with column or row references)
        // Use a set for O(1) lookup instead of O(n) Vec::contains
        let mut recalc_set: crate::CoordSet = recalc_order.iter().copied().collect();
        let col_row_deps =
            get_column_row_dependents((row, col), &column_dependents_map, &row_dependents_map);
        for dep in col_row_deps {
            if recalc_set.insert(dep) {
                recalc_order.push(dep);
            }
        }
        // VOLATILE UDF cells (Excel's Application.Volatile): cells calling a
        // function the author marked volatile recalculate on every edit even
        // though no dependency edge reaches them. `collect_udf_calls` found
        // them and already resolved their calls into `udf_results`, so the
        // resolver below can serve them. Empty (usually None) for every
        // workbook without a volatile UDF, so the hot path is untouched.
        if let Some(volatile) = &udf_volatile_cells {
            for v in volatile {
                if (v.row, v.col) != (row, col) && recalc_set.insert((v.row, v.col)) {
                    recalc_order.push((v.row, v.col));
                }
            }
        }
        // ARRAYS THIS EDIT UNBLOCKED. A dynamic array blocked by an occupied
        // cell is `#SPILL!`, and clearing the obstruction is the remedy the
        // error names -- but the origin does not DEPEND on the cell that was in
        // its way, so no dependency edge reaches it and the cascade walked
        // straight past. The array stayed `#SPILL!` until the user re-entered
        // the formula, which is the one thing the error message does not tell
        // them to do. (Excel re-spills the instant the blocker is cleared.)
        //
        // `spill_blocks` is what makes this cheap: it already records WHICH
        // cell blocked each origin, for the error message, so unblocking is a
        // reverse lookup on a map that is empty in every workbook with no
        // blocked array. Convergent when several cells block one array -- the
        // re-evaluation simply records the next blocker and stays `#SPILL!`.
        for origin in origins_blocked_by(&state, active_sheet, row, col) {
            if origin != (row, col) && recalc_set.insert(origin) {
                recalc_order.push(origin);
                // ...and whatever reads the array, which was reading an error.
                for dep in get_recalculation_order(origin, &dependents_map) {
                    if recalc_set.insert(dep) {
                        recalc_order.push(dep);
                    }
                }
            }
        }
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

    Ok(UpdateCellResult { cells: updated_cells, dimension_changes, needs_style_refresh, slicer_changed })
}

/// Re-evaluate ONE formula cell on the ACTIVE sheet with full spill handling —
/// the shared body of `update_cell`'s dependent cascade, extracted so targeted
/// recalc paths (`recalc_control_dependents` in control_values.rs) reuse the
/// exact same spill-aware logic. `update_cell` remains the hottest path: keep
/// this mechanical.
///
/// Each cell is evaluated with an `EvalContext` carrying ITS OWN position
/// (`current_row`/`current_col`) — required for the preserve-on-no-prefetch
/// semantics: `preserved_cube_value` / `preserved_udf_value` (evaluator.rs)
/// read the cell's stored value through the position when no cube prefetch /
/// UDF resolver is supplied, so cube-bearing dependents keep their last value
/// instead of collapsing to #N/A (and UDF-bearing ones to #NAME?).
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
    let dep_display = format_cell_value(&updated_dep.value, dep_style, locale);

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
        display: dep_display,
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
/// Still no per-cell position/preserve context, which is unchanged.
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

    // Use the cached AST if available; otherwise re-parse the rendered string.
    let raw_result = if let Some(cached_ast) = dep_cell.get_cached_ast() {
        // Defined names are expanded on the way into the evaluator (D2), against
        // the DEPENDENT'S OWN sheet — a sheet-scoped name means something
        // different over there, and this walk is on another sheet by definition.
        let eval_target = crate::name_resolution::eval_ast(
            cached_ast,
            &name_tables.at(dep_sheet_idx, dep_row, dep_col),
        );
        crate::evaluate_formula_raw_with_ast_files_and_cube(
            &*grids,
            sheet_names,
            dep_sheet_idx,
            &eval_target,
            user_files,
            None,
            None,
            Some(control_values.clone()),
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
    let dep_display = format_cell_value(&updated_dep.value, dep_style, locale);

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
        display: dep_display,
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
/// [`apply_spill_decision`], on their own sheet — see `recalc_walked_cell`.
/// What they still do not get is per-cell position/preserve context.
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
    // The cross-sheet half of the dependent cascade. Takes no `AppState`, so it
    // cannot install a token of its own — it inherits its caller's surface,
    // which is exactly right: this is the same edit, continuing onto another
    // sheet, and it must not get a different ceiling for having crossed one.
    let _governor = crate::eval_budget::inherit_or(crate::eval_budget::EvalSurface::Interactive);
    let current_sheet_name = sheet_names.get(active_sheet).cloned().unwrap_or_default();

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
        processed.insert((active_sheet, r, c));
        if queued.insert((active_sheet, r, c)) {
            work_queue.push((active_sheet, current_sheet_name.clone(), r, c));
        }
    }

    // Per-sheet dependency indexes, built on first use (see SheetDependencyIndex).
    let mut sheet_indexes: std::collections::HashMap<usize, SheetDependencyIndex> =
        std::collections::HashMap::new();

    while let Some((_source_sheet_idx, source_sheet_name, source_row, source_col)) =
        work_queue.pop()
    {
        let cross_sheet_key = (source_sheet_name, source_row, source_col);
        let Some(cross_deps) = cross_sheet_dependents_map.get(&cross_sheet_key).cloned() else {
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
) -> Result<Vec<CellData>, String> {
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

    // Plain refs that outlive the State wrappers moved into the core below
    // (tauri's State::inner returns &'r T) — needed for the post-batch recalc.
    let state_ref = state.inner();
    let user_files_ref = user_files_state.inner();
    let pivot_ref = pivot_state.inner();
    let pane_ref = pane_control_state.inner();
    let ribbon_ref = ribbon_filter_state.inner();

    let mut cells = update_cells_batch_core(
        state,
        file_state,
        user_files_state,
        pivot_state,
        updates,
        udf_results,
        udf_volatile_cells,
        Some(control_values),
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
/// they get no volatile-UDF splice either — exactly as before.
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
        state,
        file_state,
        user_files_state,
        pivot_state,
        updates,
        udf_results,
        None,
        control_values,
    )
}

/// The batch body. Split from `update_cells_batch_with_controls` so the Tauri
/// command can pass the volatile-UDF cell list the frontend's pre-fetch found
/// without changing the signature Rust-side callers (script apply / MCP tools)
/// already use.
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_cells_batch_core(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    updates: Vec<crate::api_types::CellUpdateInput>,
    udf_results: Option<std::collections::HashMap<String, crate::scripting::udf::UdfValue>>,
    udf_volatile_cells: Option<Vec<crate::scripting::udf::UdfCellRef>>,
    control_values: Option<std::sync::Arc<crate::control_values::ControlValuesMap>>,
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
    let styles = state.style_registry.read().unwrap();
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
    let pivot_data_fn = |data_field: &str, pivot_row: u32, pivot_col: u32, pairs: &[(&str, &str)]| -> Option<f64> {
        crate::pivot::operations::lookup_pivot_data(
            &pivot_tables,
            &pivot_views,
            data_field,
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

    // Process each update
    for update in &updates {
        let row = update.row;
        let col = update.col;
        let value = &update.value;

        // Check if cell is in a protected region
        // Note: We skip the check here since fill operations should not target protected cells
        // and checking 240 cells individually would be slow. The frontend should validate.

        // Record previous state for undo
        let previous_cell = grid.get_cell(row, col).cloned();

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

        // Handle empty value - clear the cell
        if value.trim().is_empty() {
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
                display_color: None,
                formula: None,
                style_index: 0,
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
        let mut cell = if update.invariant.unwrap_or(false) {
            parse_cell_input_invariant(value, &locale)
        } else {
            parse_cell_input(value, &locale)
        };

        // Apply explicit style from input if provided, otherwise preserve existing
        if let Some(explicit_style) = update.style_index {
            cell.style_index = explicit_style;
        } else if let Some(existing) = grid.get_cell(row, col) {
            cell.style_index = existing.style_index;
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

                    // Use raw evaluation to get EvalResult for spill handling
                    let eval_ctx = engine::EvalContext {
                        cube_prefetch: None,
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
        let display = format_cell_value(&cell.value, style, &locale);

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

    // Recalculate dependents if automatic mode - do this ONCE after all updates
    if *calc_mode == "automatic" {
        // One multi-root traversal for the whole batch: a single BFS + Kahn
        // over the union of affected cells instead of one full pass per edited
        // cell. Batch cells are members of the ordering, so a formula written
        // by this batch is re-evaluated AFTER the batch cells it reads (fixes
        // in-batch stale values); value-only batch cells are skipped by the
        // formula check in the evaluation loop below.
        let mut all_recalc_order: Vec<(u32, u32)> =
            crate::recalc_order_from_seeds(&cells_needing_recalc, &dependents_map, true);
        let mut recalc_set: crate::CoordSet = all_recalc_order.iter().copied().collect();

        // Also get column/row dependents (appended after the topological
        // order, mirroring update_cell).
        for (row, col) in &cells_needing_recalc {
            let col_row_deps =
                get_column_row_dependents((*row, *col), &column_dependents_map, &row_dependents_map);
            for dep in col_row_deps {
                if recalc_set.insert(dep) {
                    all_recalc_order.push(dep);
                }
            }
        }

        // VOLATILE UDF cells: recalculate on every batch even without a
        // dependency edge (see the same splice in update_cell_impl). None for
        // every workbook with no volatile UDF, and for Rust-side callers.
        if let Some(volatile) = &udf_volatile_cells {
            for v in volatile {
                if recalc_set.insert((v.row, v.col)) {
                    all_recalc_order.push((v.row, v.col));
                }
            }
        }

        // Lock table state for cascade recalculation
        let batch_tables = state.tables.read().unwrap();
        let batch_table_names = state.table_names.read().unwrap();
        let batch_named_ranges = state.named_ranges.read().unwrap();

        // PERF-20: skip per-dependent formula render + IPC payload for wide cascades.
        let include_cascade_formulas = all_recalc_order.len() <= CASCADE_FORMULA_LIMIT;

        // The same-sheet cascade evaluates UDF-bearing dependents WITH the
        // pre-fetched resolver. Without it every such cell took the
        // no-resolver branch, and because this evaluator carries no
        // current_row/current_col, `preserved_udf_value` had nothing to
        // preserve and returned #NAME? — the paste/fill corruption. The
        // collect pass covers exactly this recalc order (same seeds, same
        // helpers), so every cell reached here has an entry to serve.
        let batch_udf: Option<&dyn Fn(&str, &[EvalResult]) -> Option<EvalResult>> =
            udf_resolver.as_ref().map(|r| r as &dyn Fn(&str, &[EvalResult]) -> Option<EvalResult>);

        // Recalculate all dependents
        for (dep_row, dep_col) in &all_recalc_order {
            if let Some(dep_cell) = grid.get_cell(*dep_row, *dep_col) {
                if let Some(formula) = dep_cell.formula_string() {
                    let result = if let Some(cached_ast) = dep_cell.get_cached_ast() {
                        // Names expand on the way into the evaluator (D2).
                        let eval_target = crate::name_resolution::eval_ast(
                            cached_ast,
                            &crate::name_resolution::NameTables {
                                named_ranges: &batch_named_ranges,
                                tables: &batch_tables,
                                table_names: &batch_table_names,
                                sheet_names: &sheet_names,
                                spill_ranges: &state.spill_ranges,
                            }
                            .at(active_sheet, *dep_row, *dep_col),
                        );
                        crate::evaluate_formula_raw_with_ast_files_and_cube(
                            &grids,
                            &sheet_names,
                            active_sheet,
                            &eval_target,
                            &user_files,
                            batch_udf,
                            None,
                            Some(control_values.clone()),
                        ).to_cell_value()
                    } else {
                        // UNREACHABLE: `formula_string()` and `get_cached_ast()`
                        // read the SAME `Cell::ast` field, so a cell that produced
                        // a formula string above always has an AST here. Kept as
                        // the fallback it has always been. It is the one place that
                        // still writes an expanded AST back into a cell, which would
                        // be the pre-resolution defect (D2) if it could run.
                        // Slow path: parse, resolve refs, and cache AST
                        if let Ok(engine_ast) = {
                            parser::parse(&formula).map(|parsed| {
                                let resolved = if crate::ast_has_named_refs(&parsed) {
                                    let mut visited = HashSet::new();
                                    crate::resolve_names_in_ast(&parsed, &batch_named_ranges, active_sheet, &mut visited)
                                } else {
                                    parsed
                                };
                                let resolved = if crate::ast_has_table_refs(&resolved) {
                                    let ctx = crate::TableRefContext {
                                        tables: &batch_tables,
                                        table_names: &batch_table_names,
                                        sheet_names: &sheet_names,
                                        current_sheet_index: active_sheet,
                                        current_row: *dep_row,
                                        current_col: *dep_col,
                                    };
                                    crate::resolve_table_refs_in_ast(&resolved, &ctx)
                                } else {
                                    resolved
                                };
                                crate::convert_expr(&resolved)
                            }).map_err(|e| format!("{}", e))
                        } {
                            let result = crate::evaluate_formula_raw_with_ast_files_and_cube(
                                &grids,
                                &sheet_names,
                                active_sheet,
                                &engine_ast,
                                &user_files,
                                batch_udf,
                                None,
                                Some(control_values.clone()),
                            ).to_cell_value();
                            let mut updated_with_ast = dep_cell.clone();
                            updated_with_ast.set_cached_ast(engine_ast);
                            updated_with_ast.value = result.clone();
                            grid.set_cell(*dep_row, *dep_col, updated_with_ast.clone());
                            if active_sheet < grids.len() {
                                grids[active_sheet].set_cell(*dep_row, *dep_col, updated_with_ast.clone());
                            }

                            let dep_style = styles.get(grid.effective_style_index(*dep_row, *dep_col));
                            let dep_display = format_cell_value(&updated_with_ast.value, dep_style, &locale);

                            let (dep_row_span, dep_col_span) =
                                if let Some(region) = merge_lookup.get(&(*dep_row, *dep_col)) {
                                    (
                                        region.end_row - region.start_row + 1,
                                        region.end_col - region.start_col + 1,
                                    )
                                } else {
                                    (1, 1)
                                };

                            updated_cells.push(CellData {
                                row: *dep_row,
                                col: *dep_col,
                                display: dep_display,
                                display_color: None,
                                formula: if include_cascade_formulas { formula_display(&updated_with_ast, &locale) } else { None },
                                style_index: grid.effective_style_index(*dep_row, *dep_col),
                                row_span: dep_row_span,
                                col_span: dep_col_span,
                                sheet_index: None,
                                rich_text: None,
                                accounting_layout: None,
                            });
                            continue;
                        }
                        evaluate_formula_multi_sheet_with_files(&grids, &sheet_names, active_sheet, &formula, &user_files)
                    };

                    let mut updated_dep = dep_cell.clone();
                    updated_dep.value = result;
                    grid.set_cell(*dep_row, *dep_col, updated_dep.clone());

                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(*dep_row, *dep_col, updated_dep.clone());
                    }

                    let dep_style = styles.get(grid.effective_style_index(*dep_row, *dep_col));
                    let dep_display = format_cell_value(&updated_dep.value, dep_style, &locale);

                    let (dep_row_span, dep_col_span) =
                        if let Some(region) = merge_lookup.get(&(*dep_row, *dep_col)) {
                            (
                                region.end_row - region.start_row + 1,
                                region.end_col - region.start_col + 1,
                            )
                        } else {
                            (1, 1)
                        };

                    updated_cells.push(CellData {
                        row: *dep_row,
                        col: *dep_col,
                        display: dep_display,
                        display_color: None,
                        formula: if include_cascade_formulas { formula_display(&updated_dep, &locale) } else { None },
                        style_index: grid.effective_style_index(*dep_row, *dep_col),
                        row_span: dep_row_span,
                        col_span: dep_col_span,
                        sheet_index: None,
                        rich_text: None,
                        accounting_layout: None,
                    });
                }
            }
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

    // Begin undo transaction for batch operation
    if count > 0 {
        undo_stack.begin_transaction(format!(
            "Clear range ({},{}) to ({},{})",
            start_row, start_col, end_row, end_col
        ));
    }

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
        undo_stack.commit_transaction();
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
    let min_row = params.start_row.min(params.end_row);
    let max_row = params.start_row.max(params.end_row);
    let min_col = params.start_col.min(params.end_col);
    let max_col = params.start_col.max(params.end_col);
    let apply_to = params.apply_to;

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

    let mut override_edits: Vec<(u32, u32, Option<engine::Cell>, Option<engine::Cell>)> = Vec::new();
    let mut previous_cells: Vec<(u32, u32, Option<engine::Cell>)> = Vec::new();

    let count = {
        // Bounds check under a read-only view; the effect is built only once it
        // has passed, so a bad sheet index cannot leave the document dirty. One
        // lock throughout -- see Persisted::lock_pending.
        let grids = state.grids.lock_pending().unwrap();
        if target >= grids.len() {
            return Err(format!("Sheet index {} out of range", target));
        }
        let effect = crate::document_effect::DocumentEffect::mutates(file_state);
        let mut grids = grids.authorize(&effect);
        let mut undo_stack = state.undo_stack.lock().unwrap();
        let grid = &mut grids[target];

        let effective_end_row = max_row.min(grid.max_row);
        let effective_end_col = max_col.min(grid.max_col);

        // SPILL TEAR-DOWN, off-sheet half (§2y). The active twin gets this from
        // `recalc_after_active_sheet_bulk_rewrite`; this path recalculates
        // through `recalc_after_off_sheet_write`, which is whole-sheet and NOT
        // spill-aware, so the release happens here, in the same critical
        // section as the clear. The released cells are erased below and never
        // recorded for undo, exactly as on the active sheet.
        let released_spill = if matches!(apply_to, ClearApplyTo::Formats) {
            Vec::new()
        } else {
            take_spills_owned_within(
                state, target, min_row, min_col, effective_end_row, effective_end_col,
            )
        };
        let released_set: crate::CoordSet = released_spill.iter().copied().collect();
        for &(r, c) in &released_spill {
            grid.cells.remove(&(r, c));
        }

        let mut cells_in_range: Vec<(u32, u32)> = grid
            .cells
            .keys()
            .filter(|(r, c)| {
                *r >= min_row && *r <= effective_end_row && *c >= min_col && *c <= effective_end_col
            })
            .filter(|coord| !released_set.contains(coord))
            .cloned()
            .collect();

        // Formats mode touches every position in the range, not just existing
        // cells (count parity with the active twin; only existing cells are
        // actually rewritten below).
        if matches!(apply_to, ClearApplyTo::Formats) {
            for r in min_row..=effective_end_row {
                for c in min_col..=effective_end_col {
                    if !cells_in_range.contains(&(r, c)) {
                        cells_in_range.push((r, c));
                    }
                }
            }
        }

        let count = cells_in_range.len() as u32;

        for (row, col) in cells_in_range {
            let previous_cell = grid.get_cell(row, col).cloned();
            match apply_to {
                ClearApplyTo::All | ClearApplyTo::ResetContents => {
                    if previous_cell.is_some() {
                        override_edits.push((row, col, previous_cell.clone(), None));
                        previous_cells.push((row, col, previous_cell));
                        grid.clear_cell(row, col);
                    }
                }
                ClearApplyTo::Contents => {
                    if let Some(ref cell) = previous_cell {
                        let style_index = cell.style_index;
                        let mut new_cell = engine::Cell::new();
                        new_cell.style_index = style_index;
                        override_edits.push((
                            row,
                            col,
                            previous_cell.clone(),
                            Some(new_cell.clone()),
                        ));
                        previous_cells.push((row, col, previous_cell.clone()));
                        grid.set_cell(row, col, new_cell);
                    }
                }
                ClearApplyTo::Formats => {
                    if let Some(ref cell) = previous_cell {
                        // Index 0 = INHERIT (falls back to row/column tier).
                        let mut new_cell = cell.clone();
                        new_cell.style_index = 0;
                        previous_cells.push((row, col, previous_cell.clone()));
                        grid.set_cell(row, col, new_cell);
                    }
                }
                ClearApplyTo::Hyperlinks | ClearApplyTo::RemoveHyperlinks => {
                    if let Some(ref cell) = previous_cell {
                        if apply_to == ClearApplyTo::RemoveHyperlinks {
                            let mut new_cell = cell.clone();
                            new_cell.style_index = 0;
                            previous_cells.push((row, col, previous_cell.clone()));
                            grid.set_cell(row, col, new_cell);
                        }
                    }
                }
            }
        }

        if !previous_cells.is_empty() {
            let desc = match apply_to {
                ClearApplyTo::All => "Clear all",
                ClearApplyTo::Contents => "Clear contents",
                ClearApplyTo::Formats => "Clear formats",
                ClearApplyTo::Hyperlinks => "Clear hyperlinks",
                ClearApplyTo::RemoveHyperlinks => "Remove hyperlinks",
                ClearApplyTo::ResetContents => "Reset contents",
            };
            undo_stack.begin_transaction(format!(
                "{} on sheet {} ({},{}) to ({},{})",
                desc, target + 1, min_row, min_col, max_row, max_col
            ));
            undo_stack.record_custom_restore(
                "script_grid_cells".to_string(),
                crate::undo_commands::script_grid_cells_snapshot_bytes(target, previous_cells),
                desc,
            );
            undo_stack.commit_transaction();
        }

        count
    };

    // Subscriber overrides for the TARGET sheet (no-op when not subscribed).
    crate::calp_commands::record_subscription_override_edits(state, &crate::document_effect::DocumentEffect::mutates(file_state), target, &override_edits);

    // Dependents (anywhere) of the cleared cells recalculate now.
    if count > 0 && !matches!(apply_to, ClearApplyTo::Formats) {
        crate::commands::data::recalc_after_off_sheet_write(
            state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &[target],
        );
    }

    if count > 0 {
        let _ = crate::document_effect::DocumentEffect::mutates(&file_state);
    }

    Ok(ClearRangeResult {
        count,
        updated_cells: Vec::new(),
    })
}

/// Clear a range of cells with options for what to clear.
/// Supports Excel-compatible ClearApplyTo options:
/// - All: Clear both content and formatting (default)
/// - Contents: Clear values only, keep formatting
/// - Formats: Clear formatting only, keep values
/// - Hyperlinks: Clear hyperlinks only (placeholder)
/// - RemoveHyperlinks: Remove hyperlinks and formatting, keep content
/// - ResetContents: Reset to default state
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

    // Every gate above has passed; from here this command commits. Constructed
    // HERE and not at the top so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let style_registry = state.style_registry.read().unwrap();
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

    let ClearRangeParams {
        start_row,
        start_col,
        end_row,
        end_col,
        apply_to,
        sheet_index: _,
    } = params;

    // Normalize coordinates
    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

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

    // Collect cells in the range (both existing and potential)
    let mut cells_in_range: Vec<(u32, u32)> = grid
        .cells
        .keys()
        .filter(|(r, c)| {
            *r >= min_row && *r <= effective_end_row && *c >= min_col && *c <= effective_end_col
        })
        .filter(|coord| !owned_spill.contains(coord))
        .cloned()
        .collect();

    // For "Formats" mode, we need to process all cells in the range, not just existing ones
    if matches!(apply_to, ClearApplyTo::Formats) {
        for r in min_row..=effective_end_row {
            for c in min_col..=effective_end_col {
                if !cells_in_range.contains(&(r, c)) {
                    cells_in_range.push((r, c));
                }
            }
        }
    }

    let count = cells_in_range.len() as u32;
    let mut updated_cells = Vec::new();

    if count > 0 {
        let desc = match apply_to {
            ClearApplyTo::All => "Clear all",
            ClearApplyTo::Contents => "Clear contents",
            ClearApplyTo::Formats => "Clear formats",
            ClearApplyTo::Hyperlinks => "Clear hyperlinks",
            ClearApplyTo::RemoveHyperlinks => "Remove hyperlinks",
            ClearApplyTo::ResetContents => "Reset contents",
        };
        undo_stack.begin_transaction(format!(
            "{} ({},{}) to ({},{})",
            desc, min_row, min_col, max_row, max_col
        ));
    }

    // Pre/post cell states collected for subscriber override capture.
    let mut override_edits: Vec<(u32, u32, Option<engine::Cell>, Option<engine::Cell>)> = Vec::new();

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
                    display_color: None,
                    formula: None,
                    style_index: 0,
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
                    undo_stack.record_cell_change(active_sheet, row, col, previous_cell.clone());

                    // Index 0 = INHERIT, so this returns the cell to its
                    // row/column style tier rather than to the workbook default.
                    // That is Excel's behaviour, and it means Clear Formats also
                    // clears any per-cell LOCK override — the cell falls back to
                    // whatever its row/column (or the default: locked) says.
                    let mut new_cell = cell.clone();
                    new_cell.style_index = 0;

                    grid.set_cell(row, col, new_cell.clone());
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(row, col, new_cell);
                    }

                    // The cell's own style is cleared, but a row/column style
                    // still applies to it.
                    let default_style = style_registry.get(grid.effective_style_index(row, col));
                    let display = format_cell_value(&cell.value, default_style, &locale);

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
            ClearApplyTo::Hyperlinks | ClearApplyTo::RemoveHyperlinks => {
                // Placeholder - hyperlinks not yet implemented
                // For now, treat RemoveHyperlinks as clear formats
                if let Some(ref cell) = previous_cell {
                    if apply_to == ClearApplyTo::RemoveHyperlinks {
                        undo_stack.record_cell_change(active_sheet, row, col, previous_cell.clone());

                        // Index 0 = INHERIT; see the note in the Formats branch.
                        let mut new_cell = cell.clone();
                        new_cell.style_index = 0;

                        grid.set_cell(row, col, new_cell.clone());
                        if active_sheet < grids.len() {
                            grids[active_sheet].set_cell(row, col, new_cell);
                        }

                        // The cell's own style is cleared, but a row/column
                        // style still applies to it.
                        let default_style = style_registry.get(grid.effective_style_index(row, col));
                        let display = format_cell_value(&cell.value, default_style, &locale);

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
        }
    }

    // Record subscriber overrides for all cleared cells (subscribed sheets only)
    crate::calp_commands::record_subscription_override_edits(&state, &crate::document_effect::DocumentEffect::mutates(&file_state), active_sheet, &override_edits);

    if count > 0 {
        undo_stack.commit_transaction();
        // Mark workbook as dirty
        let _ = crate::document_effect::DocumentEffect::mutates(&file_state);
    }

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

    let sorted_count = {
        // Bounds check under a read-only view; the effect is built only once it
        // has passed, so a bad sheet index cannot leave the document dirty. One
        // lock throughout -- see Persisted::lock_pending.
        let grids = state.grids.lock_pending().unwrap();
        if target >= grids.len() {
            return Err(format!("Sheet index {} out of range", target));
        }
        let effect = crate::document_effect::DocumentEffect::mutates(file_state);
        let mut grids = grids.authorize(&effect);
        let styles = state.style_registry.read().unwrap();
        let mut undo_stack = state.undo_stack.lock().unwrap();
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
                // same rule as the active path).
                let mut rows: Vec<(u32, Vec<Option<engine::Cell>>)> = Vec::new();
                for row in data_start_row..=max_row {
                    let mut row_data: Vec<Option<engine::Cell>> = Vec::new();
                    for col in min_col..=max_col {
                        let mut cell = grid.get_cell(row, col).cloned();
                        if color_sort {
                            if let Some(c) = cell.as_mut() {
                                if c.style_index == 0 {
                                    c.style_index = grid.effective_style_index(row, col);
                                }
                            }
                        }
                        row_data.push(cell);
                    }
                    rows.push((row, row_data));
                }

                rows.sort_by(|a, b| {
                    compare_rows_by_fields(&a.1, &b.1, &fields, min_col, match_case, &styles)
                });

                // Capture the whole data range for undo BEFORE rewriting.
                for row in data_start_row..=max_row {
                    for col in min_col..=max_col {
                        previous_cells.push((row, col, grid.get_cell(row, col).cloned()));
                    }
                }

                sorted_count = rows.len() as u32;
                for (new_row_idx, (original_row, row_data)) in rows.iter().enumerate() {
                    let target_row = data_start_row + new_row_idx as u32;
                    let row_delta = target_row as i32 - *original_row as i32;
                    for (col_offset, cell_opt) in row_data.iter().enumerate() {
                        let target_col = min_col + col_offset as u32;
                        if let Some(cell) = cell_opt {
                            let mut cell = cell.clone();
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

                let mut cols: Vec<(u32, Vec<Option<engine::Cell>>)> = Vec::new();
                for col in data_start_col..=max_col {
                    let mut col_data: Vec<Option<engine::Cell>> = Vec::new();
                    for row in min_row..=max_row {
                        let mut cell = grid.get_cell(row, col).cloned();
                        if color_sort {
                            if let Some(c) = cell.as_mut() {
                                if c.style_index == 0 {
                                    c.style_index = grid.effective_style_index(row, col);
                                }
                            }
                        }
                        col_data.push(cell);
                    }
                    cols.push((col, col_data));
                }

                cols.sort_by(|a, b| {
                    compare_cols_by_fields(&a.1, &b.1, &fields, min_row, match_case, &styles)
                });

                for row in min_row..=max_row {
                    for col in data_start_col..=max_col {
                        previous_cells.push((row, col, grid.get_cell(row, col).cloned()));
                    }
                }

                sorted_count = cols.len() as u32;
                for (new_col_idx, (original_col, col_data)) in cols.iter().enumerate() {
                    let target_col = data_start_col + new_col_idx as u32;
                    let col_delta = target_col as i32 - *original_col as i32;
                    for (row_offset, cell_opt) in col_data.iter().enumerate() {
                        let target_row = min_row + row_offset as u32;
                        if let Some(cell) = cell_opt {
                            let mut cell = cell.clone();
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
            undo_stack.begin_transaction(format!(
                "Sort range on sheet {} ({},{}) to ({},{})",
                target + 1, min_row, min_col, max_row, max_col
            ));
            undo_stack.record_custom_restore(
                "script_grid_cells".to_string(),
                crate::undo_commands::script_grid_cells_snapshot_bytes(target, previous_cells),
                "Sort range",
            );
            undo_stack.commit_transaction();
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
    // Every gate above has passed; from here this command commits. Constructed
    // HERE and not at the top so a refusal cannot leave a spuriously dirty
    // document -- see DocumentEffect::mutates on ordering.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let styles = state.style_registry.read().unwrap();
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
    } = params;

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
            // invisible to Sort by Cell Color / Font Color. Materializing also
            // keeps the visible format travelling with the cell, which is what
            // Excel does when sort moves cells.
            let color_sort = fields
                .iter()
                .any(|f| matches!(f.sort_on, SortOn::CellColor | SortOn::FontColor));
            let mut rows: Vec<(u32, Vec<Option<engine::Cell>>)> = Vec::new();
            for row in data_start_row..=max_row {
                let mut row_data: Vec<Option<engine::Cell>> = Vec::new();
                for col in min_col..=max_col {
                    let mut cell = grid.get_cell(row, col).cloned();
                    if color_sort {
                        if let Some(c) = cell.as_mut() {
                            if c.style_index == 0 {
                                c.style_index = grid.effective_style_index(row, col);
                            }
                        }
                    }
                    row_data.push(cell);
                }
                rows.push((row, row_data));
            }

            // Sort the rows using the sort fields
            rows.sort_by(|a, b| {
                compare_rows_by_fields(&a.1, &b.1, &fields, min_col, match_case, &styles)
            });

            // Begin undo transaction
            undo_stack.begin_transaction(format!(
                "Sort range ({},{}) to ({},{})",
                min_row, min_col, max_row, max_col
            ));

            // Apply the sorted order back to the grid
            let mut updated_cells = Vec::new();
            let sorted_count = rows.len() as u32;

            for (new_row_idx, (original_row, row_data)) in rows.iter().enumerate() {
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
                        let display = format_cell_value(&cell.value, style, &locale);

                        updated_cells.push(CellData {
                            row: target_row,
                            col: target_col,
                            display,
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

            undo_stack.commit_transaction();

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
            // materialization rule as the row sort above).
            let color_sort = fields
                .iter()
                .any(|f| matches!(f.sort_on, SortOn::CellColor | SortOn::FontColor));
            let mut cols: Vec<(u32, Vec<Option<engine::Cell>>)> = Vec::new();
            for col in data_start_col..=max_col {
                let mut col_data: Vec<Option<engine::Cell>> = Vec::new();
                for row in min_row..=max_row {
                    let mut cell = grid.get_cell(row, col).cloned();
                    if color_sort {
                        if let Some(c) = cell.as_mut() {
                            if c.style_index == 0 {
                                c.style_index = grid.effective_style_index(row, col);
                            }
                        }
                    }
                    col_data.push(cell);
                }
                cols.push((col, col_data));
            }

            // Sort the columns using the sort fields (treating rows as keys)
            cols.sort_by(|a, b| {
                compare_cols_by_fields(&a.1, &b.1, &fields, min_row, match_case, &styles)
            });

            // Begin undo transaction
            undo_stack.begin_transaction(format!(
                "Sort columns ({},{}) to ({},{})",
                min_row, min_col, max_row, max_col
            ));

            // Apply the sorted order back to the grid
            let mut updated_cells = Vec::new();
            let sorted_count = cols.len() as u32;

            for (new_col_idx, (original_col, col_data)) in cols.iter().enumerate() {
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
                        let display = format_cell_value(&cell.value, style, &locale);

                        updated_cells.push(CellData {
                            row: target_row,
                            col: target_col,
                            display,
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

            undo_stack.commit_transaction();

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
    fields: &[SortField],
    _min_col: u32,
    match_case: bool,
    styles: &StyleRegistry,
) -> std::cmp::Ordering {
    for field in fields {
        let col_idx = field.key as usize;
        if col_idx >= row_a.len() || col_idx >= row_b.len() {
            continue;
        }

        let cell_a = &row_a[col_idx];
        let cell_b = &row_b[col_idx];

        let ordering = compare_cells(cell_a, cell_b, field, match_case, styles);

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
fn compare_cols_by_fields(
    col_a: &[Option<engine::Cell>],
    col_b: &[Option<engine::Cell>],
    fields: &[SortField],
    _min_row: u32,
    match_case: bool,
    styles: &StyleRegistry,
) -> std::cmp::Ordering {
    for field in fields {
        let row_idx = field.key as usize;
        if row_idx >= col_a.len() || row_idx >= col_b.len() {
            continue;
        }

        let cell_a = &col_a[row_idx];
        let cell_b = &col_b[row_idx];

        let ordering = compare_cells(cell_a, cell_b, field, match_case, styles);

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
    match_case: bool,
    styles: &StyleRegistry,
) -> std::cmp::Ordering {
    match field.sort_on {
        SortOn::Value => {
            // Check for custom sort order
            if let Some(ref custom_order) = field.custom_order {
                let list = resolve_custom_order(custom_order);
                if !list.is_empty() {
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
                            let key_a = custom_sort_key(a, &list);
                            let key_b = custom_sort_key(b, &list);
                            key_a.cmp(&key_b)
                        }
                    };
                }
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
            // Icon sorting not yet implemented - fall back to value comparison
            let val_a = cell_a.as_ref().map(|c| &c.value);
            let val_b = cell_b.as_ref().map(|c| &c.value);

            match (val_a, val_b) {
                (None, None) => std::cmp::Ordering::Equal,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                (Some(a), Some(b)) => compare_cell_values(a, b, match_case, field.data_option),
            }
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

/// Resolve a custom_order string into a list of values.
/// Built-in names: "weekdays", "weekdaysShort", "months", "monthsShort".
/// Otherwise treated as a comma-separated list of custom values.
fn resolve_custom_order(custom_order: &str) -> Vec<String> {
    match custom_order {
        "weekdays" => WEEKDAYS.iter().map(|s| s.to_string()).collect(),
        "weekdaysShort" => WEEKDAYS_SHORT.iter().map(|s| s.to_string()).collect(),
        "months" => MONTHS.iter().map(|s| s.to_string()).collect(),
        "monthsShort" => MONTHS_SHORT.iter().map(|s| s.to_string()).collect(),
        _ => custom_order.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
    }
}

/// Get the sort position of a value in a custom list (case-insensitive).
/// Values not found in the list sort after all list values (usize::MAX).
fn custom_sort_key(value: &str, list: &[String]) -> usize {
    list.iter()
        .position(|item| item.eq_ignore_ascii_case(value))
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
    // Sheet protection first, before any grid lock: removing duplicates rewrites
    // the whole range. Reported through the result's `error` field, since this
    // command does not return Result.
    {
        let active_sheet = *state.active_sheet.read().unwrap();
        if let Err(e) = crate::protection::check_sheet_protection_range(
            &state,
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
    }

    // Past the protection gate: this deletes grid rows.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    // `sheet_names` BEFORE `style_registry`. The recalculation pass takes them
    // in that order on a BACKGROUND thread, so taking them the other way round
    // here closes a cycle that hangs the app with no panic and no log line
    // (BUG-0045). Cloned, so nothing is held; the rebuild below reads it.
    let sheet_names_for_rebuild = state.sheet_names.read().unwrap().clone();
    let styles = state.style_registry.read().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
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
            row_data.push(grid.get_cell(row, col).cloned());
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

    // Begin undo transaction
    undo_stack.begin_transaction(format!(
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
                let display = format_cell_value(&cell.value, style, &locale);

                updated_cells.push(CellData {
                    row: target_row,
                    col: target_col,
                    display,
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

    undo_stack.commit_transaction();

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
    {
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
/// lossy because `reevaluate_formula_cell` evaluates with the cell's OWN
/// position, so `preserved_udf_value` / `preserved_cube_value` keep the stored
/// value instead of collapsing to #NAME? / #N/A (see its doc comment).
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
        let has_spills = !state.spill_ranges.lock().unwrap().is_empty();
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

    // Manual calculation mode: the user asked for stale values until F9.
    if *calc_mode != "automatic" {
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
    // Cross-sheet cycle detection is memoised for this whole scope: the loop
    // below calls `recalculate_sheet_values` 2*(sheets+1) times and the answer
    // is a function of the ASTs, which recalculation never changes. Without
    // this the workbook-level graph would be rebuilt on every one of those
    // calls. See calculation.rs `begin_circular_pass`.
    let _circular_pass = crate::calculation::begin_circular_pass();
    for _pass in 0..2 {
        for &idx in sheet_indices.iter().chain(object_sheets.iter()) {
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
    )
}

/// Command body over plain references (the `hide_sheet_inner` split):
/// `update_floating_range_cell` writes a floating range's cells through this
/// exact path — the same protection/writeback/spill gates, the same GAP-A edge
/// registration, the same off-sheet recalc — because a backing sheet IS a
/// non-active sheet and a second write path would drift.
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
) -> Result<Vec<usize>, String> {
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Interactive,
        &state.calc_cancel,
    );
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
        let active_sheet = *state.active_sheet.read().unwrap();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        let mut wrote: Vec<usize> = Vec::new();

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

        // Handle empty value - clear the cell on each target sheet. A clear
        // changes dependents exactly like a write, so it falls through to the
        // same recalc below instead of returning early.
        if value.trim().is_empty() {
            for &sheet_idx in &sheet_indices {
                if sheet_idx == active_sheet || sheet_idx >= grids.len() {
                    continue;
                }
                let previous_cell = grids[sheet_idx].get_cell(row, col).cloned();
                if previous_cell.is_some() {
                    undo_stack.begin_transaction(format!("Clear cell on sheet {}", sheet_idx));
                    undo_stack.record_cell_change(sheet_idx, row, col, previous_cell);
                    grids[sheet_idx].clear_cell(row, col);
                    undo_stack.commit_transaction();
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
            wrote
        } else {
            // Parse the input (same logic as update_cell). When invariant=true the
            // value is a script's TYPED write in canonical US form ("42.5", "TRUE");
            // delocalizing it against the workbook locale would corrupt it (sv-SE
            // reads "42.5" as 425), so it takes the invariant parse — the same split
            // update_cells_batch makes.
            let cell_template = if invariant.unwrap_or(false) {
                parse_cell_input_invariant(&value, &locale)
            } else {
                parse_cell_input(&value, &locale)
            };
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

                undo_stack.begin_transaction(format!("Update cell on sheet {}", sheet_idx));
                let previous_cell = grids[sheet_idx].get_cell(row, col).cloned();

                let mut cell = cell_template.clone();

                // Preserve existing style from target sheet
                if let Some(existing) = grids[sheet_idx].get_cell(row, col) {
                    cell.style_index = existing.style_index;
                }

                // If formula, evaluate in the context of the target sheet
                if is_formula {
                    if let Some(ref ast) = engine_ast {
                        let result_value = crate::evaluate_formula_multi_sheet_with_ast_and_files(
                            &grids,
                            &sheet_names,
                            sheet_idx,
                            ast,
                            &user_files,
                        );
                        cell.value = result_value;
                        cell.ast = Some(Box::new(ast.clone()));
                    }
                }

                grids[sheet_idx].set_cell(row, col, cell);
                undo_stack.record_cell_change(sheet_idx, row, col, previous_cell);
                undo_stack.commit_transaction();

                // GAP A: this command stored formulas for years WITHOUT
                // registering their cross-sheet dependency edges, so an
                // off-sheet `=Sheet1!A1*2` written by a script (or into a
                // floating range) evaluated once and then went permanently
                // stale when its precedents changed — the cascade had no edge
                // to walk. Registered here for EVERY caller, through the same
                // normalize-then-update pair `update_cell_impl` uses. A
                // non-formula overwrite registers the empty set, which removes
                // whatever the previous formula had registered.
                let new_refs = if is_formula {
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

/// Clear a range of cells on multiple non-active sheets.
/// Used for sheet grouping: when the user presses Delete with grouped sheets.
///
/// DEPENDENTS RECALCULATE (§2c). Like every other clear path this one
/// propagated nothing; unlike them it writes to sheets the user is not looking
/// at, so `recalc_after_off_sheet_write` is the right shape — it evaluates each
/// written sheet plus the active one, which is also what puts a formula on the
/// ACTIVE sheet reading a cleared grouped sheet back in step.
#[tauri::command]
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
) -> Result<(), String> {
    // Object-output protection on every targeted sheet (group clear must not
    // punch through a pivot/report region on a background sheet).
    for &sheet_idx in &sheet_indices {
        // Sheet protection is per-sheet, so a group clear must be refused if ANY
        // targeted sheet protects those cells — this is the cross-sheet case the
        // active-sheet-only `can_edit_cell` command could never answer.
        crate::protection::check_sheet_protection_range(
            &state, sheet_idx, start_row, start_col, end_row, end_col,
        )?;
        check_region_range_protection(&state, sheet_idx, start_row, start_col, end_row, end_col)?;
    }

    // WRITEBACK CLAIM GUARD, off-sheet half. The index is keyed by SheetId and
    // this command never consults the active sheet, so each targeted sheet is
    // asked individually. Refused for the whole group, like protection above:
    // a group clear that skipped one sheet is the silent partial mutation the
    // guard exists to prevent.
    crate::calp_commands::ensure_range_unclaimed_on_sheets(
        &state, "clear this range", &sheet_indices, start_row, start_col, end_row, end_col,
    )?;

    // SPILL PROTECTION, group half (§2y). The paired `clear_range` has always
    // refused a rectangle that cuts an array in two; this one had no check at
    // all, so a group Delete over a background sheet's spilled block erased
    // values whose formula still claimed them. `ReleasedByCaller`, like the
    // single-sheet clears: a rectangle that swallows the ORIGIN takes the whole
    // spill with it, released below.
    {
        let spill_hosts = state.spill_hosts.lock().unwrap();
        for &sheet_idx in &sheet_indices {
            check_spill_protection(
                &spill_hosts, sheet_idx, start_row, start_col, end_row, end_col,
                SpillOriginPolicy::ReleasedByCaller,
            )?;
        }
    }

    // Past every per-sheet protection + writeback-claim refusal above. This writes
    // USER CONTENT to non-active sheets, which the paired `clear_range` never covered.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grids = state.grids.write(&effect).unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    // Sheets that actually lost content — the recalc seed set for phase B.
    let mut cleared_sheets: Vec<usize> = Vec::new();

    for &sheet_idx in &sheet_indices {
        if sheet_idx == active_sheet || sheet_idx >= grids.len() {
            continue;
        }

        let grid = &grids[sheet_idx];
        let effective_end_row = end_row.min(grid.max_row);
        let effective_end_col = end_col.min(grid.max_col);

        // SPILL TEAR-DOWN (§2y), in the same critical section as the clear.
        // `recalc_after_off_sheet_write` re-lays arrays whose origin still
        // holds a formula (§3bm), and a CLEAR is exactly the case it cannot
        // help with: the origin's formula is gone, so nothing visits it and
        // nothing would release its claim. Released cells are erased and never
        // recorded for undo (see `spilled_cells_owned_within`).
        let released_spill = take_spills_owned_within(
            &state, sheet_idx, start_row, start_col, effective_end_row, effective_end_col,
        );
        let released_set: crate::CoordSet = released_spill.iter().copied().collect();

        let cells_to_clear: Vec<(u32, u32)> = grid
            .cells
            .keys()
            .filter(|(r, c)| {
                *r >= start_row && *r <= effective_end_row && *c >= start_col && *c <= effective_end_col
            })
            .filter(|coord| !released_set.contains(coord))
            .cloned()
            .collect();

        if cells_to_clear.is_empty() && released_spill.is_empty() {
            continue;
        }
        cleared_sheets.push(sheet_idx);

        {
            let grid = &mut grids[sheet_idx];
            for (r, c) in &released_spill {
                grid.cells.remove(&(*r, *c));
            }
        }

        if cells_to_clear.is_empty() {
            // Only derived spill cells went; nothing to record. Opening a
            // transaction here would leave an empty step on the stack, so the
            // next Ctrl+Z would appear to do nothing.
            continue;
        }

        undo_stack.begin_transaction(format!(
            "Clear range on sheet {}",
            sheet_idx
        ));

        let grid = &mut grids[sheet_idx];
        for (r, c) in cells_to_clear {
            let previous_cell = grid.get_cell(r, c).cloned();
            if previous_cell.is_some() {
                undo_stack.record_cell_change(sheet_idx, r, c, previous_cell);
            }
            grid.clear_cell(r, c);
        }

        undo_stack.commit_transaction();
    }

    // PHASE B — dependents. `recalc_after_off_sheet_write` takes its own locks
    // (it calls `recalculate_sheet_values`), so the caller must hold none.
    drop(undo_stack);
    drop(grids);

    if !cleared_sheets.is_empty() {
        recalc_after_off_sheet_write(
            &state,
            &user_files_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
            &cleared_sheets,
        );
    }

    Ok(())
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
) -> Result<Vec<CellData>, String> {
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

    // Sheet protection over the FILL TARGET (the source is only read).
    {
        let active = *state.active_sheet.read().unwrap();
        crate::protection::check_sheet_protection_range(
            &state,
            active,
            target_start_row.min(target_end_row),
            target_start_col.min(target_end_col),
            target_start_row.max(target_end_row),
            target_start_col.max(target_end_col),
        )?;
    }

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

    // Every gate above has passed; the fill below commits.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);

    // CANONICAL LOCK ORDER: both grid locks FIRST, then everything else.
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let user_files = user_files_state.files.lock().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let styles = state.style_registry.read().unwrap();
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
    let pivot_data_fn = |data_field: &str, pivot_row: u32, pivot_col: u32, pairs: &[(&str, &str)]| -> Option<f64> {
        crate::pivot::operations::lookup_pivot_data(
            &pivot_tables,
            &pivot_views,
            data_field,
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

    // Collect source cells into a lookup map (relative position -> Cell)
    let mut source_cells: HashMap<(u32, u32), engine::Cell> = HashMap::new();
    for r in source_start_row..=source_end_row {
        for c in source_start_col..=source_end_col {
            if let Some(cell) = grid.get_cell(r, c) {
                let rel_r = r - source_start_row;
                let rel_c = c - source_start_col;
                source_cells.insert((rel_r, rel_c), cell.clone());
            }
        }
    }

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
                    let shifted = crate::commands::structure::shift_formula_internal(
                        &formula,
                        row_delta,
                        col_delta,
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

                            // For fill, we take the simple scalar result (no spill handling)
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

                // Write the cell
                grid.set_cell(tr, tc, new_cell.clone());
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(tr, tc, new_cell.clone());
                }

                // Build CellData for the response
                let style = styles.get(grid.effective_style_index(tr, tc));
                let display = format_cell_value(&new_cell.value, style, &locale);

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
                // Source cell is empty - clear the target cell
                grid.clear_cell(tr, tc);
                if active_sheet < grids.len() {
                    grids[active_sheet].clear_cell(tr, tc);
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
                    display_color: None,
                    formula: None,
                    style_index: 0,
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

        for (dep_row, dep_col) in &all_recalc_order {
            if let Some(dep_cell) = grid.get_cell(*dep_row, *dep_col) {
                if let Some(formula) = dep_cell.formula_string() {
                    let result = if let Some(cached_ast) = dep_cell.get_cached_ast() {
                        // Names expand on the way into the evaluator (D2).
                        let eval_target = crate::name_resolution::eval_ast(
                            cached_ast,
                            &crate::name_resolution::NameTables {
                                named_ranges: &batch_named_ranges,
                                tables: &batch_tables,
                                table_names: &batch_table_names,
                                sheet_names: &sheet_names,
                                spill_ranges: &state.spill_ranges,
                            }
                            .at(active_sheet, *dep_row, *dep_col),
                        );
                        crate::evaluate_formula_raw_with_ast_files_and_cube(
                            &grids,
                            &sheet_names,
                            active_sheet,
                            &eval_target,
                            &user_files,
                            None,
                            None,
                            Some(control_values.clone()),
                        ).to_cell_value()
                    } else {
                        // UNREACHABLE: `formula_string()` and `get_cached_ast()`
                        // read the SAME `Cell::ast` field, so a cell that produced
                        // a formula string above always has an AST here. Kept as
                        // the fallback it has always been. It is the one place that
                        // still writes an expanded AST back into a cell, which would
                        // be the pre-resolution defect (D2) if it could run.
                        if let Ok(engine_ast) = {
                            parser::parse(&formula).map(|parsed| {
                                let resolved = if crate::ast_has_named_refs(&parsed) {
                                    let mut visited = HashSet::new();
                                    crate::resolve_names_in_ast(&parsed, &batch_named_ranges, active_sheet, &mut visited)
                                } else {
                                    parsed
                                };
                                let resolved = if crate::ast_has_table_refs(&resolved) {
                                    let ctx = crate::TableRefContext {
                                        tables: &batch_tables,
                                        table_names: &batch_table_names,
                                        sheet_names: &sheet_names,
                                        current_sheet_index: active_sheet,
                                        current_row: *dep_row,
                                        current_col: *dep_col,
                                    };
                                    crate::resolve_table_refs_in_ast(&resolved, &ctx)
                                } else {
                                    resolved
                                };
                                crate::convert_expr(&resolved)
                            }).map_err(|e| format!("{}", e))
                        } {
                            let result = crate::evaluate_formula_raw_with_ast_files_and_cube(
                                &grids,
                                &sheet_names,
                                active_sheet,
                                &engine_ast,
                                &user_files,
                                None,
                                None,
                                Some(control_values.clone()),
                            ).to_cell_value();
                            let mut updated_with_ast = dep_cell.clone();
                            updated_with_ast.set_cached_ast(engine_ast);
                            updated_with_ast.value = result.clone();
                            grid.set_cell(*dep_row, *dep_col, updated_with_ast.clone());
                            if active_sheet < grids.len() {
                                grids[active_sheet].set_cell(*dep_row, *dep_col, updated_with_ast.clone());
                            }
                            let dep_style = styles.get(grid.effective_style_index(*dep_row, *dep_col));
                            let dep_display = format_cell_value(&updated_with_ast.value, dep_style, &locale);
                            let (drspan, dcspan) = if let Some(region) = merge_lookup.get(&(*dep_row, *dep_col)) {
                                (region.end_row - region.start_row + 1, region.end_col - region.start_col + 1)
                            } else {
                                (1, 1)
                            };
                            updated_cells.push(CellData {
                                row: *dep_row, col: *dep_col, display: dep_display,
                                display_color: None,
                                formula: if include_cascade_formulas { formula_display(&updated_with_ast, &locale) } else { None },
                                style_index: grid.effective_style_index(*dep_row, *dep_col),
                                row_span: drspan, col_span: dcspan,
                                sheet_index: None, rich_text: None, accounting_layout: None,
                            });
                            continue;
                        }
                        evaluate_formula_multi_sheet_with_files(&grids, &sheet_names, active_sheet, &formula, &user_files)
                    };

                    let mut updated_dep = dep_cell.clone();
                    updated_dep.value = result;
                    grid.set_cell(*dep_row, *dep_col, updated_dep.clone());
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(*dep_row, *dep_col, updated_dep.clone());
                    }
                    let dep_style = styles.get(grid.effective_style_index(*dep_row, *dep_col));
                    let dep_display = format_cell_value(&updated_dep.value, dep_style, &locale);
                    let (drspan, dcspan) = if let Some(region) = merge_lookup.get(&(*dep_row, *dep_col)) {
                        (region.end_row - region.start_row + 1, region.end_col - region.start_col + 1)
                    } else {
                        (1, 1)
                    };
                    updated_cells.push(CellData {
                        row: *dep_row, col: *dep_col, display: dep_display,
                        display_color: None,
                        formula: if include_cascade_formulas { formula_display(&updated_dep, &locale) } else { None },
                        style_index: grid.effective_style_index(*dep_row, *dep_col),
                        row_span: drspan, col_span: dcspan,
                        sheet_index: None, rich_text: None, accounting_layout: None,
                    });
                }
            }
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
            (DATA_RS, "clear_range_with_options", "ensure_range_unclaimed("),
            (DATA_RS, "clear_range_on_sheets", "ensure_range_unclaimed_on_sheets("),
            (DATA_RS, "fill_range", "ensure_range_unclaimed("),
            (STRUCTURE_RS, "insert_rows", "ensure_row_shift_unclaimed("),
            (STRUCTURE_RS, "delete_rows", "ensure_row_shift_unclaimed("),
            (STRUCTURE_RS, "insert_columns", "ensure_col_shift_unclaimed("),
            (STRUCTURE_RS, "delete_columns", "ensure_col_shift_unclaimed("),
            (SEARCH_RS, "replace_all", "ensure_cells_unclaimed("),
            (SEARCH_RS, "replace_single", "ensure_range_unclaimed("),
            (MERGE_RS, "merge_cells", "ensure_range_unclaimed("),
            (MERGE_RS, "unmerge_cells", "ensure_range_unclaimed("),
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
        for (source, command, guard) in guarded_commands() {
            let body = body_of(source, command);
            let Some(txn) = body.find("begin_transaction") else {
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
        }
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
        let fill = body_of(DATA_RS, "fill_range");
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
