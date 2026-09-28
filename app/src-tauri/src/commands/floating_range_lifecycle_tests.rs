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
            row_count: Some(5),
            col_count: Some(3),
            ..Default::default()
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
        FloatingRangePatch { x: Some(240.0), ..Default::default() },
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
    for patch in [
        FloatingRangePatch { row_count: Some(0), ..Default::default() },
        FloatingRangePatch {
            row_count: Some(crate::floating_range::MAX_FLOATING_RANGE_ROWS + 1),
            ..Default::default()
        },
        FloatingRangePatch {
            col_count: Some(crate::floating_range::MAX_FLOATING_RANGE_COLS + 1),
            ..Default::default()
        },
        FloatingRangePatch { x: Some(f64::NAN), ..Default::default() },
        FloatingRangePatch { x: Some(-1.0), ..Default::default() },
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
        &wb.pivots,
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
        &wb.pivots,
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
            // Chrome and cell sizes are part of the row, so the round trip must
            // carry them: NON-default combinations, because all-defaults would
            // pass even with the fields dropped on the way through.
            show_title: Some(false),
            show_column_headers: Some(true),
            show_row_headers: Some(false),
            col_widths: Some(std::collections::HashMap::from([(0u32, 96.0), (1u32, 32.0)])),
            row_heights: Some(std::collections::HashMap::from([(2u32, 44.0)])),
            ..Default::default()
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
    // The SIZE MAPS are the other half of "the frame is derived": lose them and
    // the object reopens at default widths, silently reflowing every column.
    assert_eq!(r.range.col_widths.get(&0), Some(&96.0));
    assert_eq!(r.range.col_widths.get(&1), Some(&32.0));
    assert_eq!(r.range.row_heights.get(&2), Some(&44.0));
    assert_eq!(r.range.col_widths.len(), 2, "no phantom entries were invented");
}

/// The edge-handle drag's write path. It sends WHOLE maps, so the interesting
/// properties are (a) a present map REPLACES rather than merges, (b) an absent
/// map leaves the stored one alone, and (c) out-of-bounds sizes are refused as
/// a whole rather than partly applied.
#[test]
fn update_replaces_size_maps_wholesale_and_refuses_out_of_bounds_sizes() {
    use std::collections::HashMap;
    let wb = Workbook::new(1);
    let info = create(&wb, None);
    let id = info.range.id;

    let set_widths = |map: HashMap<u32, f64>| {
        crate::floating_range::update_floating_range_inner(
            &wb.state,
            &wb.file,
            id,
            FloatingRangePatch { col_widths: Some(map), ..Default::default() },
        )
    };

    let a = set_widths(HashMap::from([(0u32, 80.0), (1u32, 90.0)])).expect("first map");
    assert_eq!(a.range.col_widths.len(), 2);

    // REPLACE, not merge: column 1's override must be gone.
    let b = set_widths(HashMap::from([(0u32, 50.0)])).expect("second map");
    assert_eq!(b.range.col_widths.get(&0), Some(&50.0));
    assert_eq!(b.range.col_widths.get(&1), None, "a whole-map write replaces");

    // An ABSENT map leaves the stored one alone (it is not "clear them").
    let c = crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        id,
        FloatingRangePatch { x: Some(11.0), ..Default::default() },
    )
    .expect("geometry-only patch");
    assert_eq!(c.range.col_widths.get(&0), Some(&50.0));

    for bad in [
        HashMap::from([(0u32, 0.0)]),
        HashMap::from([(0u32, -20.0)]),
        HashMap::from([(0u32, f64::NAN)]),
        HashMap::from([(0u32, crate::floating_range::MAX_FLOATING_RANGE_COL_W + 1.0)]),
        HashMap::from([(0u32, crate::floating_range::MIN_FLOATING_RANGE_COL_W - 1.0)]),
        HashMap::from([(crate::floating_range::MAX_FLOATING_RANGE_COLS, 40.0)]),
    ] {
        set_widths(bad).expect_err("out-of-bounds sizes must be refused");
    }
    // …and refused means UNCHANGED, not half-written.
    let after = crate::floating_range::list_floating_ranges_inner(&wb.state);
    assert_eq!(after[0].range.col_widths.get(&0), Some(&50.0));
}

/// Over IPC every JSON object key is a STRING, so the map arrives as
/// `{"0": 80}` and has to land in a `HashMap<u32, f64>`. If serde refused
/// integer keys from strings the whole edge-drag would deserialize-fail — a
/// silent no-op at the command boundary that no frontend test could see.
#[test]
fn a_patch_with_string_map_keys_deserializes_into_the_integer_keyed_map() {
    let patch: FloatingRangePatch = serde_json::from_str(
        r#"{"colWidths":{"0":80.5,"3":120.0},"rowHeights":{"2":31.0}}"#,
    )
    .expect("string keys must deserialize into u32-keyed maps");
    let widths = patch.col_widths.expect("colWidths present");
    assert_eq!(widths.get(&0), Some(&80.5));
    assert_eq!(widths.get(&3), Some(&120.0));
    assert_eq!(patch.row_heights.expect("rowHeights").get(&2), Some(&31.0));

    // And an omitted map must be None ("leave it alone"), never Some(empty)
    // ("clear every override").
    let bare: FloatingRangePatch = serde_json::from_str(r#"{"x":5.0}"#).expect("bare patch");
    assert!(bare.col_widths.is_none());
    assert!(bare.row_heights.is_none());
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

// ---------------------------------------------------------------------------
// GATES BEFORE THE EFFECT (owner finding 2026-09-27, fr-move diagnosis E)
//
// `DocumentEffect::mutates` dirties the document AT CONSTRUCTION, so every gate
// that can still refuse must run before it. The update used to build it BEFORE
// the id lookup (a stale id dirtied the document it then refused to change),
// and had no gate at all for a range on a SUBSCRIBED canvas -- the publisher's
// read-only layout, which the frontend refuses to drag but a script could move.
// ---------------------------------------------------------------------------

/// A canvas added (and made active), with a floating range created on it.
fn fr_on_new_canvas(wb: &Workbook) -> (usize, crate::api_types::FloatingRangeInfo) {
    let added = crate::sheets::add_sheet_inner(
        &wb.state,
        &wb.file,
        None,
        ::persistence::SheetKind::new_canvas(),
    )
    .expect("add a canvas");
    let canvas = added.active_index;
    let info = create(wb, None);
    assert_eq!(
        crate::floating_range::list_floating_ranges_inner(&wb.state)
            .into_iter()
            .find(|f| f.range.id == info.range.id)
            .map(|f| f.host_sheet_index),
        Some(canvas),
        "precondition: the range is hosted on the canvas"
    );
    (canvas, info)
}

/// Record sheet `index` as materialized by an application (the subscription
/// ledger `SheetProvenance` reads -- the same shape a pull writes).
fn subscribe_sheet(wb: &Workbook, index: usize) {
    let seed = crate::document_effect::test_seed_effect();
    let local = wb.state.sheet_ids.read().unwrap()[index];
    let name = wb.state.sheet_names.read().unwrap()[index].clone();
    let mut subs = wb.state.subscriptions.write(&seed).unwrap();
    subs.subscriptions.push(calp::manifest::Subscription {
        package_name: "Reports".to_string(),
        registry_url: "C:/workspace".to_string(),
        version_pin: "latest".to_string(),
        resolved_version: "1.0.0".to_string(),
        resolved_at: "2026-09-27T00:00:00Z".to_string(),
        sheets: vec![calp::manifest::SubscribedSheet {
            package_sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()),
            local_sheet_id: local,
            local_name: name,
            extra: std::collections::HashMap::new(),
        }],
        environment: None,
        data_source_configs: Vec::new(),
        objects: Vec::new(),
        detached_sheets: Vec::new(),
        detached_local_sheets: Vec::new(),
        upstream_removed_sheets: Vec::new(),
        extra: std::collections::HashMap::new(),
    });
}

fn row_x(wb: &Workbook, id: identity::EntityId) -> f64 {
    crate::floating_range::list_floating_ranges_inner(&wb.state)
        .into_iter()
        .find(|f| f.range.id == id)
        .expect("the range is listed")
        .range
        .x
}

#[test]
fn a_range_on_a_subscribed_canvas_refuses_geometry_and_leaves_the_document_clean() {
    let wb = Workbook::new(1);
    let (canvas, info) = fr_on_new_canvas(&wb);
    subscribe_sheet(&wb, canvas);
    crate::document_effect::mark_saved(&wb.file);
    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();

    for patch in [
        FloatingRangePatch { x: Some(400.0), ..Default::default() },
        FloatingRangePatch { row_count: Some(4), ..Default::default() },
        FloatingRangePatch { show_title: Some(false), ..Default::default() },
    ] {
        let err = crate::floating_range::update_floating_range_inner(
            &wb.state,
            &wb.file,
            info.range.id,
            patch,
        )
        .expect_err("a pulled canvas is the publisher's layout: read-only until detached");
        assert!(
            err.contains("Reports") && err.contains("Detach"),
            "the refusal names the application and the remedy, got: {err}"
        );
    }

    assert!(!wb.file.is_dirty(), "a refused update must not dirty the document");
    assert_eq!(row_x(&wb, info.range.id), 100.0, "the range did not move");
    assert_eq!(
        wb.state.undo_stack.lock().unwrap().undo_depth(),
        depth,
        "and no undo entry was recorded"
    );
}

#[test]
fn a_range_on_a_subscribed_worksheet_still_moves() {
    // The rule is the CANVAS's (canvas-sheets.md section 2): a subscribed
    // worksheet is editable by design (its edits go through the override
    // ledger) and the frontend offers the gestures there, so the backend must
    // not contradict it.
    let wb = Workbook::new(1);
    let info = create(&wb, None);
    subscribe_sheet(&wb, 0);

    let moved = crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        FloatingRangePatch { x: Some(300.0), ..Default::default() },
    )
    .expect("a range on a subscribed WORKSHEET moves");
    assert_eq!(moved.range.x, 300.0);
}

#[test]
fn a_range_on_an_unsubscribed_canvas_moves_and_dirties_once() {
    let wb = Workbook::new(1);
    let (_canvas, info) = fr_on_new_canvas(&wb);
    crate::document_effect::mark_saved(&wb.file);

    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        FloatingRangePatch { x: Some(160.0), y: Some(96.0), ..Default::default() },
    )
    .expect("an editable canvas's range moves");
    assert_eq!(row_x(&wb, info.range.id), 160.0);
    assert!(wb.file.is_dirty(), "a real change dirties the document");
}

#[test]
fn an_unknown_id_is_refused_without_dirtying_the_document() {
    let wb = Workbook::new(1);
    create(&wb, None);
    crate::document_effect::mark_saved(&wb.file);

    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        FloatingRangePatch { x: Some(10.0), ..Default::default() },
    )
    .expect_err("no such range");
    assert!(
        !wb.file.is_dirty(),
        "the lookup is a gate: it runs before DocumentEffect::mutates"
    );
}

#[test]
fn a_patch_that_changes_nothing_does_not_dirty_the_document() {
    let wb = Workbook::new(1);
    let info = create(&wb, None);
    crate::document_effect::mark_saved(&wb.file);

    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        FloatingRangePatch { x: Some(100.0), y: Some(50.0), ..Default::default() },
    )
    .expect("a no-op patch is not an error");
    assert!(
        !wb.file.is_dirty(),
        "a patch that changes nothing is not an edit: the effect is built only on the changing branch"
    );
}

// ---------------------------------------------------------------------------
// SHEET PROTECTION ("Edit objects") -- review 2026-09-27 findings 1 and 12.
//
// A floating range is an OBJECT on its host sheet. Since the title bar moves a
// range outside Design Mode, a plain drag on a protected sheet reached
// `update_floating_range` -- which asked about the subscribed canvas and never
// about protection -- while a chart, a control, a slicer and a timeline on the
// same sheet refused the same drag. Every authoring door asks the HOST now.
// ---------------------------------------------------------------------------

/// Protect sheet `index` with Excel's DEFAULT options ("Edit objects" off).
fn protect_with_defaults(wb: &Workbook, index: usize) {
    wb.state
        .sheet_protection
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert(
            index,
            crate::protection::SheetProtection { protected: true, ..Default::default() },
        );
}

#[test]
fn a_protected_host_refuses_every_geometry_patch_and_leaves_the_document_clean() {
    let wb = Workbook::new(1);
    let info = create(&wb, None);
    protect_with_defaults(&wb, 0);
    crate::document_effect::mark_saved(&wb.file);
    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();

    for patch in [
        // The title-bar drag (x only), the menu's Add Row, the edge-ball cell
        // scale, and a Properties chrome toggle.
        FloatingRangePatch { x: Some(200.0), ..Default::default() },
        FloatingRangePatch { row_count: Some(3), ..Default::default() },
        FloatingRangePatch {
            col_widths: Some([(0u32, 120.0f64)].into_iter().collect()),
            ..Default::default()
        },
        FloatingRangePatch { show_title: Some(false), ..Default::default() },
    ] {
        let err = crate::floating_range::update_floating_range_inner(
            &wb.state,
            &wb.file,
            info.range.id,
            patch,
        )
        .expect_err("a protected host without 'Edit objects' refuses the object edit");
        assert!(
            err.contains("protected sheet") && err.contains("floating range"),
            "the refusal names the protection and the object, got: {err}"
        );
    }

    let row = crate::floating_range::list_floating_ranges_inner(&wb.state)
        .into_iter()
        .find(|f| f.range.id == info.range.id)
        .expect("the range is listed");
    assert_eq!(row.range.x, 100.0, "the range did not move");
    assert_eq!(row.range.row_count, 1, "nor grow");
    assert!(row.range.col_widths.is_empty(), "nor rescale");
    assert!(row.range.show_title, "nor lose its title");
    assert!(!wb.file.is_dirty(), "a refused patch must not dirty the document");
    assert_eq!(
        wb.state.undo_stack.lock().unwrap().undo_depth(),
        depth,
        "and no undo entry was recorded"
    );
}

#[test]
fn a_protected_host_that_allows_edit_objects_still_moves_its_range() {
    // The gate is the OPTION, not protection as such: Excel's "Edit objects"
    // checkbox lets a protected sheet's objects move.
    let wb = Workbook::new(1);
    let info = create(&wb, None);
    let mut protection = crate::protection::SheetProtection { protected: true, ..Default::default() };
    protection.options.allow_edit_objects = true;
    wb.state
        .sheet_protection
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert(0, protection);

    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        FloatingRangePatch { x: Some(240.0), ..Default::default() },
    )
    .expect("'Edit objects' allowed: the object moves");
    assert_eq!(row_x(&wb, info.range.id), 240.0);
}

#[test]
fn a_protected_host_refuses_a_new_floating_range_and_stays_clean() {
    let wb = Workbook::new(1);
    protect_with_defaults(&wb, 0);
    crate::document_effect::mark_saved(&wb.file);
    let sheets_before = wb.state.sheet_names.read().unwrap().len();

    let err = crate::floating_range::create_floating_range_inner(
        &wb.state,
        &wb.file,
        None,
        100.0,
        50.0,
    )
    .expect_err("inserting an object is an object edit (save_chart parity)");
    assert!(err.contains("protected sheet"), "got: {err}");
    assert!(crate::floating_range::list_floating_ranges_inner(&wb.state).is_empty());
    assert_eq!(
        wb.state.sheet_names.read().unwrap().len(),
        sheets_before,
        "no backing sheet was appended"
    );
    assert!(!wb.file.is_dirty(), "a refused create must not dirty the document");
}

#[test]
fn a_protected_host_refuses_the_users_rename_and_delete() {
    let wb = Workbook::new(1);
    let tl = timeline();
    let info = create(&wb, None);
    protect_with_defaults(&wb, 0);
    crate::document_effect::mark_saved(&wb.file);

    crate::floating_range::rename_floating_range_inner(
        &wb.state,
        &wb.file,
        &wb.pivots,
        info.range.id,
        "Rates".to_string(),
    )
    .expect_err("a protected host's object keeps its name");
    let err = crate::floating_range::delete_floating_range_impl(
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
    .expect_err("a protected host's object cannot be deleted");
    assert!(err.contains("protected sheet"), "got: {err}");

    let listed = crate::floating_range::list_floating_ranges_inner(&wb.state);
    assert_eq!(listed.len(), 1, "the range survived");
    assert_eq!(listed[0].name, info.name, "under its own name");
    assert!(!wb.file.is_dirty(), "a refused rename/delete must not dirty the document");
}

#[test]
fn deleting_a_protected_host_sheet_still_cascades_its_floating_ranges() {
    // The object gate belongs to the USER's delete, never the cascade: deleting
    // the host sheet is workbook STRUCTURE (unprotected here), and a gate on
    // the dying host's object option would strand the cascade halfway.
    let wb = Workbook::new(2);
    let tl = timeline();
    wb.switch_to(1);
    let info = create(&wb, None);
    assert_eq!(info.host_sheet_index, 1);
    protect_with_defaults(&wb, 1);
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
    .expect("delete the protected host sheet");
    assert!(
        crate::floating_range::list_floating_ranges_inner(&wb.state).is_empty(),
        "the floating range died with its protected host"
    );
}

// ---------------------------------------------------------------------------
// CREATE on a SUBSCRIBED canvas -- review 2026-09-27 finding 2.
//
// The update refuses a pulled canvas's ranges; the create did not, so a
// script's create-then-resize appended a 1x1 range to the publisher's layout,
// was refused on the resize, and left a non-undoable orphan nobody could size,
// move or open.
// ---------------------------------------------------------------------------

#[test]
fn create_on_a_subscribed_canvas_is_refused_and_the_document_stays_clean() {
    let wb = Workbook::new(1);
    let added = crate::sheets::add_sheet_inner(
        &wb.state,
        &wb.file,
        None,
        ::persistence::SheetKind::new_canvas(),
    )
    .expect("add a canvas");
    subscribe_sheet(&wb, added.active_index);
    crate::document_effect::mark_saved(&wb.file);
    let sheets_before = wb.state.sheet_names.read().unwrap().len();

    let err = crate::floating_range::create_floating_range_inner(
        &wb.state,
        &wb.file,
        None,
        100.0,
        50.0,
    )
    .expect_err("a pulled canvas is the publisher's layout: no new object on it");
    assert!(
        err.contains("Reports") && err.contains("Detach"),
        "the refusal names the application and the remedy, got: {err}"
    );
    assert!(crate::floating_range::list_floating_ranges_inner(&wb.state).is_empty());
    assert_eq!(wb.state.sheet_names.read().unwrap().len(), sheets_before);
    assert!(!wb.file.is_dirty(), "a refused create must not dirty the document");
}
