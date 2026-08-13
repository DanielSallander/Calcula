//! FILENAME: app/src-tauri/src/autofilter_table_button_tests.rs
//! PURPOSE: BUG-0040 — a table's filter buttons and its AutoFilter are ONE state.
//! CONTEXT: A child module of `undo_commands` (declared with `#[path]` there),
//!          so it can drive the real `apply_object_swap_restore` rather than a
//!          re-implementation of it. The undo half is the point: the fix is
//!          wrong without it.
//!
//! THE DEFECT
//! ----------
//! Two actions found it: create a table, remove its filter. Save, reopen — and
//! THE FILTER IS BACK.
//!
//! Calcula kept two records of one thing:
//!
//!   * `Table.style_options.show_filter_button` — persisted, on the table;
//!   * an entry in `auto_filters` — persisted separately, in `autofilters.json`.
//!
//! `create_table` wrote both. `remove_auto_filter` cleared only the second. And
//! `Table.auto_filter_id` — the link between them — is derived state that is
//! never saved, so the load path has to reconstruct it: finding no saved filter
//! for a sheet whose table still advertised buttons, it SEEDED A NEW ONE from
//! that table. The user's deliberate removal was undone by the reopen, and the
//! document that came back was not the document that was saved.
//!
//! WHAT EXCEL DOES, WHICH SETTLES IT
//! ---------------------------------
//! Excel has a single state here: `ListObject.ShowAutoFilter`. Data ▸ Filter
//! (Ctrl+Shift+L) on a table and Table Design ▸ Filter Button are the same
//! switch, and turning it off persists. There is no Excel state in which a
//! table shows filter dropdowns but has no filter, or has a filter it does not
//! show. Under "Excel parity wins", removing the filter clears the flag.
//!
//! WHY THE SEED STAYS
//! ------------------
//! It was tempting to delete the load-path seed instead, and that is the fix
//! the bug was filed with a warning against. `load_xlsx` hard-codes
//! `user_files: HashMap::new()`, so an imported workbook NEVER has an
//! `autofilters.json` — the `show_filter_button` carried in the table metadata
//! is the only record of its filters that exists. Deleting the seed would have
//! silently stripped the filter buttons from every imported workbook. With the
//! flag now cleared on removal, the seed only ever fires for a table that still
//! says it wants buttons, which is exactly its job.

use super::*;
use crate::autofilter::AutoFilter;
use crate::persistence::FileState;
use crate::tables::{Table, TableStyleOptions};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

fn table_at(id: identity::EntityId, start_row: u32, start_col: u32, end_row: u32, end_col: u32) -> Table {
    Table {
        id,
        name: format!("Table{}", start_row),
        sheet_index: 0,
        start_row,
        start_col,
        end_row,
        end_col,
        columns: vec![],
        style_options: TableStyleOptions::default(), // show_filter_button: true
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    }
}

fn new_id() -> identity::EntityId {
    identity::EntityId::from_bytes(identity::generate_uuid_v7())
}

/// A one-sheet workbook holding one table that owns the sheet's AutoFilter —
/// the state `create_table` leaves behind.
fn state_with_filtered_table() -> (AppState, identity::EntityId) {
    let state = crate::create_app_state();
    let seed = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );

    let table_id = new_id();
    let filter = AutoFilter::new(0, 0, 2, 2);
    let filter_id = filter.id;

    let mut table = table_at(table_id, 0, 0, 2, 2);
    table.auto_filter_id = Some(filter_id);

    state.auto_filters.write(&seed).unwrap().insert(0, filter);
    let mut tables = state.tables.write(&seed).unwrap();
    tables.entry(0).or_default().insert(table_id, table);
    drop(tables);

    (state, table_id)
}

fn show_filter_button(state: &AppState, table_id: identity::EntityId) -> bool {
    state.tables.read().unwrap()[&0][&table_id]
        .style_options
        .show_filter_button
}

fn owns_filter(state: &AppState, table_id: identity::EntityId) -> bool {
    let filters = state.auto_filters.read().unwrap();
    let Some(af) = filters.get(&0) else { return false };
    state.tables.read().unwrap()[&0][&table_id].auto_filter_id == Some(af.id)
}

// ---------------------------------------------------------------------------
// Removal clears the owner's flag
// ---------------------------------------------------------------------------

#[test]
fn removing_a_tables_filter_also_clears_its_filter_button() {
    let (state, table_id) = state_with_filtered_table();
    let fs = FileState::default();
    assert!(show_filter_button(&state, table_id), "precondition");

    let result = crate::autofilter::remove_auto_filter_inner(&state, &fs);
    assert!(result.success, "{:?}", result.error);

    assert!(
        state.auto_filters.read().unwrap().get(&0).is_none(),
        "the filter itself is gone"
    );
    assert!(
        !show_filter_button(&state, table_id),
        "AND the owning table stops advertising filter buttons. While it still \
         did, the load path's seed treated it as 'a table that wants a filter \
         but has none saved' and MANUFACTURED ONE — so the removal did not \
         survive a save/reload at all."
    );
}

#[test]
fn a_table_that_did_not_own_the_filter_keeps_its_buttons() {
    // NON-VACUITY: clearing the flag on every table would pass the test above
    // and would silently disarm unrelated tables on the same sheet.
    let (state, owner_id) = state_with_filtered_table();
    let bystander_id = new_id();
    {
        let seed = crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::LoadingFromDisk,
        );
        let mut tables = state.tables.write(&seed).unwrap();
        // Far away from the filter's range, and owning nothing.
        tables
            .get_mut(&0)
            .unwrap()
            .insert(bystander_id, table_at(bystander_id, 40, 40, 42, 42));
    }

    let fs = FileState::default();
    crate::autofilter::remove_auto_filter_inner(&state, &fs);

    assert!(!show_filter_button(&state, owner_id), "the owner is cleared");
    assert!(
        show_filter_button(&state, bystander_id),
        "a table that never owned this filter must keep its own buttons"
    );
}

#[test]
fn removing_a_filter_no_table_owns_touches_no_table() {
    // A plain-range Data > Filter, with a table elsewhere on the sheet.
    let state = crate::create_app_state();
    let seed = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    let table_id = new_id();
    state
        .auto_filters
        .write(&seed)
        .unwrap()
        .insert(0, AutoFilter::new(50, 50, 52, 52));
    state
        .tables
        .write(&seed)
        .unwrap()
        .entry(0)
        .or_default()
        .insert(table_id, table_at(table_id, 0, 0, 2, 2));

    let fs = FileState::default();
    crate::autofilter::remove_auto_filter_inner(&state, &fs);

    assert!(
        show_filter_button(&state, table_id),
        "the removed filter was not this table's, so its buttons are not the \
         user's answer to this command"
    );
}

// ---------------------------------------------------------------------------
// ...and undo puts BOTH halves back
// ---------------------------------------------------------------------------

/// Without this the fix would trade one bug for another: `show_filter_button`
/// is what `relink_autofilter_owner` re-derives ownership FROM, so an undo that
/// restored the filter alone would restore an ORPHAN — a sheet filter no table
/// claims, on a table showing no buttons to clear it with.
#[test]
fn undoing_the_removal_restores_the_filter_and_the_buttons_together() {
    let (state, table_id) = state_with_filtered_table();
    let fs = FileState::default();

    // Capture the snapshot the command records, then perform the removal.
    let removed = state.auto_filters.read().unwrap().get(&0).cloned();
    crate::autofilter::remove_auto_filter_inner(&state, &fs);
    assert!(!show_filter_button(&state, table_id), "precondition for the undo");

    // Drive the REAL restore path, not a re-implementation of it.
    let snapshot = serde_json::to_vec(&AutoFilterObjSnapshot {
        sheet_index: 0,
        previous: removed,
        filter_buttons: vec![(table_id, true)],
    })
    .unwrap();

    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    let mut inverse = Transaction::new("undo");
    let mut report = RestoreReport::default();
    apply_object_swap_restore(
        &state,
        &effect,
        "obj_autofilter",
        &snapshot,
        &mut inverse,
        &mut report,
    );

    assert!(
        state.auto_filters.read().unwrap().get(&0).is_some(),
        "the filter is back"
    );
    assert!(
        show_filter_button(&state, table_id),
        "and so are the buttons — restoring one without the other is what would \
         have made the table stop owning its own filter"
    );
    assert!(
        owns_filter(&state, table_id),
        "which is the consequence that matters: ownership is DERIVED from the \
         flag, so the table only re-acquires its filter if the flag came back"
    );
}

#[test]
fn the_inverse_of_that_undo_records_the_state_it_replaced() {
    // REDO must be exact. The inverse is built from the values found at restore
    // time, so redoing the undo has to take the buttons back off again.
    let (state, table_id) = state_with_filtered_table();
    let fs = FileState::default();
    let removed = state.auto_filters.read().unwrap().get(&0).cloned();
    crate::autofilter::remove_auto_filter_inner(&state, &fs);

    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );

    // Undo.
    let undo_snapshot = serde_json::to_vec(&AutoFilterObjSnapshot {
        sheet_index: 0,
        previous: removed,
        filter_buttons: vec![(table_id, true)],
    })
    .unwrap();
    let mut inverse = Transaction::new("undo");
    let mut report = RestoreReport::default();
    apply_object_swap_restore(&state, &effect, "obj_autofilter", &undo_snapshot, &mut inverse, &mut report);
    assert!(show_filter_button(&state, table_id));

    // Redo, driven by the inverse the undo just produced.
    let redo = inverse
        .changes
        .iter()
        .find_map(|c| match c {
            CellChange::CustomRestore { kind, data } if kind == "obj_autofilter" => {
                Some(data.clone())
            }
            _ => None,
        })
        .expect("the undo must have produced an obj_autofilter inverse");

    let mut inverse2 = Transaction::new("undo");
    let mut report2 = RestoreReport::default();
    apply_object_swap_restore(&state, &effect, "obj_autofilter", &redo, &mut inverse2, &mut report2);

    assert!(
        state.auto_filters.read().unwrap().get(&0).is_none(),
        "redo removes the filter again"
    );
    assert!(
        !show_filter_button(&state, table_id),
        "and takes the buttons back off with it — an inverse that recorded no \
         buttons would leave the table advertising a filter it does not have, \
         which is the exact state the load-path seed resurrects from"
    );
}

/// A filter operation that does NOT change any table's buttons must not invent
/// button changes on undo. This is what keeps the new field from becoming a
/// second, always-on source of truth.
#[test]
fn an_ordinary_criteria_undo_carries_no_button_changes() {
    let (state, table_id) = state_with_filtered_table();
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );

    let snapshot = crate::undo_commands::autofilter_snapshot_bytes(0, Some(AutoFilter::new(0, 0, 2, 2)));
    let mut inverse = Transaction::new("undo");
    let mut report = RestoreReport::default();
    apply_object_swap_restore(&state, &effect, "obj_autofilter", &snapshot, &mut inverse, &mut report);

    assert!(
        show_filter_button(&state, table_id),
        "nothing about the buttons was recorded, so nothing about them changes"
    );
}
