//! FILENAME: app/src-tauri/src/object_bindings/page_overrides_tests.rs
// PURPOSE: A Page Navigator's PER-BUTTON bindings (D §3.18a, WP-D S8d):
//          - the AI-visible JSON projects `pageOverrides` as an object keyed by
//            page (sheetId, or `name:<sheet>`);
//          - a literal write upserts ONE page's entry and leaves every other
//            entry's bytes alone, as one undo step;
//          - a bound caption paints through `resolve_control_properties`, and the
//            stored literal is untouched;
//          - a binding on a page that goes away is DORMANT (no paint, no error),
//            survives the sheet delete's cascade, and resolves again when the page
//            is back;
//          - a `.calp` pull remaps the page segment of the binding's PATH;
//          - the gates: a per-button path on a control that is not a navigator,
//            or on a page that does not exist, is refused at Set and SetLiteral.
// CONTEXT: The fixture is built through the real sheet doors (a sheet delete
//          walks every per-sheet vector): Data (active) and Inputs are
//          worksheets; Report, Sales and Detail are canvas pages, and the
//          navigator sits on Report.

use std::collections::HashMap;

use calcula_format::page_navigator::{parse_page_overrides, serialize_page_overrides, PageOverrideWire};
use engine::Cell;
use serde_json::{json, Value};

use super::page_overrides::*;
use super::store::BindingKey;
use super::*;
use crate::api_types::{ObjectBindingKind, ObjectBindingRef, ObjectBindingsRequest, ObjectBindingsResponse, ResolvedBinding};
use crate::document_effect::test_seed_effect;
use crate::persistence::{FileState, UserFilesState};

const DATA: usize = 0;
const INPUTS: usize = 1;
const REPORT: usize = 2;
const SALES: usize = 3;
const DETAIL: usize = 4;
const NAV_UID: &str = "nav-uid-1";
const NAV_ANCHOR: (usize, u32, u32) = (REPORT, 1, 1);

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
        let wb = Wb {
            state: crate::create_app_state(),
            file: FileState::default(),
            files: UserFilesState::default(),
            slicers: crate::slicer::SlicerState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
        };
        crate::sheets::rename_sheet_inner(&wb.state, &wb.file, &wb.pivots, 0, "Data".to_string(), false)
            .expect("name the first sheet Data");
        crate::sheets::add_sheet_inner(&wb.state, &wb.file, Some("Inputs".to_string()), ::persistence::SheetKind::Worksheet)
            .expect("add Inputs");
        for page in ["Report", "Sales", "Detail"] {
            crate::sheets::add_sheet_inner(&wb.state, &wb.file, Some(page.to_string()), ::persistence::SheetKind::new_canvas())
                .expect("add a canvas page");
        }
        crate::sheets::activate_sheet(&wb.state, DATA).expect("back to Data");
        assert_eq!(
            *wb.state.sheet_names.read().unwrap(),
            ["Data", "Inputs", "Report", "Sales", "Detail"].map(String::from).to_vec(),
            "fixture"
        );
        wb
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

    fn sheet_id(&self, index: usize) -> String {
        self.state.sheet_ids.read().unwrap()[index].to_string()
    }

    fn set_text(&self, sheet: usize, row: u32, col: u32, text: &str) {
        self.state.grids.write(&test_seed_effect()).unwrap()[sheet].set_cell(row, col, Cell::new_text(text.to_string()));
    }

    /// A control at `anchor` with these static properties.
    fn control(&self, anchor: (usize, u32, u32), uid: &str, control_type: &str, props: &[(&str, &str)]) -> ObjectBindingRef {
        let properties: HashMap<String, crate::controls::ControlPropertyValue> = props
            .iter()
            .map(|(k, v)| {
                (
                    k.to_string(),
                    crate::controls::ControlPropertyValue { value_type: "static".to_string(), value: v.to_string() },
                )
            })
            .collect();
        self.state.controls.write(&test_seed_effect()).unwrap().insert(
            anchor,
            crate::controls::ControlMetadata {
                control_type: control_type.to_string(),
                uid: uid.to_string(),
                properties,
            },
        );
        ObjectBindingRef { kind: ObjectBindingKind::Control, id: uid.to_string() }
    }

    /// The navigator on Report with these stored overrides.
    fn navigator(&self, overrides: &str) -> ObjectBindingRef {
        self.control(
            NAV_ANCHOR,
            NAV_UID,
            crate::controls::PAGE_NAVIGATOR_CONTROL_TYPE,
            &[("orientation", "horizontal"), ("pageOverrides", overrides), ("pinToGrid", "false")],
        )
    }

    fn stored_overrides(&self) -> String {
        self.state.controls.read().unwrap()[&NAV_ANCHOR].properties["pageOverrides"].value.clone()
    }

    fn painted_overrides(&self) -> String {
        let (s, r, c) = NAV_ANCHOR;
        crate::controls::resolve_control_properties_core(&self.state, s, r, c)["pageOverrides"].clone()
    }

    fn resolve_all(&self) -> Vec<ResolvedBinding> {
        match self.send(json!({ "op": "resolveAll" })).expect("resolveAll") {
            ObjectBindingsResponse::Resolved { values } => values,
            other => panic!("expected resolved values, got {other:?}"),
        }
    }

    fn resolved(&self, object: &ObjectBindingRef, path: &str) -> Option<ResolvedBinding> {
        self.resolve_all().into_iter().find(|v| &v.object == object && v.path == path)
    }

    fn has_binding(&self, object: &ObjectBindingRef, path: &str) -> bool {
        self.state
            .object_bindings
            .read()
            .unwrap()
            .bindings
            .contains_key(&BindingKey { object: object.clone(), path: path.to_string() })
    }

    fn depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
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

fn set_req(object: &ObjectBindingRef, path: &str, formula: &str) -> Value {
    json!({ "op": "set", "object": object, "path": path, "formula": formula, "invariant": true })
}

fn literal_req(object: &ObjectBindingRef, path: &str, value: Value) -> Value {
    json!({ "op": "setLiteral", "object": object, "path": path, "value": value })
}

fn entry(sheet_id: &str, name: &str) -> PageOverrideWire {
    PageOverrideWire {
        sheet_id: sheet_id.to_string(),
        sheet_name: name.to_string(),
        text: None,
        hidden: None,
        fill: None,
        color: None,
        border_color: None,
    }
}

// ===========================================================================
// The projection
// ===========================================================================

/// `pageOverrides` is projected as an OBJECT keyed by page: the sheetId, or
/// `name:<sheet>` for an entry with no id; every other property stays a string,
/// and a stored value that cannot be read stays the string it is.
///
/// SABOTAGE: drop the navigator branch in `object_json::control_json` -- the
/// property is projected as its raw string and `/properties/pageOverrides/<id>`
/// points at nothing.
#[test]
fn the_projection_is_keyed_by_sheet_id() {
    let wb = Wb::new();
    let sales = wb.sheet_id(SALES);
    let stored = serialize_page_overrides(&[
        PageOverrideWire { text: Some("Revenue".into()), fill: Some("#ff0000".into()), ..entry(&sales, "Sales") },
        PageOverrideWire { hidden: Some(true), ..entry("", "Old page") },
    ]);
    let nav = wb.navigator(&stored);
    let json = match wb.send(json!({ "op": "objectJson", "object": nav })).unwrap() {
        ObjectBindingsResponse::ObjectJson { json } => json,
        other => panic!("{other:?}"),
    };
    let overrides = &json["properties"]["pageOverrides"];
    assert_eq!(overrides[&sales], json!({ "sheetName": "Sales", "text": "Revenue", "fill": "#ff0000" }));
    assert_eq!(overrides["name:Old page"], json!({ "sheetName": "Old page", "hidden": true }));
    assert_eq!(overrides.as_object().unwrap().len(), 2);
    assert_eq!(json["properties"]["orientation"], json!("horizontal"), "every other property stays a string");
    // The pointer a binding uses resolves in it.
    assert_eq!(json.pointer(&format!("/properties/pageOverrides/{sales}/text")), Some(&json!("Revenue")));

    // Unreadable stays a string; a plain button's property never projects.
    let wb = Wb::new();
    let nav = wb.navigator("not json");
    let json = super::object_json::control_json(NAV_UID, &wb.state.controls.read().unwrap()[&NAV_ANCHOR]);
    assert_eq!(json["properties"]["pageOverrides"], json!("not json"));
    let _ = nav;
    let button = wb.control((REPORT, 5, 5), "btn", "button", &[("pageOverrides", "[]")]);
    let meta = wb.state.controls.read().unwrap()[&(REPORT, 5, 5)].clone();
    assert_eq!(super::object_json::control_json(&button.id, &meta)["properties"]["pageOverrides"], json!("[]"));
}

// ===========================================================================
// The literal write
// ===========================================================================

/// A literal write of ONE page's caption upserts that page's entry -- named by
/// its id AND current name -- and leaves every other entry's bytes and place
/// alone; it is one "Set property" undo step, and the undo restores the bytes.
///
/// SABOTAGE: in `upsert_literal`, push a NEW entry instead of replacing the
/// matched one (`Some(i) => list.push(entry)`) -- the Sales page gets two
/// entries and the bytes no longer match.
#[test]
fn a_literal_write_upserts_one_entry_and_leaves_the_others_byte_identical() {
    let wb = Wb::new();
    let (report, sales, detail) = (wb.sheet_id(REPORT), wb.sheet_id(SALES), wb.sheet_id(DETAIL));
    let before = serialize_page_overrides(&[
        PageOverrideWire { fill: Some("#123".into()), ..entry(&report, "Report") },
        PageOverrideWire { text: Some("Old".into()), color: Some("#00ff00".into()), ..entry(&sales, "Sales") },
        PageOverrideWire { hidden: Some(true), ..entry(&detail, "Detail") },
    ]);
    let nav = wb.navigator(&before);
    let depth = wb.depth();

    let path = format!("/properties/pageOverrides/{sales}/text");
    wb.send(literal_req(&nav, &path, json!("Revenue"))).expect("the literal write");
    let after = wb.stored_overrides();
    let expected = serialize_page_overrides(&[
        PageOverrideWire { fill: Some("#123".into()), ..entry(&report, "Report") },
        PageOverrideWire { text: Some("Revenue".into()), color: Some("#00ff00".into()), ..entry(&sales, "Sales") },
        PageOverrideWire { hidden: Some(true), ..entry(&detail, "Detail") },
    ]);
    assert_eq!(after, expected);
    assert_eq!(wb.depth(), depth + 1, "one undo step");

    // A page with no entry gains one, appended; an rgb() colour is stored as hex.
    wb.send(literal_req(&nav, &format!("/properties/pageOverrides/{report}/borderColor"), json!("rgb(255, 0, 16)")))
        .unwrap();
    let list = parse_page_overrides(&wb.stored_overrides()).unwrap();
    assert_eq!(list.len(), 3, "Report's existing entry was updated, not duplicated");
    assert_eq!(list[0].border_color.as_deref(), Some("#ff0010"));
    assert_eq!(list[0].fill.as_deref(), Some("#123"), "its other field kept");

    // Writing the value it already has changes nothing and records nothing.
    let depth = wb.depth();
    wb.send(literal_req(&nav, &path, json!("Revenue"))).unwrap();
    assert_eq!(wb.depth(), depth, "an unchanged write is not a step");

    // Clearing the last field of an entry removes the entry.
    wb.send(literal_req(&nav, &format!("/properties/pageOverrides/{detail}/hidden"), json!(false))).unwrap();
    let list = parse_page_overrides(&wb.stored_overrides()).unwrap();
    assert!(list.iter().all(|e| e.sheet_id != detail), "Detail's only setting was cleared: {list:?}");

    // Undo puts the bytes back, step by step.
    wb.undo();
    wb.undo();
    wb.undo();
    assert_eq!(wb.stored_overrides(), before);
}

/// An entry that names its page only by NAME (no live id) is the page's entry
/// by the frontend's matching rule: the write re-keys it to the page's id
/// instead of adding a second entry the painter would prefer.
#[test]
fn a_name_matched_entry_is_rekeyed_not_duplicated() {
    let wb = Wb::new();
    let sales = wb.sheet_id(SALES);
    let nav = wb.navigator(&serialize_page_overrides(&[PageOverrideWire {
        fill: Some("#abcdef".into()),
        ..entry("app-id-from-elsewhere", "Sales")
    }]));
    wb.send(literal_req(&nav, &format!("/properties/pageOverrides/{sales}/text"), json!("Revenue"))).unwrap();
    assert_eq!(
        parse_page_overrides(&wb.stored_overrides()).unwrap(),
        vec![PageOverrideWire { text: Some("Revenue".into()), fill: Some("#abcdef".into()), ..entry(&sales, "Sales") }]
    );
}

/// The gates of a per-button path: a navigator only, a live page only, a
/// caption within the frontend's limit; and `/properties/pageOverrides` itself
/// or a page's identity field never, at Set or at SetLiteral.
#[test]
fn per_button_paths_are_refused_off_a_navigator_or_a_live_page() {
    let wb = Wb::new();
    let sales = wb.sheet_id(SALES);
    let nav = wb.navigator("[]");
    let button = wb.control((REPORT, 6, 6), "btn-1", "button", &[("text", "Go")]);
    let path = format!("/properties/pageOverrides/{sales}/text");

    let err = wb.send(set_req(&button, &path, "=Inputs!A1")).unwrap_err();
    assert!(err.contains("Page Navigator"), "{err}");
    let err = wb.send(literal_req(&button, &path, json!("x"))).unwrap_err();
    assert!(err.contains("Page Navigator"), "{err}");

    let gone = "00000000-0000-4000-8000-000000000000";
    let err = wb.send(set_req(&nav, &format!("/properties/pageOverrides/{gone}/text"), "=Inputs!A1")).unwrap_err();
    assert!(err.contains("no report page"), "{err}");
    let err = wb.send(literal_req(&nav, &format!("/properties/pageOverrides/{gone}/text"), json!("x"))).unwrap_err();
    assert!(err.contains("no report page"), "{err}");
    // A WORKSHEET is not a report page.
    let inputs = wb.sheet_id(INPUTS);
    assert!(wb.send(set_req(&nav, &format!("/properties/pageOverrides/{inputs}/text"), "=Inputs!A1")).is_err());

    let err = wb.send(literal_req(&nav, &path, json!("x".repeat(MAX_PAGE_NAVIGATOR_CAPTION + 1)))).unwrap_err();
    assert!(err.contains("at most 255"), "{err}");
    let err = wb.send(set_req(&nav, "/properties/pageOverrides", "=Inputs!A1")).unwrap_err();
    assert!(err.contains("never bound"), "{err}");
    let err = wb.send(set_req(&nav, &format!("/properties/pageOverrides/{sales}/sheetId"), "=Inputs!A1")).unwrap_err();
    assert!(err.contains("never bound"), "{err}");
    assert_eq!(wb.stored_overrides(), "[]", "nothing was written");
}

// ===========================================================================
// The overlay
// ===========================================================================

/// A bound caption paints through `resolve_control_properties`: the painter's
/// one `pageOverrides` string carries the resolved caption (a page with no
/// entry gains one), every other entry is unchanged, and the STORED literal is
/// untouched.
///
/// SABOTAGE: in `resolve_control_properties_core`, skip the per-button
/// overlay (`if !per_button.is_empty()` -> `if false`) -- the painted string is
/// the literal.
#[test]
fn a_bound_caption_paints_through_resolve_control_properties() {
    let wb = Wb::new();
    let (report, sales) = (wb.sheet_id(REPORT), wb.sheet_id(SALES));
    wb.set_text(INPUTS, 0, 0, "Revenue Q3");
    wb.set_text(INPUTS, 1, 0, "#336699");
    let stored = serialize_page_overrides(&[PageOverrideWire { fill: Some("#123".into()), ..entry(&report, "Report") }]);
    let nav = wb.navigator(&stored);

    let text_path = format!("/properties/pageOverrides/{sales}/text");
    let fill_path = format!("/properties/pageOverrides/{report}/fill");
    wb.send(set_req(&nav, &text_path, "=Inputs!A1")).expect("bind the Sales caption");
    wb.send(set_req(&nav, &fill_path, "=Inputs!A2")).expect("bind the Report fill");
    let v = wb.resolved(&nav, &text_path).expect("a resolved caption");
    assert_eq!((v.value.clone(), v.error.clone(), v.pending), (json!("Revenue Q3"), None, false));

    let painted = parse_page_overrides(&wb.painted_overrides()).expect("the painted string parses");
    assert_eq!(
        painted,
        vec![
            PageOverrideWire { fill: Some("#336699".into()), ..entry(&report, "Report") },
            PageOverrideWire { text: Some("Revenue Q3".into()), ..entry(&sales, "Sales") },
        ]
    );
    assert_eq!(wb.stored_overrides(), stored, "the literal is untouched");

    // The value follows its cell.
    wb.set_text(INPUTS, 0, 0, "Revenue Q4");
    wb.resolve_all();
    assert!(wb.painted_overrides().contains("Revenue Q4"));
}

/// A binding whose page goes away is DORMANT: it resolves to nothing (not
/// pending, no value, no error), paints nothing, survives the sheet delete's
/// cascade (the navigator is still there), and resolves again once the page is
/// back.
///
/// SABOTAGE: make `is_dormant` (eval.rs) return false -- the deleted page's
/// binding is evaluated and resolves its cell's value.
#[test]
fn a_binding_on_a_deleted_page_is_dormant_and_comes_back_with_the_page() {
    let wb = Wb::new();
    let detail = wb.sheet_id(DETAIL);
    let detail_id = wb.state.sheet_ids.read().unwrap()[DETAIL];
    wb.set_text(INPUTS, 0, 0, "Details");
    let nav = wb.navigator("[]");
    let path = format!("/properties/pageOverrides/{detail}/text");
    wb.send(set_req(&nav, &path, "=Inputs!A1")).expect("bind the Detail caption");
    assert_eq!(wb.resolved(&nav, &path).unwrap().value, json!("Details"));

    crate::sheets::delete_sheet_impl(
        &wb.state, &wb.file, &wb.pivots, &wb.files, &wb.pane, &wb.ribbon, &wb.slicers, &wb.timelines, DETAIL, false,
    )
    .expect("delete Detail");

    assert!(wb.has_binding(&nav, &path), "the sheet delete's cascade must keep another sheet's navigator binding");
    let v = wb.resolved(&nav, &path).expect("still resolved");
    assert_eq!((v.value, v.error, v.pending, v.display), (Value::Null, None, false, String::new()), "dormant");
    assert_eq!(wb.painted_overrides(), "[]", "a dormant binding paints nothing");

    // The page comes back with its id (what an undo or a pull of it does).
    {
        let seed = test_seed_effect();
        wb.state.sheet_names.write(&seed).unwrap().push("Detail".to_string());
        wb.state.sheet_ids.write(&seed).unwrap().push(detail_id);
        wb.state.sheet_kinds.write(&seed).unwrap().push(::persistence::SheetKind::new_canvas());
        wb.state.grids.write(&seed).unwrap().push(engine::Grid::new());
    }
    assert_eq!(wb.resolved(&nav, &path).unwrap().value, json!("Details"), "the binding is live again");
    assert!(wb.painted_overrides().contains("Details"));
}

/// The pure overlay rules: pending and dormant keep the literal; an error
/// keeps it for a colour and shows the error display on a caption; a value the
/// field cannot hold is skipped, never painted broken.
#[test]
fn the_overlay_keeps_the_literal_for_pending_dormant_and_bad_values() {
    let sales = "7f9c2a64-3b1e-4d5a-9c8e-0a1b2c3d4e5f";
    let sales_id = identity::SheetId::parse(sales).unwrap();
    let pages = ReportPages::from_table(&[sales_id], &["Sales".to_string()], &[::persistence::SheetKind::new_canvas()]);
    let value = |v: Value, error: Option<&str>, pending: bool| ResolvedBinding {
        object: ObjectBindingRef { kind: ObjectBindingKind::Control, id: NAV_UID.into() },
        path: String::new(),
        value: v,
        display: "#REF!".into(),
        error: error.map(str::to_string),
        pending,
    };
    let at = |key: &str, field: &str| PerButtonPath { page_key: key.into(), field: field.into() };
    let raw = "[]";
    assert_eq!(overlay_overrides(raw, &[(at(sales, "text"), value(json!("X"), None, true))], &pages), None, "pending");
    assert_eq!(overlay_overrides(raw, &[(at("gone", "text"), value(json!("X"), None, false))], &pages), None, "dormant");
    assert_eq!(overlay_overrides(raw, &[(at(sales, "fill"), value(json!("red"), None, false))], &pages), None, "bad colour");
    assert_eq!(overlay_overrides(raw, &[(at(sales, "fill"), value(Value::Null, Some("x"), false))], &pages), None, "colour error");
    let shown = overlay_overrides(raw, &[(at(sales, "text"), value(Value::Null, Some("x"), false))], &pages).unwrap();
    assert!(shown.contains("#REF!"), "a caption shows its error display: {shown}");
    let hidden = overlay_overrides(raw, &[(at("name:sales", "hidden"), value(json!(true), None, false))], &pages).unwrap();
    assert_eq!(hidden, r#"[{"sheetId":"","sheetName":"Sales","hidden":true}]"#, "a name key, case-folded");
    assert_eq!(overlay_overrides("not json", &[(at(sales, "text"), value(json!("X"), None, false))], &pages), None);
}

// ===========================================================================
// Carriage
// ===========================================================================

/// A `.calp` pull remaps the page SEGMENT of a per-button binding's path to
/// the subscriber's id (the literal's entries are re-keyed by the same map), by
/// text; a `name:` key, an unmapped page and any other path are untouched.
///
/// SABOTAGE: return false at the top of `carriage::remap_per_button_page` --
/// the path keeps the application's id.
#[test]
fn a_pull_remaps_the_page_segment_of_the_path() {
    let app = "7f9c2a64-3b1e-4d5a-9c8e-0a1b2c3d4e5f";
    let local = "0192a6b4-1111-7222-8333-444455556666";
    let map: HashMap<String, String> = [(app.to_string(), local.to_string())].into_iter().collect();

    let mut path = per_button_pointer(app, "text");
    assert!(super::carriage::remap_per_button_page(&mut path, &map));
    assert_eq!(path, format!("/properties/pageOverrides/{local}/text"));

    for untouched in [
        "/properties/pageOverrides/name:Sales/text".to_string(),
        "/properties/pageOverrides/00000000-0000-4000-8000-000000000000/fill".to_string(),
        "/properties/text".to_string(),
    ] {
        let mut p = untouched.clone();
        assert!(!super::carriage::remap_per_button_page(&mut p, &map));
        assert_eq!(p, untouched);
    }
}

#[test]
fn colours_are_stored_in_the_spellings_the_painter_reads() {
    assert_eq!(navigator_colour("#ABC").as_deref(), Some("#ABC"));
    assert_eq!(navigator_colour(" #11223344 ").as_deref(), Some("#11223344"));
    assert_eq!(navigator_colour("rgb(0, 128, 255)").as_deref(), Some("#0080ff"));
    assert_eq!(navigator_colour("rgba(255,255,255,0)").as_deref(), Some("#ffffff00"));
    for bad in ["red", "#12", "#12345", "rgb(256,0,0)", "rgba(0,0,0)", "rgb(0,0,0,1)"] {
        assert_eq!(navigator_colour(bad), None, "{bad}");
    }
}

// ===========================================================================
// An earlier formatting / literal step's undo never erases a later Buttons edit
// ===========================================================================

/// The Buttons section writes `pageOverrides` through `set_control_property`,
/// which records no undo for a non-code key. A "Format control" step (the
/// Format tab) or a "Set property" step (a literal write) taken BEFORE it used
/// to snapshot the WHOLE control store, so its Ctrl+Z also erased the later
/// per-page caption with no undo entry naming it. Both steps now restore only
/// the properties they wrote.
///
/// SABOTAGE (confirmed): make the `obj_control_props` arm restore every
/// property of the control from the step's snapshot (or record the whole store
/// in `set_control_appearance_core` again) -- the caption edit is gone after
/// the undo.
#[test]
fn undoing_a_format_or_literal_step_keeps_a_later_buttons_section_edit() {
    let wb = Wb::new();
    let sales = wb.sheet_id(SALES);
    let nav = wb.navigator("");
    let (s, r, c) = NAV_ANCHOR;
    let fill = || {
        wb.state.controls.read().unwrap()[&NAV_ANCHOR].properties.get("fill").map(|p| p.value.clone())
    };
    let buttons_edit = |caption: &str| {
        let overrides = serialize_page_overrides(&[PageOverrideWire { text: Some(caption.into()), ..entry(&sales, "Sales") }]);
        crate::controls::set_control_property_core(
            &wb.state,
            &wb.file,
            s,
            r,
            c,
            String::new(),
            "pageOverrides".to_string(),
            "static".to_string(),
            overrides.clone(),
        )
        .expect("the Buttons section's write");
        overrides
    };

    // 1. Format tab, then a Buttons-section caption, then Ctrl+Z.
    crate::controls::set_control_appearance_core(
        &wb.state,
        &wb.file,
        &[crate::api_types::ControlAppearanceChange {
            sheet_index: s,
            row: r,
            col: c,
            properties: vec![crate::api_types::ControlAppearanceWrite { key: "fill".into(), value: "#112233".into() }],
        }],
    )
    .expect("format the navigator");
    assert_eq!(fill().as_deref(), Some("#112233"));
    let first = buttons_edit("Revenue");
    wb.undo();
    assert_eq!(fill(), None, "the undo takes the format back");
    assert_eq!(wb.stored_overrides(), first, "and keeps the later per-page caption");

    // 2. A literal write ("Set property"), then a caption, then Ctrl+Z.
    wb.send(literal_req(&nav, "/properties/selectedFill", json!("#445566"))).expect("the literal write");
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_description(), Some("Set property"));
    let second = buttons_edit("Margin");
    wb.undo();
    let props = wb.state.controls.read().unwrap()[&NAV_ANCHOR].properties.clone();
    assert!(!props.contains_key("selectedFill"), "the undo takes the literal back: {props:?}");
    assert_eq!(wb.stored_overrides(), second, "and keeps the later per-page caption");
    assert_eq!(props["orientation"].value, "horizontal", "an untouched property is untouched");
}
