//! FILENAME: app/src-tauri/src/object_bindings/control_spelling_tests.rs
// PURPOSE: A control's background and border have ONE spelling per type
//          (BUG-0491), and a solid background colour on a Page Navigator paints
//          (BUG-0510 (1)), whichever door the write takes: the control door
//          (`set_control_property_core`, what `shape.setProperty` reaches), the
//          Format pane's batch, a binding literal (`setLiteral`, the route of a
//          script's `property.set`, MCP `set_object_property` and the in-app
//          AI), and a binding's `set`.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::store::BindingKey;
use super::*;
use crate::api_types::{
    ControlAppearanceChange, ControlAppearanceWrite, ObjectBindingKind, ObjectBindingRef, ObjectBindingsRequest,
    ObjectBindingsResponse,
};
use crate::controls::{ControlMetadata, ControlPropertyValue, PAGE_NAVIGATOR_CONTROL_TYPE};
use crate::document_effect::test_seed_effect;
use crate::persistence::{FileState, UserFilesState};

struct Wb {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    slicers: crate::slicer::SlicerState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
    pivots: crate::pivot::types::PivotState,
    pane: crate::pane_control::PaneControlState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
}

impl Wb {
    fn new() -> Wb {
        Wb {
            state: crate::create_app_state(),
            file: FileState::default(),
            files: UserFilesState::default(),
            slicers: crate::slicer::SlicerState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
        }
    }

    fn cx(&self) -> BindingCx<'_> {
        BindingCx {
            state: &self.state,
            file_state: &self.file,
            slicers: &self.slicers,
            timelines: &self.timelines,
            pivots: &self.pivots,
            pane: &self.pane,
            ribbon: &self.ribbon,
            user_files: &self.files,
        }
    }

    fn send(&self, request: Value) -> Result<ObjectBindingsResponse, String> {
        let request: ObjectBindingsRequest =
            serde_json::from_value(request.clone()).unwrap_or_else(|e| panic!("{request} does not deserialize: {e}"));
        handle_request(&self.cx(), &[], request).map(|h| h.response)
    }

    fn control(&self, anchor: (usize, u32, u32), uid: &str, control_type: &str, props: &[(&str, &str)]) -> ObjectBindingRef {
        let properties: HashMap<String, ControlPropertyValue> = props
            .iter()
            .map(|(k, v)| (k.to_string(), ControlPropertyValue { value_type: "static".to_string(), value: v.to_string() }))
            .collect();
        self.state.controls.write(&test_seed_effect()).unwrap().insert(
            anchor,
            ControlMetadata { control_type: control_type.to_string(), uid: uid.to_string(), properties },
        );
        ObjectBindingRef { kind: ObjectBindingKind::Control, id: uid.to_string() }
    }

    fn prop(&self, anchor: (usize, u32, u32), key: &str) -> Option<String> {
        self.state.controls.read().unwrap().get(&anchor).and_then(|m| m.properties.get(key)).map(|p| p.value.clone())
    }

    fn write(&self, anchor: (usize, u32, u32), key: &str, value: &str) -> Result<ControlMetadata, String> {
        let (s, r, c) = anchor;
        crate::controls::set_control_property_core(
            &self.state,
            &self.file,
            s,
            r,
            c,
            String::new(),
            key.to_string(),
            "static".to_string(),
            value.to_string(),
        )
    }

    fn has_binding(&self, object: &ObjectBindingRef, path: &str) -> bool {
        self.state
            .object_bindings
            .read()
            .unwrap()
            .bindings
            .contains_key(&BindingKey { object: object.clone(), path: path.to_string() })
    }

    fn undo(&self) {
        let t = self.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
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
}

const SHAPE: (usize, u32, u32) = (0, 1, 1);
const BUTTON: (usize, u32, u32) = (0, 2, 2);
const PICTURE: (usize, u32, u32) = (0, 3, 3);
const NAV: (usize, u32, u32) = (0, 4, 4);

/// BUG-0491: on a shape, a text box, a button and a picture the flat
/// `containerBackground*` / `containerBorder{Show,Color,Width}` keys are a
/// second spelling of `fill` / `stroke` (a button's `borderColor`) /
/// `strokeWidth` that nothing paints. Every door refuses a non-empty one with
/// a sentence naming the real key, and stores nothing; `""` (the default), the
/// live `containerBackgroundTransparency`, and the same keys on a Page
/// Navigator (whose container they ARE) stay writable.
///
/// SABOTAGE: make `dead_container_spelling` answer `None` -- the shape stores
/// `containerBackgroundColor` and the first assertion fails.
#[test]
fn a_painted_controls_dead_container_spelling_is_refused_at_every_door() {
    let wb = Wb::new();
    let shape = wb.control(SHAPE, "shape-1", "shape", &[("fill", "#4472c4")]);
    wb.control(BUTTON, "button-1", "button", &[("text", "Go")]);
    wb.control(PICTURE, "picture-1", "image", &[]);
    wb.control(NAV, "nav-1", PAGE_NAVIGATOR_CONTROL_TYPE, &[]);

    // The control door (shape.setProperty, the Properties pane).
    let err = wb.write(SHAPE, "containerBackgroundColor", "#ff0000").unwrap_err();
    assert!(err.contains("Write 'fill' instead"), "{err}");
    assert_eq!(wb.prop(SHAPE, "containerBackgroundColor"), None, "nothing stored");
    let err = wb.write(BUTTON, "containerBorderColor", "#ff0000").unwrap_err();
    assert!(err.contains("Write 'borderColor' instead"), "a button's border colour is borderColor: {err}");
    let err = wb.write(PICTURE, "containerBorderWidth", "2").unwrap_err();
    assert!(err.contains("Write 'strokeWidth' instead"), "{err}");
    for key in ["containerBackgroundShow", "containerBorderShow"] {
        assert!(wb.write(SHAPE, key, "true").is_err(), "{key} on a shape");
    }
    // A text box is a shape whose shapeType is textBox; the textBox type too.
    wb.control((0, 5, 5), "tb-1", "textBox", &[]);
    assert!(wb.write((0, 5, 5), "containerBackgroundColor", "#ff0000").is_err(), "a text box");
    // Creating a control through the door with one is refused, and creates nothing.
    let (s, r, c) = (0, 9, 9);
    assert!(crate::controls::set_control_property_core(
        &wb.state, &wb.file, s, r, c, "shape".into(), "containerBorderColor".into(), "static".into(), "#000".into()
    )
    .is_err());
    assert!(!wb.state.controls.read().unwrap().contains_key(&(s, r, c)), "no control was created");

    // What stays writable.
    wb.write(SHAPE, "containerBackgroundColor", "").expect("\"\" is the family default");
    wb.write(SHAPE, "containerBackgroundTransparency", "40").expect("a shape's path reads its transparency");
    wb.write(SHAPE, "fill", "#ff0000").expect("the real key");
    wb.write(NAV, "containerBorderColor", "#ff0000").expect("a navigator's container IS these keys");

    // The Format pane's batch: refused whole, nothing written.
    let batch = vec![ControlAppearanceChange {
        sheet_index: 0,
        row: 2,
        col: 2,
        properties: vec![
            ControlAppearanceWrite { key: "text".into(), value: "Stop".into() },
            ControlAppearanceWrite { key: "containerBorderShow".into(), value: "true".into() },
        ],
    }];
    let err = crate::controls::set_control_appearance_core(&wb.state, &wb.file, &batch).unwrap_err();
    assert!(err.contains("Nothing in the format batch was written"), "{err}");
    assert_eq!(wb.prop(BUTTON, "text").as_deref(), Some("Go"), "the batch wrote nothing");

    // A binding literal (property.set, MCP set_object_property, the AI).
    let err = wb
        .send(json!({ "op": "setLiteral", "object": shape, "path": "/properties/containerBackgroundColor", "value": "#00ff00" }))
        .unwrap_err();
    assert!(err.contains("Write 'fill' instead"), "{err}");
    assert_eq!(wb.prop(SHAPE, "containerBackgroundColor"), None, "the literal stored nothing (a \"\" write of a dead key drops it)");

    // A binding: a formula may not follow the dead key either.
    let err = wb
        .send(json!({ "op": "set", "object": shape, "path": "/properties/containerBorderColor", "formula": "=\"#00ff00\"", "invariant": true }))
        .unwrap_err();
    assert!(err.contains("Write 'stroke' instead"), "{err}");
    assert!(!wb.has_binding(&shape, "/properties/containerBorderColor"), "no binding stored");
}

/// BUG-0510 (1): a Page Navigator's background is OFF by default and lives in
/// flat keys, so a colour written alone through the control arm used to be
/// reported as written while nothing showed it. A non-empty colour write now
/// also shows the background (the solid-commit rule, ruling Q9); `""` does
/// not; a shown background is left alone; the same colour again on a hidden
/// background is a change; and the binding-literal route's Ctrl+Z takes the
/// companion back with the colour.
///
/// SABOTAGE: make `solid_background_companion` answer `None` -- the first
/// `containerBackgroundShow` assertion reads `None`.
#[test]
fn a_navigator_background_colour_write_shows_the_background() {
    let wb = Wb::new();
    let nav = wb.control(NAV, "nav-1", PAGE_NAVIGATOR_CONTROL_TYPE, &[]);

    wb.write(NAV, "containerBackgroundColor", "#ff0000").unwrap();
    assert_eq!(wb.prop(NAV, "containerBackgroundShow").as_deref(), Some("true"), "the colour shows");

    // "" is the default, not a colour: visibility untouched.
    wb.write(NAV, "containerBackgroundShow", "false").unwrap();
    wb.write(NAV, "containerBackgroundColor", "").unwrap();
    assert_eq!(wb.prop(NAV, "containerBackgroundShow").as_deref(), Some("false"));

    // Through the binding literal: the colour written again on a hidden
    // background is a change, and one Ctrl+Z hides it again.
    wb.write(NAV, "containerBackgroundColor", "#00ff00").unwrap();
    wb.write(NAV, "containerBackgroundShow", "false").unwrap();
    let written = wb
        .send(json!({ "op": "setLiteral", "object": nav, "path": "/properties/containerBackgroundColor", "value": "#00ff00" }))
        .expect("the literal write");
    assert!(matches!(written, ObjectBindingsResponse::LiteralSet { .. }), "{written:?}");
    assert_eq!(wb.prop(NAV, "containerBackgroundShow").as_deref(), Some("true"), "shown by the literal");
    wb.undo();
    assert_eq!(wb.prop(NAV, "containerBackgroundShow").as_deref(), Some("false"), "Ctrl+Z hides it again");
    assert_eq!(wb.prop(NAV, "containerBackgroundColor").as_deref(), Some("#00ff00"));

    // Another family's colour key is not this rule.
    wb.control(SHAPE, "shape-1", "shape", &[]);
    wb.write(SHAPE, "fill", "#ff0000").unwrap();
    assert_eq!(wb.prop(SHAPE, "containerBackgroundShow"), None, "a shape's fill writes no companion");
}

/// BUG-0510 (1), the bound half: a navigator's background colour that FOLLOWS
/// A FORMULA paints like a written one -- `resolve_control_properties` shows
/// the background -- unless its visibility is bound too, which then decides.
///
/// SABOTAGE: drop the `bound_colour` companion in
/// `resolve_control_properties_core` -- the painted show stays absent.
#[test]
fn a_bound_navigator_background_colour_shows_the_background() {
    let wb = Wb::new();
    let nav = wb.control(NAV, "nav-1", PAGE_NAVIGATOR_CONTROL_TYPE, &[("containerBackgroundShow", "false")]);
    wb.send(json!({ "op": "set", "object": nav, "path": "/properties/containerBackgroundColor", "formula": "=\"#00ff00\"", "invariant": true }))
        .expect("bind the colour");
    let (s, r, c) = NAV;
    let painted = crate::controls::resolve_control_properties_core(&wb.state, s, r, c);
    assert_eq!(painted.get("containerBackgroundColor").map(String::as_str), Some("#00ff00"), "{painted:?}");
    assert_eq!(painted.get("containerBackgroundShow").map(String::as_str), Some("true"), "the bound colour shows");
    assert_eq!(wb.prop(NAV, "containerBackgroundShow").as_deref(), Some("false"), "the literal is untouched");

    // A bound visibility decides.
    wb.send(json!({ "op": "set", "object": nav, "path": "/properties/containerBackgroundShow", "formula": "=1=2", "invariant": true }))
        .expect("bind the visibility");
    let painted = crate::controls::resolve_control_properties_core(&wb.state, s, r, c);
    assert_eq!(painted.get("containerBackgroundShow").map(String::as_str), Some("false"), "{painted:?}");
}

/// BUG-0772: a shape's, text box's and button's background TRANSPARENCY is a
/// key their painters read (`containerBackgroundTransparency`), so a formula
/// may follow it -- Rust evaluates the binding and the resolved properties the
/// painter reads carry the bound value (the Format pane offers the bind since
/// this fix; it offered none).
#[test]
fn a_shapes_background_transparency_binds_and_resolves() {
    let wb = Wb::new();
    let shape = wb.control(SHAPE, "shape-1", "shape", &[("fill", "#4472c4")]);
    let button = wb.control(BUTTON, "button-1", "button", &[("text", "Go")]);
    for (object, (s, r, c)) in [(shape, SHAPE), (button, BUTTON)] {
        wb.send(json!({ "op": "set", "object": object, "path": "/properties/containerBackgroundTransparency", "formula": "=20+20", "invariant": true }))
            .expect("a painted key binds");
        assert!(wb.has_binding(&object, "/properties/containerBackgroundTransparency"));
        let painted = crate::controls::resolve_control_properties_core(&wb.state, s, r, c);
        assert_eq!(painted.get("containerBackgroundTransparency").map(String::as_str), Some("40"), "{painted:?}");
    }
}

/// BUG-0491, the remainder: EVERY `container*` key a control's type does not
/// paint (`visual_format::CONTROL_PAINTED_CONTAINER_FIELDS`, the list the
/// Controls painters read) is refused at every write door -- the property
/// door, the CREATE door, the Format pane's batch, a binding literal and a
/// binding's `set` -- naming the real key where one exists; a `""` write of one
/// stores nothing; a dead key a control already carries is dropped on its next
/// write, on load and on a pull (`materialize_saved_controls`), and a stored
/// binding of one is not installed on load.
///
/// SABOTAGE: make `dead_container_key` answer `None` unless the key is a
/// background / border spelling -- the button's title write is accepted and
/// the first assertion fails.
#[test]
fn every_container_key_a_control_does_not_paint_is_refused_and_never_stored() {
    let wb = Wb::new();
    let shape = wb.control(SHAPE, "shape-1", "shape", &[("fill", "#4472c4")]);
    let button = wb.control(BUTTON, "button-1", "button", &[("text", "Go")]);
    wb.control(PICTURE, "picture-1", "image", &[]);
    wb.control(NAV, "nav-1", PAGE_NAVIGATOR_CONTROL_TYPE, &[]);
    wb.control((0, 6, 6), "check-1", "checkbox", &[]);

    // The property door (shape.setProperty, the Properties pane).
    let err = wb.write(BUTTON, "containerTitleShow", "true").unwrap_err();
    assert!(err.contains("not a setting a button has"), "a button has no title: {err}");
    assert_eq!(wb.prop(BUTTON, "containerTitleShow"), None);
    let err = wb.write(BUTTON, "containerTitleText", "Run").unwrap_err();
    assert!(err.contains("Write 'text (a button's caption)' instead"), "{err}");
    assert!(wb.write(BUTTON, "containerPaddingTop", "4").is_err(), "a button has no padding");
    assert!(wb.write(SHAPE, "containerBorderRadius", "8").is_err(), "a shape's path is its outline");
    assert!(wb.write(PICTURE, "containerSpacingBelowSubtitle", "4").is_err(), "a picture has no subtitle");
    assert!(wb.write(PICTURE, "containerDividerShow", "true").is_err(), "nor a divider");
    let err = wb.write(NAV, "containerPaddingTop", "4").unwrap_err();
    assert!(err.contains("Write 'padding' instead"), "a navigator's padding is `padding`: {err}");
    let err = wb.write((0, 6, 6), "containerShadowShow", "true").unwrap_err();
    assert!(err.contains("a 'checkbox' control"), "no container at all: {err}");
    // What each type paints stays writable.
    wb.write(BUTTON, "containerBorderRadius", "6").expect("a button's face radius");
    wb.write(BUTTON, "containerShadowShow", "true").expect("a button's shadow");
    wb.write(SHAPE, "containerTitleShow", "true").expect("a shape's title");
    wb.write(PICTURE, "containerSpacingBelowTitle", "4").expect("a picture's title spacing");
    wb.write(NAV, "containerBorderRadius", "4").expect("a navigator's radius");
    // "" of a dead key is the default: allowed, and stores nothing.
    wb.write(BUTTON, "containerTitleShow", "").expect("\"\" is the default");
    assert_eq!(wb.prop(BUTTON, "containerTitleShow"), None, "a \"\" dead write stores nothing");

    // The CREATE door (paste, duplicate, every insert).
    let create = |props: &[(&str, &str)]| {
        let properties: HashMap<String, ControlPropertyValue> = props
            .iter()
            .map(|(k, v)| (k.to_string(), ControlPropertyValue { value_type: "static".into(), value: v.to_string() }))
            .collect();
        crate::controls::set_control_metadata_core(
            &wb.state,
            &wb.file,
            0,
            9,
            9,
            ControlMetadata { control_type: "button".into(), uid: String::new(), properties },
        )
    };
    let err = create(&[("text", "Go"), ("containerSubtitleShow", "true")]).unwrap_err();
    assert!(err.contains("containerSubtitleShow"), "{err}");
    assert!(!wb.state.controls.read().unwrap().contains_key(&(0, 9, 9)), "nothing was created");
    let made = create(&[("text", "Go"), ("containerSubtitleShow", "")]).expect("a \"\" dead key is dropped");
    assert!(!made.properties.contains_key("containerSubtitleShow"), "{:?}", made.properties);

    // The Format pane's batch.
    let batch = vec![ControlAppearanceChange {
        sheet_index: 0,
        row: 2,
        col: 2,
        properties: vec![ControlAppearanceWrite { key: "containerPaddingLeft".into(), value: "3".into() }],
    }];
    assert!(crate::controls::set_control_appearance_core(&wb.state, &wb.file, &batch).is_err());
    assert_eq!(wb.prop(BUTTON, "containerPaddingLeft"), None);

    // A binding literal and a binding's set.
    let err = wb
        .send(json!({ "op": "setLiteral", "object": shape, "path": "/properties/containerBorderRadius", "value": 8 }))
        .unwrap_err();
    assert!(err.contains("not a setting a shape has"), "{err}");
    let err = wb
        .send(json!({ "op": "set", "object": button, "path": "/properties/containerTitleColor", "formula": "=\"#00ff00\"", "invariant": true }))
        .unwrap_err();
    assert!(err.contains("not a setting a button has"), "{err}");
    assert!(!wb.has_binding(&button, "/properties/containerTitleColor"));

    // A dead key a control already carries goes on its next write...
    wb.control((0, 7, 7), "button-2", "button", &[("text", "Old"), ("containerTitleShow", "true")]);
    wb.write((0, 7, 7), "text", "New").expect("an ordinary write");
    assert_eq!(wb.prop((0, 7, 7), "containerTitleShow"), None, "dropped on the next write");
    assert_eq!(wb.prop((0, 7, 7), "text").as_deref(), Some("New"));

    // ...and on load / a pull.
    let saved = vec![::persistence::SavedSheetControls {
        sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()),
        controls: json!([{
            "row": 1, "col": 1, "controlType": "button", "uid": "b-load",
            "properties": {
                "text": { "valueType": "static", "value": "Go" },
                "containerTitleShow": { "valueType": "static", "value": "true" },
                "containerShadowShow": { "valueType": "static", "value": "true" }
            }
        }]),
    }];
    let mut store = crate::controls::ControlStorage::new();
    crate::controls::materialize_saved_controls(&saved, &mut store, |_| Some(0), &crate::controls::PageTargetRemap::identity());
    let loaded = &store[&(0, 1, 1)];
    assert!(!loaded.properties.contains_key("containerTitleShow"), "a dead key is not loaded");
    assert!(loaded.properties.contains_key("containerShadowShow"), "a painted one is");

    // A stored binding of a dead key is not installed on load.
    wb.send(json!({ "op": "set", "object": button, "path": "/properties/containerShadowColor", "formula": "=\"#00ff00\"", "invariant": true }))
        .expect("a painted key binds");
    let mut rows = wb.state.object_bindings.read().unwrap().snapshot().rows;
    let mut dead = rows.iter().find(|r| r.path == "/properties/containerShadowColor").cloned().expect("the row");
    dead.path = "/properties/containerTitleColor".to_string();
    rows.push(dead);
    let installed = super::store::restore_bindings_from_disk(&wb.state, &rows).unwrap();
    assert_eq!(installed, rows.len() - 1, "the dead-key binding is not installed");
    assert!(wb.has_binding(&button, "/properties/containerShadowColor"));
    assert!(!wb.has_binding(&button, "/properties/containerTitleColor"));
}
