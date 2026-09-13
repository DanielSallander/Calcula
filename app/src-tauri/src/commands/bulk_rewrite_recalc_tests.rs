//! FILENAME: app/src-tauri/src/commands/bulk_rewrite_recalc_tests.rs
//! PURPOSE: the §2c follow-ons — bulk range commands that rewrite cells must
//! seed the ONE shared cascade, and dependency cycles must be detected across
//! sheet boundaries.
//!
//! A child module of `commands::data` (declared with `#[path]` there) so it
//! reaches `recalc_after_active_sheet_bulk_rewrite` and the dependency-map
//! helpers. It reuses the `Workbook` harness from `cross_sheet_recalc_tests`
//! rather than copying one: a copied harness drifts, and a drifted harness is
//! exactly how the defects below stayed hidden.
//!
//! THE TWO DEFECTS THESE PIN.
//!
//! 1. **`clear_range` recalculated NOTHING** — not cross-sheet, not even
//!    same-sheet. This is the Delete key. Erasing the inputs of `=SUM(...)`
//!    left the total showing its pre-delete number until some unrelated later
//!    edit swept it up. Identical in class to the `sort_range` defect: a bulk
//!    range command that rewrites cells and never seeds the cascade. The class
//!    had recurred twice, so the sweep that produced these tests covered every
//!    sibling (see the wiring test at the bottom).
//!
//! 2. **A cycle crossing a sheet boundary was detected nowhere.**
//!    `partition_formula_cells` runs Kahn's algorithm over one sheet's local
//!    map, built from same-sheet references only, so `Sheet1!A1 = Sheet2!A1`
//!    with `Sheet2!A1 = Sheet1!A1` terminated and produced whichever number the
//!    evaluation order happened to leave behind instead of `#CIRCULAR!`. An
//!    ORDER-DEPENDENT number is the worst failure available here, because the
//!    soak and regression oracles compare recalc results across runs.

use super::cross_sheet_recalc_tests::{body_of, Workbook};
use super::*;
use engine::{CellError, CellValue};

// ---------------------------------------------------------------------------
// Reproducing a bulk clear
// ---------------------------------------------------------------------------

/// Reproduce exactly what `clear_range` does to the grid in its FIRST lock
/// phase: erase the cells and drop their outgoing dependency edges, touching
/// nothing else. Returns the cells that actually held content — which is
/// precisely the seed list `clear_range` now hands to phase B.
///
/// `clear_range` is a `#[tauri::command]` taking `State` and so cannot run
/// in-process; this reproduces its WRITE, and the wiring test below proves from
/// source that it still calls the recalculation afterwards. Same split the
/// `sort_range` tests use.
fn clear_active_range(
    wb: &Workbook,
    min_row: u32,
    min_col: u32,
    max_row: u32,
    max_col: u32,
) -> Vec<(u32, u32)> {
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    let mut grid = wb.state.grid.write(&effect).unwrap();
    let mut grids = wb.state.grids.write(&effect).unwrap();
    let active_sheet = *wb.state.active_sheet.read().unwrap();
    let mut dependents_map = wb.state.dependents.lock().unwrap();
    let mut dependencies_map = wb.state.dependencies.lock().unwrap();
    let mut column_dependents_map = wb.state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = wb.state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = wb.state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = wb.state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = wb.state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = wb.state.cross_sheet_dependencies.lock().unwrap();

    let targets: Vec<(u32, u32)> = grid
        .cells
        .keys()
        .filter(|(r, c)| *r >= min_row && *r <= max_row && *c >= min_col && *c <= max_col)
        .cloned()
        .collect();

    let mut cleared = Vec::new();
    for (row, col) in targets {
        if grid.get_cell(row, col).is_none() {
            continue;
        }
        cleared.push((row, col));
        grid.clear_cell(row, col);
        if active_sheet < grids.len() {
            grids[active_sheet].clear_cell(row, col);
        }
        crate::update_cross_sheet_dependencies(
            (active_sheet, row, col),
            Default::default(),
            &mut cross_sheet_dependencies_map,
            &mut cross_sheet_dependents_map,
        );
        crate::update_dependencies(
            (row, col),
            Default::default(),
            &mut dependencies_map,
            &mut dependents_map,
        );
        crate::update_column_dependencies(
            (row, col),
            Default::default(),
            &mut column_dependencies_map,
            &mut column_dependents_map,
        );
        crate::update_row_dependencies(
            (row, col),
            Default::default(),
            &mut row_dependencies_map,
            &mut row_dependents_map,
        );
    }
    cleared.sort_unstable();
    cleared
}

/// Phase B, exactly as every fixed command now runs it.
fn recalc_bulk(wb: &Workbook, seeds: &[(u32, u32)]) -> Vec<CellData> {
    let mut updated = Vec::new();
    recalc_after_active_sheet_bulk_rewrite(
        &wb.state,
        &wb.files,
        &wb.pane,
        &wb.filters,
        seeds,
        &mut updated,
    );
    updated
}

// ---------------------------------------------------------------------------
// 1. Clearing a range recalculates its dependents
// ---------------------------------------------------------------------------

#[test]
fn clearing_a_range_recalculates_its_same_sheet_dependents() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "10");
    wb.set(1, 0, "20");
    wb.set(2, 0, "30");
    wb.set(4, 0, "=SUM(A1:A3)");
    assert_eq!(wb.number(0, 4, 0), 60.0, "precondition");

    let seeds = clear_active_range(&wb, 0, 0, 1, 0);
    assert_eq!(seeds, vec![(0, 0), (1, 0)], "both literals held content");

    recalc_bulk(&wb, &seeds);

    assert_eq!(
        wb.number(0, 4, 0),
        30.0,
        "clearing A1:A2 left `=SUM(A1:A3)` at its pre-delete total — the Delete \
         key seeded no cascade at all, the same defect `sort_range` had"
    );
}

#[test]
fn clearing_a_range_recalculates_cross_sheet_dependents() {
    let wb = Workbook::new(2);
    wb.set(0, 0, "10");
    wb.set(1, 0, "20");
    wb.set(4, 0, "=SUM(A1:A3)");

    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A5");
    wb.set(1, 0, "=A1*2");
    assert_eq!(wb.number(1, 0, 0), 30.0, "precondition");
    assert_eq!(wb.number(1, 1, 0), 60.0, "precondition");
    wb.switch_to(0);

    let seeds = clear_active_range(&wb, 0, 0, 1, 0);
    recalc_bulk(&wb, &seeds);

    assert_eq!(wb.number(0, 4, 0), 0.0, "same-sheet total");
    assert_eq!(
        wb.number(1, 0, 0),
        0.0,
        "the first cross-sheet hop kept the pre-delete total"
    );
    assert_eq!(
        wb.number(1, 1, 0),
        0.0,
        "the SECOND hop — a dependent of the cross-sheet dependent — is what \
         the shared `cascade_cross_sheet_dependents` walk exists to reach"
    );
}

#[test]
fn clearing_cells_that_hold_no_content_seeds_nothing() {
    // The empty-selection case: `clear_range` must not pay for a cascade when
    // it erased nothing, which is what makes the fix free on the common path.
    let wb = Workbook::new(1);
    wb.set(4, 0, "=SUM(A1:A3)");
    let seeds = clear_active_range(&wb, 0, 0, 1, 0);
    assert!(seeds.is_empty(), "no cell in A1:A2 held content");
}

// ---------------------------------------------------------------------------
// 2. Cross-sheet cycles report #CIRCULAR!
// ---------------------------------------------------------------------------

fn assert_circular(wb: &Workbook, sheet: usize, row: u32, col: u32, what: &str) {
    match wb.value(sheet, row, col) {
        CellValue::Error(CellError::Circular) => {}
        other => panic!(
            "{}: sheet {} ({},{}) is {:?}, expected #CIRCULAR!. A cycle crossing a \
             sheet boundary was detected nowhere, so it produced an ORDER-DEPENDENT \
             number instead of an error",
            what, sheet, row, col, other
        ),
    }
}

#[test]
fn a_two_sheet_cycle_reports_circular() {
    let wb = Workbook::new(2);
    wb.set(0, 0, "=Sheet2!A1");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1");
    wb.switch_to(0);

    wb.recalculate_every_sheet();

    assert_circular(&wb, 0, 0, 0, "two-sheet cycle");
    assert_circular(&wb, 1, 0, 0, "two-sheet cycle");
}

#[test]
fn a_three_sheet_cycle_reports_circular() {
    let wb = Workbook::new(3);
    wb.set(0, 0, "=Sheet2!A1");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet3!A1");
    wb.switch_to(2);
    wb.set(0, 0, "=Sheet1!A1");
    wb.switch_to(0);

    wb.recalculate_every_sheet();

    for sheet in 0..3 {
        assert_circular(&wb, sheet, 0, 0, "three-sheet cycle");
    }
}

#[test]
fn a_prefixed_self_reference_is_a_cycle_too() {
    // `=Sheet1!A1` written ON Sheet1 is a same-sheet cycle that the LOCAL
    // detector cannot see: `ExtractedRefs::cells` reports only UNPREFIXED
    // references, so this edge lands in `cross_sheet_cells` and was invisible
    // to `partition_formula_cells`. The sheet-level projection records it as a
    // self-loop, which is why the workbook walk catches it.
    let wb = Workbook::new(2);
    wb.set(0, 0, "=Sheet1!A1");
    wb.switch_to(0);

    wb.recalculate_every_sheet();

    assert_circular(&wb, 0, 0, 0, "prefixed self reference");
}

#[test]
fn mutual_sheet_references_without_a_cell_cycle_stay_numeric() {
    // THE FALSE-POSITIVE GUARD, and the reason the sheet-level projection can
    // only ever be a fast REJECT. Sheet1 reads Sheet2 and Sheet2 reads Sheet1,
    // so the projection is cyclic — but the two edges touch different cells and
    // there is no cell cycle at all. Reporting #CIRCULAR! here would be far
    // worse than the bug being fixed: this is an ordinary layered workbook.
    let wb = Workbook::new(2);
    wb.set(0, 0, "5"); // Sheet1!A1, a literal
    wb.set(0, 1, "=Sheet2!B1"); // Sheet1!B1
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1"); // Sheet2!A1
    wb.set(0, 1, "7"); // Sheet2!B1, a literal
    wb.switch_to(0);

    wb.recalculate_every_sheet();

    assert_eq!(wb.number(0, 0, 1), 7.0, "Sheet1!B1 reads Sheet2!B1");
    assert_eq!(wb.number(1, 0, 0), 5.0, "Sheet2!A1 reads Sheet1!A1");
}

#[test]
fn a_same_sheet_cycle_still_reports_circular() {
    // Behaviour that must NOT change: the local detector still owns this case,
    // and a single-sheet workbook never reaches the workbook-level walk at all
    // (gate 1 returns immediately when nothing references another sheet).
    let wb = Workbook::new(1);
    wb.set(0, 0, "=A2+1");
    wb.set(1, 0, "=A1+1");

    wb.recalculate_every_sheet();

    assert_circular(&wb, 0, 0, 0, "same-sheet cycle");
    assert_circular(&wb, 0, 1, 0, "same-sheet cycle");
}

#[test]
fn an_acyclic_cross_sheet_chain_stays_numeric() {
    // The ordinary case the gates protect: a layered workbook, where the
    // sheet-level projection is a DAG and the workbook walk returns without
    // ever building the cell-level graph.
    let wb = Workbook::new(3);
    wb.set(0, 0, "6");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1*2");
    wb.switch_to(2);
    wb.set(0, 0, "=Sheet2!A1+1");
    wb.switch_to(0);

    wb.recalculate_every_sheet();

    assert_eq!(wb.number(1, 0, 0), 12.0);
    assert_eq!(wb.number(2, 0, 0), 13.0);
}

// ---------------------------------------------------------------------------
// 2b. A SHEET-scoped pass evaluates ONE sheet, and a cycle spans several
// ---------------------------------------------------------------------------
//
// Found LIVE on the running app (remaining-correctness.spec.ts), not by
// reading. Every test above recalculates EVERY sheet, because that is what the
// off-sheet write path does — `recalc_after_off_sheet_write` calls
// `recalculate_sheet_values` once per sheet.
//
// HISTORY, because the fixture below reads oddly otherwise: `calculate_now` —
// F9 — used to evaluate the ACTIVE SHEET ALONE, and that is the state this
// section was written against. F9 now plans the whole workbook (Excel parity:
// F9 = Calculate Now = workbook, Shift+F9 = Calculate Sheet = sheet), so the
// off-sheet mark below belongs to the SHEET-scoped pass, which is the only one
// that still leaves sheets unevaluated. See
// `calculate_scope_tests.rs` for the workbook half, run rather than read.
//
// So `merge_cross_sheet_circular` moved the active sheet's members into a
// circular group and the members on the other sheets were left holding whatever
// number the previous evaluation order produced. Measured: F9 on Sheet1 gave
// `#CIRCULAR` on Sheet1!A1 and `0` on Sheet2!A1, and only a second F9 after
// switching tabs made them agree. That surviving number is the order-dependent
// answer this detector exists to remove — and it is worse than the original bug
// in one respect, because half the cycle now says "error" while the other half
// says "zero", one tab apart.
//
// `mark_off_sheet_circular_cells` closes it: a cycle is a workbook-level fact,
// so every sheet owning a member reports it.

/// The set a SHEET-scoped pass computes for itself, from the same walk.
fn workbook_cycle_members(wb: &Workbook) -> std::collections::HashSet<(usize, u32, u32)> {
    let grids = wb.state.grids.read().unwrap();
    let names = wb.state.sheet_names.read().unwrap().clone();
    let named_ranges = wb.state.named_ranges.read().unwrap();
    let tables = wb.state.tables.read().unwrap();
    let table_names = wb.state.table_names.read().unwrap();
    crate::calculation::workbook_circular_cells(
        &grids,
        &names,
        crate::name_resolution::NameTables {
            named_ranges: &named_ranges,
            tables: &tables,
            table_names: &table_names,
            sheet_names: &names,
            spill_ranges: &wb.state.spill_ranges,
        },
    )
}

/// Do to the grids exactly what the SHEET-scoped pass does after its merge.
fn mark_off_sheet(wb: &Workbook, active: usize) -> Vec<(usize, u32, u32)> {
    let circular = workbook_cycle_members(wb);
    let iteration_enabled = *wb.state.iteration_enabled.lock().unwrap();
    let mut grids = wb
        .state
        .grids
        .write(&crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::DerivedCache,
        ))
        .unwrap();
    crate::calculation::mark_off_sheet_circular_cells(
        &mut grids,
        &circular,
        active,
        iteration_enabled,
    )
}

#[test]
fn an_f9_pass_reports_the_cycle_members_it_did_not_evaluate() {
    let wb = Workbook::new(2);
    wb.set(0, 0, "=Sheet2!A1");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1");
    wb.switch_to(0);

    // What F9 evaluates: the ACTIVE sheet, and only that.
    crate::calculation::recalculate_sheet_values(&wb.state, &wb.files, &wb.pivots, 0, None);

    assert_circular(&wb, 0, 0, 0, "the sheet F9 evaluated");
    // TEETH. The single-sheet pass CANNOT have reported the other member — it
    // never looked at Sheet2 — so the assertion after the mark is a change and
    // not the state the fixture arrived in.
    assert!(
        !matches!(wb.value(1, 0, 0), CellValue::Error(CellError::Circular)),
        "Sheet2!A1 was already circular before the off-sheet mark ran; this test \
         would then prove nothing about the mark"
    );

    let marked = mark_off_sheet(&wb, 0);
    assert_eq!(
        marked,
        vec![(1usize, 0u32, 0u32)],
        "the mark must name exactly the off-sheet member it changed"
    );
    assert_circular(&wb, 1, 0, 0, "the sheet F9 did NOT evaluate");
}

#[test]
fn a_repeated_f9_does_not_re_announce_an_already_circular_cell() {
    // The frontend repaints what the command RETURNS, so a mark that reported
    // every member on every pass would make each F9 look like a change to a
    // workbook nothing had touched.
    let wb = Workbook::new(2);
    wb.set(0, 0, "=Sheet2!A1");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1");
    wb.switch_to(0);
    crate::calculation::recalculate_sheet_values(&wb.state, &wb.files, &wb.pivots, 0, None);

    assert_eq!(mark_off_sheet(&wb, 0).len(), 1, "the first pass marks it");
    assert!(
        mark_off_sheet(&wb, 0).is_empty(),
        "a second pass must announce nothing — the value did not move"
    );
    assert_circular(&wb, 1, 0, 0, "and it is still circular");
}

#[test]
fn the_off_sheet_mark_leaves_a_layered_workbook_alone() {
    // The false-positive guard, restated for the new writer. The sheet-level
    // projection is an over-approximation, so this fixture has a CYCLIC
    // projection and no cell cycle at all — and it is an entirely ordinary
    // layered workbook. Marking anything here would be far worse than the bug.
    let wb = Workbook::new(2);
    wb.set(0, 0, "5");
    wb.set(0, 1, "=Sheet2!B1");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1");
    wb.set(0, 1, "7");
    wb.switch_to(0);
    wb.recalculate_every_sheet();

    assert!(
        mark_off_sheet(&wb, 0).is_empty(),
        "nothing may be marked in a workbook with no cell cycle"
    );
    assert_eq!(wb.number(1, 0, 0), 5.0, "Sheet2!A1 is still a number");
    assert_eq!(wb.number(0, 0, 1), 7.0, "Sheet1!B1 is still a number");
}

#[test]
fn the_off_sheet_mark_is_skipped_under_iterative_calculation() {
    // The negative half, stated on its own. Under iteration the off-sheet
    // members CONVERGE (one hop per whole-workbook round); stamping them
    // #CIRCULAR! is precisely the regression the iterative guards forbid, and
    // this writer runs on the same hot path they do.
    let wb = Workbook::new(2);
    *wb.state.iteration_enabled.lock().unwrap() = true;
    wb.set(0, 0, "=Sheet2!A1*0.5+10");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1");
    wb.switch_to(0);
    crate::calculation::recalculate_sheet_values(&wb.state, &wb.files, &wb.pivots, 0, None);

    assert!(
        mark_off_sheet(&wb, 0).is_empty(),
        "the off-sheet mark must do nothing at all while iteration is enabled"
    );
    for sheet in 0..2 {
        assert!(
            !matches!(wb.value(sheet, 0, 0), CellValue::Error(CellError::Circular)),
            "sheet {} reported #CIRCULAR! with iterative calculation ENABLED",
            sheet
        );
    }
}

#[test]
fn the_sheet_scoped_pass_marks_the_cycle_members_on_the_sheets_it_does_not_evaluate() {
    // Behaviour is pinned by running the pass (calculate_scope_tests.rs); this
    // pins the WIRING, because deleting the call is silent: a sheet pass would
    // still look right on the sheet you are looking at and leave a plausible 0
    // one tab away.
    const CALCULATION_RS: &str = include_str!("../calculation.rs");
    let body = body_of(CALCULATION_RS, "run_calculation_pass");
    assert!(
        body.contains("mark_off_sheet_circular_cells("),
        "the SHEET-scoped pass (Shift+F9) merges the active sheet's cross-sheet \
         cycle members and stops there, so the members on every other sheet keep \
         the number the previous evaluation order left behind — #CIRCULAR! on \
         the sheet you are looking at and a plausible 0 one tab away"
    );
}

// ---------------------------------------------------------------------------
// 3. Iterative calculation must keep converging
// ---------------------------------------------------------------------------

#[test]
fn iterative_calculation_still_converges_across_sheets() {
    // Iterative calculation is a SUPPORTED feature: a deliberate circular
    // reference under it must converge, not start reporting #CIRCULAR! because
    // the cycle detector learned to see across sheets. Routing cross-sheet
    // cycle members into the SAME `circular_groups` bucket a same-sheet cycle
    // lands in is what buys this — they inherit the `iteration_enabled` branch
    // unchanged.
    //
    // x = 0.5x + 10  =>  x = 20.
    let wb = Workbook::new(2);
    *wb.state.iteration_enabled.lock().unwrap() = true;

    wb.set(0, 0, "=Sheet2!A1*0.5+10");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1");
    wb.switch_to(0);

    // Each whole-workbook round advances the cycle one hop, because a per-sheet
    // pass iterates only the members living on the sheet it is evaluating and
    // reads the other sheet's cached value. The ratio is 0.5, so this is
    // geometric and 60 rounds is enormous headroom.
    for _ in 0..60 {
        wb.recalculate_every_sheet();
    }

    let a = wb.number(0, 0, 0);
    let b = wb.number(1, 0, 0);
    assert!(
        (a - 20.0).abs() < 1e-6,
        "iterative cross-sheet cycle did not converge: Sheet1!A1 = {}",
        a
    );
    assert!(
        (b - 20.0).abs() < 1e-6,
        "iterative cross-sheet cycle did not converge: Sheet2!A1 = {}",
        b
    );
}

#[test]
fn iterative_mode_never_writes_circular_across_sheets() {
    // The negative half of the test above, stated on its own so a regression
    // that reports #CIRCULAR! under iteration fails loudly rather than as a
    // convergence assertion.
    let wb = Workbook::new(2);
    *wb.state.iteration_enabled.lock().unwrap() = true;

    wb.set(0, 0, "=Sheet2!A1");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1");
    wb.switch_to(0);

    wb.recalculate_every_sheet();

    for (sheet, label) in [(0usize, "Sheet1!A1"), (1usize, "Sheet2!A1")] {
        assert!(
            !matches!(wb.value(sheet, 0, 0), CellValue::Error(CellError::Circular)),
            "{} reported #CIRCULAR! with iterative calculation ENABLED",
            label
        );
    }
}

// ---------------------------------------------------------------------------
// 4. The detector's own gates
// ---------------------------------------------------------------------------

#[test]
fn the_workbook_walk_returns_immediately_without_cross_sheet_references() {
    // Gate 1, asserted directly: a workbook whose formulas never name another
    // sheet gets an empty answer, so single-sheet workbooks are untouched and
    // keep relying on `partition_formula_cells` alone.
    let wb = Workbook::new(2);
    wb.set(0, 0, "=A2+1");
    wb.set(1, 0, "=A1+1"); // a genuine SAME-sheet cycle
    wb.switch_to(0);

    let grids = wb.state.grids.read().unwrap();
    let names = wb.state.sheet_names.read().unwrap().clone();
    let named_ranges = wb.state.named_ranges.read().unwrap();
    let tables = wb.state.tables.read().unwrap();
    let table_names = wb.state.table_names.read().unwrap();
    let circular = crate::calculation::workbook_circular_cells(
        &grids,
        &names,
        crate::name_resolution::NameTables {
            named_ranges: &named_ranges,
            tables: &tables,
            table_names: &table_names,
            sheet_names: &names,
            spill_ranges: &wb.state.spill_ranges,
        },
    );

    assert!(
        circular.is_empty(),
        "gate 1 must return an EMPTY set when nothing references another sheet \
         — same-sheet cycles stay the local detector's job"
    );
}

#[test]
fn the_workbook_walk_finds_both_members_of_a_cross_sheet_cycle() {
    let wb = Workbook::new(2);
    wb.set(0, 0, "=Sheet2!A1");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1");
    wb.switch_to(0);

    let grids = wb.state.grids.read().unwrap();
    let names = wb.state.sheet_names.read().unwrap().clone();
    let named_ranges = wb.state.named_ranges.read().unwrap();
    let tables = wb.state.tables.read().unwrap();
    let table_names = wb.state.table_names.read().unwrap();
    let circular = crate::calculation::workbook_circular_cells(
        &grids,
        &names,
        crate::name_resolution::NameTables {
            named_ranges: &named_ranges,
            tables: &tables,
            table_names: &table_names,
            sheet_names: &names,
            spill_ranges: &wb.state.spill_ranges,
        },
    );

    assert!(circular.contains(&(0, 0, 0)), "Sheet1!A1 is a cycle member");
    assert!(circular.contains(&(1, 0, 0)), "Sheet2!A1 is a cycle member");
    assert_eq!(circular.len(), 2, "and nothing else is");
}

// ---------------------------------------------------------------------------
// 5. Every bulk rewrite path seeds the cascade
// ---------------------------------------------------------------------------

/// THE SIBLING SWEEP, asserted from source.
///
/// This class has now recurred three times — `update_cells_batch_core` and
/// `fill_range` (BUG-0019), then `sort_range`, then every command below. Each
/// of these takes `State` and cannot run in-process, and the failure mode is
/// silent (stale values, no error), so the wiring is pinned from source the way
/// `sort_range_recalculates_the_range_it_rewrote` pins its own.
///
/// A command that rewrites cell CONTENT and appears in neither list is the next
/// instance of this bug.
#[test]
fn every_bulk_cell_rewrite_seeds_the_shared_cascade() {
    const DATA_RS: &str = include_str!("data.rs");
    const SEARCH_RS: &str = include_str!("search.rs");
    const MERGE_RS: &str = include_str!("../merge_commands.rs");

    // ACTIVE-sheet rewrites: seeds into `recalc_after_active_sheet_bulk_rewrite`.
    let active: &[(&str, &str)] = &[
        ("clear_cell", DATA_RS),
        ("clear_range", DATA_RS),
        ("clear_range_with_options", DATA_RS),
        ("sort_range", DATA_RS),
        ("remove_duplicates", DATA_RS),
        ("replace_all", SEARCH_RS),
        ("replace_single", SEARCH_RS),
        // A merge DESTROYS every slave cell's value.
        ("merge_cells", MERGE_RS),
    ];
    for (name, source) in active {
        let body = body_of(source, name);
        assert!(
            body.contains("recalc_after_active_sheet_bulk_rewrite("),
            "`{}` rewrites cells on the active sheet without seeding the shared \
             cascade — its dependents keep stale values until an unrelated later \
             edit sweeps them up",
            name
        );
    }

    // OFF-sheet rewrites: whole-sheet evaluation through the off-sheet helper.
    let off_sheet: &[(&str, &str)] = &[
        ("clear_range_on_sheets", DATA_RS),
        ("clear_range_with_options_off_sheet", DATA_RS),
        ("sort_range_off_sheet", DATA_RS),
        ("replace_all_off_sheet", SEARCH_RS),
        ("replace_single_off_sheet", SEARCH_RS),
        // Found at integration: the ACTIVE `merge_cells` was fixed and its
        // off-sheet twin was not — the same asymmetry as `sort_range`, mirrored,
        // so it was the sheet you were NOT looking at that stayed wrong.
        ("merge_cells_off_sheet", MERGE_RS),
    ];
    for (name, source) in off_sheet {
        let body = body_of(source, name);
        assert!(
            body.contains("recalc_after_off_sheet_write("),
            "`{}` writes cells on a non-active sheet without recalculating anything",
            name
        );
    }

    // EITHER-sheet rewrites: the destination is a parameter, so these branch on
    // it and must carry BOTH helpers.
    const CONSOLIDATE_RS: &str = include_str!("../consolidate.rs");
    const BI_RS: &str = include_str!("../bi/commands.rs");
    let either: &[(&str, &str)] = &[
        ("consolidate_data", CONSOLIDATE_RS),
        ("bi_insert_result", BI_RS),
        // Found at integration, in the same file as the one that WAS fixed: a
        // refresh replaces the whole result block exactly as an insert writes
        // it, so every formula reading a refreshed region kept the PREVIOUS
        // refresh's numbers.
        ("bi_refresh_connection", BI_RS),
    ];
    for (name, source) in either {
        let body = body_of(source, name);
        assert!(
            body.contains("recalc_after_active_sheet_bulk_rewrite(")
                && body.contains("recalc_after_off_sheet_write("),
            "`{}` writes a block of cells to a destination sheet chosen at \
             runtime, so it must recalculate on BOTH branches — an on-sheet \
             destination through the seeded cascade, an off-sheet one through \
             the whole-sheet helper",
            name
        );
    }
}

#[test]
fn remove_duplicates_rebuilds_dependencies_before_seeding() {
    // Remove-duplicates COMPACTS rows upwards, so formula cells land at new
    // positions and the dependency maps still describe where they used to live
    // (the BUG-0010 hazard `sort_range` rebuilds for). Seeding a cascade over
    // stale edges would walk the wrong graph, so the rebuild is part of the fix
    // rather than an independent nicety.
    const DATA_RS: &str = include_str!("data.rs");
    let body = body_of(DATA_RS, "remove_duplicates");
    assert!(
        body.contains("rebuild_all_dependencies_from_grid("),
        "`remove_duplicates` moves formula cells without rebuilding the \
         dependency maps"
    );
}

// ---------------------------------------------------------------------------
// 6. The sweep, made exhaustive
// ---------------------------------------------------------------------------

/// EVERY function in the crate that writes a cell, classified — the census the
/// hand-written list above cannot be.
///
/// `every_bulk_cell_rewrite_seeds_the_shared_cascade` pins twelve NAMED
/// commands. That is exactly the shape the defect keeps hiding in: it recurred
/// with `update_cells_batch_core` + `fill_range`, then `sort_range`, then ten
/// siblings, and integration found two MORE that the ten-command sweep had not
/// enumerated at all (`bi_refresh_connection`, whose own twin `bi_insert_result`
/// had just been fixed, and `merge_cells_off_sheet`, the mirror of the
/// active/off-sheet asymmetry that hid `sort_range`). A list of names cannot
/// fail for the command nobody thought of, so this test does not take a list of
/// names: it ENUMERATES the crate.
///
/// Every function containing a `set_cell` / `clear_cell` call must either
/// recalculate (its body mentions one of the shared entry points) or appear in
/// `EXEMPT` below with a written reason. A new cell-writing command fails this
/// test until somebody makes that decision explicitly.
#[test]
fn every_cell_writing_function_either_recalculates_or_is_exempt_with_a_reason() {
    // (file relative to src/, function, reason it does not recalculate)
    const EXEMPT: &[(&str, &str, &str)] = &[
        ("mcp/tools.rs", "apply_seeds", "IS NOT A DOCUMENT WRITE: seeds a DETACHED CLONE for a dry run (ai/dryrun.rs). Nothing downstream observes it, so there are no dependents to recalculate."),
        ("ai/preview_eval.rs", "build_grid", "IS NOT A DOCUMENT WRITE: fills a `Grid::new()` built inside the function from the caller's cell list, for the script preview's formula evaluator. The grid is dropped when `evaluate_preview` returns; the workbook is never reached, so there is nothing to recalculate."),
        ("ai/preview_eval.rs", "evaluate_preview", "IT IS AN EVALUATION LOOP, over a detached grid: it iterates its own formulas to a fixed point (PASS_CAP) and returns values. Pure — no Tauri state, no I/O — which is the same class as data_tables/goal_seek below, minus even the document."),
        ("insights/report.rs", "paint", "WRITES ONLY LITERALS, ONTO A SHEET THAT DID NOT EXIST. `insights_create_report_sheet` calls `add_sheet_inner` first — with a name `ensure_sheet_name_is_free` proved was not taken — and paints into a fresh `Grid::new()`. Nothing in the workbook can already depend on cells of a sheet created a moment ago, and `ReportCell` has no formula variant, so nothing painted needs evaluating either. Whether creating a sheet at all should recalculate is `add_sheet_inner`'s question, and it is the same question for every sheet the user adds by hand."),
        // -- It IS recalculation, or an inner step of it -------------------
        ("calculation.rs", "run_calculation_pass", "the full-recalculation pass itself (F9 = workbook, Shift+F9 = active sheet)"),
        ("calculation.rs", "mark_off_sheet_circular_cells", "an inner step of the SHEET-scoped pass: reports a cycle the pass already detected on the sheets it does not evaluate"),
        ("commands/data.rs", "reevaluate_formula_cell", "the cascade's per-cell evaluator"),
        ("commands/data.rs", "recalc_walked_cell", "the cross-sheet walk's per-cell step"),
        ("pivot/operations.rs", "recalculate_sheet_formulas", "a whole-sheet evaluation"),
        ("persistence.rs", "open_file", "the load path recalculates the workbook it just read"),
        // -- Rewrites a formula's TEXT without moving any value -------------
        ("named_ranges.rs", "apply_names_to_formulas", "substitutes a defined name for the reference it already denoted: the same cell, so no value moves (it does rebuild the name dependency edges)"),
        ("sheets.rs", "rename_sheet_inner", "a rename rewrites references to spell the new name; every reference still denotes the same cell, so no value moves (it does re-key the cross-sheet dependency maps and rebuild the single-sheet ones). The `rename_sheet` command is now a one-line delegation here (testability split) and writes nothing itself"),
        ("tables.rs", "fill_calculated_columns", "a SHARED HELPER, not a command: it writes one table's calculated columns across the rows its caller names and collects them as SEEDS. All three callers (set_calculated_column and the two row-growth paths) drop every guard and then run the shared cascade with those seeds -- `every_row_growth_path_fills_the_calculated_columns` in tables.rs is what keeps a fourth caller from appearing without one"),
        ("named_ranges.rs", "rename_name_in_grids", "the DEFINED-NAME twin of rename_sheet_inner above: it rewrites `NamedRef` nodes to spell the new name, and every one still denotes the same range, so no value moves. Its caller `rename_named_range_impl` does run a phase B (`rebuild_all_dependencies` then `recalc_after_name_change`) — necessary because the name dependency edges are keyed BY NAME and would otherwise all be filed under a name the workbook no longer has, not because a value changed"),
        // -- Own evaluation loop over the cells it writes -------------------
        ("data_tables.rs", "data_table_one_var", "what-if table: evaluates each substitution itself"),
        ("data_tables.rs", "data_table_two_var", "what-if table: evaluates each substitution itself"),
        ("data_tables.rs", "re_evaluate_formulas", "the what-if table's own evaluation step"),
        ("data_tables.rs", "restore_cell", "restores the probe cell the loop borrowed"),
        ("data_tables.rs", "set_cell_value", "sets the probe cell the loop borrowed"),
        ("goal_seek.rs", "goal_seek", "iterates to a root, evaluating every trial itself"),
        ("goal_seek.rs", "evaluate_target", "one goal-seek trial"),
        ("goal_seek.rs", "finalize_result", "writes the converged value the loop already evaluated"),
        ("solver.rs", "solver_solve", "runs its own objective evaluation loop"),
        ("solver.rs", "solver_revert", "restores the pre-solve values the loop captured"),
        ("solver.rs", "set_variables_and_evaluate", "one solver trial"),
        ("scenario_manager.rs", "scenario_show", "transient scenario preview with its own evaluation"),
        ("scenario_manager.rs", "scenario_summary", "builds a report block from values it evaluated"),
        ("animation_commands.rs", "apply_set_ops_and_recalc", "transient frame playback; orders through the shared recalc_order_from_seeds"),
        // -- Style only: changes nothing a formula can read -----------------
        ("commands/styles.rs", "apply_formatting", "style_index only"),
        ("commands/styles.rs", "apply_formatting_to_sheets", "style_index only"),
        ("commands/styles.rs", "set_cell_style", "style_index only"),
        ("commands/styles.rs", "set_cell_rich_text", "rich-text runs only"),
        ("commands/styles.rs", "apply_border_preset", "style_index only"),
        ("protection.rs", "set_cell_protection", "lock/hidden flags only"),
        ("named_styles_cmd.rs", "apply_named_style_impl", "style_index only"),
        ("computed_properties.rs", "apply_fill_color", "style_index only"),
        ("computed_properties.rs", "apply_style_change", "style_index only"),
        ("mcp/tools.rs", "apply_cell_formatting", "style_index only"),
        // -- Helper: the CALLER recalculates --------------------------------
        ("consolidate.rs", "consolidate_data_inner", "`consolidate_data` seeds from its updated_cells"),
        ("calp_commands.rs", "write_override_value", "all three override commands run recalculate_sheet_values after"),
        ("commands/coord_shift.rs", "shift_per_sheet_cell_map", "generic coordinate-map shift used by the structural edit"),
        ("scripting/commands.rs", "parse_script_formula_writes", "builds a detached grid; apply_script_modified_grids_core recalculates"),
        ("calp_merge.rs", "overlay_their_cells", "builds a DETACHED copy of the grids with the intervening version's cells laid over it; it mutates nothing in AppState and hands the result to apply_script_modified_grids, which diffs, records undo and recalculates — the same arrangement parse_script_formula_writes has"),
        ("calp_commands.rs", "calp_hold_back_cells", "the same arrangement as overlay_their_cells above, from a different selection source: it clones the grids, lays the BASE version's value over the cells the author unticked in the push diff, and hands the result to apply_script_modified_grids. The recalculation is the POINT rather than an obligation — a held-back input whose dependents still showed the author's numbers is exactly the inconsistent artifact this command exists to avoid publishing"),
        ("commands/structure.rs", "shift_cross_sheet_formulas", "helper of the structural edit, which recalculates"),
        ("commands/structure.rs", "shift_cross_sheet_formulas_for_off_sheet_edit", "helper of off_sheet_structural_edit, which recalculates"),
        ("tables.rs", "write_table_formula_cell", "helper: writes ONE totals cell with its resolved AST + edges; `set_totals_row_function` and `toggle_totals_row` seed the cascade over every cell they hand it"),
        ("calp_commands.rs", "apply_override_value_to_grid", "helper of the three override commands; calp_revert_override, calp_accept_upstream and calp_refresh_apply each run recalculate_sheet_values after"),
        ("calp_commands.rs", "apply_refreshed_pivots", "helper of calp_refresh_apply (§2.z), which runs recalculate_sheet_values over every REFRESHED sheet index before it returns. That covers this function's writes exactly, and the coverage is stated rather than assumed: a pivot adopted from an application writes its output to that application's own destination sheet, and a withdrawn pivot's cleared region sits on the sheet it was written to — both of which are, by construction, sheets this refresh touched and therefore sheets in `refreshed_indices`. A pivot naming a destination this workbook does not have is SKIPPED before any write, so it cannot escape that set"),
        ("commands/structure.rs", "shift_per_sheet_cell_stores", "helper of the four structural edits; wraps shift_per_sheet_cell_map over every per-sheet store"),
        ("lib.rs", "repair_all_formulas", "helper: rewrites formula ASTs across every sheet for a caller-supplied repair; `delete_sheet` recalculates the workbook after it and `rename_sheet` is exempt because a rename moves no value"),
        ("commands/data.rs", "erase_released_spill_cells", "helper: erases the cells a released spill owned; every caller is inside, or immediately followed by, the shared cascade"),
        ("commands/data.rs", "apply_spill_decision", "THE ONE SPILL DECISION (§3bm): the inner step every per-cell evaluator ends in — the three edit paths, the cross-sheet walk and both recalculation passes. It decides what ONE already-evaluated result does to the grid; it never chooses which cells to evaluate, so it cannot seed anything"),
        ("commands/data.rs", "release_origin_spill", "helper: the tear-down half of apply_spill_decision, called directly only where a value is written WITHOUT an EvalResult to hand it (the #CIRCULAR! stamps)"),
        ("undo_commands.rs", "apply_changes", "drives the cascade for every restore kind"),
        ("undo_commands.rs", "apply_calp_reset_restore", "reports its sheet; apply_changes recalculates"),
        ("undo_commands.rs", "apply_object_swap_restore", "reports its sheet; apply_changes recalculates"),
        ("undo_commands.rs", "apply_pivot_create_restore", "reports its sheet; apply_changes recalculates"),
        ("undo_commands.rs", "apply_pivot_definition_restore", "reports its sheet; apply_changes recalculates"),
        ("undo_commands.rs", "apply_report_restore", "reports its sheet; apply_changes recalculates"),
        ("undo_commands.rs", "apply_script_grid_cells_restore", "reports its sheet; apply_changes recalculates"),
        ("undo_commands.rs", "apply_sheet_structural_restore", "reports its sheet; apply_changes recalculates"),
        // -- Writes a sheet nothing can yet reference -----------------------
        ("pivot/commands.rs", "drill_through_to_sheet", "writes a freshly created sheet: no formula can reference a sheet that did not exist a moment ago, so there is nothing to cascade to"),
        // -- Rewrites formula REFERENCES, not values ------------------------
        ("tables.rs", "rename_table_refs_in_formulas", "re-points structured refs at the same cells; no value moves"),
        ("tables.rs", "rename_table_column_in_formulas", "re-points a COLUMN specifier at the same cells; no value moves, and both callers recalculate anyway"),
        ("tables.rs", "rewrite_table_refs_to_ranges", "flattens structured refs to the same cells; no value moves"),
    ];
    //
    // D8 CLOSED THE "KNOWN RESIDUAL" BLOCK — the four structural edits.
    // `insert_rows`, `insert_columns`, `delete_rows` and `delete_columns` sat
    // here saying, honestly, that they re-point every reference and move each
    // cached value with its cell and therefore LOOK value-preserving, but that
    // a formula whose result depends on the SHAPE or POSITION of what it reads
    // keeps a number its own rewritten AST no longer produces. They now
    // recalculate, through the SAME shared entry points as everything else
    // (`recalc_after_active_sheet_bulk_rewrite` for the active sheet,
    // `recalc_after_off_sheet_write` for the sheets a cross-sheet rewrite
    // touched, `recalc_after_name_change` for a re-pointed defined name), and
    // the bodies now live in `*_impl` twins so the behaviour can be tested at
    // all — a `#[tauri::command]` cannot be called from a unit test, which is
    // why "it recalculates" had never been anything but an assertion about
    // source text. Behaviour is pinned in `commands/d8_structural_recalc_tests.rs`.
    //
    // The seed set and its cost are in docs/design/open-decisions-2026-08.md D8.
    // The measurement contradicted the register's own recommendation twice: its
    // option 1 (seed only the rewritten ASTs) MISSES `=ROW()`, which has no
    // argument to rewrite and still has to change when its cell moves; and its
    // option 2 (seed every moved cell) measured WORSE than the whole-sheet pass
    // it would replace (628.08 ms vs 392.76 ms on a 10 000-row insert), which is
    // D3's finding recurring.
    //
    // D3 CLOSED THE "IN CLASS" BLOCK. Eight entries used to sit here saying the
    // pivot and table writes were somebody else's problem: create_pivot_inner,
    // delete_pivot_table, undo_pivot_overwrite, toggle_totals_row,
    // set_totals_row_function, set_calculated_column, check_table_auto_expand
    // and relocate_cell_references. Each wrote into a region and recalculated
    // nothing, so a formula reading that region kept a stale value with no
    // error shown — and in Excel every one of those formulas updates. They now
    // seed the SHARED cascade (`recalc_after_active_sheet_bulk_rewrite` on the
    // active sheet, `recalc_after_off_sheet_write` for a destination sheet
    // chosen at runtime), NOT a per-region refresh contract of their own: a
    // second cascade concept is exactly what this census exists to prevent.
    // Behaviour is pinned in `commands/d3_cascade_seed_tests.rs`.
    //
    // The measured cost is in docs/design/open-decisions-2026-08.md §4 D3. It
    // is far cheaper than the alternative already in the tree: the pivot
    // refresh path (`finalize_pivot_update` -> `recalculate_sheet_formulas`)
    // re-evaluates EVERY formula on the sheet, where seeding touches only the
    // block and its dependents.

    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    assert!(
        src_root.is_dir(),
        "the crate source tree is not readable at {} — this census cannot run \
         from a list, so it reads the tree",
        src_root.display()
    );

    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_rs_files(&src_root, &mut files);
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
        // Test sources are not the product.
        if rel.ends_with("_tests.rs") || rel == "tests.rs" || rel.starts_with("tests/") {
            continue;
        }
        let text = std::fs::read_to_string(path).unwrap_or_default();
        for (func, recalculates) in cell_writing_functions(&text) {
            seen.push((rel.clone(), func.clone()));
            if recalculates {
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
        "these functions write cells and neither recalculate nor carry a \
         recorded reason not to:\n  {}\n\nThis is the `sort_range` / \
         `clear_range` / `bi_refresh_connection` class. Either seed the ONE \
         shared cascade (`recalc_after_active_sheet_bulk_rewrite` for the \
         active sheet, `recalc_after_off_sheet_write` for others, as a SECOND \
         lock phase after the command's own guards are dropped) or add the \
         function to EXEMPT with the reason it needs none.",
        unclassified.join("\n  ")
    );

    // The exemption list must not outlive its entries either: a stale name in
    // it reads as a considered decision about code that no longer exists.
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

    // Non-vacuity: the census must actually be finding the known members.
    for (file, func) in [
        ("commands/data.rs", "clear_range"),
        ("commands/data.rs", "sort_range"),
        ("bi/commands.rs", "bi_refresh_connection"),
        ("merge_commands.rs", "merge_cells_off_sheet"),
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

/// THE CENSUS HAS TEETH, asserted rather than trusted.
///
/// `every_cell_writing_function_either_recalculates_or_is_exempt_with_a_reason`
/// is the acceptance test for a whole class of defect, so its own detector must
/// be shown to FIRE. The manual version of this check is "delete one recalc
/// call and confirm the census names that function" — which is exactly what
/// this does, on a synthetic source string, so it runs on every build instead
/// of once in somebody's head.
///
/// Three properties, and all three matter:
///   1. a function that writes a cell and does NOT recalculate is reported;
///   2. the same function WITH a shared entry point is not;
///   3. removing the call flips it back — the detector keys on the recalc call,
///      not on the function's name or position.
#[test]
fn the_census_detector_actually_fires_on_a_cell_writer_that_does_not_recalculate() {
    const WITHOUT: &str = "\
pub fn writes_and_forgets(grid: &mut Grid) {
    grid.set_cell(0, 0, cell);
}
";
    const WITH: &str = "\
pub fn writes_and_forgets(grid: &mut Grid) {
    grid.set_cell(0, 0, cell);
    recalc_after_active_sheet_bulk_rewrite(state, files, pane, filters, seeds, out);
}
";
    const NO_WRITE: &str = "\
pub fn touches_nothing(grid: &mut Grid) {
    let _ = grid.get_cell(0, 0);
}
";

    let found = cell_writing_functions(WITHOUT);
    assert_eq!(
        found,
        vec![("writes_and_forgets".to_string(), false)],
        "the census did not flag a function that writes a cell and reaches no          shared entry point — it would pass a workbook full of stale values"
    );

    let found = cell_writing_functions(WITH);
    assert_eq!(
        found,
        vec![("writes_and_forgets".to_string(), true)],
        "the census failed to notice a function that DOES seed the shared          cascade; a census that reports everything is ignored, which is the          same as having none"
    );

    assert!(
        cell_writing_functions(NO_WRITE).is_empty(),
        "the census reported a function that writes no cell at all"
    );

    // 3b. A BRACE-LESS `#[cfg(test)] mod x;` MUST NOT SWALLOW THE REST OF THE
    //     FILE.
    //
    // THE HOLE THIS CASE WAS WRITTEN FOR, and it was live. `strip_test_modules`
    // skipped a test module by scanning forward to a `}` at column 0. A module
    // DECLARATION has no body and no such brace, so the scan ran to EOF and
    // blanked everything after it. `commands/data.rs` ends with ten of those
    // declarations, so the census's view of the crate's biggest command file
    // stopped there.
    //
    // Measured, not imagined: appending a cell writer that recalculates nothing
    // to the end of `data.rs` left THIS census green while the spill census —
    // whose stripper never had the bug — named the function immediately.
    const AFTER_TEST_MOD_DECL: &str = "\
#[cfg(test)]
#[path = \"some_tests.rs\"]
mod some_tests;

pub fn writes_after_the_declaration(grid: &mut Grid) {
    grid.set_cell(0, 0, cell);
}
";
    assert_eq!(
        cell_writing_functions(AFTER_TEST_MOD_DECL),
        vec![("writes_after_the_declaration".to_string(), false)],
        "a cell writer declared AFTER a brace-less `#[cfg(test)] mod x;` was \
         not enumerated — the test-module stripper is consuming the rest of \
         the file, so any function below the test declarations is exempt from \
         this census without anybody saying so"
    );

    // ...and a real test module WITH a body is still removed, or the census
    // would start enumerating test fixtures as product cell writers.
    const REAL_TEST_MOD: &str = "\
#[cfg(test)]
mod tests {
    pub fn seeds_a_fixture(grid: &mut Grid) {
        grid.set_cell(0, 0, cell);
    }
}
";
    assert!(
        cell_writing_functions(REAL_TEST_MOD).is_empty(),
        "a `#[cfg(test)]` module WITH a body was not stripped — test fixtures \
         would be enumerated as product writes and the census would drown"
    );

    // 4. THE HOLE FOUND BY SABOTAGE. A caller that reaches the grid only
    //    through a delegating helper is still a cell writer. Before this,
    //    deleting the recalc call from `set_totals_row_function` — whose whole
    //    exemption story is "the caller seeds" — failed nothing at all.
    const VIA_HELPER: &str = "\
pub fn writes_through_a_helper(state: &AppState) {
    write_table_formula_cell(state, &mut grid, row, col, formula);
}
";
    assert_eq!(
        cell_writing_functions(VIA_HELPER),
        vec![("writes_through_a_helper".to_string(), false)],
        "a function that writes cells ONLY by calling a delegating helper was \
         not enumerated. The helper is EXEMPT because its caller recalculates, \
         so an unchecked caller means neither half is checked."
    );

    // ...and it is satisfied by the same shared entry points, not by anything
    // special-cased for helpers.
    const VIA_HELPER_OK: &str = "\
pub fn writes_through_a_helper(state: &AppState) {
    write_table_formula_cell(state, &mut grid, row, col, formula);
    recalc_after_active_sheet_bulk_rewrite(state, files, pane, filters, seeds, out);
}
";
    assert_eq!(
        cell_writing_functions(VIA_HELPER_OK),
        vec![("writes_through_a_helper".to_string(), true)]
    );

    // The helper's OWN definition must still be judged by its body, or every
    // helper would classify itself as a caller of itself and the exemption
    // list could never be satisfied.
    const HELPER_ITSELF: &str = "\
pub fn write_table_formula_cell(grid: &mut Grid) {
    grid.set_cell(0, 0, cell);
}
";
    assert_eq!(
        cell_writing_functions(HELPER_ITSELF),
        vec![("write_table_formula_cell".to_string(), false)],
        "the helper's own definition must be classified by its body"
    );

    // 5. THE SECOND HOLE FOUND BY SABOTAGE, in the D8 integration pass. The
    //    recalc call was "removed" from `insert_rows_impl` by COMMENTING IT
    //    OUT, and the census passed: the text was still in the body and the
    //    RECALC side read the raw lines. That is the likeliest shape of a real
    //    removal — every one of these call sites is wrapped in a comment
    //    explaining it, so the name survives a careless delete either way.
    const COMMENTED_OUT: &str = "\
pub fn writes_and_forgets(grid: &mut Grid) {
    grid.set_cell(0, 0, cell);
    // recalc_after_active_sheet_bulk_rewrite(state, files, pane, filters, seeds, out);
}
";
    assert_eq!(
        cell_writing_functions(COMMENTED_OUT),
        vec![("writes_and_forgets".to_string(), false)],
        "a COMMENTED-OUT recalculation call satisfied the census. Comments are \
         not code: a function that only mentions the entry point does not reach \
         it, and this is exactly what deleting one carelessly leaves behind."
    );

    // ...including the prose form, which is how every real call site here
    // documents itself.
    const MENTIONED_IN_PROSE: &str = "\
pub fn writes_and_forgets(grid: &mut Grid) {
    // Callers rely on recalc_after_active_sheet_bulk_rewrite(...) running later.
    grid.set_cell(0, 0, cell);
}
";
    assert_eq!(
        cell_writing_functions(MENTIONED_IN_PROSE),
        vec![("writes_and_forgets".to_string(), false)],
        "a prose mention of the entry point satisfied the census"
    );
}

/// The exemption list is a list of DECISIONS, so every entry must carry a
/// reason somebody wrote. An empty string is how an entry gets parked
/// "temporarily" and then stays forever — which is precisely what the eight
/// "IN CLASS" entries D3 removed had done.
#[test]
fn every_exemption_carries_a_written_reason() {
    // Re-read the list from this file's own source: the constant is scoped to
    // the census test above, and duplicating it here would let the two drift.
    const SELF: &str = include_str!("bulk_rewrite_recalc_tests.rs");
    let start = SELF
        .find("const EXEMPT:")
        .expect("the census must still declare an EXEMPT list");
    let end = SELF[start..]
        .find("\n    ];")
        .map(|o| start + o)
        .expect("the EXEMPT list must still terminate");
    let block = &SELF[start..end];

    for line in block.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("(\"") {
            continue;
        }
        assert!(
            !trimmed.contains(", \"\")"),
            "an EXEMPT entry carries an empty reason:\n  {}\n\nAn exemption is a \
             decision, and a decision nobody wrote down is indistinguishable \
             from an oversight",
            trimmed
        );
    }
}

/// Every `.rs` file under `dir`, recursively.
fn collect_rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// `(function name, does its body reach a shared recalculation entry point)`
/// for every function in `text` that writes a cell, with `#[cfg(test)]` modules
/// removed first — a test fixture seeding a grid is not a product write.
fn cell_writing_functions(text: &str) -> Vec<(String, bool)> {
    cell_writing_functions_with_helpers(text, DELEGATING_HELPERS)
}

/// The EXEMPT entries whose recorded reason is "my CALLER recalculates".
///
/// THE HOLE THIS CLOSES, found by sabotage during integration. The census
/// enumerates functions whose body textually contains `.set_cell(` /
/// `.clear_cell(`. `set_totals_row_function` contains neither — it delegates to
/// `write_table_formula_cell`, which is EXEMPT precisely *because*
/// `set_totals_row_function` seeds the cascade. So the recalc call was deleted
/// from `set_totals_row_function` and the census PASSED: the exemption's reason
/// was a claim about another function that nothing verified, and the two halves
/// could be removed one at a time with no test ever failing.
///
/// Calling one of these counts as writing a cell, which is what it is — the
/// helper exists only to be the write. The caller must then recalculate or earn
/// its own exemption, exactly like a direct writer.
const DELEGATING_HELPERS: &[&str] = &[
    "consolidate_data_inner",
    "write_override_value",
    "shift_per_sheet_cell_map",
    "parse_script_formula_writes",
    "shift_cross_sheet_formulas",
    "shift_cross_sheet_formulas_for_off_sheet_edit",
    "write_table_formula_cell",
    // Second-level helpers: each wraps one of the above, so the chain has to
    // continue through them or it stops one call short of the command that
    // actually owns the decision. `apply_override_value_to_grid` reaches
    // `calp_revert_override` / `calp_accept_upstream` / `calp_refresh_apply`
    // (all three recalculate); `shift_per_sheet_cell_stores` reaches the four
    // structural edits.
    "apply_override_value_to_grid",
    "shift_per_sheet_cell_stores",
    // Found once the census learned to see direct `grid.cells` writes.
    // `repair_all_formulas` rewrites formula ASTs across EVERY sheet -- including
    // the arm that sets a cell to `#REF!` -- so its callers (`delete_sheet`,
    // `rename_sheet`) own the recalculation decision, exactly like a direct
    // writer. `erase_released_spill_cells` is the spill tear-down's write.
    "repair_all_formulas",
    "erase_released_spill_cells",
    // §3bm. THE ONE SPILL DECISION and its tear-down half: both write cells on
    // behalf of whoever called them, so the caller still owns the
    // recalculation decision, exactly like a direct writer.
    "apply_spill_decision",
    "release_origin_spill",
    // §2aj. `rename_table_column_in_formulas` is the column rename's write, the
    // way `rename_table_refs_in_formulas` is the table rename's; its two callers
    // (`rename_table_column`, `enforce_table_header`) own the decision.
    "rename_table_column_in_formulas",
];

/// The direct-map mutations of a `Grid`: `grid.cells.insert(...)`,
/// `grids[i].cells.remove(...)`, `grid.cells.get_mut(...)`.
///
/// Deliberately RECEIVER-AWARE. `Grid::cells` is a public map and this crate
/// writes into it in 42 places, but `ExtractedRefs` also has a field called
/// `cells` and collecting a reference into it is not writing a cell. Matching
/// `.cells.insert(` alone reported `extract_references_recursive` as a cell
/// writer, and the only way to make the census pass would have been to record a
/// false exemption -- which is how a census stops being believed.
///
/// The receiver must therefore name a grid. `unrecognised_cells_receivers`
/// below is the tripwire that keeps this precision from quietly becoming
/// blindness: if a `Grid` is ever held in a variable not named for one, that
/// test fails and forces the decision rather than silently dropping the write.
fn writes_cells_map(line: &str) -> bool {
    for method in [".cells.insert(", ".cells.remove(", ".cells.get_mut("] {
        let mut rest = line;
        while let Some(at) = rest.find(method) {
            if receiver_is_a_grid(&rest[..at]) {
                return true;
            }
            rest = &rest[at + method.len()..];
        }
    }
    false
}

/// The identifier immediately before `.cells`, with any `[index]` stripped.
fn cells_receiver(before: &str) -> String {
    let base = before.rsplit('[').next_back().unwrap_or(before);
    let base = base.trim_end_matches(|c: char| c == ']' || c.is_whitespace());
    let base = if let Some(open) = base.rfind('[') {
        &base[..open]
    } else {
        base
    };
    base.chars()
        .rev()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn receiver_is_a_grid(before: &str) -> bool {
    cells_receiver(before).to_lowercase().contains("grid")
}

fn cell_writing_functions_with_helpers(text: &str, helpers: &[&str]) -> Vec<(String, bool)> {
    const RECALC: [&str; 6] = [
        "recalc_after_active_sheet_bulk_rewrite(",
        "recalc_after_off_sheet_write(",
        "recalculate_sheet_values(",
        "cascade_cross_sheet_dependents(",
        "recalc_order_from_seeds(",
        // §2aj. `recalc_after_table_change` is not a SIXTH cascade: it seeds the
        // first two and nothing else, the way `recalc_after_name_change` does
        // for a repointed defined name. Naming it here is what lets a table
        // command satisfy this census by calling the ONE entry point that also
        // rebuilds the readers' cell edges — which a bare
        // `recalc_after_active_sheet_bulk_rewrite` does not do, and which a
        // table resize needs. `the_table_recalculation_reaches_the_shared_cascade`
        // in `structured_ref_tests` pins that it really does seed them, so this
        // vocabulary entry cannot become a way to satisfy the census with
        // nothing behind it.
        "recalc_after_table_change(",
    ];
    let lines: Vec<String> = strip_test_modules(text);

    // (line index, indentation, name) of every `fn` item.
    let mut starts: Vec<(usize, usize, String)> = Vec::new();
    for (n, line) in lines.iter().enumerate() {
        if let Some((indent, name)) = parse_fn_header(line) {
            starts.push((n, indent, name));
        }
    }

    let mut out: Vec<(String, bool)> = Vec::new();
    for &(start, indent, ref name) in &starts {
        // A function ends at the first line that is exactly its closing brace
        // at its own indentation — how every item in this crate is written.
        let closer = format!("{}}}", " ".repeat(indent));
        let end = lines[start + 1..]
            .iter()
            .position(|l| *l == closer)
            .map(|off| start + 1 + off)
            .unwrap_or(lines.len() - 1);
        let body = &lines[start..=end];
        let writes = body.iter().any(|l| {
            let t = l.trim_start();
            if t.starts_with("//") {
                return false;
            }
            // THE THIRD BLIND SPOT IN THIS DETECTOR (after delegating helpers
            // and comments-are-not-code). `set_cell`/`clear_cell` are the
            // Grid's API, but a `Grid`'s `cells` map is PUBLIC and a good deal
            // of this crate writes straight into it. `repair_all_formulas` is
            // the one that mattered: it rewrites formula ASTs across EVERY
            // sheet through `grid.cells.get_mut(...)`, including the arm that
            // sets a cell to `#REF!`, and it contains neither token -- so
            // neither it nor its callers (`delete_sheet`, `rename_sheet`) was
            // ever enumerated. An entire subsystem sat outside the census.
            if l.contains(".set_cell(") || l.contains(".clear_cell(") || writes_cells_map(l) {
                return true;
            }
            // Delegating to a helper that exists only to do the write is
            // writing. `name != h` so the helper's own definition is still
            // classified by its body, not by its signature line.
            helpers
                .iter()
                .any(|h| *h != name.as_str() && l.contains(&format!("{}(", h)))
        });
        if !writes {
            continue;
        }
        // COMMENTS ARE NOT CODE, and this side of the census used to forget it.
        // Found by sabotage during integration: the recalc call was "removed"
        // from `insert_rows_impl` by commenting it out, and the census PASSED —
        // the deleted line was still there as text, and this check read the raw
        // body. Every function that documents WHY it recalculates does so by
        // naming the entry point, so a body that only *mentions* the call is
        // exactly the shape a careless removal leaves behind. No function in the
        // crate relies on a comment today (verified when this line was added);
        // this makes sure none ever can.
        let code: String = body
            .iter()
            .filter(|l| !l.trim_start().starts_with("//"))
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        let recalculates = RECALC.iter().any(|r| code.contains(r));
        out.push((name.clone(), recalculates));
    }
    out
}

/// `(indentation, name)` if `line` opens a `fn` item.
fn parse_fn_header(line: &str) -> Option<(usize, String)> {
    let indent = line.len() - line.trim_start().len();
    if indent > 4 {
        return None; // deeper than an impl body: a closure or a nested item
    }
    let mut rest = line.trim_start();
    for prefix in ["pub(crate) ", "pub(super) ", "pub(self) ", "pub ", "async ", "const ", "unsafe "] {
        while let Some(stripped) = rest.strip_prefix(prefix) {
            rest = stripped;
        }
    }
    let rest = rest.strip_prefix("fn ")?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        None
    } else {
        Some((indent, name))
    }
}

/// The source with top-level `#[cfg(test)] mod ... { ... }` blocks blanked out.
fn strip_test_modules(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    let len = lines.len();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim() == "#[cfg(test)]" {
            let mut j = i + 1;
            while j < lines.len()
                && (lines[j].trim_start().starts_with("#[") || lines[j].trim_start().starts_with("//"))
            {
                j += 1;
            }
            let is_mod = j < lines.len() && {
                let t = lines[j].trim_start();
                t.starts_with("mod ") || t.starts_with("pub mod ")
            };
            if is_mod {
                // A DECLARATION (`mod foo;`) HAS NO BODY TO SKIP, and treating
                // it as though it did blanked the whole rest of the file.
                //
                // THE HOLE, found by sabotage: `commands/data.rs` ends with ten
                // `#[cfg(test)] #[path = "..."] mod x;` declarations. None is
                // followed by a `}` at column 0, so the brace scan below ran to
                // EOF and cleared every line from the first declaration onward.
                // A product function added anywhere after them was invisible to
                // this census — a cell writer that recalculates nothing would
                // have been enumerated as not existing. The spill census's own
                // stripper never had this bug, so the two disagreed and only
                // one of them was right.
                if lines[j].trim_end().ends_with(';') {
                    for line in lines.iter_mut().take(j + 1).skip(i) {
                        line.clear();
                    }
                    i = j + 1;
                    continue;
                }
                let mut k = j;
                while k < lines.len() && lines[k] != "}" {
                    k += 1;
                }
                for line in lines.iter_mut().take((k + 1).min(len)).skip(i) {
                    line.clear();
                }
                i = k + 1;
                continue;
            }
        }
        i += 1;
    }
    lines
}

/// The census's cell-write detector is RECEIVER-AWARE for direct `cells` map
/// mutations (see `writes_cells_map`): `grid.cells.insert(..)` is a cell write,
/// `refs.cells.insert(..)` -- the reference collector -- is not. That precision
/// is what keeps the census free of false exemptions, and it is bought with an
/// assumption: a `Grid` is always held in a variable named for one.
///
/// This is the tripwire on that assumption. It enumerates every receiver in the
/// crate that reaches `.cells.insert/remove/get_mut` and fails on any spelling
/// it has not been told about. Without it, holding a `Grid` in a variable called
/// `sheet` or `target` would silently drop that function out of the census --
/// the exact failure mode the receiver check was added to avoid, reintroduced
/// one rename later and with no signal at all.
#[test]
fn every_direct_cells_map_receiver_is_a_recognised_spelling() {
    /// Receivers known NOT to be grids. Anything else must be a grid, or be
    /// added here with the reason it is not.
    const NOT_A_GRID: &[(&str, &str)] = &[
        (
            "refs",
            "ExtractedRefs: `cells` is the SET of coordinates a formula references, \
             not a sheet's contents",
        ),
        (
            "sheet",
            "`persistence::Sheet`: the SAVE-side snapshot of a sheet, not a live \
             `engine::Grid`. `apply_spill_extents_to_sheet` stamps the dynamic-array \
             extent onto cells `Sheet::from_grid` has already produced -- it writes \
             no document cell, so there is nothing to recalculate",
        ),
    ];

    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_rs_files(&src_root, &mut files);
    assert!(
        files.len() > 50,
        "only {} source files found — the walk is broken, not the crate",
        files.len()
    );

    let mut unrecognised: Vec<String> = Vec::new();
    let mut grid_receivers = 0usize;
    let mut non_grid_receivers = 0usize;

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
        for (n, line) in text.lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for method in [".cells.insert(", ".cells.remove(", ".cells.get_mut("] {
                let mut consumed = 0usize;
                while let Some(at) = line[consumed..].find(method) {
                    let abs = consumed + at;
                    let receiver = cells_receiver(&line[..abs]);
                    consumed = abs + method.len();
                    if receiver.to_lowercase().contains("grid") {
                        grid_receivers += 1;
                    } else if NOT_A_GRID.iter().any(|(r, _)| *r == receiver) {
                        non_grid_receivers += 1;
                    } else {
                        unrecognised.push(format!("{}:{} — receiver `{}`", rel, n + 1, receiver));
                    }
                }
            }
        }
    }

    assert!(
        unrecognised.is_empty(),
        "these lines mutate a `cells` map through a receiver the recalculation \
         census does not recognise:\n  {}\n\nIf it holds a `Grid`, rename it so \
         its name contains \"grid\" (the census keys on that, and every one of \
         the {} existing grid writes already reads that way). If it does NOT, \
         add it to NOT_A_GRID with the reason. Leaving it as-is silently drops \
         the enclosing function out of \
         `every_cell_writing_function_either_recalculates_or_is_exempt_with_a_reason`.",
        unrecognised.join("\n  "),
        grid_receivers
    );

    // Non-vacuity, both ways: the walk must actually be finding both kinds, or
    // this test would pass on an empty crate.
    assert!(
        grid_receivers >= 20,
        "only {} grid `cells` writes found — the scan is broken",
        grid_receivers
    );
    assert!(
        non_grid_receivers > 0,
        "no non-grid `cells` receiver found, yet NOT_A_GRID lists one: it is \
         stale, and the census's precision check is now guarding nothing"
    );
}
