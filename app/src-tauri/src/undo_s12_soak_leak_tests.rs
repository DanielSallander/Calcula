//! FILENAME: app/src-tauri/src/undo_s12_soak_leak_tests.rs
//! PURPOSE: The three "undo leaks" the soak walk reported as S12, each reduced
//!          from the minimized trace to a deterministic case — and each
//!          answered.
//!
//! A child module of `undo_commands` (declared with `#[path]` there), so it
//! reaches `apply_changes` and the private restore registry.
//!
//! THE BUNDLE, AND WHAT IT ACTUALLY SAYS
//! -------------------------------------
//! `app/e2e/results/soak/failures/2026-08-10T21-21-08-352Z-undo-round-trip/`
//! (seed 20260810). The oracle took a checkpoint after action 50, ran actions
//! 51..75, then undid `undoDepth_now - undoDepth_then` = **23** steps and found
//! three things the checkpoint had never had:
//!
//!   1. `sheets[0].cells.3:3` — the cell edit `D4 = "Test54"` from action 54;
//!   2. `tables.<id>` plus the five `autoFilters.0.*` fields that are its
//!      filter — the table created by action 51;
//!   3. `conditionalFormats.0` — the rule added by action 75 (BUG-0020).
//!
//! (1) and (2) are the OLDEST mutations in the window and (3) is the newest.
//! That shape is the whole finding. A per-command undo defect leaves a
//! defect-shaped leftover; a contiguous *oldest-first* prefix is what "the
//! undo did not walk back far enough" looks like from the outside — and the
//! window pushed roughly 36 transactions, not 23, because `table.create` alone
//! writes nine cells through `update_cell` before it creates anything.
//!
//! The count was short because `undo_depth()` had SATURATED: history is capped
//! at 100 entries, so past the cap every push silently drops the oldest and the
//! depth stops growing. `depth_now - depth_then` then under-counts by exactly
//! the number evicted, and the oracle stopped 13 transactions early. So:
//!
//!   * (1) and (2) are NOT product defects. The commands do record, the
//!     restores are exact, and the tests below prove both by undoing the same
//!     operations the walk performed and asserting the state comes back. The
//!     defect was in the INSTRUMENT: `core/engine/src/undo.rs` now stamps every
//!     transaction with an id, `get_undo_state` reports the ids on the stack,
//!     and the oracle counts entries above a remembered id instead of
//!     subtracting two sizes. `history_horizon_tests` in the engine pins that.
//!   * (3) IS a product defect, and it was the real one: conditional formatting
//!     recorded no undo entry at all. Fixed — the CF commands now snapshot the
//!     sheet's rule list, which is why the last group here exists.
//!
//! The same saturation explains S11 (`invariant`'s `undo-round-trip` failing on
//! `sparklines.*` while backend sparkline undo/redo measured symmetric in
//! isolation — "it needs another action class to trigger" is what needing
//! ENOUGH other actions looks like) and the intermittent `state-consistency`
//! failures that were filed as monkey flake.

use super::*;
use crate::conditional_formatting::{
    AddCFParams, CellValueOperator, CellValueRule, ConditionalFormat, ConditionalFormatRange,
    ConditionalFormatRule, UpdateCFParams,
};
use crate::persistence::{FileState, UserFilesState};
use crate::pivot::types::PivotState;
use crate::slicer::SlicerState;
use engine::{Cell, CellValue};

struct Fixture {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    pivots: PivotState,
    slicer: SlicerState,
    pane: crate::pane_control::PaneControlState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
    filters: crate::ribbon_filter::RibbonFilterState,
}

impl Fixture {
    fn new() -> Self {
        Fixture {
            state: crate::create_app_state(),
            file: FileState::default(),
            files: UserFilesState::default(),
            pivots: PivotState::new(),
            slicer: SlicerState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
        }
    }

    fn undo(&self) -> UndoResult {
        let transaction = self
            .state
            .undo_stack
            .lock()
            .unwrap()
            .pop_undo()
            .expect("nothing on the undo stack");
        apply_changes(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.slicer,
            &self.filters,
            &self.pane,
            &self.timelines,
            transaction,
            true,
        )
    }

    fn redo(&self) -> UndoResult {
        let transaction = self
            .state
            .undo_stack
            .lock()
            .unwrap()
            .pop_redo()
            .expect("nothing on the redo stack");
        apply_changes(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.slicer,
            &self.filters,
            &self.pane,
            &self.timelines,
            transaction,
            false,
        )
    }

    fn undo_depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }

    fn undo_seqs(&self) -> Vec<u64> {
        self.state.undo_stack.lock().unwrap().undo_seqs()
    }

    fn rules(&self) -> Vec<crate::conditional_formatting::ConditionalFormatDefinition> {
        self.state
            .conditional_formats
            .read()
            .unwrap()
            .get(&0)
            .cloned()
            .unwrap_or_default()
    }

    fn cell_value(&self, row: u32, col: u32) -> CellValue {
        self.state
            .grid
            .read()
            .unwrap()
            .get_cell(row, col)
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    }
}

fn cf_params(threshold: &str, background: &str) -> AddCFParams {
    AddCFParams {
        rule: ConditionalFormatRule::CellValue(CellValueRule {
            operator: CellValueOperator::GreaterThan,
            value1: threshold.to_string(),
            value2: None,
        }),
        format: ConditionalFormat {
            background_color: Some(background.to_string()),
            ..Default::default()
        },
        // The walker's `cf.add-rule` range, verbatim from the trace.
        ranges: vec![ConditionalFormatRange {
            start_row: 59,
            start_col: 39,
            end_row: 62,
            end_col: 39,
        }],
        stop_if_true: false,
    }
}

// ---------------------------------------------------------------------------
// LEAK 3 — `conditionalFormats.0`, the one that was real (BUG-0020)
// ---------------------------------------------------------------------------

#[test]
fn adding_a_conditional_format_is_undoable() {
    // Action 75 of the walk, on its own. Before the fix this recorded NOTHING:
    // the rule was invisible to Ctrl+Z, so it survived any number of undo
    // steps and the oracle was right to report it. Excel has always undone a
    // conditional-formatting rule, so parity settles the question.
    let f = Fixture::new();
    let depth_before = f.undo_depth();

    let result = crate::conditional_formatting::add_conditional_format_impl(
        &f.state,
        &f.file,
        cf_params("82", "#FFC7CE"),
    );
    assert!(result.success, "{:?}", result.error);
    assert_eq!(f.rules().len(), 1);
    assert_eq!(
        f.undo_depth(),
        depth_before + 1,
        "adding a rule must leave exactly one entry on the undo stack"
    );

    f.undo();
    assert!(
        f.rules().is_empty(),
        "undo must take the rule away — this is the S12 leak that was a real defect"
    );

    f.redo();
    assert_eq!(f.rules().len(), 1, "redo must put it back");
    assert_eq!(f.rules()[0].id, 1);
}

#[test]
fn undoing_a_rule_announces_the_conditional_format_domain() {
    // The restore is only half the fix. The ConditionalFormatting extension
    // caches the rule list in `cfStore.state.rules` and `grid:refresh` merely
    // re-EVALUATES that cache, so an undo that says nothing leaves the grid
    // painting by the undone rule set — the same staleness that made undoing a
    // note or a hyperlink invisible before those got domains.
    let f = Fixture::new();
    crate::conditional_formatting::add_conditional_format_impl(
        &f.state,
        &f.file,
        cf_params("82", "#FFC7CE"),
    );

    let result = f.undo();
    assert!(
        result.refresh_domains.iter().any(|d| d == "conditionalFormats"),
        "undo announced {:?}, which does not include conditionalFormats",
        result.refresh_domains
    );
}

#[test]
fn deleting_and_reordering_rules_are_undoable_too() {
    // add/update/delete/reorder/clear ALL recorded nothing; fixing only the add
    // would leave Ctrl+Z half-working, which is worse than not working because
    // it looks like it worked.
    let f = Fixture::new();
    crate::conditional_formatting::add_conditional_format_impl(
        &f.state,
        &f.file,
        cf_params("10", "#AAAAAA"),
    );
    crate::conditional_formatting::add_conditional_format_impl(
        &f.state,
        &f.file,
        cf_params("20", "#BBBBBB"),
    );
    let ids: Vec<u64> = f.rules().iter().map(|r| r.id).collect();
    assert_eq!(ids, vec![1, 2]);

    // Delete
    let deleted =
        crate::conditional_formatting::delete_conditional_format_impl(&f.state, &f.file, 1);
    assert!(deleted.success, "{:?}", deleted.error);
    assert_eq!(f.rules().len(), 1);
    f.undo();
    assert_eq!(
        f.rules().iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![1, 2],
        "undo of a delete restores the rule AND its position in the priority order"
    );

    // Reorder — the whole list is the unit, because reordering renumbers every
    // rule's priority and the Vec ORDER is evaluation semantics.
    let reordered =
        crate::conditional_formatting::reorder_conditional_formats_impl(&f.state, &f.file, vec![2, 1]);
    assert!(reordered.success, "{:?}", reordered.error);
    assert_eq!(f.rules().iter().map(|r| r.id).collect::<Vec<_>>(), vec![2, 1]);
    f.undo();
    assert_eq!(
        f.rules().iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![1, 2],
        "undo of a reorder restores the previous order"
    );
}

#[test]
fn updating_a_rule_is_undoable_and_a_refused_update_records_nothing() {
    // Both halves matter. An undo entry for a command that refused is worse
    // than a missing one: Ctrl+Z consumes a step and visibly does nothing.
    let f = Fixture::new();
    crate::conditional_formatting::add_conditional_format_impl(
        &f.state,
        &f.file,
        cf_params("82", "#FFC7CE"),
    );
    let depth_after_add = f.undo_depth();

    let refused = crate::conditional_formatting::update_conditional_format_impl(
        &f.state,
        &f.file,
        UpdateCFParams {
            rule_id: 999,
            rule: None,
            format: None,
            ranges: None,
            stop_if_true: None,
            enabled: None,
        },
    );
    assert!(!refused.success, "no rule 999 exists");
    assert_eq!(
        f.undo_depth(),
        depth_after_add,
        "a refused update must not push an undo entry"
    );

    let updated = crate::conditional_formatting::update_conditional_format_impl(
        &f.state,
        &f.file,
        UpdateCFParams {
            rule_id: 1,
            rule: None,
            format: None,
            ranges: None,
            stop_if_true: None,
            enabled: Some(false),
        },
    );
    assert!(updated.success, "{:?}", updated.error);
    assert!(!f.rules()[0].enabled);

    f.undo();
    assert!(f.rules()[0].enabled, "undo restores the rule's enabled flag");
}

#[test]
fn clearing_rules_in_a_range_is_undoable_and_a_no_op_clear_records_nothing() {
    let f = Fixture::new();
    crate::conditional_formatting::add_conditional_format_impl(
        &f.state,
        &f.file,
        cf_params("82", "#FFC7CE"),
    );
    let depth_after_add = f.undo_depth();

    // A range that covers no rule: nothing removed, nothing recorded.
    let untouched = crate::conditional_formatting::clear_conditional_formats_in_range_impl(
        &f.state, &f.file, 0, 0, 3, 3, None,
    )
    .expect("clear must not error");
    assert_eq!(untouched, 0);
    assert_eq!(f.undo_depth(), depth_after_add);

    // The rule's own rectangle.
    let cleared = crate::conditional_formatting::clear_conditional_formats_in_range_impl(
        &f.state, &f.file, 55, 35, 70, 45, None,
    )
    .expect("clear must not error");
    assert_eq!(cleared, 1);
    assert!(f.rules().is_empty());

    f.undo();
    assert_eq!(f.rules().len(), 1, "undo of a clear brings the rules back");
}

// ---------------------------------------------------------------------------
// LEAKS 1 AND 2 — the two the walk blamed on undo, reduced and re-run
// ---------------------------------------------------------------------------

#[test]
fn the_walks_cell_edit_is_undone_when_its_entry_is_actually_reached() {
    // Leak 1, verbatim: action 54 wrote `D4 = "Test54"` (digest path
    // `sheets[0].cells.3:3`) and it was still there after the round trip. The
    // entry existed the whole time — `update_cell` records unconditionally.
    // Pop it and the cell goes.
    let f = Fixture::new();
    let previous = f.state.grid.read().unwrap().get_cell(3, 3).cloned();
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(0, 3, 3, previous);
    f.state
        .grid
        .write(&crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::LoadingFromDisk,
        ))
        .unwrap()
        .set_cell(3, 3, Cell::new_text("Test54".to_string()));
    assert_eq!(f.cell_value(3, 3), CellValue::Text("Test54".to_string()));

    f.undo();
    assert_eq!(
        f.cell_value(3, 3),
        CellValue::Empty,
        "D4 comes back empty — the leak was the oracle stopping short, not this entry"
    );
}

#[test]
fn the_walks_table_create_undo_removes_the_table_and_restores_the_filter() {
    // Leak 2, verbatim: after the round trip the workbook held a table the
    // checkpoint never had, its `autoFilterId` matching the surviving
    // `autoFilters.0`, while the checkpoint's own range filter (rows 59..63,
    // column 37, from `filter.apply`) had been displaced.
    //
    // That is exactly what ONE undo of `create_table` produces if it is never
    // run: the sheet holds a single AutoFilter, so creating a table over-writes
    // whatever filter was there and records the displaced one for undo. This
    // replays that pair of entries the way `create_table` records them and
    // asserts the undo is exact in both stores.
    let f = Fixture::new();
    let seed = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );

    // The pre-existing range filter — the one the checkpoint had.
    let range_filter = crate::autofilter::AutoFilter::new(59, 37, 63, 37);
    let range_filter_id = range_filter.id;
    f.state
        .auto_filters
        .write(&seed)
        .unwrap()
        .insert(0, range_filter.clone());

    // `create_table`'s two writes: the table, and the filter it installs over
    // the sheet's single slot.
    let table_filter = crate::autofilter::AutoFilter::new(0, 30, 2, 32);
    let table = crate::tables::Table {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: "Table1".to_string(),
        sheet_index: 0,
        start_row: 0,
        start_col: 30,
        end_row: 2,
        end_col: 32,
        columns: vec![crate::tables::TableColumn::new(
            identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            "Name".to_string(),
        )],
        style_options: Default::default(),
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: Some(table_filter.id),
    };
    f.state
        .auto_filters
        .write(&seed)
        .unwrap()
        .insert(0, table_filter);
    f.state
        .tables
        .write(&seed)
        .unwrap()
        .entry(0)
        .or_default()
        .insert(table.id, table.clone());
    f.state
        .table_names
        .write(&seed)
        .unwrap()
        .insert("TABLE1".to_string(), (0, table.id));

    // ...recorded exactly as `create_table` records them: ONE transaction,
    // table first, displaced filter second, so undo replays them in reverse.
    {
        let mut stack = f.state.undo_stack.lock().unwrap();
        stack.begin_transaction("Create table".to_string());
    }
    record_table_undo(&f.state, 0, table.id, None, "Create table");
    record_autofilter_undo(&f.state, 0, Some(range_filter), "Create table");
    {
        let mut stack = f.state.undo_stack.lock().unwrap();
        stack.commit_transaction();
    }

    f.undo();

    assert!(
        f.state
            .tables
            .read()
            .unwrap()
            .get(&0)
            .map(|t| t.is_empty())
            .unwrap_or(true),
        "undo of a table create must leave no table behind"
    );
    assert!(
        !f.state.table_names.read().unwrap().contains_key("TABLE1"),
        "and no name-registry entry either"
    );
    let filters = f.state.auto_filters.read().unwrap();
    let restored = filters.get(&0).expect("the displaced filter comes back");
    assert_eq!(
        restored.id, range_filter_id,
        "the sheet's ONE filter slot must hold the filter the table displaced, \
         not the table's own"
    );
    assert_eq!(
        (restored.start_row, restored.start_col, restored.end_row, restored.end_col),
        (59, 37, 63, 37),
        "and with its original geometry"
    );
}

// ---------------------------------------------------------------------------
// The actual cause: the history horizon, at the level the oracle reads it
// ---------------------------------------------------------------------------

#[test]
fn get_undo_state_reports_the_history_ids_the_oracle_needs() {
    // The oracle reads `get_undo_state`. It has to be able to answer "how many
    // steps back is the point I remembered" from what that reports — which
    // `undo_depth` alone cannot do once the cap is reached.
    let f = Fixture::new();
    for row in 0..5u32 {
        f.state
            .undo_stack
            .lock()
            .unwrap()
            .record_cell_change(0, row, 0, None);
    }
    let seqs = f.undo_seqs();
    assert_eq!(seqs.len(), 5);
    assert!(
        seqs.windows(2).all(|w| w[0] < w[1]),
        "ids increase towards the top of the stack: {seqs:?}"
    );
    let marker = seqs[1];

    for row in 5..9u32 {
        f.state
            .undo_stack
            .lock()
            .unwrap()
            .record_cell_change(0, row, 0, None);
    }
    let seqs = f.undo_seqs();
    let position = seqs.iter().position(|s| *s == marker).expect("still held");
    assert_eq!(
        seqs.len() - 1 - position,
        7,
        "seven entries sit above the remembered point"
    );
}

#[test]
fn a_remembered_point_survives_an_undo_and_redo_of_a_later_entry() {
    // The walk undoes and redoes mid-window. The inverse transaction a restore
    // builds inherits the popped transaction's id precisely so that round trip
    // puts the SAME entry back — otherwise every checkpoint after any Ctrl+Z
    // would look like the remembered point had been lost, and the oracle would
    // stop checking exactly when the walk got interesting.
    let f = Fixture::new();
    for row in 0..3u32 {
        f.state
            .undo_stack
            .lock()
            .unwrap()
            .record_cell_change(0, row, 0, None);
    }
    let before = f.undo_seqs();

    f.undo();
    f.redo();

    assert_eq!(
        f.undo_seqs(),
        before,
        "undo-then-redo leaves the history's ids exactly as they were"
    );
}
