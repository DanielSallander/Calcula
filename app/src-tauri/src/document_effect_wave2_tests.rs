//! FILENAME: app/src-tauri/src/document_effect_wave2_tests.rs
//! PURPOSE: Pin the dirty-flag contract for the second wave of onboarded commands
//!          (autofilter.rs, commands/print.rs, calculation.rs).
//!
//! WHY THESE TESTS EXIST. The bug these guard against is SILENT: a mutating command
//! that never sets `is_modified` produces no error, no log line and no visible symptom
//! until the user closes the window, gets no prompt, and the work is gone -- and
//! AutoRecover, which gates on the same flag, declined to snapshot it either. Nothing
//! in a normal test suite notices that.
//!
//! WHAT IS COVERED, AND WHY THIS SHAPE. 80-odd commands cannot each have a test, so the
//! selection targets SYSTEMATIC mistakes rather than individual commands -- one test per
//! distinct way the whole batch could be wrong:
//!
//!   1. POSITIVE   -- a mutation dirties at all (the 256-command defect itself).
//!   2. ORDERING   -- a REFUSED call leaves the document clean. This is the contract
//!                    most at risk from a mechanical fix, because `DocumentEffect::mutates`
//!                    sets the flag in its CONSTRUCTOR: paste it at the top of a command
//!                    that can still fail its protection gate and every refusal now
//!                    dirties. A prompt that fires for work never done is how users learn
//!                    to dismiss the prompt, which costs more than the original bug.
//!   3. CONDITIONAL-- a call that resolves to a genuine no-op does not dirty.
//!   4. REFUSAL BRANCH -- the "nothing here to act on" arm of a conditional command.
//!
//! Each is exercised through the file that has the most commands sharing that shape, so a
//! regression in the shared idiom is caught once for the whole family:
//! `autofilter.rs` (12 commands, wrapper + `_inner`, protection-gated) and
//! `commands/print.rs` (13 commands, validate-then-write).
//!
//! The off-sheet Find and Replace paths are pinned next to their own behaviour tests in
//! `commands/off_sheet_tests.rs` instead, where the fixtures already exist.

use crate::autofilter::{
    apply_auto_filter_inner, clear_advanced_filter_hidden_rows_inner, reapply_auto_filter_inner,
    set_advanced_filter_hidden_rows_inner, ApplyAutoFilterParams,
};
use crate::calculation::clear_pending_recalc_impl;
use crate::commands::print::set_print_area_impl;
use crate::eval_budget::{PendingCell, PendingRecalc};
use crate::persistence::FileState;
use crate::{create_app_state, AppState};
use engine::{Cell, CellValue};

fn dirty(fs: &FileState) -> bool {
    fs.is_dirty()
}

/// A one-sheet workbook with a small header + data block for the filter to bite on.
fn seeded_state() -> AppState {
    let state = create_app_state();
    {
        // Harness seeding, not a document edit: the fixture stands in for a workbook
        // that was loaded, and no save follows. Same arm the integration harness uses.
        let effect = crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::LoadingFromDisk,
        );
        let mut grids = state.grids.write(&effect).unwrap();
        let grid = &mut grids[0];
        grid.set_cell(0, 0, Cell::new_text("Region".to_string()));
        grid.set_cell(1, 0, Cell::new_text("North".to_string()));
        grid.set_cell(2, 0, Cell::new_text("South".to_string()));
    }
    state
}

fn protect_sheet(state: &AppState, sheet: usize) {
    state.sheet_protection.write(&crate::document_effect::test_seed_effect()).unwrap().insert(
        sheet,
        crate::protection::SheetProtection { protected: true, ..Default::default() },
    );
}

fn filter_params() -> ApplyAutoFilterParams {
    ApplyAutoFilterParams {
        start_row: 0,
        start_col: 0,
        end_row: 2,
        end_col: 0,
        column_index: None,
        criteria: None,
    }
}

// ---------------------------------------------------------------------------
// 1. POSITIVE -- the mutation dirties
// ---------------------------------------------------------------------------

#[test]
fn applying_an_autofilter_marks_the_workbook_dirty() {
    let state = seeded_state();
    let fs = FileState::default();
    assert!(!dirty(&fs), "a fresh document starts clean");

    let result = apply_auto_filter_inner(&state, &fs, filter_params());

    assert!(result.success, "the filter should apply: {:?}", result.error);
    // AutoFilter state round-trips as user_files/autofilters.json and its hidden rows
    // are folded into the persisted Sheet::hidden_rows, so this changes what a save
    // writes. Before this change none of the 12 commands here took a FileState at all.
    assert!(dirty(&fs), "applying an AutoFilter must dirty the workbook");
}

#[test]
fn setting_advanced_filter_hidden_rows_marks_the_workbook_dirty() {
    let state = seeded_state();
    let fs = FileState::default();

    set_advanced_filter_hidden_rows_inner(&state, &fs, vec![1, 2]);

    // A separate persisted authority from auto_filters: persistence.rs unions these
    // into Sheet::hidden_rows at save time.
    assert!(dirty(&fs), "hiding rows via Advanced Filter must dirty the workbook");
}

// ---------------------------------------------------------------------------
// 2. ORDERING -- a refusal must leave the document clean
// ---------------------------------------------------------------------------

#[test]
fn an_autofilter_refused_by_sheet_protection_leaves_the_document_clean() {
    let state = seeded_state();
    protect_sheet(&state, 0);
    let fs = FileState::default();

    let result = apply_auto_filter_inner(&state, &fs, filter_params());

    assert!(!result.success, "a protected sheet must refuse AutoFilter");
    // THE ORDERING CONTRACT, and the one most likely to be broken by a mechanical
    // "add the flag everywhere" fix. `DocumentEffect::mutates` sets is_modified in its
    // constructor, so it must be built AFTER `check_sheet_action`, never at the top of
    // the command. Placed wrongly, every refused gesture leaves a workbook that offers
    // to save changes it does not have.
    assert!(
        !dirty(&fs),
        "a refused AutoFilter must not dirty the workbook"
    );
}

#[test]
fn an_invalid_print_area_is_refused_and_leaves_the_document_clean() {
    let state = seeded_state();
    let fs = FileState::default();

    // start > end: rejected before anything is written.
    let err = set_print_area_impl(&state, &fs, 10, 0, 2, 0);

    assert!(err.is_err(), "an inverted range must be refused");
    assert!(!dirty(&fs), "a refused print area must not dirty the workbook");
}

#[test]
fn setting_a_print_area_marks_the_workbook_dirty() {
    let state = seeded_state();
    let fs = FileState::default();

    let range = set_print_area_impl(&state, &fs, 0, 0, 9, 5).expect("valid range");

    assert_eq!(range, "A1:F10");
    // page_setups is copied into Sheet::page_setup by enrich_workbook_metadata, so the
    // print area is saved -- it was previously lost at close with no prompt.
    assert!(dirty(&fs), "setting a print area must dirty the workbook");
    assert_eq!(
        state.page_setups.read().unwrap()[0].print_area,
        "A1:F10",
        "and the value must actually be stored"
    );
}

// ---------------------------------------------------------------------------
// 3. CONDITIONAL -- a genuine no-op must not dirty
// ---------------------------------------------------------------------------

#[test]
fn clearing_advanced_filter_rows_that_were_never_set_does_not_dirty() {
    let state = seeded_state();
    let fs = FileState::default();

    clear_advanced_filter_hidden_rows_inner(&state, &fs);

    // This runs on every advanced-filter teardown, including workbooks where no rows
    // were ever hidden. Dirtying unconditionally would make merely opening and closing
    // such a workbook prompt to save.
    assert!(
        !dirty(&fs),
        "clearing an empty advanced-filter set changes nothing and must not dirty"
    );
}

#[test]
fn clearing_advanced_filter_rows_that_were_set_does_dirty() {
    let state = seeded_state();
    let fs = FileState::default();
    set_advanced_filter_hidden_rows_inner(&state, &fs, vec![1]);
    crate::document_effect::mark_saved(&fs); // isolate the clear

    clear_advanced_filter_hidden_rows_inner(&state, &fs);

    assert!(dirty(&fs), "clearing rows that WERE hidden is a real change");
}

// ---------------------------------------------------------------------------
// 4. REFUSAL BRANCH -- "nothing here to act on"
// ---------------------------------------------------------------------------

#[test]
fn reapplying_an_autofilter_when_none_exists_does_not_dirty() {
    let state = seeded_state();
    let fs = FileState::default();

    let result = reapply_auto_filter_inner(&state, &fs);

    assert!(!result.success, "there is no filter to reapply");
    // The `else` arm of the get_mut: it reports "No AutoFilter exists for this sheet"
    // and mutates nothing, so the effect must live inside the Some arm.
    assert!(!dirty(&fs), "a no-op reapply must not dirty the workbook");
}

// ---------------------------------------------------------------------------
// The census "unclear" call: clear_pending_recalc
// ---------------------------------------------------------------------------

#[test]
fn clearing_a_pending_recalc_marker_dirties_only_when_there_was_one() {
    let state = seeded_state();
    let fs = FileState::default();

    // Nothing pending: a no-op.
    assert!(!clear_pending_recalc_impl(&state, &fs));
    assert!(!dirty(&fs), "clearing an absent marker changes nothing");

    // With a marker: pending_recalc IS persisted (attach_pending_recalc_for_save /
    // restore_pending_recalc_on_load), and discarding it is an explicit human claim
    // that the stale cells no longer matter -- exactly what the close prompt protects.
    *state.pending_recalc.lock().unwrap() = Some(PendingRecalc {
        sheet_index: 0,
        cells: vec![PendingCell { row: 1, col: 0 }],
    });
    assert!(clear_pending_recalc_impl(&state, &fs));
    assert!(dirty(&fs), "discarding a real staleness marker must dirty the workbook");
}

// ---------------------------------------------------------------------------
// Guard against a silent regression in the seeded fixture itself
// ---------------------------------------------------------------------------

#[test]
fn the_fixture_really_has_filterable_data() {
    // If this ever stops holding, `applying_an_autofilter_marks_the_workbook_dirty`
    // could pass for the wrong reason (a refusal that happens to be clean is NOT what
    // that test means to assert).
    let state = seeded_state();
    let grids = state.grids.read().unwrap();
    assert_eq!(
        grids[0].get_cell(0, 0).map(|c| c.value.clone()),
        Some(CellValue::Text("Region".to_string()))
    );
}
