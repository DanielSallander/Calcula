//! FILENAME: app/src-tauri/src/calp_refresh_pivot_tests.rs
//! PURPOSE: A refresh ADOPTS the publisher's pivots — §2.z, owner decision
//! 2026-09-13 — so a pivot added, deleted or re-laid-out in v2 actually reaches
//! the subscriber.
//!
//! CONTEXT: `calp_refresh_apply` materialized twelve kinds out of the pull
//! result and never read `pull_result.pivot_definitions`. The ledger merge then
//! carried the v1 pivot rows forward verbatim, so the subscriber kept v1's
//! definitions for ever and nothing in the preview or the result said so.
//!
//! WHY *ADOPT* RATHER THAN "KEEP THE SUBSCRIBER'S", because the friendlier-
//! sounding option is the dangerous one: `PivotField.source_index` is a source
//! COLUMN ORDINAL and `source_start`/`source_end` are stored coordinates, so a
//! v2 that inserts a source column leaves the v1 definition aimed at the old
//! ordinal and the old rectangle — and the cache is rebuilt confidently against
//! the new data. "You keep your layout" quietly becomes "you keep a wrong
//! number". `calp_reset_subscription` already adopts wholesale, so the two
//! surfaces disagreed in silence.
//!
//! These tests drive `apply_refreshed_pivots` directly rather than a whole
//! publish/pull/refresh cycle: the defect was never in the transport, it was
//! that nothing read the payload, and a test that exercises the adopting
//! function is the one that fails if that stops being true.

use std::collections::{HashMap, HashSet};

use crate::document_effect::{test_seed_effect, DocumentEffect};
use crate::pivot::types::PivotState;
use crate::AppState;

/// Two sheets: "Data" (seeded with a tiny table) and "Report" (the pivot's
/// destination). Sheet 0 is active, matching a real workbook.
fn two_sheet_state() -> AppState {
    let state = crate::create_app_state();
    let e = test_seed_effect();
    {
        let mut data = engine::Grid::new();
        // header row + two rows, the shape `build_cache_from_grid` expects.
        data.set_cell(0, 0, engine::cell::Cell::new_text("Region".to_string()));
        data.set_cell(0, 1, engine::cell::Cell::new_text("Amount".to_string()));
        data.set_cell(1, 0, engine::cell::Cell::new_text("North".to_string()));
        data.set_cell(1, 1, engine::cell::Cell::new_number(10.0));
        data.set_cell(2, 0, engine::cell::Cell::new_text("South".to_string()));
        data.set_cell(2, 1, engine::cell::Cell::new_number(20.0));
        *state.grid.write(&e).unwrap() = data.clone();
        let mut grids = state.grids.write(&e).unwrap();
        grids.clear();
        grids.push(data);
        grids.push(engine::Grid::new());
    }
    {
        let mut names = state.sheet_names.write(&e).unwrap();
        names.clear();
        names.push("Data".to_string());
        names.push("Report".to_string());
    }
    {
        let mut ids = state.sheet_ids.write(&e).unwrap();
        while ids.len() < 2 {
            ids.push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        }
    }
    {
        let mut widths = state.all_column_widths.write(&e).unwrap();
        while widths.len() < 2 {
            widths.push(HashMap::new());
        }
        let mut heights = state.all_row_heights.write(&e).unwrap();
        while heights.len() < 2 {
            heights.push(HashMap::new());
        }
        let mut merged = state.all_merged_regions.write(&e).unwrap();
        while merged.len() < 2 {
            merged.push(HashSet::new());
        }
    }
    state
}

/// A grid-sourced pivot definition, as a publisher would ship it: source on
/// "Data", output on "Report".
/// Built by SERIALIZING a real `PivotDefinition` rather than by hand-writing
/// JSON. The first draft hand-wrote camelCase keys, `PivotDefinition` is
/// snake_case on the wire, and every definition silently failed to deserialize —
/// the tests then failed for a fixture reason while claiming the product reason,
/// which is the most expensive kind of red. Going through the real type also
/// means a field added to `PivotDefinition` cannot leave this fixture behind.
fn saved_pivot(
    id: identity::EntityId,
    destination_sheet: &str,
    destination: (u32, u32),
) -> persistence::SavedPivotDefinition {
    use pivot_engine::{AggregationType, PivotDefinition, PivotField, ValueField};
    let mut def = PivotDefinition::new(id, (0, 0), (2, 1));
    def.name = Some("Revenue by region".to_string());
    def.source_has_headers = true;
    def.source_sheet = Some("Data".to_string());
    def.destination_sheet = Some(destination_sheet.to_string());
    def.destination = destination;
    def.row_fields.push(PivotField::new(0, "Region".to_string()));
    def.value_fields
        .push(ValueField::new(1, "Amount".to_string(), AggregationType::Sum));
    persistence::SavedPivotDefinition {
        id,
        source_type: "grid".to_string(),
        source_sheet_index: Some(0),
        definition: serde_json::to_value(&def).unwrap(),
    }
}

fn effect() -> DocumentEffect {
    test_seed_effect()
}

#[test]
fn a_v2_pivot_reaches_the_subscriber() {
    // THE DEFECT ITSELF. Before §2.z nothing read `pull_result.pivot_definitions`
    // on refresh, so this pivot never existed on the subscriber's side.
    let state = two_sheet_state();
    let pivot_state = PivotState::new();
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let defs = vec![saved_pivot(id, "Report", (0, 0))];
    let mut ledger = Vec::new();

    crate::calp_commands::apply_refreshed_pivots(
        &effect(),
        &state,
        &pivot_state,
        &defs,
        &[],
        &HashMap::new(),
        &HashMap::new(),
        &HashSet::new(),
        Some(&mut ledger),
    );

    assert!(
        pivot_state.pivot_tables.read().unwrap().contains_key(&id),
        "the refreshed pivot definition never reached PivotState — the subscriber \
         is still on v1, which is the whole of §2.z",
    );
    assert_eq!(
        ledger.iter().filter(|o| o.kind == "pivot").count(),
        1,
        "the pivot was adopted but not ledgered, so the merge would carry no row \
         for it and Application Explorer would not report the application as \
         providing it",
    );
}

#[test]
fn a_pivot_the_publisher_DELETED_in_v2_is_withdrawn() {
    // Adopt means REPLACE. A definition left behind keeps rendering and keeps
    // being reported as provided by the application.
    let state = two_sheet_state();
    let pivot_state = PivotState::new();
    let gone = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let kept = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    // v1 shipped both.
    crate::calp_commands::apply_refreshed_pivots(
        &effect(),
        &state,
        &pivot_state,
        &[saved_pivot(gone, "Report", (0, 0)), saved_pivot(kept, "Report", (20, 0))],
        &[],
        &HashMap::new(),
        &HashMap::new(),
        &HashSet::new(),
        None,
    );
    assert!(pivot_state.pivot_tables.read().unwrap().contains_key(&gone));

    // v2 ships only one of them, and the ledger says both were ours.
    let previously: HashSet<String> = [gone.to_string(), kept.to_string()].into_iter().collect();
    crate::calp_commands::apply_refreshed_pivots(
        &effect(),
        &state,
        &pivot_state,
        &[saved_pivot(kept, "Report", (20, 0))],
        &[],
        &HashMap::new(),
        &HashMap::new(),
        &previously,
        None,
    );

    let tables = pivot_state.pivot_tables.read().unwrap();
    assert!(
        !tables.contains_key(&gone),
        "a pivot the publisher deleted in v2 is still here; it will keep \
         rendering v1's numbers under an application that no longer ships it",
    );
    assert!(tables.contains_key(&kept), "the surviving pivot was withdrawn too");
}

#[test]
fn only_this_applications_pivots_are_withdrawn() {
    // THE LINE THAT MATTERS FOR SAFETY. `previously_provided` is this
    // subscription's own ledger, so a pivot the SUBSCRIBER built — or one
    // another application provides — is keyed by its own id and must survive a
    // refresh that ships neither.
    let state = two_sheet_state();
    let pivot_state = PivotState::new();
    let theirs = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let mine = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    crate::calp_commands::apply_refreshed_pivots(
        &effect(),
        &state,
        &pivot_state,
        &[saved_pivot(theirs, "Report", (0, 0)), saved_pivot(mine, "Report", (20, 0))],
        &[],
        &HashMap::new(),
        &HashMap::new(),
        &HashSet::new(),
        None,
    );

    // v2 ships nothing, and the ledger claims only `theirs`.
    let previously: HashSet<String> = [theirs.to_string()].into_iter().collect();
    crate::calp_commands::apply_refreshed_pivots(
        &effect(),
        &state,
        &pivot_state,
        &[],
        &[],
        &HashMap::new(),
        &HashMap::new(),
        &previously,
        None,
    );

    let tables = pivot_state.pivot_tables.read().unwrap();
    assert!(!tables.contains_key(&theirs), "the application's own pivot survived a v2 that dropped it");
    assert!(
        tables.contains_key(&mine),
        "a refresh deleted a pivot this application never provided — the \
         subscriber's own work, or another application's, destroyed by an \
         unrelated update",
    );
}

#[test]
fn a_renamed_sheet_does_not_send_the_pivot_to_the_subscribers_own() {
    // A v2-ADDED sheet that collides is renamed on arrival ("Report" ->
    // "Report (2)"), and both of the pivot's anchors are sheet NAMES. Without
    // the remap the publisher's pivot writes its whole output over the
    // subscriber's own same-named sheet. The rename map has to be captured
    // BEFORE the collision pass, because that pass rewrites the name in place.
    let state = two_sheet_state();
    {
        let e = test_seed_effect();
        state.sheet_names.write(&e).unwrap().push("Report (2)".to_string());
        state.grids.write(&e).unwrap().push(engine::Grid::new());
        state.all_column_widths.write(&e).unwrap().push(HashMap::new());
        state.all_row_heights.write(&e).unwrap().push(HashMap::new());
        state.all_merged_regions.write(&e).unwrap().push(HashSet::new());
        state.sheet_ids.write(&e).unwrap().push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
    }
    let pivot_state = PivotState::new();
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let mut rename = HashMap::new();
    rename.insert("Report".to_string(), "Report (2)".to_string());

    crate::calp_commands::apply_refreshed_pivots(
        &effect(),
        &state,
        &pivot_state,
        &[saved_pivot(id, "Report", (0, 0))],
        &[],
        &HashMap::new(),
        &rename,
        &HashSet::new(),
        None,
    );

    let tables = pivot_state.pivot_tables.read().unwrap();
    let (def, _cache) = tables.get(&id).expect("pivot was not adopted at all");
    assert_eq!(
        def.destination_sheet.as_deref(),
        Some("Report (2)"),
        "the pivot still points at 'Report' — on a refresh that renamed the \
         publisher's sheet, that is the SUBSCRIBER's sheet, and the pivot's \
         output would be written over it",
    );
}

#[test]
fn a_destination_this_workbook_does_not_have_is_skipped_not_written_to_sheet_zero() {
    // The `.unwrap_or(0)` trap, which on the pull path once wrote a pivot's
    // whole output over whatever the subscriber's first sheet happened to be.
    let state = two_sheet_state();
    let pivot_state = PivotState::new();
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    crate::calp_commands::apply_refreshed_pivots(
        &effect(),
        &state,
        &pivot_state,
        &[saved_pivot(id, "A Sheet That Is Not Here", (0, 0))],
        &[],
        &HashMap::new(),
        &HashMap::new(),
        &HashSet::new(),
        None,
    );

    assert!(
        !pivot_state.pivot_tables.read().unwrap().contains_key(&id),
        "a pivot naming an absent destination was adopted anyway",
    );
    // Sheet 0 still holds exactly the source table it was seeded with.
    let grids = state.grids.read().unwrap();
    assert_eq!(
        grids[0].get_cell(0, 0).map(|c| c.display_value()),
        Some("Region".to_string()),
        "the skipped pivot wrote over sheet 0 — the exact failure the \
         case-insensitive-resolve-or-skip rule exists to prevent",
    );
}

// ===========================================================================
// The WIRING, which none of the tests above can see
// ===========================================================================
//
// Every test above calls `apply_refreshed_pivots` directly, so all five stay
// green if the ONE call in `calp_refresh_apply` is deleted — and §2.z was
// never a bug in the adopting code, it was that nothing called any. That is
// the same asymmetry the wedge guard had (`wedgeGuardWired.test.ts`): a guard
// that is correct and unwired is decorative, and its absence is silent.

/// `calp_commands.rs` as text, for the wiring facts below.
fn calp_commands_src() -> String {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/calp_commands.rs"),
    )
    .expect("calp_commands.rs must be readable")
}

/// The same file with `//` line comments stripped.
///
/// NOT decoration. The first draft of the wiring test below counted raw text,
/// and commenting the call out — the obvious way a refactor removes it — left
/// the count unchanged, because the commented line still contains the call's
/// spelling. This repo has the same defect on record one layer over: a `word(`
/// inside a comment fabricated a call edge in the store census. A textual guard
/// must be handed the CODE, not the prose about it.
fn calp_commands_code() -> String {
    calp_commands_src()
        .lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn calp_refresh_apply_actually_calls_the_adopter() {
    let src = calp_commands_code();
    let calls = src.matches("apply_refreshed_pivots(").count();
    assert!(
        calls >= 2,
        "expected the definition AND at least one call site; found {} occurrence(s) \
         of `apply_refreshed_pivots(`. If this is 1, the adopter exists and nothing \
         invokes it — which is exactly the shape §2.z was: twelve kinds \
         materialized out of the pull result and pivots simply never read.",
        calls
    );
}

#[test]
fn the_ledger_merge_no_longer_carries_pivots_forward() {
    // Pivots are re-materialized for every payload now, so their fresh entries
    // are the FULL truth — like tables and charts. Carrying the old rows too
    // would duplicate every surviving pivot AND resurrect a ledger row for one
    // the v2 deletion just removed, so the subscriber would be told the
    // application still provides a pivot it has stopped shipping.
    let src = calp_commands_code();
    assert!(
        !src.contains("o.kind == \"pivot\" || o.kind == \"dataSource\""),
        "the refresh ledger merge is carrying v1 pivot rows forward again. With \
         pivots adopted, that both duplicates survivors and resurrects deleted \
         ones.",
    );
    assert!(
        src.contains("o.kind == \"dataSource\" || o.kind == \"extensionData\""),
        "the ledger merge's carry-forward filter is not the expected shape; \
         re-read it before trusting either assertion here.",
    );
}

#[test]
fn the_refresh_path_captures_sheet_names_before_the_collision_pass() {
    // `resolve_sheet_name_collisions` rewrites `ps.name` IN PLACE, and
    // `PulledSheet` has only the one name field — so the publisher's spelling is
    // gone the moment it runs. A pivot anchors its output by sheet NAME, so
    // without the map captured FIRST, a v2-added sheet that collided would send
    // the publisher's pivot to the subscriber's OWN same-named sheet and write
    // over it. The pull path has always captured these; the refresh path did
    // not, and the first draft of this fix reused the post-collision names.
    let src = calp_commands_code();
    let capture = src.find("let mut sheet_rename_maps");
    let collide = src.find("calp::pull::resolve_sheet_name_collisions(\n                &mut payload.pull_result.sheets");
    assert!(capture.is_some(), "the refresh path no longer builds a sheet rename map at all");
    if let (Some(c), Some(r)) = (capture, collide) {
        assert!(
            c < r,
            "the rename map is built AFTER the collision pass, so it maps \
             resolved names to themselves and the remap is a no-op",
        );
    }
}
