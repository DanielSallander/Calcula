//! FILENAME: app/src-tauri/src/commands/spill_map_tests.rs
//! PURPOSE: §2y — the spill map has ONE maintainer, and every path that removes
//! or overwrites a spill ORIGIN reaches it.
//!
//! A child module of `commands::data` (declared with `#[path]` there) so it
//! reaches `check_spill_protection`, `take_spills_owned_within`,
//! `spilled_cells_owned_within` and `recalc_after_active_sheet_bulk_rewrite`,
//! all private to that module. It reuses the `Workbook` harness from
//! `cross_sheet_recalc_tests` rather than copying one, for the reason stated
//! there: a copied harness drifts, and a drifted harness is how this class of
//! defect hides.
//!
//! THE DEFECT THIS PINS. The spill map (`spill_ranges`: origin -> the cells it
//! spilled into; `spill_hosts`: spilled cell -> its origin) was maintained by
//! `update_cell` and by nothing else. **The Delete key is not `update_cell`** —
//! it is `clear_range`, which CHECKED the map and never wrote to it. So, inside
//! one document, on the first press:
//!
//! ```text
//! A1 "=SEQUENCE(4)"      -> A1..A4 = 1 2 3 4   spill_ranges [{0,0 -> 3,0}]
//! clear_range A1:A1      -> A1 empty           spill_ranges UNCHANGED
//! update_cell A2 "typed" -> REFUSED "...spilled from cell (1,1). Edit or
//!                           delete the formula in the source cell instead."
//! clear_range A1:A4      -> REFUSED "...you will need to modify that formula."
//! ```
//!
//! A2:A4 showed `2 3 4` that no formula produced, could not be edited and could
//! not be deleted for the rest of the session, and **both remedies the messages
//! named were impossible** — the source cell was already empty, and deleting
//! the block was refused by the same guard. They saved as orphan literals.
//!
//! THE TWO HALVES OF THE FIX, and why neither works alone:
//!
//!   1. the tear-down moved to a CHOKE POINT — `recalc_after_active_sheet_bulk_
//!      rewrite`, where a seed that no longer holds a formula releases whatever
//!      spill it owned. Every bulk rewrite already ends there, so `clear_range`,
//!      Clear Contents, a sort that moved an origin, an undo that cleared one
//!      and the redo that cleared it again are all covered by one rule instead
//!      of five remembered call sites;
//!   2. `check_spill_protection` gained [`SpillOriginPolicy`], so a rectangle
//!      that swallows the ORIGIN stops being refused. Without (2) "select the
//!      spill and press Delete" stays impossible after (1) fixes everything
//!      else; without (1) it becomes a silent leak instead of a dead end.
//!
//! AND THE HALF THE REGISTER HAD BACKWARDS, pinned by
//! `restoring_spilled_literals_beside_a_restored_origin_is_what_blocks_the_
//! respill`: the filed fix said the cleared spill cells should each get an
//! `undo_stack.record_cell_change`. They must NOT. `apply_changes` puts every
//! recorded cell back BEFORE it recalculates, so restored literals in A2:A4 are
//! sitting there when the restored `=SEQUENCE(4)` re-evaluates,
//! `reevaluate_formula_cell` finds occupied cells that are not its own spill —
//! the map entry left with the clear — and the undo lands on `#VALUE!` instead
//! of the array. Undo restores the ORIGIN; the cascade re-spills it.

use super::cross_sheet_recalc_tests::{body_of, Workbook};
use super::*;
use engine::{CellError, CellValue};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// The spill map as `get_spill_ranges` would report it: origin -> spilled cells.
fn spill_ranges_of(wb: &Workbook) -> Vec<((usize, u32, u32), Vec<(u32, u32)>)> {
    let mut out: Vec<((usize, u32, u32), Vec<(u32, u32)>)> = wb
        .state
        .spill_ranges
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .iter()
        .map(|(k, v)| {
            let mut cells = v.clone();
            cells.sort_unstable();
            (*k, cells)
        })
        .collect();
    out.sort_unstable();
    out
}

fn spill_hosts_of(wb: &Workbook) -> Vec<((usize, u32, u32), (u32, u32))> {
    let mut out: Vec<((usize, u32, u32), (u32, u32))> = wb
        .state
        .spill_hosts
        .lock()
        .unwrap()
        .iter()
        .map(|(k, v)| (*k, *v))
        .collect();
    out.sort_unstable();
    out
}

/// EXACTLY what `clear_range` does, phase for phase, on the active sheet.
///
/// `clear_range` is a `#[tauri::command]` taking `State<AppState>` and cannot be
/// invoked in-process, so this reproduces its sequence — guard, spill exclusion,
/// undo-recording clear loop, then the shared cascade — and
/// `clear_range_still_runs_the_four_phases_this_harness_reproduces` pins from
/// source that the command still does the same four things in the same order.
/// The same split every other command test in this crate uses.
fn clear_range_like_the_command(
    wb: &Workbook,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<u32, String> {
    let active_sheet = *wb.state.active_sheet.read().unwrap();

    // Phase 1 — the guard, with the clear's policy.
    {
        let spill_hosts = wb.state.spill_hosts.lock().unwrap();
        check_spill_protection(
            &spill_hosts,
            active_sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            SpillOriginPolicy::ReleasedByCaller,
        )?;
    }

    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    let seeds: Vec<(u32, u32)> = {
        let mut grid = wb.state.grid.write(&effect).unwrap();
        let mut grids = wb.state.grids.write(&effect).unwrap();
        let mut dependents_map = wb.state.dependents.lock().unwrap();
        let mut dependencies_map = wb.state.dependencies.lock().unwrap();
        let mut column_dependents_map = wb.state.column_dependents.lock().unwrap();
        let mut column_dependencies_map = wb.state.column_dependencies.lock().unwrap();
        let mut row_dependents_map = wb.state.row_dependents.lock().unwrap();
        let mut row_dependencies_map = wb.state.row_dependencies.lock().unwrap();
        let mut cross_sheet_dependents_map = wb.state.cross_sheet_dependents.lock().unwrap();
        let mut cross_sheet_dependencies_map = wb.state.cross_sheet_dependencies.lock().unwrap();
        let mut undo_stack = wb.state.undo_stack.lock().unwrap();

        let effective_end_row = end_row.min(grid.max_row);
        let effective_end_col = end_col.min(grid.max_col);

        // Phase 2 — spilled values owned by an origin inside the rectangle are
        // not this loop's business.
        let owned_spill = spilled_cells_owned_within(
            &wb.state,
            active_sheet,
            start_row,
            start_col,
            effective_end_row,
            effective_end_col,
        );

        let cells_to_clear: Vec<(u32, u32)> = grid
            .cells
            .keys()
            .filter(|(r, c)| {
                *r >= start_row
                    && *r <= effective_end_row
                    && *c >= start_col
                    && *c <= effective_end_col
            })
            .filter(|coord| !owned_spill.contains(coord))
            .cloned()
            .collect();

        // Phase 3 — the undo-recording clear loop.
        if !cells_to_clear.is_empty() {
            undo_stack.begin_transaction("Clear range".to_string());
        }
        let mut seeds = Vec::new();
        for (row, col) in cells_to_clear {
            let previous_cell = grid.get_cell(row, col).cloned();
            if previous_cell.is_some() {
                seeds.push((row, col));
                undo_stack.record_cell_change(active_sheet, row, col, previous_cell);
            }
            grid.clear_cell(row, col);
            if active_sheet < grids.len() {
                grids[active_sheet].clear_cell(row, col);
            }
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
        if !seeds.is_empty() {
            undo_stack.commit_transaction();
        }
        seeds
    };

    // Phase 4 — the shared cascade, which is where the tear-down lives.
    if !seeds.is_empty() {
        let mut updated = Vec::new();
        recalc_after_active_sheet_bulk_rewrite(
            &wb.state,
            &wb.files,
            &wb.pane,
            &wb.filters,
            &seeds,
            &mut updated,
        );
    }
    Ok(seeds.len() as u32)
}

/// One real undo (or redo) through `apply_changes` — the shared body both
/// commands run.
fn undo_once(wb: &Workbook) -> bool {
    let Some(transaction) = wb.state.undo_stack.lock().unwrap().pop_undo() else {
        return false;
    };
    crate::undo_commands::apply_changes(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.slicer,
        &wb.filters,
        &wb.pane,
        &wb.timelines,
        transaction,
        true,
    )
    .success
}

fn redo_once(wb: &Workbook) -> bool {
    let Some(transaction) = wb.state.undo_stack.lock().unwrap().pop_redo() else {
        return false;
    };
    crate::undo_commands::apply_changes(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.slicer,
        &wb.filters,
        &wb.pane,
        &wb.timelines,
        transaction,
        false,
    )
    .success
}

/// A workbook with `=SEQUENCE(4)` in A1, spilled down A1:A4, asserted so every
/// test below starts from the state the reproduction starts from.
fn workbook_with_a_spill() -> Workbook {
    let wb = Workbook::new(2);
    wb.set(0, 0, "=SEQUENCE(4)");

    assert_eq!(wb.value(0, 0, 0), CellValue::Number(1.0));
    assert_eq!(wb.value(0, 1, 0), CellValue::Number(2.0));
    assert_eq!(wb.value(0, 2, 0), CellValue::Number(3.0));
    assert_eq!(wb.value(0, 3, 0), CellValue::Number(4.0));
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])],
        "the precondition failed: A1 did not spill, so nothing below is testing \
         what it claims"
    );
    wb
}

// ---------------------------------------------------------------------------
// 1. The register's reproduction, start to finish
// ---------------------------------------------------------------------------

/// §2y verbatim: press Delete on the ORIGIN alone and the spilled cells must
/// leave with it — map, grid and editability together.
#[test]
fn deleting_the_origin_takes_the_whole_spill_with_it() {
    let wb = workbook_with_a_spill();

    let cleared = clear_range_like_the_command(&wb, 0, 0, 0, 0).expect("Delete on A1 was refused");
    assert_eq!(cleared, 1, "the clear loop should have cleared A1 and only A1");

    // The map is the thing that used to survive.
    assert!(
        spill_ranges_of(&wb).is_empty(),
        "clearing the ORIGIN left `spill_ranges` claiming cells for a formula \
         that no longer exists: {:?}",
        spill_ranges_of(&wb)
    );
    assert!(
        spill_hosts_of(&wb).is_empty(),
        "clearing the ORIGIN left `spill_hosts` claims behind: {:?}",
        spill_hosts_of(&wb)
    );

    // And the values no formula produces are gone from BOTH grids, not merely
    // unclaimed — otherwise they would still save as orphan literals.
    for row in 0..4u32 {
        assert_eq!(
            wb.value(0, row, 0),
            CellValue::Empty,
            "({},0) still holds a value after its origin was deleted",
            row
        );
    }

    // The dead end is gone in both directions the messages named.
    wb.set(1, 0, "typed");
    assert_eq!(
        wb.value(0, 1, 0),
        CellValue::Text("typed".to_string()),
        "A2 is still uneditable after its origin was deleted — the message told \
         the user to edit or delete a formula in a cell that is empty"
    );
}

/// The second impossible remedy: selecting the whole block and pressing Delete.
#[test]
fn deleting_the_whole_spilled_block_is_allowed_and_removes_it() {
    let wb = workbook_with_a_spill();

    clear_range_like_the_command(&wb, 0, 0, 3, 0)
        .expect("selecting A1:A4 and pressing Delete was refused — the second of \
                 the two remedies §2y showed to be impossible");

    assert!(spill_ranges_of(&wb).is_empty());
    assert!(spill_hosts_of(&wb).is_empty());
    for row in 0..4u32 {
        assert_eq!(wb.value(0, row, 0), CellValue::Empty);
    }
}

/// The guard is not simply gone: a rectangle that cuts an array in half without
/// taking its origin is refused exactly as before, and with the same message.
#[test]
fn deleting_only_the_spilled_cells_is_still_refused() {
    let wb = workbook_with_a_spill();

    let err = clear_range_like_the_command(&wb, 1, 0, 3, 0)
        .expect_err("A2:A4 was deleted without its origin — the array would be \
                     silently cut in half");
    assert!(
        err.contains("A1"),
        "the refusal must still name the origin the user has to edit: {}",
        err
    );

    // Nothing moved.
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])]
    );
    assert_eq!(wb.value(0, 1, 0), CellValue::Number(2.0));
}

// ---------------------------------------------------------------------------
// 2. Undo restores the SPILL, not just the literals
// ---------------------------------------------------------------------------

#[test]
fn undo_of_the_delete_restores_the_spill_and_the_map_agrees() {
    let wb = workbook_with_a_spill();
    clear_range_like_the_command(&wb, 0, 0, 0, 0).unwrap();

    assert!(undo_once(&wb), "undo reported failure");

    // The formula is back...
    assert_eq!(
        wb.state.grid.read().unwrap().get_cell(0, 0).and_then(|c| c.formula_string()),
        Some("SEQUENCE(4)".to_string()),
        "undo did not restore the origin formula"
    );
    // ...and it SPILLED again, rather than landing on the #VALUE! that a
    // blocked re-spill produces.
    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Number(1.0),
        "the restored origin did not re-evaluate to the array's first value"
    );
    assert_eq!(wb.value(0, 1, 0), CellValue::Number(2.0));
    assert_eq!(wb.value(0, 2, 0), CellValue::Number(3.0));
    assert_eq!(wb.value(0, 3, 0), CellValue::Number(4.0));

    // The map must agree, or the restored cells are unprotected literals that
    // look right until somebody types over one.
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])],
        "undo restored the VALUES without restoring the spill map — A2:A4 are \
         now ordinary literals that no formula owns"
    );
    assert_eq!(
        spill_hosts_of(&wb),
        vec![
            ((0, 1, 0), (0, 0)),
            ((0, 2, 0), (0, 0)),
            ((0, 3, 0), (0, 0)),
        ]
    );

    // Protection is back with it.
    let err = wb
        .state
        .spill_hosts
        .lock()
        .unwrap()
        .get(&(0, 1, 0))
        .copied();
    assert_eq!(
        err,
        Some((0, 0)),
        "A2 is editable after the undo — the spill came back as loose values"
    );
}

/// The other direction. Redo re-runs the clear as a `SetCell -> None` restore,
/// which is a path with no `clear_range` in it at all; before the choke point
/// existed it re-created §2y from inside undo.
#[test]
fn redo_of_the_delete_takes_the_spill_down_again() {
    let wb = workbook_with_a_spill();
    clear_range_like_the_command(&wb, 0, 0, 0, 0).unwrap();
    assert!(undo_once(&wb));
    assert!(redo_once(&wb), "redo reported failure");

    assert!(
        spill_ranges_of(&wb).is_empty(),
        "REDOING the delete left the spill map behind — §2y, reached through \
         `apply_changes` instead of through `clear_range`: {:?}",
        spill_ranges_of(&wb)
    );
    for row in 0..4u32 {
        assert_eq!(
            wb.value(0, row, 0),
            CellValue::Empty,
            "({},0) survived the redo of its origin's deletion",
            row
        );
    }
}

/// THE FIXED FIX'S OWN PREMISE, stated as a test rather than as prose.
///
/// The register filed "give each cleared spill cell an `undo_stack.record_cell_
/// change`" as half the fix. This is what that would produce: literals sitting
/// in A2:A4 when the restored origin re-evaluates. `reevaluate_formula_cell`
/// refuses to spill over occupied cells it does not own, so the origin lands on
/// `#VALUE!` and the undo destroys the array it was undoing back to.
#[test]
fn restoring_spilled_literals_beside_a_restored_origin_is_what_blocks_the_respill() {
    let wb = Workbook::new(2);
    // Exactly the state "record the spill cells for undo" restores: the origin
    // formula, plus foreign literals in the cells it wants.
    wb.set(1, 0, "2");
    wb.set(2, 0, "3");
    wb.set(3, 0, "4");
    wb.set(0, 0, "=SEQUENCE(4)");

    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(CellError::Spill),
        "a blocked spill is supposed to report an error in the origin — if this \
         ever stops being true, the reason the cleared spill cells get no undo \
         entry has changed and `spilled_cells_owned_within` needs re-reading"
    );
    assert!(
        spill_ranges_of(&wb).is_empty(),
        "a blocked spill must claim nothing"
    );
}

/// The consequence, asserted directly on the transaction: a Delete over a
/// spilled block records the ORIGIN and nothing else.
#[test]
fn a_swallowed_spill_cell_gets_no_undo_entry() {
    let wb = workbook_with_a_spill();
    clear_range_like_the_command(&wb, 0, 0, 3, 0).unwrap();

    let transaction = wb
        .state
        .undo_stack
        .lock()
        .unwrap()
        .pop_undo()
        .expect("the clear recorded no undo step at all");
    let recorded: Vec<(u32, u32)> = transaction
        .changes
        .iter()
        .filter_map(|c| match c {
            engine::CellChange::SetCell { row, col, .. } => Some((*row, *col)),
            _ => None,
        })
        .collect();
    assert_eq!(
        recorded,
        vec![(0, 0)],
        "the clear recorded spilled cells for undo. Restoring them puts \
         literals in the way of the re-spill and the undo lands on #VALUE! — \
         see `restoring_spilled_literals_beside_a_restored_origin_is_what_\
         blocks_the_respill`"
    );
}

// ---------------------------------------------------------------------------
// 3. The guard's new policy, on its own
// ---------------------------------------------------------------------------

#[test]
fn the_origin_exemption_fires_only_for_an_origin_inside_the_rectangle() {
    let mut hosts: std::collections::HashMap<(usize, u32, u32), (u32, u32)> =
        std::collections::HashMap::new();
    // A1 spills A1:A4 on sheet 0.
    for r in 1..4u32 {
        hosts.insert((0, r, 0), (0, 0));
    }

    // Origin INSIDE, released by the caller: allowed.
    assert!(check_spill_protection(
        &hosts, 0, 0, 0, 3, 0, SpillOriginPolicy::ReleasedByCaller
    )
    .is_ok());

    // Origin inside, but the caller cannot release it: refused.
    assert!(check_spill_protection(
        &hosts, 0, 0, 0, 3, 0, SpillOriginPolicy::Refuse
    )
    .is_err());

    // Origin OUTSIDE the rectangle: refused under BOTH policies. This is the
    // half that must not be weakened — it is the whole of the array's
    // protection.
    for policy in [
        SpillOriginPolicy::ReleasedByCaller,
        SpillOriginPolicy::Refuse,
    ] {
        assert!(
            check_spill_protection(&hosts, 0, 1, 0, 3, 0, policy).is_err(),
            "A2:A4 was allowed under {:?} — its origin A1 is outside the \
             rectangle, so nothing would remove the formula that owns them",
            policy
        );
    }

    // ANOTHER SHEET's claims are invisible: the map is keyed by sheet, and a
    // rectangle answers only for the sheet it was asked about. Neither the
    // refusal nor the exemption may leak across.
    assert!(
        check_spill_protection(&hosts, 1, 1, 0, 3, 0, SpillOriginPolicy::Refuse).is_ok(),
        "sheet 0's spill refused a rectangle on sheet 1"
    );
    let mut other: std::collections::HashMap<(usize, u32, u32), (u32, u32)> =
        std::collections::HashMap::new();
    // On sheet 1, B1 spills B2:B4. A rectangle over COLUMN A on sheet 1 must
    // not be exempted by it, and a rectangle over B2:B4 must still be refused
    // because B1 is outside.
    other.insert((1, 1, 1), (0, 1));
    other.insert((1, 2, 1), (0, 1));
    assert!(
        check_spill_protection(&other, 1, 1, 1, 2, 1, SpillOriginPolicy::ReleasedByCaller).is_err(),
        "B2:B3 was allowed although its origin B1 lies outside the rectangle"
    );
    assert!(
        check_spill_protection(&other, 1, 0, 1, 2, 1, SpillOriginPolicy::ReleasedByCaller).is_ok(),
        "B1:B3 was refused although it swallows the origin B1"
    );
}

/// The exemption must survive BOTH scan strategies. `check_spill_protection`
/// picks between probing each coordinate and iterating the map by comparing the
/// rectangle's area with the map's size, and a fix applied to one branch only
/// is a fix that works until the workbook grows.
#[test]
fn the_origin_exemption_holds_on_both_sides_of_the_adaptive_scan() {
    let mut hosts: std::collections::HashMap<(usize, u32, u32), (u32, u32)> =
        std::collections::HashMap::new();
    for r in 1..4u32 {
        hosts.insert((0, r, 0), (0, 0));
    }

    // area 4 <= len 3 is false -> map-iteration branch.
    assert!(
        check_spill_protection(&hosts, 0, 0, 0, 3, 0, SpillOriginPolicy::ReleasedByCaller).is_ok()
    );

    // Pad the map so the rectangle is the smaller side -> coordinate-probe
    // branch, over the SAME rectangle and the same claims.
    for r in 100..200u32 {
        hosts.insert((0, r, 5), (100, 5));
    }
    assert!(
        (4u64) <= hosts.len() as u64,
        "the padding did not flip the strategy, so this test proves nothing"
    );
    assert!(
        check_spill_protection(&hosts, 0, 0, 0, 3, 0, SpillOriginPolicy::ReleasedByCaller).is_ok(),
        "the exemption is missing from the coordinate-probe branch"
    );
    // ...and the untouched spill in rows 100..200 is still protected.
    assert!(
        check_spill_protection(&hosts, 0, 150, 5, 160, 5, SpillOriginPolicy::ReleasedByCaller)
            .is_err()
    );
}

// ---------------------------------------------------------------------------
// 4. The tear-down primitive
// ---------------------------------------------------------------------------

#[test]
fn the_tear_down_removes_both_sides_of_the_map_and_reports_the_cells() {
    let wb = workbook_with_a_spill();

    let released = take_spills_owned_within(&wb.state, 0, 0, 0, 0, 0);
    assert_eq!(released, vec![(1, 0), (2, 0), (3, 0)]);
    assert!(spill_ranges_of(&wb).is_empty());
    assert!(
        spill_hosts_of(&wb).is_empty(),
        "the origin's entry went but its `spill_hosts` claims did not — the two \
         sides must move in lockstep or a cell is protected by a range that no \
         longer exists"
    );
}

#[test]
fn the_tear_down_leaves_a_spill_whose_origin_is_outside_the_rectangle_alone() {
    let wb = workbook_with_a_spill();

    assert!(take_spills_owned_within(&wb.state, 0, 1, 0, 3, 0).is_empty());
    assert!(take_spills_owned_within(&wb.state, 0, 0, 1, 9, 9).is_empty());
    assert!(
        take_spills_owned_within(&wb.state, 1, 0, 0, 3, 0).is_empty(),
        "a rectangle on sheet 1 released sheet 0's spill"
    );
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])]
    );
}

#[test]
fn the_tear_down_costs_nothing_on_a_workbook_with_no_dynamic_array() {
    // Behavioural half of the cost claim: the primitive answers without ever
    // consulting `spill_hosts`, which is the map that can be large. Proved by
    // holding that lock across the call — a `take` that touched it would
    // deadlock this test rather than fail it, so it is asserted the only way it
    // can be from in-process: the call returns while the lock is held.
    let wb = Workbook::new(1);
    wb.set(0, 0, "1");
    let hosts = wb.state.spill_hosts.lock().unwrap();
    assert!(take_spills_owned_within(&wb.state, 0, 0, 0, 1000, 1000).is_empty());
    drop(hosts);
}

// ---------------------------------------------------------------------------
// 5. The choke point covers the siblings, not just the Delete key
// ---------------------------------------------------------------------------

/// Overwriting the origin with a literal is `update_cell`'s own path, which
/// always maintained the map. Pinned because the tear-down moved: the shared
/// helper must do exactly what the four hand-written copies did.
#[test]
fn overwriting_the_origin_with_a_literal_releases_the_spill() {
    let wb = workbook_with_a_spill();
    wb.set(0, 0, "7");

    assert!(spill_ranges_of(&wb).is_empty());
    assert!(spill_hosts_of(&wb).is_empty());
    assert_eq!(wb.value(0, 0, 0), CellValue::Number(7.0));
    for row in 1..4u32 {
        assert_eq!(wb.value(0, row, 0), CellValue::Empty);
    }
}

/// FOUND BY THIS PASS, and NOT what §2y filed. The register's table says
/// `update_cell` maintains the map on both its branches. It maintained it on
/// the CLEAR branch and inside `if let Some(formula) = ... { Ok(parsed) => `,
/// which leaves two ways to overwrite a spill ORIGIN through the one command
/// the register called the map's correct maintainer:
///
///   * type a LITERAL over it — no formula, so neither branch ran;
///   * type a formula that does not PARSE — one level deeper.
///
/// Both left the exact §2y state: A2:A4 showing values no formula produced,
/// uneditable and undeletable for the session.
#[test]
fn overwriting_the_origin_with_something_that_is_not_a_formula_releases_the_spill() {
    for replacement in ["7", "just text", "=SEQ(", "=1+"] {
        let wb = workbook_with_a_spill();
        wb.set(0, 0, replacement);

        assert!(
            spill_ranges_of(&wb).is_empty(),
            "typing {:?} over the origin left `spill_ranges` behind: {:?}",
            replacement,
            spill_ranges_of(&wb)
        );
        assert!(spill_hosts_of(&wb).is_empty());
        for row in 1..4u32 {
            assert_eq!(
                wb.value(0, row, 0),
                CellValue::Empty,
                "typing {:?} over the origin left ({},0) holding a value no \
                 formula produces",
                replacement,
                row
            );
        }
        // ...and it is editable again, which is the user-visible half.
        wb.set(1, 0, "typed");
        assert_eq!(wb.value(0, 1, 0), CellValue::Text("typed".to_string()));
    }
}

/// The worse half of the same defect: the tear-down used to run AFTER the new
/// formula was evaluated, so a formula typed over an origin read the values of
/// the array it was replacing. The stored number then disagreed with every
/// later recalculation of the same workbook — an ORDER-DEPENDENT value, which
/// is the failure this program's recalculation work exists to eliminate.
#[test]
fn a_formula_typed_over_an_origin_does_not_read_the_array_it_replaces() {
    let wb = workbook_with_a_spill();
    // A2 currently holds the spilled 2. Replacing A1 destroys the array, so
    // this must evaluate against an EMPTY A2.
    wb.set(0, 0, "=A2*10");

    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Number(0.0),
        "the replacement formula read the spilled value it was destroying. The \
         cell stored 20 while a reload of the same workbook produces 0"
    );

    // The oracle, stated directly: a full recalculation must agree.
    wb.recalculate_every_sheet();
    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Number(0.0),
        "the edit path and the load path disagree about the same workbook"
    );
}

/// A SHORTER array must release the cells it no longer covers.
#[test]
fn shrinking_the_array_releases_the_cells_it_no_longer_covers() {
    let wb = workbook_with_a_spill();
    wb.set(0, 0, "=SEQUENCE(2)");

    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0)])],
        "the map still claims the rows the shorter array gave up"
    );
    assert_eq!(wb.value(0, 2, 0), CellValue::Empty);
    assert_eq!(wb.value(0, 3, 0), CellValue::Empty);
}

/// A SORT that moves the origin out of a cell reaches the same cascade the
/// Delete key does, so the stale range is released by the same rule — no
/// per-command tear-down anywhere in `sort_range`.
#[test]
fn a_cascade_seed_that_lost_its_formula_releases_its_spill() {
    let wb = workbook_with_a_spill();

    // What a permutation leaves behind: the origin's cell no longer holds the
    // formula. Written directly, because this is testing the CHOKE POINT, not
    // any particular command's route to it.
    {
        let effect = crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::LoadingFromDisk,
        );
        let mut grid = wb.state.grid.write(&effect).unwrap();
        let mut grids = wb.state.grids.write(&effect).unwrap();
        grid.cells.remove(&(0, 0));
        grids[0].cells.remove(&(0, 0));
    }

    let mut updated = Vec::new();
    recalc_after_active_sheet_bulk_rewrite(
        &wb.state,
        &wb.files,
        &wb.pane,
        &wb.filters,
        &[(0, 0)],
        &mut updated,
    );

    assert!(
        spill_ranges_of(&wb).is_empty(),
        "a seed that no longer holds a formula kept its spill claim: {:?}",
        spill_ranges_of(&wb)
    );
    for row in 1..4u32 {
        assert_eq!(wb.value(0, row, 0), CellValue::Empty);
    }
    // The erased cells are reported, or the canvas keeps painting them.
    let reported: Vec<(u32, u32)> = updated.iter().map(|c| (c.row, c.col)).collect();
    for row in 1..4u32 {
        assert!(
            reported.contains(&(row, 0)),
            "({},0) was erased but not reported to the frontend — the grid would \
             keep painting a value that is no longer in the model",
            row
        );
    }
}

/// The tear-down must NOT wait for a recalculation the user turned off. Manual
/// mode is a decision about VALUES; a map claiming cells for a deleted formula
/// is corruption, and F9 would not repair it (`run_calculation_pass` is not
/// spill-aware).
#[test]
fn the_tear_down_runs_in_manual_calculation_mode_too() {
    let wb = workbook_with_a_spill();
    *wb.state.calculation_mode.lock().unwrap() = "manual".to_string();

    {
        let effect = crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::LoadingFromDisk,
        );
        let mut grid = wb.state.grid.write(&effect).unwrap();
        let mut grids = wb.state.grids.write(&effect).unwrap();
        grid.cells.remove(&(0, 0));
        grids[0].cells.remove(&(0, 0));
    }

    let mut updated = Vec::new();
    recalc_after_active_sheet_bulk_rewrite(
        &wb.state,
        &wb.files,
        &wb.pane,
        &wb.filters,
        &[(0, 0)],
        &mut updated,
    );

    assert!(
        spill_ranges_of(&wb).is_empty(),
        "manual calculation mode skipped the spill tear-down, so the cells stay \
         uneditable and undeletable until the document is reloaded"
    );
}

/// A seed that still holds a formula must NOT be released here — it is
/// `reevaluate_formula_cell`'s job, and doing both would erase a live array.
#[test]
fn a_seed_that_still_holds_its_formula_keeps_its_spill() {
    let wb = workbook_with_a_spill();
    wb.set(5, 0, "1"); // an unrelated write to seed with

    let mut updated = Vec::new();
    recalc_after_active_sheet_bulk_rewrite(
        &wb.state,
        &wb.files,
        &wb.pane,
        &wb.filters,
        &[(0, 0), (5, 0)],
        &mut updated,
    );

    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])],
        "the cascade released a LIVE array's cells"
    );
    assert_eq!(wb.value(0, 3, 0), CellValue::Number(4.0));
}

// ---------------------------------------------------------------------------
// 5b. The ORIGIN guard, which `check_spill_protection` cannot see
// ---------------------------------------------------------------------------

/// The arrangement `check_spill_protection` alone lets through: an origin
/// INSIDE the rectangle whose spilled cells are all OUTSIDE it. A horizontal
/// array in row 1 (A1 spilling A1:D1) is inside any sort of column A.
#[test]
fn a_rectangle_holding_an_origin_but_none_of_its_cells_is_still_refused_for_a_permutation() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "=SEQUENCE(1;4)");
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(0, 1), (0, 2), (0, 3)])],
        "the precondition failed: A1 did not spill ACROSS"
    );

    // Column A rows 1..5: contains the ORIGIN A1 and none of B1:D1.
    {
        let spill_hosts = wb.state.spill_hosts.lock().unwrap();
        assert!(
            check_spill_protection(&spill_hosts, 0, 0, 0, 4, 0, SpillOriginPolicy::Refuse).is_ok(),
            "the host check is supposed to be blind to this arrangement — if it \
             is not, `check_no_spill_origin_within` is testing nothing"
        );
    }
    let err = check_no_array_within(&wb.state, 0, 0, 0, 4, 0)
        .expect_err("a sort of column A was allowed to move the origin of an \
                     array whose values live in row 1 — the formula would land \
                     on another row while B1:D1 stayed put");
    assert!(err.contains("A1"), "the refusal must name the origin: {}", err);

    // Away from the origin it costs nothing and refuses nothing.
    assert!(check_no_array_within(&wb.state, 0, 10, 0, 20, 5).is_ok());
    assert!(
        check_no_array_within(&wb.state, 1, 0, 0, 4, 0).is_ok(),
        "sheet 0's origin refused a rectangle on another sheet"
    );
}

/// Wired from source: every command that CANNOT carry an array refuses one.
/// These are the commands whose exemption from the census reads "it refuses
/// instead of maintaining"; if the refusal goes, the exemption is a lie and the
/// map has a silent second writer again.
#[test]
fn every_command_that_cannot_carry_an_array_refuses_one() {
    const DATA_RS: &str = include_str!("data.rs");
    const MERGE_RS: &str = include_str!("../merge_commands.rs");
    const SEARCH_RS: &str = include_str!("search.rs");

    for (source, command) in [
        (DATA_RS, "sort_range"),
        (DATA_RS, "sort_range_off_sheet"),
        (DATA_RS, "fill_range"),
        (MERGE_RS, "merge_cells"),
        (MERGE_RS, "merge_cells_off_sheet"),
    ] {
        let body = body_of(source, command);
        assert!(
            body.contains("check_no_array_within("),
            "`{}` permutes, overwrites or deletes a whole rectangle without \
             asking whether it holds part of a dynamic array. Both halves of \
             that question matter: the spilled-CELL check alone is blind to a \
             horizontal array whose origin is inside the rectangle and whose \
             values are outside it",
            command
        );
    }

    // The replace family acts on a MATCH LIST, not a rectangle, for the same
    // reason its writeback and protection gates do.
    for command in [
        "replace_all",
        "replace_all_off_sheet",
        "replace_single",
        "replace_single_off_sheet",
    ] {
        let body = body_of(SEARCH_RS, command);
        assert!(
            body.contains("check_spill_protection_cells("),
            "`{}` rewrites matched cells without asking whether any of them is \
             a spilled value. It skips formula cells, so it never touches an \
             ORIGIN — but a spilled VALUE is an ordinary non-formula cell, and \
             rewriting one is allowed nowhere else in the product AND does not \
             survive the next recalculation of its origin",
            command
        );
    }
}

/// ...and the refusal actually fires, on a real workbook, for both
/// arrangements.
#[test]
fn a_rectangle_holding_any_part_of_an_array_is_refused() {
    let wb = workbook_with_a_spill(); // A1 spills DOWN A1:A4

    // Spilled cells only.
    assert!(check_no_array_within(&wb.state, 0, 1, 0, 3, 0).is_err());
    // Origin only, plus cells.
    assert!(check_no_array_within(&wb.state, 0, 0, 0, 3, 0).is_err());
    // Clear of the array entirely.
    assert!(check_no_array_within(&wb.state, 0, 0, 1, 9, 9).is_ok());
    assert!(check_no_array_within(&wb.state, 0, 10, 0, 20, 0).is_ok());
    // Another sheet is another workbook as far as this is concerned.
    assert!(check_no_array_within(&wb.state, 1, 0, 0, 3, 0).is_ok());
}

/// The match-list guard, on a real workbook.
#[test]
fn a_match_list_containing_a_spilled_value_is_refused() {
    let wb = workbook_with_a_spill();

    assert!(
        check_spill_protection_cells(&wb.state, 0, &[(5, 5), (6, 6)]).is_ok(),
        "cells nowhere near the array were refused"
    );
    let err = check_spill_protection_cells(&wb.state, 0, &[(5, 5), (2, 0)])
        .expect_err("a match list containing the spilled A3 was allowed");
    assert!(err.contains("A1"), "the refusal must name the origin: {}", err);

    // The ORIGIN itself is not a spilled value and is not refused here — the
    // replace paths skip it for having a formula, and every other single-cell
    // writer is allowed to replace it.
    assert!(check_spill_protection_cells(&wb.state, 0, &[(0, 0)]).is_ok());
}

// ---------------------------------------------------------------------------
// 5c. §2ab — the map DOES survive a reload, and this is the mechanism
// ---------------------------------------------------------------------------

/// §2ab, INVERTED — this test used to assert the defect and now asserts the
/// fix, which is why the name changed rather than the file.
///
/// WHAT IT USED TO SAY. The spill map was session state
/// (`reset_document_scoped_stores` clears it and nothing refilled it) while the
/// spilled CELLS were saved as ordinary literals. A reload therefore produced a
/// workbook whose arrays were painted but unowned, and the first recalculation
/// of an origin found its own cells occupied by values it did not own and
/// collapsed to `#VALUE!`.
///
/// WHAT CLOSED IT. `.cala` now stores the array's EXTENT on its origin
/// (`SavedCell::spill`, format version 7 — the same thing xlsx stores as `ref`
/// on `<f t="array">`), and `open_file` restores the map from it. This test
/// keeps reproducing the reload STATE rather than doing file I/O, so it pins
/// the STRUCTURAL claim — "the map is what stands between a reopened array and
/// `#VALUE!`" — while `spill_persistence_tests` proves the round trip over real
/// `.cala` bytes.
///
/// The first half is therefore still the OLD behaviour, deliberately: it is
/// what a build without the restore does, and it must keep failing that way so
/// nobody concludes the collapse was imaginary. The second half is the fix.
#[test]
fn the_restored_spill_map_is_what_keeps_a_reloaded_origin_alive_2ab() {
    // ---- Without the map: exactly what §2ab measured -----------------------
    let broken = workbook_with_a_spill();
    // What `reset_document_scoped_stores` does on load — the cells stay,
    // because the grid comes back from the file.
    broken.state.spill_ranges.write(&crate::document_effect::test_seed_effect()).unwrap().clear();
    broken.state.spill_hosts.lock().unwrap().clear();
    assert_eq!(broken.value(0, 2, 0), CellValue::Number(3.0));

    let mut updated = Vec::new();
    recalc_after_active_sheet_bulk_rewrite(
        &broken.state,
        &broken.files,
        &broken.pane,
        &broken.filters,
        &[(0, 0)],
        &mut updated,
    );
    assert_eq!(
        broken.value(0, 0, 0),
        CellValue::Error(CellError::Spill),
        "an unowned array must still collapse — this is the defect the restore \
         exists to prevent, and if it stops happening the restore has stopped \
         being load-bearing"
    );
    assert_eq!(
        broken.value(0, 2, 0),
        CellValue::Number(3.0),
        "...leaving the orphaned literals beside a #SPILL! origin"
    );

    // ---- With the map restored: the array survives -------------------------
    let fixed = workbook_with_a_spill();
    fixed.state.spill_ranges.write(&crate::document_effect::test_seed_effect()).unwrap().clear();
    fixed.state.spill_hosts.lock().unwrap().clear();

    // The one line `open_file` gained. `A1:A4` is what the file's `sp` field
    // says, so this is the same claim the restore installs.
    let saved_sheet = {
        let mut sheet = persistence::Sheet::new("Sheet1".to_string());
        sheet.cells.insert(
            (0, 0),
            persistence::SavedCell {
                value: persistence::SavedCellValue::Number(1.0),
                formula: Some("SEQUENCE(4)".to_string()),
                style_index: 0,
                rich_text: None,
                spill: Some((3, 0)),
            },
        );
        sheet
    };
    crate::spill_restore::restore_spill_extents_for_sheet(&fixed.state, 0, &saved_sheet);
    assert_eq!(
        spill_ranges_of(&fixed),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])],
        "the restore must put the ownership back"
    );

    let mut updated = Vec::new();
    recalc_after_active_sheet_bulk_rewrite(
        &fixed.state,
        &fixed.files,
        &fixed.pane,
        &fixed.filters,
        &[(0, 0)],
        &mut updated,
    );
    assert_eq!(
        fixed.value(0, 0, 0),
        CellValue::Number(1.0),
        "with the map restored the origin re-spills onto cells it owns instead \
         of reading them as foreign data"
    );
    assert_eq!(fixed.value(0, 3, 0), CellValue::Number(4.0));
    assert_eq!(
        spill_ranges_of(&fixed),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])]
    );
}

// ---------------------------------------------------------------------------
// 6. The census: every cell writer either maintains the map or says why not
// ---------------------------------------------------------------------------

/// EVERY function in the crate that writes cells, classified against the spill
/// map — the sibling of `every_cell_writing_function_either_recalculates_or_is_
/// exempt_with_a_reason`, and for the same reason: §2y was found in a command
/// nobody had thought to check, so this does not take a list of names.
///
/// A function that writes cells must give ONE of three answers:
///
///   * MAINTAIN — reach the shared tear-down (`take_spills_owned_*`,
///     `release_spills_orphaned_by_grid`) or the shared cascade
///     (`recalc_after_active_sheet_bulk_rewrite`), whose tear-down phase does it;
///   * REFUSE — reach a spill guard (`check_no_array_within`,
///     `check_spill_protection_cells`) and decline the gesture instead, which is
///     what a command that cannot carry an array should do;
///   * EXEMPT, with a written reason.
#[test]
fn every_cell_writing_function_either_maintains_the_spill_map_or_is_exempt_with_a_reason() {
    // (file relative to src/, function, reason it needs no spill maintenance)
    const EXEMPT: &[(&str, &str, &str)] = &[
        // -- It IS the spill machinery, or an inner step of it ---------------
        ("commands/data.rs", "erase_released_spill_cells", "IS the tear-down's grid half: it erases exactly the cells take_spills_* released"),
        // §3bm REMOVED SIX ENTRIES FROM THIS LIST, and that is the point of the
        // change. `update_cell_impl`, `update_cells_batch_core`,
        // `reevaluate_formula_cell`, `recalc_walked_cell`,
        // `run_calculation_pass` and `recalculate_sheet_values` were each
        // exempt with a reason; three of them carried their own hand-copied
        // spill decision and three said, in prose, that they removed no origin
        // — which was true and beside the point, because they REPLACED an
        // array's value without re-laying its rectangle. They now all reach
        // `apply_spill_decision` (or `release_origin_spill`) and are classified
        // by the detector rather than by a sentence. An exemption that has to
        // be argued is the shape this register keeps finding defects behind.
        // -- Style only: an origin's FORMULA is untouched, so its spill lives -
        ("commands/styles.rs", "apply_formatting", "style_index only — no formula is removed, so no range is orphaned"),
        ("commands/styles.rs", "apply_formatting_to_sheets", "style_index only"),
        ("commands/styles.rs", "set_cell_style", "style_index only"),
        ("commands/styles.rs", "set_cell_rich_text", "rich-text runs only"),
        ("commands/styles.rs", "apply_border_preset", "style_index only"),
        ("protection.rs", "set_cell_protection", "lock/hidden flags only"),
        ("named_styles_cmd.rs", "apply_named_style_impl", "style_index only"),
        ("computed_properties.rs", "apply_fill_color", "style_index only"),
        ("computed_properties.rs", "apply_style_change", "style_index only"),
        ("mcp/tools.rs", "apply_cell_formatting", "style_index only"),
        // -- Rewrites formula REFERENCES, not the formulas' existence --------
        ("tables.rs", "rename_table_refs_in_formulas", "re-points structured refs at the same cells; every origin keeps its formula"),
        ("tables.rs", "rename_table_column_in_formulas", "re-points a COLUMN specifier at the same cells; every origin keeps its formula"),
        ("tables.rs", "rewrite_table_refs_to_ranges", "flattens structured refs to the same cells; every origin keeps its formula"),
        ("commands/structure.rs", "shift_cross_sheet_formulas", "re-points references inside surviving formulas"),
        ("commands/structure.rs", "shift_cross_sheet_formulas_for_off_sheet_edit", "re-points references inside surviving formulas"),
        ("commands/structure.rs", "relocate_cell_references", "re-points references; seeds the shared cascade for the values"),
        // -- The structural edits move the map in lockstep --------------------
        ("commands/structure.rs", "insert_rows_impl", "shift_flat_cell_stores moves BOTH spill maps with the edit (keys and values), and drops a sheet's claims when an origin is deleted"),
        ("commands/structure.rs", "insert_columns_impl", "shift_flat_cell_stores, as insert_rows_impl"),
        ("commands/structure.rs", "delete_rows_impl", "shift_flat_cell_stores, as insert_rows_impl"),
        ("commands/structure.rs", "delete_columns_impl", "shift_flat_cell_stores, as insert_rows_impl"),
        ("commands/structure.rs", "off_sheet_structural_edit", "shift_flat_cell_stores, re-anchored to the target sheet"),
        ("commands/coord_shift.rs", "shift_per_sheet_cell_map", "generic coordinate-map shift; the spill pair is moved by shift_flat_cell_stores, which uses shift_flat_cell_map"),
        ("commands/structure.rs", "shift_per_sheet_cell_stores", "helper of the four structural edits; the spill pair is not a per-sheet store"),
        // -- Transient / self-evaluating: writes it also un-writes ------------
        ("data_tables.rs", "data_table_one_var", "what-if table: substitutes into a borrowed probe cell and restores it"),
        ("data_tables.rs", "data_table_two_var", "what-if table: as above"),
        ("data_tables.rs", "re_evaluate_formulas", "the what-if table's own evaluation step"),
        ("data_tables.rs", "restore_cell", "restores the probe cell the loop borrowed"),
        ("data_tables.rs", "set_cell_value", "sets the probe cell the loop borrowed"),
        ("goal_seek.rs", "goal_seek", "iterates to a root over a borrowed input cell"),
        ("goal_seek.rs", "evaluate_target", "one goal-seek trial"),
        ("goal_seek.rs", "finalize_result", "writes the converged value into the same input cell"),
        ("solver.rs", "solver_solve", "runs its own objective loop over borrowed variable cells"),
        ("solver.rs", "solver_revert", "restores the pre-solve values the loop captured"),
        ("solver.rs", "set_variables_and_evaluate", "one solver trial"),
        ("scenario_manager.rs", "scenario_show", "transient scenario preview (see the transient-write pattern)"),
        ("scenario_manager.rs", "scenario_summary", "builds a report block from values it evaluated"),
        ("animation_commands.rs", "apply_set_ops_and_recalc", "transient frame playback"),
        // -- Whole-sheet / whole-workbook evaluation --------------------------
        ("calculation.rs", "mark_off_sheet_circular_cells", "an inner step of the sheet-scoped pass"),
        ("pivot/operations.rs", "recalculate_sheet_formulas", "whole-sheet evaluation; removes no origin"),
        ("persistence.rs", "open_file", "document replacement: reset_document_scoped_stores clears both spill maps for the outgoing document, and `spill_restore::restore_spill_map_on_load` refills them for the incoming one from the extents the file carries (§2ab). Neither half writes a document cell"),
        // -- Helper: the CALLER maintains --------------------------------------
        ("consolidate.rs", "consolidate_data_inner", "`consolidate_data` seeds the shared cascade over its updated_cells"),
        ("calp_commands.rs", "write_override_value", "the raw write; its one caller apply_override_value_to_grid releases orphaned claims on the written sheet"),
        ("calp_commands.rs", "calp_revert_override", "writes only through apply_override_value_to_grid, which releases orphaned claims on the sheet it wrote"),
        ("calp_commands.rs", "calp_accept_upstream", "as calp_revert_override"),
        ("calp_commands.rs", "calp_refresh_apply", "as calp_revert_override"),
        ("scripting/commands.rs", "parse_script_formula_writes", "builds a detached grid; apply_script_modified_grids_core recalculates"),
        ("tables.rs", "write_table_formula_cell", "helper: one totals cell; its two callers seed the shared cascade"),
        ("undo_commands.rs", "apply_changes", "every SetCell restore is a cascade seed, and the cascade's tear-down phase releases whatever the restored cell stopped owning"),
        ("undo_commands.rs", "apply_calp_reset_restore", "reports its sheet; apply_changes cascades"),
        ("undo_commands.rs", "apply_object_swap_restore", "reports its sheet; apply_changes cascades"),
        ("undo_commands.rs", "apply_pivot_create_restore", "reports its sheet; apply_changes cascades"),
        ("undo_commands.rs", "apply_pivot_definition_restore", "reports its sheet; apply_changes cascades"),
        ("undo_commands.rs", "apply_report_restore", "reports its sheet; apply_changes cascades"),
        ("undo_commands.rs", "apply_script_grid_cells_restore", "reports its sheet; apply_changes cascades"),
        ("undo_commands.rs", "apply_sheet_structural_restore", "reports its sheet; apply_changes cascades"),
        // -- Writes a region no dynamic array can be inside --------------------
        ("pivot/commands.rs", "create_pivot_inner", "a pivot's output region is protected against every content write, so no spill ORIGIN can be inside it"),
        ("pivot/commands.rs", "delete_pivot_table", "clears the same protected region"),
        ("pivot/commands.rs", "undo_pivot_overwrite", "restores cells the pivot displaced, inside the same protected region"),
        ("pivot/commands.rs", "drill_through_to_sheet", "writes a freshly created sheet, which can hold no pre-existing spill"),
        ("bi/commands.rs", "bi_insert_result", "writes a query result block and seeds the shared cascade"),
        ("bi/commands.rs", "bi_refresh_connection", "rewrites the same result block and seeds the shared cascade"),
        ("bi/cube.rs", "build_cube_prefetch", "builds a detached prefetch grid, never the document's"),
        ("tables.rs", "check_table_auto_expand", "extends a table's own rows; seeds the shared cascade"),
        ("tables.rs", "set_calculated_column", "writes a table column; seeds the shared cascade"),
        // -- Reads, or writes something that is not the document ---------------
        ("commands/data.rs", "get_viewport_cells", "read path: builds the payload the canvas paints"),
        ("scripting/udf.rs", "collect_udf_calls", "collects call sites; writes no document cell"),
        ("state_digest.rs", "digest_cells", "hashes cells"),
        // `get_workbook_state_digest` WAS exempt here. Its body moved into
        // `build_workbook_state_digest` so the lock-order guards could call it
        // without a Tauri `State`, and the exemption did not move with it — so
        // this census has been RED in the tree, naming a read-only function,
        // and the stale-entry half of the same census then named the wrapper.
        // It is read-only: the `cells.insert(` the detector matches is an
        // insert into the digest's OWN output map, and the function takes both
        // grid locks with `.read()`.
        ("state_digest.rs", "build_workbook_state_digest", "read-only: `cells` is the digest's own output BTreeMap, not a grid cell store; both grid locks are taken with .read()"),
        ("tracing.rs", "trace_precedents", "builds a trace overlay"),
        ("lib.rs", "extract_references_recursive", "walks an AST"),
    ];

    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_rs_files_for_spill_census(&src_root, &mut files);
    assert!(
        files.len() > 50,
        "only {} source files found under {} — the walk is broken, not the crate",
        files.len(),
        src_root.display()
    );

    let mut unclassified: Vec<String> = Vec::new();
    let mut seen: Vec<(String, String)> = Vec::new();
    for path in &files {
        let rel = path
            .strip_prefix(&src_root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if rel.ends_with("_tests.rs") || rel == "tests.rs" || rel.starts_with("tests/") {
            continue;
        }
        let text = std::fs::read_to_string(path).unwrap_or_default();
        for (func, maintains) in spill_relevant_functions(&text) {
            seen.push((rel.clone(), func.clone()));
            if maintains {
                continue;
            }
            if EXEMPT.iter().any(|(f, n, _)| *f == rel && *n == func) {
                continue;
            }
            unclassified.push(format!("{}::{}", rel, func));
        }
    }

    assert!(
        unclassified.is_empty(),
        "these functions write cells and neither maintain the spill map, nor \
         refuse a gesture that would orphan it, nor carry a recorded reason to \
         do neither:\n  {}\n\nThis is the §2y class: the map is derived state \
         with ONE maintainer, and a second writer that removes or overwrites a \
         spill ORIGIN leaves it claiming cells no formula produces — cells that \
         then refuse every edit AND every delete, naming a source cell that is \
         already empty, and save as orphan literals. Pick one: MAINTAIN (reach \
         `take_spills_owned_within` / `take_spills_owned_by_any` / \
         `release_spills_orphaned_by_grid`, or the shared cascade \
         `recalc_after_active_sheet_bulk_rewrite`, whose tear-down phase does it \
         for every seed that lost its formula), REFUSE (`check_no_array_within` \
         / `check_spill_protection_cells`), or add the function to EXEMPT with \
         the reason it needs neither.",
        unclassified.join("\n  ")
    );

    let stale: Vec<String> = EXEMPT
        .iter()
        .filter(|(f, n, _)| !seen.iter().any(|(sf, sn)| sf == f && sn == n))
        .map(|(f, n, _)| format!("{}::{}", f, n))
        .collect();
    assert!(
        stale.is_empty(),
        "EXEMPT names functions that no longer write cells:\n  {}",
        stale.join("\n  ")
    );

    // Non-vacuity: the census must be finding the members this pass fixed.
    for (file, func) in [
        ("commands/data.rs", "clear_range"),
        ("commands/data.rs", "clear_range_with_options"),
        ("commands/data.rs", "clear_range_with_options_off_sheet"),
        ("commands/data.rs", "clear_range_on_sheets"),
        ("commands/data.rs", "clear_cell"),
        ("commands/data.rs", "sort_range"),
        ("commands/data.rs", "fill_range"),
        ("commands/data.rs", "remove_duplicates"),
        // The command's writing body (testability split — the `update_cell_on_sheets`
        // wrapper itself writes nothing).
        ("commands/data.rs", "update_cell_on_sheets_inner"),
        ("undo_commands.rs", "apply_changes"),
    ] {
        assert!(
            seen.iter().any(|(f, n)| f == file && n == func),
            "the census did not even find `{}::{}` — it is not measuring what \
             it claims to",
            file,
            func
        );
    }
}

/// Every exemption is a DECISION, so every entry must carry a reason somebody
/// wrote. Same rule, and same failure mode, as the recalculation census.
#[test]
fn every_spill_exemption_carries_a_written_reason() {
    const SELF: &str = include_str!("spill_map_tests.rs");
    let start = SELF
        .find("const EXEMPT:")
        .expect("the census must still declare an EXEMPT list");
    let end = SELF[start..]
        .find("\n    ];")
        .map(|o| start + o)
        .expect("the EXEMPT list must still terminate");
    for line in SELF[start..end].lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("(\"") {
            continue;
        }
        assert!(
            !trimmed.contains(", \"\")"),
            "an EXEMPT entry carries an empty reason:\n  {}",
            trimmed
        );
    }
}

/// THE CENSUS HAS TEETH, asserted rather than trusted — the same sabotage
/// discipline the recalculation census carries, including the two holes that
/// one was found to have (a delegating helper, and a COMMENTED-OUT call).
#[test]
fn the_spill_census_detector_actually_fires() {
    const WITHOUT: &str = "\
pub fn writes_and_forgets(grid: &mut Grid) {
    grid.clear_cell(0, 0);
}
";
    assert_eq!(
        spill_relevant_functions(WITHOUT),
        vec![("writes_and_forgets".to_string(), false)],
        "a function that clears cells and reaches no tear-down was not flagged"
    );

    const VIA_TEAR_DOWN: &str = "\
pub fn writes_and_releases(state: &AppState, grid: &mut Grid) {
    grid.clear_cell(0, 0);
    take_spills_owned_within(state, sheet, r, c, r, c);
}
";
    assert_eq!(
        spill_relevant_functions(VIA_TEAR_DOWN),
        vec![("writes_and_releases".to_string(), true)]
    );

    const VIA_CASCADE: &str = "\
pub fn writes_and_cascades(state: &AppState, grid: &mut Grid) {
    grid.clear_cell(0, 0);
    recalc_after_active_sheet_bulk_rewrite(state, files, pane, filters, seeds, out);
}
";
    assert_eq!(
        spill_relevant_functions(VIA_CASCADE),
        vec![("writes_and_cascades".to_string(), true)],
        "the shared cascade is the choke point; a writer that reaches it is \
         maintained by its tear-down phase"
    );

    const COMMENTED_OUT: &str = "\
pub fn writes_and_forgets(grid: &mut Grid) {
    grid.clear_cell(0, 0);
    // take_spills_owned_within(state, sheet, r, c, r, c);
}
";
    assert_eq!(
        spill_relevant_functions(COMMENTED_OUT),
        vec![("writes_and_forgets".to_string(), false)],
        "a COMMENTED-OUT tear-down satisfied the census. Comments are not code, \
         and every real call site here is wrapped in a comment explaining it, \
         so a careless delete leaves exactly this behind"
    );

    const NO_WRITE: &str = "\
pub fn touches_nothing(grid: &Grid) {
    let _ = grid.get_cell(0, 0);
}
";
    assert!(spill_relevant_functions(NO_WRITE).is_empty());

    // A caller that reaches the grid ONLY through a delegating helper is still
    // a cell writer — the hole sabotage found in the recalculation census, and
    // the reason those helpers' exemptions ("my caller maintains") are worth
    // anything.
    const VIA_HELPER: &str = "\
pub fn writes_through_a_helper(state: &AppState) {
    write_table_formula_cell(state, &mut grid, row, col, formula);
}
";
    assert_eq!(
        spill_relevant_functions(VIA_HELPER),
        vec![("writes_through_a_helper".to_string(), false)],
        "a function that writes cells ONLY through a delegating helper was not \
         enumerated, so neither half of the helper's exemption is checked"
    );

    // The helper's OWN definition is still judged by its body, or every helper
    // would classify itself as its own caller.
    const HELPER_ITSELF: &str = "\
pub fn write_table_formula_cell(grid: &mut Grid) {
    grid.set_cell(0, 0, cell);
}
";
    assert_eq!(
        spill_relevant_functions(HELPER_ITSELF),
        vec![("write_table_formula_cell".to_string(), false)]
    );
}

/// The GUARD half, wired from source: a call site that takes the
/// `ReleasedByCaller` exemption must actually release the spill. Taking the
/// exemption without the removal it promises is strictly worse than §2y — it
/// turns a refusal into a silent leak.
#[test]
fn every_release_policy_call_site_actually_releases_the_spill() {
    const DATA_RS: &str = include_str!("data.rs");

    // Which functions take the exemption, read from the source rather than
    // listed, so a new one cannot be added without answering for itself.
    let mut current = String::new();
    let mut takers: Vec<String> = Vec::new();
    for line in DATA_RS.lines() {
        if let Some(rest) = line.strip_prefix("pub fn ").or_else(|| {
            line.strip_prefix("pub(crate) fn ")
                .or_else(|| line.strip_prefix("fn "))
        }) {
            current = rest.split(['(', '<']).next().unwrap_or("").to_string();
        }
        // `check_spill_protection` is the guard's own definition — it names the
        // variant to implement it, and it is not a call site.
        if line.contains("SpillOriginPolicy::ReleasedByCaller")
            && !line.trim_start().starts_with("//")
            && !current.is_empty()
            && current != "check_spill_protection"
            && !takers.contains(&current)
        {
            takers.push(current.clone());
        }
    }
    assert!(
        !takers.is_empty(),
        "no call site takes the origin exemption at all — either the guard \
         regressed to always refusing, or this detector stopped working"
    );

    for name in &takers {
        let body = body_of(DATA_RS, name);
        assert!(
            body.contains("take_spills_owned_within(")
                || body.contains("take_spills_owned_by_any(")
                || body.contains("recalc_after_active_sheet_bulk_rewrite(")
                || body.contains("spilled_cells_owned_within("),
            "`{}` lets a rectangle swallow a spill ORIGIN \
             (SpillOriginPolicy::ReleasedByCaller) but reaches no tear-down. \
             The exemption promises the spilled cells leave with the origin; \
             without the release they stay in the grid AND lose their guard, \
             which is worse than the refusal it replaced",
            name
        );
    }

    // The clears are the reason the exemption exists; if one drops out of the
    // list, the detector is reading the wrong thing.
    for expected in [
        "clear_range",
        "clear_range_with_options",
        "clear_range_with_options_off_sheet",
        "clear_range_on_sheets",
    ] {
        assert!(
            takers.iter().any(|t| t == expected),
            "`{}` no longer takes the origin exemption — 'select the spill and \
             press Delete' is refused again (§2y's second impossible remedy)",
            expected
        );
    }
}

/// The harness above claims to reproduce `clear_range`. This pins the claim.
#[test]
fn clear_range_still_runs_the_four_phases_this_harness_reproduces() {
    const DATA_RS: &str = include_str!("data.rs");
    let body = body_of(DATA_RS, "clear_range");

    for (needle, why) in [
        (
            "SpillOriginPolicy::ReleasedByCaller",
            "the guard no longer exempts an origin inside the rectangle, so \
             selecting a spilled block and pressing Delete is refused again",
        ),
        (
            "spilled_cells_owned_within(",
            "the swallowed spill cells are no longer excluded from the clear \
             loop, so they get undo entries again and the undo will land on \
             #VALUE! instead of the array",
        ),
        (
            "record_cell_change",
            "the clear stopped recording anything for undo",
        ),
        (
            "recalc_after_active_sheet_bulk_rewrite(",
            "the clear no longer reaches the shared cascade, which is where the \
             spill tear-down lives",
        ),
    ] {
        assert!(body.contains(needle), "`clear_range`: {}", why);
    }

    // Order matters: the guard must precede the undo transaction, so a refusal
    // is a clean no-op.
    let guard = body.find("check_spill_protection").expect("guard present");
    let txn = body.find("begin_transaction").expect("transaction present");
    assert!(
        guard < txn,
        "`clear_range` opens its undo transaction before the spill guard runs"
    );
}

/// The tear-down must exist in exactly ONE place. Four hand-written copies is
/// what it was, and the copy in `clear_range` is the one that was never
/// written.
#[test]
fn the_spill_map_has_exactly_one_tear_down() {
    const DATA_RS: &str = include_str!("data.rs");
    let removals = DATA_RS.matches("spill_ranges.remove(").count();
    assert_eq!(
        removals, 1,
        "`spill_ranges.remove(` appears {} times in data.rs. There is one \
         tear-down (`take_spills_where`); a second copy is how the map got a \
         second maintainer that disagreed with the first",
        removals
    );

    // ...and `spill_hosts` is only ever removed from alongside it.
    let host_removals = DATA_RS.matches("spill_hosts.remove(").count();
    assert_eq!(
        host_removals, 1,
        "`spill_hosts.remove(` appears {} times: the two sides of the map must \
         move in lockstep, which is only checkable if they move in one place",
        host_removals
    );
}

// ---------------------------------------------------------------------------
// Census plumbing
// ---------------------------------------------------------------------------

fn collect_rs_files_for_spill_census(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files_for_spill_census(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// `(function name, does its body reach the spill map's maintenance)` for every
/// function in `text` that writes a cell, with `#[cfg(test)]` modules removed
/// first — a test fixture seeding a grid is not a product write.
///
/// "Writes a cell" and "maintains the map" are both read from CODE, never from
/// comments: the recalculation census was found to accept a commented-out call,
/// and every real call site here is wrapped in a comment naming the function it
/// calls, so a careless delete leaves the name behind in prose.
fn spill_relevant_functions(text: &str) -> Vec<(String, bool)> {
    // A call to a DELEGATING HELPER counts as writing a cell, which is what it
    // is — the helper exists only to be the write. This is the hole the
    // recalculation census was sabotaged into revealing: without it, a helper's
    // exemption ("my caller maintains") is a claim about another function that
    // nothing verifies, and the two halves can be removed one at a time with no
    // test failing. Same list as `bulk_rewrite_recalc_tests::DELEGATING_HELPERS`
    // plus this pass's own tear-down half.
    const WRITES: &[&str] = &[
        ".set_cell(",
        ".clear_cell(",
        "cells.remove(",
        "cells.insert(",
        "erase_released_spill_cells(",
        // §3bm. THE ONE SPILL DECISION and its tear-down half. Both write
        // cells, and both are also listed under MAINTAINS below, because the
        // maintenance is exactly what they are — so a function that reaches
        // either has discharged the rule, and one that reaches neither while
        // writing cells still has to answer for itself.
        "apply_spill_decision(",
        "release_origin_spill(",
        "consolidate_data_inner(",
        "write_override_value(",
        "shift_per_sheet_cell_map(",
        "parse_script_formula_writes(",
        "shift_cross_sheet_formulas(",
        "shift_cross_sheet_formulas_for_off_sheet_edit(",
        "write_table_formula_cell(",
        "apply_override_value_to_grid(",
        "shift_per_sheet_cell_stores(",
        // §2aj: the column rename's write, exactly like the table rename's.
        "rename_table_column_in_formulas(",
    ];
    const MAINTAINS: &[&str] = &[
        "take_spills_owned_within(",
        "take_spills_owned_by_any(",
        "take_spills_where(",
        "spilled_cells_owned_within(",
        "recalc_after_active_sheet_bulk_rewrite(",
        // §2aj. Reaches the line above and nothing else -- see the note on
        // `RECALC` in `bulk_rewrite_recalc_tests`, and the test that pins it.
        "recalc_after_table_change(",
        "shift_flat_cell_stores(",
        "release_spills_orphaned_by_grid(",
        "check_no_array_within(",
        "check_spill_protection_cells(",
        // §3bm: see the note in WRITES.
        "apply_spill_decision(",
        "release_origin_spill(",
    ];

    let stripped = strip_test_modules(text);
    let mut out: Vec<(String, bool)> = Vec::new();
    let mut current: Option<(String, bool, bool)> = None; // name, writes, maintains
    for raw in stripped.lines() {
        let code = raw.split("//").next().unwrap_or("");
        if raw.starts_with("fn ")
            || raw.starts_with("pub fn ")
            || raw.starts_with("pub(crate) fn ")
            || raw.starts_with("pub(super) fn ")
            || raw.starts_with("async fn ")
            || raw.starts_with("pub async fn ")
        {
            if let Some((name, writes, maintains)) = current.take() {
                if writes {
                    out.push((name, maintains));
                }
            }
            let name = raw
                .rsplit("fn ")
                .next()
                .unwrap_or("")
                .split(['(', '<'])
                .next()
                .unwrap_or("")
                .to_string();
            current = Some((name, false, false));
        }
        if let Some((_, writes, maintains)) = current.as_mut() {
            if WRITES.iter().any(|n| code.contains(n)) {
                *writes = true;
            }
            if MAINTAINS.iter().any(|n| code.contains(n)) {
                *maintains = true;
            }
        }
    }
    if let Some((name, writes, maintains)) = current.take() {
        if writes {
            out.push((name, maintains));
        }
    }
    out
}

/// Everything outside `#[cfg(test)]` modules. Nested braces are counted, so a
/// test module containing one does not end the strip early.
fn strip_test_modules(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        if line.trim_start().starts_with("#[cfg(test)]") {
            // Skip attributes/comments until the item itself.
            let mut depth: i32 = 0;
            let mut started = false;
            // The `mod ... {` may be on the next line(s).
            for inner in lines.by_ref() {
                depth += inner.matches('{').count() as i32;
                depth -= inner.matches('}').count() as i32;
                if inner.contains('{') {
                    started = true;
                }
                if started && depth <= 0 {
                    break;
                }
                if !started && inner.contains(';') {
                    // `#[cfg(test)] #[path = "..."] mod x;` — a file-level
                    // declaration with no body here. Deliberately NOT also
                    // breaking on a blank line: a blank line between the
                    // attribute and `mod tests {` would end the strip early and
                    // feed the census a test fixture as if it were product code.
                    break;
                }
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}
