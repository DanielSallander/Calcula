//! FILENAME: app/src-tauri/src/object_sheet_tests.rs
//! PURPOSE: The OBJECT-BACKED SHEET substrate for Floating Ranges (M1).
//!
//! A floating range's cells live in a REAL engine sheet marked
//! `sheet_visibility == "object"` (`OBJECT_SHEET_VISIBILITY`). That buys the
//! whole recalculation stack — name-keyed cross-sheet edges, the shared
//! cascade, the F9 plan, `SetCell{sheet}` undo, sheet persistence — with zero
//! new machinery. What it costs is an invariant set, pinned here:
//!
//!   1. Object sheets are ABSENT from `build_sheet_list` (the one builder every
//!      `getSheets()` surface consumes) while remaining fully present in the
//!      state vectors, and the listed `index` values stay TRUE indices.
//!   2. An object sheet can never be ACTIVATED — the `state.grid` mirror, the
//!      active-sheet dependency maps and the cascade seeding all lean on that.
//!   3. The sheet lifecycle commands refuse object sheets (hide/unhide and
//!      delete pinned here, the delete's refusal before its effect;
//!      rename/move/copy share the same `ensure_user_sheet` gate).
//!   4. THE PARTITION INVARIANT: user sheets form a contiguous PREFIX and
//!      object sheets sit at the tail. `add_sheet` is the one operation that
//!      would break it (it used to append at the very end), so it now rotates
//!      the new user sheet in front of the object tail and re-keys the
//!      sheet-index-keyed stores for the shifted object sheets — their
//!      cross-sheet dependency edges above all. The partition is what keeps
//!      3D references (`sheet_order`) and every positional consumer of the
//!      filtered sheet list correct with NO filtering at all.

use std::collections::{HashMap, HashSet};

use crate::persistence::FileState;
use crate::sheets::OBJECT_SHEET_VISIBILITY;
use crate::AppState;

/// A workbook with `count` user sheets, seeded the way a load does.
fn workbook_with_sheets(count: usize) -> AppState {
    let state = crate::create_app_state();
    let seed = crate::document_effect::test_seed_effect;
    for i in 1..count {
        state.grids.write(&seed()).unwrap().push(engine::Grid::new());
        state
            .sheet_names
            .write(&seed())
            .unwrap()
            .push(format!("Sheet{}", i + 1));
        state.all_column_widths.write(&seed()).unwrap().push(HashMap::new());
        state.all_row_heights.write(&seed()).unwrap().push(HashMap::new());
        state.all_user_hidden_rows.write(&seed()).unwrap().push(HashSet::new());
        state.all_user_hidden_cols.write(&seed()).unwrap().push(HashSet::new());
        state.all_merged_regions.write(&seed()).unwrap().push(HashSet::new());
        state
            .sheet_ids
            .write(&seed())
            .unwrap()
            .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
    }
    state
}

/// Append an object-backed sheet through the ONE shared push-list
/// (`append_sheet_stores`) — exactly what `create_floating_range` does.
fn append_object_sheet(state: &AppState, name: &str) -> (usize, identity::SheetId) {
    let effect = crate::document_effect::test_seed_effect();
    let mut sheet_names = state.sheet_names.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let mut freeze_configs = state.freeze_configs.write(&effect).unwrap();
    let mut tab_colors = state.tab_colors.write(&effect).unwrap();
    let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();
    let mut all_column_widths = state.all_column_widths.write(&effect).unwrap();
    let mut all_row_heights = state.all_row_heights.write(&effect).unwrap();
    crate::sheets::append_sheet_stores(
        state,
        &effect,
        name.to_string(),
        OBJECT_SHEET_VISIBILITY,
        ::persistence::SheetKind::Worksheet,
        &mut sheet_names,
        &mut grids,
        &mut freeze_configs,
        &mut tab_colors,
        &mut sheet_visibility,
        &mut all_column_widths,
        &mut all_row_heights,
    )
}

fn visibility(state: &AppState, index: usize) -> String {
    state
        .sheet_visibility
        .read()
        .unwrap()
        .get(index)
        .cloned()
        .unwrap_or_else(|| "visible".to_string())
}

fn listed(state: &AppState) -> Vec<(usize, String)> {
    let sheet_names = state.sheet_names.read().unwrap();
    let freeze_configs = state.freeze_configs.read().unwrap();
    let tab_colors = state.tab_colors.read().unwrap();
    let sheet_visibility = state.sheet_visibility.read().unwrap();
    let sheet_ids = state.sheet_ids.read().unwrap();
    let sheet_kinds = state.sheet_kinds.read().unwrap();
    let ephemeral = crate::sheets::ephemeral_sheet_ids(state);
    crate::sheets::build_sheet_list(
        &sheet_names,
        &freeze_configs,
        &tab_colors,
        &sheet_visibility,
        &sheet_ids,
        &sheet_kinds,
        &ephemeral,
    )
        .into_iter()
        .map(|s| (s.index, s.name))
        .collect()
}

/// The `(index, ephemeral)` of every listed sheet.
fn listed_ephemeral(state: &AppState) -> Vec<(usize, bool)> {
    let sheet_names = state.sheet_names.read().unwrap();
    let freeze_configs = state.freeze_configs.read().unwrap();
    let tab_colors = state.tab_colors.read().unwrap();
    let sheet_visibility = state.sheet_visibility.read().unwrap();
    let sheet_ids = state.sheet_ids.read().unwrap();
    let sheet_kinds = state.sheet_kinds.read().unwrap();
    let ephemeral = crate::sheets::ephemeral_sheet_ids(state);
    crate::sheets::build_sheet_list(
        &sheet_names,
        &freeze_configs,
        &tab_colors,
        &sheet_visibility,
        &sheet_ids,
        &sheet_kinds,
        &ephemeral,
    )
    .into_iter()
    .map(|s| (s.index, s.ephemeral))
    .collect()
}

// ---------------------------------------------------------------------------
// 6. The EPHEMERAL flag (a drill-through's result sheet, model-drillthrough.md 2.6)
//
// Keyed by the STABLE sheet id in a session-only set, read by `build_sheet_list`
// through its 7th argument, cleared by `keep_ephemeral_sheet` (no FileState) and
// by the document reset. Pinned here beside the list builder it rides in.
// ---------------------------------------------------------------------------

#[test]
fn an_ephemeral_sheet_is_listed_as_such_by_its_stable_id_not_its_index() {
    let state = workbook_with_sheets(3);
    let second = state.sheet_ids.read().unwrap()[1];
    state.ephemeral_sheets.lock().unwrap().insert(second);

    assert_eq!(listed_ephemeral(&state), vec![(0, false), (1, true), (2, false)]);

    // The flag follows the ID, not the position: swap the first two sheets'
    // ids (what a move does to `sheet_ids`) and the flag moves with the id.
    {
        let seed = crate::document_effect::test_seed_effect();
        let mut ids = state.sheet_ids.write(&seed).unwrap();
        ids.swap(0, 1);
    }
    assert_eq!(listed_ephemeral(&state), vec![(0, true), (1, false), (2, false)]);
}

#[test]
fn keep_ephemeral_sheet_keeps_by_stable_id_and_answers_the_list_without_a_file_state() {
    let state = workbook_with_sheets(3);
    let second = state.sheet_ids.read().unwrap()[1];
    state.ephemeral_sheets.lock().unwrap().insert(second);
    assert_eq!(listed_ephemeral(&state), vec![(0, false), (1, true), (2, false)]);

    // The sheet MOVES before the keep lands (what a lower sheet's discard, or
    // a Move, does to a tab menu opened earlier): the keep follows the ID, so
    // it clears the sheet the user meant, wherever it now is -- never the
    // sheet that slid into the index the menu was opened on.
    {
        let seed = crate::document_effect::test_seed_effect();
        state.sheet_ids.write(&seed).unwrap().swap(1, 2);
    }
    assert_eq!(listed_ephemeral(&state), vec![(0, false), (1, false), (2, true)]);
    let result = crate::sheets::keep_ephemeral_sheet_impl(&state, &second.to_string()).expect("keep");
    assert_eq!(
        result.sheets.iter().map(|s| (s.index, s.ephemeral)).collect::<Vec<_>>(),
        vec![(0, false), (1, false), (2, false)],
        "the answered list no longer flags the kept sheet"
    );
    assert!(state.ephemeral_sheets.lock().unwrap().is_empty(), "the id left the set");
    assert_eq!(result.active_index, *state.active_sheet.read().unwrap());

    // A SECOND keep of the same, now ordinary, sheet is harmless and true: it
    // is the sheet the user meant, already kept (a repeated double-click, Keep
    // Sheet racing a refused discard's keep).
    let again = crate::sheets::keep_ephemeral_sheet_impl(&state, &second.to_string()).expect("a second keep is Ok");
    assert!(again.sheets.iter().all(|s| !s.ephemeral));
}

#[test]
fn keep_ephemeral_sheet_refuses_an_id_that_names_no_sheet_and_an_object_sheet() {
    let state = workbook_with_sheets(2);
    // A discard landed first (or the id is another document's): nothing was
    // kept, so the answer must not say it was.
    let gone = identity::SheetId::from_bytes(identity::generate_uuid_v7()).to_string();
    let err = crate::sheets::keep_ephemeral_sheet_impl(&state, &gone).unwrap_err();
    assert_eq!(err, crate::sheets::NO_SHEET_WITH_THAT_ID);
    let err = crate::sheets::keep_ephemeral_sheet_impl(&state, "not-an-id").unwrap_err();
    assert_eq!(err, crate::sheets::NO_SHEET_WITH_THAT_ID, "an id that does not parse names no sheet either");

    // A floating range's object-backed sheet is never a tab and never kept.
    let (_, object_id) = append_object_sheet(&state, "Float1");
    let err = crate::sheets::keep_ephemeral_sheet_impl(&state, &object_id.to_string()).unwrap_err();
    assert!(err.contains("floating range"), "the refusal says why: {err}");
}

/// A workbook built through the real add path -- Sheet1, Costs, Summary --
/// with a drill-through's EPHEMERAL result sheet "Drillthrough" appended LAST
/// and active, as `drill_through` lands it. Returns the drill sheet's id.
fn workbook_with_a_drill_sheet(state: &AppState, file: &FileState) -> identity::SheetId {
    for name in ["Costs", "Summary"] {
        crate::sheets::add_sheet_inner(state, file, Some(name.to_string()), ::persistence::SheetKind::Worksheet)
            .expect("add");
    }
    let added = crate::sheets::append_user_sheet(
        state,
        file,
        crate::sheets::EphemeralUserSheet {
            sheet: crate::sheets::NewUserSheet {
                name: crate::sheets::NewSheetName::FirstFree("Drillthrough".to_string()),
                kind: ::persistence::SheetKind::Worksheet,
                cells: None,
                activate: true,
            },
            refusal: "fixture: the active sheet is temporary",
        },
        "test",
    )
    .expect("append the drill sheet");
    assert_eq!(added.index, 3);
    added.sheet_id
}

fn sheet_names(state: &AppState) -> Vec<String> {
    state.sheet_names.read().unwrap().clone()
}

/// The `delete_sheet` command's body over plain states minus the slicer
/// pre/post work and the background re-query (which needs an AppHandle) --
/// the precedent `deleting_an_ephemeral_sheet_removes_its_id_from_the_set` uses.
fn delete_through_the_impl(
    state: &AppState,
    file: &FileState,
    index: usize,
    expected: Option<identity::SheetId>,
) -> Result<crate::sheets::SheetsResult, String> {
    crate::sheets::delete_sheet_impl(
        state,
        file,
        &crate::pivot::types::PivotState::new(),
        &crate::persistence::UserFilesState::default(),
        &crate::pane_control::PaneControlState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        index,
        false,
        expected,
    )
}

#[test]
fn discard_by_id_deletes_exactly_the_temporary_sheet_after_its_index_moved() {
    // THE BLOCKER. Insert Sheet is add + move: a list read between the two
    // named the drill sheet at index 3, the move then gave index 3 to Summary,
    // and a delete BY THAT INDEX removed Summary with no prompt while the
    // temporary sheet survived.
    let state = crate::create_app_state();
    let file = FileState::default();
    let drill = workbook_with_a_drill_sheet(&state, &file);
    assert_eq!(sheet_names(&state), vec!["Sheet1", "Costs", "Summary", "Drillthrough"]);
    let stale_index = 3;

    // Insert Sheet before the first tab while on the drill sheet: add, then move.
    crate::sheets::add_sheet_inner(&state, &file, Some("Inserted".to_string()), ::persistence::SheetKind::Worksheet)
        .expect("add");
    crate::sheets::move_sheet_impl(
        &state,
        &file,
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        4,
        0,
    )
    .expect("move");
    assert_eq!(sheet_names(&state), vec!["Inserted", "Sheet1", "Costs", "Summary", "Drillthrough"]);
    assert_eq!(sheet_names(&state)[stale_index], "Summary", "fixture: the stale index now names a user sheet");

    let discarded = crate::sheets::discard_ephemeral_sheet_with(&state, &drill.to_string(), |index, id| {
        delete_through_the_impl(&state, &file, index, Some(id))
    })
    .expect("discard");
    assert_eq!(discarded.deleted_index, 4, "the index the id resolved to at the delete, not the stale one");
    assert_eq!(discarded.deleted_name, "Drillthrough");
    assert_eq!(sheet_names(&state), vec!["Inserted", "Sheet1", "Costs", "Summary"], "every user sheet survives");
    assert_eq!(
        discarded.result.sheets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        vec!["Inserted", "Sheet1", "Costs", "Summary"],
        "the answered list is the list after the delete"
    );
    assert!(state.ephemeral_sheets.lock().unwrap().is_empty(), "the flag went with the sheet");
    // The wire shape the strip reads.
    let json = serde_json::to_value(&discarded).expect("serialize");
    assert_eq!(json["deletedIndex"], 4);
    assert_eq!(json["deletedName"], "Drillthrough");
    assert!(json["result"]["sheets"].is_array() && json["result"].get("activeIndex").is_some(), "{json}");
}

#[test]
fn a_discard_whose_sheet_moved_after_its_lookup_is_refused_cleanly_and_deletes_nothing() {
    // Review RA-1. The MCP server runs on its OWN thread, so its move_sheet can
    // land between the discard's id lookup and the delete. Before the delete
    // re-checked the id, the looked-up index deleted whichever sheet slid into
    // it -- a user sheet, with no prompt and the undo history ended -- while
    // the temporary sheet stayed.
    //
    // WHAT THIS PINS: the refusal (`SHEETS_CHANGED_UNDER_THE_DELETE`, nothing
    // deleted, the document clean, the sheet still temporary) and the positive
    // control. NOT where the check sits: the other door's move lands before the
    // delete is even entered, so a check hoisted out of the delete's locks
    // passes here too. `the_delete_checks_the_expected_id_under_its_locks_before_the_effect`
    // pins the position, from the source.
    //
    // SABOTAGE: drop the `expected` check in `delete_sheet_impl` -- Sheet1 is
    // deleted and the first assertion fails.
    let state = crate::create_app_state();
    let setup = FileState::default();
    let drill = workbook_with_a_drill_sheet(&state, &setup);
    assert_eq!(sheet_names(&state), vec!["Sheet1", "Costs", "Summary", "Drillthrough"]);
    let clean = FileState::default();
    let err = crate::sheets::discard_ephemeral_sheet_with(&state, &drill.to_string(), |index, id| {
        assert_eq!(index, 3, "fixture: the lookup found the drill sheet at 3");
        // The other door's move lands in the window: Sheet1 to the end.
        crate::sheets::move_sheet_impl(
            &state,
            &setup,
            &crate::slicer::SlicerState::new(),
            &crate::timeline_slicer::TimelineSlicerState::new(),
            &crate::ribbon_filter::RibbonFilterState::new(),
            0,
            3,
        )
        .expect("the other door's move");
        assert_eq!(sheet_names(&state)[index], "Sheet1", "fixture: the looked-up index now names a user sheet");
        delete_through_the_impl(&state, &clean, index, Some(id))
    })
    .unwrap_err();
    assert_eq!(
        sheet_names(&state),
        vec!["Costs", "Summary", "Drillthrough", "Sheet1"],
        "nothing was deleted: the user sheet at the looked-up index survives"
    );
    assert_eq!(err, crate::sheets::SHEETS_CHANGED_UNDER_THE_DELETE);
    assert!(state.ephemeral_sheets.lock().unwrap().contains(&drill), "the temporary sheet is still temporary");
    assert!(!clean.is_dirty(), "the refusal comes before the document is marked dirty");

    // POSITIVE CONTROL: the same call with the id the index really holds deletes.
    let index_now = state.sheet_ids.read().unwrap().iter().position(|i| *i == drill).expect("the drill sheet");
    delete_through_the_impl(&state, &clean, index_now, Some(drill)).expect("the id matches: deleted");
    assert_eq!(sheet_names(&state), vec!["Costs", "Summary", "Sheet1"]);
}

/// The code of the top-level `fn` in sheets.rs that starts at `signature`, up
/// to its closing brace at column 0, with every comment stripped -- the
/// comments around the id check name the very things this file looks for.
fn sheets_fn_code(signature: &str) -> String {
    let src = include_str!("sheets.rs");
    let at = src
        .find(signature)
        .unwrap_or_else(|| panic!("{signature} not found in sheets.rs -- renamed? re-derive this pin"));
    let rest = &src[at..];
    let end = rest.find("\n}\n").map_or(rest.len(), |e| e + 3);
    crate::object_deps_census_tests::strip_comments(&rest[..end])
}

#[test]
fn the_delete_checks_the_expected_id_under_its_locks_before_the_effect() {
    // Review RA-1, the half no runtime test here can see. The id re-check is
    // only worth something UNDER the three pending guards: every door that
    // renumbers the sheets takes `grid` first, so a check made before
    // `lock_pending` leaves exactly the window RA-1 is about (an MCP move
    // landing between the check and the locks deletes the user sheet with no
    // prompt). And it must come before the effect, or a refusal dirties the
    // document. The refusal constant may appear EARLIER as well (an early,
    // non-authoritative answer); what is pinned is that one sits between the
    // guards and the effect, reading `sheet_ids` there, and none after it.
    //
    // SABOTAGE: move the `if let Some(expected) = expected { ... }` block above
    // the three pending guards -- the "under the delete's locks" assertion fails.
    let body = sheets_fn_code("pub(crate) fn delete_sheet_impl(");
    let grid_locked = body
        .find("state.grid.lock_pending(")
        .expect("delete_sheet_impl no longer takes the grid lock pending");
    let names_locked = body
        .find("state.sheet_names.lock_pending(")
        .expect("delete_sheet_impl no longer takes the sheet_names lock pending");
    let effect = body
        .find("DocumentEffect::mutates(")
        .expect("delete_sheet_impl no longer constructs its effect");
    assert!(
        grid_locked < names_locked && names_locked < effect,
        "test out of date: the pending guards no longer come before the effect"
    );
    let refusals: Vec<usize> = body
        .match_indices("SHEETS_CHANGED_UNDER_THE_DELETE")
        .map(|(at, _)| at)
        .collect();
    let authoritative: Vec<usize> = refusals
        .iter()
        .copied()
        .filter(|&at| grid_locked < at && names_locked < at && at < effect)
        .collect();
    assert!(
        !authoritative.is_empty(),
        "the expected-id check is not under the delete's locks (after `state.grid.lock_pending(` and \
         `state.sheet_names.lock_pending(`, before `DocumentEffect::mutates(`); refusals at {refusals:?}, \
         guards at {grid_locked}/{names_locked}, effect at {effect}"
    );
    assert!(
        refusals.iter().all(|&at| at < effect),
        "an id refusal after `DocumentEffect::mutates(` leaves the document dirty"
    );
    let first_check = authoritative[0];
    assert!(
        body[names_locked..first_check].contains(".sheet_ids.read()"),
        "the check under the locks no longer reads `sheet_ids` there -- an id read before the locks \
         compares against a stale answer"
    );
}

/// A slicer the stores can hold: only the fields the store and the doomed
/// list read matter here.
fn slicer_on_sheet(sheet: usize) -> crate::slicer::Slicer {
    serde_json::from_value(serde_json::json!({
        "id": identity::EntityId::from_bytes(identity::generate_uuid_v7()).to_string(),
        "name": "Region",
        "sheetIndex": sheet,
        "x": 0.0, "y": 0.0, "width": 180.0, "height": 240.0,
        "sourceType": "pivot",
        "cacheSourceId": identity::EntityId::from_bytes(identity::generate_uuid_v7()).to_string(),
        "fieldName": "Region",
        "selectedItems": ["East"],
        "showHeader": true,
        "columns": 1,
        "stylePreset": "SlicerStyleLight1"
    }))
    .expect("a slicer")
}

#[test]
fn only_the_slicers_the_delete_removed_have_their_filters_cleared() {
    // Review RA-1, the pre-work. `delete_sheet` resolves the doomed slicers'
    // targets by INDEX before the delete takes its locks; a renumbering in that
    // window (away and back, which the id check cannot see) resolves another
    // sheet's slicers, which SURVIVE the delete. Clearing their filters would
    // take a live selection off pivots elsewhere with no undo.
    //
    // SABOTAGE: make `doomed_slicers_the_delete_removed` return `doomed`
    // unchanged -- the surviving slicer is kept and the assertion fails.
    let slicers = crate::slicer::SlicerState::new();
    let survivor = slicer_on_sheet(1);
    let survivor_id = survivor.id;
    slicers
        .slicers
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert(survivor_id, survivor);
    let removed_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let target = |pivot: u8| crate::slicer::commands::SlicerFilterTarget {
        pivot_id: identity::EntityId::from_bytes([pivot; 16]),
        field_index: 0,
        bi_field_key: None,
    };
    let doomed = vec![
        crate::slicer::commands::DoomedSlicerFilters { slicer_id: survivor_id, targets: vec![target(1)] },
        crate::slicer::commands::DoomedSlicerFilters { slicer_id: removed_id, targets: vec![target(2)] },
    ];

    let kept = crate::slicer::commands::doomed_slicers_the_delete_removed(&slicers, doomed);
    assert_eq!(
        kept.iter().map(|d| d.slicer_id).collect::<Vec<_>>(),
        vec![removed_id],
        "only the slicer that is gone from the store keeps its entry; the one still there is left alone"
    );
    assert_eq!(kept[0].targets, vec![target(2)], "with its own targets");
}

#[test]
fn the_delete_sheet_command_clears_only_the_slicers_its_delete_removed() {
    // The command cannot be driven here (it needs an AppHandle), so the step
    // `only_the_slicers_the_delete_removed_have_their_filters_cleared` proves is
    // pinned into it from the source: after the delete, before the clear, and
    // the clear gets its answer.
    //
    // SABOTAGE: drop the `doomed_slicers_the_delete_removed` call from
    // `delete_sheet` -- this test fails.
    let body = sheets_fn_code("pub fn delete_sheet(");
    let delete = body.find("delete_sheet_impl(").expect("delete_sheet no longer runs delete_sheet_impl");
    let removed = body
        .find("let doomed = crate::slicer::commands::doomed_slicers_the_delete_removed(&slicer_state, doomed);")
        .expect("delete_sheet no longer narrows the doomed slicers to the ones its delete removed");
    let clear = body
        .find("clear_filters_of_deleted_slicers(")
        .expect("delete_sheet no longer clears the removed slicers' filters");
    assert!(delete < removed && removed < clear, "the narrowing must run after the delete and before the clear");
}

#[test]
fn discard_refuses_an_unknown_id_and_a_kept_sheet_before_anything_runs_and_leaves_the_document_clean() {
    let state = crate::create_app_state();
    let setup = FileState::default();
    let drill = workbook_with_a_drill_sheet(&state, &setup);
    let before = sheet_names(&state);

    // The delete handed in is the REAL one, over a FileState that starts
    // clean: had either refusal come after it, a sheet would be gone and the
    // document dirty.
    let clean = FileState::default();
    let gone = identity::SheetId::from_bytes(identity::generate_uuid_v7()).to_string();
    let err = crate::sheets::discard_ephemeral_sheet_with(&state, &gone, |index, id| delete_through_the_impl(&state, &clean, index, Some(id)))
        .unwrap_err();
    assert_eq!(err, crate::sheets::NO_SHEET_WITH_THAT_ID);
    let err = crate::sheets::discard_ephemeral_sheet_with(&state, "  ", |index, id| delete_through_the_impl(&state, &clean, index, Some(id)))
        .unwrap_err();
    assert_eq!(err, crate::sheets::NO_SHEET_WITH_THAT_ID);
    assert_eq!(sheet_names(&state), before, "an unknown id deletes nothing");
    assert!(!clean.is_dirty(), "and leaves the document clean");

    // The user KEPT it (double-click) while the discard was on its way.
    crate::sheets::keep_ephemeral_sheet_impl(&state, &drill.to_string()).expect("keep");
    let err = crate::sheets::discard_ephemeral_sheet_with(&state, &drill.to_string(), |index, id| {
        delete_through_the_impl(&state, &clean, index, Some(id))
    })
    .unwrap_err();
    assert_eq!(err, crate::sheets::SHEET_NOT_TEMPORARY_ANY_MORE);
    assert_eq!(sheet_names(&state), before, "a kept sheet is never discarded");
    assert!(!clean.is_dirty(), "and the refusal leaves the document clean");

    // An ordinary sheet that was never temporary is refused the same way.
    let costs = state.sheet_ids.read().unwrap()[1].to_string();
    let err = crate::sheets::discard_ephemeral_sheet_with(&state, &costs, |index, id| delete_through_the_impl(&state, &clean, index, Some(id)))
        .unwrap_err();
    assert_eq!(err, crate::sheets::SHEET_NOT_TEMPORARY_ANY_MORE);
    assert_eq!(sheet_names(&state), before);
    assert!(!clean.is_dirty());
}

#[test]
fn an_ephemeral_add_refuses_on_a_temporary_active_sheet_and_flags_its_own_id_under_its_locks() {
    // The drill's own guards run before its query is awaited; the add is
    // where "the active sheet is temporary" is decided for good, inside the
    // add's critical section, and where the new id is flagged -- so no other
    // add, switch or delete can see the new sheet unflagged.
    let state = crate::create_app_state();
    let file = FileState::default();
    let ephemeral_add = |name: &str| crate::sheets::EphemeralUserSheet {
        sheet: crate::sheets::NewUserSheet {
            name: crate::sheets::NewSheetName::FirstFree(name.to_string()),
            kind: ::persistence::SheetKind::new_canvas(),
            cells: None,
            activate: true,
        },
        refusal: "Another drill-through opened a temporary sheet while this one was running.",
    };

    // The ACTIVE sheet is temporary: refused with the caller's sentence,
    // before the effect -- nothing added, the document clean.
    let active = state.sheet_ids.read().unwrap()[0];
    state.ephemeral_sheets.lock().unwrap().insert(active);
    let err = match crate::sheets::append_user_sheet(&state, &file, ephemeral_add("Drill"), "test") {
        Ok(_) => panic!("an ephemeral sheet was opened on top of a temporary one"),
        Err(e) => e,
    };
    assert_eq!(err, "Another drill-through opened a temporary sheet while this one was running.");
    assert_eq!(sheet_names(&state), vec!["Sheet1"], "nothing added");
    assert!(!file.is_dirty(), "the refusal leaves the document clean");

    // Not temporary any more: the add lands and flags its OWN id, which the
    // list it built under its locks already shows.
    state.ephemeral_sheets.lock().unwrap().clear();
    let added = crate::sheets::append_user_sheet(&state, &file, ephemeral_add("Drill"), "test").expect("lands");
    assert!(state.ephemeral_sheets.lock().unwrap().contains(&added.sheet_id), "the add flagged the id it minted");
    assert_eq!(state.sheet_ids.read().unwrap()[added.index], added.sheet_id, "and answered that id");
    assert_eq!(
        added.result.sheets.iter().map(|s| (s.index, s.ephemeral)).collect::<Vec<_>>(),
        vec![(0, false), (1, true)],
        "the list built inside the add already flags the new sheet"
    );

    // An ORDINARY add flags nothing, and is not refused by a temporary
    // active sheet (Insert Sheet while on a drill result is allowed).
    let ordinary = crate::sheets::append_user_sheet(
        &state,
        &file,
        crate::sheets::NewUserSheet {
            name: crate::sheets::NewSheetName::Exact("Plain".to_string()),
            kind: ::persistence::SheetKind::Worksheet,
            cells: None,
            activate: false,
        },
        "test",
    )
    .expect("an ordinary add is never refused for the active sheet");
    assert!(!state.ephemeral_sheets.lock().unwrap().contains(&ordinary.sheet_id));
    assert_eq!(state.ephemeral_sheets.lock().unwrap().len(), 1);
}

#[test]
fn deleting_an_ephemeral_sheet_removes_its_id_from_the_set() {
    // The hygiene half of `delete_sheet_impl`: the flag goes with the sheet.
    // The second sheet is added through the ONE add path so every per-sheet
    // store has its entry, then flagged, then deleted through the real impl
    // over plain states (the `delete_sheet` command's body minus the slicer
    // re-query, which needs an AppHandle).
    let state = crate::create_app_state();
    let file = FileState::default();
    let added = crate::sheets::append_user_sheet(
        &state,
        &file,
        crate::sheets::NewUserSheet {
            name: crate::sheets::NewSheetName::FirstFree("Drillthrough".to_string()),
            kind: ::persistence::SheetKind::Worksheet,
            cells: None,
            activate: false,
        },
        "test",
    )
    .expect("append");
    let id = state.sheet_ids.read().unwrap()[added.index];
    let kept = state.sheet_ids.read().unwrap()[0];
    state.ephemeral_sheets.lock().unwrap().insert(id);
    state.ephemeral_sheets.lock().unwrap().insert(kept);
    assert_eq!(listed_ephemeral(&state), vec![(0, true), (1, true)]);

    let result = crate::sheets::delete_sheet_impl(
        &state,
        &file,
        &crate::pivot::types::PivotState::new(),
        &crate::persistence::UserFilesState::default(),
        &crate::pane_control::PaneControlState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        added.index,
        false,
        None,
    )
    .expect("delete");
    assert_eq!(result.sheets.len(), 1);
    let remaining: Vec<identity::SheetId> = state.ephemeral_sheets.lock().unwrap().iter().copied().collect();
    assert_eq!(remaining, vec![kept], "the deleted sheet's id left the set; the other flag is untouched");
    assert_eq!(listed_ephemeral(&state), vec![(0, true)]);
}

#[test]
fn the_document_reset_clears_every_ephemeral_flag() {
    let state = workbook_with_sheets(2);
    let second = state.sheet_ids.read().unwrap()[1];
    state.ephemeral_sheets.lock().unwrap().insert(second);

    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    // The real reset, with every store it takes -- the same call `new_file`
    // and `open_file` make (`document_store_reset_tests` is the precedent).
    crate::persistence::reset_document_scoped_stores(
        &state,
        &crate::persistence::UserFilesState::default(),
        &crate::slicer::SlicerState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        &crate::pane_control::PaneControlState::new(),
        &crate::scripting::types::ScriptState::new(),
        &crate::pivot::types::PivotState::new(),
        &crate::bi::types::BiState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        &effect,
    )
    .expect("reset");
    assert!(
        state.ephemeral_sheets.lock().unwrap().is_empty(),
        "File > New / Open starts with no sheet flagged: the ids were the previous document's"
    );
}

// ---------------------------------------------------------------------------
// 7. Every refusal of a sheet delete leaves the document clean (review F2 and
//    F3, round 3). `DocumentEffect::mutates` dirties at construction, so a
//    refusal below it puts the asterisk in the title, makes Close ask to save
//    and hands AutoRecover a change -- for a delete that changed nothing.
// ---------------------------------------------------------------------------

/// Review F3. The sheet command's door (`allow_object = false`) refuses a
/// floating range's backing sheet: deleting it there would leave the object
/// row pointing at nothing. Those indices lie past the listed sheets, and any
/// caller can pass one (an MCP agent's `delete_sheet`). Both id shapes: with
/// the backing sheet's own id the id check passes and the door is the only
/// thing that refuses.
///
/// SABOTAGE: (a) drop the `else { ensure_user_sheet(..) }` arm in
/// `delete_sheet_impl` -- Float1 is deleted and `expect_err` fails; (b) move it
/// below `DocumentEffect::mutates` (reading the write guard) -- the clean
/// assertion fails.
#[test]
fn the_user_door_refuses_to_delete_an_object_sheet_and_leaves_the_document_clean() {
    let state = workbook_with_sheets(1);
    let (object_index, object_id) = append_object_sheet(&state, "Float1");
    let before = sheet_names(&state);
    assert_eq!(before, vec!["Sheet1", "Float1"], "fixture");
    let clean = FileState::default();
    for expected in [None, Some(object_id)] {
        let err = delete_through_the_impl(&state, &clean, object_index, expected)
            .expect_err("the sheet door must never delete a floating range's backing sheet");
        assert!(err.contains("floating range"), "the refusal says why: {err}");
        assert_eq!(sheet_names(&state), before, "nothing was deleted ({expected:?})");
        assert_eq!(visibility(&state, object_index), OBJECT_SHEET_VISIBILITY, "the backing sheet is untouched");
        assert!(!clean.is_dirty(), "the refusal comes before the document is marked dirty ({expected:?})");
    }
}

/// Review F2. Sheet2 is hidden and Sheet1 is the only visible sheet; the tab
/// menu's Delete is enabled on it (it greys only on the last SHEET), and the
/// user confirms. The delete is refused -- and was refused only AFTER the
/// effect, so a workbook nothing had changed came back dirty. Both id shapes:
/// the tab strip's Delete and a temporary sheet's discard pass the id, a
/// script passes none.
///
/// SABOTAGE: drop the last-visible check above the effect (the backstop below
/// it still refuses) -- the clean assertion fails.
#[test]
fn refusing_to_delete_the_last_visible_sheet_leaves_the_document_clean() {
    let state = workbook_with_sheets(2);
    let setup = FileState::default();
    crate::sheets::hide_sheet_inner(&state, &setup, 1, None).expect("fixture: hide Sheet2");
    assert_eq!(visibility(&state, 1), "hidden", "fixture: Sheet2 is hidden");
    let sheet1 = state.sheet_ids.read().unwrap()[0];
    let before = sheet_names(&state);
    let clean = FileState::default();
    for expected in [None, Some(sheet1)] {
        let err = delete_through_the_impl(&state, &clean, 0, expected)
            .expect_err("the last visible sheet must not be deleted");
        assert_eq!(err, "Cannot delete the last visible sheet");
        assert_eq!(sheet_names(&state), before, "nothing was deleted ({expected:?})");
        assert_eq!(visibility(&state, 1), "hidden", "the hidden sheet stays hidden");
        assert!(!clean.is_dirty(), "the refusal comes before the document is marked dirty ({expected:?})");
    }
    // POSITIVE CONTROL: the hidden sheet itself may go -- Sheet1 stays visible.
    delete_through_the_impl(&state, &clean, 1, None).expect("deleting the hidden sheet leaves a visible one");
    assert_eq!(sheet_names(&state), vec!["Sheet1"]);
}

/// Review F2. A one-sheet workbook: the delete is refused with its own
/// message, and clean.
///
/// SABOTAGE: (a) move the last-sheet check below `DocumentEffect::mutates` --
/// the message assertion fails (the last-visible check answers first: one
/// sheet removed leaves no visible sheet either); (b) move all three checks
/// below it, the shape before the fix -- the clean assertion fails.
#[test]
fn refusing_to_delete_the_last_sheet_leaves_the_document_clean() {
    let state = workbook_with_sheets(1);
    let only = state.sheet_ids.read().unwrap()[0];
    let clean = FileState::default();
    for expected in [None, Some(only)] {
        let err = delete_through_the_impl(&state, &clean, 0, expected)
            .expect_err("the last sheet must not be deleted");
        assert_eq!(err, "Cannot delete the last sheet");
        assert_eq!(sheet_names(&state), vec!["Sheet1"], "nothing was deleted ({expected:?})");
        assert!(!clean.is_dirty(), "the refusal comes before the document is marked dirty ({expected:?})");
    }
}

/// Review F2. An index one past the last sheet (a script's `deleteSheet` with
/// a stale index): refused, and clean. (With an id the id check answers first,
/// `SHEETS_CHANGED_UNDER_THE_DELETE`, also clean.)
///
/// SABOTAGE: move the out-of-range check below `DocumentEffect::mutates` -- the
/// clean assertion fails.
#[test]
fn refusing_an_out_of_range_delete_leaves_the_document_clean() {
    let state = workbook_with_sheets(2);
    let clean = FileState::default();
    let err = delete_through_the_impl(&state, &clean, 2, None).expect_err("index 2 names no sheet of two");
    assert_eq!(err, "Sheet index 2 out of range");
    assert_eq!(sheet_names(&state), vec!["Sheet1", "Sheet2"], "nothing was deleted");
    assert!(!clean.is_dirty(), "the refusal comes before the document is marked dirty");
}

/// Review F2 and F3, the half no runtime test above can see. Every refusal of
/// the delete a caller can provoke -- the two door checks and the three "can
/// the workbook survive it" checks -- must sit UNDER the delete's pending
/// guards (after `state.sheet_names.lock_pending(`, the last of the three: a
/// check made before them answers about a workbook another door, such as the
/// MCP server on its own thread, can renumber before the delete holds its
/// locks -- the window review RA-1 closed) and BEFORE `DocumentEffect::mutates(`
/// (a refusal after it dirties the document). And the last-visible check is
/// asked AGAIN under the `sheet_visibility` write guard: that store is read and
/// released before the effect, and the undo/redo of a hide
/// (`apply_sheet_tab_state_restore`) writes it without taking `sheet_names`.
///
/// SABOTAGE: (a) hoist one check above the pending guards -- it is listed as
/// asked before the guards; (b) move one below the effect -- it is listed as
/// asked only after it; (c) drop the backstop -- the last assertion fails.
#[test]
fn every_refusal_of_the_delete_sits_under_its_locks_before_the_effect() {
    let body = sheets_fn_code("pub(crate) fn delete_sheet_impl(");
    let names_locked = body
        .find("state.sheet_names.lock_pending(")
        .expect("delete_sheet_impl no longer takes the sheet_names lock pending");
    let effect = body
        .find("DocumentEffect::mutates(")
        .expect("delete_sheet_impl no longer constructs its effect");
    let refusals = [
        "ensure_user_sheet(",
        "ensure_object_sheet(",
        "\"Cannot delete the last sheet\"",
        "\"Sheet index {} out of range\"",
        "\"Cannot delete the last visible sheet\"",
    ];
    let misplaced: Vec<String> = refusals
        .iter()
        .filter_map(|refusal| match body.find(refusal) {
            None => Some(format!("{refusal} is gone from delete_sheet_impl")),
            Some(at) if at < names_locked => Some(format!(
                "{refusal} is asked before the pending guards (at {at}; `sheet_names` is locked at {names_locked})"
            )),
            Some(at) if at > effect => Some(format!(
                "{refusal} is asked only after the effect (at {at}; `DocumentEffect::mutates(` at {effect})"
            )),
            Some(_) => None,
        })
        .collect();
    assert!(
        misplaced.is_empty(),
        "every refusal of the delete must sit under its pending guards and before the effect: {misplaced:#?}"
    );
    let visibility_written = body[effect..]
        .find("state.sheet_visibility.write(")
        .map(|at| effect + at)
        .expect("delete_sheet_impl no longer takes the sheet_visibility write guard after its effect");
    assert!(
        body[visibility_written..].contains("\"Cannot delete the last visible sheet\""),
        "the last-visible BACKSTOP under the sheet_visibility write guard is gone: a hide that lands between \
         the check before the effect and the write (the undo/redo of a hide takes no `sheet_names`) would \
         leave the workbook with no visible sheet"
    );
}

// ---------------------------------------------------------------------------
// 1. Invisible to the list, present in the stores
// ---------------------------------------------------------------------------

#[test]
fn an_object_sheet_is_absent_from_the_sheet_list_but_present_in_the_stores() {
    let state = workbook_with_sheets(2);
    let (obj_index, _id) = append_object_sheet(&state, "Float1");
    assert_eq!(obj_index, 2);

    let list = listed(&state);
    assert_eq!(
        list,
        vec![(0, "Sheet1".to_string()), (1, "Sheet2".to_string())],
        "the object sheet must not appear on any getSheets() surface, and the \
         listed indices must remain TRUE state-vector indices"
    );

    // Fully present underneath: it is a real sheet.
    assert_eq!(state.sheet_names.read().unwrap()[2], "Float1");
    assert_eq!(state.grids.read().unwrap().len(), 3);
    assert_eq!(visibility(&state, 2), OBJECT_SHEET_VISIBILITY);
}

// ---------------------------------------------------------------------------
// 2. Never active
// ---------------------------------------------------------------------------

#[test]
fn an_object_sheet_cannot_be_activated() {
    let state = workbook_with_sheets(1);
    let (obj_index, _id) = append_object_sheet(&state, "Float1");

    let err = crate::sheets::activate_sheet(&state, obj_index)
        .expect_err("activating a floating range's backing sheet must refuse");
    assert!(
        err.contains("floating range"),
        "the refusal must say WHY (got: {err})"
    );
    assert_eq!(
        *state.active_sheet.read().unwrap(),
        0,
        "a refused activation must not move the active sheet"
    );
}

// ---------------------------------------------------------------------------
// 3. The lifecycle commands refuse
// ---------------------------------------------------------------------------

#[test]
fn an_object_sheet_can_be_neither_hidden_nor_unhidden() {
    let state = workbook_with_sheets(1);
    let file = FileState::default();
    let (obj_index, _id) = append_object_sheet(&state, "Float1");

    crate::sheets::hide_sheet_inner(&state, &file, obj_index, None)
        .expect_err("hide must refuse an object sheet");
    crate::sheets::unhide_sheet_inner(&state, &file, obj_index)
        .expect_err("unhide must refuse an object sheet");
    assert_eq!(
        visibility(&state, obj_index),
        OBJECT_SHEET_VISIBILITY,
        "a refused hide/unhide must leave the object marker untouched — \
         overwriting it would orphan the floating range that owns the sheet"
    );
}

// ---------------------------------------------------------------------------
// 4. The partition invariant
// ---------------------------------------------------------------------------

#[test]
fn adding_a_sheet_rotates_in_front_of_the_object_tail_and_rekeys_its_edges() {
    let state = workbook_with_sheets(1);
    let file = FileState::default();
    let (obj_index, obj_id) = append_object_sheet(&state, "Float1");
    assert_eq!(obj_index, 1);

    // A formula on the object sheet (a floating range cell) depends on
    // Sheet1!A1: the dependent VALUE and the dependency KEY both carry the
    // object sheet's INDEX, which the rotation below renumbers.
    {
        let mut dependents = state.cross_sheet_dependents.lock().unwrap();
        let mut set = rustc_hash::FxHashSet::default();
        set.insert((obj_index, 0u32, 0u32));
        dependents.insert(("Sheet1".to_string(), 0, 0), set);
    }
    {
        let mut dependencies = state.cross_sheet_dependencies.lock().unwrap();
        dependencies.insert((obj_index, 0, 0), Default::default());
    }

    let result =
        crate::sheets::add_sheet_inner(&state, &file, None, ::persistence::SheetKind::Worksheet).expect("add a user sheet");

    // The new user sheet took the object sheet's old position; the object
    // sheet moved to the tail. User sheets are a contiguous prefix again.
    {
        let vis = state.sheet_visibility.read().unwrap();
        assert_eq!(
            &*vis,
            &vec![
                "visible".to_string(),
                "visible".to_string(),
                OBJECT_SHEET_VISIBILITY.to_string()
            ],
            "user sheets must form a contiguous prefix with the object tail last"
        );
    }
    assert_eq!(
        *state.active_sheet.read().unwrap(),
        1,
        "the new sheet is active at its rotated-in position"
    );
    assert_eq!(
        state.sheet_names.read().unwrap()[2],
        "Float1",
        "the object sheet rode the rotation to the tail"
    );
    assert_eq!(
        state.sheet_ids.read().unwrap()[2],
        obj_id,
        "the object sheet kept its SheetId through the rotation"
    );
    assert_eq!(
        result.sheets.iter().map(|s| s.index).collect::<Vec<_>>(),
        vec![0, 1],
        "the returned list holds exactly the user sheets, at true indices"
    );

    // The object sheet's cross-sheet edges followed it to its new index —
    // this is the re-keying that keeps a floating range recalculating after
    // the user adds a sheet.
    {
        let dependents = state.cross_sheet_dependents.lock().unwrap();
        let set = dependents
            .get(&("Sheet1".to_string(), 0, 0))
            .expect("the edge must survive the add");
        assert!(
            set.contains(&(2, 0, 0)),
            "the dependent must now name the object sheet's NEW index (got {set:?})"
        );
        assert!(!set.contains(&(1, 0, 0)), "the old index must be gone");
    }
    {
        let dependencies = state.cross_sheet_dependencies.lock().unwrap();
        assert!(
            dependencies.contains_key(&(2, 0, 0)),
            "the dependency key must follow the object sheet"
        );
        assert!(!dependencies.contains_key(&(1, 0, 0)));
    }
}

/// Append a USER sheet at the very end, as a `.calp` pull appends one -- i.e.
/// deliberately WITHOUT `add_sheet`'s partition-keeping rotation.
fn append_user_sheet_at_end(state: &AppState, name: &str) -> (usize, identity::SheetId) {
    let effect = crate::document_effect::test_seed_effect();
    let mut sheet_names = state.sheet_names.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let mut freeze_configs = state.freeze_configs.write(&effect).unwrap();
    let mut tab_colors = state.tab_colors.write(&effect).unwrap();
    let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();
    let mut all_column_widths = state.all_column_widths.write(&effect).unwrap();
    let mut all_row_heights = state.all_row_heights.write(&effect).unwrap();
    crate::sheets::append_sheet_stores(
        state,
        &effect,
        name.to_string(),
        "visible",
        ::persistence::SheetKind::Worksheet,
        &mut sheet_names,
        &mut grids,
        &mut freeze_configs,
        &mut tab_colors,
        &mut sheet_visibility,
        &mut all_column_widths,
        &mut all_row_heights,
    )
}

#[test]
fn restoring_the_partition_changes_nothing_on_a_partitioned_workbook() {
    let state = workbook_with_sheets(2);
    append_object_sheet(&state, "Float1");
    state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(2, 0, 0, Some(engine::cell::Cell::new_number(1.0)));
    let effect = crate::document_effect::test_seed_effect();
    let (slicers, timelines, filters) = object_states();
    assert_eq!(
        crate::sheets::restore_partition_invariant(&state, &effect, &slicers, &timelines, &filters)
            .unwrap(),
        None,
        "already a user prefix + object tail: nothing to move"
    );
    assert!(
        state.undo_stack.lock().unwrap().can_undo(),
        "nothing moved, so the undo history is not ended"
    );
    assert_eq!(
        listed(&state),
        vec![(0, "Sheet1".to_string()), (1, "Sheet2".to_string())]
    );
}

/// The pull-side partition repair: two user sheets appended BEHIND a two-sheet
/// object tail rotate in front of it, in order, and every per-sheet store --
/// aligned vectors and index-keyed maps alike -- follows its sheet.
///
/// SABOTAGE: drop the `sheet_kinds` rotation (the canvas flag lands on the
/// neighbour), or the note/hyperlink re-key (the link stays on index 2, which
/// now holds a USER sheet).
#[test]
fn restoring_the_partition_rotates_appended_user_sheets_in_front_of_the_object_tail() {
    let state = workbook_with_sheets(1); // Sheet1
    let (_, float1) = append_object_sheet(&state, "Float1"); // 1
    let (_, float2) = append_object_sheet(&state, "Float2"); // 2
    let (_, north) = append_user_sheet_at_end(&state, "North"); // 3
    let (_, canvas) = append_user_sheet_at_end(&state, "Canvas"); // 4
    let effect = crate::document_effect::test_seed_effect();
    state.sheet_kinds.write(&effect).unwrap()[4] = ::persistence::SheetKind::new_canvas();
    state.tab_colors.write(&effect).unwrap()[3] = "#ff0000".to_string();
    *state.active_sheet.write(&effect).unwrap() = 3;
    {
        // A hyperlink on the object sheet Float2 (index 2).
        let mut links = HashMap::new();
        links.insert(
            (0u32, 0u32),
            crate::hyperlinks::Hyperlink {
                row: 0,
                col: 0,
                sheet_index: 2,
                link_type: crate::hyperlinks::HyperlinkType::Url,
                target: "https://example.com".to_string(),
                internal_ref: None,
                display_text: None,
                tooltip: None,
            },
        );
        state.hyperlinks.write(&effect).unwrap().insert(2, links);
    }
    // A cross-sheet edge whose dependent is North (index 3).
    {
        let mut set = rustc_hash::FxHashSet::default();
        set.insert((3usize, 0u32, 0u32));
        state
            .cross_sheet_dependents
            .lock()
            .unwrap()
            .insert(("Sheet1".to_string(), 0, 0), set);
    }
    // A queued edit on Float1's cell store (index 1), which the rotation is
    // about to renumber to 3.
    state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(1, 0, 0, Some(engine::cell::Cell::new_number(1.0)));

    let (slicers, timelines, filters) = object_states();
    let old_to_new = crate::sheets::restore_partition_invariant(&state, &effect, &slicers, &timelines, &filters)
        .unwrap()
        .expect("user sheets behind the tail must move");
    assert_eq!(old_to_new, vec![0, 3, 4, 1, 2]);
    assert!(
        !state.undo_stack.lock().unwrap().can_undo(),
        "the rotation renumbered sheets under the queued edit -- a structural \
         change ends the undo history (BUG-0005), or the undo lands on North"
    );

    assert_eq!(
        *state.sheet_names.read().unwrap(),
        vec!["Sheet1", "North", "Canvas", "Float1", "Float2"]
    );
    let ids = state.sheet_ids.read().unwrap().clone();
    assert_eq!((ids[1], ids[2], ids[3], ids[4]), (north, canvas, float1, float2));
    {
        let vis = state.sheet_visibility.read().unwrap();
        assert_eq!(
            &vis[..],
            &[
                "visible".to_string(),
                "visible".to_string(),
                "visible".to_string(),
                OBJECT_SHEET_VISIBILITY.to_string(),
                OBJECT_SHEET_VISIBILITY.to_string()
            ][..]
        );
    }
    {
        let kinds = state.sheet_kinds.read().unwrap();
        assert!(kinds[2].is_canvas(), "the canvas kind followed its sheet");
        assert!(!kinds[4].is_canvas() && !kinds[1].is_canvas());
    }
    assert_eq!(state.tab_colors.read().unwrap()[1], "#ff0000", "North's tab colour followed it");
    assert_eq!(*state.active_sheet.read().unwrap(), 1, "the active sheet followed North");
    {
        let links = state.hyperlinks.read().unwrap();
        let link = links.get(&4).and_then(|l| l.get(&(0, 0))).expect("the link followed Float2");
        assert_eq!(link.sheet_index, 4, "and was re-stamped");
        assert!(!links.contains_key(&2), "Canvas carries no link it never had");
    }
    {
        let dependents = state.cross_sheet_dependents.lock().unwrap();
        let set = dependents.get(&("Sheet1".to_string(), 0, 0)).unwrap();
        assert!(set.contains(&(1, 0, 0)) && !set.contains(&(3, 0, 0)), "the edge followed North: {set:?}");
    }
    // The listed indices are TRUE indices again, and positional: sheets[i].index == i.
    assert_eq!(
        listed(&state),
        vec![(0, "Sheet1".to_string()), (1, "North".to_string()), (2, "Canvas".to_string())]
    );
}

/// The object stores `restore_partition_invariant` needs to re-anchor the
/// index-FIELD objects (slicers, timelines, ribbon filters).
fn object_states() -> (
    crate::slicer::SlicerState,
    crate::timeline_slicer::TimelineSlicerState,
    crate::ribbon_filter::RibbonFilterState,
) {
    (
        crate::slicer::SlicerState::new(),
        crate::timeline_slicer::TimelineSlicerState::new(),
        crate::ribbon_filter::RibbonFilterState::new(),
    )
}

/// The objects that name their sheet by an index FIELD ride the rotation too.
/// The helper used to re-key only the index-KEYED stores and rest the rest on a
/// precondition ("nothing anchored by index exists on a moved sheet yet"), which
/// a refresh does not honour: it writes the publisher's visibility onto sheets
/// it already had, so an existing user sheet can move -- and its chart,
/// sparkline, slicer, timeline, report and pivot region stayed on the index
/// that now holds a DIFFERENT sheet.
///
/// SABOTAGE: drop the `cascade_sheet_removed` call (chart/sparkline/timeline/
/// slicer), the region loop, or `remap_report_sheets` from the helper.
#[test]
fn restoring_the_partition_re_anchors_the_index_field_objects_of_a_moved_sheet() {
    let state = workbook_with_sheets(1); // Sheet1
    append_object_sheet(&state, "Float1"); // 1
    append_user_sheet_at_end(&state, "North"); // 2 -> moves to 1
    let effect = crate::document_effect::test_seed_effect();
    let (slicers, timelines, filters) = object_states();

    let chart_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    state.charts.write(&effect).unwrap().push(crate::api_types::ChartEntry {
        id: chart_id,
        sheet_index: 2,
        spec_json: "{}".to_string(),
    });
    state.sparklines.write(&effect).unwrap().push(crate::api_types::SparklineEntry {
        sheet_index: 2,
        groups_json: "[]".to_string(),
    });
    let pivot_owner = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    state.protected_regions.lock().unwrap().push(crate::ProtectedRegion {
        id: format!("pivot-{pivot_owner}"),
        region_type: "pivot".to_string(),
        owner_id: pivot_owner,
        sheet_index: 2,
        start_row: 0,
        start_col: 0,
        end_row: 3,
        end_col: 3,
        reserved_only: false,
    });
    // An object on the sheet that does NOT move: must stay exactly where it is.
    let sheet1_chart = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    state.charts.write(&effect).unwrap().push(crate::api_types::ChartEntry {
        id: sheet1_chart,
        sheet_index: 0,
        spec_json: "{}".to_string(),
    });

    let old_to_new = crate::sheets::restore_partition_invariant(&state, &effect, &slicers, &timelines, &filters)
        .unwrap()
        .expect("North sits behind the object tail and must move");
    assert_eq!(old_to_new, vec![0, 2, 1], "North 2 -> 1, Float1 1 -> 2");

    let charts = state.charts.read().unwrap();
    let north_chart = charts.iter().find(|c| c.id == chart_id).unwrap();
    assert_eq!(north_chart.sheet_index, 1, "the chart followed North, not stayed on Float1's new index");
    assert_eq!(charts.iter().find(|c| c.id == sheet1_chart).unwrap().sheet_index, 0);
    assert_eq!(state.sparklines.read().unwrap()[0].sheet_index, 1, "the sparklines followed North");
    let regions = state.protected_regions.lock().unwrap();
    assert_eq!(
        regions.iter().find(|r| r.owner_id == pivot_owner).unwrap().sheet_index,
        1,
        "the pivot's protected region followed North"
    );
}

#[test]
fn adding_a_sheet_with_no_object_tail_is_a_plain_append() {
    let state = workbook_with_sheets(2);
    let file = FileState::default();

    let result = crate::sheets::add_sheet_inner(&state, &file, None, ::persistence::SheetKind::Worksheet).expect("add");
    assert_eq!(*state.active_sheet.read().unwrap(), 2);
    assert_eq!(result.sheets.len(), 3);
}

// ---------------------------------------------------------------------------
// 5. The shared name namespace
// ---------------------------------------------------------------------------

#[test]
fn adding_a_sheet_with_a_floating_ranges_name_is_refused() {
    let state = workbook_with_sheets(1);
    let file = FileState::default();
    append_object_sheet(&state, "Float1");

    crate::sheets::add_sheet_inner(&state, &file, Some("Float1".to_string()), ::persistence::SheetKind::Worksheet)
        .expect_err("the sheet namespace is shared with floating ranges");
    // Case-insensitively, like every other sheet-name collision.
    crate::sheets::add_sheet_inner(&state, &file, Some("FLOAT1".to_string()), ::persistence::SheetKind::Worksheet)
        .expect_err("sheet-name uniqueness ignores case");
}

// ---------------------------------------------------------------------------
// 6. Landing predicates treat object sheets as unlandable
// ---------------------------------------------------------------------------

#[test]
fn the_landing_predicates_treat_object_sheets_as_unlandable() {
    let vis = vec![
        "visible".to_string(),
        OBJECT_SHEET_VISIBILITY.to_string(),
        "hidden".to_string(),
    ];
    assert!(!crate::sheets::sheet_is_visible(&vis, 1));
    assert!(!crate::sheets::is_user_sheet(&vis, 1));
    assert!(crate::sheets::is_user_sheet(&vis, 2), "hidden is still a USER sheet");
    assert_eq!(
        crate::sheets::nearest_visible_sheet(&vis, 3, 1),
        0,
        "a delete landing computed onto an object sheet must be redirected"
    );
    assert_eq!(
        crate::sheets::visible_sheets_after_removing(&vis, 3, 2),
        1,
        "object sheets never count toward the last-visible-sheet guard"
    );
}
