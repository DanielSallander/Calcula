//! FILENAME: app/src-tauri/src/object_bindings/cascade_tests.rs
// PURPOSE: WP-D S5b (D §3.12, §3.20): what happens to object property BINDINGS
//          when what they name goes away or moves.
//          - a delete drops the object's bindings in the SAME undo step, and one
//            Ctrl+Z brings back the object AND its bindings (chart, control,
//            slicer, timeline);
//          - a sheet delete drops the bindings of the page and of every object
//            on it, and turns a surviving binding's reference into #REF!
//            through delete_rule_references -> rewrite_rule_formulas ->
//            rewrite_binding_formulas;
//          - a sheet rename re-spells binding formulas;
//          - inserting / deleting rows, columns and cells shifts them (and one
//            Ctrl+Z puts them back), without deadlocking against an evaluation;
//          - every caller of `shift_named_ranges*` also shifts bindings (census);
//          - Trace Dependents names the bound objects that read a cell.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::object_json::ObjectStores;
use super::store::{BindingKey, StoredBinding};
use crate::api_types::{ObjectBindingKind, ObjectBindingRef};
use crate::document_effect::{test_seed_effect, DocumentEffect};
use crate::persistence::{FileState, UserFilesState};
use crate::AppState;

const DATA: usize = 0;
const INPUTS: usize = 1;
const REPORT: usize = 2;

fn entity() -> identity::EntityId {
    identity::EntityId::from_bytes(identity::generate_uuid_v7())
}

/// Data (active) and Inputs are worksheets, Report is a canvas page. Built
/// through the real sheet doors, so every per-sheet vector is as the app keeps
/// it (a sheet delete walks all of them).
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
        crate::sheets::add_sheet_inner(&wb.state, &wb.file, Some("Report".to_string()), ::persistence::SheetKind::new_canvas())
            .expect("add the Report canvas");
        crate::sheets::activate_sheet(&wb.state, DATA).expect("back to Data");
        assert_eq!(
            *wb.state.sheet_names.read().unwrap(),
            vec!["Data".to_string(), "Inputs".to_string(), "Report".to_string()],
            "fixture"
        );
        wb
    }

    fn stores(&self) -> ObjectStores<'_> {
        ObjectStores { state: &self.state, slicers: &self.slicers, timelines: &self.timelines, pivots: &self.pivots }
    }

    fn sheet_id(&self, index: usize) -> identity::SheetId {
        self.state.sheet_ids.read().unwrap()[index]
    }

    /// Store a binding directly (the command is S3b's subject, not this file's).
    fn bind(&self, object: &ObjectBindingRef, path: &str, formula: &str) {
        let mut store = self.state.object_bindings.write(&test_seed_effect()).unwrap();
        store.bindings.insert(
            BindingKey { object: object.clone(), path: path.to_string() },
            StoredBinding { formula: formula.to_string(), model: None },
        );
        store.bump_generation();
    }

    fn formula(&self, object: &ObjectBindingRef, path: &str) -> Option<String> {
        self.state
            .object_bindings
            .read()
            .unwrap()
            .bindings
            .get(&BindingKey { object: object.clone(), path: path.to_string() })
            .map(|b| b.formula.clone())
    }

    fn bound_objects(&self) -> Vec<ObjectBindingRef> {
        let store = self.state.object_bindings.read().unwrap();
        let mut out: Vec<ObjectBindingRef> = store.bindings.keys().map(|k| k.object.clone()).collect();
        out.dedup();
        out
    }

    fn generation(&self) -> u64 {
        self.state.object_bindings.read().unwrap().generation
    }

    fn depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }

    fn apply(&self, transaction: engine::Transaction, is_undo: bool) {
        crate::undo_commands::apply_changes(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.slicers,
            &self.ribbon,
            &self.pane,
            &self.timelines,
            transaction,
            is_undo,
        );
    }

    fn undo(&self) {
        let t = self.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
        self.apply(t, true);
    }

    fn redo(&self) {
        let t = self.state.undo_stack.lock().unwrap().pop_redo().expect("nothing to redo");
        self.apply(t, false);
    }

    fn chart(&self, sheet: usize) -> ObjectBindingRef {
        let id = entity();
        let envelope = json!({ "chartId": id.to_string(), "name": "Revenue chart", "sheetIndex": sheet, "spec": { "mark": "bar" } });
        self.state.charts.write(&test_seed_effect()).unwrap().push(crate::api_types::ChartEntry {
            id,
            sheet_index: sheet,
            spec_json: envelope.to_string(),
        });
        ObjectBindingRef { kind: ObjectBindingKind::Chart, id: id.to_string() }
    }

    fn chart_exists(&self, object: &ObjectBindingRef) -> bool {
        self.state.charts.read().unwrap().iter().any(|c| c.id.to_string() == object.id)
    }

    fn control(&self, sheet: usize, row: u32, col: u32) -> ObjectBindingRef {
        let uid = format!("ctl-{sheet}-{row}-{col}");
        let mut properties = HashMap::new();
        properties.insert(
            "text".to_string(),
            crate::controls::ControlPropertyValue { value_type: "static".to_string(), value: String::new() },
        );
        self.state.controls.write(&test_seed_effect()).unwrap().insert(
            (sheet, row, col),
            crate::controls::ControlMetadata { control_type: "button".to_string(), uid: uid.clone(), properties },
        );
        ObjectBindingRef { kind: ObjectBindingKind::Control, id: uid }
    }

    fn slicer(&self, sheet: usize) -> (identity::EntityId, ObjectBindingRef) {
        let id = entity();
        let slicer: crate::slicer::Slicer = serde_json::from_value(json!({
            "id": id.to_string(), "name": "Region", "headerText": "Pick a region",
            "sheetIndex": sheet, "x": 0.0, "y": 0.0, "width": 100.0, "height": 200.0,
            "sourceType": "table", "cacheSourceId": entity().to_string(), "fieldName": "Region",
            "selectedItems": null, "showHeader": true, "columns": 1, "stylePreset": "SlicerStyleLight1"
        }))
        .expect("a minimal slicer");
        self.slicers.slicers.write(&test_seed_effect()).unwrap().insert(id, slicer);
        (id, ObjectBindingRef { kind: ObjectBindingKind::Slicer, id: id.to_string() })
    }

    fn timeline(&self, sheet: usize) -> (identity::EntityId, ObjectBindingRef) {
        let id = entity();
        let timeline: crate::timeline_slicer::TimelineSlicer = serde_json::from_value(json!({
            "id": id.to_string(), "name": "Order date", "sheetIndex": sheet,
            "x": 0.0, "y": 0.0, "width": 300.0, "height": 120.0,
            "sourceType": "pivot", "sourceId": entity().to_string(), "fieldName": "OrderDate",
            "showHeader": true, "showLevelSelector": true, "showScrollbar": true, "stylePreset": "TimeSlicerStyleLight1"
        }))
        .expect("a minimal timeline");
        self.timelines.timelines.write(&test_seed_effect()).unwrap().insert(id, timeline);
        (id, ObjectBindingRef { kind: ObjectBindingKind::TimelineSlicer, id: id.to_string() })
    }

    fn page(&self) -> ObjectBindingRef {
        ObjectBindingRef { kind: ObjectBindingKind::CanvasPage, id: self.sheet_id(REPORT).to_string() }
    }

    fn delete_sheet(&self, index: usize) {
        crate::sheets::delete_sheet_impl(
            &self.state,
            &self.file,
            &self.pivots,
            &self.files,
            &self.pane,
            &self.ribbon,
            &self.slicers,
            &self.timelines,
            index,
            false,
        )
        .expect("delete the sheet");
    }

    fn insert_rows(&self, row: u32, count: u32, sheet: Option<usize>) {
        crate::commands::structure::insert_rows_impl(
            &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.ribbon, &self.slicers,
            &self.timelines, row, count, sheet,
        )
        .expect("insert rows");
    }

    fn delete_rows(&self, row: u32, count: u32) {
        crate::commands::structure::delete_rows_impl(
            &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.ribbon, &self.slicers,
            &self.timelines, row, count, None,
        )
        .expect("delete rows");
    }

    fn insert_columns(&self, col: u32, count: u32) {
        crate::commands::structure::insert_columns_impl(
            &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.ribbon, &self.slicers,
            &self.timelines, col, count, None,
        )
        .expect("insert columns");
    }
}

// ===========================================================================
// One undo step per delete (D §3.12)
// ===========================================================================

/// The chart delete (the AI's door `delete_chart_core`; the command
/// `chart_commands::delete_chart` runs the identical cascade, which the
/// object-dependency census pins by name): the chart's bindings go, a
/// NEIGHBOUR's stay, the delete is ONE step, and one Ctrl+Z brings back the
/// chart AND its bindings.
///
/// SABOTAGE: drop the `drop_bindings_for_objects` call from
/// `delete_chart_core` -- the binding survives the delete.
#[test]
fn deleting_a_chart_drops_its_bindings_in_its_one_undo_step() {
    let wb = Wb::new();
    let chart = wb.chart(DATA);
    let neighbour = wb.chart(DATA);
    wb.bind(&chart, "/spec/title", "=Data!A1");
    wb.bind(&chart, "/spec/xAxis/min", "=Inputs!B2");
    wb.bind(&neighbour, "/spec/title", "=Data!A2");
    let depth = wb.depth();
    let generation = wb.generation();

    let effect = DocumentEffect::mutates(&wb.file);
    crate::mcp::objects::delete_chart_core(&wb.state, &wb.pane, &effect, &chart.id).expect("delete");

    assert_eq!(wb.depth(), depth + 1, "the delete is ONE undo step, bindings included");
    assert!(!wb.chart_exists(&chart));
    assert_eq!(wb.formula(&chart, "/spec/title"), None, "a deleted chart's binding survived");
    assert_eq!(wb.formula(&chart, "/spec/xAxis/min"), None);
    assert_eq!(wb.formula(&neighbour, "/spec/title").as_deref(), Some("=Data!A2"), "a neighbour lost its binding");
    assert!(wb.generation() > generation, "the store write did not bump the generation");

    wb.undo();
    assert!(wb.chart_exists(&chart), "one Ctrl+Z did not bring the chart back");
    assert_eq!(wb.formula(&chart, "/spec/title").as_deref(), Some("=Data!A1"), "one Ctrl+Z did not bring its binding back");
    assert_eq!(wb.formula(&chart, "/spec/xAxis/min").as_deref(), Some("=Inputs!B2"));
    assert_eq!(wb.depth(), depth);

    wb.redo();
    assert!(!wb.chart_exists(&chart));
    assert_eq!(wb.formula(&chart, "/spec/title"), None, "redo brought the binding back without the chart");
}

/// A delete with nothing bound writes nothing to the store (no generation
/// bump, so no reload is announced) and is still one step.
#[test]
fn deleting_an_unbound_object_leaves_the_binding_store_alone() {
    let wb = Wb::new();
    let chart = wb.chart(DATA);
    let other = wb.chart(DATA);
    wb.bind(&other, "/spec/title", "=Data!A1");
    let generation = wb.generation();
    let depth = wb.depth();
    let effect = DocumentEffect::mutates(&wb.file);
    crate::mcp::objects::delete_chart_core(&wb.state, &wb.pane, &effect, &chart.id).expect("delete");
    assert_eq!(wb.generation(), generation, "an unbound delete wrote the binding store");
    assert_eq!(wb.depth(), depth + 1);
    assert_eq!(wb.formula(&other, "/spec/title").as_deref(), Some("=Data!A1"));
    assert_eq!(super::cascade::drop_bindings_for_objects(&wb.state, &effect, &[]), None);
}

/// D §3.12 "one undo step per delete (controls)": the controls recorder opens
/// its own transaction when none is open, so the controls restore and the
/// bindings restore must go to ONE recorder call -- two calls were two Ctrl+Z
/// steps, the first of which brought back bindings for a control that was not
/// there.
///
/// SABOTAGE: record the bindings through a separate
/// `record_bindings_undo` call in `remove_control_metadata_core` -- the depth
/// assertion fails (+2).
#[test]
fn deleting_a_control_is_one_step_and_one_undo_brings_back_the_control_and_its_bindings() {
    let wb = Wb::new();
    let control = wb.control(DATA, 3, 2);
    wb.bind(&control, "/properties/text", "=\"Region: \"&Data!B1");
    let depth = wb.depth();

    assert!(crate::controls::remove_control_metadata_core(&wb.state, &wb.file, DATA, 3, 2).expect("delete"));
    assert_eq!(wb.depth(), depth + 1, "the control and its bindings are ONE step");
    assert!(!wb.state.controls.read().unwrap().contains_key(&(DATA, 3, 2)));
    assert_eq!(wb.formula(&control, "/properties/text"), None, "the deleted control's binding survived");

    wb.undo();
    let controls = wb.state.controls.read().unwrap();
    let back = controls.get(&(DATA, 3, 2)).expect("one Ctrl+Z did not bring the control back");
    assert_eq!(back.uid, control.id, "the control came back under another uid -- its bindings would be orphans");
    drop(controls);
    assert_eq!(
        wb.formula(&control, "/properties/text").as_deref(),
        Some("=\"Region: \"&Data!B1"),
        "one Ctrl+Z did not bring the control's binding back"
    );
    assert_eq!(wb.depth(), depth);
}

#[tokio::test]
async fn deleting_a_slicer_drops_its_bindings_in_its_one_undo_step() {
    let wb = Wb::new();
    let (slicer_id, slicer) = wb.slicer(DATA);
    wb.bind(&slicer, "/headerText", "=Data!A1");
    let depth = wb.depth();
    let bi = crate::bi::types::BiState::new();
    let ctx = crate::pivot::commands::PivotCmdCtx {
        state: &wb.state,
        file_state: &wb.file,
        pivot_state: &wb.pivots,
        pane_control_state: &wb.pane,
        ribbon_filter_state: &wb.ribbon,
        user_files_state: &wb.files,
        bi_state: &bi,
        slicer_state: &wb.slicers,
        record_undo: true,
    };
    crate::slicer::commands::delete_slicer_core(&ctx, slicer_id).await.expect("delete");
    assert_eq!(wb.depth(), depth + 1, "the slicer and its bindings are ONE step");
    assert_eq!(wb.formula(&slicer, "/headerText"), None);

    wb.undo();
    assert!(wb.slicers.slicers.read().unwrap().contains_key(&slicer_id), "the slicer came back");
    assert_eq!(wb.formula(&slicer, "/headerText").as_deref(), Some("=Data!A1"), "its binding came back with it");
}

#[test]
fn deleting_a_timeline_drops_its_bindings_in_its_one_undo_step() {
    let wb = Wb::new();
    let (timeline_id, timeline) = wb.timeline(DATA);
    wb.bind(&timeline, "/headerText", "=Data!A1");
    let depth = wb.depth();
    crate::timeline_slicer::commands::delete_timeline_slicer_core(&wb.state, &wb.timelines, &wb.file, timeline_id)
        .expect("delete");
    assert_eq!(wb.depth(), depth + 1, "the timeline and its bindings are ONE step");
    assert_eq!(wb.formula(&timeline, "/headerText"), None);

    wb.undo();
    assert!(wb.timelines.timelines.read().unwrap().contains_key(&timeline_id), "the timeline came back");
    assert_eq!(wb.formula(&timeline, "/headerText").as_deref(), Some("=Data!A1"), "its binding came back with it");
}

// ===========================================================================
// Sheet delete / rename (D §3.12)
// ===========================================================================

/// Proves the bindings arm is REACHED through the chain the matrix row names
/// (`delete_sheet_impl` -> `delete_rule_references` -> `rewrite_rule_formulas`
/// -> `rewrite_binding_formulas`), so the row's symbol is not a vouch by name:
/// a surviving chart's binding that read the deleted sheet reads #REF!, an
/// unrelated one keeps its bytes.
///
/// SABOTAGE: drop the `rewrite_binding_formulas` call from
/// `sheets.rs::rewrite_rule_formulas` -- the first assertion fails.
#[test]
fn deleting_a_sheet_turns_binding_refs_into_ref_errors() {
    let wb = Wb::new();
    let chart = wb.chart(DATA);
    wb.bind(&chart, "/spec/title", "=Inputs!A1");
    wb.bind(&chart, "/spec/xAxis/title", "=Data!A1&Inputs!B1");
    wb.bind(&chart, "/spec/yAxis/title", "=Data!C3");

    wb.delete_sheet(INPUTS);

    let title = wb.formula(&chart, "/spec/title").expect("a SURVIVING object keeps its binding");
    assert!(title.contains("#REF!") && !title.to_uppercase().contains("INPUTS"), "`{title}` still reads the deleted sheet");
    let mixed = wb.formula(&chart, "/spec/xAxis/title").expect("kept");
    // The surviving reference keeps the workbook's own spelling: the repair
    // re-renders the formula, and the lexer upper-cases a bare sheet name.
    assert!(
        mixed.contains("#REF!") && mixed.contains("Data!A1"),
        "`{mixed}`: only the deleted sheet's reference breaks, and Data stays spelled Data"
    );
    assert_eq!(wb.formula(&chart, "/spec/yAxis/title").as_deref(), Some("=Data!C3"), "an unrelated binding was rewritten");
}

/// Deleting a canvas page drops the page's own bindings and those of every
/// object on it; a chart on another sheet keeps its binding.
///
/// SABOTAGE: drop the `drop_bindings_for_objects` call from
/// `delete_sheet_impl` -- the page's binding survives.
#[test]
fn deleting_a_sheet_drops_the_page_and_its_objects_bindings() {
    let wb = Wb::new();
    let page = wb.page();
    let on_page = wb.chart(REPORT);
    let elsewhere = wb.chart(DATA);
    let control = wb.control(REPORT, 1, 1);
    wb.bind(&page, "/background", "=Inputs!B3");
    wb.bind(&on_page, "/spec/title", "=Data!A1");
    wb.bind(&control, "/properties/text", "=Data!A2");
    wb.bind(&elsewhere, "/spec/title", "=Data!A3");

    wb.delete_sheet(REPORT);

    assert_eq!(wb.bound_objects(), vec![elsewhere.clone()], "only the surviving chart keeps bindings");
    assert_eq!(wb.formula(&elsewhere, "/spec/title").as_deref(), Some("=Data!A3"));
}

/// A rename re-spells every binding formula that names the sheet (quoted when
/// the new name needs it), and leaves the rest byte for byte.
#[test]
fn renaming_a_sheet_rewrites_binding_formulas() {
    let wb = Wb::new();
    let chart = wb.chart(INPUTS);
    let page = wb.page();
    wb.bind(&chart, "/spec/title", "=Data!B2");
    wb.bind(&chart, "/spec/xAxis/title", "=Data!B2&Inputs!C1");
    wb.bind(&page, "/background", "=Inputs!B3");
    crate::sheets::rename_sheet_inner(&wb.state, &wb.file, &wb.pivots, DATA, "Data 2".to_string(), false)
        .expect("rename Data");
    assert_eq!(wb.formula(&chart, "/spec/title").as_deref(), Some("='Data 2'!B2"));
    assert_eq!(
        wb.formula(&chart, "/spec/xAxis/title").as_deref(),
        Some("='Data 2'!B2&Inputs!C1"),
        "the untouched Inputs reference keeps the workbook's spelling"
    );
    assert_eq!(wb.formula(&page, "/background").as_deref(), Some("=Inputs!B3"), "an unrelated binding was re-spelled");
}

// ===========================================================================
// Structural shift (D §3.12)
// ===========================================================================

/// Insert a row above B2 on Data: `=Data!B2` follows to B3, a binding reading
/// another sheet stays, and one Ctrl+Z (the structural step) puts it back.
///
/// SABOTAGE: drop the `shift_object_bindings` call from `insert_rows_impl`'s
/// named-range site -- the binding still reads B2.
#[test]
fn inserting_a_row_above_a_bound_cell_shifts_the_binding_and_undo_puts_it_back() {
    let wb = Wb::new();
    let chart = wb.chart(DATA);
    wb.bind(&chart, "/spec/title", "=Data!B2");
    wb.bind(&chart, "/spec/xAxis/title", "=Inputs!B2");
    let generation = wb.generation();

    wb.insert_rows(0, 1, None);

    assert_eq!(wb.formula(&chart, "/spec/title").as_deref(), Some("=Data!B3"));
    assert_eq!(wb.formula(&chart, "/spec/xAxis/title").as_deref(), Some("=Inputs!B2"), "another sheet's reference moved");
    assert!(wb.generation() > generation, "the shift did not bump the generation");

    wb.undo();
    assert_eq!(wb.formula(&chart, "/spec/title").as_deref(), Some("=Data!B2"), "one Ctrl+Z did not put the binding back");
    wb.redo();
    assert_eq!(wb.formula(&chart, "/spec/title").as_deref(), Some("=Data!B3"));
}

/// The off-sheet structural path (an explicit non-active target).
#[test]
fn inserting_a_row_on_another_sheet_shifts_the_bindings_that_read_it() {
    let wb = Wb::new();
    let chart = wb.chart(DATA);
    wb.bind(&chart, "/spec/title", "=Inputs!B2");
    wb.bind(&chart, "/spec/xAxis/title", "=Data!B2");
    wb.insert_rows(0, 1, Some(INPUTS));
    assert_eq!(wb.formula(&chart, "/spec/title").as_deref(), Some("=Inputs!B3"));
    assert_eq!(wb.formula(&chart, "/spec/xAxis/title").as_deref(), Some("=Data!B2"));
}

#[test]
fn deleting_the_row_a_binding_reads_turns_it_into_ref_and_columns_shift_too() {
    let wb = Wb::new();
    let chart = wb.chart(DATA);
    wb.bind(&chart, "/spec/title", "=Data!B2");
    wb.bind(&chart, "/spec/xAxis/title", "=Data!B5");
    wb.delete_rows(1, 1);
    let title = wb.formula(&chart, "/spec/title").unwrap();
    assert!(title.contains("#REF!"), "a reference into the deleted row became `{title}`");
    assert_eq!(wb.formula(&chart, "/spec/xAxis/title").as_deref(), Some("=Data!B4"));

    wb.insert_columns(0, 2);
    assert_eq!(wb.formula(&chart, "/spec/xAxis/title").as_deref(), Some("=Data!D4"));
}

/// Excel's Insert Cells (shift down) over B1:B1: only references inside the
/// shifted band (column B, at or below row 1) move.
///
/// SABOTAGE: drop the `shift_object_bindings_in_band` call from
/// `shift_cells_impl` -- the first assertion fails.
#[test]
fn inserting_cells_shifts_only_the_bindings_inside_the_band() {
    let wb = Wb::new();
    let chart = wb.chart(DATA);
    wb.bind(&chart, "/spec/title", "=Data!B2");
    wb.bind(&chart, "/spec/xAxis/title", "=Data!C2");
    crate::commands::structure::structure_cells::shift_cells_impl(
        &wb.state,
        &wb.file,
        &wb.pivots,
        &wb.files,
        &wb.pane,
        &wb.ribbon,
        &wb.slicers,
        &wb.timelines,
        0,
        1,
        0,
        1,
        crate::commands::structure::structure_cells::CellShift::Down,
        false,
    )
    .expect("insert cells");
    assert_eq!(wb.formula(&chart, "/spec/title").as_deref(), Some("=Data!B3"));
    assert_eq!(wb.formula(&chart, "/spec/xAxis/title").as_deref(), Some("=Data!C2"), "a reference outside the band moved");
}

/// D risk 7 / §3.3 rule 2: a structural shift holds `grid`, `grids` and the
/// `undo_stack` guard while it takes the (leaf) binding store; an evaluation
/// takes the store, releases it, then takes `grid` -> `grids`. Run both on two
/// threads against a bound object on the edited sheet, under a deadline, so a
/// deadlock is REPORTED rather than joined.
#[test]
fn a_structural_shift_with_a_bound_object_does_not_deadlock() {
    let wb = Arc::new(Wb::new());
    let chart = wb.chart(DATA);
    wb.bind(&chart, "/spec/title", "=Data!B2");
    wb.bind(&chart, "/spec/xAxis/min", "=SUM(Data!A1:A9)");

    const ROUNDS: usize = 25;
    let shifter_done = Arc::new(AtomicBool::new(false));
    let evaluations = Arc::new(AtomicUsize::new(0));

    let shifter = {
        let wb = Arc::clone(&wb);
        let done = Arc::clone(&shifter_done);
        std::thread::spawn(move || {
            for _ in 0..ROUNDS {
                wb.insert_rows(0, 1, None);
                wb.delete_rows(0, 1);
            }
            done.store(true, Ordering::SeqCst);
        })
    };
    let evaluator = {
        let wb = Arc::clone(&wb);
        let done = Arc::clone(&shifter_done);
        let evaluations = Arc::clone(&evaluations);
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                super::eval::reevaluate(&wb.stores(), &wb.pane, &wb.ribbon, super::eval::Scope::All);
                evaluations.fetch_add(1, Ordering::SeqCst);
            }
        })
    };

    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline && !shifter_done.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        shifter_done.load(Ordering::SeqCst),
        "DEADLOCK: after 60 s the structural shifts had not finished ({} evaluations ran)",
        evaluations.load(Ordering::SeqCst)
    );
    shifter.join().unwrap();
    evaluator.join().unwrap();
    assert_eq!(wb.formula(&chart, "/spec/title").as_deref(), Some("=Data!B2"), "insert + delete is a round trip");
}

// ===========================================================================
// Census: every named-range shift site also shifts bindings
// ===========================================================================

/// Every non-test `.rs` file of the crate as (path relative to src, text).
fn crate_sources() -> Vec<(String, String)> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("readable src dir").flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if !name.ends_with(".rs") || name.ends_with("_tests.rs") || name == "tests.rs" {
                continue;
            }
            let rel = path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
            out.push((rel, std::fs::read_to_string(&path).unwrap_or_default()));
        }
    }
    assert!(out.len() > 100, "the crate scan found only {} files", out.len());
    out
}

/// True when comment-stripped `code` CALLS `name(` (an identifier boundary
/// before it, and not its definition `fn name(`).
fn calls(code: &str, name: &str) -> bool {
    let needle = format!("{name}(");
    let mut from = 0;
    while let Some(at) = code[from..].find(&needle) {
        let i = from + at;
        let boundary = !code[..i].chars().next_back().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        let definition = code[..i].trim_end().ends_with("fn");
        if boundary && !definition {
            return true;
        }
        from = i + needle.len();
    }
    false
}

/// The functions that call a named-range shift without the matching binding
/// shift, as "file::fn", and how many named-range shift sites were seen.
fn unpaired_shift_sites(sources: &[(String, String)]) -> (usize, Vec<String>) {
    let pairs = [
        ("shift_named_ranges", "shift_object_bindings"),
        ("shift_named_ranges_in_band", "shift_object_bindings_in_band"),
    ];
    let mut sites = 0usize;
    let mut unpaired = Vec::new();
    for (file, text) in sources {
        for (name, body) in super::eval_tests::functions(text) {
            let code = super::eval_tests::strip_comments(&body);
            for (names, bindings) in pairs {
                if !calls(&code, names) {
                    continue;
                }
                sites += 1;
                if !calls(&code, bindings) {
                    unpaired.push(format!("{file}::{name} calls {names} without {bindings}"));
                }
            }
        }
    }
    (sites, unpaired)
}

/// D §3.12: a binding formula is a coordinate holder exactly like a defined
/// name, so every place that shifts names shifts bindings too -- a sixth
/// structural path added later must not leave bound properties reading the
/// wrong row.
///
/// SABOTAGE: drop any one `shift_object_bindings` call in
/// `commands/structure.rs` -- this names the function.
#[test]
fn every_named_range_shift_site_also_shifts_bindings() {
    let (sites, unpaired) = unpaired_shift_sites(&crate_sources());
    assert!(sites >= 6, "only {sites} named-range shift site(s) found -- the census is not seeing them");
    assert!(unpaired.is_empty(), "structural paths that shift names but not bindings:\n{}", unpaired.join("\n"));
}

#[test]
fn the_shift_site_census_fires_on_a_planted_body() {
    let planted = vec![(
        "planted.rs".to_string(),
        "fn forgets(state: &AppState) {\n    let n = shift_named_ranges(state, e, u, 0, \"Data\", edit);\n}\n\
         fn pairs(state: &AppState) {\n    shift_named_ranges_in_band(state, e, u, 0, \"Data\", &band);\n    \
         crate::object_bindings::cascade::shift_object_bindings_in_band(state, e, u, \"Data\", &band);\n}\n\
         fn quiet(state: &AppState) {\n    // shift_named_ranges(state) is only mentioned here\n}\n\
         pub(crate) fn shift_named_ranges(state: &AppState) {}\n"
            .to_string(),
    )];
    let (sites, unpaired) = unpaired_shift_sites(&planted);
    assert_eq!(sites, 2, "a comment and a definition are not call sites");
    assert_eq!(unpaired, vec!["planted.rs::forgets calls shift_named_ranges without shift_object_bindings".to_string()]);
}

// ===========================================================================
// Trace Dependents (D §3.20)
// ===========================================================================

/// Trace Dependents on Data!B2 names the chart bound to it and the one bound
/// to a range around it, not the one reading another cell.
///
/// SABOTAGE: return `Vec::new()` from `bound_objects_reading_cell` -- the
/// assertion fails.
#[test]
fn trace_returns_the_bound_chart_for_its_cell() {
    let wb = Wb::new();
    let direct = wb.chart(DATA);
    let ranged = wb.chart(REPORT);
    let unrelated = wb.chart(DATA);
    wb.bind(&direct, "/spec/title", "=Data!B2");
    wb.bind(&ranged, "/spec/xAxis/max", "=SUM(Data!A1:C3)");
    wb.bind(&unrelated, "/spec/title", "=Data!Z9");

    let result = crate::tracing::trace_dependents_core(&wb.stores(), 1, 1);
    let mut got: Vec<(String, String, String)> = result
        .bound_objects
        .iter()
        .map(|b| (b.object.id.clone(), b.path.clone(), b.formula.clone()))
        .collect();
    got.sort();
    let mut want = vec![
        (direct.id.clone(), "/spec/title".to_string(), "=Data!B2".to_string()),
        (ranged.id.clone(), "/spec/xAxis/max".to_string(), "=SUM(Data!A1:C3)".to_string()),
    ];
    want.sort();
    assert_eq!(got, want);

    // The wire shape: camelCase `boundObjects`, each `{object, path, formula}`.
    let wire: Value = serde_json::to_value(&result).unwrap();
    assert_eq!(wire["boundObjects"].as_array().map(Vec::len), Some(2));
    assert!(wire["boundObjects"][0]["object"]["kind"].is_string());

    // A cell nothing is bound to names no object.
    assert!(crate::tracing::trace_dependents_core(&wb.stores(), 40, 40).bound_objects.is_empty());
}

// ===========================================================================
// A SOURCE cascade drops the bindings of what it destroys (every caller)
// ===========================================================================

/// Delete Table, Convert to Range and a row/column delete that swallows a pivot
/// all end in `cascade_deleted_sources`, which deletes the slicers and
/// timelines left with nothing to show. Their binding rows -- and the removed
/// pivot's own -- used to stay behind (only `delete_pivot_table` dropped
/// them), so Bound Properties listed "(no longer in this workbook)" rows and an
/// .xlsx save warned about bindings whose objects were all gone. The cascade
/// now drops them itself, records their restore FIRST in the caller's one step
/// (so one Ctrl+Z brings them back LAST, after the objects), and the xlsx
/// question counts only live objects.
///
/// SABOTAGE (confirmed): delete the bindings block from
/// `cascade_deleted_sources` -- the slicer's, the timeline's and the pivot's
/// bindings survive the cascade.
#[test]
fn a_source_cascade_drops_the_bindings_of_every_object_it_destroys() {
    let wb = Wb::new();
    let table = entity();
    let pivot = entity();
    let (slicer_id, slicer) = wb.slicer(DATA);
    wb.slicers.slicers.write(&test_seed_effect()).unwrap().get_mut(&slicer_id).unwrap().cache_source_id = table;
    let (timeline_id, timeline) = wb.timeline(DATA);
    wb.timelines.timelines.write(&test_seed_effect()).unwrap().get_mut(&timeline_id).unwrap().source_id = pivot;
    let pivot_ref = ObjectBindingRef { kind: ObjectBindingKind::Pivot, id: pivot.to_string() };
    let survivor = wb.chart(DATA);
    wb.bind(&slicer, "/headerText", "=Data!A1");
    wb.bind(&timeline, "/headerText", "=Data!A2");
    wb.bind(&pivot_ref, "/canvasFrame/container/title/text", "=Data!A3");
    wb.bind(&survivor, "/spec/title", "=Data!A4");
    assert!(super::store::any_live_binding(&wb.stores()), "the chart's binding is live");

    let effect = DocumentEffect::mutates(&wb.file);
    let depth = wb.depth();
    wb.state.undo_stack.lock().unwrap().begin_transaction("Delete table");
    let cascade = crate::object_deps::cascade_deleted_sources(
        &wb.state,
        &wb.slicers,
        &wb.timelines,
        &wb.ribbon,
        &effect,
        &[crate::object_deps::DeletedSource::table(table), crate::object_deps::DeletedSource::pivot(pivot)],
    );
    crate::object_deps::record_source_cascade_undo(&wb.state, &cascade);
    wb.state.undo_stack.lock().unwrap().commit_transaction();

    assert_eq!(cascade.deleted_slicers.len(), 1, "the table slicer went");
    assert_eq!(cascade.deleted_timelines.len(), 1, "the pivot timeline went");
    assert!(cascade.bindings_restore.is_some(), "the cascade dropped bindings and carries their restore");
    assert_eq!(wb.formula(&slicer, "/headerText"), None, "the deleted slicer's binding survived");
    assert_eq!(wb.formula(&timeline, "/headerText"), None, "the deleted timeline's binding survived");
    assert_eq!(wb.formula(&pivot_ref, "/canvasFrame/container/title/text"), None, "the removed pivot's binding survived");
    assert_eq!(wb.bound_objects(), vec![survivor.clone()], "only the surviving chart keeps bindings");
    assert_eq!(wb.depth(), depth + 1, "one step");

    // An orphan row is no loss for an .xlsx: with only an orphan left, nothing is live.
    let orphan = ObjectBindingRef { kind: ObjectBindingKind::Slicer, id: entity().to_string() };
    wb.bind(&orphan, "/headerText", "=Data!A9");
    {
        let mut store = wb.state.object_bindings.write(&test_seed_effect()).unwrap();
        store.bindings.retain(|k, _| k.object != survivor);
    }
    assert!(!super::store::any_live_binding(&wb.stores()), "an orphan row is not a live binding");
    {
        let mut store = wb.state.object_bindings.write(&test_seed_effect()).unwrap();
        store.bindings.retain(|k, _| k.object != orphan);
    }
    wb.bind(&survivor, "/spec/title", "=Data!A4");

    // One Ctrl+Z: the slicer and timeline come back, and their bindings with them.
    wb.undo();
    assert!(wb.slicers.slicers.read().unwrap().contains_key(&slicer_id));
    assert!(wb.timelines.timelines.read().unwrap().contains_key(&timeline_id));
    assert_eq!(wb.formula(&slicer, "/headerText").as_deref(), Some("=Data!A1"));
    assert_eq!(wb.formula(&timeline, "/headerText").as_deref(), Some("=Data!A2"));
    assert_eq!(wb.formula(&pivot_ref, "/canvasFrame/container/title/text").as_deref(), Some("=Data!A3"));
    assert_eq!(wb.formula(&survivor, "/spec/title").as_deref(), Some("=Data!A4"), "an unrelated binding is untouched");
}
