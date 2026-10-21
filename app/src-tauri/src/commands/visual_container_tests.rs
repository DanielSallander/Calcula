//! FILENAME: app/src-tauri/src/commands/visual_container_tests.rs
//! PURPOSE: WP-C S7 (D-FORMAT) -- the VISUAL CONTAINER on every family's own
//!          record, through each family's own door, at the unit tier.
//!
//! What is pinned here (the canvas pivot box and the pivot style are pinned in
//! `canvas_sheet_tests.rs`, beside the frame tests):
//!
//!   1. Slicer / timeline: `container` sets, `null` clears, an invalid one is
//!      refused BEFORE the effect (`is_modified` stays false -- the
//!      DocumentEffect discipline), and Ctrl+Z restores the old container.
//!   2. Floating grid: a CONTAINER-ONLY patch persists, dirties, records undo
//!      and passes a Lock Objects page (it would be dropped silently as "changes
//!      nothing" without the `patched()` / `patchable_fields_differ()` edits);
//!      an identical patch records nothing.
//!   3. Charts: the store (`update_chart_core`, `save_chart_core`) and the AI
//!      path (`validate_chart_spec_core`) refuse a second spelling of the title
//!      (`container.title.text`), a bad colour and an unknown leaf, and accept a
//!      valid container -- before the effect.
//!   4. Controls: `set_control_appearance_core` is ONE "Format control" step
//!      over several keys on several controls, joins an open transaction, and
//!      refuses (nothing written, clean) an unknown control, a duplicate, a code
//!      key, a structural key and a bad container value; an all-unchanged batch
//!      records nothing; `set_control_property_core` refuses a bad
//!      `container*` value before the effect too.
//!
//! Reuses the `cross_sheet_recalc_tests::Workbook` harness.

use super::cross_sheet_recalc_tests::Workbook;
use crate::api_types::{
    CanvasLayoutPatch, ChartEntry, ControlAppearanceChange, ControlAppearanceWrite, FloatingRangePatch,
};
use crate::controls::{ControlMetadata, ControlPropertyValue};
use persistence::SheetKind;
use visual_format::VisualContainerFormat;

fn add_canvas(wb: &Workbook) -> usize {
    crate::sheets::add_sheet_inner(&wb.state, &wb.file, None, SheetKind::new_canvas())
        .expect("add a canvas sheet")
        .active_index
}

fn lock(wb: &Workbook, index: usize, on: bool) {
    let patch = CanvasLayoutPatch { objects_locked: Some(on), ..Default::default() };
    crate::sheets::set_canvas_layout_inner(&wb.state, &wb.file, Some(index), &patch).expect("toggle Lock Objects");
}

fn undo_depth(wb: &Workbook) -> usize {
    wb.state.undo_stack.lock().unwrap().undo_depth()
}

fn last_label(wb: &Workbook) -> Option<String> {
    wb.state.undo_stack.lock().unwrap().undo_description().map(str::to_string)
}

/// Ctrl+Z through the real restore path.
fn undo_once(wb: &Workbook) {
    let transaction = wb.state.undo_stack.lock().unwrap().pop_undo().expect("an undo step");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, &wb.timelines, transaction, true,
    );
}

fn container(v: serde_json::Value) -> VisualContainerFormat {
    serde_json::from_value(v).expect("a container")
}

fn rounded() -> VisualContainerFormat {
    container(serde_json::json!({"border": {"show": true, "color": "#336699", "radius": 8}, "padding": {"top": 6}}))
}

/// Run `refused`, which must fail, and prove it left the document clean and
/// the undo stack untouched.
fn assert_clean_refusal<T: std::fmt::Debug>(wb: &Workbook, what: &str, refused: impl FnOnce() -> Result<T, String>) -> String {
    crate::document_effect::mark_saved(&wb.file);
    let depth = undo_depth(wb);
    let err = match refused() {
        Ok(v) => panic!("{what}: must be refused, got Ok({v:?})"),
        Err(e) => e,
    };
    assert!(!wb.file.is_dirty(), "{what}: a refusal must leave the document clean");
    assert_eq!(undo_depth(wb), depth, "{what}: a refusal must record no undo step");
    err
}

// ---------------------------------------------------------------------------
// 1. Slicer
// ---------------------------------------------------------------------------

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

fn slicer_params(v: serde_json::Value) -> crate::slicer::types::UpdateSlicerParams {
    serde_json::from_value(v).expect("slicer params")
}

/// SABOTAGE: drop the `container.validate()` gate in `update_slicer_core` ->
/// the bad radius is written and the document dirtied.
#[test]
fn a_slicer_container_sets_clears_refuses_cleanly_and_undoes() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    let id = insert_slicer(&wb, canvas);
    let update = |p| crate::slicer::commands::update_slicer_core(&wb.state, &wb.file, &wb.slicer, id, p);
    let stored = || wb.slicer.slicers.read().unwrap()[&id].container.clone();

    // Absent = keep: an ordinary rename does not touch it (and the double
    // option reads an absent key as "keep", not "clear").
    let absent = slicer_params(serde_json::json!({"name": "Area"}));
    assert!(absent.container.is_none());

    crate::document_effect::mark_saved(&wb.file);
    let depth = undo_depth(&wb);
    let set = update(slicer_params(serde_json::json!({"container": serde_json::to_value(rounded()).unwrap()})))
        .expect("a valid container is set");
    assert_eq!(set.container, Some(rounded()));
    assert_eq!(stored(), Some(rounded()));
    assert!(wb.file.is_dirty());
    assert_eq!(undo_depth(&wb), depth + 1);

    update(absent).expect("a rename");
    assert_eq!(stored(), Some(rounded()), "an absent container is kept");

    let err = assert_clean_refusal(&wb, "slicer bad radius", || {
        update(slicer_params(serde_json::json!({"container": {"border": {"radius": 101}}})))
    });
    assert_eq!(err, "border.radius must be a number from 0 to 100.");
    assert_clean_refusal(&wb, "slicer bad colour", || {
        update(slicer_params(serde_json::json!({"container": {"background": {"color": "red"}}})))
    });
    assert_eq!(stored(), Some(rounded()), "a refused container wrote nothing");

    update(slicer_params(serde_json::json!({"container": null}))).expect("null clears");
    assert_eq!(stored(), None);
    undo_once(&wb);
    assert_eq!(stored(), Some(rounded()), "undo of the clear brings the container back");
}

// ---------------------------------------------------------------------------
// 1b. Timeline
// ---------------------------------------------------------------------------

/// SABOTAGE: drop the validate gate in `update_timeline_slicer_core`.
#[test]
fn a_timeline_container_sets_clears_refuses_cleanly_and_undoes() {
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
    let update = |v: serde_json::Value| {
        let params: crate::timeline_slicer::types::UpdateTimelineParams = serde_json::from_value(v).unwrap();
        crate::timeline_slicer::commands::update_timeline_slicer_core(&wb.state, &wb.timelines, &wb.file, id, params)
    };
    let stored = || wb.timelines.timelines.read().unwrap()[&id].container.clone();

    crate::document_effect::mark_saved(&wb.file);
    let depth = undo_depth(&wb);
    update(serde_json::json!({"container": serde_json::to_value(rounded()).unwrap()})).expect("set");
    assert_eq!(stored(), Some(rounded()));
    assert!(wb.file.is_dirty());
    assert_eq!(undo_depth(&wb), depth + 1);

    // The same container again is no edit (the door compares).
    update(serde_json::json!({"container": serde_json::to_value(rounded()).unwrap()})).unwrap();
    assert_eq!(undo_depth(&wb), depth + 1, "an unchanged container records nothing");

    let err = assert_clean_refusal(&wb, "timeline bad shadow", || {
        update(serde_json::json!({"container": {"shadow": {"blur": 51}}}))
    });
    assert_eq!(err, "shadow.blur must be a number from 0 to 50.");
    assert_eq!(stored(), Some(rounded()));

    update(serde_json::json!({"container": null})).expect("null clears");
    assert_eq!(stored(), None);
    undo_once(&wb);
    assert_eq!(stored(), Some(rounded()), "undo restores the container");
}

// ---------------------------------------------------------------------------
// 2. Floating grid
// ---------------------------------------------------------------------------

/// SABOTAGE: drop `|| a.container != b.container` from
/// `patchable_fields_differ` -> the container-only patch is dropped as "changes
/// nothing" (not stored, not dirty, no step).
#[test]
fn a_floating_range_container_only_patch_persists_dirties_undoes_and_passes_a_locked_page() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    let info = crate::floating_range::create_floating_range_inner(&wb.state, &wb.file, None, 100.0, 50.0)
        .expect("create a floating range on the active canvas");
    let id = info.range.id;
    lock(&wb, canvas, true);
    let update = |p: FloatingRangePatch| crate::floating_range::update_floating_range_inner(&wb.state, &wb.file, id, p, crate::floating_range::PatchGate::ObjectEdit);
    let stored = || {
        wb.state.floating_ranges.read().unwrap().iter().find(|f| f.id == id).unwrap().container.clone()
    };

    crate::document_effect::mark_saved(&wb.file);
    let depth = undo_depth(&wb);
    let padded = container(serde_json::json!({"padding": {"top": 12, "left": 12}, "border": {"radius": 4}}));
    let out = update(FloatingRangePatch { container: Some(Some(padded.clone())), ..Default::default() })
        .expect("a container is formatting: a locked page lets it through (padding too)");
    assert_eq!(out.range.container, Some(padded.clone()));
    assert_eq!(stored(), Some(padded.clone()));
    assert!(wb.file.is_dirty(), "a container-only patch dirties the document");
    assert_eq!(undo_depth(&wb), depth + 1, "and records one step");
    assert_eq!(last_label(&wb).as_deref(), Some("Format floating range"));

    crate::document_effect::mark_saved(&wb.file);
    update(FloatingRangePatch { container: Some(Some(padded.clone())), ..Default::default() }).unwrap();
    assert!(!wb.file.is_dirty(), "an identical container patch is not an edit");
    assert_eq!(undo_depth(&wb), depth + 1, "and records nothing");

    let err = assert_clean_refusal(&wb, "floating range bad padding", || {
        update(FloatingRangePatch {
            container: Some(Some(container(serde_json::json!({"padding": {"top": 500}})))),
            ..Default::default()
        })
    });
    assert_eq!(err, "padding.top must be a number from 0 to 200.");
    assert_eq!(stored(), Some(padded.clone()));

    // A geometry patch on the same locked page is still refused.
    assert!(update(FloatingRangePatch { x: Some(300.0), ..Default::default() }).is_err());

    undo_once(&wb);
    assert_eq!(stored(), None, "undo takes the container away");

    // The double option on the wire: absent keeps, null clears.
    let keep: FloatingRangePatch = serde_json::from_value(serde_json::json!({"x": 100.0})).unwrap();
    assert!(keep.container.is_none());
    let clear: FloatingRangePatch = serde_json::from_value(serde_json::json!({"container": null})).unwrap();
    assert_eq!(clear.container, Some(None));
}

// ---------------------------------------------------------------------------
// 3. Charts
// ---------------------------------------------------------------------------

fn chart_with(sheet_index: usize, container: Option<serde_json::Value>) -> ChartEntry {
    let mut spec = serde_json::json!({ "mark": "bar", "data": "Sheet1!A1:B3", "series": [], "title": "Sales" });
    if let Some(c) = container {
        spec["container"] = c;
    }
    ChartEntry {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        sheet_index,
        spec_json: serde_json::json!({
            "chartId": "c", "name": "Chart 1", "sheetIndex": sheet_index,
            "x": 40.0, "y": 40.0, "width": 480.0, "height": 300.0,
            "spec": spec
        })
        .to_string(),
    }
}

fn with_container(entry: &ChartEntry, c: serde_json::Value) -> ChartEntry {
    let mut v: serde_json::Value = serde_json::from_str(&entry.spec_json).unwrap();
    v["spec"]["container"] = c;
    ChartEntry { id: entry.id, sheet_index: entry.sheet_index, spec_json: v.to_string() }
}

/// THE ONE-SPELLING RULE (R5) on every route that writes a chart spec: the
/// title TEXT is `spec.title`, so `container.title.text` is refused -- by the
/// store's update and upsert AND the AI path -- before the effect.
///
/// SABOTAGE: drop `forbid_chart_title_leaves()` from
/// `check_chart_spec_formatting` -> the second spelling is stored.
#[test]
fn a_chart_container_is_validated_on_the_store_and_the_ai_path() {
    let wb = Workbook::new(1);
    let entry = chart_with(0, None);
    crate::chart_commands::save_chart_core(&wb.state, &wb.file, entry.clone()).expect("insert a chart");
    let update = |e: ChartEntry| crate::chart_commands::update_chart_core(&wb.state, &wb.file, e, None);
    let stored_spec = || {
        let charts = wb.state.charts.read().unwrap();
        let v: serde_json::Value = serde_json::from_str(&charts.iter().find(|c| c.id == entry.id).unwrap().spec_json).unwrap();
        v["spec"].clone()
    };

    let bad: [(&str, serde_json::Value, &str); 5] = [
        ("title text", serde_json::json!({"title": {"text": "Revenue"}}), "spec.title"),
        ("title colour", serde_json::json!({"title": {"color": "#000"}}), "titleColor"),
        ("bad colour", serde_json::json!({"border": {"color": "red"}}), "border.color"),
        ("unknown leaf", serde_json::json!({"border": {"glow": 1}}), "not a visual container field"),
        ("unknown root", serde_json::json!({"halo": {"show": true}}), "not a visual container field"),
    ];
    for (what, c, says) in &bad {
        let err = assert_clean_refusal(&wb, what, || update(with_container(&entry, c.clone())));
        assert!(err.contains(says), "{what}: {err}");
        assert!(stored_spec().get("container").is_none(), "{what}: nothing stored");
        // The upsert door refuses it the same way.
        assert_clean_refusal(&wb, what, || {
            crate::chart_commands::save_chart_core(&wb.state, &wb.file, with_container(&entry, c.clone()))
        });
        // And the AI path.
        let mut spec = stored_spec();
        spec["container"] = c.clone();
        let ai = crate::mcp::tools::validate_chart_spec_core(&spec).unwrap_err();
        assert!(ai.contains(says), "AI path, {what}: {ai}");
    }

    // A field-format code over the cap is refused too.
    let mut v: serde_json::Value = serde_json::from_str(&entry.spec_json).unwrap();
    v["spec"]["fieldFormats"] = serde_json::json!({"Revenue": "0".repeat(257)});
    let long = ChartEntry { id: entry.id, sheet_index: 0, spec_json: v.to_string() };
    assert_clean_refusal(&wb, "field format too long", || update(long));

    // A valid container (title STYLE only, no text/colour/size) is accepted.
    let good = serde_json::json!({"title": {"show": true, "bold": true, "align": "left"},
        "background": {"color": "#fff4e5", "gradient": {"type": "linear",
            "stops": [{"offset": 0, "color": "#000"}, {"offset": 1, "color": "#fff"}]}},
        "border": {"radius": 8}});
    crate::document_effect::mark_saved(&wb.file);
    update(with_container(&entry, good.clone())).expect("a valid container is accepted");
    assert!(wb.file.is_dirty());
    assert_eq!(stored_spec()["container"], good);
    let mut spec = stored_spec();
    spec["fieldFormats"] = serde_json::json!({"Revenue": "#,##0.00"});
    crate::mcp::tools::validate_chart_spec_core(&spec).expect("the AI path accepts it too");
}

// ---------------------------------------------------------------------------
// 4. Controls
// ---------------------------------------------------------------------------

fn shape_at(wb: &Workbook, sheet_index: usize, row: u32, col: u32) -> (usize, u32, u32) {
    let mut properties = std::collections::HashMap::new();
    for (name, value) in [("x", "600"), ("y", "40"), ("width", "80"), ("height", "28"), ("pinToGrid", "false"), ("fill", "#4472C4")] {
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

fn prop(wb: &Workbook, key: (usize, u32, u32), name: &str) -> Option<String> {
    wb.state.controls.read().unwrap().get(&key).and_then(|m| m.properties.get(name)).map(|p| p.value.clone())
}

fn change(key: (usize, u32, u32), writes: &[(&str, &str)]) -> ControlAppearanceChange {
    ControlAppearanceChange {
        sheet_index: key.0,
        row: key.1,
        col: key.2,
        properties: writes
            .iter()
            .map(|(k, v)| ControlAppearanceWrite { key: k.to_string(), value: v.to_string() })
            .collect(),
    }
}

/// Two keys on one control and one on another are ONE "Format control" step
/// whose undo restores all three; on a locked page (formatting).
///
/// SABOTAGE: record per control inside the loop -> two steps.
#[test]
fn a_control_appearance_batch_is_one_undo_step_that_restores_every_key() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    let a = shape_at(&wb, canvas, 1, 1);
    let b = shape_at(&wb, canvas, 2, 2);
    lock(&wb, canvas, true);
    crate::document_effect::mark_saved(&wb.file);
    let depth = undo_depth(&wb);

    let changed = crate::controls::set_control_appearance_core(
        &wb.state,
        &wb.file,
        &[
            change(a, &[("fill", "#FF0000"), ("containerBorderRadius", "8")]),
            change(b, &[("containerShadowShow", "true")]),
        ],
    )
    .expect("a valid batch, on a locked page (formatting)");
    assert_eq!(changed, 2);
    assert_eq!(prop(&wb, a, "fill").as_deref(), Some("#FF0000"));
    assert_eq!(prop(&wb, a, "containerBorderRadius").as_deref(), Some("8"));
    assert_eq!(prop(&wb, b, "containerShadowShow").as_deref(), Some("true"));
    assert!(wb.file.is_dirty());
    assert_eq!(undo_depth(&wb), depth + 1, "ONE step for the whole batch");
    assert_eq!(last_label(&wb).as_deref(), Some("Format control"));
    let stored_type = wb.state.controls.read().unwrap()[&a].properties["containerBorderRadius"].value_type.clone();
    assert_eq!(stored_type, "static");

    // Everything already as requested: no effect, no step.
    crate::document_effect::mark_saved(&wb.file);
    let n = crate::controls::set_control_appearance_core(&wb.state, &wb.file, &[change(b, &[("containerShadowShow", "true")])])
        .unwrap();
    assert_eq!(n, 0);
    assert!(!wb.file.is_dirty(), "an all-unchanged batch leaves the document clean");
    assert_eq!(undo_depth(&wb), depth + 1);

    undo_once(&wb);
    assert_eq!(prop(&wb, a, "fill").as_deref(), Some("#4472C4"), "undo restores the fill");
    assert_eq!(prop(&wb, a, "containerBorderRadius"), None, "and removes the new container key");
    assert_eq!(prop(&wb, b, "containerShadowShow"), None, "on the other control too");
}

#[test]
fn a_control_appearance_batch_joins_an_open_transaction() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    let a = shape_at(&wb, canvas, 1, 1);
    let depth = undo_depth(&wb);
    wb.state.undo_stack.lock().unwrap().begin_transaction("Format");
    crate::controls::set_control_appearance_core(&wb.state, &wb.file, &[change(a, &[("stroke", "none")])]).unwrap();
    assert!(wb.state.undo_stack.lock().unwrap().has_open_transaction(), "the caller's transaction stays open");
    assert_eq!(undo_depth(&wb), depth, "nothing lands before the caller commits");
    wb.state.undo_stack.lock().unwrap().commit_transaction();
    assert_eq!(undo_depth(&wb), depth + 1);
}

/// Every refusal happens BEFORE the effect: nothing written, document clean,
/// no step -- and one bad entry refuses the whole batch.
///
/// SABOTAGE: drop `check_control_container_value` from
/// `encode_appearance_changes` -> "abc" and "101" are written.
#[test]
fn a_control_appearance_batch_refuses_before_the_effect() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    let a = shape_at(&wb, canvas, 1, 1);
    let run = |changes: Vec<ControlAppearanceChange>| {
        crate::controls::set_control_appearance_core(&wb.state, &wb.file, &changes)
    };
    let cases: Vec<(&str, Vec<ControlAppearanceChange>)> = vec![
        ("unknown control", vec![change(a, &[("fill", "#000000")]), change((canvas, 9, 9), &[("fill", "#000000")])]),
        ("duplicate control", vec![change(a, &[("fill", "#000000")]), change(a, &[("stroke", "#000000")])]),
        ("executable key", vec![change(a, &[("onSelect", "alert(1)")])]),
        ("macro key", vec![change(a, &[("macroRef", "m1")])]),
        ("action key", vec![change(a, &[("action", "navigate")])]),
        ("held key", vec![change(a, &[("heldOnSelect", "x")])]),
        ("structural key", vec![change(a, &[("x", "10")])]),
        ("identity key", vec![change(a, &[("uid", "abc")])]),
        ("empty entry", vec![change(a, &[])]),
        ("not a number", vec![change(a, &[("fill", "#000000"), ("containerBorderRadius", "abc")])]),
        ("over the radius cap", vec![change(a, &[("containerBorderRadius", "101")])]),
        ("bad container colour", vec![change(a, &[("containerTitleColor", "red")])]),
    ];
    for (what, changes) in cases {
        assert_clean_refusal(&wb, what, || run(changes));
        assert_eq!(prop(&wb, a, "fill").as_deref(), Some("#4472C4"), "{what}: nothing written");
        assert_eq!(prop(&wb, a, "containerBorderRadius"), None, "{what}: nothing written");
    }
    // An empty batch is a no-op, not an error.
    assert_eq!(run(Vec::new()).unwrap(), 0);
}

/// The single-property door (`shape.setProperty`, the Properties pane, WP-D's
/// control literal arm) re-checks a `container*` value in Rust.
///
/// SABOTAGE: drop the `check_control_container_value` call from
/// `set_control_property_with`.
#[test]
fn the_single_property_door_refuses_a_bad_container_value_before_the_effect() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb);
    let a = shape_at(&wb, canvas, 1, 1);
    let set = |name: &str, value: &str| {
        crate::controls::set_control_property_core(
            &wb.state,
            &wb.file,
            a.0,
            a.1,
            a.2,
            "shape".to_string(),
            name.to_string(),
            "static".to_string(),
            value.to_string(),
        )
    };
    let err = assert_clean_refusal(&wb, "containerTitleColor", || set("containerTitleColor", "url(x)"));
    assert_eq!(err, "containerTitleColor must be empty or a #rgb, #rrggbb or #rrggbbaa colour.");
    assert_eq!(prop(&wb, a, "containerTitleColor"), None);
    assert_clean_refusal(&wb, "containerTitleFontSize", || set("containerTitleFontSize", "200"));
    set("containerTitleColor", "#123456").expect("a valid container colour is written");
    assert_eq!(prop(&wb, a, "containerTitleColor").as_deref(), Some("#123456"));
    set("containerTitleColor", "").expect("\"\" is the family default");
}
