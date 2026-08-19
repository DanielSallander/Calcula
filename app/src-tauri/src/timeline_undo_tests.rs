//! FILENAME: app/src-tauri/src/timeline_undo_tests.rs
//! PURPOSE: A timeline slicer survives undo AND redo — including when it dies as
//!          collateral in a pivot cascade.
//! CONTEXT: BUG-0103 consequence 2. Until 2026-08-19 a timeline had no restore
//!          arm at all, justified in `object_deps.rs` on the grounds that
//!          `TimelineSlicerState` "is not persisted and has no restore arm at
//!          all, so there is nothing to record INTO". Persistence landed first,
//!          which turned that from a tidy gap into real data loss: deleting a
//!          timeline destroyed an object the file was now expected to carry.
//!
//! WHAT THESE ASSERT THAT A NAIVE VERSION WOULD NOT. The easy mistake in an undo
//! arm is to restore correctly and record NOTHING for the inverse — undo then
//! works once and redo silently does nothing. Every case below therefore drives
//! the full cycle and asserts the state after BOTH halves, which is the only way
//! the missing-inverse bug shows up.

use crate::document_effect::{CleanReason, DocumentEffect};
use crate::timeline_slicer::{TimelineLevel, TimelineSlicer, TimelineSlicerState, TimelineSourceType};

fn load_effect() -> DocumentEffect {
    DocumentEffect::deliberately_clean(CleanReason::LoadingFromDisk)
}

fn timeline(name: &str, source: identity::EntityId) -> TimelineSlicer {
    TimelineSlicer {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: name.to_string(),
        header_text: None,
        sheet_index: 0,
        x: 10.0,
        y: 20.0,
        width: 350.0,
        height: 100.0,
        source_type: TimelineSourceType::Pivot,
        source_id: source,
        field_name: "OrderDate".to_string(),
        level: TimelineLevel::Months,
        selection_start: None,
        selection_end: None,
        show_header: true,
        show_level_selector: true,
        show_scrollbar: true,
        style_preset: "TimelineStyleLight1".to_string(),
        connected_pivot_ids: vec![],
    }
}

/// Serialize the payload the way the commands do, so the test exercises the real
/// wire shape rather than a hand-built struct that could drift from it.
fn snapshot_bytes(id: identity::EntityId, tl: &TimelineSlicer) -> Vec<u8> {
    #[derive(serde::Serialize)]
    struct S<'a> {
        timeline_id: identity::EntityId,
        previous: &'a TimelineSlicer,
    }
    serde_json::to_vec(&S { timeline_id: id, previous: tl }).unwrap()
}

fn create_bytes(id: identity::EntityId) -> Vec<u8> {
    #[derive(serde::Serialize)]
    struct S {
        timeline_id: identity::EntityId,
    }
    serde_json::to_vec(&S { timeline_id: id }).unwrap()
}

#[test]
fn undoing_a_delete_puts_the_timeline_back_and_redo_removes_it_again() {
    let state = TimelineSlicerState::new();
    let e = load_effect();
    let tl = timeline("Order Date", identity::EntityId::from_bytes(identity::generate_uuid_v7()));
    let id = tl.id;

    // The delete already happened; the transaction carries how to reverse it.
    let data = snapshot_bytes(id, &tl);
    let mut inverse = engine::Transaction::new("undo");
    crate::undo_commands::testing::apply_timeline_delete_restore(&state, &e, &data, &mut inverse);

    let back = state.timelines.read().unwrap();
    assert!(back.contains_key(&id), "undo did not restore the deleted timeline");
    assert_eq!(back[&id].name, "Order Date");
    assert_eq!(back[&id].width, 350.0, "the restored object is not the one deleted");
    drop(back);

    // REDO. The inverse must have been recorded, or redo is a silent no-op —
    // the half of an undo arm that is easiest to forget and hardest to notice.
    let redo = inverse
        .changes
        .iter()
        .find_map(|c| match c {
            engine::CellChange::CustomRestore { kind, data } if kind == "timeline_slicer_create" => {
                Some(data.clone())
            }
            _ => None,
        })
        .expect("undoing a delete recorded no inverse, so redo does nothing");
    let mut inverse2 = engine::Transaction::new("redo");
    crate::undo_commands::testing::apply_timeline_create_restore(&state, &e, &redo, &mut inverse2);
    assert!(
        !state.timelines.read().unwrap().contains_key(&id),
        "redo did not remove the timeline again"
    );
}

#[test]
fn undoing_a_create_removes_it_and_redo_brings_back_the_SAME_object() {
    let state = TimelineSlicerState::new();
    let e = load_effect();
    let tl = timeline("Ship Date", identity::EntityId::from_bytes(identity::generate_uuid_v7()));
    let id = tl.id;
    state.timelines.write(&e).unwrap().insert(id, tl.clone());

    let mut inverse = engine::Transaction::new("undo");
    crate::undo_commands::testing::apply_timeline_create_restore(
        &state,
        &e,
        &create_bytes(id),
        &mut inverse,
    );
    assert!(
        !state.timelines.read().unwrap().contains_key(&id),
        "undoing a create left the timeline in place"
    );

    // Redo must restore the WHOLE object, not just an id — a create-undo that
    // recorded only the id would bring back an empty husk.
    let redo = inverse
        .changes
        .iter()
        .find_map(|c| match c {
            engine::CellChange::CustomRestore { kind, data } if kind == "timeline_slicer_delete" => {
                Some(data.clone())
            }
            _ => None,
        })
        .expect("undoing a create recorded no inverse");
    let mut inverse2 = engine::Transaction::new("redo");
    crate::undo_commands::testing::apply_timeline_delete_restore(&state, &e, &redo, &mut inverse2);

    let back = state.timelines.read().unwrap();
    let got = back.get(&id).expect("redo did not re-create the timeline");
    assert_eq!(got.name, "Ship Date");
    assert_eq!(got.field_name, "OrderDate");
    assert_eq!(got.style_preset, "TimelineStyleLight1");
}

#[test]
fn undoing_an_edit_restores_the_previous_value_and_redo_reapplies_it() {
    let state = TimelineSlicerState::new();
    let e = load_effect();
    let mut tl = timeline("Dates", identity::EntityId::from_bytes(identity::generate_uuid_v7()));
    let id = tl.id;
    let before = tl.clone();

    // The edit already happened.
    tl.level = TimelineLevel::Days;
    tl.selection_start = Some("2026-03-01".to_string());
    state.timelines.write(&e).unwrap().insert(id, tl);

    let mut inverse = engine::Transaction::new("undo");
    crate::undo_commands::testing::apply_timeline_restore(
        &state,
        &e,
        &snapshot_bytes(id, &before),
        &mut inverse,
    );
    {
        let m = state.timelines.read().unwrap();
        assert_eq!(m[&id].level, TimelineLevel::Months, "undo did not restore the level");
        assert!(m[&id].selection_start.is_none(), "undo did not clear the selection");
    }

    // Redo must re-apply the EDITED value — so the inverse has to carry the
    // post-edit state, captured before the overwrite.
    let redo = inverse
        .changes
        .iter()
        .find_map(|c| match c {
            engine::CellChange::CustomRestore { kind, data } if kind == "timeline_slicer" => {
                Some(data.clone())
            }
            _ => None,
        })
        .expect("undoing an edit recorded no inverse");
    let mut inverse2 = engine::Transaction::new("redo");
    crate::undo_commands::testing::apply_timeline_restore(&state, &e, &redo, &mut inverse2);
    let m = state.timelines.read().unwrap();
    assert_eq!(m[&id].level, TimelineLevel::Days, "redo did not re-apply the edit");
    assert_eq!(m[&id].selection_start.as_deref(), Some("2026-03-01"));
}

#[test]
fn a_cascade_records_its_timelines_BEFORE_the_caller_records_the_pivot() {
    // Order is load-bearing and invisible at runtime until someone presses
    // Ctrl+Z: entries replay in REVERSE, so a timeline recorded AFTER its pivot
    // would be restored FIRST — pointing at a pivot that does not exist yet.
    let mut stack = engine::UndoStack::new();
    stack.begin_transaction("Delete pivot");

    let pivot_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let cascade = crate::object_deps::SourceCascade {
        deleted_timelines: vec![timeline("Dates", pivot_id)],
        ..Default::default()
    };
    crate::object_deps::record_source_cascade_undo_into(&mut stack, &cascade);
    // ...and only now the caller's own pivot entry.
    stack.record_custom_restore("pivot_delete".to_string(), vec![1, 2, 3], "Restore pivot");
    stack.commit_transaction();

    let tx = stack.pop_undo().expect("nothing recorded");
    let kinds: Vec<&str> = tx
        .changes
        .iter()
        .filter_map(|c| match c {
            engine::CellChange::CustomRestore { kind, .. } => Some(kind.as_str()),
            _ => None,
        })
        .collect();
    let tl_at = kinds.iter().position(|k| *k == "timeline_slicer_delete");
    let pv_at = kinds.iter().position(|k| *k == "pivot_delete");
    assert!(tl_at.is_some(), "the cascade recorded no timeline restore");
    assert!(pv_at.is_some(), "fixture precondition: the pivot entry is missing");
    assert!(
        tl_at < pv_at,
        "the timeline restore must be recorded BEFORE the pivot's, so that on \
         reverse replay the pivot exists again before the timeline that points \
         at it. Got: {kinds:?}"
    );
}
