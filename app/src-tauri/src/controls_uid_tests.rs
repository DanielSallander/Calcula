//! FILENAME: app/src-tauri/src/controls_uid_tests.rs
// PURPOSE: WP-D S5a (D §3.13). A control's STABLE identity (`uid`) -- what a
//          property binding names it by -- is minted once, by ONE helper
//          (`assign_uid`), and carried unchanged by every move, structural
//          shift, undo and pull; a paste is a new object. The three write doors
//          refuse a formula-typed property (a formula is a binding now) and
//          carry a CODE slot's value type byte-identical. And
//          `resolve_control_properties` is the overlay of literals and resolved
//          bindings, with no evaluator of its own.

use super::*;
use crate::api_types::{ObjectBindingKind, ObjectBindingRef, ResolvedBinding};
use crate::document_effect::test_seed_effect;
use crate::object_bindings::store::{BindingKey, StoredBinding};
use crate::persistence::FileState;

fn stat(v: &str) -> ControlPropertyValue {
    ControlPropertyValue { value_type: "static".into(), value: v.into() }
}

fn formula(v: &str) -> ControlPropertyValue {
    ControlPropertyValue { value_type: "formula".into(), value: v.into() }
}

fn meta(control_type: &str, uid: &str, props: &[(&str, ControlPropertyValue)]) -> ControlMetadata {
    ControlMetadata {
        control_type: control_type.into(),
        uid: uid.into(),
        properties: props.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
    }
}

fn uid_at(state: &AppState, key: ControlKey) -> String {
    state.controls.read().unwrap().get(&key).map(|m| m.uid.clone()).expect("a control at the key")
}

fn depth(state: &AppState) -> usize {
    state.undo_stack.lock().unwrap().undo_depth()
}

/// Everything `apply_changes` (the shared body of Ctrl+Z / Ctrl+Y) reaches.
struct Sides {
    files: crate::persistence::UserFilesState,
    pivots: crate::pivot::types::PivotState,
    slicers: crate::slicer::SlicerState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
    pane: crate::pane_control::PaneControlState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
}

impl Sides {
    fn new() -> Sides {
        Sides {
            files: crate::persistence::UserFilesState::default(),
            pivots: crate::pivot::types::PivotState::new(),
            slicers: crate::slicer::SlicerState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    fn undo(&self, state: &AppState, file: &FileState) {
        let t = state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
        crate::undo_commands::apply_changes(
            state, file, &self.files, &self.pivots, &self.slicers, &self.ribbon, &self.pane, &self.timelines, t, true,
        );
    }
}

// ===========================================================================
// The uid
// ===========================================================================

/// Every creating door mints a uid -- a real, distinct id -- and an ordinary
/// property write keeps it.
///
/// SABOTAGE: make `assign_uid` return `incoming.to_string()` unconditionally
/// (a create with nothing incoming then stores an empty uid).
#[test]
fn uid_minted_on_create() {
    let state = crate::create_app_state();
    let file = FileState::default();

    let made = set_control_metadata_core(&state, &file, 0, 2, 1, meta("button", "", &[("text", stat("Go"))]))
        .expect("create through the metadata door");
    assert!(identity::EntityId::parse(&made.uid).is_some(), "a minted uid is a canonical id: {:?}", made.uid);
    assert_eq!(uid_at(&state, (0, 2, 1)), made.uid, "the door RETURNS the stored uid");

    let created = set_control_property_core(
        &state, &file, 0, 5, 5, "shape".into(), "text".into(), "static".into(), "Hi".into(),
    )
    .expect("create through the property door");
    assert!(identity::EntityId::parse(&created.uid).is_some(), "{:?}", created.uid);
    assert_ne!(created.uid, made.uid, "two controls, two identities");

    let edited = set_control_property_core(
        &state, &file, 0, 5, 5, String::new(), "text".into(), "static".into(), "Bye".into(),
    )
    .expect("an ordinary property write");
    assert_eq!(edited.uid, created.uid, "a property write keeps the uid");
}

/// A move, an inserted row above the control (the structural shift re-keys it)
/// and the undo of each carry the SAME uid -- the whole point of an identity
/// that is not the anchor cell.
///
/// SABOTAGE: in `move_control_core`, clear `moved.uid` before it is stored.
#[test]
fn uid_kept_on_move_shift_undo() {
    let state = crate::create_app_state();
    let file = FileState::default();
    let sides = Sides::new();
    let uid = set_control_metadata_core(&state, &file, 0, 2, 1, meta("button", "", &[("text", stat("Go"))]))
        .expect("create")
        .uid;

    let moved = move_control_core(&state, &file, 0, (2, 1), (3, 1), HashMap::new()).expect("move");
    assert_eq!(moved.uid, uid, "a move carries the uid");
    assert_eq!(uid_at(&state, (0, 3, 1)), uid);

    crate::commands::structure::insert_rows_impl(
        &state, &file, &sides.pivots, &sides.files, &sides.pane, &sides.ribbon, &sides.slicers, &sides.timelines,
        0, 2, None,
    )
    .expect("insert two rows above the control");
    assert!(!state.controls.read().unwrap().contains_key(&(0, 3, 1)), "precondition: the shift re-keyed it");
    assert_eq!(uid_at(&state, (0, 5, 1)), uid, "a structural shift carries the uid");

    sides.undo(&state, &file);
    assert_eq!(uid_at(&state, (0, 3, 1)), uid, "undoing the shift carries the uid");
    sides.undo(&state, &file);
    assert_eq!(uid_at(&state, (0, 2, 1)), uid, "undoing the move carries the uid");
}

/// A paste / duplicate / clipboard copy arrives carrying its SOURCE's uid and
/// lands at a NEW key: it is re-minted, and the source keeps its own. A unique
/// incoming uid at a new key is kept (a pull's, say).
///
/// SABOTAGE: drop the `!taken(incoming)` half of `assign_uid`'s rule (a).
#[test]
fn colliding_uid_is_reminted_on_a_new_key() {
    let state = crate::create_app_state();
    let file = FileState::default();
    let source = set_control_metadata_core(&state, &file, 0, 1, 1, meta("shape", "", &[("text", stat("A"))]))
        .expect("source")
        .uid;

    let pasted = set_control_metadata_core(&state, &file, 0, 4, 4, meta("shape", &source, &[("text", stat("A"))]))
        .expect("paste");
    assert_ne!(pasted.uid, source, "a copy is a new object, never a second name for its source");
    assert!(identity::EntityId::parse(&pasted.uid).is_some());
    assert_eq!(uid_at(&state, (0, 1, 1)), source, "the source keeps its uid");

    let carried = set_control_metadata_core(&state, &file, 0, 6, 6, meta("shape", "uid-from-elsewhere", &[]))
        .expect("a unique incoming uid");
    assert_eq!(carried.uid, "uid-from-elsewhere", "a uid no other control carries is kept");
}

/// `set_control_metadata` is wholesale REPLACEMENT at an existing key: the
/// existing uid survives whatever arrives -- empty, or another control's.
///
/// SABOTAGE: drop the existing-key branch of `assign_uid` (rule b).
#[test]
fn replace_at_same_key_keeps_the_existing_uid() {
    let state = crate::create_app_state();
    let file = FileState::default();
    let uid = set_control_metadata_core(&state, &file, 0, 2, 2, meta("button", "", &[("text", stat("Go"))]))
        .expect("create")
        .uid;
    let other = set_control_metadata_core(&state, &file, 0, 9, 9, meta("button", "", &[])).expect("other").uid;

    let replaced = set_control_metadata_core(&state, &file, 0, 2, 2, meta("button", "", &[("text", stat("Stop"))]))
        .expect("replace with an empty uid");
    assert_eq!(replaced.uid, uid, "an EMPTY incoming uid must not orphan the control's bindings");
    for foreign in [other.as_str(), "a-foreign-uid"] {
        let replaced = set_control_metadata_core(&state, &file, 0, 2, 2, meta("button", foreign, &[]))
            .expect("replace with a foreign uid");
        assert_eq!(replaced.uid, uid, "a FOREIGN incoming uid ({foreign}) must not re-identify the control");
    }
    assert_eq!(uid_at(&state, (0, 2, 2)), uid);
    assert_eq!(uid_at(&state, (0, 9, 9)), other);
}

/// The load / pull door keeps a stored uid, mints for a control with none, and
/// re-mints one that ANOTHER control already carries.
#[test]
fn materialize_keeps_a_stored_uid_and_mints_a_missing_or_colliding_one() {
    let sheet = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let saved = vec![persistence::SavedSheetControls {
        sheet_id: sheet,
        controls: serde_json::json!([
            { "row": 1, "col": 1, "controlType": "button", "uid": "u-1", "properties": {} },
            { "row": 2, "col": 1, "controlType": "button", "properties": {} },
            { "row": 3, "col": 1, "controlType": "button", "uid": "u-1", "properties": {} }
        ]),
    }];
    let mut store: ControlStorage = HashMap::new();
    assert_eq!(materialize_saved_controls(&saved, &mut store, |_| Some(0), &PageTargetRemap::identity()), 3);
    assert_eq!(store[&(0, 1, 1)].uid, "u-1", "a stored uid is carried");
    assert!(identity::EntityId::parse(&store[&(0, 2, 1)].uid).is_some(), "a missing uid is minted");
    assert_ne!(store[&(0, 3, 1)].uid, "u-1", "a duplicate uid is re-minted");
    assert!(!store[&(0, 3, 1)].uid.is_empty());

    // And it round-trips through the save carrier.
    let carried = collect_controls_for_save(&store, &[sheet]);
    let mut back: ControlStorage = HashMap::new();
    materialize_saved_controls(&carried, &mut back, |_| Some(0), &PageTargetRemap::identity());
    for key in [(0, 1, 1), (0, 2, 1), (0, 3, 1)] {
        assert_eq!(back[&key].uid, store[&key].uid, "{key:?}: the uid survives save + load");
    }
}

// ===========================================================================
// The formula refusal, at all three doors
// ===========================================================================

/// `set_control_property`, `set_control_metadata` and `move_control`'s
/// overrides refuse a formula-typed property -- refused before the effect:
/// nothing written, the document clean, no undo step.
///
/// SABOTAGE: make `refuse_formula_value_type` return `Ok(())`.
#[test]
fn formula_value_type_is_refused() {
    let state = crate::create_app_state();
    state.controls.write(&test_seed_effect()).unwrap().insert((0, 1, 1), meta("button", "u-1", &[("text", stat("Go"))]));
    let file = FileState::default();

    for key in ["text", "fill", "name", "x"] {
        let refused = set_control_property_core(
            &state, &file, 0, 1, 1, String::new(), key.into(), "formula".into(), "=A1".into(),
        );
        assert_eq!(refused.unwrap_err(), FORMULA_VALUE_TYPE_REFUSAL, "set_control_property `{key}`");
    }
    let created = set_control_property_core(
        &state, &file, 0, 7, 7, "shape".into(), "text".into(), "formula".into(), "=A1".into(),
    );
    assert_eq!(created.unwrap_err(), FORMULA_VALUE_TYPE_REFUSAL, "a create with a formula-typed property");

    let pasted = set_control_metadata_core(&state, &file, 0, 4, 4, meta("shape", "", &[("text", formula("=A1"))]));
    assert_eq!(pasted.unwrap_err(), FORMULA_VALUE_TYPE_REFUSAL, "set_control_metadata");

    let mut overrides = HashMap::new();
    overrides.insert("text".to_string(), formula("=A1"));
    let moved = move_control_core(&state, &file, 0, (1, 1), (2, 1), overrides);
    assert_eq!(moved.unwrap_err(), FORMULA_VALUE_TYPE_REFUSAL, "move_control overrides");

    let controls = state.controls.read().unwrap();
    assert_eq!(controls.len(), 1, "a refused door wrote a control");
    assert_eq!(controls[&(0, 1, 1)].properties["text"].value, "Go");
    drop(controls);
    assert!(!file.is_dirty(), "a refused door dirtied the document");
    assert_eq!(depth(&state), 0, "a refused door recorded an undo step");

    // Non-vacuity: the same writes, static, go through.
    set_control_property_core(&state, &file, 0, 1, 1, String::new(), "text".into(), "static".into(), "=A1".into())
        .expect("'=A1' as a STATIC literal is text");
    assert_eq!(state.controls.read().unwrap()[&(0, 1, 1)].properties["text"].value, "=A1");
}

/// A CODE slot's value type is its application's: the doors carry it
/// byte-identical instead of refusing it (the refusal is for the bindable
/// keys, not for code).
///
/// SABOTAGE: drop `is_code_slot(key)` from `refuse_formula_value_type`.
#[test]
fn code_slot_value_types_are_carried_unchanged() {
    let state = crate::create_app_state();
    let file = FileState::default();

    // set_control_property: an executable slot written formula-typed.
    state.controls.write(&test_seed_effect()).unwrap().insert((0, 1, 1), meta("button", "u-1", &[]));
    set_control_property_core(&state, &file, 0, 1, 1, String::new(), "onSelect".into(), "formula".into(), "=A1".into())
        .expect("a code slot keeps its value type");
    let stored = state.controls.read().unwrap()[&(0, 1, 1)].properties["onSelect"].clone();
    assert_eq!((stored.value_type.as_str(), stored.value.as_str()), ("formula", "=A1"));

    // set_control_metadata: executable and action slots carried.
    let made = set_control_metadata_core(
        &state,
        &file,
        0,
        3,
        3,
        meta(
            "button",
            "",
            &[("onSelect", formula("=B1")), ("macroRef", formula("macro-1")), ("action", formula("navigate"))],
        ),
    )
    .expect("code slots keep their value types at the metadata door");
    for (key, value) in [("onSelect", "=B1"), ("macroRef", "macro-1"), ("action", "navigate")] {
        let p = &made.properties[key];
        assert_eq!((p.value_type.as_str(), p.value.as_str()), ("formula", value), "{key}");
    }

    // move_control: a move carries the control's code -- held compartment
    // included -- byte-identical, value types and all.
    let held = crate::controls::HELD_ON_SELECT_PROPERTY;
    state.controls.write(&test_seed_effect()).unwrap().insert(
        (0, 5, 5),
        meta("button", "u-5", &[("onSelect", formula("=C1")), (held, formula("=D1")), ("text", stat("Go"))]),
    );
    let mut overrides = HashMap::new();
    overrides.insert(PIN_TO_GRID_PROPERTY.to_string(), stat("false"));
    let moved = move_control_core(&state, &file, 0, (5, 5), (6, 5), overrides).expect("move");
    assert_eq!((moved.properties["onSelect"].value_type.as_str(), moved.properties["onSelect"].value.as_str()), ("formula", "=C1"));
    assert_eq!((moved.properties[held].value_type.as_str(), moved.properties[held].value.as_str()), ("formula", "=D1"));
    assert_eq!(moved.uid, "u-5");
}

// ===========================================================================
// resolve_control_properties: literals + resolved bindings, nothing evaluated
// ===========================================================================

fn bind(state: &AppState, uid: &str, path: &str) -> BindingKey {
    let key = BindingKey { object: ObjectBindingRef { kind: ObjectBindingKind::Control, id: uid.into() }, path: path.into() };
    state
        .object_bindings
        .write(&test_seed_effect())
        .unwrap()
        .bindings
        .insert(key.clone(), StoredBinding { formula: "=Sheet1!A1".into(), model: None });
    key
}

fn resolve(state: &AppState, key: BindingKey, value: serde_json::Value, display: &str, error: Option<&str>, pending: bool) {
    state.object_binding_runtime.lock().unwrap().resolved.insert(
        key.clone(),
        ResolvedBinding {
            object: key.object.clone(),
            path: key.path.clone(),
            value,
            display: display.into(),
            error: error.map(str::to_string),
            pending,
        },
    );
}

/// A bound property paints its resolved value; it keeps its literal while
/// pending, while unevaluated and -- for every type but text -- in error; a
/// text property shows its error display. A runtime value whose binding the
/// store no longer holds (an undo removed it) is not overlaid.
///
/// SABOTAGE: drop the `bound` store filter (the stale `color` value paints).
#[test]
fn resolve_control_properties_overlays_the_resolved_bindings() {
    let state = crate::create_app_state();
    state.controls.write(&test_seed_effect()).unwrap().insert(
        (0, 1, 1),
        meta(
            "shape",
            "u-1",
            &[
                ("text", stat("")),
                ("tooltip", stat("tip")),
                ("fill", stat("#000000")),
                ("fontSize", stat("10")),
                ("fontBold", stat("false")),
                ("color", stat("#111111")),
                ("textColor", stat("#222222")),
            ],
        ),
    );
    let text = bind(&state, "u-1", "/properties/text");
    let tooltip = bind(&state, "u-1", "/properties/tooltip");
    let fill = bind(&state, "u-1", "/properties/fill");
    let size = bind(&state, "u-1", "/properties/fontSize");
    let bold = bind(&state, "u-1", "/properties/fontBold");
    let _unevaluated = bind(&state, "u-1", "/properties/textColor");
    resolve(&state, text, serde_json::json!(null), "#REF!", Some("The sheet is gone."), false);
    resolve(&state, tooltip, serde_json::json!(null), "", None, true);
    resolve(&state, fill, serde_json::json!(null), "#VALUE!", Some("not a colour"), false);
    resolve(&state, size, serde_json::json!(12.5), "12.5", None, false);
    resolve(&state, bold, serde_json::json!(true), "TRUE", None, false);
    let stale = BindingKey {
        object: ObjectBindingRef { kind: ObjectBindingKind::Control, id: "u-1".into() },
        path: "/properties/color".into(),
    };
    resolve(&state, stale, serde_json::json!("#ff0000"), "#ff0000", None, false);

    let shown = resolve_control_properties_core(&state, 0, 1, 1);
    assert_eq!(shown["text"], "#REF!", "a TEXT property shows its error display");
    assert_eq!(shown["tooltip"], "tip", "a pending value keeps the literal");
    assert_eq!(shown["fill"], "#000000", "a non-text error keeps the literal");
    assert_eq!(shown["fontSize"], "12.5", "a number in its shortest spelling");
    assert_eq!(shown["fontBold"], "true", "a boolean as true/false");
    assert_eq!(shown["textColor"], "#222222", "an unevaluated binding keeps the literal");
    assert_eq!(shown["color"], "#111111", "a value whose binding is gone is not overlaid");

    // A control with no uid has no bindings: its literals, as they are.
    state.controls.write(&test_seed_effect()).unwrap().insert((0, 2, 2), meta("shape", "", &[("text", stat("plain"))]));
    assert_eq!(resolve_control_properties_core(&state, 0, 2, 2)["text"], "plain");
    assert!(resolve_control_properties_core(&state, 0, 9, 9).is_empty(), "no control, nothing");
}
