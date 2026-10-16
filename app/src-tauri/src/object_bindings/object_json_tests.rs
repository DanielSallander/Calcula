//! FILENAME: app/src-tauri/src/object_bindings/object_json_tests.rs
// PURPOSE: The AI-visible JSON of each bindable kind (the document a binding's
//          pointer addresses) and where each object is found.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::object_json::*;
use crate::api_types::{ObjectBindingKind, ObjectBindingRef};
use crate::controls::{ControlMetadata, ControlPropertyValue};

fn entity() -> identity::EntityId {
    identity::EntityId::from_bytes(identity::generate_uuid_v7())
}

fn sheet_id() -> identity::SheetId {
    identity::SheetId::from_bytes(identity::generate_uuid_v7())
}

fn reference(kind: ObjectBindingKind, id: impl ToString) -> ObjectBindingRef {
    ObjectBindingRef { kind, id: id.to_string() }
}

/// A workbook with two sheets: "Data" (a worksheet) and "Report" (a canvas).
struct Fixture {
    state: crate::AppState,
    slicers: crate::slicer::SlicerState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
    pivots: crate::pivot::types::PivotState,
    data_id: identity::SheetId,
    report_id: identity::SheetId,
}

impl Fixture {
    fn new() -> Fixture {
        let state = crate::create_app_state();
        let seed = crate::document_effect::test_seed_effect();
        let data_id = sheet_id();
        let report_id = sheet_id();
        *state.sheet_names.write(&seed).unwrap() = vec!["Data".to_string(), "Report".to_string()];
        *state.sheet_ids.write(&seed).unwrap() = vec![data_id, report_id];
        *state.sheet_kinds.write(&seed).unwrap() =
            vec![::persistence::SheetKind::Worksheet, ::persistence::SheetKind::new_canvas()];
        Fixture {
            state,
            slicers: crate::slicer::SlicerState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            data_id,
            report_id,
        }
    }

    fn stores(&self) -> ObjectStores<'_> {
        ObjectStores { state: &self.state, slicers: &self.slicers, timelines: &self.timelines, pivots: &self.pivots }
    }
}

fn pointer<'a>(v: &'a Value, p: &str) -> &'a Value {
    v.pointer(p).unwrap_or_else(|| panic!("{p} is not in {v}"))
}

#[test]
fn object_json_chart_is_the_definition_envelope() {
    let f = Fixture::new();
    let id = entity();
    f.state.charts.write(&crate::document_effect::test_seed_effect()).unwrap().push(crate::api_types::ChartEntry {
        id,
        sheet_index: 1,
        spec_json: json!({
            "chartId": id.to_string(),
            "name": "Revenue by month",
            "sheetIndex": 1,
            "spec": { "title": "Revenue", "series": [{ "name": "2024" }] }
        })
        .to_string(),
    });
    let r = reference(ObjectBindingKind::Chart, id);
    let v = object_json(&f.stores(), &r).expect("chart json");
    assert_eq!(pointer(&v, "/spec/title"), "Revenue", "chart pointers start /spec/");
    assert_eq!(pointer(&v, "/spec/series/0/name"), "2024");

    let loc = locate(&f.stores(), &r).expect("the chart is located");
    assert_eq!((loc.sheet_index, loc.sheet_id, loc.sheet_name.as_str()), (1, f.report_id, "Report"));
    assert_eq!(loc.name, "Revenue by month");
}

#[test]
fn object_json_chart_with_an_unreadable_definition_says_so() {
    let f = Fixture::new();
    let id = entity();
    f.state.charts.write(&crate::document_effect::test_seed_effect()).unwrap().push(crate::api_types::ChartEntry {
        id,
        sheet_index: 0,
        spec_json: "{not json".to_string(),
    });
    let err = object_json(&f.stores(), &reference(ObjectBindingKind::Chart, id)).unwrap_err();
    assert!(err.starts_with("The chart's definition could not be read"), "{err}");
}

#[test]
fn object_json_of_a_missing_object_names_the_kind_and_id() {
    let f = Fixture::new();
    for kind in ObjectBindingKind::ALL {
        let missing = entity().to_string();
        let err = object_json(&f.stores(), &reference(kind, &missing)).unwrap_err();
        assert!(err.contains(&missing) && err.contains(kind.label()), "{kind:?}: {err}");
        assert!(locate(&f.stores(), &reference(kind, &missing)).is_none());
    }
}

#[test]
fn object_json_control_is_values_only_without_the_held_compartment() {
    let mut properties = HashMap::new();
    let stat = |v: &str| ControlPropertyValue { value_type: "static".to_string(), value: v.to_string() };
    properties.insert("text".to_string(), stat("Go"));
    properties.insert("fill".to_string(), stat("#ff0000"));
    properties.insert("onSelect".to_string(), ControlPropertyValue { value_type: "formula".to_string(), value: "run()".to_string() });
    properties.insert(crate::controls::HELD_ON_SELECT_PROPERTY.to_string(), stat("held()"));
    properties.insert(crate::controls::HELD_FROM_PROPERTY.to_string(), stat("{}"));
    let meta = ControlMetadata { control_type: "button".to_string(), uid: "uid-1".to_string(), properties };

    let v = control_json("uid-1", &meta);
    assert_eq!(v["controlType"], "button");
    assert_eq!(v["uid"], "uid-1");
    assert_eq!(pointer(&v, "/properties/text"), "Go");
    assert_eq!(pointer(&v, "/properties/fill"), "#ff0000");
    assert_eq!(pointer(&v, "/properties/onSelect"), "run()", "values only: no valueType wrapper");
    assert!(v.pointer("/properties/heldOnSelect").is_none(), "held keys are omitted");
    assert!(v.pointer("/properties/heldFrom").is_none(), "held keys are omitted");
}

/// A control's binding identity is its `uid` -- found, located and listed by
/// it, never by its anchor cell -- and a control with no uid has none (it can
/// carry no binding until a door or the load path gives it one).
///
/// SABOTAGE: make `control_uid` return `None` again.
#[test]
fn a_control_is_found_by_its_uid_and_a_control_without_one_is_not() {
    let f = Fixture::new();
    let stat = |v: &str| ControlPropertyValue { value_type: "static".to_string(), value: v.to_string() };
    {
        let mut controls = f.state.controls.write(&crate::document_effect::test_seed_effect()).unwrap();
        let mut properties = HashMap::new();
        properties.insert("name".to_string(), stat("Go button"));
        controls.insert(
            (1, 4, 2),
            ControlMetadata { control_type: "button".to_string(), uid: "uid-go".to_string(), properties },
        );
        controls.insert(
            (0, 1, 1),
            ControlMetadata { control_type: "shape".to_string(), uid: String::new(), properties: HashMap::new() },
        );
    }
    let stores = f.stores();
    let go = reference(ObjectBindingKind::Control, "uid-go");
    let v = object_json(&stores, &go).expect("found by uid");
    assert_eq!(v["uid"], "uid-go");
    let loc = locate(&stores, &go).expect("located by uid");
    assert_eq!((loc.sheet_index, loc.sheet_id, loc.name.as_str()), (1, f.report_id, "Go button"));
    let controls: Vec<ObjectBindingRef> =
        live_object_refs(&stores).into_iter().filter(|r| r.kind == ObjectBindingKind::Control).collect();
    assert_eq!(controls, vec![go], "the uid-less control has no binding identity");
    assert!(object_json(&stores, &reference(ObjectBindingKind::Control, "")).is_err());
    assert!(object_json(&stores, &reference(ObjectBindingKind::Control, "0:1:1")).is_err(), "never by anchor");
}

#[test]
fn object_json_slicer_and_timeline_are_their_runtime_structs() {
    let f = Fixture::new();
    let slicer_id = entity();
    let slicer: crate::slicer::Slicer = serde_json::from_value(json!({
        "id": slicer_id.to_string(), "name": "Region", "headerText": "Pick a region",
        "sheetIndex": 1, "x": 0.0, "y": 0.0, "width": 100.0, "height": 200.0,
        "sourceType": "table", "cacheSourceId": entity().to_string(), "fieldName": "Region",
        "selectedItems": null, "showHeader": true, "columns": 1, "stylePreset": "SlicerStyleLight1"
    }))
    .expect("a minimal slicer");
    f.slicers.slicers.write(&crate::document_effect::test_seed_effect()).unwrap().insert(slicer_id, slicer);

    let timeline_id = entity();
    let timeline: crate::timeline_slicer::TimelineSlicer = serde_json::from_value(json!({
        "id": timeline_id.to_string(), "name": "Order date", "sheetIndex": 0,
        "x": 0.0, "y": 0.0, "width": 300.0, "height": 120.0,
        "sourceType": "pivot", "sourceId": entity().to_string(), "fieldName": "OrderDate",
        "showHeader": false, "showLevelSelector": true, "showScrollbar": true, "stylePreset": "TimeSlicerStyleLight1"
    }))
    .expect("a minimal timeline");
    f.timelines.timelines.write(&crate::document_effect::test_seed_effect()).unwrap().insert(timeline_id, timeline);

    let s = object_json(&f.stores(), &reference(ObjectBindingKind::Slicer, slicer_id)).unwrap();
    assert_eq!(pointer(&s, "/headerText"), "Pick a region");
    assert_eq!(pointer(&s, "/showHeader"), true);
    let t = object_json(&f.stores(), &reference(ObjectBindingKind::TimelineSlicer, timeline_id)).unwrap();
    assert_eq!(pointer(&t, "/showHeader"), false);
    assert!(t.get("headerText").is_none(), "an unset header text is absent, like the runtime struct");

    let on_report: Vec<ObjectBindingRef> = list_objects_on_sheet(&f.stores(), 1).into_iter().map(|(r, _)| r).collect();
    assert!(on_report.contains(&reference(ObjectBindingKind::Slicer, slicer_id)));
    assert!(!on_report.contains(&reference(ObjectBindingKind::TimelineSlicer, timeline_id)), "the timeline is on Data");
}

#[test]
fn object_json_pivot_is_hand_built_with_a_camel_case_frame() {
    use pivot_engine::{CanvasFrame, PivotCache, PivotDefinition};
    let f = Fixture::new();
    let canvas_pivot = entity();
    let mut def = PivotDefinition::new(canvas_pivot, (0, 0), (10, 3));
    def.name = Some("Sales by region".to_string());
    def.destination_sheet = Some("report".to_string()); // case drifted from the tab
    def.canvas_frame = Some(CanvasFrame { x: 10.0, y: 20.0, width: 480.0, height: 320.0, frozen_headers: true, container: None });
    let sheet_pivot = entity();
    let mut plain = PivotDefinition::new(sheet_pivot, (0, 0), (10, 3));
    plain.destination_sheet = Some("Data".to_string());
    {
        let mut tables = f.pivots.pivot_tables.write(&crate::document_effect::test_seed_effect()).unwrap();
        tables.insert(canvas_pivot, (def, PivotCache::new(canvas_pivot, 4)));
        tables.insert(sheet_pivot, (plain, PivotCache::new(sheet_pivot, 4)));
    }

    let v = object_json(&f.stores(), &reference(ObjectBindingKind::Pivot, canvas_pivot)).unwrap();
    assert_eq!(v["name"], "Sales by region");
    assert_eq!(pointer(&v, "/canvasFrame/frozenHeaders"), true, "camelCase, not the snake_case disk struct");
    assert_eq!(pointer(&v, "/canvasFrame/width"), 480.0);
    let loc = locate(&f.stores(), &reference(ObjectBindingKind::Pivot, canvas_pivot)).unwrap();
    assert_eq!(loc.sheet_index, 1, "the destination resolves case-insensitively");

    let w = object_json(&f.stores(), &reference(ObjectBindingKind::Pivot, sheet_pivot)).unwrap();
    assert!(w.get("canvasFrame").is_none(), "a worksheet pivot has no frame");
}

#[test]
fn object_json_floating_range_is_its_row_and_lives_on_its_host() {
    let f = Fixture::new();
    let id = entity();
    let row: crate::api_types::FloatingRange = serde_json::from_value(json!({
        "id": id.to_string(), "backingSheetId": f.data_id.to_string(), "hostSheetId": f.report_id.to_string(),
        "x": 40.0, "y": 50.0, "rowCount": 5, "colCount": 3
    }))
    .expect("a minimal floating range");
    f.state.floating_ranges.write(&crate::document_effect::test_seed_effect()).unwrap().push(row);

    let r = reference(ObjectBindingKind::FloatingRange, id);
    let v = object_json(&f.stores(), &r).unwrap();
    assert_eq!(pointer(&v, "/rowCount"), 5);
    let loc = locate(&f.stores(), &r).unwrap();
    assert_eq!((loc.sheet_index, loc.name.as_str()), (1, "Data"), "host sheet, named by its backing sheet");
}

#[test]
fn object_json_canvas_page_is_its_layout_and_a_worksheet_is_refused() {
    let f = Fixture::new();
    let page = reference(ObjectBindingKind::CanvasPage, f.report_id);
    let v = object_json(&f.stores(), &page).unwrap();
    assert!(v.pointer("/background").is_some(), "the page background is addressable: {v}");
    assert_eq!(locate(&f.stores(), &page).unwrap().name, "Report");

    let err = object_json(&f.stores(), &reference(ObjectBindingKind::CanvasPage, f.data_id)).unwrap_err();
    assert!(err.contains("'Data' is a worksheet"), "{err}");
    assert!(
        !live_object_refs(&f.stores()).contains(&reference(ObjectBindingKind::CanvasPage, f.data_id)),
        "a worksheet is not a canvas page"
    );
}
