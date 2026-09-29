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

/// No name translation at all: every publisher name resolves as itself.
fn no_names() -> crate::calp_commands::RefreshSheetNames {
    crate::calp_commands::RefreshSheetNames::default()
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
        &no_names(),
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
        &no_names(),
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
        &no_names(),
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
        &no_names(),
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
        &no_names(),
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
    let mut rename = no_names();
    rename.local_names.insert("Report".to_string(), "Report (2)".to_string());

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

/// A pivot aimed at a sheet the subscriber DETACHED is neither re-adopted nor
/// withdrawn: the page and the pivot on it are the subscriber's now. Adopting
/// would write the publisher's v2 over a sheet upstream no longer speaks for;
/// withdrawing (it is in the prior ledger) would CLEAR its cells.
///
/// SABOTAGE: drop the `is_blocked_destination` skip, or the
/// `kept_on_detached` exclusion from `withdrawn`.
#[test]
fn a_pivot_on_a_detached_sheet_is_neither_adopted_nor_withdrawn() {
    let state = two_sheet_state();
    let pivot_state = PivotState::new();
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    // v1 put the pivot on "Report", and the ledger says it was ours.
    crate::calp_commands::apply_refreshed_pivots(
        &effect(),
        &state,
        &pivot_state,
        &[saved_pivot(id, "Report", (0, 0))],
        &[],
        &HashMap::new(),
        &no_names(),
        &HashSet::new(),
        None,
    );
    let written = state.grids.read().unwrap()[1].cells.len();
    assert!(written > 0, "precondition: v1 wrote the pivot's output");

    // The subscriber detaches "Report"; v2 re-lays the pivot out.
    let mut names = no_names();
    names.local_names.insert("Report".to_string(), "Report".to_string());
    names.blocked_destinations.insert("Report".to_string());
    let previously: HashSet<String> = [id.to_string()].into_iter().collect();
    let mut ledger = Vec::new();
    crate::calp_commands::apply_refreshed_pivots(
        &effect(),
        &state,
        &pivot_state,
        &[saved_pivot(id, "Report", (10, 5))],
        &[],
        &HashMap::new(),
        &names,
        &previously,
        Some(&mut ledger),
    );

    let tables = pivot_state.pivot_tables.read().unwrap();
    let (def, _) = tables.get(&id).expect("the detached sheet's pivot was withdrawn -- its cells cleared");
    assert_eq!(def.destination, (0, 0), "v2 was written over the detached sheet's pivot");
    assert_eq!(
        state.grids.read().unwrap()[1].cells.len(),
        written,
        "the detached sheet's cells changed"
    );
    assert!(ledger.is_empty(), "a pivot the subscriber now owns is not ledgered back to the application");
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
        &no_names(),
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
// The PULL path's restore (`restore_pulled_pivots`): the active mirror, and
// the lock it must not hold while it waits (BUG-0152, C7)
// ===========================================================================

/// Occupied cells of one grid, sorted.
fn occupied(grid: &engine::Grid) -> Vec<(u32, u32)> {
    let mut v: Vec<(u32, u32)> = grid.cells.keys().copied().collect();
    v.sort();
    v
}

/// BUG-0152. `state.grid` is the ACTIVE sheet's authoritative copy and
/// `run_calculation_pass` opens with `grids[active] = grid.clone()` -- a
/// whole-grid REPLACEMENT. `restore_pulled_pivots` wrote a pulled pivot into
/// `grids` only, so a pivot whose destination is the active sheet was erased by
/// the very next recalculation. The refresh path (`update_pivot_in_grid`)
/// always dual-wrote; the pull path assumed its destination could never be the
/// active sheet, and a destination resolved BY NAME can be.
///
/// SABOTAGE: pass `None` for the active-grid dual-write again.
#[test]
fn a_pulled_pivot_written_onto_the_active_sheet_reaches_the_mirror() {
    let state = two_sheet_state(); // "Data" (active, mirrored) + "Report"
    let pivot_state = PivotState::new();
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    // Output on the ACTIVE sheet, clear of its source table.
    let defs = vec![saved_pivot(id, "Data", (10, 5))];

    crate::calp_commands::restore_pulled_pivots(
        &effect(),
        &defs,
        &[],
        &state,
        &pivot_state,
        &[0, 1],
        &HashMap::new(),
        &HashMap::new(),
    );

    let grids = state.grids.read().unwrap();
    assert!(
        grids[0].get_cell(10, 5).is_some(),
        "precondition: the pivot's output landed on the active sheet's grid"
    );
    let mirror = state.grid.read().unwrap();
    assert_eq!(
        occupied(&mirror),
        occupied(&grids[0]),
        "the active sheet's mirror is missing the pivot's cells, so the next \
         recalculation (grids[active] = grid.clone()) deletes them"
    );
}

/// C7 (lock order). `restore_pulled_pivots` held `pivot_tables` (and `grids`)
/// while it waited for `sheet_names`; `calp_get_application_objects` takes
/// `sheet_names` first and `pivot_tables` after, and so does every name
/// authority. Two orders over one pair of locks is a deadlock waiting for its
/// interleaving, with no panic and nothing in the log.
///
/// Measured, not read off the source: this thread holds `sheet_names`, the
/// restore runs beside it, and a probe asks for `pivot_tables`. If the restore
/// is sitting on `pivot_tables` while it waits for `sheet_names`, the probe
/// cannot get it. (A false GREEN is possible if the restore has not reached its
/// locks within the pause; a false RED is not.)
///
/// SABOTAGE: take `sheet_names` after `pivot_tables` again.
#[test]
fn restoring_pulled_pivots_never_holds_pivot_tables_while_waiting_for_sheet_names() {
    let state = two_sheet_state();
    let pivot_state = PivotState::new();
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let defs = vec![saved_pivot(id, "Report", (0, 0))];
    let eff = effect();

    let probe_got_pivot_tables = std::thread::scope(|scope| {
        let names_guard = state.sheet_names.read().unwrap();
        let restore = scope.spawn(|| {
            crate::calp_commands::restore_pulled_pivots(
                &eff,
                &defs,
                &[],
                &state,
                &pivot_state,
                &[0, 1],
                &HashMap::new(),
                &HashMap::new(),
            );
        });
        // Let the restore run up to whatever it blocks on.
        std::thread::sleep(std::time::Duration::from_millis(300));
        let (tx, rx) = std::sync::mpsc::channel();
        let probed = &pivot_state;
        let probe = scope.spawn(move || {
            let _pt = probed.pivot_tables.read().unwrap();
            let _ = tx.send(());
        });
        let got = rx.recv_timeout(std::time::Duration::from_millis(1500)).is_ok();
        drop(names_guard);
        restore.join().unwrap();
        probe.join().unwrap();
        got
    });

    assert!(
        probe_got_pivot_tables,
        "restore_pulled_pivots held `pivot_tables` while it waited for `sheet_names` -- \
         the inverse of the order every name authority (and \
         calp_get_application_objects) takes them in"
    );
    assert!(
        pivot_state.pivot_tables.read().unwrap().contains_key(&id),
        "and once `sheet_names` was free the restore completed"
    );
}

/// C7's other half: `calp_get_application_objects` COPIES the sheet names and
/// releases them before it takes the object stores (`pivot_tables` among
/// them), so it holds no pair at all. A Tauri command with nine `State`s and a
/// window cannot be driven from a unit test, so this reads its code.
#[test]
fn application_objects_copy_the_sheet_names_before_the_object_stores() {
    let src = calp_commands_code();
    let start = src
        .find("pub fn calp_get_application_objects(")
        .expect("calp_get_application_objects moved");
    let body = &src[start..];
    let end = body.find("\n}\n").expect("end of calp_get_application_objects");
    let body = &body[..end];
    let names_at = body
        .find("state.sheet_names.read()")
        .expect("the command no longer reads sheet_names");
    let statement_end = body[names_at..].find(';').map(|i| names_at + i).unwrap();
    let statement = &body[names_at..statement_end];
    assert!(
        statement.contains(".clone()"),
        "`sheet_names` is held as a guard across the object stores again: {statement}"
    );
    let pivots_at = body
        .find("pivot_tables.read()")
        .expect("the command no longer reads pivot_tables");
    assert!(names_at < pivots_at, "the canonical order is sheet_names, then pivot_tables");
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
    // (The BEHAVIOUR is pinned by the refresh-orchestration tests in
    // calp_materialize_tests.rs; this keeps the ordering visible at the source.)
    //
    // BUG-0151 moved the resolution into ONE core function the refresh PREVIEW
    // shares (`calp::refresh::resolve_refresh_sheet_names`, whose own test pins
    // the capture-before-collision order), so the host must call THAT and must
    // not run a collision pass of its own beside it.
    let src = calp_commands_code();
    let start = src
        .find("pub(crate) fn prepare_refresh_payloads(")
        .expect("the refresh path no longer resolves its sheet names in prepare_refresh_payloads");
    let body = &src[start..];
    let end = body.find("\n}\n").expect("end of prepare_refresh_payloads");
    let body = &body[..end];
    assert!(
        body.contains("calp::refresh::resolve_refresh_sheet_names("),
        "the refresh path no longer resolves names through the resolver the preview shares"
    );
    assert!(
        !body.contains("calp::pull::resolve_sheet_name_collisions("),
        "the refresh path runs its own collision pass again -- the preview cannot see it, \
         so the two stop agreeing about which references a rename rewrites"
    );
    let core = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../core/calp/src/refresh.rs"),
    )
    .expect("core/calp/src/refresh.rs must be readable");
    let resolver = &core[core
        .find("pub fn resolve_refresh_sheet_names(")
        .expect("the shared resolver moved")..];
    let capture = resolver.find("let original: Vec<String>").expect("the resolver captures names");
    let collide = resolver
        .find("crate::pull::resolve_name_collisions(")
        .expect("the resolver runs the collision pass");
    assert!(
        capture < collide,
        "the publisher's names are captured AFTER the collision pass, so the map \
         sends resolved names to themselves and the remap is a no-op",
    );
}
