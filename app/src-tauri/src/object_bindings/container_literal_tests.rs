//! FILENAME: app/src-tauri/src/object_bindings/container_literal_tests.rs
// PURPOSE: WP-C S7b -- the LITERAL door of a visual container field
//          (`container_literal::write_container_literal`, reached through
//          `literal::write_literal` for every `O::Container` catalog row), at
//          the unit tier over `create_app_state()`.
//
// What is pinned, per kind (chart, PivotTable box, slicer, timeline, floating
// range):
//   - a literal `<root>/border/radius` = 8 lands in the family's OWN record
//     through the family's own door: `Written`, dirty, ONE undo step (the
//     door's), and Ctrl+Z takes it away;
//   - the same value again is `Unchanged`: clean, no step (the slicer and pivot
//     doors mint their effect without comparing -- the door here compares);
//   - a bad value (an unsafe colour, an out-of-range number) is refused BEFORE
//     the effect: clean, no step, nothing stored;
// plus the chart's one-spelling rule (`/spec/container/title/text` refused by
// the catalog AND by the door called directly), the pivot box keeping its
// geometry (and a worksheet pivot refused), a floating range's write passing a
// Lock Objects page, `rgb(...)` stored as hex (literal AND bound value), a
// control's flat `container*` keys through the control arm, and the pivot
// object-JSON projection of `canvasFrame.container`.

use serde_json::{json, Value};

use super::container_literal::{
    is_container_colour_path, normalize_container_colour, normalize_if_container_colour, write_container_literal,
};
use super::literal::{self, LiteralWriteCtx, LiteralWriteOutcome};
use crate::api_types::{ObjectBindingKind, ObjectBindingRef};
use crate::document_effect::test_seed_effect;
use crate::persistence::{FileState, UserFilesState};
use crate::AppState;
use visual_format::VisualContainerFormat;

fn entity() -> identity::EntityId {
    identity::EntityId::from_bytes(identity::generate_uuid_v7())
}

/// One worksheet (Sheet1) plus one ACTIVE canvas page.
struct H {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    slicers: crate::slicer::SlicerState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
    pivots: crate::pivot::types::PivotState,
    pane: crate::pane_control::PaneControlState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
    canvas: usize,
}

impl H {
    fn new() -> H {
        let state = crate::create_app_state();
        let file = FileState::default();
        let canvas = crate::sheets::add_sheet_inner(&state, &file, None, ::persistence::SheetKind::new_canvas())
            .expect("add a canvas page")
            .active_index;
        H {
            state,
            file,
            files: UserFilesState::default(),
            slicers: crate::slicer::SlicerState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
            canvas,
        }
    }

    fn ctx(&self) -> LiteralWriteCtx<'_> {
        LiteralWriteCtx {
            state: &self.state,
            file_state: &self.file,
            slicers: &self.slicers,
            timelines: &self.timelines,
            pivots: &self.pivots,
        }
    }

    fn write(&self, object: &ObjectBindingRef, path: &str, value: Value) -> Result<LiteralWriteOutcome, String> {
        literal::write_literal(&self.ctx(), object, path, value)
    }

    fn depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }

    fn label(&self) -> Option<String> {
        self.state.undo_stack.lock().unwrap().undo_description().map(str::to_string)
    }

    fn clean(&self) {
        crate::document_effect::mark_saved(&self.file);
    }

    fn undo(&self) {
        let t = self.state.undo_stack.lock().unwrap().pop_undo().expect("an undo step");
        crate::undo_commands::apply_changes(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.slicers,
            &self.ribbon,
            &self.pane,
            &self.timelines,
            t,
            true,
        );
    }

    fn lock_objects(&self, on: bool) {
        let patch = crate::api_types::CanvasLayoutPatch { objects_locked: Some(on), ..Default::default() };
        crate::sheets::set_canvas_layout_inner(&self.state, &self.file, Some(self.canvas), &patch)
            .expect("toggle Lock Objects");
    }

    fn canvas_name(&self) -> String {
        self.state.sheet_names.read().unwrap()[self.canvas].clone()
    }

    // ----- objects -----

    fn chart(&self) -> ObjectBindingRef {
        let id = entity();
        let envelope = json!({
            "chartId": id.to_string(), "name": "Revenue chart", "sheetIndex": self.canvas,
            "x": 40.0, "y": 40.0, "width": 480.0, "height": 300.0,
            "spec": { "mark": "bar", "data": "Sheet1!A1:B3", "series": [], "title": "Sales" }
        });
        self.state.charts.write(&test_seed_effect()).unwrap().push(crate::api_types::ChartEntry {
            id,
            sheet_index: self.canvas,
            spec_json: envelope.to_string(),
        });
        ObjectBindingRef { kind: ObjectBindingKind::Chart, id: id.to_string() }
    }

    fn chart_container(&self, object: &ObjectBindingRef) -> Option<Value> {
        let charts = self.state.charts.read().unwrap();
        let entry = charts.iter().find(|c| c.id.to_string() == object.id).expect("the chart");
        let v: Value = serde_json::from_str(&entry.spec_json).unwrap();
        v["spec"].get("container").cloned()
    }

    fn pivot(&self, framed: bool) -> ObjectBindingRef {
        let id = entity();
        let mut def = pivot_engine::PivotDefinition::new(id, (0, 0), (0, 0));
        let worksheet = self.state.sheet_names.read().unwrap()[0].clone();
        def.destination_sheet = Some(if framed { self.canvas_name() } else { worksheet });
        def.canvas_frame = framed.then(|| pivot_engine::CanvasFrame {
            x: 40.0,
            y: 60.0,
            width: 320.0,
            height: 200.0,
            frozen_headers: true,
            container: None,
        });
        self.pivots
            .pivot_tables
            .write(&test_seed_effect())
            .unwrap()
            .insert(id, (def, pivot_engine::PivotCache::new(id, 0)));
        ObjectBindingRef { kind: ObjectBindingKind::Pivot, id: id.to_string() }
    }

    fn pivot_frame(&self, object: &ObjectBindingRef) -> pivot_engine::CanvasFrame {
        let id = identity::EntityId::parse(&object.id).unwrap();
        self.pivots.pivot_tables.read().unwrap()[&id].0.canvas_frame.clone().expect("a canvas pivot")
    }

    fn slicer(&self) -> ObjectBindingRef {
        let id = entity();
        let slicer: crate::slicer::Slicer = serde_json::from_value(json!({
            "id": id.to_string(), "name": "Region", "sheetIndex": self.canvas,
            "x": 0.0, "y": 0.0, "width": 100.0, "height": 200.0,
            "sourceType": "table", "cacheSourceId": entity().to_string(), "fieldName": "Region",
            "selectedItems": null, "showHeader": true, "columns": 1, "stylePreset": "SlicerStyleLight1"
        }))
        .expect("a minimal slicer");
        self.slicers.slicers.write(&test_seed_effect()).unwrap().insert(id, slicer);
        ObjectBindingRef { kind: ObjectBindingKind::Slicer, id: id.to_string() }
    }

    fn slicer_container(&self, object: &ObjectBindingRef) -> Option<VisualContainerFormat> {
        let id = identity::EntityId::parse(&object.id).unwrap();
        self.slicers.slicers.read().unwrap()[&id].container.clone()
    }

    fn timeline(&self) -> ObjectBindingRef {
        let id = entity();
        let timeline: crate::timeline_slicer::TimelineSlicer = serde_json::from_value(json!({
            "id": id.to_string(), "name": "Order date", "sheetIndex": self.canvas,
            "x": 0.0, "y": 0.0, "width": 300.0, "height": 120.0,
            "sourceType": "pivot", "sourceId": entity().to_string(), "fieldName": "OrderDate",
            "showHeader": true, "showLevelSelector": true, "showScrollbar": true, "stylePreset": "TimeSlicerStyleLight1"
        }))
        .expect("a minimal timeline");
        self.timelines.timelines.write(&test_seed_effect()).unwrap().insert(id, timeline);
        ObjectBindingRef { kind: ObjectBindingKind::TimelineSlicer, id: id.to_string() }
    }

    fn timeline_container(&self, object: &ObjectBindingRef) -> Option<VisualContainerFormat> {
        let id = identity::EntityId::parse(&object.id).unwrap();
        self.timelines.timelines.read().unwrap()[&id].container.clone()
    }

    fn floating_range(&self) -> ObjectBindingRef {
        let info = crate::floating_range::create_floating_range_inner(&self.state, &self.file, None, 100.0, 50.0)
            .expect("a floating range on the active canvas");
        ObjectBindingRef { kind: ObjectBindingKind::FloatingRange, id: info.range.id.to_string() }
    }

    fn floating_range_container(&self, object: &ObjectBindingRef) -> Option<VisualContainerFormat> {
        let rows = self.state.floating_ranges.read().unwrap();
        rows.iter().find(|fr| fr.id.to_string() == object.id).expect("the floating range").container.clone()
    }

    fn shape(&self) -> (ObjectBindingRef, (usize, u32, u32)) {
        let mut properties = std::collections::HashMap::new();
        for (name, value) in [("x", "600"), ("y", "40"), ("width", "80"), ("height", "28"), ("pinToGrid", "false")] {
            properties.insert(
                name.to_string(),
                crate::controls::ControlPropertyValue { value_type: "static".to_string(), value: value.to_string() },
            );
        }
        let uid = entity().to_string();
        let key = (self.canvas, 3, 4);
        self.state.controls.write(&test_seed_effect()).unwrap().insert(
            key,
            crate::controls::ControlMetadata { control_type: "shape".to_string(), uid: uid.clone(), properties },
        );
        (ObjectBindingRef { kind: ObjectBindingKind::Control, id: uid }, key)
    }

    fn control_prop(&self, key: (usize, u32, u32), name: &str) -> Option<String> {
        self.state.controls.read().unwrap().get(&key).and_then(|m| m.properties.get(name)).map(|p| p.value.clone())
    }
}

fn radius_of(c: &Option<VisualContainerFormat>) -> Option<f64> {
    c.as_ref().and_then(|c| c.border.as_ref()).and_then(|b| b.radius)
}

fn container(v: Value) -> VisualContainerFormat {
    serde_json::from_value(v).expect("a container")
}

/// The shared assertions for one kind: Written + dirty + ONE step; the same
/// value again Unchanged + clean + no step; a bad colour and an out-of-range
/// number refused before the effect; undo takes the radius away.
fn round_trip(
    h: &H,
    object: &ObjectBindingRef,
    root: &str,
    domain: &str,
    label: &str,
    radius: impl Fn() -> Option<f64>,
) {
    let path = format!("{root}/border/radius");
    h.clean();
    let depth = h.depth();
    match h.write(object, &path, json!(8)).unwrap_or_else(|e| panic!("{path}: {e}")) {
        LiteralWriteOutcome::Written { domains, layout } => {
            assert_eq!(domains, vec![domain], "{path}: the refresh domain");
            assert!(layout.is_none());
        }
        LiteralWriteOutcome::Unchanged => panic!("{path}: a new radius must be written"),
    }
    assert_eq!(radius(), Some(8.0), "{path}: the radius lands in the family record");
    assert!(h.file.is_dirty(), "{path}: a written literal dirties the document");
    assert_eq!(h.depth(), depth + 1, "{path}: ONE undo step (the door's own)");
    assert_eq!(h.label().as_deref(), Some(label), "{path}: the door's own label");

    h.clean();
    assert!(
        matches!(h.write(object, &path, json!(8.0)), Ok(LiteralWriteOutcome::Unchanged)),
        "{path}: the same value again is Unchanged"
    );
    assert!(!h.file.is_dirty(), "{path}: an unchanged literal leaves the document clean");
    assert_eq!(h.depth(), depth + 1, "{path}: and records nothing");

    for (bad_path, bad, says) in [
        (format!("{root}/border/color"), json!("red"), "not a colour"),
        (format!("{root}/border/radius"), json!(101), "border.radius must be a number from 0 to 100."),
        (format!("{root}/shadow/position"), json!("middle"), "not one of"),
    ] {
        h.clean();
        let err = h.write(object, &bad_path, bad.clone()).expect_err(&bad_path);
        assert!(err.contains(says), "{bad_path} = {bad}: {err}");
        assert!(!h.file.is_dirty(), "{bad_path}: a refusal leaves the document clean");
        assert_eq!(h.depth(), depth + 1, "{bad_path}: a refusal records nothing");
        assert_eq!(radius(), Some(8.0), "{bad_path}: nothing was stored");
    }

    h.undo();
    assert_eq!(radius(), None, "{path}: undo takes the radius away");
}

// ---------------------------------------------------------------------------
// Per kind
// ---------------------------------------------------------------------------

/// SABOTAGE (confirmed): make `write_chart` skip the `next == current` check
/// -> the second write is `Written` and adds a second "Edit chart" step.
#[test]
fn a_chart_container_literal_rides_update_chart_core() {
    let h = H::new();
    let chart = h.chart();
    round_trip(&h, &chart, "/spec/container", "objects", "Edit chart", || {
        h.chart_container(&chart).and_then(|c| c.pointer("/border/radius").and_then(Value::as_f64))
    });
    // A clear of the only leaf removes the key: no empty `container: {}` left behind.
    h.write(&chart, "/spec/container/title/show", json!(true)).unwrap();
    assert_eq!(h.chart_container(&chart), Some(json!({"title": {"show": true}})));
    h.write(&chart, "/spec/container/title/show", Value::Null).expect_err("a boolean literal is never null");
    h.undo();
    assert_eq!(h.chart_container(&chart), None, "the container key is gone again");
}

/// R5's one spelling, on the door: the catalog refuses the container's title
/// text, AND the door called directly refuses it too (it is never laxer than
/// the catalog), AND `forbid_chart_title_leaves` refuses what `with_field`
/// would build -- all before the effect.
#[test]
fn a_chart_title_text_in_the_container_is_refused_everywhere() {
    let h = H::new();
    let chart = h.chart();
    h.clean();
    for leaf in ["text", "color", "fontSize"] {
        let path = format!("/spec/container/title/{leaf}");
        let value = if leaf == "fontSize" { json!(14) } else { json!("#123456") };
        assert!(h.write(&chart, &path, value.clone()).is_err(), "{path} via write_literal");
        assert!(write_container_literal(&h.ctx(), &chart, &path, value.clone()).is_err(), "{path} called directly");
        let built = VisualContainerFormat::default().with_field(&format!("/title/{leaf}"), value).unwrap();
        assert!(built.forbid_chart_title_leaves().is_err(), "{leaf}: the second spelling");
    }
    assert!(!h.file.is_dirty());
    assert_eq!(h.depth(), 0);
    assert_eq!(h.chart_container(&chart), None);
}

/// SABOTAGE (confirmed): build the pivot request with `canvas_frame:
/// Some(config)` where `config.x = 0.0` -> "the frame geometry is kept" fails
/// (and the locked page refuses it).
#[test]
fn a_pivot_box_container_literal_keeps_the_frame_geometry() {
    let h = H::new();
    let pivot = h.pivot(true);
    let before = h.pivot_frame(&pivot);
    // Formatting passes a Lock Objects page.
    h.lock_objects(true);
    round_trip(&h, &pivot, "/canvasFrame/container", "pivot", "Format pivot", || {
        radius_of(&h.pivot_frame(&pivot).container)
    });
    h.write(&pivot, "/canvasFrame/container/title/text", json!("Sales by region")).unwrap();
    let after = h.pivot_frame(&pivot);
    assert_eq!(
        (after.x, after.y, after.width, after.height, after.frozen_headers),
        (before.x, before.y, before.width, before.height, before.frozen_headers),
        "the frame geometry is kept"
    );
    assert_eq!(after.container.unwrap().title.unwrap().text.as_deref(), Some("Sales by region"));

    // A worksheet pivot has no box: refused, cleanly.
    let sheet_pivot = h.pivot(false);
    h.clean();
    let depth = h.depth();
    let err = h.write(&sheet_pivot, "/canvasFrame/container/border/radius", json!(4)).unwrap_err();
    assert!(err.contains("worksheet"), "{err}");
    assert!(!h.file.is_dirty());
    assert_eq!(h.depth(), depth);
}

#[test]
fn a_slicer_container_literal_rides_update_slicer_core() {
    let h = H::new();
    let slicer = h.slicer();
    round_trip(&h, &slicer, "/container", "slicer", "Update slicer", || radius_of(&h.slicer_container(&slicer)));
}

#[test]
fn a_timeline_container_literal_rides_update_timeline_slicer_core() {
    let h = H::new();
    let timeline = h.timeline();
    round_trip(&h, &timeline, "/container", "slicer", "Update timeline slicer", || {
        radius_of(&h.timeline_container(&timeline))
    });
}

/// A floating range's container is formatting: a Lock Objects page lets the
/// write through (its padding and title are never bound -- the catalog
/// refuses them).
#[test]
fn a_floating_range_container_literal_passes_a_locked_page() {
    let h = H::new();
    let fr = h.floating_range();
    h.lock_objects(true);
    round_trip(&h, &fr, "/container", "floatingRanges", "Format floating range", || {
        radius_of(&h.floating_range_container(&fr))
    });
    h.clean();
    for path in ["/container/padding/top", "/container/title/text", "/container/title/show"] {
        assert!(h.write(&fr, path, json!(4)).is_err(), "{path} is never bound");
    }
    assert!(!h.file.is_dirty());
}

// ---------------------------------------------------------------------------
// Colours: rgb() is stored and painted as hex
// ---------------------------------------------------------------------------

/// The binding colour type accepts `rgb(...)`, a container colour is hex only:
/// the literal door converts, so the value lands instead of being refused late.
///
/// SABOTAGE (confirmed): drop the `normalize_if_container_colour` line from
/// `write_literal` -> "border.color must be empty or a #rgb, #rrggbb or
/// #rrggbbaa colour." here, and the control test's rgb write is refused too.
#[test]
fn an_rgb_container_colour_is_stored_as_hex() {
    let h = H::new();
    let slicer = h.slicer();
    h.write(&slicer, "/container/border/color", json!("rgb(255, 0, 16)")).expect("rgb() converts");
    let stored = h.slicer_container(&slicer).unwrap().border.unwrap().color;
    assert_eq!(stored.as_deref(), Some("#ff0010"));
    h.write(&slicer, "/container/shadow/color", json!("rgba(0,0,0,0.5)")).expect("rgba() converts");
    assert_eq!(h.slicer_container(&slicer).unwrap().shadow.unwrap().color.as_deref(), Some("#00000080"));

    // The helpers, directly (eval.rs uses the same one on a resolved value).
    assert!(is_container_colour_path(ObjectBindingKind::Chart, "/spec/container/background/color"));
    assert!(is_container_colour_path(ObjectBindingKind::Control, "/properties/containerTitleColor"));
    assert!(!is_container_colour_path(ObjectBindingKind::Control, "/properties/fill"), "not a container key");
    assert!(!is_container_colour_path(ObjectBindingKind::Chart, "/spec/config/theme/titleColor"));
    assert!(!is_container_colour_path(ObjectBindingKind::Pivot, "/canvasFrame/container/border/width"));
    assert_eq!(normalize_container_colour(json!("rgb(1, 2, 3)")), json!("#010203"));
    assert_eq!(normalize_container_colour(json!("#abc")), json!("#abc"));
    assert_eq!(normalize_container_colour(json!("")), json!(""));
    assert_eq!(normalize_container_colour(json!("red")), json!("red"), "left for the leaf check to name");
    assert_eq!(
        normalize_if_container_colour(ObjectBindingKind::Chart, "/spec/config/theme/titleColor", json!("rgb(1,2,3)")),
        json!("rgb(1,2,3)"),
        "a Family colour row keeps its spelling"
    );
}

/// A BOUND container colour resolving to `rgb(...)` is handed to the painter as
/// hex (eval.rs `evaluate_one`), never left for the TS resolver to ignore
/// (which would show the stored literal with no error anywhere). A Family
/// colour row keeps the spelling its formula returned.
///
/// SABOTAGE (confirmed): drop the `normalize_if_container_colour` line from
/// `evaluate_one` -> the resolved value is "rgb(255, 0, 16)".
#[test]
fn a_bound_rgb_container_colour_resolves_to_hex() {
    let h = H::new();
    let slicer = h.slicer();
    let chart = h.chart();
    let cx = super::BindingCx {
        state: &h.state,
        file_state: &h.file,
        slicers: &h.slicers,
        timelines: &h.timelines,
        pivots: &h.pivots,
        pane: &h.pane,
        ribbon: &h.ribbon,
    };
    let set = |object: &ObjectBindingRef, path: &str| {
        let request: crate::api_types::ObjectBindingsRequest = serde_json::from_value(json!({
            "op": "set", "object": object, "path": path, "formula": "=\"rgb(255, 0, 16)\"", "invariant": true
        }))
        .expect("a set request");
        match super::handle_request(&cx, &[], request).expect("set").response {
            crate::api_types::ObjectBindingsResponse::Binding { binding } => binding.resolved.expect("resolved"),
            other => panic!("expected a binding, got {other:?}"),
        }
    };
    let container = set(&slicer, "/container/border/color");
    assert_eq!(container.error, None, "{container:?}");
    assert_eq!(container.value, json!("#ff0010"), "a container colour resolves to hex");
    let family = set(&chart, "/spec/config/theme/titleColor");
    assert_eq!(family.value, json!("rgb(255, 0, 16)"), "a Family colour row is left as written");
}

// ---------------------------------------------------------------------------
// Controls: flat container keys ride the control arm
// ---------------------------------------------------------------------------

/// A control's container keys are Family rows: the control arm writes them
/// through `set_control_property_core` (ONE "Set property" step), a colour in
/// `rgb()` is stored as hex, and the key's value check refuses before the
/// effect.
#[test]
fn a_control_container_key_literal_rides_the_control_arm() {
    let h = H::new();
    let (shape, key) = h.shape();
    h.clean();
    h.write(&shape, "/properties/containerTitleFontSize", json!(14)).expect("a font size");
    assert_eq!(h.control_prop(key, "containerTitleFontSize").as_deref(), Some("14"));
    assert!(h.file.is_dirty());
    assert_eq!(h.depth(), 1);
    h.write(&shape, "/properties/containerTitleColor", json!("rgb(0, 128, 255)")).expect("rgb converts");
    assert_eq!(h.control_prop(key, "containerTitleColor").as_deref(), Some("#0080ff"));
    h.write(&shape, "/properties/containerShadowPosition", json!("TOPLEFT")).expect("enum, canonical spelling");
    assert_eq!(h.control_prop(key, "containerShadowPosition").as_deref(), Some("topLeft"));

    h.clean();
    let depth = h.depth();
    let err = h.write(&shape, "/properties/containerTitleFontSize", json!(200)).unwrap_err();
    assert_eq!(err, "containerTitleFontSize must be a number from 6 to 96.");
    assert!(!h.file.is_dirty(), "refused before the effect");
    assert_eq!(h.depth(), depth);
    assert!(h.write(&shape, "/properties/containerLockAspect", json!(true)).is_err(), "never bound");
    assert!(
        write_container_literal(&h.ctx(), &shape, "/properties/containerTitleFontSize", json!(12)).is_err(),
        "a control has no container root: its keys are not this door's"
    );
}

/// WP-C S14: a script reaches a control's container keys through TWO doors --
/// the KEY door (`shape.setProperty` -> `set_control_property_core`) and WP-D's
/// POINTER door (`property.set` -> `write_literal` -> the control arm, which
/// ends in the same core). A bad value of the field's own kind is refused by
/// BOTH with ONE sentence (`visual_format::check_control_container_value`),
/// before any effect; a good value is stored as the same text by both.
///
/// Where the doors differ, they differ by design and the frontend row says so
/// (validators.ts `controlContainerKeyRefusal` / `controlLiteralText`): the
/// pointer door coerces first (`coerce_literal`: a colour must be a BINDING
/// colour, `rgb()` becomes hex, an enum's case is canonicalised), the key door
/// takes the stored text as it is. So `red` is refused by both but with the
/// catalog's sentence here (the TS row speaks first, with the key's), and
/// `rgb(...)` is stored by the pointer door and refused by the key door.
///
/// SABOTAGE (confirmed 2026-10-16): drop the `check_control_container_value`
/// call from `set_control_property_with` -> every key-door refusal below is
/// `Ok` (the bad value lands on the control).
#[test]
fn both_control_container_doors_refuse_with_one_sentence() {
    let h = H::new();
    let (shape, key) = h.shape();
    let by_key = |name: &str, value: &str| {
        crate::controls::set_control_property_core(
            &h.state,
            &h.file,
            key.0,
            key.1,
            key.2,
            "shape".to_string(),
            name.to_string(),
            "static".to_string(),
            value.to_string(),
        )
    };
    let long_title = "t".repeat(1025);
    let cases: Vec<(&str, &str, Value, &str)> = vec![
        ("containerTitleFontSize", "200", json!(200), "containerTitleFontSize must be a number from 6 to 96."),
        ("containerTitleHeadingLevel", "7", json!(7), "containerTitleHeadingLevel must be a whole number from 0 to 6."),
        ("containerPaddingTop", "201", json!(201), "containerPaddingTop must be a number from 0 to 200."),
        (
            "containerTitleText",
            long_title.as_str(),
            json!(long_title),
            "containerTitleText must be text of at most 1024 characters.",
        ),
        (
            "containerTitleFontFamily",
            "Arial; x",
            json!("Arial; x"),
            "containerTitleFontFamily must be at most 64 letters, digits, spaces, commas, apostrophes or hyphens.",
        ),
    ];
    for (name, key_value, pointer_value, sentence) in cases {
        h.clean();
        let depth = h.depth();
        let by_key_err = by_key(name, key_value).expect_err(name);
        let by_pointer_err = h.write(&shape, &format!("/properties/{name}"), pointer_value).expect_err(name);
        assert_eq!(by_key_err, sentence, "{name}: the key door");
        assert_eq!(by_pointer_err, by_key_err, "{name}: one fact, one sentence");
        assert!(!h.file.is_dirty(), "{name}: refused before the effect");
        assert_eq!(h.depth(), depth, "{name}: nothing recorded");
        assert_eq!(h.control_prop(key, name), None, "{name}: nothing stored");
    }

    // A bad colour: refused by both, nothing stored (the sentences differ here;
    // the frontend row gives the key's sentence on both doors).
    h.clean();
    assert_eq!(
        by_key("containerTitleColor", "red").unwrap_err(),
        "containerTitleColor must be empty or a #rgb, #rrggbb or #rrggbbaa colour."
    );
    assert!(h.write(&shape, "/properties/containerTitleColor", json!("red")).unwrap_err().contains("is not a colour"));
    assert!(!h.file.is_dirty());
    assert_eq!(h.control_prop(key, "containerTitleColor"), None);

    // A good value is stored as the SAME text by both doors.
    by_key("containerTitleFontSize", "14").expect("the key door");
    assert_eq!(h.control_prop(key, "containerTitleFontSize").as_deref(), Some("14"));
    by_key("containerTitleFontSize", "").expect("\"\" is the family default");
    h.write(&shape, "/properties/containerTitleFontSize", json!(14)).expect("the pointer door");
    assert_eq!(h.control_prop(key, "containerTitleFontSize").as_deref(), Some("14"));
    // The coercion difference, pinned: rgb() lands as hex on the pointer door
    // and is refused on the key door, which stores text exactly as given.
    assert!(by_key("containerTitleColor", "rgb(0, 128, 255)").is_err());
    h.write(&shape, "/properties/containerTitleColor", json!("rgb(0, 128, 255)")).expect("rgb converts");
    assert_eq!(h.control_prop(key, "containerTitleColor").as_deref(), Some("#0080ff"));
}

// ---------------------------------------------------------------------------
// The pivot projection
// ---------------------------------------------------------------------------

/// SABOTAGE (confirmed): drop the `container` insert in `pivot_json` -> the
/// projection has no `canvasFrame.container`.
#[test]
fn the_pivot_projection_carries_the_container_only_when_set() {
    let h = H::new();
    let pivot = h.pivot(true);
    let id = identity::EntityId::parse(&pivot.id).unwrap();
    let json_of = || {
        let tables = h.pivots.pivot_tables.read().unwrap();
        super::object_json::pivot_json(&pivot.id, &tables[&id].0)
    };
    let bare = json_of();
    assert!(bare["canvasFrame"].get("container").is_none(), "no container, no key: {bare}");
    assert_eq!(bare["canvasFrame"]["frozenHeaders"], json!(true));

    h.write(&pivot, "/canvasFrame/container/border/radius", json!(8)).unwrap();
    h.write(&pivot, "/canvasFrame/container/title/headingLevel", json!(2)).unwrap();
    let framed = json_of();
    assert_eq!(framed.pointer("/canvasFrame/container/border/radius").and_then(Value::as_f64), Some(8.0));
    assert_eq!(framed.pointer("/canvasFrame/container/title/headingLevel"), Some(&json!(2)), "camelCase leaves");
    assert_eq!(framed["canvasFrame"]["x"], json!(40.0), "geometry still projected");

    // The projection IS what the bindable pointer addresses.
    let cx = super::object_json::ObjectStores {
        state: &h.state,
        slicers: &h.slicers,
        timelines: &h.timelines,
        pivots: &h.pivots,
    };
    let doc = super::object_json::object_json(&cx, &pivot).unwrap();
    assert_eq!(doc.pointer("/canvasFrame/container/border/radius").and_then(Value::as_f64), Some(8.0));

    // An empty container (every leaf cleared) projects no key either.
    let mut def_frame = h.pivot_frame(&pivot);
    def_frame.container = Some(container(json!({})));
    h.pivots.pivot_tables.write(&test_seed_effect()).unwrap().get_mut(&id).unwrap().0.canvas_frame = Some(def_frame);
    assert!(json_of()["canvasFrame"].get("container").is_none());
}
