//! FILENAME: app/src-tauri/src/row_visibility.rs
//! PURPOSE: Build the per-sheet row-visibility snapshot the formula engine
//!          consults for SUBTOTAL and AGGREGATE, and install it for one
//!          recalculation pass.
//! CONTEXT: SUBTOTAL/AGGREGATE are the only functions whose value depends on
//!          whether a row is VISIBLE. `engine::RowVisibility` carries the
//!          filter-hidden and manually-hidden sets separately, per sheet,
//!          because Excel's 1-11 vs 101-111 codes (and AGGREGATE's options)
//!          disagree about the second one.
//!
//! ONE NOTION OF HIDDEN. The snapshot is composed from
//! `commands::nav::hidden_row_sources_for_sheet` — the exact function
//! `collect_hidden_rows_for_sheet` (which the renderer, printing, Go To
//! Special, and the script API all use) is now defined as the union of. The
//! engine therefore cannot disagree with the grid about which rows are hidden;
//! it only gets to see the split the union throws away.
//!
//! BUILT ONCE PER PASS, NEVER PER FORMULA. `begin_pass` installs the snapshot
//! thread-locally for the duration of a recalculation, next to
//! `engine::begin_lookup_pass()`. The old design put a (sheet-blind, always
//! `None`) set on the per-cell `EvalContext`, which would have meant rebuilding
//! it — four mutex acquisitions and a set clone per sheet — for every formula
//! in the workbook.
//!
//! COST: one pass over the sheet list, four brief mutex acquisitions per sheet,
//! and a clone of sets that are empty in the overwhelming majority of
//! workbooks. A 50-sheet workbook costs ~200 uncontended lock acquisitions
//! (tens of microseconds) against a recalculation that evaluates thousands of
//! formulas. There is no per-formula cost at all: the evaluator's fast path is
//! one thread-local bool load, and `RowVisibility::is_empty()` short-circuits
//! the whole visibility walk when nothing is hidden anywhere.

use std::sync::Arc;

use crate::AppState;

/// Builds the workbook-wide row-visibility snapshot.
///
/// LOCK ORDER: takes `sheet_names` first and DROPS it, then the per-sheet
/// authority locks one at a time through `hidden_row_sources_for_sheet`
/// (user-hidden -> auto_filters -> advanced_filter_hidden_rows -> outlines).
/// It never holds a grid lock, so it is safe to call at the top of any command
/// — call it BEFORE taking long-lived grid locks, like the control-values
/// snapshot it sits beside.
pub fn build_row_visibility(state: &AppState) -> Arc<engine::RowVisibility> {
    // FAST BAIL for the workbook where nothing is hidden anywhere — the
    // overwhelming majority, and the one that must not pay for this feature.
    // Five lock acquisitions and five is_empty() checks instead of four per
    // sheet plus a set clone per sheet. `update_cell` runs this on every edit.
    if nothing_is_hidden(state) {
        return Arc::new(engine::RowVisibility::new());
    }

    let sheet_names: Vec<String> = state
        .sheet_names
        .read()
        .map(|n| n.clone())
        .unwrap_or_default();

    let mut index = engine::RowVisibility::new();
    for (sheet_index, name) in sheet_names.iter().enumerate() {
        let sources =
            crate::commands::nav::hidden_row_sources_for_sheet(state, sheet_index);
        if sources.filter_hidden.is_empty() && sources.user_hidden.is_empty() {
            continue;
        }
        index.insert(
            name,
            engine::SheetRowVisibility::new(sources.filter_hidden, sources.user_hidden),
        );
    }
    Arc::new(index)
}

/// True when NO authority hides a row on ANY sheet.
///
/// Reads the same four authorities `hidden_row_sources_for_sheet` composes, but
/// as a workbook-wide emptiness test rather than a per-sheet extraction. A
/// poisoned lock reads as "might be hidden" (false), which costs a full build
/// and never a wrong answer. Outline groups are checked by presence rather than
/// by collapsed-ness: an existing outline with everything expanded takes the
/// slow path, which is correct, just not free.
fn nothing_is_hidden(state: &AppState) -> bool {
    let user_rows_empty = state
        .user_hidden_rows
        .read()
        .map(|s| s.is_empty())
        .unwrap_or(false);
    let all_user_rows_empty = state
        .all_user_hidden_rows
        .read()
        .map(|v| v.iter().all(|s| s.is_empty()))
        .unwrap_or(false);
    let filters_empty = state
        .auto_filters
        .read()
        .map(|m| m.values().all(|af| af.hidden_rows.is_empty()))
        .unwrap_or(false);
    let advanced_empty = state
        .advanced_filter_hidden_rows
        .read()
        .map(|m| m.values().all(|v| v.is_empty()))
        .unwrap_or(false);
    let outlines_empty = state
        .outlines
        .read()
        .map(|m| m.values().all(|o| o.get_hidden_rows().is_empty()))
        .unwrap_or(false);

    user_rows_empty && all_user_rows_empty && filters_empty && advanced_empty && outlines_empty
}

/// Builds the snapshot and installs it for the current thread until the
/// returned guard drops. Call once per recalculation pass, immediately after
/// `engine::begin_lookup_pass()`.
///
/// Callers must hold no grid lock (see `build_row_visibility`).
#[must_use = "the snapshot is uninstalled when the guard drops"]
pub fn begin_pass(state: &AppState) -> engine::VisibilityPassGuard {
    engine::begin_visibility_pass(build_row_visibility(state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::dimensions::{ensure_user_hidden_len, set_rows_hidden_inner};
    use crate::persistence::FileState;
    use engine::HiddenScope;
    use std::collections::HashSet;

    /// Two-sheet workbook, sheet 0 active.
    fn two_sheet_state() -> AppState {
        let state = crate::create_app_state();
        state.grids.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::LoadingFromDisk)).unwrap().push(engine::Grid::new());
        state.sheet_names.write(&crate::document_effect::test_seed_effect()).unwrap().push("Sheet2".to_string());
        state
            .sheet_ids
            .write(&crate::document_effect::test_seed_effect())
            .unwrap()
        .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        ensure_user_hidden_len(&state, &crate::document_effect::test_seed_effect(), 2);
        state
    }

    /// Sheet1: row 1 hidden BY HAND, row 4 hidden BY AN ADVANCED FILTER.
    fn state_with_both_notions() -> AppState {
        let state = two_sheet_state();
        set_rows_hidden_inner(&state, &FileState::default(), &[1], true).unwrap();
        state
            .advanced_filter_hidden_rows
            .write(&crate::document_effect::test_seed_effect())
            .unwrap()
            .insert(0, vec![4]);
        state
    }

    #[test]
    fn snapshot_keeps_the_two_notions_apart() {
        let index = build_row_visibility(&state_with_both_notions());
        // Hand-hidden row 1: invisible to 101-111, VISIBLE to 1-11.
        assert!(index.is_hidden("SHEET1", 1, HiddenScope::FilterAndManual));
        assert!(!index.is_hidden("SHEET1", 1, HiddenScope::FilterOnly));
        // Filter-hidden row 4: invisible to both code ranges.
        assert!(index.is_hidden("SHEET1", 4, HiddenScope::FilterOnly));
        assert!(index.is_hidden("SHEET1", 4, HiddenScope::FilterAndManual));
    }

    #[test]
    fn a_sheet_with_nothing_hidden_gets_no_entry() {
        let index = build_row_visibility(&state_with_both_notions());
        assert!(index.sheet("SHEET2").is_none());
        assert!(!index.is_hidden("SHEET2", 1, HiddenScope::FilterAndManual));
        // ...and specifically does NOT inherit Sheet1's rows.
        assert!(!index.is_hidden("SHEET2", 4, HiddenScope::FilterAndManual));
    }

    #[test]
    fn an_untouched_workbook_produces_an_empty_snapshot() {
        assert!(build_row_visibility(&crate::create_app_state()).is_empty());
    }

    #[test]
    fn the_fast_bail_never_hides_a_hidden_row() {
        // The optimization is only safe if it agrees with the slow path on
        // every authority. One row hidden by ANY of them must defeat it.
        let clean = two_sheet_state();
        assert!(nothing_is_hidden(&clean));

        let by_hand = two_sheet_state();
        set_rows_hidden_inner(&by_hand, &FileState::default(), &[3], true).unwrap();
        assert!(!nothing_is_hidden(&by_hand));

        let by_filter = two_sheet_state();
        by_filter
            .advanced_filter_hidden_rows
            .write(&crate::document_effect::test_seed_effect())
            .unwrap()
            .insert(1, vec![9]);
        assert!(!nothing_is_hidden(&by_filter));

        // ...including on a NON-active sheet, whose user set lives in the
        // per-sheet vector rather than the active mirror.
        let other_sheet = two_sheet_state();
        other_sheet.all_user_hidden_rows.write(&crate::document_effect::test_seed_effect()).unwrap()[1].insert(2);
        assert!(!nothing_is_hidden(&other_sheet));
        assert!(build_row_visibility(&other_sheet)
            .is_hidden("SHEET2", 2, HiddenScope::FilterAndManual));
    }

    #[test]
    fn the_snapshot_matches_the_union_the_renderer_sees() {
        // The invariant that keeps the engine and the grid honest: the union of
        // the snapshot's two sets IS collect_hidden_rows_for_sheet's answer.
        let state = state_with_both_notions();
        let union = crate::commands::nav::collect_hidden_rows_for_sheet(&state, 0);
        let index = build_row_visibility(&state);
        let entry = index.sheet("SHEET1").expect("Sheet1 hides something");
        let mut recomposed: HashSet<u32> = entry.filter_hidden.clone();
        recomposed.extend(entry.user_hidden.iter().copied());
        assert_eq!(recomposed, union);
    }

    // ------------------------------------------------------------------
    // Recalc-on-hide: the half no dependency edge can express.
    // ------------------------------------------------------------------

    /// Sheet1 with A1=10, A2=20, A3=30 and A5 = the given formula, evaluated
    /// once so the stored value is the pre-hide answer.
    fn state_with_total(formula: &str) -> (AppState, crate::persistence::UserFilesState,
                                           crate::pivot::types::PivotState) {
        let state = crate::create_app_state();
        {
            let mut grid = state.grid.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::LoadingFromDisk)).unwrap();
            grid.set_cell(0, 0, engine::Cell::new_number(10.0));
            grid.set_cell(1, 0, engine::Cell::new_number(20.0));
            grid.set_cell(2, 0, engine::Cell::new_number(30.0));
            grid.set_cell(4, 0, engine::Cell::new_formula(formula.to_string()));
        }
        {
            let mut grids = state.grids.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::LoadingFromDisk)).unwrap();
            grids[0] = state.grid.read().unwrap().clone();
        }
        let files = crate::persistence::UserFilesState::default();
        let pivots = crate::pivot::types::PivotState::new();
        // Prime A5 with its no-hidden-rows value.
        crate::calculation::recalc_visibility_dependents_core(&state, &files, &pivots, None)
            .unwrap();
        (state, files, pivots)
    }

    fn total_at_a5(state: &AppState) -> f64 {
        match state.grid.read().unwrap().get_cell(4, 0).map(|c| c.value.clone()) {
            Some(engine::CellValue::Number(n)) => n,
            other => panic!("A5 is not a number: {:?}", other),
        }
    }

    #[test]
    fn hiding_a_row_recalculates_subtotal_109() {
        let (state, files, pivots) = state_with_total("=SUBTOTAL(109,A1:A3)");
        assert_eq!(total_at_a5(&state), 60.0, "pre-hide total");

        set_rows_hidden_inner(&state, &FileState::default(), &[1], true).unwrap();
        crate::calculation::recalc_visibility_dependents_core(&state, &files, &pivots, None)
            .unwrap();

        assert_eq!(
            total_at_a5(&state),
            40.0,
            "hiding row 2 by hand must drop it from SUBTOTAL(109, ...)"
        );
    }

    #[test]
    fn unhiding_a_row_recalculates_it_back() {
        let (state, files, pivots) = state_with_total("=SUBTOTAL(109,A1:A3)");
        set_rows_hidden_inner(&state, &FileState::default(), &[1], true).unwrap();
        crate::calculation::recalc_visibility_dependents_core(&state, &files, &pivots, None)
            .unwrap();
        assert_eq!(total_at_a5(&state), 40.0);

        set_rows_hidden_inner(&state, &FileState::default(), &[1], false).unwrap();
        crate::calculation::recalc_visibility_dependents_core(&state, &files, &pivots, None)
            .unwrap();
        assert_eq!(total_at_a5(&state), 60.0, "unhide must restore the total");
    }

    #[test]
    fn hand_hiding_leaves_subtotal_9_alone_but_a_filter_moves_it() {
        let (state, files, pivots) = state_with_total("=SUBTOTAL(9,A1:A3)");
        assert_eq!(total_at_a5(&state), 60.0);

        // Hand-hidden: code 9 INCLUDES it.
        set_rows_hidden_inner(&state, &FileState::default(), &[1], true).unwrap();
        crate::calculation::recalc_visibility_dependents_core(&state, &files, &pivots, None)
            .unwrap();
        assert_eq!(total_at_a5(&state), 60.0);

        // Filter-hidden: code 9 excludes it.
        state
            .advanced_filter_hidden_rows
            .write(&crate::document_effect::test_seed_effect())
            .unwrap()
            .insert(0, vec![1]);
        crate::calculation::recalc_visibility_dependents_core(&state, &files, &pivots, None)
            .unwrap();
        assert_eq!(total_at_a5(&state), 40.0);
    }

    #[test]
    fn aggregate_cells_are_recalculated_too() {
        let (state, files, pivots) = state_with_total("=AGGREGATE(9,5,A1:A3)");
        assert_eq!(total_at_a5(&state), 60.0);
        set_rows_hidden_inner(&state, &FileState::default(), &[2], true).unwrap();
        crate::calculation::recalc_visibility_dependents_core(&state, &files, &pivots, None)
            .unwrap();
        assert_eq!(total_at_a5(&state), 30.0);
    }

    #[test]
    fn manual_calculation_mode_suppresses_the_cascade() {
        let (state, files, pivots) = state_with_total("=SUBTOTAL(109,A1:A3)");
        *state.calculation_mode.lock().unwrap() = "manual".to_string();
        set_rows_hidden_inner(&state, &FileState::default(), &[1], true).unwrap();
        let cells =
            crate::calculation::recalc_visibility_dependents_core(&state, &files, &pivots, None)
                .unwrap();
        assert!(cells.is_empty(), "manual mode defers every dependent cascade");
        assert_eq!(total_at_a5(&state), 60.0, "value left stale on purpose");
    }

    #[test]
    fn a_workbook_without_subtotals_produces_no_seeds() {
        let state = crate::create_app_state();
        state
            .grid
            .write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::LoadingFromDisk))
            .unwrap()
            .set_cell(0, 0, engine::Cell::new_formula("=SUM(A2:A4)".to_string()));
        let files = crate::persistence::UserFilesState::default();
        let pivots = crate::pivot::types::PivotState::new();
        let cells =
            crate::calculation::recalc_visibility_dependents_core(&state, &files, &pivots, None)
                .unwrap();
        assert!(cells.is_empty());
    }

    #[test]
    fn the_pass_guard_installs_and_removes_the_snapshot() {
        let state = state_with_both_notions();
        assert!(engine::active_row_visibility().is_none());
        {
            let _guard = begin_pass(&state);
            let active = engine::active_row_visibility().expect("installed");
            assert!(active.is_hidden("SHEET1", 4, HiddenScope::FilterOnly));
        }
        assert!(engine::active_row_visibility().is_none());
    }
}
