//! FILENAME: app/src-tauri/src/timeline_slicer/tests.rs
//! PURPOSE: W1 (wave C; wb-slicer needs 2): every timeline command JOINS the
//!          caller's open undo transaction instead of committing it, and the
//!          delete is gated like every other object delete.
//! CONTEXT: The commands ran an unconditional `begin_transaction` /
//!          `commit_transaction` pair. `begin` is a no-op while a transaction
//!          is open, but `commit` is not -- so a timeline selection COMMITTED
//!          the frontend transaction its pivot filter was about to join (two
//!          Ctrl+Z steps for one click, and a decline that had to name the
//!          selection's step separately), and a timeline in a canvas-wide
//!          Delete split that Delete in two. The update commands also minted
//!          the dirty flag before their id lookup, and the delete had no
//!          protection gate at all.

use crate::document_effect::{mark_saved, test_seed_effect};
use crate::persistence::FileState;
use crate::timeline_slicer::commands::{
    create_timeline_slicer_core, delete_timeline_slicer_core, update_timeline_connections_core,
    update_timeline_selection_core, update_timeline_slicer_core,
};
use crate::timeline_slicer::*;
use crate::AppState;

fn new_id() -> identity::EntityId {
    identity::EntityId::from_bytes(identity::generate_uuid_v7())
}

struct Fx {
    state: AppState,
    file: FileState,
    timelines: TimelineSlicerState,
}

impl Fx {
    fn new() -> Fx {
        Fx { state: crate::create_app_state(), file: FileState::default(), timelines: TimelineSlicerState::new() }
    }

    fn create(&self) -> identity::EntityId {
        let params: CreateTimelineParams = serde_json::from_value(serde_json::json!({
            "name": "Dates",
            "sheetIndex": 0,
            "x": 10.0,
            "y": 20.0,
            "sourceId": new_id().to_string(),
            "fieldName": "OrderDate",
        }))
        .unwrap();
        create_timeline_slicer_core(&self.state, &self.timelines, &self.file, params).expect("create").id
    }

    fn select(&self, id: identity::EntityId, start: Option<&str>, end: Option<&str>) -> Result<(), String> {
        update_timeline_selection_core(
            &self.state,
            &self.timelines,
            &self.file,
            UpdateTimelineSelectionParams {
                timeline_id: id,
                selection_start: start.map(str::to_string),
                selection_end: end.map(str::to_string),
            },
        )
    }

    fn selection(&self, id: identity::EntityId) -> (Option<String>, Option<String>) {
        let t = &self.timelines.timelines.read().unwrap()[&id];
        (t.selection_start.clone(), t.selection_end.clone())
    }

    fn depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }

    fn open(&self) -> bool {
        self.state.undo_stack.lock().unwrap().has_open_transaction()
    }

    fn begin(&self, label: &str) {
        self.state.undo_stack.lock().unwrap().begin_transaction(label);
    }

    fn commit(&self) {
        self.state.undo_stack.lock().unwrap().commit_transaction();
    }

    /// Pop the top step and replay it through the real undo body.
    fn undo(&self) {
        let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("a step to undo");
        crate::undo_commands::apply_changes(
            &self.state,
            &self.file,
            &crate::persistence::UserFilesState::default(),
            &crate::pivot::types::PivotState::new(),
            &crate::slicer::SlicerState::new(),
            &crate::ribbon_filter::RibbonFilterState::new(),
            &crate::pane_control::PaneControlState::new(),
            &self.timelines,
            transaction,
            true,
        );
    }

    fn protect_sheet_zero(&self) {
        self.state
            .sheet_protection
            .write(&test_seed_effect())
            .unwrap()
            .insert(0, crate::protection::SheetProtection { protected: true, ..Default::default() });
    }
}

/// The selection is ONE step with the pivot writes of its gesture: it JOINS
/// the transaction the gesture opened and leaves it open for them.
#[test]
fn a_timeline_selection_inside_an_open_transaction_joins_it_and_is_one_step_with_its_pivots() {
    let fx = Fx::new();
    let id = fx.create();
    let depth = fx.depth();

    fx.begin("Timeline Filter");
    fx.select(id, Some("2026-01-01"), Some("2026-01-31")).unwrap();
    assert!(
        fx.open(),
        "the selection COMMITTED the gesture's transaction: its pivot filter would land in a second step"
    );
    // The gesture's pivot write lands in the same open step.
    fx.state.undo_stack.lock().unwrap().record_custom_restore("probe_pivot".to_string(), vec![], "pivot");
    fx.commit();
    assert_eq!(fx.depth(), depth + 1, "the selection and its pivots must be ONE Ctrl+Z step");

    let step = fx.state.undo_stack.lock().unwrap().pop_undo().unwrap();
    let kinds: Vec<String> = step
        .changes
        .iter()
        .filter_map(|c| match c {
            engine::CellChange::CustomRestore { kind, .. } => Some(kind.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(kinds, vec!["timeline_slicer".to_string(), "probe_pivot".to_string()], "one step holds both");
}

#[test]
fn a_timeline_selection_alone_is_one_step_and_undoes() {
    let fx = Fx::new();
    let id = fx.create();
    let depth = fx.depth();

    fx.select(id, Some("2026-01-01"), Some("2026-01-31")).unwrap();
    assert!(!fx.open(), "alone, the selection opens and commits its own step");
    assert_eq!(fx.depth(), depth + 1);

    fx.undo();
    assert_eq!(fx.selection(id), (None, None), "Ctrl+Z restores the previous range");
}

#[test]
fn an_unknown_timeline_or_an_unchanged_selection_leaves_the_document_clean_and_records_nothing() {
    let fx = Fx::new();
    let id = fx.create();
    fx.select(id, Some("2026-01-01"), Some("2026-01-31")).unwrap();
    mark_saved(&fx.file);
    let depth = fx.depth();

    let unknown = new_id();
    assert!(fx.select(unknown, Some("2026-02-01"), None).is_err());
    let connections = UpdateTimelineConnectionsParams { timeline_id: unknown, connected_pivot_ids: vec![new_id()] };
    assert!(update_timeline_connections_core(&fx.state, &fx.timelines, &fx.file, connections).is_err());
    let update: UpdateTimelineParams = serde_json::from_value(serde_json::json!({ "name": "X" })).unwrap();
    assert!(update_timeline_slicer_core(&fx.state, &fx.timelines, &fx.file, unknown, update).is_err());
    assert!(!fx.file.is_dirty(), "a refusal must not mark the document changed");

    fx.select(id, Some("2026-01-01"), Some("2026-01-31")).unwrap();
    assert!(!fx.file.is_dirty(), "re-selecting the same range changes nothing");
    assert_eq!(fx.depth(), depth, "and records no step that restores itself");
}

#[test]
fn timeline_updates_create_and_connections_join_an_open_transaction() {
    let fx = Fx::new();
    let depth = fx.depth();
    fx.begin("Insert");
    let id = fx.create();
    let update: UpdateTimelineParams = serde_json::from_value(serde_json::json!({ "name": "Renamed" })).unwrap();
    update_timeline_slicer_core(&fx.state, &fx.timelines, &fx.file, id, update).unwrap();
    let connections = UpdateTimelineConnectionsParams { timeline_id: id, connected_pivot_ids: vec![new_id()] };
    update_timeline_connections_core(&fx.state, &fx.timelines, &fx.file, connections).unwrap();
    assert!(fx.open(), "a timeline command committed the caller's transaction");
    fx.commit();
    assert_eq!(fx.depth(), depth + 1, "the whole insert is ONE step");

    fx.undo();
    assert!(fx.timelines.timelines.read().unwrap().is_empty(), "one Ctrl+Z takes the whole insert back");
}

#[test]
fn deleting_a_timeline_inside_an_open_transaction_joins_it_and_undoes_with_it() {
    let fx = Fx::new();
    let id = fx.create();
    let depth = fx.depth();

    fx.begin("Delete Objects");
    delete_timeline_slicer_core(&fx.state, &fx.timelines, &fx.file, id).unwrap();
    assert!(fx.open(), "the delete COMMITTED the canvas-wide Delete's transaction halfway");
    fx.commit();
    assert_eq!(fx.depth(), depth + 1);

    fx.undo();
    assert!(fx.timelines.timelines.read().unwrap().contains_key(&id), "one Ctrl+Z brings the timeline back");
}

#[test]
fn deleting_a_timeline_on_a_sheet_protected_against_object_edits_is_refused_and_clean() {
    let fx = Fx::new();
    let id = fx.create();
    mark_saved(&fx.file);
    let depth = fx.depth();
    fx.protect_sheet_zero();

    let refused = delete_timeline_slicer_core(&fx.state, &fx.timelines, &fx.file, id);
    assert!(refused.is_err_and(|e| e.contains("protected")), "a protected sheet refuses the delete");
    assert!(fx.timelines.timelines.read().unwrap().contains_key(&id), "the timeline was deleted anyway");
    assert!(!fx.file.is_dirty(), "a refused delete leaves the document clean");
    assert_eq!(fx.depth(), depth, "and records nothing");

    let unknown = new_id();
    assert!(delete_timeline_slicer_core(&fx.state, &fx.timelines, &fx.file, unknown).is_err());
    assert!(!fx.file.is_dirty());
}

/// Source guard: no timeline command may commit a transaction it did not open.
#[test]
fn no_timeline_command_runs_an_unconditional_begin_commit_pair() {
    let src = include_str!("commands.rs");
    let code: String = src
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for needle in ["begin_transaction(", "commit_transaction(", "record_custom_restore("] {
        assert!(
            !code.contains(needle),
            "timeline_slicer/commands.rs calls `{needle}` directly: record through \
             `undo_commands::record_restores_joining_open_transaction` (or `record_timeline_undo`) \
             so a caller's open transaction is joined, never committed"
        );
    }
}
