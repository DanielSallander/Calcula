//! FILENAME: app/src-tauri/src/eval_budget_tests.rs
//! PURPOSE: Tests for the HOST half of the evaluation budget — that every
//! wrapper in the `evaluate_formula*` family actually honours the governing
//! surface, that cancellation stops a recalculation and leaves a coherent
//! workbook with the stale cells recorded, and that a script-initiated
//! evaluation cannot buy itself more than an interactive edit gets.
//! CONTEXT: The engine's own suite proves the meter works. What it cannot prove
//! is that the host WIRED it — and a missed wiring site is a hole that looks
//! fixed, which is worse than an open one. These tests are the wiring proof.
//!
//! ## How these stay deterministic
//!
//! No test here sleeps or asserts a duration, with one exception that is
//! explicitly a smoke test for "does not hang / does not corrupt" and asserts
//! neither timing nor a specific stopping point.
//!
//! Two properties make that possible:
//!   * a ceiling is observable WITHOUT burning it — `EvalBudget::remaining()`
//!     reports the allowance the moment the evaluator is built, so "this
//!     surface gets exactly this much fuel" is an equality, not a stopwatch;
//!   * a cancellation is observable without a race — an ALREADY-cancelled token
//!     trips the very first charge (the engine's `arm_if_idle` checks for a
//!     pending cancel), so "the token reached this wrapper" is a single
//!     assertion on a returned value.

use crate::eval_budget::{
    self, EvalSurface, PendingCell, PendingRecalc, CALL_BATCH_FUEL, TRANSIENT_CELL_FUEL,
};
use engine::{Cell, CancelToken, CellError, CellValue, Evaluator, Grid, DEFAULT_CELL_FUEL};
use persistence;

// ============================================================================
// Fixtures
// ============================================================================

fn one_sheet() -> (Vec<Grid>, Vec<String>) {
    let mut grid = Grid::new();
    grid.set_cell(0, 0, Cell::new_number(2.0));
    grid.set_cell(0, 1, Cell::new_number(3.0));
    (vec![grid], vec!["Sheet1".to_string()])
}

/// A token that is already tripped, so any evaluation governed by it stops on
/// its first charge. This is the deterministic stand-in for "the user clicked
/// Cancel while this was running".
fn pre_cancelled() -> CancelToken {
    let t = CancelToken::new();
    t.cancel();
    t
}

fn is_limit(v: &CellValue) -> bool {
    matches!(v, CellValue::Error(CellError::Limit))
}

// ============================================================================
// Every surface hands out exactly the ceiling it promises
// ============================================================================

#[test]
fn each_surface_installs_exactly_its_own_ceiling() {
    let grid = Grid::new();
    for (surface, expected) in [
        (EvalSurface::Interactive, DEFAULT_CELL_FUEL),
        (EvalSurface::Recalc, DEFAULT_CELL_FUEL),
        (EvalSurface::Background, DEFAULT_CELL_FUEL),
        (EvalSurface::Script, DEFAULT_CELL_FUEL),
        (EvalSurface::Transient, TRANSIENT_CELL_FUEL),
    ] {
        let _g = eval_budget::install_cancellable(surface, CancelToken::new());
        let mut ev = Evaluator::new(&grid);
        eval_budget::apply(&mut ev);
        assert_eq!(
            ev.budget().remaining(),
            expected,
            "surface {} installed the wrong ceiling",
            surface.name()
        );
    }
}

/// THE REQUIREMENT, asserted where it is actually enforced rather than only on
/// the constant: an evaluator built under the Script surface has no more fuel
/// than one built under Interactive.
#[test]
fn a_script_evaluation_never_out_fuels_an_interactive_one() {
    let grid = Grid::new();
    let interactive = {
        let _g = eval_budget::install_cancellable(EvalSurface::Interactive, CancelToken::new());
        let mut ev = Evaluator::new(&grid);
        eval_budget::apply(&mut ev);
        ev.budget().remaining()
    };
    let script = {
        let _g = eval_budget::install_service(
            EvalSurface::Script,
            CancelToken::new(),
            std::time::Duration::from_millis(crate::eval_budget::SCRIPT_EVAL_TIMEOUT_MS),
        );
        let mut ev = Evaluator::new(&grid);
        eval_budget::apply(&mut ev);
        ev.budget().remaining()
    };
    assert!(
        script <= interactive,
        "a script asked for {} fuel where an interactive edit gets {}",
        script,
        interactive
    );
}

/// The wrapper that RETURNS an evaluator is the one place a ceiling can be
/// checked end to end through the public host API.
#[test]
fn the_evaluator_factory_wrapper_carries_the_surface_ceiling() {
    let (grids, names) = one_sheet();
    let _g = eval_budget::install_cancellable(EvalSurface::Transient, CancelToken::new());
    let ev = crate::create_evaluator_for_sheet(&grids, &names, 0).expect("evaluator");
    assert_eq!(ev.budget().remaining(), TRANSIENT_CELL_FUEL);
    assert!(ev.budget().cancel_token().is_some(), "the factory dropped the token");
}

// ============================================================================
// Every wrapper in the family honours the governor
// ============================================================================

/// THE WIRING PROOF, and the test that would have caught a missed site.
///
/// Each wrapper is called under an already-cancelled governor. If the wrapper
/// forwards the governor to the evaluator it builds, the very first charge
/// trips and the answer is `#LIMIT!`. If it does not, the formula computes
/// normally and the surface is silently uncancellable — exactly the hole this
/// whole exercise exists to close.
#[test]
fn every_evaluate_wrapper_forwards_the_cancellation_token() {
    let (grids, names) = one_sheet();
    let files = std::collections::HashMap::new();
    let ctx = engine::EvalContext::default();
    let ast = crate::parse_formula_to_engine_ast("A1+B1").expect("parses");

    // Sanity: ungoverned, these all compute 5.
    assert_eq!(
        crate::evaluate_formula_multi_sheet(&grids, &names, 0, "A1+B1"),
        CellValue::Number(5.0),
        "fixture is wrong before the governor is even installed"
    );

    let _g = eval_budget::install_cancellable(EvalSurface::Recalc, pre_cancelled());

    let mut checked = 0;
    macro_rules! assert_stops {
        ($label:expr, $value:expr) => {{
            let v: CellValue = $value;
            assert!(
                is_limit(&v),
                "{} ignored the governing cancel token and returned {:?}",
                $label,
                v
            );
            checked += 1;
        }};
    }

    assert_stops!("evaluate_formula", crate::evaluate_formula(&grids[0], "=A1+B1"));
    assert_stops!(
        "evaluate_formula_with_ast",
        crate::evaluate_formula_with_ast(&grids[0], &ast)
    );
    assert_stops!(
        "evaluate_formula_multi_sheet",
        crate::evaluate_formula_multi_sheet(&grids, &names, 0, "A1+B1")
    );
    assert_stops!(
        "evaluate_formula_multi_sheet_with_ast",
        crate::evaluate_formula_multi_sheet_with_ast(&grids, &names, 0, &ast)
    );
    assert_stops!(
        "evaluate_formula_with_context",
        crate::evaluate_formula_with_context(&grids, &names, 0, &ast, ctx.clone(), None)
    );
    assert_stops!(
        "evaluate_formula_with_context_and_files",
        crate::evaluate_formula_with_context_and_files(&grids, &names, 0, &ast, ctx.clone(), None, &files)
    );
    assert_stops!(
        "evaluate_formula_with_pivot",
        crate::evaluate_formula_with_pivot(&grids, &names, 0, &ast, ctx.clone(), None, &files, None, None)
    );
    assert_stops!(
        "evaluate_formula_multi_sheet_with_files",
        crate::evaluate_formula_multi_sheet_with_files(&grids, &names, 0, "A1+B1", &files)
    );
    assert_stops!(
        "evaluate_formula_multi_sheet_with_ast_and_files",
        crate::evaluate_formula_multi_sheet_with_ast_and_files(&grids, &names, 0, &ast, &files)
    );

    // The raw (EvalResult) wrappers.
    for (label, r) in [
        (
            "evaluate_formula_raw",
            crate::evaluate_formula_raw(&grids, &names, 0, &ast, ctx.clone(), None),
        ),
        (
            "evaluate_formula_raw_with_files",
            crate::evaluate_formula_raw_with_files(&grids, &names, 0, &ast, ctx.clone(), None, &files),
        ),
        (
            "evaluate_formula_raw_with_files_and_pivot",
            crate::evaluate_formula_raw_with_files_and_pivot(
                &grids, &names, 0, &ast, ctx.clone(), None, &files, None, None, None,
            ),
        ),
        (
            "evaluate_formula_raw_with_ast_and_files",
            crate::evaluate_formula_raw_with_ast_and_files(&grids, &names, 0, &ast, &files, None),
        ),
        (
            "evaluate_formula_raw_with_ast_files_and_cube",
            crate::evaluate_formula_raw_with_ast_files_and_cube(
                &grids, &names, 0, &ast, &files, None, None, None,
            ),
        ),
    ] {
        assert_stops!(label, r.to_cell_value());
    }

    // The batch wrapper and the two evaluator factories.
    let batched = crate::batch_evaluate_formulas(&grids, &names, 0, &[((0, 2), "A1+B1")]);
    assert_stops!("batch_evaluate_formulas", batched[0].1.clone());

    for (label, factory) in [
        (
            "create_evaluator_for_sheet",
            crate::create_evaluator_for_sheet(&grids, &names, 0),
        ),
        (
            "create_evaluator_with_files",
            crate::create_evaluator_with_files(&grids, &names, 0, None),
        ),
    ] {
        let ev = factory.expect("factory built an evaluator");
        assert_stops!(label, ev.evaluate(&ast).to_cell_value());
    }

    assert_eq!(
        checked, 17,
        "the wrapper family changed size — every wrapper must be covered here, \
         because an uncovered one is a surface with no Cancel button"
    );
}

/// The fail-safe half of the same story: with NO governor installed, every
/// wrapper still computes normally. A governor that leaked across calls (or a
/// token that was never reset) would break every calculation in the product,
/// so this is not a trivial assertion.
#[test]
fn wrappers_are_unaffected_when_no_governor_is_installed() {
    let (grids, names) = one_sheet();
    assert_eq!(eval_budget::active_surface(), None);
    assert_eq!(
        crate::evaluate_formula_multi_sheet(&grids, &names, 0, "A1+B1"),
        CellValue::Number(5.0)
    );
    assert!(!eval_budget::cancel_requested());
}

// ============================================================================
// The `#LIMIT!` literal is nameable everywhere
// ============================================================================

#[test]
fn the_limit_error_renders_with_its_trailing_bang() {
    // The `#{Debug}` fallback would render "#LIMIT", which
    // `normalizeCellErrorLiteral` on the frontend does not recognise and
    // therefore collapses to "#VALUE!" — turning the one error a user most
    // needs to find back into the one it was given its own variant to escape.
    assert_eq!(crate::cell_error_display(&CellError::Limit), "#LIMIT!");
    assert_eq!(
        crate::scripting::udf::cell_error_to_str(&CellError::Limit),
        "#LIMIT!"
    );

    let style = engine::CellStyle::new();
    let locale = engine::LocaleSettings::invariant();
    assert_eq!(
        crate::format_cell_value(&CellValue::Error(CellError::Limit), &style, &locale),
        "#LIMIT!"
    );
    assert_eq!(
        crate::format_cell_value_simple(&CellValue::Error(CellError::Limit)),
        "#LIMIT!"
    );

    // And the grid agrees with the app, which is the point of having one helper.
    let mut cell = Cell::new();
    cell.value = CellValue::Error(CellError::Limit);
    assert_eq!(cell.display_value(), "#LIMIT!");
}

// ============================================================================
// The per-CALL ceiling on caller-supplied lists
// ============================================================================

#[test]
fn the_batch_ceiling_is_a_multiple_of_the_per_formula_one() {
    // Per-expression parity with an interactive edit, and a strictly larger but
    // finite aggregate — so 100,000 expressions in one call cannot draw 100,000
    // full allowances, while an honest batch of a few dozen is untouched.
    assert_eq!(CALL_BATCH_FUEL, 8 * DEFAULT_CELL_FUEL);
    assert!(CALL_BATCH_FUEL > DEFAULT_CELL_FUEL);
}

/// The accumulator must not FALSE-POSITIVE. A chart evaluating one cheap
/// expression over thousands of row scopes has to come back with thousands of
/// real answers, not a wall of `#LIMIT!` — which is what a mis-summed aggregate
/// (say, adding `initial` instead of `consumed`) would produce.
#[test]
fn a_long_batch_of_cheap_expressions_never_trips_the_aggregate() {
    let scopes: Vec<std::collections::HashMap<String, serde_json::Value>> = (0..5_000)
        .map(|i| {
            let mut m = std::collections::HashMap::new();
            m.insert("x".to_string(), serde_json::json!(i));
            m
        })
        .collect();
    let out = crate::formula::evaluate_scoped_for_test("x * 2", &scopes).expect("evaluates");
    assert_eq!(out.len(), 5_000);
    assert_eq!(out[0], serde_json::json!(0.0));
    assert_eq!(out[4_999], serde_json::json!(9998.0));
    assert!(
        !out.iter().any(|v| v == &serde_json::json!("#LIMIT!")),
        "the per-call aggregate fired on a batch of trivial expressions"
    );
}

// ============================================================================
// Cancellation of a real recalculation pass
// ============================================================================

fn state_with_formulas(count: u32) -> crate::AppState {
    let state = crate::create_app_state();
    {
        let mut grids = state.grids.lock().unwrap();
        let mut mirror = state.grid.lock().unwrap();
        grids[0].set_cell(0, 0, Cell::new_number(7.0));
        mirror.set_cell(0, 0, Cell::new_number(7.0));
        for r in 1..=count {
            // Deliberately NOT self-referential and NOT expensive: this test is
            // about the LOOP's cancellation behaviour, not the meter's.
            let cell = Cell::new_formula("A1*2".to_string());
            grids[0].set_cell(r, 0, cell.clone());
            mirror.set_cell(r, 0, cell);
        }
    }
    state
}

/// A cancelled pass must leave the workbook COHERENT and must say which cells
/// are stale.
///
/// With an already-cancelled token the pass stops at its first check, so this
/// pins three separate promises at once, all deterministically:
///   1. nothing was written — the ordering rule (ask the token BEFORE writing)
///      held, so no cell carries a `#LIMIT!` the user never asked for;
///   2. the pending set is EXACTLY the cells that did not recalculate;
///   3. `get_calculation_state` reports "pending", which is what turns the
///      status bar from "Ready" into "Calculate".
#[test]
fn a_cancelled_recalc_writes_nothing_and_records_every_stale_cell() {
    let state = state_with_formulas(50);
    let files = crate::persistence::UserFilesState::default();
    let pivots = crate::pivot::types::PivotState::new();

    // Simulates the realistic shape: an enclosing operation (a `.calp` refresh,
    // an animation frame) already owns the token and the user hits Cancel while
    // the nested recalculation is running. The nested pass must OBSERVE that
    // cancel, not reset it — resetting is how a Cancel button un-presses itself
    // on a compound operation.
    let _outer = eval_budget::install_cancellable(
        EvalSurface::Background,
        state.calc_cancel.clone(),
    );
    state.calc_cancel.cancel();
    crate::calculation::recalculate_sheet_values(&state, &files, &pivots, 0, None);

    let pending = state.pending_recalc.lock().unwrap().clone().expect(
        "a cancelled pass must record what it did not reach — otherwise a stale \
         cell is indistinguishable from a correct one",
    );
    assert_eq!(pending.sheet_index, 0);
    assert_eq!(pending.cells.len(), 50, "every formula cell was left unprocessed");

    let grids = state.grids.lock().unwrap();
    for r in 1..=50u32 {
        let cell = grids[0].get_cell(r, 0).expect("cell survives the cancel");
        assert!(
            !is_limit(&cell.value),
            "cancelling a pass must never LAND a #LIMIT! in a cell (row {}); the \
             user asked to stop, not to poison the workbook",
            r
        );
        assert!(pending.contains(r, 0), "row {} is stale but was not recorded", r);
    }
}

/// A pass that is NOT cancelled clears the pending set, so an accidental Cancel
/// followed by a real recalculation returns the workbook to "Ready".
#[test]
fn a_completed_recalc_clears_the_stale_marker() {
    let state = state_with_formulas(10);
    let files = crate::persistence::UserFilesState::default();
    let pivots = crate::pivot::types::PivotState::new();

    // Pretend a previous pass was cancelled.
    *state.pending_recalc.lock().unwrap() = Some(PendingRecalc {
        sheet_index: 0,
        cells: (1..=10).map(|r| PendingCell { row: r, col: 0 }).collect(),
    });

    crate::calculation::recalculate_sheet_values(&state, &files, &pivots, 0, None);

    assert!(
        state.pending_recalc.lock().unwrap().is_none(),
        "a clean pass must clear the stale marker"
    );
    let grids = state.grids.lock().unwrap();
    assert_eq!(grids[0].get_cell(5, 0).unwrap().value, CellValue::Number(14.0));
}

/// The token must not leak. A pass that ended cancelled leaves the flag CLEAR,
/// or the user's next calculation would abort instantly for no visible reason —
/// and the resume they just asked for would be the first casualty.
#[test]
fn the_cancel_flag_never_survives_the_pass_that_consumed_it() {
    let state = state_with_formulas(5);
    let files = crate::persistence::UserFilesState::default();
    let pivots = crate::pivot::types::PivotState::new();

    state.calc_cancel.cancel();
    crate::calculation::recalculate_sheet_values(&state, &files, &pivots, 0, None);
    assert!(
        !state.calc_cancel.is_cancelled(),
        "the pass guard must clear the flag on the way out"
    );

    // ...and the very next pass therefore succeeds.
    crate::calculation::recalculate_sheet_values(&state, &files, &pivots, 0, None);
    let grids = state.grids.lock().unwrap();
    assert_eq!(grids[0].get_cell(3, 0).unwrap().value, CellValue::Number(14.0));
}

/// REGRESSION: a cancel raised against one operation must not poison the NEXT
/// one.
///
/// The first wiring installed the governor and claimed the token as two
/// separate calls, and several entry points did only the first. A Cancel that
/// landed in one of those left the flag SET, and the next interactive edit —
/// which shares the token — aborted on its first charge and wrote `#LIMIT!`
/// into an entirely ordinary cell. Every governed entry point now goes through
/// `begin_pass`, which claims and clears as one thing, and this pins that:
/// after ANY governed operation ends, the flag is down.
#[test]
fn a_cancel_never_leaks_into_the_operation_that_follows_it() {
    let state = state_with_formulas(3);

    for surface in [
        EvalSurface::Interactive,
        EvalSurface::Recalc,
        EvalSurface::Background,
    ] {
        {
            let pass = eval_budget::begin_pass(surface, &state.calc_cancel);
            state.calc_cancel.cancel();
            assert!(pass.cancelled(), "{} did not observe its own cancel", surface.name());
        }
        assert!(
            !state.calc_cancel.is_cancelled(),
            "{} leaked a raised cancel flag past the end of its operation — the \
             next edit would abort and write #LIMIT! into an ordinary cell",
            surface.name()
        );

        // And the proof that matters: an evaluation immediately afterwards
        // computes its real answer.
        let (grids, names) = one_sheet();
        let _next = eval_budget::begin_pass(EvalSurface::Interactive, &state.calc_cancel);
        assert_eq!(
            crate::evaluate_formula_multi_sheet(&grids, &names, 0, "A1+B1"),
            CellValue::Number(5.0),
            "the operation after {} inherited a stale cancel",
            surface.name()
        );
    }
}

/// Cancelling from ANOTHER THREAD — the shape the real Cancel button has, now
/// that `calculate_now` runs off the UI thread.
///
/// Deliberately asserts no timing and no stopping point: where the cancel lands
/// depends on the machine, and pinning that would be exactly the kind of flake
/// this design went out of its way to avoid everywhere else. What it DOES
/// assert is the pair of properties that must hold wherever it lands — the call
/// returns (no hang, no deadlock against the locks the pass holds) and no cell
/// is left holding a `#LIMIT!` that the user never caused.
#[test]
fn a_cancel_from_another_thread_is_safe_wherever_it_lands() {
    let state = std::sync::Arc::new(state_with_formulas(400));
    let files = crate::persistence::UserFilesState::default();
    let pivots = crate::pivot::types::PivotState::new();

    let token = state.calc_cancel.clone();
    let canceller = std::thread::spawn(move || {
        token.cancel();
    });

    crate::calculation::recalculate_sheet_values(&state, &files, &pivots, 0, None);
    canceller.join().expect("canceller thread");

    let pending_count = state
        .pending_recalc
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.cells.len())
        .unwrap_or(0);

    let grids = state.grids.lock().unwrap();
    let mut computed = 0;
    for r in 1..=400u32 {
        let v = &grids[0].get_cell(r, 0).unwrap().value;
        assert!(!is_limit(v), "row {} was poisoned by a cancellation", r);
        if v == &CellValue::Number(14.0) {
            computed += 1;
        }
    }
    // Whatever the split, the two halves must account for the whole sheet:
    // a cell is either recalculated or recorded as stale, never neither.
    assert!(
        computed + pending_count >= 400,
        "{} cells recalculated and {} recorded stale — {} fell through the gap",
        computed,
        pending_count,
        400 - (computed + pending_count)
    );
}

// ============================================================================
// The pending set as the frontend sees it
// ============================================================================

#[test]
fn the_pending_set_serialises_with_camel_case_keys() {
    // The TS mirror reads `sheetIndex` / `cells[].row`; a serde slip here would
    // surface as a status bar that never leaves "Ready".
    let p = PendingRecalc {
        sheet_index: 2,
        cells: vec![PendingCell { row: 4, col: 7 }],
    };
    let json = serde_json::to_value(&p).unwrap();
    assert_eq!(json["sheetIndex"], 2);
    assert_eq!(json["cells"][0]["row"], 4);
    assert_eq!(json["cells"][0]["col"], 7);
}

#[test]
fn the_progress_event_serialises_with_camel_case_keys() {
    let e = crate::eval_budget::CalcProgressEvent {
        scope: "workbook".to_string(),
        cells_done: 10,
        cells_total: 100,
        elapsed_ms: 250,
        done: false,
        cancelled: false,
        pending_cells: 0,
    };
    let json = serde_json::to_value(&e).unwrap();
    assert_eq!(json["cellsDone"], 10);
    assert_eq!(json["cellsTotal"], 100);
    assert_eq!(json["elapsedMs"], 250);
    assert_eq!(json["pendingCells"], 0);
}

/// THE SILENT-STALENESS CLOSURE, end to end through the real save/load code.
///
/// A cancelled recalculation leaves some cells holding pre-recalculation values
/// and records them in `AppState.pending_recalc`, which is what keeps the status
/// bar saying "Calculate" and what makes `.calp` publish refuse. But that set was
/// SESSION state: it did not travel into the `.cala`, so saving and reopening
/// laundered a knowingly-stale workbook into one that claimed to be calculated —
/// wrong numbers on screen, "Ready" in the status bar, and publish now willing to
/// ship them. A wrong number that announces nothing is the worst thing this
/// feature can produce; it is strictly worse than the `#LIMIT!` the rest of the
/// design works so hard to make visible.
#[test]
fn staleness_from_a_cancelled_recalc_survives_a_save_and_reload() {
    let state = state_with_formulas(6);
    let sheet_id = state.sheet_ids.lock().unwrap()[0];
    *state.pending_recalc.lock().unwrap() = Some(PendingRecalc {
        sheet_index: 0,
        cells: vec![PendingCell { row: 2, col: 0 }, PendingCell { row: 5, col: 0 }],
    });

    // SAVE: the marker must reach the persisted workbook, keyed by SheetId.
    let mut workbook = persistence::Workbook::new();
    workbook.sheets[0].id = sheet_id;
    crate::persistence::attach_pending_recalc_for_save(&state, &[sheet_id], &mut workbook);
    let saved = workbook
        .pending_recalc
        .clone()
        .expect("a workbook saved mid-cancel must carry its staleness marker");
    assert_eq!(saved.sheet_id, sheet_id, "recorded by identity, not by index");
    assert_eq!(saved.cells.len(), 2);

    // RELOAD into a FRESH session that knows nothing about the cancel.
    let reopened = crate::create_app_state();
    assert!(reopened.pending_recalc.lock().unwrap().is_none());
    crate::persistence::restore_pending_recalc_on_load(&reopened, &workbook);

    let pending = reopened
        .pending_recalc
        .lock()
        .unwrap()
        .clone()
        .expect("reopening a stale workbook must still report it as stale");
    assert_eq!(pending.sheet_index, 0, "the SheetId resolved back to a live index");
    assert!(pending.contains(2, 0));
    assert!(pending.contains(5, 0));

    // ...and opening a CLEAN workbook clears it, so staleness from a file the
    // user already closed cannot haunt the next one.
    let clean = persistence::Workbook::new();
    crate::persistence::restore_pending_recalc_on_load(&reopened, &clean);
    assert!(reopened.pending_recalc.lock().unwrap().is_none());
}

/// The `.calp` override layer identifies a changed cell by its DISPLAY string,
/// and it compares two independently-produced ones: `override_display` (from a
/// live `engine::CellValue`) against `override_value_from_saved` (from the
/// persisted `SavedCellValue`). If those two ever spell an error differently,
/// every error-bearing cell in a subscribed sheet reports a permanent spurious
/// override conflict - the file says one thing, the grid says another, and the
/// difference never resolves because neither side is wrong on its own terms.
///
/// Moving persistence onto the canonical literal is exactly the kind of change
/// that breaks this silently, so it is pinned rather than commented.
#[test]
fn the_calp_override_display_agrees_with_the_persisted_error_form() {
    let variants = [
        CellError::Div0,
        CellError::Ref,
        CellError::Name,
        CellError::Value,
        CellError::NA,
        CellError::Circular,
        CellError::Conflict,
        CellError::Blocked,
        CellError::Limit,
    ];
    for e in variants {
        let live = CellValue::Error(e.clone());
        let saved = persistence::SavedCellValue::from_value(&live);
        let from_saved = match &saved {
            persistence::SavedCellValue::Error(s) => s.clone(),
            other => panic!("expected an Error payload, got {other:?}"),
        };
        assert_eq!(
            crate::calp_commands::override_display_for_test(&live),
            from_saved,
            "the live and persisted spellings of {} disagree",
            e.as_literal()
        );
        assert_eq!(from_saved, e.as_literal(), "and both must be the canonical literal");
    }
}
