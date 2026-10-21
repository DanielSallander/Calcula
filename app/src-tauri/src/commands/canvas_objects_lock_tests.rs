//! FILENAME: app/src-tauri/src/commands/canvas_objects_lock_tests.rs
//! PURPOSE: CONTRACT-CANVAS 4.7 -- a canvas's WALLPAPER and LOCK OBJECTS.
//!
//! `CanvasLayout` gained `wallpaper` (the colour of the area OUTSIDE the page)
//! and `objects_locked` (Power BI's View > Lock objects: "Lock all objects on
//! the canvas so that they can't be moved or resized"). What is pinned here:
//!
//!   1. `set_canvas_layout` applies, validates and refuses the two fields like
//!      the page background: a bad wallpaper is refused with the document
//!      clean; neither field records an undo step (D1: page/view state).
//!   2. While a page is locked, EVERY geometry door refuses a write that would
//!      MOVE or RESIZE an object on it -- chart (the store's update and upsert,
//!      and the AI tool's), control (the geometry batch, a single x/y/width/
//!      height property, an anchor move), slicer, timeline, floating range and
//!      canvas pivot box -- BEFORE its effect: the document stays clean, no
//!      undo step is recorded and the object stays where it was.
//!   3. What the lock does NOT stop, because Power BI's does not either: a
//!      write that leaves the geometry as it is (a re-sync), a FORMAT edit
//!      (a title, a caption, a rotation, a slicer's name, a floating range's
//!      chrome), a DELETE, an INSERT, and everything on an UNLOCKED page or a
//!      WORKSHEET. Each refusal test carries its positive control in the same
//!      test, so an `is_err()` that passes for an unrelated reason is caught.
//!
//! Reuses the `cross_sheet_recalc_tests::Workbook` harness, like
//! `canvas_sheet_tests.rs`.

use super::cross_sheet_recalc_tests::Workbook;
use crate::api_types::{CanvasLayoutPatch, ChartEntry, ControlGeometryChange, FloatingRangePatch};
use crate::controls::{ControlMetadata, ControlPropertyValue};
use persistence::{CanvasLayout, SheetKind};

fn add_canvas(wb: &Workbook) -> usize {
    crate::sheets::add_sheet_inner(&wb.state, &wb.file, None, SheetKind::new_canvas())
        .expect("add a canvas sheet")
        .active_index
}

fn layout(wb: &Workbook, index: usize) -> CanvasLayout {
    match &wb.state.sheet_kinds.read().unwrap()[index] {
        SheetKind::Canvas(l) => l.clone(),
        other => panic!("sheet {index} is not a canvas: {other:?}"),
    }
}

fn patch(wb: &Workbook, index: usize, p: CanvasLayoutPatch) -> Result<CanvasLayout, String> {
    crate::sheets::set_canvas_layout_inner(&wb.state, &wb.file, Some(index), &p).map(|c| c.layout)
}

fn lock(wb: &Workbook, index: usize, on: bool) {
    patch(wb, index, CanvasLayoutPatch { objects_locked: Some(on), ..Default::default() }).expect("toggle Lock Objects");
    assert_eq!(layout(wb, index).objects_locked, on, "precondition: the page lock is {on}");
}

fn undo_depth(wb: &Workbook) -> usize {
    wb.state.undo_stack.lock().unwrap().undo_depth()
}

/// A refusal BY THE PAGE LOCK: the message names the lock and the remedy.
fn assert_refused_by_lock<T: std::fmt::Debug>(result: Result<T, String>, door: &str) {
    match result {
        Ok(v) => panic!("{door}: a locked page must refuse the move, got Ok({v:?})"),
        Err(e) => assert!(
            e.contains("Lock Objects"),
            "{door}: the refusal must name Lock Objects so the user knows the remedy, got: {e}"
        ),
    }
}

/// Run `refused` against a CLEAN document and prove it changed nothing the
/// user could see: still clean, no undo step.
fn assert_clean_refusal<T: std::fmt::Debug>(wb: &Workbook, door: &str, refused: impl FnOnce() -> Result<T, String>) {
    crate::document_effect::mark_saved(&wb.file);
    let depth = undo_depth(wb);
    assert_refused_by_lock(refused(), door);
    assert!(!wb.file.is_dirty(), "{door}: a refused move must leave the document clean");
    assert_eq!(undo_depth(wb), depth, "{door}: a refused move must record no undo step");
}

// ---------------------------------------------------------------------------
// 1. The layout fields
// ---------------------------------------------------------------------------

#[test]
fn the_layout_command_sets_and_clears_wallpaper_and_lock_and_records_no_undo_step() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    crate::document_effect::mark_saved(&wb.file);
    let depth = undo_depth(&wb);

    let next = patch(
        &wb,
        canvas,
        CanvasLayoutPatch { wallpaper: Some(" #101820 ".to_string()), objects_locked: Some(true), ..Default::default() },
    )
    .expect("a hex wallpaper and the lock apply");
    assert_eq!(next.wallpaper, "#101820", "the wallpaper is trimmed like the background");
    assert!(next.objects_locked);
    assert_eq!(layout(&wb, canvas), next, "the command returns what it stored");
    assert!(wb.file.is_dirty(), "both are persisted, so setting them dirties the document");
    assert_eq!(undo_depth(&wb), depth, "page/view state is not undoable (D1)");

    patch(&wb, canvas, CanvasLayoutPatch { wallpaper: Some(String::new()), objects_locked: Some(false), ..Default::default() })
        .expect("\"\" and false restore the defaults");
    let back = layout(&wb, canvas);
    assert_eq!((back.wallpaper.as_str(), back.objects_locked), ("", false));

    // A bad wallpaper is refused before the effect.
    crate::document_effect::mark_saved(&wb.file);
    let err = patch(&wb, canvas, CanvasLayoutPatch { wallpaper: Some("tomato".to_string()), ..Default::default() })
        .expect_err("a named colour is not a hex colour");
    assert!(err.contains("wallpaper"), "{err}");
    assert!(!wb.file.is_dirty(), "a refused patch leaves the document clean");

    // The new presets apply through the same command and set their size.
    let tooltip = patch(&wb, canvas, CanvasLayoutPatch { page_preset: Some("tooltip".to_string()), ..Default::default() })
        .expect("Tooltip is a preset");
    assert_eq!((tooltip.page_width, tooltip.page_height), (320, 240));
    let fhd = patch(&wb, canvas, CanvasLayoutPatch { page_preset: Some("16:9-fhd".to_string()), ..Default::default() })
        .expect("16:9 Full HD is a preset");
    assert_eq!((fhd.page_width, fhd.page_height), (1920, 1080));
}

#[test]
fn a_worksheet_has_no_page_to_lock() {
    let wb = Workbook::new(1);
    let err = patch(&wb, 0, CanvasLayoutPatch { objects_locked: Some(true), ..Default::default() })
        .expect_err("a worksheet is not a canvas");
    assert!(err.contains("not a canvas"), "{err}");
}

// ---------------------------------------------------------------------------
// 2. Each geometry door, locked vs unlocked
// ---------------------------------------------------------------------------

fn chart_on(sheet_index: usize, x: f64) -> ChartEntry {
    ChartEntry {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        sheet_index,
        spec_json: serde_json::json!({
            "chartId": "c", "name": "Chart 1", "sheetIndex": sheet_index,
            "x": x, "y": 40.0, "width": 480.0, "height": 300.0,
            "spec": { "mark": "bar", "title": "Sales" }
        })
        .to_string(),
    }
}

fn with_json(entry: &ChartEntry, edit: impl FnOnce(&mut serde_json::Value)) -> ChartEntry {
    let mut v: serde_json::Value = serde_json::from_str(&entry.spec_json).unwrap();
    edit(&mut v);
    ChartEntry { id: entry.id, sheet_index: entry.sheet_index, spec_json: v.to_string() }
}

fn stored_chart_x(wb: &Workbook, id: identity::EntityId) -> f64 {
    let charts = wb.state.charts.read().unwrap();
    let json: serde_json::Value = serde_json::from_str(&charts.iter().find(|c| c.id == id).unwrap().spec_json).unwrap();
    json["x"].as_f64().unwrap()
}

#[test]
fn a_locked_page_refuses_a_chart_move_or_resize_but_takes_a_format_edit() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    let chart = chart_on(canvas, 100.0);
    wb.state.charts.write(&crate::document_effect::test_seed_effect()).unwrap().push(chart.clone());
    lock(&wb, canvas, true);

    let moved = with_json(&chart, |v| v["x"] = serde_json::json!(260.0));
    assert_clean_refusal(&wb, "update_chart (move)", || {
        crate::chart_commands::update_chart_core(&wb.state, &wb.file, moved.clone(), None)
    });
    let resized = with_json(&chart, |v| v["width"] = serde_json::json!(600.0));
    assert_clean_refusal(&wb, "update_chart (resize)", || {
        crate::chart_commands::update_chart_core(&wb.state, &wb.file, resized.clone(), None)
    });
    assert_clean_refusal(&wb, "save_chart (an upsert that moves)", || {
        crate::chart_commands::save_chart_core(&wb.state, &wb.file, moved.clone())
    });
    assert_eq!(stored_chart_x(&wb, chart.id), 100.0, "the chart stayed where it was");

    // A FORMAT edit keeps the geometry: allowed on a locked page.
    let retitled = with_json(&chart, |v| v["spec"]["title"] = serde_json::json!("Revenue"));
    crate::chart_commands::update_chart_core(&wb.state, &wb.file, retitled, None)
        .expect("formatting a chart on a locked page is allowed");

    // POSITIVE CONTROL: the same move on the unlocked page goes through.
    lock(&wb, canvas, false);
    crate::chart_commands::update_chart_core(&wb.state, &wb.file, moved, None).expect("an unlocked page moves");
    assert_eq!(stored_chart_x(&wb, chart.id), 260.0);
}

#[test]
fn a_locked_page_refuses_the_ai_tools_chart_placement() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    let chart = chart_on(canvas, 100.0);
    wb.state.charts.write(&crate::document_effect::test_seed_effect()).unwrap().push(chart.clone());
    lock(&wb, canvas, true);
    let effect = crate::document_effect::test_seed_effect();
    let place = crate::mcp::objects::ChartPlacement { x: Some(300.0), ..Default::default() };
    let id = chart.id.to_string();
    assert_refused_by_lock(
        crate::mcp::objects::update_chart_core(&wb.state, &effect, &id, None, None, None, &place),
        "mcp update_chart",
    );
    assert_eq!(stored_chart_x(&wb, chart.id), 100.0);
    // A rename only: allowed.
    crate::mcp::objects::update_chart_core(&wb.state, &effect, &id, None, Some("Renamed"), None, &Default::default())
        .expect("a rename is not a move");
    lock(&wb, canvas, false);
    crate::mcp::objects::update_chart_core(&wb.state, &effect, &id, None, None, None, &place).expect("unlocked moves");
    assert_eq!(stored_chart_x(&wb, chart.id), 300.0);
}

fn shape_at(wb: &Workbook, sheet_index: usize, row: u32, col: u32) -> (usize, u32, u32) {
    let mut properties = std::collections::HashMap::new();
    for (name, value) in [("x", "600"), ("y", "40"), ("width", "80"), ("height", "28"), ("pinToGrid", "false"), ("text", "Hi")] {
        properties.insert(
            name.to_string(),
            ControlPropertyValue { value_type: "static".to_string(), value: value.to_string() },
        );
    }
    wb.state
        .controls
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert((sheet_index, row, col), ControlMetadata { control_type: "shape".to_string(), uid: String::new(), properties });
    (sheet_index, row, col)
}

fn control_prop(wb: &Workbook, key: (usize, u32, u32), name: &str) -> Option<String> {
    wb.state.controls.read().unwrap().get(&key).and_then(|m| m.properties.get(name)).map(|p| p.value.clone())
}

fn geometry(key: (usize, u32, u32), x: f64) -> ControlGeometryChange {
    ControlGeometryChange {
        sheet_index: key.0,
        row: key.1,
        col: key.2,
        x,
        y: 40.0,
        width: 80.0,
        height: 28.0,
        offset_x: None,
        offset_y: None,
    }
}

fn set_prop(wb: &Workbook, key: (usize, u32, u32), name: &str, value: &str) -> Result<ControlMetadata, String> {
    crate::controls::set_control_property_core(
        &wb.state,
        &wb.file,
        key.0,
        key.1,
        key.2,
        "shape".to_string(),
        name.to_string(),
        "static".to_string(),
        value.to_string(),
    )
}

#[test]
fn a_locked_page_refuses_every_control_geometry_door_but_not_format_or_delete() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    let shape = shape_at(&wb, canvas, 0, 0);
    let other = shape_at(&wb, canvas, 0, 1);
    lock(&wb, canvas, true);

    assert_clean_refusal(&wb, "set_control_geometry", || {
        crate::controls::set_control_geometry_core(&wb.state, &wb.file, &[geometry(shape, 640.0)])
    });
    for (name, value) in [("x", "1"), ("y", "2"), ("width", "90"), ("height", "30")] {
        assert_clean_refusal(&wb, &format!("set_control_property {name}"), || set_prop(&wb, shape, name, value));
    }
    assert_clean_refusal(&wb, "move_control (another anchor)", || {
        crate::controls::move_control_core(&wb.state, &wb.file, canvas, (0, 0), (5, 5), Default::default())
    });
    let mut replaced = wb.state.controls.read().unwrap()[&shape].clone();
    replaced
        .properties
        .insert("x".to_string(), ControlPropertyValue { value_type: "static".to_string(), value: "700".to_string() });
    assert_clean_refusal(&wb, "set_control_metadata (a replace that moves)", || {
        crate::controls::set_control_metadata_core(&wb.state, &wb.file, shape.0, shape.1, shape.2, replaced.clone())
    });
    assert_eq!(control_prop(&wb, shape, "x").as_deref(), Some("600"), "the shape stayed where it was");

    // NOT moves: the same geometry re-sent, a caption, a rotation, a delete.
    assert_eq!(
        crate::controls::set_control_geometry_core(&wb.state, &wb.file, &[geometry(shape, 600.0)]),
        Ok(0),
        "a re-sync of the same geometry is not a move"
    );
    set_prop(&wb, shape, "x", "600").expect("writing the value it already has is not a move");
    set_prop(&wb, shape, "text", "Hello").expect("a caption is formatting");
    set_prop(&wb, shape, "rotation", "45").expect("Power BI's Rotation is a format card");
    assert!(
        crate::controls::remove_control_metadata_core(&wb.state, &wb.file, other.0, other.1, other.2)
            .expect("a delete is allowed on a locked page"),
        "the other shape was deleted"
    );
    // An INSERT lands where it is put: the first write that creates a control.
    set_prop(&wb, (canvas, 9, 9), "x", "10").expect("inserting on a locked page is allowed");

    // POSITIVE CONTROL: the same batch on the unlocked page moves the shape.
    lock(&wb, canvas, false);
    assert_eq!(crate::controls::set_control_geometry_core(&wb.state, &wb.file, &[geometry(shape, 640.0)]), Ok(1));
    assert_eq!(control_prop(&wb, shape, "x").as_deref(), Some("640"));
}

#[test]
fn a_locked_page_does_not_lock_its_neighbours() {
    // Per PAGE, as in Power BI: the lock on one canvas leaves a second canvas
    // and the worksheet editable, inside ONE batch too.
    let wb = Workbook::new(1);
    let locked_canvas = add_canvas(&wb);
    let open_canvas = add_canvas(&wb);
    let on_locked = shape_at(&wb, locked_canvas, 0, 0);
    let on_open = shape_at(&wb, open_canvas, 0, 0);
    let on_sheet = shape_at(&wb, 0, 0, 0);
    lock(&wb, locked_canvas, true);

    assert_eq!(
        crate::controls::set_control_geometry_core(&wb.state, &wb.file, &[geometry(on_open, 10.0), geometry(on_sheet, 10.0)]),
        Ok(2),
        "the other canvas and the worksheet move"
    );
    assert_clean_refusal(&wb, "a batch that also moves the locked page's shape", || {
        crate::controls::set_control_geometry_core(&wb.state, &wb.file, &[geometry(on_open, 20.0), geometry(on_locked, 20.0)])
    });
    assert_eq!(control_prop(&wb, on_open, "x").as_deref(), Some("10"), "a refused batch moves NOTHING");
}

fn insert_slicer(wb: &Workbook, sheet_index: usize) -> identity::EntityId {
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let slicer: crate::slicer::Slicer = serde_json::from_value(serde_json::json!({
        "id": id.to_string(),
        "name": "Region",
        "sheetIndex": sheet_index,
        "x": 10.0, "y": 300.0, "width": 180.0, "height": 240.0,
        "sourceType": "pivot",
        "cacheSourceId": id.to_string(),
        "fieldName": "Region",
        "selectedItems": null,
        "showHeader": true,
        "columns": 1,
        "stylePreset": "SlicerStyleLight1",
        "connectedSources": []
    }))
    .expect("slicer from json");
    wb.slicer.slicers.write(&crate::document_effect::test_seed_effect()).unwrap().insert(id, slicer);
    id
}

#[test]
fn a_locked_page_refuses_a_slicer_move_but_not_a_rename() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    let id = insert_slicer(&wb, canvas);
    lock(&wb, canvas, true);
    let at = |x| crate::slicer::commands::update_slicer_position_core(&wb.state, &wb.file, &wb.slicer, id, x, 300.0, 180.0, 240.0);

    assert_clean_refusal(&wb, "update_slicer_position", || at(50.0));
    assert_eq!(wb.slicer.slicers.read().unwrap()[&id].x, 10.0);
    at(10.0).expect("the same position is not a move");
    let rename: crate::slicer::types::UpdateSlicerParams = serde_json::from_value(serde_json::json!({ "name": "Area" })).unwrap();
    crate::slicer::commands::update_slicer_core(&wb.state, &wb.file, &wb.slicer, id, rename).expect("a rename is formatting");

    lock(&wb, canvas, false);
    at(50.0).expect("an unlocked page moves the slicer");
    assert_eq!(wb.slicer.slicers.read().unwrap()[&id].x, 50.0);
}

#[test]
fn a_locked_page_refuses_a_timeline_move() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    let timeline = crate::timeline_slicer::TimelineSlicer {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: "Order Date".to_string(),
        header_text: None,
        sheet_index: canvas,
        x: 10.0,
        y: 20.0,
        width: 350.0,
        height: 100.0,
        source_type: crate::timeline_slicer::TimelineSourceType::Pivot,
        source_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        field_name: "OrderDate".to_string(),
        level: crate::timeline_slicer::TimelineLevel::Months,
        selection_start: None,
        selection_end: None,
        show_header: true,
        show_level_selector: true,
        show_scrollbar: true,
        style_preset: "TimelineStyleLight1".to_string(),
        connected_pivot_ids: vec![],
        container: None,
    };
    let id = timeline.id;
    wb.timelines.timelines.write(&crate::document_effect::test_seed_effect()).unwrap().insert(id, timeline);
    lock(&wb, canvas, true);
    let at = |w| {
        crate::timeline_slicer::commands::update_timeline_position_core(&wb.state, &wb.timelines, &wb.file, id, 10.0, 20.0, w, 100.0)
    };

    assert_clean_refusal(&wb, "update_timeline_position (resize)", || at(500.0));
    assert_eq!(wb.timelines.timelines.read().unwrap()[&id].width, 350.0);
    at(350.0).expect("the same size is not a resize");
    lock(&wb, canvas, false);
    at(500.0).expect("an unlocked page resizes the timeline");
    assert_eq!(wb.timelines.timelines.read().unwrap()[&id].width, 500.0);
}

#[test]
fn a_locked_page_refuses_a_floating_range_move_or_resize_but_not_its_chrome() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    let info = crate::floating_range::create_floating_range_inner(&wb.state, &wb.file, None, 100.0, 50.0)
        .expect("create a floating range on the active canvas");
    let id = info.range.id;
    lock(&wb, canvas, true);
    let update = |p: FloatingRangePatch| crate::floating_range::update_floating_range_inner(&wb.state, &wb.file, id, p, crate::floating_range::PatchGate::ObjectEdit);

    assert_clean_refusal(&wb, "floating range x", || update(FloatingRangePatch { x: Some(300.0), ..Default::default() }));
    assert_clean_refusal(&wb, "floating range rowCount", || update(FloatingRangePatch { row_count: Some(9), ..Default::default() }));
    update(FloatingRangePatch { x: Some(100.0), ..Default::default() }).expect("the same x is not a move");
    update(FloatingRangePatch { show_title: Some(false), ..Default::default() }).expect("the chrome is formatting");

    lock(&wb, canvas, false);
    let moved = update(FloatingRangePatch { x: Some(300.0), ..Default::default() }).expect("an unlocked page moves it");
    assert_eq!(moved.range.x, 300.0);
}

#[test]
fn a_locked_page_refuses_a_canvas_pivot_box_move_but_not_a_rename() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    let frame = pivot_engine::CanvasFrame { x: 40.0, y: 60.0, width: 320.0, height: 200.0, frozen_headers: false, container: None };
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let mut def = pivot_engine::PivotDefinition::new(id, (0, 0), (0, 0));
    def.destination_sheet = Some(canvas_name);
    def.canvas_frame = Some(frame.clone());
    wb.pivots
        .pivot_tables
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert(id, (def, pivot_engine::PivotCache::new(id, 0)));
    lock(&wb, canvas, true);
    let request = |frame: Option<pivot_engine::CanvasFrame>, name: Option<&str>| crate::pivot::types::UpdatePivotPropertiesRequest {
        pivot_id: id,
        name: name.map(|s| s.to_string()),
        allow_multiple_filters_per_field: None,
        enable_data_value_editing: None,
        refresh_on_open: None,
        use_custom_sort_lists: None,
        canvas_frame: frame.map(Into::into),
        style: None,
    };
    let update = |r| crate::pivot::commands::update_pivot_properties_core(&wb.state, &wb.file, &wb.pivots, r);
    let stored = || wb.pivots.pivot_tables.read().unwrap()[&id].0.canvas_frame.clone().unwrap();

    assert_clean_refusal(&wb, "pivot box move", || {
        update(request(Some(pivot_engine::CanvasFrame { x: 400.0, ..frame.clone() }), None))
    });
    assert_eq!(stored().x, 40.0);
    update(request(Some(pivot_engine::CanvasFrame { frozen_headers: true, ..frame.clone() }), None))
        .expect("freezing the box's headers is formatting, not a move");
    update(request(None, Some("Sales by region"))).expect("a rename is not a move");

    lock(&wb, canvas, false);
    update(request(Some(pivot_engine::CanvasFrame { x: 400.0, ..frame.clone() }), None)).expect("an unlocked page moves the box");
    assert_eq!(stored().x, 400.0);
}
