//! FILENAME: app/src-tauri/src/canvas_stacking_undo_tests.rs
//! PURPOSE: W5 (wave C; = M4 of wave B): a canvas's Bring to Front / Send to
//!          Back and Lock are ONE Ctrl+Z step each, and redo works. They were
//!          not undoable at all: `set_canvas_layout` treated the whole layout
//!          as view state, so Ctrl+Z skipped past a restack to the user's
//!          previous action. The other layout settings (page, snap grid,
//!          background) stay non-undoable view state (decision D1).
//! CONTEXT: Drives the real command body (`sheets::set_canvas_layout_inner`)
//!          and the real undo body (`undo_commands::apply_changes`) over an
//!          in-memory workbook with one canvas.

use persistence::{CanvasObjectRef, SheetKind};

use crate::api_types::CanvasLayoutPatch;
use crate::persistence::{FileState, UserFilesState};
use crate::pivot::types::PivotState;
use crate::AppState;

fn obj(kind: &str, id: &str) -> CanvasObjectRef {
    CanvasObjectRef { kind: kind.to_string(), id: id.to_string() }
}

struct Wb {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    pivots: PivotState,
    slicers: crate::slicer::SlicerState,
    filters: crate::ribbon_filter::RibbonFilterState,
    pane: crate::pane_control::PaneControlState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
    canvas: usize,
}

impl Wb {
    /// Sheet 0 is a worksheet; sheet 1 is a canvas.
    fn new() -> Wb {
        let wb = Wb {
            state: crate::create_app_state(),
            file: FileState::default(),
            files: UserFilesState::default(),
            pivots: PivotState::new(),
            slicers: crate::slicer::SlicerState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            canvas: 0,
        };
        let canvas = crate::sheets::add_sheet_inner(&wb.state, &wb.file, None, SheetKind::new_canvas())
            .expect("add a canvas")
            .active_index;
        Wb { canvas, ..wb }
    }

    fn patch(&self, patch: CanvasLayoutPatch) -> Result<crate::sheets::CanvasLayoutChanged, String> {
        crate::sheets::set_canvas_layout_inner(&self.state, &self.file, Some(self.canvas), &patch)
    }

    fn layout(&self) -> persistence::CanvasLayout {
        match &self.state.sheet_kinds.read().unwrap()[self.canvas] {
            SheetKind::Canvas(layout) => layout.clone(),
            other => panic!("sheet {} is not a canvas: {other:?}", self.canvas),
        }
    }

    fn depth(&self) -> (usize, usize) {
        let stack = self.state.undo_stack.lock().unwrap();
        (stack.undo_depth(), stack.redo_depth())
    }

    fn apply(&self, transaction: engine::Transaction, is_undo: bool) -> crate::undo_commands::UndoResult {
        crate::undo_commands::apply_changes(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.slicers,
            &self.filters,
            &self.pane,
            &self.timelines,
            transaction,
            is_undo,
        )
    }

    fn undo(&self) -> crate::undo_commands::UndoResult {
        let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("a step to undo");
        self.apply(transaction, true)
    }

    fn redo(&self) -> crate::undo_commands::UndoResult {
        let transaction = self.state.undo_stack.lock().unwrap().pop_redo().expect("a step to redo");
        self.apply(transaction, false)
    }
}

#[test]
fn bring_to_front_is_one_undo_step_and_redo_puts_it_back() {
    let wb = Wb::new();
    let stacked = vec![obj("chart", "c1"), obj("shape", "s1")];
    wb.patch(CanvasLayoutPatch { z_order: Some(stacked.clone()), ..Default::default() }).unwrap();
    let (depth, _) = wb.depth();

    // Bring the chart to the front.
    let front = vec![obj("shape", "s1"), obj("chart", "c1")];
    wb.patch(CanvasLayoutPatch { z_order: Some(front.clone()), ..Default::default() }).unwrap();
    assert_eq!(wb.depth().0, depth + 1, "a restack must be exactly ONE undo step");
    assert_eq!(
        wb.state.undo_stack.lock().unwrap().undo_description(),
        Some("Reorder objects"),
        "the step names what it undoes"
    );

    let result = wb.undo();
    assert!(result.success, "the step undoes");
    assert_eq!(wb.layout().z_order, stacked, "Ctrl+Z puts the previous stacking back");
    assert!(
        result.refresh_domains.iter().any(|d| d == "sheets"),
        "the restore must announce `sheets` (the canvas re-reads its layout on SHEET_CHANGED): {:?}",
        result.refresh_domains
    );

    wb.redo();
    assert_eq!(wb.layout().z_order, front, "Ctrl+Y re-applies the restack");
    wb.undo();
    assert_eq!(wb.layout().z_order, stacked, "and undoes again after the redo");
}

#[test]
fn a_lock_toggle_is_one_undo_step() {
    let wb = Wb::new();
    let (depth, _) = wb.depth();

    wb.patch(CanvasLayoutPatch { locked: Some(vec![obj("chart", "c1")]), ..Default::default() }).unwrap();
    assert_eq!(wb.depth().0, depth + 1, "a lock must be exactly ONE undo step");
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_description(), Some("Lock objects"));

    wb.undo();
    assert!(wb.layout().locked.is_empty(), "Ctrl+Z unlocks the chart again");
    wb.redo();
    assert_eq!(wb.layout().locked, vec![obj("chart", "c1")], "Ctrl+Y locks it again");
}

#[test]
fn page_snap_and_background_changes_record_nothing() {
    let wb = Wb::new();
    let (depth, _) = wb.depth();

    wb.patch(CanvasLayoutPatch {
        grid_size_px: Some(25),
        snap_to_grid: Some(false),
        page_preset: Some("4:3".to_string()),
        background: Some("#ffeecc".to_string()),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(wb.depth().0, depth, "a page/snap/background change is view state: no undo step (D1)");

    // A patch that re-sends the SAME lists records nothing either.
    wb.patch(CanvasLayoutPatch { z_order: Some(Vec::new()), locked: Some(Vec::new()), ..Default::default() })
        .unwrap();
    assert_eq!(wb.depth().0, depth, "an unchanged stacking records no step that restores itself");
}

/// A patch that changes NOTHING (a script re-sending the page, snap grid and
/// stacking already there) leaves the document clean: `set_canvas_layout_inner`
/// minted its effect before comparing, so a no-op patch raised the
/// close-without-saving prompt (DocumentEffect: construct the effect only
/// inside the branch that actually changes something).
#[test]
fn an_unchanged_patch_leaves_the_document_clean_and_records_nothing() {
    let wb = Wb::new();
    let same = || CanvasLayoutPatch {
        grid_size_px: Some(25),
        background: Some("#ffeecc".to_string()),
        z_order: Some(vec![obj("chart", "c1"), obj("shape", "s1")]),
        locked: Some(vec![obj("shape", "s1")]),
        ..Default::default()
    };
    wb.patch(same()).unwrap();
    crate::document_effect::mark_saved(&wb.file);
    let (depth, _) = wb.depth();
    let before = wb.layout();

    let changed = wb.patch(same()).expect("a no-op patch is not an error");
    assert_eq!(changed.layout, before, "fixture: the patch re-sends exactly what is there");
    assert!(!wb.file.is_dirty(), "a patch that changed nothing dirtied the document");
    assert_eq!(wb.depth().0, depth, "a patch that changed nothing recorded a step");

    // The positive control: a real change still dirties.
    wb.patch(CanvasLayoutPatch { grid_size_px: Some(30), ..Default::default() }).unwrap();
    assert!(wb.file.is_dirty(), "a real layout change must still dirty the document");
}

#[test]
fn a_restack_inside_an_open_transaction_joins_it() {
    let wb = Wb::new();
    let (depth, _) = wb.depth();
    wb.state.undo_stack.lock().unwrap().begin_transaction("Arrange");

    wb.patch(CanvasLayoutPatch { z_order: Some(vec![obj("chart", "c1"), obj("shape", "s1")]), ..Default::default() })
        .unwrap();
    wb.patch(CanvasLayoutPatch { locked: Some(vec![obj("shape", "s1")]), ..Default::default() }).unwrap();
    assert!(
        wb.state.undo_stack.lock().unwrap().has_open_transaction(),
        "the recorder must not commit the caller's transaction"
    );
    wb.state.undo_stack.lock().unwrap().commit_transaction();
    assert_eq!(wb.depth().0, depth + 1, "both changes JOINED the caller's one step");

    wb.undo();
    let layout = wb.layout();
    assert!(layout.z_order.is_empty() && layout.locked.is_empty(), "one Ctrl+Z takes back the whole arrange");
}

#[test]
fn a_refused_patch_records_nothing() {
    let wb = Wb::new();
    let (depth, _) = wb.depth();
    let bad = CanvasLayoutPatch { z_order: Some(vec![obj("chart", " ")]), ..Default::default() };
    assert!(wb.patch(bad).is_err(), "fixture: a blank ref is refused");
    let worksheet = crate::sheets::set_canvas_layout_inner(
        &wb.state,
        &wb.file,
        Some(0),
        &CanvasLayoutPatch { z_order: Some(vec![obj("chart", "c1")]), ..Default::default() },
    );
    assert!(worksheet.is_err(), "fixture: a worksheet has no canvas layout");
    assert_eq!(wb.depth().0, depth, "a refused patch records no step");
}

#[test]
fn undoing_a_restack_of_a_canvas_that_moved_follows_its_identity() {
    let wb = Wb::new();
    let stacked = vec![obj("chart", "c1"), obj("shape", "s1")];
    wb.patch(CanvasLayoutPatch { z_order: Some(stacked.clone()), ..Default::default() }).unwrap();
    wb.patch(CanvasLayoutPatch { z_order: Some(vec![obj("shape", "s1"), obj("chart", "c1")]), ..Default::default() })
        .unwrap();
    // The restack's step is on top; the restore names the canvas by its
    // SheetId, so it lands on the canvas wherever it now sits.
    let canvas_id = wb.state.sheet_ids.read().unwrap()[wb.canvas];
    let transaction = wb.state.undo_stack.lock().unwrap().pop_undo().unwrap();
    // Simulate the canvas being addressed by identity only: a restore whose
    // sheet no longer exists must restore nothing and push no inverse.
    let mut inverse = engine::Transaction::new("probe");
    let data = match &transaction.changes[0] {
        engine::CellChange::CustomRestore { kind, data } => {
            assert_eq!(kind, crate::sheets::CANVAS_STACKING_RESTORE_KIND);
            data.clone()
        }
        other => panic!("expected the canvas_stacking restore, got {other:?}"),
    };
    let mut gone: serde_json::Value = serde_json::from_slice(&data).unwrap();
    assert_eq!(gone["sheet_id"], serde_json::to_value(canvas_id).unwrap(), "the restore names the canvas by identity");
    gone["sheet_id"] = serde_json::to_value(identity::SheetId::from_bytes(identity::generate_uuid_v7())).unwrap();
    let effect = crate::document_effect::DocumentEffect::mutates(&wb.file);
    crate::sheets::apply_canvas_stacking_restore(&wb.state, &effect, &serde_json::to_vec(&gone).unwrap(), &mut inverse);
    assert!(inverse.changes.is_empty(), "a canvas that is gone restores nothing");
    assert_eq!(wb.layout().z_order, vec![obj("shape", "s1"), obj("chart", "c1")], "and changes nothing");

    wb.apply(transaction, true);
    assert_eq!(wb.layout().z_order, stacked, "the real restore finds the canvas by its id");
}

/// LOCKS: the `canvas_stacking` step is recorded with NO store held -- the
/// function's own rule ("the undo stack is never taken while holding a
/// store"). The recorder sat inside `if let Some(id) = state.sheet_ids.read()
/// .unwrap().get(index).copied() { .. }`, and in edition 2021 a temporary in
/// an `if let` scrutinee lives to the end of the whole body: `sheet_ids` stayed
/// locked while the recorder WAITED for the undo stack (review of wave C).
/// Proved by a stranger holding the undo stack: the restack must wait for it
/// without holding `sheet_ids`, so a third reader of `sheet_ids` is never
/// queued behind the undo stack.
///
/// NO TIMING ON THE PASSING PATH (X9, wave D). The reader used to be given
/// 2 s, and once, in a full-suite run on a loaded machine, it was not even
/// SCHEDULED within 2 s: the product defect was reported for a slow machine
/// (a 2.1 s stall injected into the reader reproduces it exactly, with the
/// product untouched). A correct restack holds nothing while it waits, so the
/// reader gets `sheet_ids` as soon as it runs at all; a restack that keeps it
/// holds it until the stranger lets go -- forever, from the reader's side. So
/// the bounds below are not expectations but ceilings far past any stall:
/// only the defect ever reaches them, and only the defect pays their time.
#[test]
fn the_stacking_step_is_recorded_with_sheet_ids_released() {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// Reached only by a restack that holds `sheet_ids` (or never writes).
    const CEILING: Duration = Duration::from_secs(60);

    let wb = Wb::new();
    let (state, file, canvas) = (&wb.state, &wb.file, wb.canvas);
    let front = vec![obj("shape", "s1"), obj("chart", "c1")];
    let (depth, _) = wb.depth();
    let stranger = state.undo_stack.lock().unwrap();
    let reader_got_sheet_ids = std::thread::scope(|scope| {
        let patch = CanvasLayoutPatch { z_order: Some(front.clone()), ..Default::default() };
        let restack = scope.spawn(move || crate::sheets::set_canvas_layout_inner(state, file, Some(canvas), &patch));
        // The layout shows once the restack has written it and dropped
        // `sheet_kinds`; it then records -- waiting for the stranger's stack.
        let deadline = Instant::now() + CEILING;
        while wb.layout().z_order != front {
            assert!(Instant::now() < deadline, "fixture: the restack never wrote its layout");
            std::thread::sleep(Duration::from_millis(5));
        }
        // Lets a restack that WRONGLY keeps `sheet_ids` reach its wait before
        // the reader asks. Only the defect's detection depends on this pause;
        // the passing path does not depend on how long anything takes.
        std::thread::sleep(Duration::from_millis(150));
        let (tx, rx) = mpsc::channel();
        scope.spawn(move || {
            let len = state.sheet_ids.read().unwrap().len();
            let _ = tx.send(len);
        });
        // Received before the stranger is dropped below = read WHILE the undo
        // stack was held, which is the property.
        let got = rx.recv_timeout(CEILING).is_ok();
        // Let everyone finish before asserting (a stuck scope never joins).
        drop(stranger);
        restack.join().expect("the restack thread").expect("the restack");
        got
    });
    assert!(
        reader_got_sheet_ids,
        "set_canvas_layout_inner held `sheet_ids` while waiting for the undo stack"
    );
    assert_eq!(wb.depth().0, depth + 1, "fixture: the restack recorded its ONE step once the stack was free");
}
