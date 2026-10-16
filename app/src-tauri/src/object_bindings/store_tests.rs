//! FILENAME: app/src-tauri/src/object_bindings/store_tests.rs
// PURPOSE: The binding store: its one serialisable form (a sorted SEQUENCE),
//          the save / load halves, and the state digest.

use std::collections::BTreeMap;

use super::object_json::{live_object_refs, ObjectStores};
use super::store::*;
use crate::api_types::{ObjectBindingKind, ObjectBindingRef};

fn new_id() -> String {
    identity::EntityId::from_bytes(identity::generate_uuid_v7()).to_string()
}

fn key(kind: ObjectBindingKind, id: &str, path: &str) -> BindingKey {
    BindingKey { object: ObjectBindingRef { kind, id: id.to_string() }, path: path.to_string() }
}

fn bound(formula: &str, model: Option<&str>) -> StoredBinding {
    StoredBinding { formula: formula.to_string(), model: model.map(str::to_string) }
}

fn saved(kind: &str, id: &str, path: &str, formula: &str) -> ::persistence::SavedObjectBinding {
    ::persistence::SavedObjectBinding {
        object: ::persistence::SavedObjectRef { kind: kind.to_string(), id: id.to_string() },
        path: path.to_string(),
        formula: formula.to_string(),
        model: None,
    }
}

/// The snapshot order is the ON-DISK order -- (kind string, id, path) -- and
/// it does not depend on how the store was filled.
#[test]
fn store_roundtrip_is_sorted_and_deterministic() {
    let page = new_id();
    let chart = new_id();
    let slicer = new_id();
    let entries = vec![
        (key(ObjectBindingKind::Slicer, &slicer, "/headerText"), bound("=Data!A1", None)),
        (key(ObjectBindingKind::Chart, &chart, "/spec/yAxis/title"), bound("=Data!B1", None)),
        (key(ObjectBindingKind::CanvasPage, &page, "/background"), bound("=Data!C1", None)),
        (key(ObjectBindingKind::Chart, &chart, "/spec/title"), bound("=[Revenue]", Some("model-1"))),
    ];

    let mut forward = BindingStore::default();
    for (k, b) in entries.iter().cloned() {
        forward.bindings.insert(k, b);
    }
    let mut backward = BindingStore::default();
    for (k, b) in entries.iter().rev().cloned() {
        backward.bindings.insert(k, b);
    }

    let a = serde_json::to_vec(&forward.snapshot()).unwrap();
    let b = serde_json::to_vec(&backward.snapshot()).unwrap();
    assert_eq!(a, b, "the same bindings must serialise to the same bytes");

    let rows = forward.snapshot().rows;
    let order: Vec<(&str, &str)> = rows.iter().map(|r| (r.object.kind.as_str(), r.path.as_str())).collect();
    assert_eq!(
        order,
        vec![
            ("canvasPage", "/background"),
            ("chart", "/spec/title"),
            ("chart", "/spec/yAxis/title"),
            ("slicer", "/headerText"),
        ],
        "sorted by the on-disk kind spelling, then path"
    );

    let back = BindingStore::from_snapshot(&forward.snapshot());
    assert_eq!(back.bindings, forward.bindings, "a snapshot round trip keeps every row");
}

/// The undo recorder writes `serde_json::to_vec(..).unwrap_or_default()`. A
/// map-keyed snapshot would fail to serialise and record EMPTY bytes -- a dead
/// undo step with no error. The sequence form must serialise, non-empty, and
/// come back equal.
#[test]
fn store_snapshot_bytes_are_non_empty_and_round_trip() {
    let mut store = BindingStore::default();
    store.bindings.insert(key(ObjectBindingKind::Chart, &new_id(), "/spec/title"), bound("=Sheet1!A1", None));
    store.bindings.insert(key(ObjectBindingKind::CanvasPage, &new_id(), "/background"), bound("=Sheet1!B1", None));

    let bytes = serde_json::to_vec(&store.snapshot()).expect("the snapshot must serialise");
    assert!(!bytes.is_empty());
    let snap: BindingStoreSnapshot = serde_json::from_slice(&bytes).expect("and read back");
    assert_eq!(snap.rows.len(), 2);
    assert_eq!(BindingStore::from_snapshot(&snap).bindings, store.bindings);

    // And the reason the sequence exists: the map itself cannot be written.
    assert!(
        serde_json::to_vec(&store.bindings).is_err(),
        "a struct-keyed map serialises now -- the sequence snapshot is no longer load-bearing"
    );
}

#[test]
fn an_unknown_kind_is_dropped_not_fatal() {
    let snap = BindingStoreSnapshot {
        rows: vec![
            saved("chart", &new_id(), "/spec/title", "=A1"),
            saved("tablix", &new_id(), "/title", "=A1"),
        ],
    };
    assert_eq!(BindingStore::from_snapshot(&snap).bindings.len(), 1);
}

#[test]
fn every_write_helper_bumps_the_generation() {
    let mut store = BindingStore::default();
    let g0 = store.generation;
    store.bump_generation();
    assert_eq!(store.generation, g0 + 1);
    store.replace_bindings(BindingStore::default());
    assert_eq!(store.generation, g0 + 2);
    store.clear_bindings();
    assert_eq!(store.generation, g0 + 3);
}

/// A workbook whose first sheet is a canvas page and which holds one chart.
fn canvas_with_chart() -> (crate::AppState, String, String) {
    let state = crate::create_app_state();
    let seed = crate::document_effect::test_seed_effect();
    state.sheet_kinds.write(&seed).unwrap()[0] = ::persistence::SheetKind::new_canvas();
    let page = state.sheet_ids.read().unwrap()[0].to_string();
    let chart_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    state.charts.write(&seed).unwrap().push(crate::api_types::ChartEntry {
        id: chart_id,
        sheet_index: 0,
        spec_json: r#"{"name":"Revenue","spec":{"title":"Revenue"}}"#.to_string(),
    });
    (state, page, chart_id.to_string())
}

/// Load installs, save writes back exactly what exists -- and a binding whose
/// object is gone (an orphan) is not carried into the next file.
#[test]
fn restore_then_collect_round_trips_and_drops_orphans() {
    let (state, page, chart) = canvas_with_chart();
    let slicers = crate::slicer::SlicerState::new();
    let timelines = crate::timeline_slicer::TimelineSlicerState::new();
    let pivots = crate::pivot::types::PivotState::new();
    let orphan = new_id();

    let mut rows = vec![
        saved("canvasPage", &page, "/background", "=Inputs!B1"),
        saved("chart", &chart, "/spec/title", "=Sheet1!A1"),
        saved("chart", &orphan, "/spec/title", "=Sheet1!A2"),
    ];
    let generation_before = state.object_bindings.read().unwrap().generation;
    let installed = restore_bindings_from_disk(&state, &rows).expect("restore");
    assert_eq!(installed, 3, "load installs every row it can read, orphans included");
    assert!(
        state.object_bindings.read().unwrap().generation > generation_before,
        "a load must bump the generation so the runtime rebuilds"
    );

    let stores = ObjectStores { state: &state, slicers: &slicers, timelines: &timelines, pivots: &pivots };
    let live = live_object_refs(&stores);
    let written = collect_bindings_for_save(&state, &live);
    rows.retain(|r| r.object.id != orphan);
    sort_saved_rows(&mut rows);
    assert_eq!(written, rows, "the save writes the live bindings, sorted, and no orphan");
}

#[test]
fn a_second_load_replaces_never_merges() {
    let (state, page, chart) = canvas_with_chart();
    restore_bindings_from_disk(
        &state,
        &[saved("canvasPage", &page, "/background", "=A1"), saved("chart", &chart, "/spec/title", "=A2")],
    )
    .unwrap();
    restore_bindings_from_disk(&state, &[saved("chart", &chart, "/spec/title", "=A3")]).unwrap();
    let store = state.object_bindings.read().unwrap();
    assert_eq!(store.bindings.len(), 1);
    assert_eq!(store.bindings.values().next().unwrap().formula, "=A3");
}

/// The digest carries the bindings (the save/reload and undo oracles must be
/// able to see one disappear), keyed "kind:id path".
#[test]
fn the_state_digest_carries_every_binding() {
    let (state, page, chart) = canvas_with_chart();
    restore_bindings_from_disk(
        &state,
        &[
            saved("canvasPage", &page, "/background", "=Inputs!B1"),
            ::persistence::SavedObjectBinding {
                model: Some("model-key".to_string()),
                ..saved("chart", &chart, "/spec/title", "=[Revenue]")
            },
        ],
    )
    .unwrap();

    let digest = crate::state_digest::build_workbook_state_digest(
        &state,
        &crate::pivot::types::PivotState::new(),
        &crate::slicer::SlicerState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        None,
    )
    .expect("digest");
    let expected: BTreeMap<String, serde_json::Value> = BTreeMap::from([
        (
            format!("canvasPage:{page} /background"),
            serde_json::json!({ "formula": "=Inputs!B1", "model": null }),
        ),
        (
            format!("chart:{chart} /spec/title"),
            serde_json::json!({ "formula": "=[Revenue]", "model": "model-key" }),
        ),
    ]);
    assert_eq!(digest.object_bindings, expected);
}
