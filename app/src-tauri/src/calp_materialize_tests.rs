//! FILENAME: app/src-tauri/src/calp_materialize_tests.rs
//! PURPOSE: A materialized package keeps its LITERAL cells, and the active-sheet
//! mirror agrees with the grid it mirrors.
//! CONTEXT: Reported 2026-08-30 — publish a sheet of hard-coded values and
//! formulas, open it, and only the formulas are there.
//!
//! # The mechanism, because it is not obvious from any one file
//!
//! `state.grid` is the authoritative copy of the ACTIVE sheet;
//! `state.grids[i]` is the per-sheet store. Two facts combine badly:
//!
//!   1. `run_calculation_pass` opens with `grids[active] = grid.clone()`
//!      (calculation.rs:1107) — a whole-Grid REPLACEMENT, so any cell present
//!      in `grids[active]` but absent from the mirror is deleted outright.
//!   2. `recalculate_sheet_values` only ever writes FORMULA cells into the
//!      mirror — it builds its work list from `cell.formula_string()`.
//!
//! So a sheet materialized onto the active index with a stale mirror loses
//! every literal on the next recalculation, while its formulas survive. The
//! asymmetry in the bug report is the fingerprint of exactly this.
//!
//! `calp_refresh` and `calp_reset_to_package` both sync the mirror and both
//! carry a comment saying why. `materialize_pull_result` — used by BOTH
//! subscribe and checkout — did not.
//!
//! # Why there was no test before
//!
//! The materializer took a `&tauri::Window`, which cannot be constructed
//! outside a running app, so 700 lines covering every artifact type a package
//! can carry were reachable only by launching Calcula. The parameter is now
//! `Option<&tauri::Window>`; these tests pass `None`.

use std::path::Path;

use tempfile::TempDir;

use calp::publish::{self, PublishRequest, PushMode};
use calp::version::{SemVer, VersionPin};

use engine::cell::Cell;
use persistence::{SavedCell, Sheet, Workbook};

use crate::calp_commands::{materialize_pull_result, MaterializeMode};

/// The reported shape: text literals, number literals, and a formula reading
/// them.
fn mixed_workbook() -> Workbook {
    let mut sheet = Sheet::new("Sheet1".to_string());
    sheet
        .cells
        .insert((1, 1), SavedCell::from_cell(&Cell::new_text("Hello".to_string())));
    sheet.cells.insert((1, 2), SavedCell::from_cell(&Cell::new_number(10.0)));
    sheet
        .cells
        .insert((2, 1), SavedCell::from_cell(&Cell::new_text("World".to_string())));
    sheet.cells.insert((2, 2), SavedCell::from_cell(&Cell::new_number(20.0)));
    sheet
        .cells
        .insert((3, 2), SavedCell::from_cell(&Cell::new_formula("C2+C3".to_string())));
    let mut wb = Workbook::default();
    wb.sheets = vec![sheet];
    wb
}

fn publish_and_pull(
    dir: &TempDir,
    prof: &Path,
    wb: &Workbook,
) -> calp::pull::PullResult {
    publish_and_pull_sheets(dir, prof, wb, vec![0])
}

fn publish_and_pull_sheets(
    dir: &TempDir,
    prof: &Path,
    wb: &Workbook,
    sheet_indices: Vec<usize>,
) -> calp::pull::PullResult {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let request = PublishRequest {
        workbook: wb,
        package_name: "literals".to_string(),
        version: SemVer::new(1, 0, 0),
        kind: "report".to_string(),
        mode: PushMode::CreateNew,
        change_summary: "first".to_string(),
        sheet_indices,
        now: "2026-08-30T00:00:00Z".to_string(),
        published_by: "author".to_string(),
        writeback_regions: None,
        model_writebacks: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: Vec::new(),
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        min_app_version: String::new(),
    };
    publish::publish(&reg, &request, prof).expect("publish failed");

    let scope = calp::workspace_scope(dir.path().to_str().unwrap()).unwrap();
    calp::pull::pull(
        &reg,
        &calp::pull::PullRequest {
            package_name: "literals".to_string(),
            target: calp::manifest::SubscriptionTarget::Line(VersionPin::Latest),
            now: "2026-08-30T01:00:00Z".to_string(),
        },
        &scope,
        prof,
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .expect("pull failed")
}

struct Harness {
    state: crate::AppState,
    pivot: crate::pivot::types::PivotState,
    bi: crate::bi::types::BiState,
    scripts: crate::scripting::types::ScriptState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
    pane: crate::pane_control::PaneControlState,
    slicer: crate::slicer::SlicerState,
    timeline: crate::timeline_slicer::TimelineSlicerState,
}

impl Harness {
    fn new() -> Self {
        Self {
            state: crate::create_app_state(),
            pivot: crate::pivot::types::PivotState::new(),
            bi: crate::bi::types::BiState::new(),
            scripts: crate::scripting::types::ScriptState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            slicer: crate::slicer::SlicerState::new(),
            timeline: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    fn materialize(&self, result: calp::pull::PullResult, mode: MaterializeMode) {
        self.materialize_response(result, mode);
    }

    fn materialize_response(
        &self,
        result: calp::pull::PullResult,
        mode: MaterializeMode,
    ) -> crate::calp_commands::PullResponse {
        let effect = crate::document_effect::DocumentEffect::mutates(
            &crate::persistence::FileState::default(),
        );
        materialize_pull_result(
            &self.state,
            &effect,
            &self.pivot,
            &self.bi,
            &self.scripts,
            &self.ribbon,
            &self.pane,
            &self.slicer,
            &self.timeline,
            result,
            mode,
            // No frontend to notify in a test — the point of the parameter
            // being optional.
            None,
        )
        .expect("materialization failed")
    }

    /// Empty the workbook the way `calp_checkout` does before materializing:
    /// the shared document reset blanks the mirror and sets active_sheet = 0,
    /// then checkout clears the placeholder sheet so the package lands at 0.
    fn empty_as_checkout_does(&self) {
        let effect = crate::document_effect::DocumentEffect::mutates(
            &crate::persistence::FileState::default(),
        );
        *self.state.grid.write(&effect).unwrap() = engine::grid::Grid::new();
        *self.state.active_sheet.write(&effect).unwrap() = 0;
        self.state.grids.write(&effect).unwrap().clear();
        self.state.sheet_names.write(&effect).unwrap().clear();
        self.state.sheet_ids.write(&effect).unwrap().clear();
        self.state.all_column_widths.write(&effect).unwrap().clear();
        self.state.all_row_heights.write(&effect).unwrap().clear();
    }
}

/// Cells of one grid that carry a value or a formula.
fn occupied(grid: &engine::grid::Grid) -> Vec<(u32, u32)> {
    let mut v: Vec<(u32, u32)> = grid.cells.keys().copied().collect();
    v.sort();
    v
}

#[test]
fn checking_out_a_package_keeps_its_literal_cells() {
    // THE reported bug. A checkout lands the package's first sheet on the
    // ACTIVE index with a freshly-blanked mirror, so this is where the desync
    // bites hardest.
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let wb = mixed_workbook();
    let pulled = publish_and_pull(&dir, prof.path(), &wb);

    let h = Harness::new();
    h.empty_as_checkout_does();
    h.materialize(pulled, MaterializeMode::Checkout);

    let grids = h.state.grids.read().unwrap();
    assert_eq!(grids.len(), 1, "the package's one sheet landed");
    assert_eq!(
        occupied(&grids[0]).len(),
        5,
        "four literals and one formula, not just the formula: {:?}",
        occupied(&grids[0])
    );
}

/// The invariant behind the bug, stated directly.
///
/// It is not enough for `grids[active]` to hold the literals: the next
/// recalculation REPLACES `grids[active]` with the mirror wholesale, so a
/// mirror that disagrees is a deletion waiting to happen — and it deletes
/// precisely the cells a recalculation never mirrors, i.e. the literals.
#[test]
fn the_active_sheet_mirror_agrees_with_the_sheet_it_mirrors() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let wb = mixed_workbook();
    let pulled = publish_and_pull(&dir, prof.path(), &wb);

    let h = Harness::new();
    h.empty_as_checkout_does();
    h.materialize(pulled, MaterializeMode::Checkout);

    let grids = h.state.grids.read().unwrap();
    let active = *h.state.active_sheet.read().unwrap();
    let mirror = h.state.grid.read().unwrap();

    assert_eq!(
        occupied(&mirror),
        occupied(&grids[active]),
        "state.grid must mirror grids[active] after materialization — otherwise \
         `run_calculation_pass` (grids[active] = grid.clone()) deletes whatever \
         the mirror is missing, and `recalculate_sheet_values` only ever puts \
         FORMULA cells into the mirror"
    );
    assert_eq!(occupied(&mirror).len(), 5, "and it is the full sheet, not the formulas alone");
}

/// The SUBSCRIBE sequence, end to end, including the sheet activation the
/// frontend performs afterwards.
///
/// Subscribe appends its sheets ABOVE the active one, so the materializer
/// deliberately leaves the mirror alone (see the test below for why). That
/// makes the repair depend entirely on `activate_sheet` doing a full
/// mirror <- grids[index] copy when the user is moved onto the pulled sheet.
///
/// This test exists because the bug was reported against "subscribe" while the
/// mechanism could only be PROVEN for checkout. Rather than assume the two
/// paths behave alike, exercise the real sequence and let it answer.
#[test]
fn subscribing_then_activating_the_pulled_sheet_lands_the_literals_in_the_mirror() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let wb = mixed_workbook();
    let pulled = publish_and_pull(&dir, prof.path(), &wb);

    // A freshly-started app: one blank sheet, active, mirrored.
    let h = Harness::new();
    let sheets_before = h.state.grids.read().unwrap().len();
    assert_eq!(sheets_before, 1, "a fresh workbook has exactly one sheet");
    assert_eq!(*h.state.active_sheet.read().unwrap(), 0);

    h.materialize(pulled, MaterializeMode::Subscribe);

    let pulled_index = {
        let grids = h.state.grids.read().unwrap();
        assert_eq!(grids.len(), 2, "the package's sheet was appended, not merged");
        grids.len() - 1
    };

    // What the frontend does next: move the user onto the pulled sheet.
    crate::sheets::activate_sheet(&h.state, pulled_index).expect("activation failed");

    let grids = h.state.grids.read().unwrap();
    let mirror = h.state.grid.read().unwrap();
    assert_eq!(
        *h.state.active_sheet.read().unwrap(),
        pulled_index,
        "the user is on the pulled sheet"
    );
    assert_eq!(
        occupied(&mirror),
        occupied(&grids[pulled_index]),
        "after activation the mirror must hold the pulled sheet in full — if it \
         holds less, the next recalculation copies that shortfall back over \
         grids[active] and the literals are gone"
    );
    assert_eq!(
        occupied(&mirror).len(),
        5,
        "four literals and one formula reached the mirror"
    );
}

/// The pull reports WHICH sheet to activate, by true state-vector index.
///
/// The subscribe dialog used to derive it as `sheets.length - sheetsPulled`,
/// which is arithmetic over the FILTERED sheet list — object-backed sheets (a
/// floating range's backing sheet) are omitted from it, and its builder says so
/// in as many words: "consumers must match by `s.index`, never by list
/// position." With one such sheet present the subtraction names the wrong
/// sheet, the pulled report never becomes active, and — since the active-sheet
/// mirror is only repaired BY an activation — the next recalculation copies the
/// stale mirror back over the pulled sheet. Same lost literals, second route.
#[test]
fn a_pull_reports_the_true_index_of_the_sheet_to_activate() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let wb = mixed_workbook();
    let pulled = publish_and_pull(&dir, prof.path(), &wb);

    let h = Harness::new();

    // Give the workbook an OBJECT-BACKED sheet, which the sheet list hides.
    // This is what makes list position and true index disagree.
    {
        let effect = crate::document_effect::DocumentEffect::mutates(
            &crate::persistence::FileState::default(),
        );
        h.state.grids.write(&effect).unwrap().push(engine::grid::Grid::new());
        h.state.sheet_names.write(&effect).unwrap().push("__float1".to_string());
        h.state
            .sheet_ids
            .write(&effect)
            .unwrap()
            .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        h.state.all_column_widths.write(&effect).unwrap().push(Default::default());
        h.state.all_row_heights.write(&effect).unwrap().push(Default::default());
        h.state
            .sheet_visibility
            .write(&effect)
            .unwrap()
            .push(crate::sheets::OBJECT_SHEET_VISIBILITY.to_string());
    }

    let response = {
        let effect = crate::document_effect::DocumentEffect::mutates(
            &crate::persistence::FileState::default(),
        );
        materialize_pull_result(
            &h.state,
            &effect,
            &h.pivot,
            &h.bi,
            &h.scripts,
            &h.ribbon,
            &h.pane,
            &h.slicer,
            &h.timeline,
            pulled,
            MaterializeMode::Subscribe,
            None,
        )
        .expect("materialization failed")
    };

    // CHANGED DELIBERATELY (M5). The pull used to APPEND the package's sheet
    // behind the object tail, leaving [Sheet1, __float1(object), pulled] with
    // the pulled sheet at true index 2. The partition repair now rotates it in
    // front of the tail, as add_sheet does for one sheet: the workbook is
    // [Sheet1, pulled, __float1(object)], and the answer is 1 -- which is ALSO
    // what the filtered list says, because a partitioned workbook's user sheets
    // sit at `sheets[i].index == i`. The index is still the backend's, never
    // list arithmetic.
    let reported = response
        .first_pulled_sheet_index
        .expect("a package with a user sheet reports one to activate");
    assert_eq!(
        reported, 1,
        "the pulled sheet's FINAL index, after it was rotated in front of the object tail"
    );

    let visibility = h.state.sheet_visibility.read().unwrap();
    assert!(
        crate::sheets::is_user_sheet(&visibility, reported),
        "and it must be a sheet the user can actually see"
    );
    assert_eq!(
        visibility.get(2).map(String::as_str),
        Some(crate::sheets::OBJECT_SHEET_VISIBILITY),
        "the object sheet moved to the tail -- the user sheets are a contiguous prefix"
    );
    assert_eq!(h.state.sheet_names.read().unwrap()[2], "__float1");

    // The end-to-end consequence: activating what was reported puts the pulled
    // content in the mirror. Activating the list-derived index would not.
    drop(visibility);
    crate::sheets::activate_sheet(&h.state, reported).expect("activation failed");
    let mirror = h.state.grid.read().unwrap();
    assert_eq!(
        occupied(&mirror).len(),
        5,
        "the pulled sheet's literals and formula reached the mirror"
    );
}

/// An application whose OWN first sheet is hidden lands the user on the next
/// one, not on a sheet `activate_sheet` refuses.
///
/// THE ORDERING DEFECT THIS PINS. The landing computation used to run inside the
/// grid-lock scope, 30 lines BEFORE `materialize_pulled_sheet_state` — the only
/// code that extends `sheet_visibility` for the appended sheets. Every probed
/// index was therefore past the end of that vector; `is_user_sheet` reads a
/// missing slot as `unwrap_or(true)`, so `find` returned `base_index`
/// unconditionally and the filter could not skip anything at all.
///
/// The user-visible half: `PublishedSheetMetadata` carries visibility and the
/// pull restores it verbatim, so an application CAN begin with a hidden sheet.
/// `activate_sheet` refuses one by name, and both call sites swallow that into a
/// `console.warn` — the dialog closed, the tabs appeared, and the user was left
/// on their own sheet with nothing said.
///
/// SABOTAGE: move the computation back above `materialize_pulled_sheet_state`,
/// or drop the `sheet_is_visible` half of the predicate.
#[test]
fn a_hidden_first_sheet_is_not_the_sheet_the_pull_lands_on() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();

    // [Raw (hidden), Dashboard] — the shape a publisher gets by hiding their
    // working data before publishing the report that reads it.
    let mut wb = mixed_workbook();
    wb.sheets[0].name = "Raw".to_string();
    wb.sheets[0].visibility = "hidden".to_string();
    let mut dashboard = Sheet::new("Dashboard".to_string());
    dashboard
        .cells
        .insert((1, 1), SavedCell::from_cell(&Cell::new_number(42.0)));
    wb.sheets.push(dashboard);

    let pulled = publish_and_pull_sheets(&dir, &prof.path(), &wb, vec![0, 1]);
    assert_eq!(pulled.sheets.len(), 2, "both sheets published");
    assert_eq!(
        pulled.sheets[0].sheet.visibility, "hidden",
        "the pull restores the publisher's visibility verbatim — without this \
         the test is measuring nothing"
    );

    let h = Harness::new();
    let response = {
        let effect = crate::document_effect::DocumentEffect::mutates(
            &crate::persistence::FileState::default(),
        );
        materialize_pull_result(
            &h.state,
            &effect,
            &h.pivot,
            &h.bi,
            &h.scripts,
            &h.ribbon,
            &h.pane,
            &h.slicer,
            &h.timeline,
            pulled,
            MaterializeMode::Subscribe,
            None,
        )
        .expect("materialization failed")
    };

    // Workbook is [Sheet1, Raw(hidden), Dashboard]. base_index is 1, and 1 is
    // the answer the broken ordering gave every time.
    let reported = response
        .first_pulled_sheet_index
        .expect("the application has a landable sheet");
    assert_eq!(
        reported, 2,
        "the hidden first sheet is skipped; landing on it is a refusal the \
         frontend swallows"
    );

    // The end-to-end consequence, and the only assertion that could not be
    // satisfied by arithmetic: activating what was reported must SUCCEED.
    crate::sheets::activate_sheet(&h.state, reported)
        .expect("the reported landing sheet must be one activate_sheet accepts");
    assert!(
        crate::sheets::activate_sheet(&h.state, 1).is_err(),
        "and the sheet it skipped must be one activate_sheet refuses — \
         otherwise this test proves nothing about the skip"
    );
}

/// An application with NOTHING landable reports `None` rather than a sheet the
/// caller cannot activate.
///
/// SABOTAGE: `.find(...)` -> `.next()`, i.e. drop the predicate entirely.
#[test]
fn an_application_of_only_hidden_sheets_reports_no_landing_at_all() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();

    let mut wb = mixed_workbook();
    wb.sheets[0].name = "Raw".to_string();
    wb.sheets[0].visibility = "hidden".to_string();

    let pulled = publish_and_pull_sheets(&dir, &prof.path(), &wb, vec![0]);

    let h = Harness::new();
    let response = {
        let effect = crate::document_effect::DocumentEffect::mutates(
            &crate::persistence::FileState::default(),
        );
        materialize_pull_result(
            &h.state,
            &effect,
            &h.pivot,
            &h.bi,
            &h.scripts,
            &h.ribbon,
            &h.pane,
            &h.slicer,
            &h.timeline,
            pulled,
            MaterializeMode::Subscribe,
            None,
        )
        .expect("materialization failed")
    };

    assert_eq!(
        response.first_pulled_sheet_index, None,
        "no landable sheet means no landing — reporting one the caller cannot \
         activate is how the refusal ended up in a console.warn"
    );
}

/// The other half of the guard: a subscribe APPENDS its sheets above the active
/// one, and must NOT touch the mirror.
///
/// `grids[active]` may legitimately lag behind the mirror (BUG-0016), so an
/// unconditional grids -> mirror copy would discard the user's unsaved edits on
/// whatever sheet they were looking at. Fixing the desync must not introduce
/// that.
#[test]
fn subscribing_does_not_clobber_the_mirror_of_a_sheet_it_did_not_create() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let wb = mixed_workbook();
    let pulled = publish_and_pull(&dir, prof.path(), &wb);

    let h = Harness::new();
    // The user is on sheet 0 with an edit that lives only in the mirror — the
    // legitimate lag the guard exists to protect.
    let effect = crate::document_effect::DocumentEffect::mutates(
        &crate::persistence::FileState::default(),
    );
    {
        let mut mirror = h.state.grid.write(&effect).unwrap();
        mirror.set_cell(0, 0, Cell::new_text("unsaved edit".to_string()));
    }
    let active_before = *h.state.active_sheet.read().unwrap();
    assert_eq!(active_before, 0);

    h.materialize(pulled, MaterializeMode::Subscribe);

    let mirror = h.state.grid.read().unwrap();
    let survived = mirror.get_cell(0, 0).is_some();
    assert!(
        survived,
        "a subscribe appends sheets ABOVE the active one and must leave the \
         active sheet's mirror alone — copying grids[active] over it would \
         discard exactly the edits the mirror exists to hold"
    );
}

// ===========================================================================
// M5 — every object on a canvas travels: charts, floating ranges, timelines,
// controls and their scripts, through subscribe, checkout and refresh.
// ===========================================================================

fn new_entity() -> identity::EntityId {
    identity::EntityId::from_bytes(identity::generate_uuid_v7())
}

fn new_sheet_id() -> identity::SheetId {
    identity::SheetId::from_bytes(identity::generate_uuid_v7())
}

fn test_effect() -> crate::document_effect::DocumentEffect {
    crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())
}

/// Publish `sheet_indices` of `wb` as "literals" v1.0.0 without pulling.
fn publish_sheets(dir: &TempDir, prof: &Path, wb: &Workbook, sheet_indices: Vec<usize>) {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let request = PublishRequest {
        workbook: wb,
        package_name: "literals".to_string(),
        version: SemVer::new(1, 0, 0),
        kind: "report".to_string(),
        mode: PushMode::CreateNew,
        change_summary: "first".to_string(),
        sheet_indices,
        now: "2026-09-25T00:00:00Z".to_string(),
        published_by: "author".to_string(),
        writeback_regions: None,
        model_writebacks: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: Vec::new(),
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        min_app_version: String::new(),
    };
    publish::publish(&reg, &request, prof).expect("publish failed");
}

/// The SUBSCRIBE pull (fresh local sheet ids).
fn subscribe_pull(dir: &TempDir, prof: &Path) -> calp::pull::PullResult {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let scope = calp::workspace_scope(dir.path().to_str().unwrap()).unwrap();
    calp::pull::pull(
        &reg,
        &calp::pull::PullRequest {
            package_name: "literals".to_string(),
            target: calp::manifest::SubscriptionTarget::Line(VersionPin::Latest),
            now: "2026-09-25T01:00:00Z".to_string(),
        },
        &scope,
        prof,
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .expect("pull failed")
}

/// The CHECKOUT pull (the application's own sheet ids).
fn checkout_pull(dir: &TempDir, prof: &Path) -> calp::pull::PullResult {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let scope = calp::workspace_scope(dir.path().to_str().unwrap()).unwrap();
    calp::checkout::checkout(&reg, "literals", None, "2026-09-25T01:00:00Z", &scope, prof)
        .expect("checkout failed")
}

/// A chart ENVELOPE (as the chart store writes it) on `host`, whose data source
/// names `source` by id and by index.
fn chart_reading(
    host: identity::SheetId,
    source: identity::SheetId,
    source_index: usize,
    name: &str,
) -> persistence::SavedChart {
    persistence::SavedChart {
        id: new_entity(),
        sheet_id: host,
        spec_json: serde_json::json!({
            "chartId": 1,
            "name": name,
            "sheetIndex": 0,
            "spec": {
                "mark": "bar",
                "data": {
                    "sheetIndex": source_index,
                    "sheetId": source.to_string(),
                    "startRow": 0, "startCol": 0, "endRow": 4, "endCol": 1
                }
            }
        })
        .to_string(),
    }
}

/// `(spec.data.sheetId, spec.data.sheetIndex)` of a chart envelope.
fn spec_data_ref(spec_json: &str) -> (String, u64) {
    let v: serde_json::Value = serde_json::from_str(spec_json).unwrap();
    (
        v["spec"]["data"]["sheetId"].as_str().unwrap_or_default().to_string(),
        v["spec"]["data"]["sheetIndex"].as_u64().unwrap_or(u64::MAX),
    )
}

/// ["Dashboard" (a chart reading Data), "Data"].
fn dashboard_and_data() -> Workbook {
    let dashboard = Sheet::new("Dashboard".to_string());
    let mut data = Sheet::new("Data".to_string());
    for r in 0..5u32 {
        data.cells.insert((r, 0), SavedCell::from_cell(&Cell::new_number(f64::from(r))));
    }
    let mut wb = Workbook::default();
    wb.sheets = vec![dashboard, data];
    let (host, source) = (wb.sheets[0].id, wb.sheets[1].id);
    wb.charts = vec![chart_reading(host, source, 1, "Revenue")];
    wb
}

/// SUBSCRIBE: the pulled chart must read the PULLED "Data", which collided with
/// the subscriber's own "Data" and arrived as "Data (2)".
///
/// Before M5 the spec went through verbatim, still naming the PUBLISHER's
/// sheet id -- a sheet that exists nowhere in the subscriber's workbook -- so
/// every subscribed chart said its source sheet no longer exists. (And a
/// name-bound reading would have found the subscriber's OWN "Data", which is
/// worse: wrong numbers with no error.)
///
/// SABOTAGE: drop the `remap_chart_spec_sheet_ids` call in the subscribe chart
/// block.
#[test]
fn a_subscribed_chart_reads_the_pulled_sheet_not_the_publishers_or_the_subscribers_own() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let wb = dashboard_and_data();
    let publisher_data = wb.sheets[1].id;
    publish_sheets(&dir, prof.path(), &wb, vec![0, 1]);
    let pulled = subscribe_pull(&dir, prof.path());

    let h = Harness::new();
    h.state.sheet_names.write(&test_effect()).unwrap()[0] = "Data".to_string();
    let own_data = h.state.sheet_ids.read().unwrap()[0];

    h.materialize(pulled, MaterializeMode::Subscribe);

    let names = h.state.sheet_names.read().unwrap().clone();
    let ids = h.state.sheet_ids.read().unwrap().clone();
    let pulled_data = names
        .iter()
        .position(|n| n == "Data (2)")
        .expect("the pulled Data collided with the subscriber's own and was renamed");
    let dashboard = names.iter().position(|n| n == "Dashboard").unwrap();

    let charts = h.state.charts.read().unwrap();
    assert_eq!(charts.len(), 1, "the chart landed");
    assert_eq!(charts[0].sheet_index, dashboard, "on the pulled Dashboard");
    let (source_id, source_index) = spec_data_ref(&charts[0].spec_json);
    assert_ne!(source_id, publisher_data.to_string(), "not the PUBLISHER's sheet id");
    assert_ne!(source_id, own_data.to_string(), "not the subscriber's OWN Data");
    assert_eq!(source_id, ids[pulled_data].to_string(), "the pulled \"Data (2)\"");
    assert_eq!(source_index as usize, pulled_data, "and its index agrees with its id");
}

/// CHECKOUT preserves the application's sheet ids, so the chart's refs already
/// name sheets the working copy has -- and the spec must come through
/// BYTE-identical: a rewrite would re-serialize it with reordered keys and put
/// a chart nobody edited into the next push's diff.
///
/// SABOTAGE: run the remap in `MaterializeMode::Checkout` too.
#[test]
fn a_checked_out_chart_keeps_its_spec_bytes() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let wb = dashboard_and_data();
    let application_data = wb.sheets[1].id;
    publish_sheets(&dir, prof.path(), &wb, vec![0, 1]);
    let checked_out = checkout_pull(&dir, prof.path());
    let published_spec = checked_out.charts[0].spec_json.clone();

    let h = Harness::new();
    h.materialize(checked_out, MaterializeMode::Checkout);

    let charts = h.state.charts.read().unwrap();
    assert_eq!(charts.len(), 1);
    assert_eq!(charts[0].spec_json, published_spec, "byte-identical on checkout");
    let (source_id, _) = spec_data_ref(&charts[0].spec_json);
    assert_eq!(source_id, application_data.to_string());
    assert!(
        h.state.sheet_ids.read().unwrap().contains(&application_data),
        "and the id it names is a sheet the working copy has"
    );
}

/// REFRESH: charts land on the OLD local sheet of their application sheet --
/// including a sheet coming back from a tombstone, which the old index map
/// dropped (with its charts, CF/DV and names) because it only looked in
/// `sub.sheets`. The chart's data source follows the same map, and the fresh ids
/// the refresh pull minted appear nowhere.
///
/// SABOTAGE: drop the `upstream_removed_sheets` arm of `refresh_local_sheet_id`.
#[test]
fn a_refreshed_chart_lands_on_the_old_local_sheet_including_a_returning_one() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut wb = dashboard_and_data();
    let (dashboard_pkg, data_pkg) = (wb.sheets[0].id, wb.sheets[1].id);
    // A second chart, ON the returning sheet.
    wb.charts.push(chart_reading(data_pkg, data_pkg, 1, "Inline"));
    publish_sheets(&dir, prof.path(), &wb, vec![0, 1]);
    let pulled = subscribe_pull(&dir, prof.path());
    let fresh_ids: Vec<String> = pulled.sheets.iter().map(|p| p.sheet.id.to_string()).collect();

    // The subscriber's view BEFORE this refresh: Dashboard tracked under its
    // old local id, Data dropped by an earlier version (a tombstone).
    let (old_dashboard, old_data) = (new_sheet_id(), new_sheet_id());
    let mut sub = pulled.subscription.clone();
    for s in sub.sheets.iter_mut() {
        if s.package_sheet_id == dashboard_pkg {
            s.local_sheet_id = old_dashboard;
        }
    }
    sub.sheets.retain(|s| s.package_sheet_id != data_pkg);
    sub.upstream_removed_sheets.push(calp::manifest::UpstreamRemovedSheet {
        package_sheet_id: data_pkg,
        local_sheet_id: old_data,
        local_name: "Data".to_string(),
        removed_at_version: String::new(),
        extra: std::collections::HashMap::new(),
    });
    let (owned_v1, mine) = (new_entity(), new_entity());
    sub.objects.push(calp::manifest::SubscribedObject {
        kind: "chart".to_string(),
        id: owned_v1.to_string(),
        name: String::new(),
        extra: std::collections::HashMap::new(),
    });
    let mut charts = vec![
        crate::api_types::ChartEntry { id: owned_v1, sheet_index: 0, spec_json: "{}".to_string() },
        crate::api_types::ChartEntry { id: mine, sheet_index: 0, spec_json: "{}".to_string() },
    ];
    // The workbook: [Mine, Data (old), Dashboard (old)].
    let sheet_ids = vec![new_sheet_id(), old_data, old_dashboard];
    let mut entries = Vec::new();

    crate::calp_commands::apply_refreshed_charts(&mut charts, &sub, &pulled, &sheet_ids, &mut entries);

    assert!(!charts.iter().any(|c| c.id == owned_v1), "the application's v1 chart was replaced");
    assert!(charts.iter().any(|c| c.id == mine), "the subscriber's own chart was never touched");
    assert_eq!(charts.len(), 3, "mine + the two v2 charts: {charts:?}");
    let revenue = charts.iter().find(|c| c.id == wb.charts[0].id).expect("Revenue landed");
    let inline = charts
        .iter()
        .find(|c| c.id == wb.charts[1].id)
        .expect("the chart on the RETURNING sheet landed -- the tombstone arm");
    assert_eq!(revenue.sheet_index, 2, "on the OLD Dashboard");
    assert_eq!(inline.sheet_index, 1, "on the OLD Data, where the returner was replaced in place");
    for chart in [revenue, inline] {
        let (source_id, source_index) = spec_data_ref(&chart.spec_json);
        assert_eq!(source_id, old_data.to_string(), "the source is the OLD local Data");
        assert_eq!(source_index, 1);
        assert!(!fresh_ids.contains(&source_id), "never the fresh id the refresh pull minted");
    }
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().all(|e| e.kind == "chart"));
}

/// ["Dashboard", "Float1" (object)] with one floating range hosted on
/// Dashboard; the backing sheet has a formula that reads Dashboard!A1.
fn workbook_with_floating_range() -> (Workbook, identity::EntityId) {
    let mut dashboard = Sheet::new("Dashboard".to_string());
    dashboard
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_number(21.0)));
    let mut backing = Sheet::new("Float1".to_string());
    backing.visibility = crate::sheets::OBJECT_SHEET_VISIBILITY.to_string();
    backing
        .cells
        .insert((0, 1), SavedCell::from_cell(&Cell::new_formula("Dashboard!A1*2".to_string())));
    let mut wb = Workbook::default();
    wb.sheets = vec![dashboard, backing];
    let id = new_entity();
    wb.floating_ranges = vec![persistence::SavedFloatingRange {
        id,
        backing_sheet_id: wb.sheets[1].id,
        host_sheet_id: wb.sheets[0].id,
        x: 120.0,
        y: 48.0,
        rotation: 0.0,
        pin_to_grid: false,
        row_count: 4,
        col_count: 2,
        col_widths: [(0u32, 140.0)].into_iter().collect(),
        row_heights: std::collections::HashMap::new(),
        show_title: false,
        show_column_headers: true,
        show_row_headers: false,
    }];
    (wb, id)
}

/// A pulled floating range's row binds BOTH of its sheets to the LOCAL sheets
/// they landed on (pull keeps application ids; only the host knows the final
/// ones), records a `floatingRange` ledger entry, and its backing sheet's
/// formulas get their cross-sheet edges -- the backing sheet is never active,
/// so nothing else would ever install them.
///
/// SABOTAGE: skip `materialize_pulled_floating_ranges` in the materializer.
#[test]
fn a_pulled_floating_range_binds_host_and_backing_to_the_local_sheets() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let (wb, fr_id) = workbook_with_floating_range();
    let (publisher_host, publisher_backing) = (wb.sheets[0].id, wb.sheets[1].id);
    publish_sheets(&dir, prof.path(), &wb, vec![0, 1]);
    let pulled = subscribe_pull(&dir, prof.path());
    assert_eq!(pulled.floating_ranges.len(), 1, "precondition: the row travelled");

    let h = Harness::new();
    h.materialize(pulled, MaterializeMode::Subscribe);

    let names = h.state.sheet_names.read().unwrap().clone();
    let ids = h.state.sheet_ids.read().unwrap().clone();
    let host = names.iter().position(|n| n == "Dashboard").unwrap();
    let backing = names.iter().position(|n| n == "Float1").unwrap();
    assert_eq!(backing, names.len() - 1, "the backing sheet sits at the object tail");

    let rows = h.state.floating_ranges.read().unwrap().clone();
    let row = rows.iter().find(|fr| fr.id == fr_id).expect("the floating range landed");
    assert_eq!(row.host_sheet_id, ids[host], "host bound to the LOCAL Dashboard");
    assert_eq!(row.backing_sheet_id, ids[backing], "backing bound to the LOCAL Float1");
    assert_ne!(row.host_sheet_id, publisher_host);
    assert_ne!(row.backing_sheet_id, publisher_backing);
    assert_eq!((row.x, row.y, row.row_count, row.col_count), (120.0, 48.0, 4, 2));
    assert_eq!(
        h.state.sheet_visibility.read().unwrap()[backing],
        crate::sheets::OBJECT_SHEET_VISIBILITY
    );

    let subs = h.state.subscriptions.read().unwrap();
    let entry = subs.subscriptions[0]
        .objects
        .iter()
        .find(|o| o.kind == "floatingRange")
        .expect("the subscription records the floating range it owns");
    assert_eq!(entry.id, fr_id.to_string());
    assert_eq!(entry.name, "Float1");

    let dependents = h.state.cross_sheet_dependents.lock().unwrap();
    assert!(
        dependents.values().any(|cells| cells.contains(&(backing, 0, 1))),
        "the backing sheet's formula is registered as a dependent of Dashboard!A1 -- \
         without it the floating range never recalculates"
    );
}

/// Refresh's floating-range REPLACE maps both ids to the OLD local sheets
/// (whatever `resolve` answers), removes only the rows the subscription owns,
/// and never clobbers a row the workbook already has.
#[test]
fn a_refreshed_floating_range_replaces_only_the_owned_row_on_the_old_sheets() {
    let h = Harness::new();
    let effect = test_effect();
    let (host_pkg, backing_pkg) = (new_sheet_id(), new_sheet_id());
    let (old_host, old_backing) = (new_sheet_id(), new_sheet_id());
    {
        let mut ids = h.state.sheet_ids.write(&effect).unwrap();
        ids.push(old_host);
        ids.push(old_backing);
        h.state.sheet_names.write(&effect).unwrap().extend(["Host".to_string(), "Float1".to_string()]);
        // Host a user sheet, the backing an OBJECT sheet: the structure every
        // materialized row is checked against.
        *h.state.sheet_visibility.write(&effect).unwrap() = vec![
            "visible".to_string(),
            "visible".to_string(),
            crate::sheets::OBJECT_SHEET_VISIBILITY.to_string(),
        ];
    }
    let owned_v1 = crate::persistence::saved_floating_range_to_row(&persistence::SavedFloatingRange {
        id: new_entity(),
        backing_sheet_id: old_backing,
        host_sheet_id: old_host,
        x: 0.0,
        y: 0.0,
        rotation: 0.0,
        pin_to_grid: false,
        row_count: 1,
        col_count: 1,
        col_widths: Default::default(),
        row_heights: Default::default(),
        show_title: true,
        show_column_headers: true,
        show_row_headers: true,
    });
    let owned_v1_id = owned_v1.id;
    h.state.floating_ranges.write(&effect).unwrap().push(owned_v1);

    let v2 = persistence::SavedFloatingRange {
        id: new_entity(),
        backing_sheet_id: backing_pkg,
        host_sheet_id: host_pkg,
        x: 9.0,
        y: 8.0,
        rotation: 0.0,
        pin_to_grid: false,
        row_count: 3,
        col_count: 3,
        col_widths: Default::default(),
        row_heights: Default::default(),
        show_title: true,
        show_column_headers: true,
        show_row_headers: true,
    };
    let owned: std::collections::HashSet<String> = [owned_v1_id.to_string()].into_iter().collect();
    let resolve = |sid: identity::SheetId| {
        if sid == host_pkg {
            Some(1)
        } else if sid == backing_pkg {
            Some(2)
        } else {
            None
        }
    };
    let applied = crate::calp_commands::replace_refreshed_floating_ranges(
        &effect,
        &h.state,
        &owned,
        std::slice::from_ref(&v2),
        resolve,
    )
    .unwrap();
    assert_eq!(applied, vec![(v2.id.to_string(), "Float1".to_string())]);
    let rows = h.state.floating_ranges.read().unwrap().clone();
    assert_eq!(rows.len(), 1, "v1's owned row was replaced, not kept beside v2");
    assert_eq!(rows[0].id, v2.id);
    assert_eq!((rows[0].host_sheet_id, rows[0].backing_sheet_id), (old_host, old_backing));
}

/// A pulled TIMELINE slicer lands on the pulled sheet, with a ledger entry --
/// the coverage table claimed timelines were CARRIED long before anything in
/// the collaboration path read or wrote one.
///
/// SABOTAGE: skip `materialize_pulled_timeline_slicers` in the materializer.
#[test]
fn a_pulled_timeline_lands_on_the_pulled_sheet() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    let pivot = persistence::SavedPivotDefinition {
        id: new_entity(),
        source_type: "grid".to_string(),
        source_sheet_index: None,
        definition: serde_json::json!({ "name": "ByMonth", "destination_sheet": "Dashboard" }),
    };
    let timeline_id = new_entity();
    wb.timeline_slicers = vec![persistence::SavedTimelineSlicer {
        id: timeline_id,
        name: "Dates".to_string(),
        header_text: None,
        sheet_id: wb.sheets[0].id,
        x: 30.0,
        y: 400.0,
        width: 520.0,
        height: 130.0,
        source_type: persistence::SavedTimelineSourceType::Pivot,
        source_id: pivot.id,
        field_name: "OrderDate".to_string(),
        level: persistence::SavedTimelineLevel::Months,
        selection_start: Some("2026-02-01".to_string()),
        selection_end: None,
        show_header: true,
        show_level_selector: true,
        show_scrollbar: false,
        style_preset: "TimelineStyleLight1".to_string(),
        connected_pivot_ids: Vec::new(),
    }];
    wb.pivot_definitions = vec![pivot.clone()];
    publish_sheets(&dir, prof.path(), &wb, vec![0]);
    let pulled = subscribe_pull(&dir, prof.path());
    assert_eq!(pulled.timeline_slicers.len(), 1, "precondition: the timeline travelled");

    let h = Harness::new();
    h.materialize(pulled, MaterializeMode::Subscribe);

    let dashboard = h
        .state
        .sheet_names
        .read()
        .unwrap()
        .iter()
        .position(|n| n == "Dashboard")
        .unwrap();
    assert_eq!(dashboard, 1, "the pulled sheet sits after the subscriber's own");
    let timelines = h.timeline.timelines.read().unwrap();
    let timeline = timelines.get(&timeline_id).expect("the timeline landed");
    assert_eq!(timeline.sheet_index, dashboard, "on the PULLED sheet, not the subscriber's");
    assert_eq!((timeline.x, timeline.y), (30.0, 400.0));
    assert_eq!(timeline.source_id, pivot.id, "still bound to the application pivot's id");
    assert_eq!(timeline.selection_start.as_deref(), Some("2026-02-01"));
    let subs = h.state.subscriptions.read().unwrap();
    assert!(subs.subscriptions[0]
        .objects
        .iter()
        .any(|o| o.kind == "timelineSlicer" && o.id == timeline_id.to_string()));
}

/// A PULL INTO A WORKBOOK THAT ALREADY HAS A FLOATING RANGE. The pulled sheets
/// used to be appended BEHIND the subscriber's object tail, leaving
/// [Sheet1, Float1(object), North, South]: 3D ranges spanned the backing sheet
/// and every positional consumer of the filtered sheet list drifted. They are
/// now rotated in front of it, and the object sheet's own stores follow it to
/// its new index.
///
/// SABOTAGE: skip the `restore_partition_invariant` call in the materializer.
#[test]
fn a_pull_behind_an_object_tail_keeps_the_user_prefix_contiguous() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut north = Sheet::new("North".to_string());
    north.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(1.0)));
    let mut south = Sheet::new("South".to_string());
    south.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(2.0)));
    let mut wb = Workbook::default();
    wb.sheets = vec![north, south];
    publish_sheets(&dir, prof.path(), &wb, vec![0, 1]);
    let pulled = subscribe_pull(&dir, prof.path());

    let h = Harness::new();
    let own = crate::floating_range::create_floating_range_inner(
        &h.state,
        &crate::persistence::FileState::default(),
        None,
        10.0,
        10.0,
    )
    .expect("the subscriber's own floating range");
    assert_eq!(own.backing_sheet_index, 1, "precondition: its backing sheet is index 1");
    // Stores keyed by the object sheet's INDEX, which the rotation renumbers.
    let effect = test_effect();
    h.state.conditional_formats.write(&effect).unwrap().insert(1, Vec::new());
    {
        let mut sheet_notes = std::collections::HashMap::new();
        sheet_notes.insert(
            (0u32, 0u32),
            crate::notes::Note {
                id: "n1".to_string(),
                row: 0,
                col: 0,
                sheet_index: 1,
                author_name: "me".to_string(),
                content: "on the backing sheet".to_string(),
                rich_content: None,
                width: 200.0,
                height: 100.0,
                visible: false,
                created_at: "2026-09-25T00:00:00Z".to_string(),
                modified_at: None,
            },
        );
        h.state.notes.write(&effect).unwrap().insert(1, sheet_notes);
    }
    {
        let mut set = rustc_hash::FxHashSet::default();
        set.insert((1usize, 0u32, 0u32));
        h.state
            .cross_sheet_dependents
            .lock()
            .unwrap()
            .insert(("Sheet1".to_string(), 0, 0), set);
    }

    let response = h.materialize_response(pulled, MaterializeMode::Subscribe);

    let names = h.state.sheet_names.read().unwrap().clone();
    assert_eq!(names, vec!["Sheet1", "North", "South", "Float1"], "user sheets first, object tail last");
    let visibility = h.state.sheet_visibility.read().unwrap().clone();
    assert_eq!(visibility[3], crate::sheets::OBJECT_SHEET_VISIBILITY);
    assert!((0..3).all(|i| crate::sheets::is_user_sheet(&visibility, i)));
    assert_eq!(response.first_pulled_sheet_index, Some(1), "the FINAL index of North");
    // The grids moved WITH their names.
    {
        let grids = h.state.grids.read().unwrap();
        assert!(grids[1].get_cell(0, 0).is_some() && grids[2].get_cell(0, 0).is_some());
        assert!(grids[3].cells.is_empty(), "the (empty) backing grid moved to the tail");
    }
    // The subscriber's own floating range still resolves -- by id, to the tail.
    assert_eq!(h.state.sheet_ids.read().unwrap()[3], own.range.backing_sheet_id);
    assert_eq!(
        crate::floating_range::sheet_index_of(&h.state, own.range.backing_sheet_id),
        Some(3)
    );
    // ...and its index-keyed stores followed it.
    let cf = h.state.conditional_formats.read().unwrap();
    assert!(cf.contains_key(&3) && !cf.contains_key(&1), "CF followed the object sheet");
    let notes = h.state.notes.read().unwrap();
    let moved = notes.get(&3).and_then(|n| n.get(&(0, 0))).expect("the note followed");
    assert_eq!(moved.sheet_index, 3, "and was re-stamped");
    assert!(!notes.contains_key(&1), "North carries no note it never had");
    let dependents = h.state.cross_sheet_dependents.lock().unwrap();
    let set = dependents.get(&("Sheet1".to_string(), 0, 0)).unwrap();
    assert!(set.contains(&(3, 0, 0)) && !set.contains(&(1, 0, 0)), "the edge followed: {set:?}");
}

/// A pulled CANVAS arrives as a canvas: its kind and display flags land (both
/// were written by the materializer and neither was tested), its free-floating
/// button keeps x/y and `pinToGrid: "false"`, and the button's click script is
/// bound to the button where it LANDED -- not to the publisher's sheet index.
///
/// SABOTAGE: drop `rebind_pulled_control_script` from the subscribe script
/// block.
#[test]
fn a_pulled_canvas_arrives_as_a_canvas_with_its_controls_and_their_script() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let scratch = Sheet::new("Scratch".to_string()); // index 0, NOT published
    let mut canvas = Sheet::new("Report".to_string());
    canvas.kind = persistence::SheetKind::new_canvas();
    canvas.display_headings = false;
    canvas.show_gridlines = false;
    canvas.display_zeros = false;
    let mut wb = Workbook::default();
    wb.sheets = vec![scratch, canvas];
    let canvas_id = wb.sheets[1].id;
    let static_prop = |v: &str| serde_json::json!({ "valueType": "static", "value": v });
    wb.controls = vec![persistence::SavedSheetControls {
        sheet_id: canvas_id,
        controls: serde_json::json!([{
            "row": 5,
            "col": 2,
            "controlType": "button",
            "properties": {
                "x": static_prop("140"),
                "y": static_prop("260"),
                "pinToGrid": static_prop("false"),
                "text": static_prop("Go")
            }
        }]),
    }];
    // The button's click script, bound the way the frontend binds it: by the
    // AUTHOR's workbook index (1).
    wb.object_scripts = vec![persistence::SavedObjectScript {
        id: "script-go".to_string(),
        name: "Go".to_string(),
        object_type: persistence::ScriptableObjectType::Button,
        instance_id: Some("control-1-5-2".to_string()),
        source: "export function onClick() {}".to_string(),
        access_level: Default::default(),
        description: None,
        provenance: Default::default(),
        package_name: None,
        package_version: None,
        declared_capabilities: Vec::new(),
    }];
    // What the host's publish assembly does before core publish sees it.
    crate::calp_commands::canonicalize_control_bindings(&mut wb.object_scripts, &[1]);
    assert_eq!(
        wb.object_scripts[0].instance_id.as_deref(),
        Some("control-0-5-2"),
        "canonical: the canvas is the application's FIRST sheet"
    );
    publish_sheets(&dir, prof.path(), &wb, vec![1]);
    let pulled = subscribe_pull(&dir, prof.path());

    // A subscriber with three sheets, so the canvas lands at an index that is
    // neither the publisher's (1) nor the application position (0).
    let h = Harness::new();
    let file = crate::persistence::FileState::default();
    crate::sheets::add_sheet_inner(&h.state, &file, None, persistence::SheetKind::Worksheet).unwrap();
    crate::sheets::add_sheet_inner(&h.state, &file, None, persistence::SheetKind::Worksheet).unwrap();
    h.materialize(pulled, MaterializeMode::Subscribe);

    let landed = h
        .state
        .sheet_names
        .read()
        .unwrap()
        .iter()
        .position(|n| n == "Report")
        .unwrap();
    assert_eq!(landed, 3);
    assert!(h.state.sheet_kinds.read().unwrap()[landed].is_canvas(), "it arrives as a canvas");
    {
        let flags = h.state.sheet_display_flags.read().unwrap();
        assert!(!flags[landed].display_headings, "display flags land");
        assert!(!flags[landed].display_zeros);
        assert!(!h.state.show_gridlines.read().unwrap()[landed]);
    }
    {
        let controls = h.state.controls.read().unwrap();
        let button = controls.get(&(landed, 5, 2)).expect("the button landed on the canvas");
        assert_eq!(button.properties["x"].value, "140");
        assert_eq!(button.properties["y"].value, "260");
        assert_eq!(button.properties["pinToGrid"].value, "false", "still free-floating");
    }
    let scripts = h.state.object_scripts.read().unwrap();
    let script = scripts.iter().find(|s| s.id == "script-go").expect("the script landed");
    assert_eq!(
        script.instance_id.as_deref(),
        Some("control-3-5-2"),
        "bound to the button where it LANDED"
    );
}

/// The transparency report says what travels: a canvas is a report page, a
/// floating range is now an INCLUDED object (its "does not distribute yet"
/// exclusion line is gone), timelines are counted the way core publish selects
/// them (only those whose pivot travels), and the sheets the selection ADDED
/// for an object's source are named.
#[test]
fn the_publish_report_counts_canvases_timelines_and_floating_ranges_as_included() {
    let (mut wb, _) = workbook_with_floating_range(); // Dashboard(0), Float1(1, object)
    let mut canvas = Sheet::new("Report".to_string());
    canvas.kind = persistence::SheetKind::new_canvas();
    wb.sheets.push(canvas); // 2
    let dashboard = wb.sheets[0].id;
    let carried_pivot = persistence::SavedPivotDefinition {
        id: new_entity(),
        source_type: "grid".to_string(),
        source_sheet_index: None,
        definition: serde_json::json!({ "name": "ByMonth", "destination_sheet": "Dashboard" }),
    };
    let timeline = |source_id: identity::EntityId| persistence::SavedTimelineSlicer {
        id: new_entity(),
        name: "Dates".to_string(),
        header_text: None,
        sheet_id: dashboard,
        x: 0.0,
        y: 0.0,
        width: 300.0,
        height: 120.0,
        source_type: persistence::SavedTimelineSourceType::Pivot,
        source_id,
        field_name: "OrderDate".to_string(),
        level: persistence::SavedTimelineLevel::Months,
        selection_start: None,
        selection_end: None,
        show_header: true,
        show_level_selector: true,
        show_scrollbar: true,
        style_preset: "TimelineStyleLight1".to_string(),
        connected_pivot_ids: Vec::new(),
    };
    // One timeline whose pivot travels, one whose pivot the application lacks.
    wb.timeline_slicers = vec![timeline(carried_pivot.id), timeline(new_entity())];
    wb.pivot_definitions = vec![carried_pivot];

    let assembly = crate::calp_commands::PublishAssembly {
        workbook: wb,
        writeback_regions: None,
        object_scripts: None,
        data_sources: Vec::new(),
        model_writebacks: Vec::new(),
        excluded_regions: Vec::new(),
    };
    let selection = crate::calp_commands::PublishSelection {
        indices: vec![0, 2, 1],
        auto_included: vec!["Report".to_string()],
        ..Default::default()
    };
    let state = crate::create_app_state();
    let report = crate::calp_commands::compute_publish_report(&assembly, &state, &[0, 2, 1], false, &selection);
    let included = |category: &str| {
        report.included.iter().find(|i| i.category == category).map(|i| i.count)
    };
    assert_eq!(included("canvasSheets"), Some(1));
    assert_eq!(included("floatingRanges"), Some(1));
    assert_eq!(included("timelineSlicers"), Some(1), "only the timeline whose pivot travels");
    assert_eq!(included("objectSourceSheets"), Some(1));
    assert!(
        !report.excluded.iter().any(|i| i.category == "floatingRanges"),
        "a floating range is no longer reported as left behind"
    );
}

/// The CODE (comments stripped per line) of one top-level function of
/// `calp_commands.rs`, from its signature to the next top-level item.
fn calp_commands_fn_code(signature: &str) -> String {
    let src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/calp_commands.rs"),
    )
    .expect("cannot read calp_commands.rs");
    let start = src
        .find(signature)
        .unwrap_or_else(|| panic!("calp_commands.rs no longer has `{signature}`"));
    let rest = &src[start + signature.len()..];
    let end = ["\npub fn ", "\npub(crate) fn ", "\nfn ", "\n#[tauri::command]"]
        .iter()
        .filter_map(|next| rest.find(next))
        .min()
        .unwrap_or(rest.len());
    rest[..end]
        .lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The WIRING, which the unit tests above cannot see: each helper is tested on
/// its own, and a helper nothing calls is the exact shape §2.z was. Both doors
/// -- the first pull (subscribe AND checkout) and the refresh -- must call
/// every M5 materializer, and the partition repair must run BEFORE anything is
/// placed at a pulled sheet's index.
#[test]
fn subscribe_checkout_and_refresh_call_every_canvas_materializer() {
    let pull = calp_commands_fn_code("pub(crate) fn materialize_pull_result(");
    for call in [
        "restore_partition_invariant(",
        "remap_chart_spec_sheet_ids(",
        "materialize_pulled_floating_ranges(",
        "materialize_pulled_timeline_slicers(",
        "rebind_pulled_control_script(",
        "register_object_sheet_edges(",
        "announce_cascade(",
    ] {
        assert!(pull.contains(call), "materialize_pull_result does not call {call}");
    }
    let repair = pull.find("restore_partition_invariant(").unwrap();
    for later in ["materialize_pulled_tables(", "state.charts.write(", "state.controls.write("] {
        let at = pull.find(later).unwrap_or_else(|| panic!("materialize_pull_result lost {later}"));
        assert!(repair < at, "{later} runs before the partition repair -- it would be placed at a pre-rotation index");
    }

    // The command is a thin wrapper now: the orchestration lives in the
    // window-free helper, which the behavioural refresh tests below drive.
    let command = calp_commands_fn_code("pub fn calp_refresh_apply(");
    for call in ["prepare_refresh_payloads(", "apply_refresh_payloads("] {
        assert!(command.contains(call), "calp_refresh_apply does not call {call}");
    }
    let refresh = calp_commands_fn_code("pub(crate) fn apply_refresh_payloads(");
    for call in [
        "restore_partition_invariant(",
        "apply_refreshed_charts(",
        "replace_refreshed_floating_ranges(",
        "replace_refreshed_timeline_slicers(",
        "rebind_pulled_control_script(",
        "refresh_pkg_to_index(",
    ] {
        assert!(refresh.contains(call), "apply_refresh_payloads does not call {call}");
    }
    let repair = refresh.find("restore_partition_invariant(").unwrap();
    let names = refresh.find("state.named_ranges.write(").expect("refresh lost its named-range write");
    assert!(repair < names, "refresh writes index-anchored state before the partition repair");
}

/// The publish-side half on its own: a binding to a control on a sheet the
/// publish does not carry is ORPHANED rather than shipped naming an index that
/// would pick out another sheet's control; other instance ids are untouched.
#[test]
fn canonicalizing_control_bindings_orphans_an_unpublished_sheets_binding() {
    let script = |instance: Option<&str>| persistence::SavedObjectScript {
        id: "s".to_string(),
        name: "s".to_string(),
        object_type: persistence::ScriptableObjectType::Button,
        instance_id: instance.map(str::to_string),
        source: String::new(),
        access_level: Default::default(),
        description: None,
        provenance: Default::default(),
        package_name: None,
        package_version: None,
        declared_capabilities: Vec::new(),
    };
    let mut scripts = vec![
        script(Some("control-4-1-1")),
        script(Some("control-2-0-0")),
        script(Some("pane-abc")),
        script(None),
    ];
    crate::calp_commands::canonicalize_control_bindings(&mut scripts, &[4, 7]);
    assert_eq!(scripts[0].instance_id.as_deref(), Some("control-0-1-1"));
    assert_eq!(scripts[1].instance_id, None, "sheet 2 is not published: orphaned");
    assert_eq!(scripts[2].instance_id.as_deref(), Some("pane-abc"));
    assert_eq!(scripts[3].instance_id, None);
}

// ===========================================================================
// M5 review fixes: the REFRESH orchestration driven end to end through
// `prepare_refresh_payloads` + `apply_refresh_payloads` (the window-free body
// of `calp_refresh_apply`), and the floating-range / detach / dev-pull repairs.
// ===========================================================================

/// Publish `wb`'s `sheet_indices` as `package` at `version`: a first publish
/// when `base` is `None`, else the next version on top of `base`.
fn publish_as(
    dir: &TempDir,
    prof: &Path,
    wb: &Workbook,
    sheet_indices: Vec<usize>,
    package: &str,
    version: (u32, u32, u32),
    base: Option<(u32, u32, u32)>,
) {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let mode = match base {
        None => PushMode::CreateNew,
        Some((a, b, c)) => PushMode::Update { expected_base: SemVer::new(a, b, c) },
    };
    let request = PublishRequest {
        workbook: wb,
        package_name: package.to_string(),
        version: SemVer::new(version.0, version.1, version.2),
        kind: "report".to_string(),
        mode,
        change_summary: format!("v{}.{}.{}", version.0, version.1, version.2),
        sheet_indices,
        now: "2026-09-25T00:00:00Z".to_string(),
        published_by: "author".to_string(),
        writeback_regions: None,
        model_writebacks: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: Vec::new(),
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        min_app_version: String::new(),
    };
    publish::publish(&reg, &request, prof).expect("publish failed");
}

/// The workspace head of `package`, as a subscribe or a refresh pulls it
/// (fresh local ids).
fn pull_latest(dir: &TempDir, prof: &Path, package: &str) -> calp::pull::PullResult {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let scope = calp::workspace_scope(dir.path().to_str().unwrap()).unwrap();
    calp::pull::pull(
        &reg,
        &calp::pull::PullRequest {
            package_name: package.to_string(),
            target: calp::manifest::SubscriptionTarget::Line(VersionPin::Latest),
            now: "2026-09-25T01:00:00Z".to_string(),
        },
        &scope,
        prof,
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .expect("pull failed")
}

impl Harness {
    /// A refresh exactly as `calp_refresh_apply` runs one once its pulls are
    /// verified: the pre-effect name resolution, then the orchestration.
    /// `pulls` pairs each pulled version with its subscription's index.
    fn refresh(&self, pulls: Vec<(usize, calp::pull::PullResult)>) -> calp::refresh::RefreshResult {
        let mut payloads: Vec<calp::refresh::RefreshPayload> = pulls
            .into_iter()
            .map(|(subscription_index, pull_result)| calp::refresh::RefreshPayload {
                subscription_index,
                pull_result,
            })
            .collect();
        let names = crate::calp_commands::prepare_refresh_payloads(&self.state, &mut payloads)
            .expect("the refresh's pre-effect pass refused");
        crate::calp_commands::apply_refresh_payloads(
            &self.state,
            &test_effect(),
            &crate::persistence::UserFilesState::default(),
            &self.pivot,
            &self.scripts,
            &self.bi,
            &self.ribbon,
            &self.pane,
            &self.slicer,
            &self.timeline,
            payloads,
            names,
            &[],
            "2026-09-25T02:00:00Z",
            None,
        )
        .expect("refresh failed")
    }

    fn index_of(&self, name: &str) -> usize {
        self.state
            .sheet_names
            .read()
            .unwrap()
            .iter()
            .position(|n| n == name)
            .unwrap_or_else(|| panic!("no sheet named {name}"))
    }

    fn detach(&self, index: usize) -> crate::calp_commands::DetachSheetResponse {
        crate::calp_commands::detach_sheet_inner(
            &self.state,
            &crate::persistence::FileState::default(),
            &self.pivot,
            &self.slicer,
            &self.timeline,
            index,
        )
        .expect("detach failed")
    }
}

/// A static control property, as the controls store writes it.
fn static_prop(v: &str) -> serde_json::Value {
    serde_json::json!({ "valueType": "static", "value": v })
}

/// One button at (5, 2) on `sheet` whose caption is `text`.
fn button_on(sheet: identity::SheetId, text: &str) -> persistence::SavedSheetControls {
    persistence::SavedSheetControls {
        sheet_id: sheet,
        controls: serde_json::json!([{
            "row": 5,
            "col": 2,
            "controlType": "button",
            "properties": { "text": static_prop(text) }
        }]),
    }
}

fn button_text(h: &Harness, sheet_index: usize) -> Option<String> {
    h.state
        .controls
        .read()
        .unwrap()
        .get(&(sheet_index, 5, 2))
        .map(|c| c.properties["text"].value.clone())
}

fn number_at(grid: &engine::grid::Grid, row: u32, col: u32) -> Option<f64> {
    match grid.get_cell(row, col).map(|c| &c.value) {
        Some(engine::CellValue::Number(n)) => Some(*n),
        _ => None,
    }
}

/// TWO SUBSCRIPTIONS THAT SHARE A PACKAGE SHEET ID, refreshed in one apply.
/// Two applications forked from one workbook keep its sheet ids, and the
/// refresh used to merge every payload's (package id -> local index) map into
/// ONE -- the second payload's entry overwrote the first's, so the first
/// application's v2 tab colour, button and floating range all landed on the
/// SECOND subscription's copy of the sheet (the floating range then collided
/// with the other one's backing sheet and vanished).
///
/// SABOTAGE: make `refresh_pkg_to_index` hand every payload one merged map.
#[test]
fn two_subscriptions_sharing_a_package_sheet_id_each_refresh_their_own_sheet() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let (mut alpha, alpha_fr) = workbook_with_floating_range(); // [Dashboard, Float1(object)]
    alpha.sheets[0].name = "Alpha".to_string();
    alpha.sheets[1].name = "FloatA".to_string();
    let (mut beta, beta_fr) = workbook_with_floating_range();
    // A FORK: the same two sheet ids.
    beta.sheets[0].id = alpha.sheets[0].id;
    beta.sheets[1].id = alpha.sheets[1].id;
    beta.floating_ranges[0].host_sheet_id = alpha.sheets[0].id;
    beta.floating_ranges[0].backing_sheet_id = alpha.sheets[1].id;
    beta.sheets[0].name = "Beta".to_string();
    beta.sheets[1].name = "FloatB".to_string();
    alpha.controls = vec![button_on(alpha.sheets[0].id, "A1")];
    beta.controls = vec![button_on(beta.sheets[0].id, "B1")];
    publish_as(&dir, prof.path(), &alpha, vec![0, 1], "alpha", (1, 0, 0), None);
    publish_as(&dir, prof.path(), &beta, vec![0, 1], "beta", (1, 0, 0), None);

    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "alpha"), MaterializeMode::Subscribe);
    h.materialize(pull_latest(&dir, prof.path(), "beta"), MaterializeMode::Subscribe);
    assert_eq!(
        *h.state.sheet_names.read().unwrap(),
        vec!["Sheet1", "Alpha", "Beta", "FloatA", "FloatB"],
        "precondition: both subscribed, the object tail last"
    );

    // v2 of each changes the same three things on its own copy.
    alpha.sheets[0].tab_color = "#aa0000".to_string();
    alpha.floating_ranges[0].x = 111.0;
    alpha.controls = vec![button_on(alpha.sheets[0].id, "A2")];
    beta.sheets[0].tab_color = "#0000bb".to_string();
    beta.floating_ranges[0].x = 222.0;
    beta.controls = vec![button_on(beta.sheets[0].id, "B2")];
    publish_as(&dir, prof.path(), &alpha, vec![0, 1], "alpha", (1, 1, 0), Some((1, 0, 0)));
    publish_as(&dir, prof.path(), &beta, vec![0, 1], "beta", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![
        (0, pull_latest(&dir, prof.path(), "alpha")),
        (1, pull_latest(&dir, prof.path(), "beta")),
    ]);

    let (a, b) = (h.index_of("Alpha"), h.index_of("Beta"));
    let (fa, fb) = (h.index_of("FloatA"), h.index_of("FloatB"));
    let tabs = h.state.tab_colors.read().unwrap().clone();
    assert_eq!(tabs[a], "#aa0000", "alpha's v2 presentation landed on ALPHA's sheet");
    assert_eq!(tabs[b], "#0000bb", "and beta's on beta's");
    assert_eq!(button_text(&h, a).as_deref(), Some("A2"), "alpha's button on alpha's sheet");
    assert_eq!(button_text(&h, b).as_deref(), Some("B2"), "beta's button on beta's sheet");
    let ids = h.state.sheet_ids.read().unwrap().clone();
    let rows = h.state.floating_ranges.read().unwrap().clone();
    let ra = rows.iter().find(|fr| fr.id == alpha_fr).expect("alpha's floating range survived its refresh");
    let rb = rows.iter().find(|fr| fr.id == beta_fr).expect("beta's floating range survived its refresh");
    assert_eq!((ra.host_sheet_id, ra.backing_sheet_id, ra.x), (ids[a], ids[fa], 111.0));
    assert_eq!((rb.host_sheet_id, rb.backing_sheet_id, rb.x), (ids[b], ids[fb], 222.0));
}

/// DETACHING A CANVAS CLAIMS WHAT IS ON IT. The next refresh deletes every
/// ledger-owned object and re-adds only what resolves onto a still-subscribed
/// sheet -- so a detached canvas lost its floating range, timeline and chart,
/// and the range's backing sheet (still subscribed) kept being rewritten from
/// upstream under a host the user owned.
///
/// SABOTAGE: drop the `sub.objects.retain(...)` claim in `detach_sheet_inner`
/// (the objects vanish), or the backing-sheet loop (its cell becomes v2's).
#[test]
fn a_detached_canvas_keeps_its_floating_range_timeline_and_chart_through_a_refresh() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let (mut wb, fr_id) = workbook_with_floating_range(); // [Dashboard, Float1(object)]
    wb.sheets[0].name = "Canvas".to_string();
    wb.sheets[0].kind = persistence::SheetKind::new_canvas();
    wb.sheets[1]
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_number(7.0)));
    let mut other = Sheet::new("Other".to_string());
    other.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(1.0)));
    wb.sheets.push(other); // 2
    let (canvas_id, float_id, other_id) = (wb.sheets[0].id, wb.sheets[1].id, wb.sheets[2].id);
    let pivot = persistence::SavedPivotDefinition {
        id: new_entity(),
        source_type: "grid".to_string(),
        source_sheet_index: None,
        definition: serde_json::json!({ "name": "ByMonth", "destination_sheet": "Other" }),
    };
    let timeline_id = new_entity();
    wb.timeline_slicers = vec![persistence::SavedTimelineSlicer {
        id: timeline_id,
        name: "Dates".to_string(),
        header_text: None,
        sheet_id: canvas_id,
        x: 30.0,
        y: 400.0,
        width: 520.0,
        height: 130.0,
        source_type: persistence::SavedTimelineSourceType::Pivot,
        source_id: pivot.id,
        field_name: "OrderDate".to_string(),
        level: persistence::SavedTimelineLevel::Months,
        selection_start: None,
        selection_end: None,
        show_header: true,
        show_level_selector: true,
        show_scrollbar: false,
        style_preset: "TimelineStyleLight1".to_string(),
        connected_pivot_ids: Vec::new(),
    }];
    wb.pivot_definitions = vec![pivot];
    wb.charts = vec![chart_reading(canvas_id, other_id, 2, "OnTheCanvas")];
    let chart_id = wb.charts[0].id;
    publish_as(&dir, prof.path(), &wb, vec![0, 1, 2], "literals", (1, 0, 0), None);

    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    let canvas = h.index_of("Canvas");
    h.detach(canvas);
    {
        let subs = h.state.subscriptions.read().unwrap();
        let sub = &subs.subscriptions[0];
        assert!(sub.detached_sheets.contains(&canvas_id), "the canvas is detached");
        assert!(sub.detached_sheets.contains(&float_id), "and so is its floating range's backing sheet");
        assert!(
            !sub.objects.iter().any(|o| o.id == fr_id.to_string()
                || o.id == timeline_id.to_string()
                || o.id == chart_id.to_string()),
            "the objects on the canvas are the subscriber's now: {:?}",
            sub.objects
        );
    }

    // v2 moves the range, rewrites its cells, and re-lays the canvas out.
    wb.floating_ranges[0].x = 999.0;
    wb.sheets[1]
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_number(70.0)));
    wb.timeline_slicers[0].x = 5.0;
    publish_as(&dir, prof.path(), &wb, vec![0, 1, 2], "literals", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);

    let canvas = h.index_of("Canvas");
    let float1 = h.index_of("Float1");
    let ids = h.state.sheet_ids.read().unwrap().clone();
    let rows = h.state.floating_ranges.read().unwrap().clone();
    let row = rows.iter().find(|fr| fr.id == fr_id).expect("the detached canvas kept its floating range");
    assert_eq!((row.host_sheet_id, row.backing_sheet_id), (ids[canvas], ids[float1]));
    assert_eq!(row.x, 120.0, "v1's geometry: upstream no longer speaks for it");
    let timelines = h.timeline.timelines.read().unwrap();
    let timeline = timelines.get(&timeline_id).expect("the detached canvas kept its timeline");
    assert_eq!((timeline.sheet_index, timeline.x), (canvas, 30.0));
    let charts = h.state.charts.read().unwrap();
    let chart = charts.iter().find(|c| c.id == chart_id).expect("the detached canvas kept its chart");
    assert_eq!(chart.sheet_index, canvas);
    assert_eq!(
        number_at(&h.state.grids.read().unwrap()[float1], 0, 0),
        Some(7.0),
        "the range's cells are not rewritten from upstream under a host the user owns"
    );
}

/// A CHART THAT STAYS SUBSCRIBED BUT READS A DETACHED SHEET keeps reading it.
/// v2's chart names its source by the PUBLISHER's sheet id; the detached sheet
/// is in no refresh map (nothing may be PLACED on it), so the ref used to stay
/// on an id that exists nowhere here. The detach records the sheet's local id
/// and the chart's DATA sources resolve through it.
///
/// SABOTAGE: remap through `pkg_to_local` instead of `source_to_local` in
/// `apply_refreshed_charts`.
#[test]
fn a_chart_reading_a_detached_sheet_keeps_reading_it_after_a_refresh() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut wb = dashboard_and_data(); // Dashboard (chart reads Data), Data
    let publisher_data = wb.sheets[1].id;
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 0, 0), None);

    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    h.detach(h.index_of("Data"));

    wb.charts[0] = chart_reading(wb.sheets[0].id, publisher_data, 1, "Revenue v2");
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);

    let (dashboard, data) = (h.index_of("Dashboard"), h.index_of("Data"));
    let ids = h.state.sheet_ids.read().unwrap().clone();
    let charts = h.state.charts.read().unwrap();
    let chart = charts.iter().find(|c| c.id == wb.charts[0].id).expect("v2's chart landed");
    assert_eq!(chart.sheet_index, dashboard, "on the still-subscribed Dashboard");
    let (source_id, source_index) = spec_data_ref(&chart.spec_json);
    assert_ne!(source_id, publisher_data.to_string(), "not the publisher's sheet id");
    assert_eq!(source_id, ids[data].to_string(), "the detached Data, where it lives here");
    assert_eq!(source_index as usize, data);
}

/// A REFRESH THAT APPENDS A USER SHEET BEHIND AN OBJECT TAIL: v1 brought a
/// floating range, so the workbook ends in its backing sheet; v2 adds "North".
/// The sheet is rotated in front of the tail BEFORE anything is placed at its
/// index -- its chart and presentation land at the final index -- while the
/// floating range still resolves by id and the subscriber's own chart on
/// Sheet1 never moves.
///
/// SABOTAGE: drop the `restore_partition_invariant` call in
/// `apply_refresh_payloads`.
#[test]
fn a_refresh_appending_a_user_sheet_behind_an_object_tail_repairs_the_partition() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let (mut wb, fr_id) = workbook_with_floating_range(); // [Dashboard, Float1(object)]
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 0, 0), None);

    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    let mine = new_entity();
    h.state.charts.write(&test_effect()).unwrap().push(crate::api_types::ChartEntry {
        id: mine,
        sheet_index: 0,
        spec_json: "{}".to_string(),
    });

    let mut north = Sheet::new("North".to_string());
    north.tab_color = "#123456".to_string();
    north.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(3.0)));
    wb.sheets.push(north); // 2
    let north_id = wb.sheets[2].id;
    wb.charts = vec![chart_reading(north_id, north_id, 2, "North")];
    publish_as(&dir, prof.path(), &wb, vec![0, 1, 2], "literals", (1, 1, 0), Some((1, 0, 0)));
    let result = h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);
    assert_eq!(result.sheets_added, 1);

    assert_eq!(
        *h.state.sheet_names.read().unwrap(),
        vec!["Sheet1", "Dashboard", "North", "Float1"],
        "the appended user sheet was rotated in front of the object tail"
    );
    let visibility = h.state.sheet_visibility.read().unwrap().clone();
    assert!((0..3).all(|i| crate::sheets::is_user_sheet(&visibility, i)));
    assert_eq!(visibility[3], crate::sheets::OBJECT_SHEET_VISIBILITY);
    assert_eq!(h.state.tab_colors.read().unwrap()[2], "#123456", "North's presentation moved with it");
    assert_eq!(number_at(&h.state.grids.read().unwrap()[2], 0, 0), Some(3.0), "and its cells");
    let charts = h.state.charts.read().unwrap();
    let north_chart = charts.iter().find(|c| c.id == wb.charts[0].id).expect("North's chart landed");
    assert_eq!(north_chart.sheet_index, 2, "at North's FINAL index");
    assert_eq!(charts.iter().find(|c| c.id == mine).unwrap().sheet_index, 0, "the subscriber's own chart stayed");
    let ids = h.state.sheet_ids.read().unwrap().clone();
    let rows = h.state.floating_ranges.read().unwrap().clone();
    let row = rows.iter().find(|fr| fr.id == fr_id).expect("the floating range survived");
    assert_eq!((row.host_sheet_id, row.backing_sheet_id), (ids[1], ids[3]));
}

/// A SHEET RETURNING FROM A TOMBSTONE THAT IS THE ACTIVE SHEET, WITH A LOCAL
/// EDIT. The grid block already replaced a returner in place, but everything
/// after it looked the sheet up in `sub.sheets`, which no longer holds a
/// tombstoned sheet: the active mirror was not synced, the subscriber's
/// override was neither rebased nor re-applied (the grid showed the publisher's
/// value with the edit silently gone), and nothing recalculated.
///
/// SABOTAGE: resolve through `sub.sheets` again in `active_was_refreshed`, or in
/// the upstream-values block.
#[test]
fn a_sheet_returning_from_a_tombstone_keeps_its_override_and_is_recalculated() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut a = Sheet::new("A".to_string());
    a.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(1.0)));
    let mut b = Sheet::new("B".to_string());
    b.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(1.0)));
    b.cells.insert((1, 0), SavedCell::from_cell(&Cell::new_formula("A1*10".to_string())));
    let mut wb = Workbook::default();
    wb.sheets = vec![a, b];
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 0, 0), None);

    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);

    // v2 drops B: the subscriber keeps it as a TOMBSTONE.
    publish_as(&dir, prof.path(), &wb, vec![0], "literals", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);
    let b_local = {
        let subs = h.state.subscriptions.read().unwrap();
        let sub = &subs.subscriptions[0];
        let tomb = sub.upstream_removed_sheets.first().expect("precondition: B is tombstoned");
        tomb.local_sheet_id
    };

    // The user is ON B and edits A1 -> 5 (recorded as an override).
    let b = h.index_of("B");
    crate::sheets::activate_sheet(&h.state, b).expect("activate B");
    {
        let effect = test_effect();
        h.state.grid.write(&effect).unwrap().set_cell(0, 0, Cell::new_number(5.0));
        h.state.grids.write(&effect).unwrap()[b].set_cell(0, 0, Cell::new_number(5.0));
        h.state.override_layer.write(&effect).unwrap().set_override(calp::CellOverride {
            sheet_id: b_local,
            cell_id: identity::CellId::from_bytes(identity::generate_uuid_v7()),
            position: (0, 0),
            baseline: calp::OverrideValue::Value { display: "1".to_string() },
            current: calp::OverrideValue::Value { display: "5".to_string() },
            created_at: "2026-09-25T00:00:00Z".to_string(),
            modified_at: "2026-09-25T00:00:00Z".to_string(),
            author: String::new(),
            conflict: false,
            upstream_new: None,
            extra: std::collections::HashMap::new(),
        });
    }

    // v3 brings B back with a new upstream A1, and a new cell C1.
    wb.sheets[1]
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_number(2.0)));
    wb.sheets[1]
        .cells
        .insert((0, 2), SavedCell::from_cell(&Cell::new_number(99.0)));
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 2, 0), Some((1, 1, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);

    let b = h.index_of("B");
    assert_eq!(*h.state.active_sheet.read().unwrap(), b, "still on B");
    assert_eq!(
        h.state.sheet_ids.read().unwrap()[b],
        b_local,
        "B came back IN PLACE, under its old id"
    );
    assert_eq!(
        number_at(&h.state.grids.read().unwrap()[b], 0, 0),
        Some(5.0),
        "the subscriber's override was re-applied over the returning upstream value"
    );
    let mirror = h.state.grid.read().unwrap();
    assert_eq!(number_at(&mirror, 0, 0), Some(5.0), "the active mirror agrees");
    assert_eq!(
        number_at(&mirror, 0, 2),
        Some(99.0),
        "the active mirror was synced to the returning version -- a stale mirror is copied \
         back over grids[active] by the next recalculation"
    );
    assert_eq!(number_at(&mirror, 1, 0), Some(50.0), "and the returning sheet was recalculated (5 * 10)");
    let layer = h.state.override_layer.read().unwrap();
    let ovr = layer.overrides_for_sheet(b_local);
    assert_eq!(ovr.len(), 1, "the override survives");
    assert!(ovr[0].conflict, "upstream moved 1 -> 2 under it: a conflict to resolve, not a silent loss");
}

/// A grid-sourced pivot on `sheet`, its output at `destination` on the same sheet.
fn data_pivot(id: identity::EntityId, sheet: &str, destination: (u32, u32)) -> persistence::SavedPivotDefinition {
    use pivot_engine::{AggregationType, PivotDefinition, PivotField, ValueField};
    let mut def = PivotDefinition::new(id, (0, 0), (2, 1));
    def.source_has_headers = true;
    def.source_sheet = Some(sheet.to_string());
    def.destination_sheet = Some(sheet.to_string());
    def.destination = destination;
    def.row_fields.push(PivotField::new(0, "Region".to_string()));
    def.value_fields.push(ValueField::new(1, "Amount".to_string(), AggregationType::Sum));
    persistence::SavedPivotDefinition {
        id,
        source_type: "grid".to_string(),
        source_sheet_index: Some(0),
        definition: serde_json::to_value(&def).unwrap(),
    }
}

/// THE TRACKED SHEET THAT WAS RENAMED ON SUBSCRIBE. The subscriber already had
/// a "Data", so the application's arrived as "Data (2)". The refresh name map
/// held only the collision renames of sheets NEW in that version, so v2's pivot
/// -- anchored on the publisher's "Data" -- resolved to the SUBSCRIBER's own
/// "Data", built its cache from their cells and wrote its output over them.
///
/// SABOTAGE: drop the tracked-sheet arm of `prepare_refresh_payloads` (only
/// collision renames of new sheets go in the map).
#[test]
fn a_refreshed_pivot_follows_its_renamed_sheet_not_the_subscribers_same_named_one() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut data = Sheet::new("Data".to_string());
    for (r, region, amount) in [(1u32, "North", 10.0), (2, "South", 20.0)] {
        data.cells.insert((r, 0), SavedCell::from_cell(&Cell::new_text(region.to_string())));
        data.cells.insert((r, 1), SavedCell::from_cell(&Cell::new_number(amount)));
    }
    data.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_text("Region".to_string())));
    data.cells.insert((0, 1), SavedCell::from_cell(&Cell::new_text("Amount".to_string())));
    let mut wb = Workbook::default();
    wb.sheets = vec![data];
    let pivot_id = new_entity();
    wb.pivot_definitions = vec![data_pivot(pivot_id, "Data", (10, 5))];
    publish_as(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None);

    let h = Harness::new();
    {
        // The subscriber's OWN "Data", with a marker where the pivot would land.
        let effect = test_effect();
        h.state.sheet_names.write(&effect).unwrap()[0] = "Data".to_string();
        h.state.grid.write(&effect).unwrap().set_cell(10, 5, Cell::new_text("MINE".to_string()));
        h.state.grids.write(&effect).unwrap()[0].set_cell(10, 5, Cell::new_text("MINE".to_string()));
    }
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    let pulled = h.index_of("Data (2)");

    wb.sheets[0]
        .cells
        .insert((1, 1), SavedCell::from_cell(&Cell::new_number(11.0)));
    publish_as(&dir, prof.path(), &wb, vec![0], "literals", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);

    let own = h.state.grids.read().unwrap()[0]
        .get_cell(10, 5)
        .map(|c| c.display_value());
    assert_eq!(own.as_deref(), Some("MINE"), "the pivot was written over the subscriber's own Data");
    let region = crate::pivot::operations::get_pivot_region(&h.state, pivot_id).expect("the pivot was adopted");
    assert_eq!(region.sheet_index, pulled, "on the application's own sheet, \"Data (2)\"");
    let tables = h.pivot.pivot_tables.read().unwrap();
    assert_eq!(tables[&pivot_id].0.destination_sheet.as_deref(), Some("Data (2)"));
}

// ===========================================================================
// BUG-0151: a collision rename carries every reference to the renamed sheet
// ===========================================================================

/// The formula text of one grid cell, as the formula bar shows it.
fn formula_at(grid: &engine::grid::Grid, row: u32, col: u32) -> Option<String> {
    grid.get_cell(row, col).and_then(|c| c.formula_string())
}

/// ["Data" (A1 = 21), "Report" (A1 = Data!A1*2)] plus a defined name and a
/// chart string source that both name "Data".
fn data_and_report() -> Workbook {
    let mut data = Sheet::new("Data".to_string());
    data.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(21.0)));
    let mut report = Sheet::new("Report".to_string());
    report
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_formula("Data!A1*2".to_string())));
    let mut wb = Workbook::default();
    wb.sheets = vec![data, report];
    wb.named_ranges = vec![persistence::SavedNamedRange {
        name: "Rate".to_string(),
        refers_to: "=Data!$A$1".to_string(),
        sheet_id: None,
        comment: None,
        folder: None,
    }];
    let report_id = wb.sheets[1].id;
    wb.charts = vec![persistence::SavedChart {
        id: new_entity(),
        sheet_id: report_id,
        spec_json: serde_json::json!({
            "chartId": 1, "name": "ByName", "sheetIndex": 1,
            "spec": { "mark": "bar", "data": "Data!A1:A1" }
        })
        .to_string(),
    }];
    wb
}

/// A harness whose one sheet is the subscriber's OWN "Data" (A1 = 1000).
fn harness_with_own_data() -> Harness {
    let h = Harness::new();
    let effect = test_effect();
    h.state.sheet_names.write(&effect).unwrap()[0] = "Data".to_string();
    h.state.grid.write(&effect).unwrap().set_cell(0, 0, Cell::new_number(1000.0));
    h.state.grids.write(&effect).unwrap()[0].set_cell(0, 0, Cell::new_number(1000.0));
    h
}

/// SUBSCRIBE. The subscriber already had a "Data", so the application's arrived
/// as "Data (2)" -- and the pulled `=Data!A1*2`, the defined name and the
/// chart all went on naming "Data", i.e. the SUBSCRIBER's sheet: 2000 where the
/// report says 42, and no error anywhere.
///
/// SABOTAGE: skip the `rename_pull` call in `materialize_pull_result`.
#[test]
fn a_subscribe_collision_rename_carries_every_reference_to_the_renamed_sheet() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    publish_sheets(&dir, prof.path(), &data_and_report(), vec![0, 1]);
    let h = harness_with_own_data();
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);

    let report = h.index_of("Report");
    h.index_of("Data (2)");
    let grids = h.state.grids.read().unwrap();
    assert_eq!(
        formula_at(&grids[report], 0, 0).as_deref(),
        Some("'Data (2)'!A1*2"),
        "the pulled formula still names 'Data' -- the subscriber's own sheet"
    );
    let names = h.state.named_ranges.read().unwrap();
    assert_eq!(names["RATE"].refers_to, "='Data (2)'!$A$1", "the defined name follows the rename");
    let charts = h.state.charts.read().unwrap();
    assert!(
        charts[0].spec_json.contains("'Data (2)'!A1:A1"),
        "the chart's string source follows the rename: {}",
        charts[0].spec_json
    );
}

/// THE CHAIN. The subscriber owns "A"; the application carries "A" and
/// "A (2)", which arrive as "A (2)" and "A (2) (2)". A formula naming both must
/// move each name ONE step -- a pairwise rewrite sends `A!A1` through both
/// renames onto "A (2) (2)".
///
/// SABOTAGE: apply the renames one pair at a time.
#[test]
fn a_chain_of_collision_renames_moves_each_reference_exactly_one_step() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let a = Sheet::new("A".to_string());
    let a2 = Sheet::new("A (2)".to_string());
    let mut report = Sheet::new("Sum".to_string());
    report.cells.insert(
        (0, 0),
        SavedCell::from_cell(&Cell::new_formula("A!A1+'A (2)'!A1".to_string())),
    );
    let mut wb = Workbook::default();
    wb.sheets = vec![a, a2, report];
    publish_sheets(&dir, prof.path(), &wb, vec![0, 1, 2]);

    let h = Harness::new();
    h.state.sheet_names.write(&test_effect()).unwrap()[0] = "A".to_string();
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);

    let sum = h.index_of("Sum");
    h.index_of("A (2)");
    h.index_of("A (2) (2)");
    assert_eq!(
        formula_at(&h.state.grids.read().unwrap()[sum], 0, 0).as_deref(),
        Some("'A (2)'!A1+'A (2) (2)'!A1")
    );
}

/// REFRESH. The tracked "Data" lives here as "Data (2)"; v2 changes the report
/// formula and ADDS a sheet "Extra" that collides with one of the subscriber's
/// own. Both references must land on the application's sheets.
///
/// SABOTAGE: skip the `rename_pull` call in `prepare_refresh_payloads`.
#[test]
fn a_refresh_carries_references_to_renamed_and_newly_colliding_sheets() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut wb = data_and_report();
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 0, 0), None);
    let h = harness_with_own_data();
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    // The subscriber's own "Extra", before v2 brings one.
    crate::sheets::add_sheet_inner(
        &h.state,
        &crate::persistence::FileState::default(),
        Some("Extra".to_string()),
        ::persistence::SheetKind::Worksheet,
    )
    .expect("the subscriber adds a sheet of their own");

    let mut extra = Sheet::new("Extra".to_string());
    extra.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(5.0)));
    wb.sheets.push(extra);
    wb.sheets[1].cells.insert(
        (0, 0),
        SavedCell::from_cell(&Cell::new_formula("Data!A1*3+Extra!A1".to_string())),
    );
    publish_as(&dir, prof.path(), &wb, vec![0, 1, 2], "literals", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);

    let report = h.index_of("Report");
    h.index_of("Extra (2)");
    assert_eq!(
        formula_at(&h.state.grids.read().unwrap()[report], 0, 0).as_deref(),
        Some("'Data (2)'!A1*3+'Extra (2)'!A1"),
        "a refreshed formula must read the application's sheets, not the subscriber's \
         same-named ones"
    );
}

/// THE PULL-SIDE PIVOT ANCHOR, case-drifted. A pivot's `destination_sheet` may
/// spell its tab in another case (a case-only rename updates no definition, and
/// publish compares case-insensitively). The rename map was consulted with an
/// EXACT lookup, so "report" missed "Report" -> "Report (2)" and the
/// case-insensitive destination lookup then found the SUBSCRIBER's own "Report"
/// -- the active sheet -- and wrote the pivot over it.
///
/// SABOTAGE: look the anchors up in the rename map case-sensitively again.
#[test]
fn a_pulled_pivot_naming_its_sheet_in_another_case_still_follows_the_rename() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut report = Sheet::new("Report".to_string());
    for (r, region, amount) in [(1u32, "North", 10.0), (2, "South", 20.0)] {
        report.cells.insert((r, 0), SavedCell::from_cell(&Cell::new_text(region.to_string())));
        report.cells.insert((r, 1), SavedCell::from_cell(&Cell::new_number(amount)));
    }
    report.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_text("Region".to_string())));
    report.cells.insert((0, 1), SavedCell::from_cell(&Cell::new_text("Amount".to_string())));
    let mut wb = Workbook::default();
    wb.sheets = vec![report];
    let pivot_id = new_entity();
    wb.pivot_definitions = vec![data_pivot(pivot_id, "report", (10, 5))];
    publish_sheets(&dir, prof.path(), &wb, vec![0]);

    let h = Harness::new();
    {
        let effect = test_effect();
        h.state.sheet_names.write(&effect).unwrap()[0] = "Report".to_string();
        h.state.grid.write(&effect).unwrap().set_cell(10, 5, Cell::new_text("MINE".to_string()));
        h.state.grids.write(&effect).unwrap()[0].set_cell(10, 5, Cell::new_text("MINE".to_string()));
    }
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);

    let pulled = h.index_of("Report (2)");
    let own = h.state.grids.read().unwrap()[0].get_cell(10, 5).map(|c| c.display_value());
    assert_eq!(own.as_deref(), Some("MINE"), "the pivot was written over the subscriber's own sheet");
    let region = crate::pivot::operations::get_pivot_region(&h.state, pivot_id).expect("the pivot was restored");
    assert_eq!(region.sheet_index, pulled, "on the application's own sheet, \"Report (2)\"");
}

/// `saved_floating_range_to_row` is the LOAD REPAIR both a `.cala` load and a
/// pull go through: out-of-range geometry is CLAMPED (window counts) or DROPPED
/// (a size override past the cap or outside the per-cell bounds), never refused
/// and never passed through -- one pulled row with `row_count: u32::MAX` asked
/// the renderer for four billion rows.
///
/// SABOTAGE: revert any one clamp.
#[test]
fn a_saved_floating_range_is_clamped_into_the_window_caps_on_the_way_in() {
    use crate::floating_range::{MAX_FLOATING_RANGE_COLS, MAX_FLOATING_RANGE_ROWS};
    let row = crate::persistence::saved_floating_range_to_row(&persistence::SavedFloatingRange {
        id: new_entity(),
        backing_sheet_id: new_sheet_id(),
        host_sheet_id: new_sheet_id(),
        x: -40.0,
        y: f64::NAN,
        rotation: 0.0,
        pin_to_grid: false,
        row_count: u32::MAX,
        col_count: 0,
        col_widths: [
            (0u32, 50.0),
            (MAX_FLOATING_RANGE_COLS, 40.0), // past the cap
            (1, f64::NAN),                   // not a size
            (2, 5000.0),                     // too wide
        ]
        .into_iter()
        .collect(),
        row_heights: [(0u32, 1.0), (3, 30.0), (u32::MAX, 30.0)].into_iter().collect(),
        show_title: true,
        show_column_headers: true,
        show_row_headers: true,
    });
    assert_eq!(row.row_count, MAX_FLOATING_RANGE_ROWS);
    assert_eq!(row.col_count, 1);
    assert_eq!((row.x, row.y), (0.0, 0.0));
    assert_eq!(row.col_widths, [(0u32, 50.0)].into_iter().collect());
    assert_eq!(row.row_heights, [(3u32, 30.0)].into_iter().collect());
}

/// A workbook [Sheet1, Host, Back1(object), Back2(object), Visible] for the
/// materializer unit tests below.
fn floating_range_fixture() -> (Harness, Vec<identity::SheetId>) {
    let h = Harness::new();
    let effect = test_effect();
    let extra: Vec<identity::SheetId> = (0..4).map(|_| new_sheet_id()).collect();
    h.state.sheet_ids.write(&effect).unwrap().extend(extra.iter().copied());
    h.state
        .sheet_names
        .write(&effect)
        .unwrap()
        .extend(["Host", "Back1", "Back2", "Visible"].map(str::to_string));
    *h.state.sheet_visibility.write(&effect).unwrap() = vec![
        "visible".to_string(),
        "visible".to_string(),
        crate::sheets::OBJECT_SHEET_VISIBILITY.to_string(),
        crate::sheets::OBJECT_SHEET_VISIBILITY.to_string(),
        "visible".to_string(),
    ];
    let ids = h.state.sheet_ids.read().unwrap().clone();
    (h, ids)
}

fn pulled_range(id: identity::EntityId, host: identity::SheetId, backing: identity::SheetId) -> persistence::SavedFloatingRange {
    persistence::SavedFloatingRange {
        id,
        backing_sheet_id: backing,
        host_sheet_id: host,
        x: 1.0,
        y: 2.0,
        rotation: 0.0,
        pin_to_grid: false,
        row_count: 2,
        col_count: 2,
        col_widths: Default::default(),
        row_heights: Default::default(),
        show_title: true,
        show_column_headers: true,
        show_row_headers: true,
    }
}

/// A pulled floating range whose id the workbook already uses for a DIFFERENT
/// object (another backing sheet) is materialized under a FRESH id, and that
/// id is what the ledger records. Skipping it left its pulled backing sheet an
/// invisible object sheet no row would ever claim.
///
/// SABOTAGE: skip on any id collision again.
#[test]
fn a_pulled_floating_range_colliding_on_id_with_another_object_gets_a_fresh_id() {
    let (h, ids) = floating_range_fixture();
    let effect = test_effect();
    let shared = new_entity();
    // The workbook's own range: id `shared`, over Back1.
    h.state
        .floating_ranges
        .write(&effect)
        .unwrap()
        .push(crate::persistence::saved_floating_range_to_row(&pulled_range(shared, ids[1], ids[2])));

    // The pulled one: same id, over Back2.
    let (host_pkg, back2_pkg) = (new_sheet_id(), new_sheet_id());
    let resolve = |sid: identity::SheetId| {
        if sid == host_pkg { Some(1) } else if sid == back2_pkg { Some(3) } else { None }
    };
    let applied = crate::calp_commands::materialize_pulled_floating_ranges(
        &effect,
        &h.state,
        &[pulled_range(shared, host_pkg, back2_pkg)],
        resolve,
    )
    .unwrap();

    assert_eq!(applied.len(), 1, "the pulled range landed");
    let rows = h.state.floating_ranges.read().unwrap().clone();
    assert_eq!(rows.len(), 2);
    let pulled = rows.iter().find(|fr| fr.backing_sheet_id == ids[3]).expect("Back2 is claimed");
    assert_ne!(pulled.id, shared, "under a FRESH id");
    assert_eq!(applied[0].0, pulled.id.to_string(), "and the ledger records the fresh id");
    assert!(rows.iter().any(|fr| fr.id == shared && fr.backing_sheet_id == ids[2]), "the workbook's own is untouched");

    // The SAME object arriving again (same id, same backing) is still a quiet no-op.
    let again = crate::calp_commands::materialize_pulled_floating_ranges(
        &effect,
        &h.state,
        &[pulled_range(shared, host_pkg, new_sheet_id())],
        |sid| if sid == host_pkg { Some(1) } else { Some(2) },
    )
    .unwrap();
    assert!(again.is_empty(), "the range over Back1 is the one the workbook already has");
}

/// A pulled floating-range row is checked against the LOCAL sheets it resolved
/// to: a backing sheet that is a VISIBLE sheet, a range backed by its own host,
/// or one hosted on an object sheet is skipped -- and the visible sheet stays
/// visible (the marker re-assertion would otherwise have made it an object
/// sheet in the middle of the user prefix).
///
/// SABOTAGE: drop the structure check in `materialize_pulled_floating_ranges`.
#[test]
fn a_structurally_malformed_pulled_floating_range_is_skipped_at_materialize() {
    let (h, _ids) = floating_range_fixture();
    let effect = test_effect();
    let (host, visible, back1, back2) = (new_sheet_id(), new_sheet_id(), new_sheet_id(), new_sheet_id());
    let resolve = |sid: identity::SheetId| {
        [(host, 1usize), (back1, 2), (back2, 3), (visible, 4)]
            .into_iter()
            .find(|(k, _)| *k == sid)
            .map(|(_, v)| v)
    };
    let applied = crate::calp_commands::materialize_pulled_floating_ranges(
        &effect,
        &h.state,
        &[
            pulled_range(new_entity(), host, visible), // backing is a user sheet
            pulled_range(new_entity(), host, host),    // backed by its own host
            pulled_range(new_entity(), back1, back2),  // hosted on an object sheet
        ],
        resolve,
    )
    .unwrap();
    assert!(applied.is_empty(), "every malformed row is skipped: {applied:?}");
    assert!(h.state.floating_ranges.read().unwrap().is_empty());
    assert_eq!(
        h.state.sheet_visibility.read().unwrap()[4],
        "visible",
        "the visible sheet was not turned into an object sheet"
    );

    // Positive control: the well-formed row lands.
    let ok = crate::calp_commands::materialize_pulled_floating_ranges(
        &effect,
        &h.state,
        &[pulled_range(new_entity(), host, back1)],
        resolve,
    )
    .unwrap();
    assert_eq!(ok.len(), 1);
}

/// DEV SUBSCRIBE AND DEV REFRESH keep the partition and bring floating ranges
/// whole. A dev pull appended its sheets behind the subscriber's object tail
/// with no repair, and carried a source's backing sheets without the rows that
/// claim them -- invisible orphans. Now: the pulled block is rotated in front
/// of the tail, the backing sheet travels with its row, and a dev refresh
/// replaces the row in place instead of adding a second one.
///
/// SABOTAGE: drop `repair_dev_partition` from `dev_subscribe_inner`, or the
/// floating-range materialization.
#[test]
fn a_dev_pull_keeps_the_partition_and_brings_its_floating_ranges() {
    let dir = TempDir::new().unwrap();
    let source_path = dir.path().join("source.cala");
    let (mut wb, fr_id) = workbook_with_floating_range(); // [Dashboard, Float1(object)]
    // Named apart from the subscriber's own range's backing sheet ("Float1").
    wb.sheets[1].name = "SrcFloat".to_string();
    calcula_format::save_calcula(&wb, &source_path).expect("save the dev source");

    let h = Harness::new();
    let own = crate::floating_range::create_floating_range_inner(
        &h.state,
        &crate::persistence::FileState::default(),
        None,
        10.0,
        10.0,
    )
    .expect("the subscriber's own floating range");
    let own_backing = own.range.backing_sheet_id;
    let params = crate::calp_commands::DevSubscribeParams {
        source_path: source_path.to_string_lossy().to_string(),
        sheet_names: vec!["Dashboard".to_string()],
    };
    crate::calp_commands::dev_subscribe_inner(
        &h.state,
        &crate::persistence::FileState::default(),
        &h.slicer,
        &h.timeline,
        &h.ribbon,
        &params,
    )
    .expect("dev subscribe");

    let names = h.state.sheet_names.read().unwrap().clone();
    let visibility = h.state.sheet_visibility.read().unwrap().clone();
    let first_object = visibility
        .iter()
        .position(|v| v == crate::sheets::OBJECT_SHEET_VISIBILITY)
        .unwrap();
    assert!(
        (first_object..names.len()).all(|i| !crate::sheets::is_user_sheet(&visibility, i)),
        "user sheets are a contiguous prefix: {names:?} / {visibility:?}"
    );
    let dashboard = h.index_of("Dashboard");
    let float1 = h.index_of("SrcFloat");
    assert!(dashboard < first_object, "the pulled Dashboard sits in the user prefix");
    let ids = h.state.sheet_ids.read().unwrap().clone();
    {
        let rows = h.state.floating_ranges.read().unwrap();
        let row = rows.iter().find(|fr| fr.id == fr_id).expect("the dev pull brought the floating range row");
        assert_eq!((row.host_sheet_id, row.backing_sheet_id), (ids[dashboard], ids[float1]));
        assert!(rows.iter().any(|fr| fr.backing_sheet_id == own_backing), "the subscriber's own range survives");
    }
    {
        let subs = h.state.subscriptions.read().unwrap();
        assert!(subs.subscriptions[0]
            .objects
            .iter()
            .any(|o| o.kind == "floatingRange" && o.id == fr_id.to_string()));
    }

    // The source moves its range; a dev refresh replaces it in place.
    wb.floating_ranges[0].x = 300.0;
    calcula_format::save_calcula(&wb, &source_path).expect("save the dev source again");
    let sheets_before = h.state.sheet_names.read().unwrap().len();
    crate::calp_commands::dev_refresh_inner(
        &h.state,
        &crate::persistence::FileState::default(),
        &h.slicer,
        &h.timeline,
        &h.ribbon,
    )
    .expect("dev refresh");
    assert_eq!(h.state.sheet_names.read().unwrap().len(), sheets_before, "no sheet appended twice");
    let rows = h.state.floating_ranges.read().unwrap();
    let pulled: Vec<_> = rows.iter().filter(|fr| fr.id == fr_id).collect();
    assert_eq!(pulled.len(), 1, "one row, replaced -- not a second beside it");
    assert_eq!(pulled[0].x, 300.0);
}

/// BUG-0154. The DEV pull appended its sheets under the source's names with no
/// collision pass at all, so pulling a source whose sheet is "Sheet1" into a
/// workbook that has one produced two tabs called "Sheet1" -- and every name
/// lookup (formulas, pivots, the Name Box) then resolved to the first. Dev
/// preview claims subscriber fidelity: the pulled sheet arrives as
/// "Sheet1 (2)" like a real pull's, and the source's references to it follow
/// (BUG-0151's rewrite). A dev REFRESH replaces the sheet in place, keeps the
/// local name, and re-applies the rewrite to the fresh content.
///
/// SABOTAGE: drop the collision pass in `dev_subscribe_inner`.
#[test]
fn a_dev_pull_never_creates_two_sheets_with_one_name() {
    let dir = TempDir::new().unwrap();
    let source_path = dir.path().join("source.cala");
    let mut own = Sheet::new("Sheet1".to_string());
    own.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(7.0)));
    let mut calc = Sheet::new("Calc".to_string());
    calc.cells.insert(
        (0, 0),
        SavedCell::from_cell(&Cell::new_formula("Sheet1!A1*2".to_string())),
    );
    let mut wb = Workbook::default();
    wb.sheets = vec![own, calc];
    calcula_format::save_calcula(&wb, &source_path).expect("save the dev source");

    let h = Harness::new(); // the subscriber's own "Sheet1"
    let params = crate::calp_commands::DevSubscribeParams {
        source_path: source_path.to_string_lossy().to_string(),
        sheet_names: Vec::new(),
    };
    crate::calp_commands::dev_subscribe_inner(
        &h.state,
        &crate::persistence::FileState::default(),
        &h.slicer,
        &h.timeline,
        &h.ribbon,
        &params,
    )
    .expect("dev subscribe");

    let names = h.state.sheet_names.read().unwrap().clone();
    let mut lower: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();
    lower.sort();
    lower.dedup();
    assert_eq!(lower.len(), names.len(), "two sheets share a name: {names:?}");
    assert_eq!(names, vec!["Sheet1", "Sheet1 (2)", "Calc"]);
    let calc_idx = h.index_of("Calc");
    assert_eq!(
        formula_at(&h.state.grids.read().unwrap()[calc_idx], 0, 0).as_deref(),
        Some("'Sheet1 (2)'!A1*2"),
        "the source's reference follows its sheet, not the subscriber's own Sheet1"
    );

    // The source edits the formula; a dev refresh replaces the sheet in place.
    wb.sheets[1].cells.insert(
        (0, 0),
        SavedCell::from_cell(&Cell::new_formula("Sheet1!A1*3".to_string())),
    );
    calcula_format::save_calcula(&wb, &source_path).expect("save the dev source again");
    crate::calp_commands::dev_refresh_inner(
        &h.state,
        &crate::persistence::FileState::default(),
        &h.slicer,
        &h.timeline,
        &h.ribbon,
    )
    .expect("dev refresh");
    assert_eq!(
        *h.state.sheet_names.read().unwrap(),
        vec!["Sheet1", "Sheet1 (2)", "Calc"],
        "a refresh neither appends a second copy nor renames the local tab"
    );
    assert_eq!(
        formula_at(&h.state.grids.read().unwrap()[calc_idx], 0, 0).as_deref(),
        Some("'Sheet1 (2)'!A1*3"),
        "the refreshed formula follows the local name too"
    );
}

// ===========================================================================
// BUG-0153: a detached sheet keeps its scripts and its sheet-scoped names
// ===========================================================================

/// ["Report" (a scripted button at (5, 2)), "Other"], the script bound the way
/// the host's publish assembly canonicalizes it (application position 0), plus
/// a name scoped to "Report" and a workbook-scoped one.
fn scripted_report_and_other() -> Workbook {
    let report = Sheet::new("Report".to_string());
    let mut other = Sheet::new("Other".to_string());
    other.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(1.0)));
    let mut wb = Workbook::default();
    wb.sheets = vec![report, other];
    let report_id = wb.sheets[0].id;
    wb.controls = vec![button_on(report_id, "Go")];
    wb.object_scripts = vec![persistence::SavedObjectScript {
        id: "script-go".to_string(),
        name: "Go".to_string(),
        object_type: persistence::ScriptableObjectType::Button,
        instance_id: Some("control-0-5-2".to_string()),
        source: "export function onClick() { /* v1 */ }".to_string(),
        access_level: Default::default(),
        description: None,
        provenance: Default::default(),
        package_name: None,
        package_version: None,
        declared_capabilities: Vec::new(),
    }];
    wb.named_ranges = vec![
        persistence::SavedNamedRange {
            name: "LocalRate".to_string(),
            refers_to: "=Report!$A$1".to_string(),
            sheet_id: Some(report_id),
            comment: None,
            folder: None,
        },
        persistence::SavedNamedRange {
            name: "Rate".to_string(),
            refers_to: "=Other!$A$1".to_string(),
            sheet_id: None,
            comment: None,
            folder: None,
        },
    ];
    wb
}

/// BUG-0153 (a). The refresh's script swap removed EVERY distributed script of
/// the application and re-bound v2's through a map that has no entry for a
/// detached sheet, so the button on a sheet the subscriber took lost its script
/// on the next refresh. The script stays exactly as it was consented to --
/// distributed, restricted, v1's source -- because the sheet it serves is no
/// longer spoken for by upstream; converting it to a local script would have
/// bypassed consent, and dropping it broke the button.
///
/// SABOTAGE: drop the detached-binding exemption from the swap's `retain`.
#[test]
fn a_detached_sheets_control_script_survives_a_refresh() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut wb = scripted_report_and_other();
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 0, 0), None);
    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    let report = h.index_of("Report");
    let bound = format!("control-{report}-5-2");
    {
        let scripts = h.state.object_scripts.read().unwrap();
        let s = scripts.iter().find(|s| s.id == "script-go").expect("precondition: the script landed");
        assert_eq!(s.instance_id.as_deref(), Some(bound.as_str()));
    }
    h.detach(report);

    // v2 edits the script and a cell on the still-subscribed sheet.
    wb.object_scripts[0].source = "export function onClick() { /* v2 */ }".to_string();
    wb.sheets[1].cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(2.0)));
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);

    let scripts = h.state.object_scripts.read().unwrap();
    let kept: Vec<_> = scripts.iter().filter(|s| s.id == "script-go").collect();
    assert_eq!(kept.len(), 1, "the detached sheet's button lost its script: {:?}", scripts.iter().map(|s| (&s.id, &s.instance_id)).collect::<Vec<_>>());
    assert_eq!(kept[0].instance_id.as_deref(), Some(bound.as_str()), "still bound to the button");
    assert!(kept[0].source.contains("v1"), "upstream no longer speaks for the detached sheet");
    assert!(
        matches!(kept[0].provenance, persistence::ScriptProvenance::Distributed),
        "still the consented DISTRIBUTED script -- never silently turned local"
    );
    assert_eq!(
        number_at(&h.state.grids.read().unwrap()[h.index_of("Other")], 0, 0),
        Some(2.0),
        "precondition: the refresh really ran"
    );
}

/// BUG-0153 (b). A refresh UPSERTS the application's defined names and
/// resolves a sheet-scoped name's sheet through the refresh map -- which has no
/// entry for a detached sheet -- so a name scoped to a sheet the subscriber
/// took came back WORKBOOK-scoped (`sheet_index: None`), silently widening
/// what it resolves for. A detached sheet's names are the subscriber's; a
/// sheet-scoped name whose sheet is not here at all is not widened either.
///
/// SABOTAGE: upsert every name again, resolving an unknown sheet to `None`.
#[test]
fn a_detached_sheets_scoped_name_stays_scoped_through_a_refresh() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut wb = scripted_report_and_other();
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 0, 0), None);
    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    let report = h.index_of("Report");
    assert_eq!(
        h.state.named_ranges.read().unwrap()["LOCALRATE"].sheet_index,
        Some(report),
        "precondition: the name arrived scoped to its sheet"
    );
    h.detach(report);

    wb.named_ranges[1].refers_to = "=Other!$A$2".to_string();
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);

    let names = h.state.named_ranges.read().unwrap();
    assert_eq!(
        names["LOCALRATE"].sheet_index,
        Some(h.index_of("Report")),
        "the detached sheet's name became workbook-scoped"
    );
    assert_eq!(names["RATE"].refers_to, "=Other!$A$2", "precondition: the refresh upserted the others");
    assert_eq!(names["RATE"].sheet_index, None);
    let subs = h.state.subscriptions.read().unwrap();
    assert!(
        !subs.subscriptions[0].objects.iter().any(|o| o.kind == "namedRange" && o.id == "LOCALRATE"),
        "a name the refresh did not apply is not ledgered back to the application"
    );
}

/// BUG-0151 ON CHECKOUT. Opening an application for editing is ADDITIVE, so an
/// author who has a "Data" of their own gets the application's as "Data (2)"
/// -- and its `=Data!A1*2` then computed from the AUTHOR's sheet while they
/// edited the application. The working copy's references follow the rename
/// like a subscriber's, and the push reverses both the tab name and the
/// references (`restore_published_sheet_references`), so the package ships
/// the application's own spelling.
///
/// SABOTAGE: rename the pulled references on SUBSCRIBE only.
#[test]
fn a_checkout_collision_rename_carries_the_working_copys_references() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    publish_sheets(&dir, prof.path(), &data_and_report(), vec![0, 1]);
    let h = harness_with_own_data();
    h.materialize(checkout_pull(&dir, prof.path()), MaterializeMode::Checkout);

    let report = h.index_of("Report");
    h.index_of("Data (2)");
    assert_eq!(
        formula_at(&h.state.grids.read().unwrap()[report], 0, 0).as_deref(),
        Some("'Data (2)'!A1*2"),
        "the working copy computes the application's report from the author's own Data"
    );
    assert_eq!(h.state.named_ranges.read().unwrap()["RATE"].refers_to, "='Data (2)'!$A$1");
}

/// The PUSH half: the carrier a working copy publishes has its collision
/// renames undone in the references it ships -- formulas on the published
/// sheets, defined names and chart string sources -- simultaneously, and a
/// reference to the author's OWN same-named sheet is left as it is (it means
/// the package's sheet there, exactly as before).
///
/// SABOTAGE: return early from `restore_published_sheet_references`.
#[test]
fn a_push_restores_the_published_names_in_the_references_it_ships() {
    let mut report = Sheet::new("Report".to_string());
    report.cells.insert(
        (0, 0),
        SavedCell::from_cell(&Cell::new_formula("'Data (2)'!A1*2+'A (2) (2)'!A1".to_string())),
    );
    report
        .cells
        .insert((1, 0), SavedCell::from_cell(&Cell::new_formula("Data!B1".to_string())));
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Data".to_string()), report];
    wb.named_ranges = vec![persistence::SavedNamedRange {
        name: "Rate".to_string(),
        refers_to: "='Data (2)'!$A$1".to_string(),
        sheet_id: None,
        comment: None,
        folder: None,
    }];
    wb.charts = vec![persistence::SavedChart {
        id: new_entity(),
        sheet_id: wb.sheets[1].id,
        spec_json: serde_json::json!({ "spec": { "data": "'Data (2)'!A1:A1" } }).to_string(),
    }];
    // LOWERCASED local name -> published name, as `assemble_publish_workbook`
    // builds it; a chain, so a pairwise undo would be caught too.
    let renamed: std::collections::HashMap<String, String> = [
        ("data (2)".to_string(), "Data".to_string()),
        ("a (2) (2)".to_string(), "A (2)".to_string()),
    ]
    .into_iter()
    .collect();

    let own_reference = wb.sheets[1].cells[&(1, 0)].formula.clone();

    crate::calp_commands::restore_published_sheet_references(&mut wb, &[1], &renamed);

    let cells = &wb.sheets[1].cells;
    assert_eq!(cells[&(0, 0)].formula.as_deref(), Some("Data!A1*2+'A (2)'!A1"));
    assert_eq!(cells[&(1, 0)].formula, own_reference, "left exactly as it was");
    assert_eq!(wb.named_ranges[0].refers_to, "=Data!$A$1");
    assert!(wb.charts[0].spec_json.contains("Data!A1:A1") && !wb.charts[0].spec_json.contains("(2)"));
}

/// BUG-0151 ON RESET. "Reset to published" re-pulls the version the subscriber
/// is on and rebuilds the subscribed sheets from it -- so without the rename
/// the reset put back `=Data!A1*2` over the repaired `='Data (2)'!A1*2`, and
/// the report read the subscriber's own "Data" again.
///
/// SABOTAGE: return early from `rename_pulled_references_for_reset`.
#[test]
fn a_reset_keeps_the_references_a_collision_rename_repaired() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    publish_sheets(&dir, prof.path(), &data_and_report(), vec![0, 1]);
    let h = harness_with_own_data();
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);
    let sub = h.state.subscriptions.read().unwrap().subscriptions[0].clone();

    // The reset's own re-pull of the version the subscriber is on.
    let mut again = subscribe_pull(&dir, prof.path());
    let names = crate::calp_commands::rename_pulled_references_for_reset(&h.state, &sub, &mut again)
        .expect("rename");
    assert_eq!(names.local_name("Data"), Some("Data (2)"));
    let report = again.sheets.iter().find(|p| p.name == "Report").expect("the pulled Report");
    assert_eq!(
        report.sheet.cells[&(0, 0)].formula.as_deref(),
        Some("'Data (2)'!A1*2"),
        "the reset would rebuild the report reading the subscriber's own Data"
    );
    assert_eq!(
        again.sheets.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
        vec!["Data", "Report"],
        "the pulled sheets keep the publisher's names: the reset maps them by id"
    );
}

/// The SUBSCRIBER DIFF ("View changes", the reset preview) compares the
/// subscriber's sheets with the published version -- and after a collision
/// rename every repaired reference would read as a change the reset does not
/// make. The working side's references are compared in the published spelling:
/// this is the map that does it (applied by `restore_published_sheet_references`
/// inside the preview publish).
///
/// SABOTAGE: return an empty map from `subscriber_published_names`.
#[test]
fn a_subscriber_diff_compares_renamed_references_in_the_published_spelling() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    publish_sheets(&dir, prof.path(), &data_and_report(), vec![0, 1]);
    let h = harness_with_own_data();
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let base = reg.get_version_manifest("literals", "1.0.0").unwrap();

    let names = crate::calp_commands::subscriber_published_names(&h.state, "literals", &base)
        .expect("names");
    assert_eq!(
        names,
        [("data (2)".to_string(), "Data".to_string())].into_iter().collect(),
        "only the collision-renamed sheet, local (lowercased) -> published"
    );
    assert!(
        crate::calp_commands::subscriber_published_names(&h.state, "not-subscribed", &base)
            .unwrap()
            .is_empty()
    );

    // The live formula, carried the way the preview carries it, comes back in
    // the published spelling.
    let report = h.index_of("Report");
    let live = formula_at(&h.state.grids.read().unwrap()[report], 0, 0).unwrap();
    let mut carrier = Workbook::default();
    let mut sheet = Sheet::new("Report".to_string());
    sheet
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_formula(live.clone())));
    carrier.sheets = vec![sheet];
    crate::calp_commands::restore_published_sheet_references(&mut carrier, &[0], &names);
    assert_eq!(carrier.sheets[0].cells[&(0, 0)].formula.as_deref(), Some("Data!A1*2"));
}

// ===========================================================================
// BUG-0151 fix-up: the doors the first round missed
// ===========================================================================

/// A working copy of "literals" checked out into a workbook that already owns
/// a "Data": the application's "Data" is here as "Data (2)", and the link names
/// the application's sheets by their PUBLISHED names, as `calp_checkout` writes
/// it.
fn checked_out_over_own_data(dir: &TempDir, prof: &Path) -> Harness {
    publish_sheets(dir, prof, &data_and_report(), vec![0, 1]);
    let h = harness_with_own_data();
    h.materialize(checkout_pull(dir, prof), MaterializeMode::Checkout);
    let base_sheets: Vec<calp::WorkingCopySheetRef> = {
        let ids = h.state.sheet_ids.read().unwrap();
        [("Data (2)", "Data"), ("Report", "Report")]
            .iter()
            .map(|(local, published)| calp::WorkingCopySheetRef {
                sheet_id: ids[h.index_of(local)],
                name: published.to_string(),
            })
            .collect()
    };
    *h.state.working_copy_link.write(&test_effect()).unwrap() = Some(calp::WorkingCopyLink::new(
        dir.path().to_str().unwrap(),
        "literals",
        "report",
        "1.0.0",
        "2026-09-25T01:00:00Z",
        base_sheets,
    ));
    h
}

/// THE HOLD-BACK DOOR. An author whose checkout renamed the application's
/// "Data" to "Data (2)" edits Report!A1 and unticks it in the push dialog; the
/// hold-back lays the BASE's cell back. It laid `DATA!A1*2` back verbatim --
/// naming the AUTHOR's own "Data" -- so its recalculation computed 2000 where
/// the application says 42, and the push shipped that number beside a formula
/// the diff called unchanged. The merge had learned the rename; the hold-back
/// had not. Both now read a published version's cells through one function.
///
/// SABOTAGE: hand `published_cells_in_local_names` an empty `SheetRenames`
/// from the hold-back (the census below), or skip `rename_saved_cell` in it.
#[test]
fn a_held_back_cell_reads_the_working_copys_renamed_sheet_not_the_authors_own() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let h = checked_out_over_own_data(&dir, prof.path());
    let registry = dir.path().to_str().unwrap();

    let renames = crate::calp_commands::working_copy_sheet_renames(&h.state, registry, "literals")
        .expect("renames");
    assert_eq!(renames.target("Data"), Some("Data (2)"), "the checkout's collision rename");

    let report_id = h.state.sheet_ids.read().unwrap()[h.index_of("Report")].to_string();
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let cells = crate::calp_commands::published_cells_in_local_names(
        &reg,
        "literals",
        "1.0.0",
        &report_id,
        &[(0, 0), (9, 9)],
        &renames,
    )
    .expect("read")
    .expect("the base has the sheet");
    assert_eq!(cells.len(), 2);
    assert_eq!(cells[0].0, (0, 0));
    assert_eq!(
        cells[0].1.as_ref().and_then(|c| c.formula.as_deref()),
        Some("'Data (2)'!A1*2"),
        "the held-back cell must read the application's Data, not the author's"
    );
    assert!(cells[1].1.is_none(), "a cell the base did not have comes back empty");

    // The cell the grid then takes computes the application's number.
    let back = cells[0].1.as_ref().unwrap().to_cell();
    assert_eq!(back.formula_string().as_deref(), Some("'Data (2)'!A1*2"));

    // A sheet the base does not have is the caller's to decide about.
    assert!(crate::calp_commands::published_cells_in_local_names(
        &reg,
        "literals",
        "1.0.0",
        &new_sheet_id().to_string(),
        &[(0, 0)],
        &renames,
    )
    .expect("read")
    .is_none());

    // Any other application's link renames nothing.
    assert!(crate::calp_commands::working_copy_sheet_renames(&h.state, registry, "other")
        .unwrap()
        .is_empty());
}

/// THE SUBSCRIBER DIFF AND THE RESET, ONE RULE. The subscriber owns "Data";
/// the application's arrived as "Data (2)" and the subscriber DETACHED it.
/// The reset maps a detached sheet to its local copy (the refresh resolver)
/// and so rewrites Report!A1 to what it already says; the diff's map was
/// walked by hand over the TRACKED sheets and missed the detached one, so
/// "View changes" listed Report!A1 with a Reset checkbox for a reset that
/// changes nothing.
///
/// SABOTAGE: walk `sub.sheets` by hand again in `subscriber_published_names`.
#[test]
fn the_subscriber_diff_and_the_reset_agree_about_a_detached_sheet() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    publish_sheets(&dir, prof.path(), &data_and_report(), vec![0, 1]);
    let h = harness_with_own_data();
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);
    h.detach(h.index_of("Data (2)"));
    let sub = h.state.subscriptions.read().unwrap().subscriptions[0].clone();
    assert!(sub.sheets.iter().all(|s| s.local_name != "Data (2)"), "precondition: detached");

    // What the reset would write.
    let mut again = subscribe_pull(&dir, prof.path());
    crate::calp_commands::rename_pulled_references_for_reset(&h.state, &sub, &mut again)
        .expect("rename");
    let reset_writes = again
        .sheets
        .iter()
        .find(|p| p.name == "Report")
        .and_then(|p| p.sheet.cells[&(0, 0)].formula.clone())
        .unwrap();
    let report = h.index_of("Report");
    let live = formula_at(&h.state.grids.read().unwrap()[report], 0, 0).unwrap();
    assert!(
        calp::sheet_renames::same_formula_text(&reset_writes, &live),
        "precondition: the reset changes nothing here ({reset_writes} vs {live})"
    );

    // What the diff compares: the live cell, in the published spelling.
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let base = reg.get_version_manifest("literals", "1.0.0").unwrap();
    let names =
        crate::calp_commands::subscriber_published_names(&h.state, "literals", &base).expect("names");
    assert_eq!(names.get("data (2)").map(String::as_str), Some("Data"), "{names:?}");
    let mut carrier = Workbook::default();
    let mut sheet = Sheet::new("Report".to_string());
    sheet.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_formula(live)));
    carrier.sheets = vec![sheet];
    crate::calp_commands::restore_published_sheet_references(&mut carrier, &[0], &names);
    let published = data_and_report().sheets[1].cells[&(0, 0)].formula.clone().unwrap();
    let compared = carrier.sheets[0].cells[&(0, 0)].formula.clone().unwrap();
    assert!(
        calp::sheet_renames::same_formula_text(&compared, &published),
        "the diff would list a change the reset does not make: {compared} vs {published}"
    );
}

/// A PULLED SHEET THE SUBSCRIBER DELETED. The subscriber owns "Data"; the
/// application's arrived as "Data (2)", which they detached and then deleted
/// (the delete guard's own remedy), leaving Report!A1 an honest `#REF!`. The
/// next refresh had no local name for "Data" and wrote v2's `Data!A1*3` back
/// in the PUBLISHER's spelling -- in this workbook, the subscriber's own sheet:
/// 3000 where there should be an error, and nothing to say so.
///
/// SABOTAGE: drop the `with_gone` half of `RefreshSheetNames::renames`.
#[test]
fn a_refresh_after_the_subscriber_deleted_a_pulled_sheet_never_reads_their_namesake() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut wb = data_and_report();
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 0, 0), None);
    let h = harness_with_own_data();
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    let pulled_data = h.index_of("Data (2)");
    h.detach(pulled_data);
    crate::sheets::delete_sheet_impl(
        &h.state,
        &crate::persistence::FileState::default(),
        &h.pivot,
        &crate::persistence::UserFilesState::default(),
        &h.pane,
        &h.ribbon,
        &h.slicer,
        &h.timeline,
        pulled_data,
        false,
    )
    .expect("the detached copy is the subscriber's to delete");
    assert!(
        !h.state.sheet_names.read().unwrap().iter().any(|n| n == "Data (2)"),
        "precondition: deleted"
    );

    wb.sheets[1]
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_formula("Data!A1*3".to_string())));
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);

    let report = h.index_of("Report");
    let grids = h.state.grids.read().unwrap();
    let formula = formula_at(&grids[report], 0, 0);
    assert_eq!(
        formula.as_deref(),
        Some("#REF!*3"),
        "the refreshed formula reads the subscriber's own 'Data' ({:?})",
        grids[report].get_cell(0, 0).map(|c| c.display_value())
    );
    assert_ne!(number_at(&grids[report], 0, 0), Some(3000.0));
}

/// A SECOND DEV SUBSCRIBE to the same source is refused before anything
/// changes. A dev pull keeps the source's sheet ids, so every sheet it brings
/// is already here: it used to be appended anyway -- two tabs per name, one id
/// per pair -- and the source's formulas read whichever came first.
///
/// SABOTAGE: drop the `CALP_DEV_SHEET_ALREADY_HERE` gate.
#[test]
fn a_second_dev_subscribe_to_the_same_source_is_refused_and_changes_nothing() {
    let dir = TempDir::new().unwrap();
    let source_path = dir.path().join("source.cala");
    let mut own = Sheet::new("Sheet1".to_string());
    own.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(7.0)));
    let mut calc = Sheet::new("Calc".to_string());
    calc.cells.insert(
        (0, 0),
        SavedCell::from_cell(&Cell::new_formula("Sheet1!A1*2".to_string())),
    );
    let mut wb = Workbook::default();
    wb.sheets = vec![own, calc];
    calcula_format::save_calcula(&wb, &source_path).expect("save the dev source");

    let h = Harness::new();
    let params = crate::calp_commands::DevSubscribeParams {
        source_path: source_path.to_string_lossy().to_string(),
        sheet_names: Vec::new(),
    };
    let subscribe = |file_state: &crate::persistence::FileState| {
        crate::calp_commands::dev_subscribe_inner(
            &h.state,
            file_state,
            &h.slicer,
            &h.timeline,
            &h.ribbon,
            &params,
        )
    };
    subscribe(&crate::persistence::FileState::default()).expect("the first dev subscribe");
    let names_before = h.state.sheet_names.read().unwrap().clone();
    let ids_before = h.state.sheet_ids.read().unwrap().clone();
    let subs_before = h.state.subscriptions.read().unwrap().subscriptions.len();

    let clean = crate::persistence::FileState::default();
    let err = subscribe(&clean).expect_err("a second dev subscribe must be refused");
    assert!(err.contains("CALP_DEV_SHEET_ALREADY_HERE"), "{err}");
    assert!(!clean.is_dirty(), "a refusal leaves a clean workbook clean");
    assert_eq!(*h.state.sheet_names.read().unwrap(), names_before);
    assert_eq!(*h.state.sheet_ids.read().unwrap(), ids_before);
    assert_eq!(h.state.subscriptions.read().unwrap().subscriptions.len(), subs_before);
    let mut unique = ids_before.clone();
    unique.sort_by_key(|id| id.to_string());
    unique.dedup();
    assert_eq!(unique.len(), ids_before.len(), "one sheet per id");
}
