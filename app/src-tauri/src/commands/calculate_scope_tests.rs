//! FILENAME: app/src-tauri/src/commands/calculate_scope_tests.rs
//! PURPOSE: D1 — **Calculate Now (F9) calculates the WORKBOOK; Calculate Sheet
//! (Shift+F9) calculates the ACTIVE SHEET**, which is what Excel does.
//!
//! A child module of `commands::data` (declared with `#[path]` there) so it can
//! reuse the `Workbook` harness from `cross_sheet_recalc_tests` rather than
//! copying one — a copied harness drifts, and a drifted harness is exactly how
//! the defects below stayed hidden.
//!
//! THE DEFECT THESE PIN. `calculate_now` evaluated the ACTIVE SHEET ALONE while
//! being wired to F9, to `Formulas > Calculate > Calculate Workbook`, and to the
//! calculate-before-save step. Three consequences, all of them visible:
//!
//!   1. a formula on a non-active sheet reading a changed cell simply did not
//!      recalculate — F9, the key whose entire job is "make everything current",
//!      left it stale;
//!   2. a cross-sheet ITERATIVE cycle moved NOWHERE under repeated F9. Only the
//!      half of the cycle on the active sheet was evaluated, so the other half
//!      never took its hop and the group could not converge no matter how many
//!      times the key was pressed. Measured on the running app: six presses, no
//!      movement.
//!   3. a cross-sheet CIRCULAR reference reported `#CIRCULAR!` on the sheet you
//!      were looking at and an order-dependent `0` one tab away.
//!
//! (3) was patched by stamping the off-sheet members after the pass
//! (`mark_off_sheet_circular_cells`). That patch is NOT redundant now — it is
//! what Shift+F9 still needs, because a sheet-scoped pass genuinely does not
//! evaluate the other sheets — but F9 no longer relies on it: every member is in
//! the plan, so every member is evaluated on its own sheet. Both halves are
//! pinned below.
//!
//! WHY THESE ARE RUN AND NOT READ. `calculate_now` is a `#[tauri::command]`
//! taking `State` and `Window` and cannot execute in-process, which is why F9's
//! cross-sheet behaviour used to be pinned by asserting on its SOURCE TEXT. The
//! pass body is now the plain function `run_calculation_pass`, so these drive
//! the real thing.

use super::cross_sheet_recalc_tests::{body_of, Workbook};
use crate::api_types::CellData;
use crate::calculation::{run_calculation_pass, CalcScope};
use engine::{Cell, CellError, CellValue};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

fn seed_effect() -> crate::document_effect::DocumentEffect {
    crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    )
}

/// Calculate Now — F9.
fn f9(wb: &Workbook) -> Vec<CellData> {
    run_calculation_pass(
        CalcScope::Workbook,
        None,
        &wb.state,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        None,
    )
    .expect("the workbook pass")
}

/// Calculate Sheet — Shift+F9.
fn shift_f9(wb: &Workbook) -> Vec<CellData> {
    run_calculation_pass(
        CalcScope::ActiveSheet,
        None,
        &wb.state,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        None,
    )
    .expect("the sheet pass")
}

/// Overwrite a cell's VALUE without touching dependencies and without
/// recalculating anything — the state a workbook is in when something has gone
/// stale and only a manual recalculation can fix it.
///
/// Written through the same lock order the pass itself uses (mirror, then
/// grids), so a test can never be the thing that inverts it.
fn poke_number(wb: &Workbook, sheet: usize, row: u32, col: u32, n: f64) {
    let effect = seed_effect();
    let active = *wb.state.active_sheet.read().unwrap();
    let mut mirror = wb.state.grid.write(&effect).unwrap();
    let mut grids = wb.state.grids.write(&effect).unwrap();
    grids[sheet].set_cell(row, col, Cell::new_number(n));
    if sheet == active {
        mirror.set_cell(row, col, Cell::new_number(n));
    }
}

/// Replace a FORMULA cell's cached value while leaving the formula in place —
/// the state a formula cell is in when it has not been recalculated yet.
fn stale_value(wb: &Workbook, sheet: usize, row: u32, col: u32, n: f64) {
    let effect = seed_effect();
    let active = *wb.state.active_sheet.read().unwrap();
    let mut mirror = wb.state.grid.write(&effect).unwrap();
    let mut grids = wb.state.grids.write(&effect).unwrap();
    let mut cell = grids[sheet]
        .get_cell(row, col)
        .cloned()
        .expect("a cell to make stale");
    cell.value = CellValue::Number(n);
    grids[sheet].set_cell(row, col, cell.clone());
    if sheet == active {
        mirror.set_cell(row, col, cell);
    }
}

/// `Sheet1!A1 = 6`, `Sheet2!A1 = Sheet1!A1 * 2`, sheet 0 active and everything
/// calculated. Poking Sheet1!A1 then leaves exactly one stale cell, and it is
/// on the sheet the user is NOT looking at.
fn two_sheet_chain() -> Workbook {
    let wb = Workbook::new(2);
    wb.set(0, 0, "6");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1*2");
    wb.switch_to(0);
    assert_eq!(wb.number(1, 0, 0), 12.0, "fixture is not calculated");
    wb
}

// ---------------------------------------------------------------------------
// 1. F9 = the workbook
// ---------------------------------------------------------------------------

#[test]
fn f9_recalculates_a_dependent_on_a_non_active_sheet() {
    let wb = two_sheet_chain();
    poke_number(&wb, 0, 0, 0, 10.0);
    // TEETH: the dependent is stale before the pass, so the assertion after it
    // is a change and not the state the fixture arrived in.
    assert_eq!(wb.number(1, 0, 0), 12.0, "the poke must not recalculate");

    f9(&wb);

    assert_eq!(
        wb.number(1, 0, 0),
        20.0,
        "F9 is Calculate Now and Calculate Now means the WORKBOOK — a dependent \
         one sheet away from the active one kept its pre-edit value"
    );
}

#[test]
fn shift_f9_recalculates_the_active_sheet_only() {
    let wb = two_sheet_chain();
    poke_number(&wb, 0, 0, 0, 10.0);

    shift_f9(&wb);

    assert_eq!(
        wb.number(1, 0, 0),
        12.0,
        "Shift+F9 is Calculate Sheet — it must not reach on to another sheet, or \
         the two commands are one command with two names"
    );
    // ...and F9 right after it finishes the job, so the difference is scope and
    // not an ordering accident in this fixture.
    f9(&wb);
    assert_eq!(wb.number(1, 0, 0), 20.0);
}

#[test]
fn f9_recalculates_every_sheet_not_merely_the_neighbours_of_the_active_one() {
    // Sheet3 depends on Sheet2 depends on Sheet1. The old pass evaluated one
    // sheet; a naive "active sheet plus the sheets it references" fix would
    // still leave the far end stale. The plan is a workbook-wide topological
    // order, so distance from the active sheet is not a concept.
    let wb = Workbook::new(3);
    wb.set(0, 0, "6");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1*2");
    wb.switch_to(2);
    wb.set(0, 0, "=Sheet2!A1+1");
    wb.switch_to(0);
    assert_eq!(wb.number(2, 0, 0), 13.0);

    poke_number(&wb, 0, 0, 0, 10.0);
    f9(&wb);

    assert_eq!(wb.number(1, 0, 0), 20.0, "the middle sheet");
    assert_eq!(
        wb.number(2, 0, 0),
        21.0,
        "the far sheet — reached only if the pass ordered the whole workbook, \
         because Sheet3 must be evaluated AFTER Sheet2"
    );
}

#[test]
fn f9_returns_only_the_cells_the_frontend_can_paint() {
    // The command's payload is deliberately the ACTIVE sheet's cells. Core
    // applies only cells with no sheet index (an off-sheet value must never be
    // painted onto the sheet on screen), and the frontend re-fetches the
    // viewport on every sheet switch — so serialising every formula cell in the
    // workbook on every F9 would be a cost with no reader. The off-sheet WRITES
    // still happen; they are pinned by the tests above.
    let wb = two_sheet_chain();
    // An ACTIVE-sheet formula, so "returns nothing at all" cannot pass this.
    wb.set(0, 1, "=A1*3");
    poke_number(&wb, 0, 0, 0, 10.0);

    let cells = f9(&wb);

    assert!(
        cells.iter().all(|c| c.sheet_index.is_none()),
        "a workbook pass must not return off-sheet cells the grid cannot apply"
    );
    assert!(
        cells.iter().any(|c| c.row == 0 && c.col == 1 && c.display == "30"),
        "the active sheet's own recalculated cells are still returned: {:?}",
        cells.iter().map(|c| (c.row, c.col, c.display.clone())).collect::<Vec<_>>()
    );
    assert_eq!(
        wb.number(1, 0, 0),
        20.0,
        "and the off-sheet WRITE still happened, it is merely not in the payload"
    );
}

// ---------------------------------------------------------------------------
// 2. The cross-sheet iterative cycle that moved nowhere
// ---------------------------------------------------------------------------

#[test]
fn a_cross_sheet_iterative_cycle_converges_under_f9() {
    // x = 0.5x + 10  =>  x = 20, spread across two sheets.
    //
    // THE MEASURED SYMPTOM: under the active-sheet-only pass, six F9 presses
    // moved this nowhere. A per-sheet pass iterates only the members living on
    // the sheet it is evaluating and reads the other sheet's CACHED value, so
    // the group advances at most one hop per pass — and the pass that would
    // supply the other hop was never run, because F9 only ever ran one.
    let wb = Workbook::new(2);
    *wb.state.iteration_enabled.lock().unwrap() = true;
    // Tighter than the 0.001 default, so "converged" can be asserted at 1e-6
    // instead of at the tolerance the workbook happens to ship with. 100
    // iterations (the default ceiling) is ample for a ratio of 0.5.
    *wb.state.max_change.lock().unwrap() = 1e-9;
    wb.set(0, 0, "=Sheet2!A1*0.5+10");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1");
    wb.switch_to(0);

    // Both members reset to zero — the formulas stay — so the assertions are
    // about THESE passes and not about whatever the edit path already did.
    stale_value(&wb, 0, 0, 0, 0.0);
    stale_value(&wb, 1, 0, 0, 0.0);

    // TEETH: repeated SHEET passes must NOT converge it, which is the defect
    // restated as an assertion. Six, the number measured on the running app.
    for _ in 0..6 {
        shift_f9(&wb);
    }
    let stalled = wb.number(1, 0, 0);
    assert!(
        (stalled - 20.0).abs() > 1e-6,
        "the sheet-scoped pass converged the cross-sheet cycle on its own \
         ({stalled}); this test then proves nothing about the workbook pass"
    );

    f9(&wb);

    for (sheet, label) in [(0usize, "Sheet1!A1"), (1usize, "Sheet2!A1")] {
        let v = wb.number(sheet, 0, 0);
        assert!(
            (v - 20.0).abs() < 1e-6,
            "{label} = {v}: one F9 must converge a cross-sheet iterative cycle, \
             because the whole cycle is ONE group of ONE workbook-wide plan"
        );
    }
}

#[test]
fn f9_never_writes_circular_while_iteration_is_enabled() {
    // The negative half, stated on its own so a regression that reports
    // #CIRCULAR! under iteration fails loudly rather than as a convergence
    // assertion. Iterative calculation is a SUPPORTED feature; a deliberate
    // circular reference under it must converge, not error.
    let wb = Workbook::new(2);
    *wb.state.iteration_enabled.lock().unwrap() = true;
    wb.set(0, 0, "=Sheet2!A1");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1");
    wb.switch_to(0);

    f9(&wb);

    for (sheet, label) in [(0usize, "Sheet1!A1"), (1usize, "Sheet2!A1")] {
        assert!(
            !matches!(wb.value(sheet, 0, 0), CellValue::Error(CellError::Circular)),
            "{label} reported #CIRCULAR! with iterative calculation ENABLED"
        );
    }
}

// ---------------------------------------------------------------------------
// 3. The cross-sheet circular reference, and what became of its patch
// ---------------------------------------------------------------------------

#[test]
fn f9_reports_a_cross_sheet_cycle_on_every_sheet_that_owns_a_member() {
    // The `#CIRCULAR!` here / plausible `0` one tab away defect. Under the
    // workbook pass this needs no separate marking step: both members are in
    // the plan's circular group, so both are written by the ordinary
    // iteration-disabled branch, on their own sheets.
    let wb = Workbook::new(2);
    wb.set(0, 0, "=Sheet2!A1");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1");
    wb.switch_to(0);

    f9(&wb);

    for (sheet, label) in [(0usize, "Sheet1!A1"), (1usize, "Sheet2!A1")] {
        assert!(
            matches!(wb.value(sheet, 0, 0), CellValue::Error(CellError::Circular)),
            "{label} is {:?}; a cycle is a WORKBOOK-level fact and half of one \
             reported as a number is worse than either half reported as an error",
            wb.value(sheet, 0, 0)
        );
    }
}

#[test]
fn shift_f9_still_needs_the_off_sheet_mark() {
    // Why `mark_off_sheet_circular_cells` survives the change. A SHEET pass
    // genuinely does not evaluate the other sheets, so without the mark the
    // off-sheet member keeps whatever number the previous evaluation order left
    // behind — which is the original defect, now reachable only through
    // Shift+F9.
    let wb = Workbook::new(2);
    wb.set(0, 0, "=Sheet2!A1");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1");
    wb.switch_to(0);

    shift_f9(&wb);

    for (sheet, label) in [(0usize, "the sheet Shift+F9 evaluated"), (1usize, "the sheet it did not")] {
        assert!(
            matches!(wb.value(sheet, 0, 0), CellValue::Error(CellError::Circular)),
            "{label}: {:?}",
            wb.value(sheet, 0, 0)
        );
    }
}

#[test]
fn a_layered_workbook_is_left_alone_by_both_scopes() {
    // The false-positive guard. The sheet-level projection used by the
    // cross-sheet detector is an over-approximation: this fixture has a CYCLIC
    // projection and no cell cycle at all, and it is an entirely ordinary
    // layered workbook. Reporting a cycle here would be far worse than the bug.
    let build = || {
        let wb = Workbook::new(2);
        wb.set(0, 0, "5");
        wb.set(0, 1, "=Sheet2!B1");
        wb.switch_to(1);
        wb.set(0, 0, "=Sheet1!A1");
        wb.set(0, 1, "7");
        wb.switch_to(0);
        wb
    };

    let a = build();
    f9(&a);
    assert_eq!(a.number(1, 0, 0), 5.0, "F9: Sheet2!A1 is still a number");
    assert_eq!(a.number(0, 0, 1), 7.0, "F9: Sheet1!B1 is still a number");

    let b = build();
    shift_f9(&b);
    assert_eq!(b.number(1, 0, 0), 5.0, "Shift+F9: Sheet2!A1 is still a number");
    assert_eq!(b.number(0, 0, 1), 7.0, "Shift+F9: Sheet1!B1 is still a number");
}

// ---------------------------------------------------------------------------
// 4. Determinism
// ---------------------------------------------------------------------------

#[test]
fn the_workbook_plan_is_stable_across_runs() {
    // The plan's ready set is a min-heap, not a FIFO seeded from a HashMap, so
    // two runs over the same workbook agree. The soak and regression oracles
    // compare recalc results across runs; an order that depends on hash
    // iteration makes an independent-cell tie look like a change.
    let values = || {
        let wb = Workbook::new(3);
        for col in 0..8u32 {
            wb.set(0, col, &format!("{}", col + 1));
        }
        wb.switch_to(1);
        for col in 0..8u32 {
            wb.set(0, col, &format!("=Sheet1!{}1*2", (b'A' + col as u8) as char));
        }
        wb.switch_to(2);
        for col in 0..8u32 {
            wb.set(0, col, &format!("=Sheet2!{}1+1", (b'A' + col as u8) as char));
        }
        wb.switch_to(0);
        f9(&wb);
        (0..3)
            .flat_map(|s| (0..8u32).map(move |c| (s, c)))
            .map(|(s, c)| wb.number(s, 0, c))
            .collect::<Vec<_>>()
    };
    assert_eq!(values(), values(), "two identical workbooks recalculated differently");
}

// ---------------------------------------------------------------------------
// 5. Wiring the two commands and the save path cannot lose silently
// ---------------------------------------------------------------------------

const CALCULATION_RS: &str = include_str!("../calculation.rs");
const PERSISTENCE_RS: &str = include_str!("../persistence.rs");

#[test]
fn the_two_commands_ask_for_the_two_different_scopes() {
    // The commands themselves take `State` and `Window` and cannot run here.
    // What can be checked is that they still name DIFFERENT scopes — the whole
    // defect was two commands sharing one behaviour, and it re-appears the
    // moment one of these constants is copy-pasted into the other.
    let now = body_of(CALCULATION_RS, "calculate_now");
    assert!(
        now.contains("CalcScope::Workbook"),
        "Calculate Now (F9) must run the WORKBOOK scope, as Excel's F9 does"
    );
    let sheet = body_of(CALCULATION_RS, "calculate_sheet");
    assert!(
        sheet.contains("CalcScope::ActiveSheet"),
        "Calculate Sheet (Shift+F9) must run the ACTIVE-SHEET scope"
    );
    assert!(
        !sheet.contains("CalcScope::Workbook"),
        "`calculate_sheet` delegated to `calculate_now` for years on a comment \
         that predated multi-sheet workbooks; it must not do so again"
    );
}

#[test]
fn calculate_before_save_recalculates_the_workbook() {
    // EXCEL PARITY, and the decision recorded rather than inherited: Excel
    // recalculates the WORKBOOK before saving. Saving a partly-calculated file
    // is the silent-staleness hazard `PendingRecalc` exists to make visible —
    // and `.calp` publish, which hard-refuses on a pending set, is downstream of
    // exactly this file. So save calls the workbook pass.
    let save = body_of(PERSISTENCE_RS, "save_file");
    assert!(
        save.contains("calculation::calculate_now("),
        "calculate-before-save must run the WORKBOOK pass (calculate_now); a \
         sheet pass would save a file whose other sheets are stale"
    );
}

// ---------------------------------------------------------------------------
// 6. The benchmark  (`cargo test -- --ignored --nocapture bench_calculate`)
// ---------------------------------------------------------------------------

/// Seed `rows` chained formula cells in column A of `sheet`, each reading the
/// one above, plus an optional cross-sheet root. Written straight into the grid
/// (no undo, no dependency bookkeeping) because the point is to build a big
/// workbook quickly, and the pass rebuilds what it needs from the ASTs.
fn seed_chain(wb: &Workbook, sheet: usize, rows: u32, root: Option<&str>) {
    let effect = seed_effect();
    let active = *wb.state.active_sheet.read().unwrap();
    let mut mirror = wb.state.grid.write(&effect).unwrap();
    let mut grids = wb.state.grids.write(&effect).unwrap();
    for row in 0..rows {
        let cell = if row == 0 {
            match root {
                Some(formula) => Cell::new_formula(formula.to_string()),
                None => Cell::new_number(1.0),
            }
        } else {
            Cell::new_formula(format!("A{}+1", row))
        };
        grids[sheet].set_cell(row, 0, cell.clone());
        if sheet == active {
            mirror.set_cell(row, 0, cell);
        }
    }
}

/// Rebuild the ACTIVE sheet's AppState dependency maps, which the sheet-scoped
/// plan orders by. Without this a directly-seeded fixture would give the sheet
/// pass no ordering at all and flatter numbers than it deserves.
fn rebuild_active_dependencies(wb: &Workbook) {
    crate::undo_commands::rebuild_all_dependencies(&wb.state);
}

#[test]
#[ignore = "benchmark; run with --ignored --nocapture"]
fn bench_calculate_scopes() {
    use std::time::Instant;

    fn time(label: &str, cells: usize, mut run: impl FnMut()) {
        run(); // warm: first pass pays for cold caches and cold branch history
        let started = Instant::now();
        run();
        let elapsed = started.elapsed();
        eprintln!(
            "{label:<44} {cells:>8} cells   {:>9.1} ms   {:>8.2} us/cell",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1e6 / cells.max(1) as f64,
        );
    }

    eprintln!("\n=== D1 recalculation benchmark =====================================");

    // A. ONE sheet. Both scopes evaluate exactly the same cells, so the
    //    difference is the PLANNER and nothing else: this is the honest answer
    //    to "did making F9 workbook-wide slow down the ordinary case".
    {
        const ROWS: u32 = 40_000;
        let wb = Workbook::new(1);
        seed_chain(&wb, 0, ROWS, None);
        rebuild_active_dependencies(&wb);
        eprintln!("\n-- A. single sheet, {ROWS} chained formulas (identical work) --");
        time("   Shift+F9  (sheet scope)", ROWS as usize, || {
            shift_f9(&wb);
        });
        time("   F9        (workbook scope)", ROWS as usize, || {
            f9(&wb);
        });
    }

    // B. EIGHT sheets. The scope difference itself: what F9 used to do (one
    //    sheet) against what it now does (all of them).
    {
        const SHEETS: usize = 8;
        const ROWS: u32 = 5_000;
        let wb = Workbook::new(SHEETS);
        seed_chain(&wb, 0, ROWS, None);
        for sheet in 1..SHEETS {
            seed_chain(&wb, sheet, ROWS, Some(&format!("Sheet{}!A{}", sheet, ROWS)));
        }
        rebuild_active_dependencies(&wb);
        eprintln!("\n-- B. {SHEETS} sheets x {ROWS} chained formulas, sheets chained end-to-end --");
        time("   Shift+F9  (sheet scope = the OLD F9)", ROWS as usize, || {
            shift_f9(&wb);
        });
        time("   F9        (workbook scope = the NEW F9)", SHEETS * ROWS as usize, || {
            f9(&wb);
        });
    }

    eprintln!("====================================================================\n");
}
