//! FILENAME: app/src-tauri/src/commands/floating_range_lifecycle_tests.rs
//! PURPOSE: Floating Range LIFECYCLE (M2) — create / update / rename / delete
//!          over object-backed sheets, and the undo doctrine each one carries.
//!
//! Reuses the `cross_sheet_recalc_tests::Workbook` harness (the ONE way tests
//! stand up a multi-sheet AppState with every auxiliary State constructed).
//!
//! The doctrine under test (module doc of `floating_range.rs`):
//!   * CREATE keeps the undo history (pure append — nothing renumbered).
//!   * DELETE and RENAME end it (sheet-structural, BUG-0005's reasons).
//!   * GEOMETRY / WINDOW patches are undoable via `obj_floating_range`.
//!   * A visibility-vector undo restore must never resurrect a backing sheet
//!     (`reassert_object_sheet_markers` — the authority is the row store).

use super::cross_sheet_recalc_tests::Workbook;
use crate::api_types::FloatingRangePatch;
use crate::sheets::OBJECT_SHEET_VISIBILITY;

fn timeline() -> crate::timeline_slicer::TimelineSlicerState {
    crate::timeline_slicer::TimelineSlicerState::new()
}

fn create(wb: &Workbook, name: Option<&str>) -> crate::api_types::FloatingRangeInfo {
    crate::floating_range::create_floating_range_inner(
        &wb.state,
        &wb.file,
        name.map(|s| s.to_string()),
        100.0,
        50.0,
    )
    .expect("create floating range")
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

#[test]
fn create_appends_an_object_sheet_and_a_row_without_touching_the_user() {
    let wb = Workbook::new(1);
    // Something on the undo stack, to prove create does NOT end the history.
    wb.set(0, 0, "1");
    assert!(wb.state.undo_stack.lock().unwrap().can_undo(), "precondition");

    let info = create(&wb, None);

    assert_eq!(info.name, "Float1", "default stem is Float{{n}}");
    assert_eq!(info.range.row_count, 1);
    assert_eq!(info.range.col_count, 1);
    assert_eq!(info.backing_sheet_index, 1);
    assert_eq!(
        wb.state.sheet_visibility.read().unwrap()[1],
        OBJECT_SHEET_VISIBILITY
    );
    assert_eq!(
        *wb.state.active_sheet.read().unwrap(),
        0,
        "creating a floating range must not move the user"
    );
    assert!(
        wb.state.undo_stack.lock().unwrap().can_undo(),
        "CREATE keeps the undo history — a pure append invalidates nothing"
    );
    assert_eq!(
        wb.state.undo_stack.lock().unwrap().cleared_total(),
        0,
        "and nothing was discarded"
    );

    // The host is the sheet the user was on.
    let host_id = wb.state.sheet_ids.read().unwrap()[0];
    assert_eq!(info.range.host_sheet_id, host_id);

    // The evaluator can see it: the name is a real sheet name.
    assert_eq!(wb.state.sheet_names.read().unwrap()[1], "Float1");
}

#[test]
fn create_refuses_a_name_a_sheet_already_holds_and_vice_versa() {
    let wb = Workbook::new(2);
    crate::floating_range::create_floating_range_inner(
        &wb.state,
        &wb.file,
        Some("Sheet2".to_string()),
        0.0,
        0.0,
    )
    .expect_err("the namespace is shared with sheets");

    create(&wb, Some("Budget"));
    crate::floating_range::create_floating_range_inner(
        &wb.state,
        &wb.file,
        Some("BUDGET".to_string()),
        0.0,
        0.0,
    )
    .expect_err("uniqueness ignores case, like every sheet-name collision");
}

#[test]
fn the_default_name_counter_skips_taken_names() {
    let wb = Workbook::new(1);
    create(&wb, Some("Float1"));
    let second = create(&wb, None);
    assert_eq!(second.name, "Float2");
}

// ---------------------------------------------------------------------------
// UPDATE (geometry + window) — undoable
// ---------------------------------------------------------------------------

#[test]
fn update_patches_geometry_and_window_and_records_an_undo_entry() {
    let wb = Workbook::new(1);
    let info = create(&wb, None);
    let before_depth = wb.state.undo_stack.lock().unwrap().undo_depth();

    let updated = crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        FloatingRangePatch {
            x: Some(240.0),
            y: None,
            row_count: Some(5),
            col_count: Some(3),
            show_title: None,
            show_column_headers: None,
            show_row_headers: None,
        },
    )
    .expect("update");

    assert_eq!(updated.range.x, 240.0);
    assert_eq!(updated.range.y, 50.0, "absent fields stay untouched");
    assert_eq!(updated.range.row_count, 5);
    assert_eq!(updated.range.col_count, 3);
    assert_eq!(
        wb.state.undo_stack.lock().unwrap().undo_depth(),
        before_depth + 1,
        "a real change records exactly one undo entry"
    );

    // A no-op patch must NOT burn an undo step.
    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        FloatingRangePatch {
            x: Some(240.0),
            y: None,
            row_count: None,
            col_count: None,
            show_title: None,
            show_column_headers: None,
            show_row_headers: None,
        },
    )
    .expect("no-op update");
    assert_eq!(
        wb.state.undo_stack.lock().unwrap().undo_depth(),
        before_depth + 1,
        "a patch that changes nothing records nothing"
    );
}

#[test]
fn update_refuses_out_of_bounds_windows() {
    let wb = Workbook::new(1);
    let info = create(&wb, None);
    let no_chrome_change = FloatingRangePatch {
        x: None,
        y: None,
        row_count: None,
        col_count: None,
        show_title: None,
        show_column_headers: None,
        show_row_headers: None,
    };
    for patch in [
        FloatingRangePatch { row_count: Some(0), ..no_chrome_change.clone() },
        FloatingRangePatch {
            row_count: Some(crate::floating_range::MAX_FLOATING_RANGE_ROWS + 1),
            ..no_chrome_change.clone()
        },
        FloatingRangePatch {
            col_count: Some(crate::floating_range::MAX_FLOATING_RANGE_COLS + 1),
            ..no_chrome_change.clone()
        },
        FloatingRangePatch { x: Some(f64::NAN), ..no_chrome_change.clone() },
        FloatingRangePatch { x: Some(-1.0), ..no_chrome_change.clone() },
    ] {
        crate::floating_range::update_floating_range_inner(&wb.state, &wb.file, info.range.id, patch)
            .expect_err("bounds must refuse");
    }
}

// ---------------------------------------------------------------------------
// RENAME — through the sheet machinery, ends the history
// ---------------------------------------------------------------------------

#[test]
fn rename_renames_the_backing_sheet_and_ends_the_history() {
    let wb = Workbook::new(1);
    let info = create(&wb, None);
    wb.set(0, 0, "1"); // something to lose
    assert!(wb.state.undo_stack.lock().unwrap().can_undo());

    let renamed = crate::floating_range::rename_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        "Rates".to_string(),
    )
    .expect("rename");

    assert_eq!(renamed.name, "Rates");
    assert_eq!(wb.state.sheet_names.read().unwrap()[1], "Rates");
    assert!(
        !wb.state.undo_stack.lock().unwrap().can_undo(),
        "RENAME ends the undo history — it rewrites formulas workbook-wide \
         and the queued `previous` cells still spell the old name"
    );

    // Collisions refused both ways.
    crate::floating_range::rename_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        "Sheet1".to_string(),
    )
    .expect_err("a floating range cannot take a sheet's name");
}

// ---------------------------------------------------------------------------
// DELETE — through the sheet machinery, ends the history
// ---------------------------------------------------------------------------

#[test]
fn delete_removes_the_row_and_the_backing_sheet() {
    let wb = Workbook::new(1);
    let tl = timeline();
    let info = create(&wb, None);
    wb.set(0, 0, "1");
    assert!(wb.state.undo_stack.lock().unwrap().can_undo());

    crate::floating_range::delete_floating_range_inner(
        &wb.state,
        &wb.file,
        &wb.pivots,
        &wb.files,
        &wb.pane,
        &wb.filters,
        &wb.slicer,
        &tl,
        info.range.id,
    )
    .expect("delete");

    assert!(crate::floating_range::list_floating_ranges_inner(&wb.state).is_empty());
    assert_eq!(
        wb.state.sheet_names.read().unwrap().len(),
        1,
        "the backing sheet is gone from the workbook"
    );
    assert!(
        !wb.state.undo_stack.lock().unwrap().can_undo(),
        "DELETE ends the undo history — it renumbers sheet indices"
    );
}

#[test]
fn deleting_the_host_sheet_cascades_its_floating_ranges() {
    let wb = Workbook::new(2);
    let tl = timeline();
    // Host the floating range on Sheet2.
    wb.switch_to(1);
    let info = create(&wb, None);
    assert_eq!(info.host_sheet_index, 1);
    wb.switch_to(0);

    crate::sheets::delete_sheet_impl(
        &wb.state,
        &wb.file,
        &wb.pivots,
        &wb.files,
        &wb.pane,
        &wb.filters,
        &wb.slicer,
        &tl,
        1,
        false,
    )
    .expect("delete the host sheet");

    assert!(
        crate::floating_range::list_floating_ranges_inner(&wb.state).is_empty(),
        "the floating range died with its host (Sheet → floatingRange.hostSheet, Cascade)"
    );
    assert_eq!(
        wb.state.sheet_names.read().unwrap().len(),
        1,
        "host AND backing sheet are both gone"
    );
    let vis = wb.state.sheet_visibility.read().unwrap();
    assert!(
        !vis.iter().any(|v| v == OBJECT_SHEET_VISIBILITY),
        "no orphaned object sheet survives the cascade"
    );
}

// ---------------------------------------------------------------------------
// Persistence round trip (M4)
// ---------------------------------------------------------------------------

/// A `persistence::Workbook` whose sheet list mirrors the live state's ids,
/// names and visibility — what the restore half reads its repair truth from.
fn file_workbook_mirroring(wb: &Workbook) -> persistence::Workbook {
    let mut file_wb = persistence::Workbook::new();
    let names = wb.state.sheet_names.read().unwrap();
    let ids = wb.state.sheet_ids.read().unwrap();
    let vis = wb.state.sheet_visibility.read().unwrap();
    file_wb.sheets = names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let mut sheet = persistence::Sheet::new(name.clone());
            sheet.id = ids[i];
            sheet.visibility = vis.get(i).cloned().unwrap_or_else(|| "visible".to_string());
            sheet
        })
        .collect();
    file_wb
}

#[test]
fn floating_ranges_survive_a_collect_restore_round_trip() {
    let wb = Workbook::new(1);
    let info = create(&wb, Some("Rates"));
    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        FloatingRangePatch {
            x: Some(120.0),
            y: Some(80.0),
            row_count: Some(4),
            col_count: Some(2),
            // Chrome is part of the row, so the round trip must carry it: this
            // asserts a NON-default combination survives save -> restore.
            show_title: Some(false),
            show_column_headers: Some(true),
            show_row_headers: Some(false),
        },
    )
    .expect("shape it");

    let saved = crate::persistence::collect_floating_ranges_for_save(&wb.state);
    assert_eq!(saved.len(), 1);
    let mut file_wb = file_workbook_mirroring(&wb);
    file_wb.floating_ranges = saved.clone();

    // Wipe (what reset_document_scoped_stores does on open) and restore.
    wb.state
        .floating_ranges
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .clear();
    crate::persistence::restore_floating_ranges(&saved, &wb.state, &file_wb);

    let restored = crate::floating_range::list_floating_ranges_inner(&wb.state);
    assert_eq!(restored.len(), 1);
    let r = &restored[0];
    assert_eq!(r.range.id, info.range.id);
    assert_eq!(r.name, "Rates");
    assert_eq!((r.range.x, r.range.y), (120.0, 80.0));
    assert_eq!((r.range.row_count, r.range.col_count), (4, 2));
    assert_eq!(r.backing_sheet_index, info.backing_sheet_index);
    // The three flags must survive INDEPENDENTLY. A `#[serde(default)]` on a
    // bool defaults to FALSE, so a mixed combination is the only one that can
    // tell "carried through" apart from "reset to the derived default" — all
    // three false would pass with the flags dropped entirely.
    assert_eq!(
        (
            r.range.show_title,
            r.range.show_column_headers,
            r.range.show_row_headers
        ),
        (false, true, false),
        "chrome visibility must round-trip field by field"
    );
}

/// The JSON shape, not just the in-process struct copy: a file written before
/// the chrome flags existed has no such keys, and `default_true` is what makes
/// it reopen with its title bar and headers instead of a bare block of cells.
#[test]
fn a_saved_row_without_chrome_keys_loads_with_all_chrome_shown() {
    let json = r#"{
        "id": "01890000-0000-7000-8000-000000000001",
        "backingSheetId": "01890000-0000-7000-8000-000000000002",
        "hostSheetId": "01890000-0000-7000-8000-000000000003",
        "x": 10.0,
        "y": 20.0,
        "rowCount": 3,
        "colCount": 2
    }"#;
    let saved: ::persistence::SavedFloatingRange =
        serde_json::from_str(json).expect("a pre-chrome row must still parse");
    assert!(saved.show_title);
    assert!(saved.show_column_headers);
    assert!(saved.show_row_headers);
}

#[test]
fn a_row_whose_backing_sheet_is_missing_is_dropped_on_load() {
    let wb = Workbook::new(1);
    create(&wb, None);
    let mut saved = crate::persistence::collect_floating_ranges_for_save(&wb.state);
    let file_wb = file_workbook_mirroring(&wb);
    saved[0].backing_sheet_id = identity::SheetId::from_bytes(identity::generate_uuid_v7());

    crate::persistence::restore_floating_ranges(&saved, &wb.state, &file_wb);
    assert!(
        crate::floating_range::list_floating_ranges_inner(&wb.state).is_empty(),
        "a row that can render nothing and address nothing must not be kept"
    );
}

// ---------------------------------------------------------------------------
// The visibility-restore hazard
// ---------------------------------------------------------------------------

#[test]
fn a_visibility_restore_recorded_before_the_range_existed_cannot_resurrect_its_sheet() {
    let wb = Workbook::new(2);
    // 1. Hide Sheet2 — records a whole-vector visibility snapshot.
    crate::sheets::hide_sheet_inner(&wb.state, &wb.file, 1, None).expect("hide");
    // 2. NOW create a floating range: the sheet count grows, the history
    //    survives (create keeps it), and the queued snapshot predates the
    //    object sheet entirely.
    create(&wb, None);
    assert_eq!(
        wb.state.sheet_visibility.read().unwrap()[2],
        OBJECT_SHEET_VISIBILITY,
        "precondition"
    );

    // 3. Undo the hide: pop the transaction and replay its restore arm, the
    //    way sheet_tab_state_undo_tests drives it (the `undo` command needs an
    //    AppHandle and cannot run in-process).
    let transaction = wb
        .state
        .undo_stack
        .lock()
        .unwrap()
        .pop_undo()
        .expect("the hide recorded an entry and create did not clear it");
    let mut inverse = engine::undo::Transaction::new("inverse");
    for change in transaction.changes.iter().rev() {
        if let engine::undo::CellChange::CustomRestore { kind, data } = change {
            assert_eq!(kind, crate::undo_commands::SHEET_TAB_STATE_RESTORE_KIND);
            crate::undo_commands::apply_sheet_tab_state_restore(
                &wb.state,
                &crate::document_effect::test_seed_effect(),
                data,
                &mut inverse,
            );
        }
    }

    let vis = wb.state.sheet_visibility.read().unwrap();
    assert_eq!(vis[1], "visible", "the hide was undone");
    assert_eq!(
        vis[2], OBJECT_SHEET_VISIBILITY,
        "the object marker survived the wholesale vector restore — without \
         reassert_object_sheet_markers the pad would stamp it \"visible\" and \
         put the floating range's cell store on the tab bar"
    );
}
