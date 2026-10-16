//! FILENAME: app/src-tauri/src/object_bindings/object_json.rs
// PURPOSE: The "AI-visible JSON" of every bindable object -- the ONE document a
//          binding's JSON Pointer addresses -- and where each object lives.
// CONTEXT: One definition per kind:
//   chart          the ChartDefinition ENVELOPE parsed from `ChartEntry.spec_json`
//                  (`{chartId,name,sheetIndex,x,y,width,height,spec}`), so chart
//                  pointers start `/spec/`
//   control        `{ "controlType", "uid", "properties": { key: value-string } }`
//                  -- values only (no `valueType`), held-compartment keys omitted;
//                  a Page Navigator's `pageOverrides` is an OBJECT keyed by page
//                  key (D §3.18a)
//   slicer         `serde_json::to_value(&Slicer)` (camelCase runtime struct)
//   timelineSlicer `serde_json::to_value(&TimelineSlicer)`
//   pivot          hand-built `{ "id", "name", "canvasFrame": {x,y,width,height,
//                  frozenHeaders, container?} }` -- `CanvasFrame` is snake_case on
//                  disk, so it is NOT serialised directly (its `container` is
//                  visual_format's camelCase struct and is); worksheet pivots
//                  carry no frame
//   floatingRange  `serde_json::to_value(&api_types::FloatingRange)`
//   canvasPage     `serde_json::to_value(&CanvasLayout)` of that sheet (an error
//                  on a worksheet)
//
// LOCKS: every function here takes each store it reads and RELEASES it before
// the next; none of them touches the binding store or its runtime, so a caller
// computes what it needs here first and only then takes the (leaf) store.

use std::collections::HashSet;

use serde_json::{json, Map, Value};

use crate::api_types::{ObjectBindingKind, ObjectBindingRef};
use crate::controls::ControlMetadata;
use crate::AppState;

/// The stores an object can live in, borrowed together.
pub struct ObjectStores<'a> {
    pub state: &'a AppState,
    pub slicers: &'a crate::slicer::SlicerState,
    pub timelines: &'a crate::timeline_slicer::TimelineSlicerState,
    pub pivots: &'a crate::pivot::types::PivotState,
}

/// Where an object is: its sheet (index valid until the next sheet operation,
/// id stable) and a name a person recognises it by.
#[derive(Debug, Clone, PartialEq)]
pub struct ObjectLocation {
    pub sheet_index: usize,
    pub sheet_id: identity::SheetId,
    /// The sheet's name (the tab).
    pub sheet_name: String,
    /// The object's own display name ("Revenue chart", "Region", "Button").
    pub name: String,
}

/// The stable binding id of a control: its `uid` (`controls::assign_uid`),
/// never its anchor cell, which a move or a structural shift re-keys. `None`
/// only for a control no door has given a uid yet (the load path mints one
/// for every control it restores), which can therefore carry no binding.
pub fn control_uid(meta: &ControlMetadata) -> Option<&str> {
    (!meta.uid.is_empty()).then_some(meta.uid.as_str())
}

/// The sheet table, copied out (names, ids, kinds), each lock released.
struct SheetTable {
    names: Vec<String>,
    ids: Vec<identity::SheetId>,
    kinds: Vec<::persistence::SheetKind>,
}

impl SheetTable {
    fn read(state: &AppState) -> SheetTable {
        let names = state.sheet_names.read().map(|g| g.clone()).unwrap_or_default();
        let ids = state.sheet_ids.read().map(|g| g.clone()).unwrap_or_default();
        let kinds = state.sheet_kinds.read().map(|g| g.clone()).unwrap_or_default();
        SheetTable { names, ids, kinds }
    }

    fn location(&self, sheet_index: usize, name: String) -> Option<ObjectLocation> {
        let sheet_id = *self.ids.get(sheet_index)?;
        let sheet_name = self.names.get(sheet_index)?.clone();
        Some(ObjectLocation { sheet_index, sheet_id, sheet_name, name })
    }

    fn index_of_id(&self, id: &identity::SheetId) -> Option<usize> {
        self.ids.iter().position(|s| s == id)
    }
}

/// The display name a chart envelope carries, or "Chart".
fn chart_name(spec_json: &str) -> String {
    serde_json::from_str::<Value>(spec_json)
        .ok()
        .and_then(|v| v.get("name").and_then(Value::as_str).map(str::to_string))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Chart".to_string())
}

/// The display name of a control: its static `name` property, else its type.
fn control_name(meta: &ControlMetadata) -> String {
    meta.properties
        .get("name")
        .filter(|p| p.value_type == "static" && !p.value.trim().is_empty())
        .map(|p| p.value.clone())
        .unwrap_or_else(|| meta.control_type.clone())
}

/// EVERY bindable object of the workbook with its location, in a stable order
/// (kind, then the store's own order sorted by id).
fn enumerate_objects(cx: &ObjectStores<'_>) -> Vec<(ObjectBindingRef, ObjectLocation)> {
    let sheets = SheetTable::read(cx.state);
    let mut out: Vec<(ObjectBindingRef, ObjectLocation)> = Vec::new();
    let mut push = |kind: ObjectBindingKind, id: String, loc: Option<ObjectLocation>| {
        if let Some(loc) = loc {
            out.push((ObjectBindingRef { kind, id }, loc));
        }
    };

    if let Ok(charts) = cx.state.charts.read() {
        for chart in charts.iter() {
            let loc = sheets.location(chart.sheet_index, chart_name(&chart.spec_json));
            push(ObjectBindingKind::Chart, chart.id.to_string(), loc);
        }
    }
    if let Ok(controls) = cx.state.controls.read() {
        for ((sheet_index, _row, _col), meta) in controls.iter() {
            if let Some(uid) = control_uid(meta) {
                let loc = sheets.location(*sheet_index, control_name(meta));
                push(ObjectBindingKind::Control, uid.to_string(), loc);
            }
        }
    }
    if let Ok(slicers) = cx.slicers.slicers.read() {
        for (id, slicer) in slicers.iter() {
            let loc = sheets.location(slicer.sheet_index, slicer.name.clone());
            push(ObjectBindingKind::Slicer, id.to_string(), loc);
        }
    }
    if let Ok(timelines) = cx.timelines.timelines.read() {
        for (id, timeline) in timelines.iter() {
            let loc = sheets.location(timeline.sheet_index, timeline.name.clone());
            push(ObjectBindingKind::TimelineSlicer, id.to_string(), loc);
        }
    }
    if let Ok(pivots) = cx.pivots.pivot_tables.read() {
        for (id, (def, _cache)) in pivots.iter() {
            let index = match def.destination_sheet.as_deref() {
                Some(name) => crate::pivot::operations::index_of_sheet(&sheets.names, name),
                None => Some(0),
            };
            let name = def
                .name
                .clone()
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| "PivotTable".to_string());
            let loc = index.and_then(|i| sheets.location(i, name));
            push(ObjectBindingKind::Pivot, id.to_string(), loc);
        }
    }
    if let Ok(rows) = cx.state.floating_ranges.read() {
        for fr in rows.iter() {
            let name = sheets
                .index_of_id(&fr.backing_sheet_id)
                .and_then(|i| sheets.names.get(i).cloned())
                .unwrap_or_else(|| "Floating range".to_string());
            let loc = sheets.index_of_id(&fr.host_sheet_id).and_then(|i| sheets.location(i, name));
            push(ObjectBindingKind::FloatingRange, fr.id.to_string(), loc);
        }
    }
    for (index, kind) in sheets.kinds.iter().enumerate() {
        if kind.is_canvas() {
            if let Some(id) = sheets.ids.get(index) {
                let name = sheets.names.get(index).cloned().unwrap_or_default();
                let loc = sheets.location(index, name);
                push(ObjectBindingKind::CanvasPage, id.to_string(), loc);
            }
        }
    }

    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Where `object` is, or `None` when it does not exist (an orphan binding).
pub fn locate(cx: &ObjectStores<'_>, object: &ObjectBindingRef) -> Option<ObjectLocation> {
    if object.id.is_empty() {
        return None;
    }
    enumerate_objects(cx)
        .into_iter()
        .find(|(r, _)| r == object)
        .map(|(_, loc)| loc)
}

/// Every bindable object on sheet `sheet_index`, with its location.
pub fn list_objects_on_sheet(
    cx: &ObjectStores<'_>,
    sheet_index: usize,
) -> Vec<(ObjectBindingRef, ObjectLocation)> {
    enumerate_objects(cx)
        .into_iter()
        .filter(|(_, loc)| loc.sheet_index == sheet_index)
        .collect()
}

/// Every bindable object of the workbook with its location, sorted by ref --
/// the evaluator's one read of where every bound object is now.
pub fn object_locations(cx: &ObjectStores<'_>) -> Vec<(ObjectBindingRef, ObjectLocation)> {
    enumerate_objects(cx)
}

/// The refs of every object that exists -- what a save keeps bindings for.
pub fn live_object_refs(cx: &ObjectStores<'_>) -> HashSet<ObjectBindingRef> {
    enumerate_objects(cx).into_iter().map(|(r, _)| r).collect()
}

fn not_found(object: &ObjectBindingRef) -> String {
    format!(
        "There is no {} with id '{}' in this workbook.",
        object.kind.label(),
        object.id
    )
}

/// The control projection: values only, held-compartment keys omitted.
///
/// A Page Navigator's `pageOverrides` is projected as an OBJECT keyed by page
/// key (`page_overrides::project_overrides`, D §3.18a), so a per-button pointer
/// `/properties/pageOverrides/<sheetId>/text` has something to point at; a
/// value that cannot be parsed stays the string it is. Every other property is
/// its string.
pub fn control_json(uid: &str, meta: &ControlMetadata) -> Value {
    let mut props: Map<String, Value> = Map::new();
    let mut keys: Vec<&String> = meta.properties.keys().collect();
    keys.sort();
    let navigator = meta.control_type == crate::controls::PAGE_NAVIGATOR_CONTROL_TYPE;
    for key in keys {
        if crate::controls::is_held_property(key) {
            continue;
        }
        if let Some(p) = meta.properties.get(key) {
            let projected = (navigator
                && key == crate::controls::PAGE_NAVIGATOR_OVERRIDES_PROPERTY
                && p.value_type == "static")
                .then(|| super::page_overrides::project_overrides(&p.value))
                .flatten();
            props.insert(key.clone(), projected.unwrap_or_else(|| Value::String(p.value.clone())));
        }
    }
    json!({
        "controlType": meta.control_type,
        "uid": uid,
        "properties": Value::Object(props),
    })
}

/// The pivot projection, hand-built (camelCase leaves; see the module header).
pub fn pivot_json(id: &str, def: &pivot_engine::PivotDefinition) -> Value {
    let mut out = Map::new();
    out.insert("id".to_string(), Value::String(id.to_string()));
    out.insert(
        "name".to_string(),
        def.name.clone().map(Value::String).unwrap_or(Value::Null),
    );
    if let Some(frame) = &def.canvas_frame {
        let mut canvas_frame = json!({
            "x": frame.x,
            "y": frame.y,
            "width": frame.width,
            "height": frame.height,
            "frozenHeaders": frame.frozen_headers,
        });
        // The box's visual container (WP-C), in visual_format's own camelCase
        // serde -- the document the `/canvasFrame/container/...` rows point
        // into. Absent when the box has none (no key, like every family).
        if let Some(container) = frame.container.as_ref().filter(|c| !c.is_empty()) {
            if let (Some(obj), Ok(value)) = (canvas_frame.as_object_mut(), serde_json::to_value(container)) {
                obj.insert("container".to_string(), value);
            }
        }
        out.insert("canvasFrame".to_string(), canvas_frame);
    }
    Value::Object(out)
}

/// The AI-visible JSON of `object` -- the document its binding paths point into.
pub fn object_json(cx: &ObjectStores<'_>, object: &ObjectBindingRef) -> Result<Value, String> {
    let to_value = |v: Result<Value, serde_json::Error>| v.map_err(|e| e.to_string());
    match object.kind {
        ObjectBindingKind::Chart => {
            let spec_json = {
                let charts = cx.state.charts.read().map_err(|e| e.to_string())?;
                charts
                    .iter()
                    .find(|c| c.id.to_string() == object.id)
                    .map(|c| c.spec_json.clone())
            }
            .ok_or_else(|| not_found(object))?;
            serde_json::from_str::<Value>(&spec_json)
                .map_err(|e| format!("The chart's definition could not be read: {e}"))
        }
        ObjectBindingKind::Control => {
            if object.id.is_empty() {
                return Err(not_found(object));
            }
            let controls = cx.state.controls.read().map_err(|e| e.to_string())?;
            controls
                .values()
                .find(|meta| control_uid(meta) == Some(object.id.as_str()))
                .map(|meta| control_json(&object.id, meta))
                .ok_or_else(|| not_found(object))
        }
        ObjectBindingKind::Slicer => {
            let id = identity::EntityId::parse(&object.id).ok_or_else(|| not_found(object))?;
            let slicers = cx.slicers.slicers.read().map_err(|e| e.to_string())?;
            let slicer = slicers.get(&id).ok_or_else(|| not_found(object))?;
            to_value(serde_json::to_value(slicer))
        }
        ObjectBindingKind::TimelineSlicer => {
            let id = identity::EntityId::parse(&object.id).ok_or_else(|| not_found(object))?;
            let timelines = cx.timelines.timelines.read().map_err(|e| e.to_string())?;
            let timeline = timelines.get(&id).ok_or_else(|| not_found(object))?;
            to_value(serde_json::to_value(timeline))
        }
        ObjectBindingKind::Pivot => {
            let id = identity::EntityId::parse(&object.id).ok_or_else(|| not_found(object))?;
            let pivots = cx.pivots.pivot_tables.read().map_err(|e| e.to_string())?;
            let (def, _cache) = pivots.get(&id).ok_or_else(|| not_found(object))?;
            Ok(pivot_json(&object.id, def))
        }
        ObjectBindingKind::FloatingRange => {
            let rows = cx.state.floating_ranges.read().map_err(|e| e.to_string())?;
            let row = rows
                .iter()
                .find(|fr| fr.id.to_string() == object.id)
                .ok_or_else(|| not_found(object))?;
            to_value(serde_json::to_value(row))
        }
        ObjectBindingKind::CanvasPage => {
            let id = identity::SheetId::parse(&object.id).ok_or_else(|| not_found(object))?;
            let sheets = SheetTable::read(cx.state);
            let index = sheets.index_of_id(&id).ok_or_else(|| not_found(object))?;
            match sheets.kinds.get(index).and_then(|k| k.canvas_layout()) {
                Some(layout) => to_value(serde_json::to_value(layout)),
                None => Err(format!(
                    "'{}' is a worksheet, not a canvas page.",
                    sheets.names.get(index).cloned().unwrap_or_default()
                )),
            }
        }
    }
}
