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
//!   3. The sheet lifecycle commands refuse object sheets (hide/unhide pinned
//!      here; delete/rename/move/copy share the same `ensure_user_sheet` gate).
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
    crate::sheets::build_sheet_list(
        &sheet_names,
        &freeze_configs,
        &tab_colors,
        &sheet_visibility,
        &sheet_ids,
        &sheet_kinds,
    )
        .into_iter()
        .map(|s| (s.index, s.name))
        .collect()
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
