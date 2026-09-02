//! FILENAME: app/src-tauri/src/spill_restore.rs
//! PURPOSE: the LOAD half of dynamic-array spill ownership — register §2ab.
//!
//! `reevaluate_formula_cell` is the only function in the crate that WRITES the
//! spill map during a session, and `reset_document_scoped_stores` is the only
//! one that clears it. Between them there was a hole: nothing put the map back
//! for an INCOMING document, so a reopened workbook's arrays were painted but
//! owned by nothing.
//!
//! THE MEASURED CONSEQUENCE (§2ab, driven through the real backend):
//!
//! ```text
//! EA5 = 4, EB5 = "=SEQUENCE(EA5)"
//! 1. live                       EB5:EB8 -> 1 2 3 4   spill_ranges [{origin -> ...}]
//! 2. save, File > New, reopen   EB5:EB8 -> 1 2 3 4   spill_ranges []   <-- looks fine
//! 3. set EA5 = 4 (the SAME value)
//!                               EB5     -> #VALUE!   spill_ranges []
//!                               EB6:EB8 -> 2 3 4     (orphan literals from the file)
//! 4. Calculate Now              EB5:EB8 -> 1 2 3 4   spill_ranges []   <-- STILL empty
//! 5. set EA5 = 4 again          EB5     -> #VALUE!
//! ```
//!
//! and, worse than the error, step 4 only LOOKS repaired because the restored
//! literals happened to equal the array. Change the array's length and F9
//! leaves stale literals under a live origin, presented as that origin's
//! output — a wrong answer with no error on it.
//!
//! # The fix, and why it is persistence rather than recomputation
//!
//! **What Excel does, verified against the format rather than assumed.** In
//! xlsx an array origin is written as
//! `<c r="A1" cm="1"><f t="array" ref="A1:A4">SEQUENCE(4)</f><v>1</v></c>` and
//! the cells it covers are written as ordinary value-only `<c>` elements with
//! no `<f>` (ECMA-376 Part 1 §18.3.1.40 `CT_CellFormula`: `t` = `array`, `ref`
//! = "range of cells which the formula applies to"; confirmed by reading
//! `rust_xlsxwriter`'s serialiser, which emits exactly that, and calamine's
//! reader, which parses `ref`). So Excel persists BOTH halves and recomputes
//! NEITHER on open: the values because they are a cache worth keeping, and the
//! extent because it is not a cache at all.
//!
//! That split is the whole point. The spilled VALUES are derived and could be
//! recomputed. The OWNERSHIP cannot: a spilled `2` and a typed `2` are the same
//! bytes, so "which cells belong to which origin" is not recoverable from the
//! grid at any price short of re-evaluating every formula in the workbook. So
//! this module persists the extent (`SavedCell::spill`, written as the `sp`
//! field, format version 7) and restores it directly.
//!
//! # Two entry points
//!
//! * [`restore_spill_map_from_workbook`] — v7 and later. Reads the extents the
//!   file carries. No evaluation, no grid writes, O(spilled cells).
//! * [`recover_spill_map_by_evaluation`] — v1..v6 and `.xlsx`, which carry the
//!   spilled literals with no record of who owns them. Re-evaluates each
//!   formula and claims a footprint ONLY when the file's own values agree with
//!   it cell for cell. Read-only with respect to the grid: it never writes,
//!   never repairs and never overwrites, so a workbook it cannot make sense of
//!   is left exactly as it was rather than guessed at.

use crate::persistence::UserFilesState;
use crate::AppState;
use crate::log_info;
use engine::CellValue;

/// The largest footprint a single restored extent may claim.
///
/// A file-integrity guard, not a policy: this is one full column, which is
/// already the largest map a live session could have built for one origin, so
/// nothing a user can do in the app is refused here. What it stops is a
/// corrupted or hand-edited `sp` claiming a rectangle whose area alone would
/// exhaust memory before anything got to validate it.
const MAX_RESTORED_SPILL_CELLS: u64 = 1_048_576;

/// What a restore or a recovery did, for the log and for the tests.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct SpillRestoreReport {
    /// Origins whose footprint was claimed.
    pub restored: usize,
    /// Origins whose stored extent was rejected (unparseable, overlapping
    /// another origin's claim, over the size guard, or on a cell that is no
    /// longer a formula).
    pub rejected: usize,
    /// Formula cells the recovery pass evaluated. Zero for the v7 path, which
    /// evaluates nothing.
    pub evaluated: usize,
}

/// Restore `spill_ranges` / `spill_hosts` from the extents a v7+ workbook
/// carries.
///
/// Must run AFTER `reset_document_scoped_stores` has cleared the outgoing
/// document's maps and after the grids are installed — it is the "refill"
/// half that the reset's comment always assumed existed.
///
/// Dependency maps are NOT required: an extent is a fact read off the file, so
/// nothing here evaluates, orders or cascades.
///
/// TWO CLAIMS ARE REFUSED, and both refusals fall back to the pre-v7
/// behaviour, which the recovery pass below can still repair:
///
/// * an extent on a cell that no longer holds a formula — there would be
///   nothing to re-derive the array from, so the claim could only destroy the
///   cells it covers on the next tear-down;
/// * an extent overlapping a claim another origin already made — a
///   well-formed file cannot contain one, and honouring the second would let
///   one origin's tear-down erase another's output.
pub(crate) fn restore_spill_map_from_workbook(
    state: &AppState,
    sheets: &[persistence::Sheet],
) -> SpillRestoreReport {
    let mut report = SpillRestoreReport::default();
    for (sheet_index, sheet) in sheets.iter().enumerate() {
        let one = restore_spill_extents_for_sheet(state, sheet_index, sheet);
        report.restored += one.restored;
        report.rejected += one.rejected;
    }
    report
}

/// Install ONE sheet's stored extents at `sheet_index`, replacing whatever that
/// index claimed before.
///
/// Two callers, and the replacement is for the second of them:
///
/// * the `.cala` open path, where the maps were just cleared wholesale by
///   `reset_document_scoped_stores` and there is nothing to replace;
/// * the `.calp` paths, which install a PULLED sheet into a live workbook —
///   appended at subscribe, and OVERWRITTEN in place at refresh, dev-refresh
///   and Reset to package. An overwrite replaces the whole grid at that index,
///   so every claim the previous content made is void the moment it lands;
///   leaving them would point `check_spill_protection` at cells the incoming
///   package never spilled, which is §2x's class of defect one document over.
///
/// A subscriber therefore gets exactly the publisher's answer: the package
/// carries the same `sp` field a `.cala` does (both go through
/// `cells_to_sheet_data` / `sheet_data_to_cells`), so the array is owned on the
/// subscriber's machine the moment it is pulled, without a recalculation.
pub(crate) fn restore_spill_extents_for_sheet(
    state: &AppState,
    sheet_index: usize,
    sheet: &persistence::Sheet,
) -> SpillRestoreReport {
    let mut report = SpillRestoreReport::default();

    // LOAD PATH. `open_file` / `new_file` rebuild every store from disk and assign
    // `is_modified = false` as their last act, so a write here must not fight that:
    // restoring a document's own spill extents is not the user modifying it.
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    let (Ok(mut spill_ranges), Ok(mut spill_hosts)) =
        (state.spill_ranges.write(&effect), state.spill_hosts.lock())
    else {
        return report;
    };

    // Drop this sheet's previous claims. `spill_ranges` is keyed by origin and
    // `spill_hosts` by spilled cell, so both have to be swept; a `spill_hosts`
    // entry left behind is precisely the orphan that refuses an edit while
    // naming a source cell that no longer exists.
    spill_ranges.retain(|&(s, _, _), _| s != sheet_index);
    spill_hosts.retain(|&(s, _, _), _| s != sheet_index);

    // ONE pass over the sheet's cells, and it is the only per-CELL work this
    // function does: everything below is per-EXTENT. A workbook with no
    // dynamic array therefore pays a single linear scan with no allocation and
    // no evaluation, which is the whole reason the extent is persisted rather
    // than re-derived.
    let mut origins: Vec<(u32, u32, u32, u32)> = Vec::new();
    for (&(row, col), cell) in sheet.cells.iter() {
        let Some((end_row, end_col)) = cell.spill else {
            continue;
        };
        if cell.formula.is_none() {
            report.rejected += 1;
            continue;
        }
        origins.push((row, col, end_row, end_col));
    }
    // Deterministic order, so an overlap is resolved the same way on every
    // open of the same file rather than by HashMap iteration order.
    origins.sort_unstable();

    for (row, col, end_row, end_col) in origins {
        if end_row < row || end_col < col {
            report.rejected += 1;
            continue;
        }
        let area = (u64::from(end_row - row) + 1) * (u64::from(end_col - col) + 1);
        if area <= 1 || area > MAX_RESTORED_SPILL_CELLS {
            report.rejected += 1;
            continue;
        }

        let mut claimed: Vec<(u32, u32)> = Vec::with_capacity(area as usize - 1);
        let mut overlaps = false;
        for r in row..=end_row {
            for c in col..=end_col {
                if (r, c) == (row, col) {
                    continue;
                }
                if spill_hosts.contains_key(&(sheet_index, r, c)) {
                    overlaps = true;
                    break;
                }
                claimed.push((r, c));
            }
            if overlaps {
                break;
            }
        }
        // An origin cannot be another origin's spilled cell either — that is
        // the one shape `spill_hosts` alone cannot express, because the
        // tear-down keys on the origin.
        if spill_hosts.contains_key(&(sheet_index, row, col)) {
            overlaps = true;
        }
        if overlaps {
            report.rejected += 1;
            continue;
        }

        for &(r, c) in &claimed {
            spill_hosts.insert((sheet_index, r, c), (row, col));
        }
        spill_ranges.insert((sheet_index, row, col), claimed);
        report.restored += 1;
    }

    report
}

/// One sheet's spill claims in the shape an undo snapshot carries them:
/// `(origin_row, origin_col, the cells that origin fills)`.
pub(crate) type SheetSpillClaims = Vec<(u32, u32, Vec<(u32, u32)>)>;

/// Read one sheet's live spill claims, deterministically ordered.
///
/// `spill_ranges` is the authority — `spill_hosts` is its inverse index and is
/// rebuilt from it — so this reads one map and the swap below writes both.
pub(crate) fn sheet_spill_claims(state: &AppState, sheet_index: usize) -> SheetSpillClaims {
    let Ok(ranges) = state.spill_ranges.read() else {
        return Vec::new();
    };
    let mut out: SheetSpillClaims = ranges
        .iter()
        .filter(|((s, _, _), _)| *s == sheet_index)
        .map(|((_, r, c), cells)| (*r, *c, cells.clone()))
        .collect();
    out.sort_unstable_by_key(|(r, c, _)| (*r, *c));
    out
}

/// Install `claims` as `sheet_index`'s spill claims, returning what it held
/// before — the symmetric swap an undo needs.
///
/// WHY THIS EXISTS. `restore_spill_extents_for_sheet` above reads its claims out
/// of a `persistence::Sheet`, which is what every FORWARD path has: a pulled
/// sheet, a file being opened. An UNDO has no such sheet. It has the claims the
/// grid held a moment ago, and it has to put exactly those back and hand the
/// current ones to the redo.
///
/// The gap this closes: undo of a "Reset to published" rebuilt the grid and the
/// override layer and touched neither map, so the publisher's extents stayed
/// installed over the subscriber's restored cells. The cells the array had
/// covered came back EMPTY and refused every edit — `check_spill_protection`
/// found the stale `spill_hosts` key and named a formula that no longer existed
/// anywhere in the workbook. Nothing repaired it, because the restored origin
/// was a literal and `recalculate_sheet_values` only walks formulas. It lasted
/// the whole session.
///
/// Refuses an overlapping claim for the same reason
/// `restore_spill_extents_for_sheet` does, and by the same shape: honouring the
/// second would let one origin's tear-down erase another's output. A refused
/// claim is simply dropped — the ordinary pre-v7 behaviour, not a corruption.
pub(crate) fn swap_sheet_spill_claims(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    sheet_index: usize,
    claims: &[(u32, u32, Vec<(u32, u32)>)],
) -> SheetSpillClaims {
    let (Ok(mut spill_ranges), Ok(mut spill_hosts)) =
        (state.spill_ranges.write(effect), state.spill_hosts.lock())
    else {
        return Vec::new();
    };

    let mut previous: SheetSpillClaims = spill_ranges
        .iter()
        .filter(|((s, _, _), _)| *s == sheet_index)
        .map(|((_, r, c), cells)| (*r, *c, cells.clone()))
        .collect();
    previous.sort_unstable_by_key(|(r, c, _)| (*r, *c));

    spill_ranges.retain(|&(s, _, _), _| s != sheet_index);
    spill_hosts.retain(|&(s, _, _), _| s != sheet_index);

    // Deterministic, so an overlap in a hand-edited or corrupted snapshot is
    // resolved the same way every time rather than by iteration order.
    let mut incoming: Vec<&(u32, u32, Vec<(u32, u32)>)> = claims.iter().collect();
    incoming.sort_unstable_by_key(|(r, c, _)| (*r, *c));

    for (row, col, cells) in incoming {
        if (cells.len() as u64) > MAX_RESTORED_SPILL_CELLS {
            continue;
        }
        let overlaps = cells
            .iter()
            .any(|&(r, c)| spill_hosts.contains_key(&(sheet_index, r, c)))
            || spill_hosts.contains_key(&(sheet_index, *row, *col));
        if overlaps {
            continue;
        }
        for &(r, c) in cells {
            spill_hosts.insert((sheet_index, r, c), (*row, *col));
        }
        spill_ranges.insert((sheet_index, *row, *col), cells.clone());
    }

    previous
}

/// Rebuild the spill map for a workbook written BEFORE the extent existed
/// (`.cala` v1..v6) or by a format that never had one (`.xlsx`).
///
/// Such a file carries the spilled cells as ordinary literals and no record of
/// who owns them. The only way back to ownership is to ask each formula what
/// array it produces, which is what this does — one evaluation per formula
/// cell, per sheet, no dependency ordering required.
///
/// # Why no ordering is needed, and why that is not an accident
///
/// A formula that reads a spilled range reads it from the GRID, and the grid
/// already holds every value the file cached — the cells were written before
/// the save and are restored before this runs. So each origin evaluates
/// against exactly the values that were on screen when the workbook was
/// saved, whatever order this visits them in. That is the same property that
/// lets Excel open an array-bearing workbook without recalculating it.
///
/// # Why it never writes
///
/// A footprint is claimed ONLY when the file's own values agree with the
/// freshly evaluated array cell for cell, including the origin. So there is
/// never anything to write: every cell the claim covers already holds the
/// value the array produces, and a cell the array leaves empty was never
/// persisted in the first place.
///
/// That is a deliberate refusal to guess. Where the values DISAGREE — the
/// origin's function behaves differently in this build, a precedent came back
/// `#REF!`, the workbook was written by a build with a different function set
/// — this pass claims nothing and leaves the grid untouched. The workbook then
/// behaves exactly as it did before this module existed (§2ab), which is bad
/// but honest, and it recovers on the first save: a re-spill through the
/// ordinary edit path writes a real extent and stamps the file v7.
///
/// The alternative — claiming the footprint anyway and overwriting whatever is
/// under it — would silently delete cells on the strength of a guess about
/// which of them used to belong to an array. Nothing in the file supports that
/// guess, and the cost of being wrong is unrecoverable data loss.
pub(crate) fn recover_spill_map_by_evaluation(
    state: &AppState,
    user_files_state: &UserFilesState,
) -> SpillRestoreReport {
    let mut report = SpillRestoreReport::default();

    // PER-FORMULA FUEL CEILING, declared rather than inherited. This runs on
    // the OPEN path, where nothing else has installed a governor, and it
    // evaluates arbitrary formulas out of an untrusted file — so a runaway
    // formula in a pre-v7 workbook must cost a bounded amount of work and come
    // back `#LIMIT!` (which is simply not an array, so nothing is claimed)
    // rather than hang the open with no Cancel button anywhere. `Background`
    // is the right surface for exactly the reason its doc gives: the user did
    // not personally start this pass.
    let _governor = crate::eval_budget::inherit_or(crate::eval_budget::EvalSurface::Background);

    // CANONICAL LOCK ORDER: `grids` FIRST, then everything else, spill maps
    // last. THE ORDER BELOW WAS THE OTHER WAY ROUND AND IT DEADLOCKED THE APP.
    //
    // The comment that used to sit here declared the opposite rule -- "every-
    // thing that is not a grid first, grids next" -- and asserted that nothing
    // here could invert it. Neither half was true. The crate's canonical order
    // is set by `run_calculation_pass` and `recalculate_sheet_values`, which
    // BOTH take `grid`, then `grids`, and only then `sheet_names` / `user_files`
    // / `tables` / `table_names` / `named_ranges`; and both of them run on
    // background threads, so a main-thread path that takes those the other way
    // round closes a cycle.
    //
    // MEASURED, from the stacks of a wedged process (2026-08-11, scenario
    // project, dumped from OUTSIDE because the logger is inside the wedge):
    //
    //   main thread 44452:  open_file -> restore_spill_map_on_load ->
    //     recover_spill_map_by_evaluation  HOLDS sheet_names, tables,
    //     table_names, named_ranges, user_files  WAITS for grids
    //   worker 88412 (queue_gather_refresh's own std::thread):
    //     recalculate_sheet_values  HOLDS grid + grids  WAITS for sheet_names
    //
    // Both stacks identical in two dumps five seconds apart. The app answers
    // nothing from that moment: the main thread is inside a synchronous
    // command, so the WebView2 message pump stops with it -- no panic, no
    // crash, and the log's last line is whatever was written before it, which
    // is why three passes attributed this to the digest.
    //
    // `no_lock_is_held_while_a_grid_lock_is_acquired` in
    // `state_digest_lock_order_tests` now enforces the order crate-wide, and
    // `the_load_paths_spill_recovery_does_not_hold_sheet_names_while_it_waits_for_grids`
    // in the same file runs THIS function against a held `grids` and fails --
    // rather than hanging -- if the order below is ever put back.
    let grids = match state.grids.read() {
        Ok(g) => g,
        Err(_) => return report,
    };
    let sheet_names = match state.sheet_names.read() {
        Ok(g) => g,
        Err(_) => return report,
    };
    let user_files = match user_files_state.files.lock() {
        Ok(g) => g,
        Err(_) => return report,
    };
    let tables = match state.tables.read() {
        Ok(g) => g,
        Err(_) => return report,
    };
    let table_names = match state.table_names.read() {
        Ok(g) => g,
        Err(_) => return report,
    };
    let named_ranges = match state.named_ranges.read() {
        Ok(g) => g,
        Err(_) => return report,
    };

    // (sheet_index, origin, footprint) for every array this pass could prove.
    let mut proven: Vec<(usize, (u32, u32), Vec<(u32, u32)>)> = Vec::new();

    for sheet_index in 0..grids.len().min(sheet_names.len()) {
        let mut formula_cells: Vec<(u32, u32)> = grids[sheet_index]
            .cells
            .iter()
            .filter(|(_, cell)| cell.get_cached_ast().is_some())
            .map(|(&key, _)| key)
            .collect();
        formula_cells.sort_unstable();

        for (row, col) in formula_cells {
            // CHEAP AND SOUND PRUNE. A multi-cell array always occupies
            // (row+1, col) when it has more than one row and (row, col+1) when
            // it has more than one column, so if BOTH of those hold a formula
            // then every possible array from this origin is blocked and there
            // is nothing this pass could claim. Skipping costs an evaluation
            // and can never skip a recoverable array.
            let below_is_formula = grids[sheet_index]
                .get_cell(row.saturating_add(1), col)
                .is_some_and(|c| c.get_cached_ast().is_some());
            let right_is_formula = grids[sheet_index]
                .get_cell(row, col.saturating_add(1))
                .is_some_and(|c| c.get_cached_ast().is_some());
            if below_is_formula && right_is_formula {
                continue;
            }

            let raw = {
                let Some(cell) = grids[sheet_index].get_cell(row, col) else {
                    continue;
                };
                let Some(cached) = cell.get_cached_ast() else {
                    continue;
                };
                let name_ctx = crate::name_resolution::NameEvalCtx {
                    named_ranges: &named_ranges,
                    tables: &tables,
                    table_names: &table_names,
                    sheet_names: &sheet_names,
                    spill_ranges: &state.spill_ranges,
                    sheet_index,
                    row,
                    col,
                };
                let eval_target = crate::name_resolution::eval_ast(cached, &name_ctx);
                let eval_ctx = engine::EvalContext {
                    cube_prefetch: None,
                    current_row: Some(row),
                    current_col: Some(col),
                    row_heights: None,
                    column_widths: None,
                    hidden_rows: None,
                    control_values: None,
                };
                crate::evaluate_formula_raw_with_files_and_pivot(
                    &grids,
                    &sheet_names,
                    sheet_index,
                    &eval_target,
                    eval_ctx,
                    None,
                    &user_files,
                    None,
                    None,
                    None,
                )
            };
            report.evaluated += 1;

            let (spill_rows, spill_cols) = raw.spill_dimensions();
            if spill_rows <= 1 && spill_cols <= 1 {
                continue;
            }
            let values = raw.to_spill_values();
            if (values.len() as u64) > MAX_RESTORED_SPILL_CELLS {
                continue;
            }

            let mut claimed: Vec<(u32, u32)> = Vec::with_capacity(values.len());
            let mut agrees = true;
            for (dr, dc, value) in &values {
                let (Some(target_row), Some(target_col)) =
                    (row.checked_add(*dr), col.checked_add(*dc))
                else {
                    agrees = false;
                    break;
                };
                let stored = grids[sheet_index]
                    .get_cell(target_row, target_col)
                    .map(|c| &c.value)
                    .unwrap_or(&CellValue::Empty);
                if stored != value {
                    agrees = false;
                    break;
                }
                // The ORIGIN keeps its formula and is not one of its own
                // spilled cells; a formula anywhere ELSE inside the footprint
                // means the file never had a clean spill here.
                if *dr != 0 || *dc != 0 {
                    if grids[sheet_index]
                        .get_cell(target_row, target_col)
                        .is_some_and(|c| c.get_cached_ast().is_some())
                    {
                        agrees = false;
                        break;
                    }
                    claimed.push((target_row, target_col));
                }
            }
            if !agrees || claimed.is_empty() {
                continue;
            }
            proven.push((sheet_index, (row, col), claimed));
        }
    }

    // Released in the reverse of the acquisition order above. All six are gone
    // before `commit_recovered_spills` takes the spill maps, which is what lets
    // the spill maps be last in the canonical order without this function
    // having to hold anything across them.
    drop(named_ranges);
    drop(table_names);
    drop(tables);
    drop(user_files);
    drop(sheet_names);
    drop(grids);

    commit_recovered_spills(state, proven, &mut report);
    report
}

/// Write the arrays [`recover_spill_map_by_evaluation`] proved into the two
/// maps.
///
/// A SEPARATE FUNCTION, not an inlined tail, and the separation is structural
/// rather than tidy: `eval_ast` now takes `state.spill_ranges` to resolve `A1#`
/// (§3bf), and `std::sync::Mutex` is not reentrant, so a function that holds
/// that lock and also evaluates a formula deadlocks. The evaluation half above
/// and the map-writing half here can no longer be interleaved by accident
/// because they cannot see each other's locals — and
/// `spill_ref_tests::no_spill_map_holder_also_resolves_a_formula` enumerates
/// the crate for the combination.
fn commit_recovered_spills(
    state: &AppState,
    proven: Vec<(usize, (u32, u32), Vec<(u32, u32)>)>,
    report: &mut SpillRestoreReport,
) {
    // Same load-path reasoning as `restore_spill_extents_for_sheet`: this is the
    // pre-v7 recovery arm, reconstructing ownership a document already had.
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    let (Ok(mut spill_ranges), Ok(mut spill_hosts)) =
        (state.spill_ranges.write(&effect), state.spill_hosts.lock())
    else {
        return;
    };
    for (sheet_index, (row, col), claimed) in proven {
        // Two proven arrays cannot overlap (a cell inside one holds no
        // formula, so it is never an origin, and a value can only equal one
        // array's output at one offset) — but the check is cheap and the cost
        // of being wrong is a tear-down erasing another origin's cells.
        if claimed
            .iter()
            .any(|&(r, c)| spill_hosts.contains_key(&(sheet_index, r, c)))
            || spill_hosts.contains_key(&(sheet_index, row, col))
        {
            report.rejected += 1;
            continue;
        }
        for &(r, c) in &claimed {
            spill_hosts.insert((sheet_index, r, c), (row, col));
        }
        spill_ranges.insert((sheet_index, row, col), claimed);
        report.restored += 1;
    }
}

/// The whole load-path decision in one place: read the extents a v7+ file
/// carries, or recover them by evaluation for anything older.
///
/// `format_version` is the version the file WAS READ AT
/// (`persistence::Workbook::format_version`; `0` for `.xlsx` and for a
/// workbook built in memory), so a v7 file never pays for the recovery and an
/// older one pays exactly once per open — and stops paying the first time it
/// is saved, because saving stamps the extents it now knows about.
pub(crate) fn restore_spill_map_on_load(
    state: &AppState,
    user_files_state: &UserFilesState,
    sheets: &[persistence::Sheet],
    format_version: u32,
) -> SpillRestoreReport {
    if format_version >= calcula_format::SPILL_EXTENT_MIN_FORMAT_VERSION {
        let report = restore_spill_map_from_workbook(state, sheets);
        log_info!(
            "SPILL",
            "restored {} spill extent(s) from the file, rejected {}",
            report.restored,
            report.rejected
        );
        report
    } else {
        let started = std::time::Instant::now();
        let report = recover_spill_map_by_evaluation(state, user_files_state);
        log_info!(
            "SPILL",
            "pre-v{} workbook: recovered {} spill map(s) by evaluating {} formula cell(s) in {:?}",
            calcula_format::SPILL_EXTENT_MIN_FORMAT_VERSION,
            report.restored,
            report.evaluated,
            started.elapsed()
        );
        report
    }
}
