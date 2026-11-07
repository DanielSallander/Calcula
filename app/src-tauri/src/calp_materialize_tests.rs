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
        identity_policy: None,
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
        identity_policy: None,
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
        .pulled
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
        spec: serde_json::json!({
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
        }),
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
/// UNCHANGED: a rewrite would put a chart nobody edited into the next push's
/// diff.
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
    let published_spec = checked_out.charts[0].spec.clone();

    let h = Harness::new();
    h.materialize(checked_out, MaterializeMode::Checkout);

    let charts = h.state.charts.read().unwrap();
    assert_eq!(charts.len(), 1);
    let stored: serde_json::Value = serde_json::from_str(&charts[0].spec_json).unwrap();
    assert_eq!(stored, published_spec, "unchanged on checkout");
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

    crate::calp_commands::apply_refreshed_charts(&mut charts, &sub, &pulled, &sheet_ids, &mut entries, &mut Vec::new());

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
        container: None,
        hidden_rows: Vec::new(),
        hidden_cols: Vec::new(),
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
        container: None,
        hidden_rows: Vec::new(),
        hidden_cols: Vec::new(),
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
        container: None,
        hidden_rows: Vec::new(),
        hidden_cols: Vec::new(),
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
        container: None,
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
        container: None,
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
        withheld: Vec::new(),
        added_to_application: Vec::new(),
        button_code: Default::default(),
        cell_type_objects: Vec::new(),
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
        identity_policy: None,
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
        // The command's other pre-effect gate: one key, one connection.
        crate::calp_commands::refuse_refreshed_data_sources_already_served(&self.state, &self.bi, &payloads)
            .expect("the refresh's data-source gate refused");
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
        container: None,
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
        spec: serde_json::json!({
            "chartId": 1, "name": "ByName", "sheetIndex": 1,
            "spec": { "mark": "bar", "data": "Data!A1:A1" }
        }),
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
        container: None,
        hidden_rows: Vec::new(),
        hidden_cols: Vec::new(),
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
        container: None,
        hidden_rows: Vec::new(),
        hidden_cols: Vec::new(),
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
        &h.pivot,
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
        &h.pivot,
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
        &h.pivot,
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
        &h.pivot,
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
        // Held under its (scope, name) key (BUG-0744).
        h.state.named_ranges.read().unwrap()[&crate::named_ranges::registry_key(Some(report), "LocalRate")].sheet_index,
        Some(report),
        "precondition: the name arrived scoped to its sheet"
    );
    h.detach(report);

    wb.named_ranges[1].refers_to = "=Other!$A$2".to_string();
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);

    let names = h.state.named_ranges.read().unwrap();
    assert!(!names.contains_key("LOCALRATE"), "the detached sheet's name became workbook-scoped");
    assert_eq!(
        names[&crate::named_ranges::registry_key(Some(h.index_of("Report")), "LocalRate")].sheet_index,
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
        spec: serde_json::json!({ "spec": { "data": "'Data (2)'!A1:A1" } }),
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
    assert_eq!(wb.charts[0].spec["spec"]["data"], "Data!A1:A1");
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
        [(identity::sheet_name_key("Data (2)"), "Data".to_string())].into_iter().collect(),
        "only the collision-renamed sheet, local (by Excel's sheet-name key) -> published"
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
    let manifest = reg.get_version_manifest("literals", "1.0.0").unwrap();
    let cells = crate::calp_commands::published_cells_in_local_names(
        &reg,
        "literals",
        "1.0.0",
        &manifest,
        &report_id,
        &[(0, 0), (9, 9)],
        &renames,
        None,
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
        &manifest,
        &new_sheet_id().to_string(),
        &[(0, 0)],
        &renames,
        None,
    )
    .expect("read")
    .is_none());

    // Any other application's link renames nothing.
    assert!(crate::calp_commands::working_copy_sheet_renames(&h.state, registry, "other")
        .unwrap()
        .is_empty());
}

/// A LAID VERSION'S SPILLED VALUES ARE NOT LAID (wave-3 verifier, backmisc).
/// The merge (head) and the hold-back (base) lay a published version's cells
/// over the working copy; a version whose dynamic array only GREW (an input
/// row added) diffs its spilled cells as changed, and laying them as literals
/// over this copy's own array was refused cell by cell as a write into a
/// spilled value (BUG-0775's background gate; the active sheet's batch) -- the
/// merge could never be applied. Both doors read with `local_spilled`: the
/// origin and the inputs come back as cells, the spilled cells as EMPTY (the
/// version has no content there; a cell of this copy that is one of its own
/// spilled values is left out instead -- see
/// `a_lay_in_settles_a_shrunk_array_and_a_literal_in_a_grown_one`), and the
/// install's recalculation re-derives the array.
///
/// SABOTAGE (obj4-lay): drop the `derived` rule in
/// `published_cells_in_local_names` -- fails at "SPILLED VALUES ARE NOT LAID".
#[test]
fn a_laid_versions_spilled_values_are_left_to_the_recalculation() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    // Data: A1:A5 inputs, B1 = an array spilling B1:B5 (its spilled values
    // value-only cells, as the writer saves them), A6 a new input.
    let mut data = Sheet::new("Data".to_string());
    for r in 0..6u32 {
        data.cells.insert((r, 0), SavedCell::from_cell(&Cell::new_number(f64::from(r + 1))));
    }
    let mut origin = SavedCell::from_cell(&Cell::new_formula("SEQUENCE(5)".to_string()));
    origin.spill = Some((4, 1));
    data.cells.insert((0, 1), origin);
    for r in 1..5u32 {
        data.cells.insert((r, 1), SavedCell::from_cell(&Cell::new_number(f64::from(r + 1))));
    }
    let mut wb = Workbook::default();
    wb.sheets = vec![data];
    let data_id = wb.sheets[0].id.to_string();
    publish_sheets(&dir, prof.path(), &wb, vec![0]);

    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let manifest = reg.get_version_manifest("literals", "1.0.0").unwrap();
    let positions = [(0, 1), (1, 1), (4, 1), (5, 0), (7, 7)];
    let none = std::collections::HashSet::new();
    let read = |local: Option<&std::collections::HashSet<(u32, u32)>>| {
        crate::calp_commands::published_cells_in_local_names(
            &reg,
            "literals",
            "1.0.0",
            &manifest,
            &data_id,
            &positions,
            &calp::sheet_renames::SheetRenames::default(),
            local,
        )
        .expect("read")
        .expect("the version has the sheet")
    };
    let laid: Vec<((u32, u32), bool)> = read(Some(&none)).into_iter().map(|(p, c)| (p, c.is_some())).collect();
    assert_eq!(
        laid,
        vec![((0, 1), true), ((1, 1), false), ((4, 1), false), ((5, 0), true), ((7, 7), false)],
        "SPILLED VALUES ARE NOT LAID: the origin and the input are cells; B2, B5 and an absent cell are empty"
    );
    // Positive control: read as saved, B2 and B5 are the version's values (the
    // diff views and the materialize tests read this way).
    let raw = read(None);
    assert_eq!(raw.len(), positions.len());
    assert!(raw[1].1.is_some() && raw[2].1.is_some(), "as saved, the spilled values are value-only cells");

    // The helper itself: the extent minus the origin, and nothing for a
    // value-only cell that merely carries an `sp` (no formula, no array).
    let parsed: calcula_format::sheet_data::SheetData = serde_json::from_slice(
        &reg.read_artifact("literals", "1.0.0", &format!("sheets/{data_id}/data.json")).unwrap().unwrap(),
    )
    .unwrap();
    let derived = crate::calp_commands::published_spill_outputs(&parsed);
    let mut derived: Vec<(u32, u32)> = derived.into_iter().collect();
    derived.sort_unstable();
    assert_eq!(derived, vec![(1, 1), (2, 1), (3, 1), (4, 1)]);
}

/// A SHEET SWAPPED AFTER IT WAS VERIFIED is refused, not written into the
/// working copy. The merge and the hold-back verify a version (every artifact
/// walked), then read one sheet AGAIN; a share-writer racing that window could
/// replace the sheet's bytes after both the signature and the signer check,
/// and the swapped cells rode the next signed push. The read now re-checks the
/// bytes against the checksum the verified manifest records.
///
/// SABOTAGE: drop the `sha256_hex(&bytes) != *expected` check from
/// `published_cells_in_local_names`.
#[test]
fn a_published_sheet_swapped_after_verification_is_refused() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let h = checked_out_over_own_data(&dir, prof.path());
    let report_id = h.state.sheet_ids.read().unwrap()[h.index_of("Report")].to_string();
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    // What the caller verified.
    let manifest = reg.get_version_manifest("literals", "1.0.0").unwrap();
    let rel = format!("sheets/{report_id}/data.json");
    let read = |manifest: &calp::manifest::VersionManifest| {
        crate::calp_commands::published_cells_in_local_names(
            &reg,
            "literals",
            "1.0.0",
            manifest,
            &report_id,
            &[(0, 0)],
            &calp::sheet_renames::SheetRenames::default(),
            None,
        )
    };
    // Positive control: the verified bytes read.
    assert!(read(&manifest).expect("the verified sheet reads").is_some());

    // The race: the sheet's bytes change after the walk.
    let genuine = reg.read_artifact("literals", "1.0.0", &rel).unwrap().unwrap();
    // Any change to the bytes is a swap; still valid JSON, so only the
    // checksum can tell.
    let swapped = format!("{} ", String::from_utf8(genuine).unwrap());
    let path = reg.version_dir("literals", "1.0.0").unwrap().join(&rel);
    std::fs::write(&path, swapped.as_bytes()).unwrap();
    let err = match read(&manifest) {
        Ok(_) => panic!("swapped bytes were read into the working copy"),
        Err(e) => e,
    };
    assert!(err.contains("does not match the checksum"), "{err}");

    // A manifest that does not vouch for the sheet at all vouches for nothing.
    let mut silent = manifest.clone();
    silent.artifact_checksums.remove(&rel);
    let err = match read(&silent) {
        Ok(_) => panic!("a sheet the manifest does not vouch for was read"),
        Err(e) => e,
    };
    assert!(err.contains("records no checksum"), "{err}");
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
    assert_eq!(names.get(&identity::sheet_name_key("data (2)")).map(String::as_str), Some("Data"), "{names:?}");
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
        None,
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
        Some("#REF!A1*3"),
        "the refreshed formula reads the subscriber's own 'Data' ({:?})",
        grids[report].get_cell(0, 0).map(|c| c.display_value())
    );
    assert_ne!(number_at(&grids[report], 0, 0), Some(3000.0));
}

/// NEW-calp-gone-walker-ref. The SAME deletion, written by its two writers: the
/// host's sheet delete (`repair_formula_text_on_delete_at`, the cells' own
/// rule) and the `.calp` gone-walker a refresh and an override's baseline go
/// through (`SheetRenames::with_gone`). Both must write Excel's text -- the
/// reference keeps its cell part and reads `#REF!` where the sheet was
/// (`=#REF!A1`, `SUM(#REF!A1:A3)`) [LIVE, Excel 16, 2026-11-05,
/// sheetspill/probe1.ps1]. The walker wrote the whole reference as `#REF!`, so
/// a refresh's rewrite of an untouched upstream formula never matched the cell
/// the subscriber's own delete had repaired.
///
/// SABOTAGE: make the gone arm of `walk_sheet_slots` write `ref_error()` again.
#[test]
fn the_refresh_gone_walker_and_the_sheet_delete_write_one_text() {
    let gone = calp::sheet_renames::SheetRenames::default().with_gone(["Data"]);
    // Sheet1, Data (deleted, index 1), Other.
    let after = vec!["Sheet1".to_string(), "Other".to_string()];
    for formula in [
        "=Data!A1",
        "=Data!$A$1*2",
        "=SUM(Data!A1:A3)+1",
        "=SUM(Data!A:A)",
        "=SUM(Data!1:3)",
        "=SUM(Data:Data!B1)",
        "=@Data!A1:A9",
        "=SUM(Data!A1#)",
        "=-Data!A1",
        "=Other!A1+Data!B2",
        "=IF(Data!A1>0,Data!B1,Other!C1)",
    ] {
        let by_delete = crate::repair_formula_text_on_delete_at(formula, "Data", 1, &after)
            .unwrap_or_else(|| panic!("the delete repairs {formula}"));
        let by_refresh = gone.rename_formula(formula).unwrap_or_else(|| panic!("the walker rewrites {formula}"));
        assert_eq!(by_refresh, by_delete, "one deletion, two texts for {formula}");
        assert!(by_delete.contains("#REF!"), "{by_delete}");
    }
    assert_eq!(gone.rename_formula("=SUM(Data!A1:A3)").as_deref(), Some("=SUM(#REF!A1:A3)"));

    // A 3-D SPAN with the deleted sheet as an endpoint (BUG-0751): both move
    // the endpoint inward over the tabs [LIVE, lane namescalp p2.ps1], the
    // walker given the tabs' order as the refresh and the delete give it.
    // Sheet1, Mid, Data (deleted, index 2), Other.
    let after4 = vec!["Sheet1".to_string(), "Mid".to_string(), "Other".to_string()];
    let gone4 = calp::sheet_renames::SheetRenames::default()
        .with_gone(["Data"])
        .with_span_order(["Sheet1", "Mid", "Data", "Other"]);
    for (formula, expected) in [
        ("=SUM(Sheet1:Data!A1)", "=SUM(Sheet1:Mid!A1)"),
        ("=SUM(Data:Other!A1)", "=SUM(Other!A1)"),
        ("=SUM(Mid:Data!A1:B2)", "=SUM(Mid!A1:B2)"),
    ] {
        let by_delete = crate::repair_formula_text_on_delete_at(formula, "Data", 2, &after4)
            .unwrap_or_else(|| panic!("the delete repairs {formula}"));
        let by_refresh = gone4.rename_formula(formula).unwrap_or_else(|| panic!("the walker rewrites {formula}"));
        assert_eq!(by_delete, expected, "the host's span rule for {formula}");
        assert_eq!(by_refresh, by_delete, "ONE SPAN TEXT: one deletion, two texts for {formula}");
    }
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
            &h.pivot,
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

// ---------------------------------------------------------------------------
// BUG-0261: the base record of a checkout's Custom Functions
// ---------------------------------------------------------------------------

/// A Custom Functions library record holding `functions` (name, body).
fn function_library(functions: &[(&str, &str)]) -> persistence::SavedScript {
    let functions: Vec<serde_json::Value> = functions
        .iter()
        .map(|(name, body)| serde_json::json!({ "name": name, "params": [], "body": body }))
        .collect();
    persistence::SavedScript {
        id: crate::calp_push_scope::CUSTOM_FUNCTIONS_LIB_ID.to_string(),
        name: "Custom Functions (data)".to_string(),
        description: None,
        source: serde_json::json!({ "functions": functions }).to_string(),
        scope: persistence::SavedScriptScope::Workbook,
        source_package: None,
    }
}

/// A CHECKOUT RECORDS THE FUNCTIONS ITS MERGE APPLIED, NOT THE ONES IT SKIPPED
/// (BUG-0261). Checkout is additive and the pull merges the application's
/// library into the developer's PER FUNCTION, keeping the developer's own
/// function when the names collide. The base record must name only what
/// landed: had it named the incoming `RATE`, the developer's own `RATE` -- the
/// one the merge kept -- would ship as the application's on the next push,
/// signed under their key, and replace the application's `RATE` for every
/// subscriber.
///
/// Through the REAL publish, checkout pull and materializer, then the push
/// filter over what the working copy holds.
///
/// SABOTAGE: read every function in `custom_function_keys_applied_by`
/// (`library_function_keys(.., None)`) -- the developer's `RATE` and `PRIVATE`
/// are then recorded as the application's and ship.
#[test]
fn a_checkout_records_the_functions_its_merge_applied_not_the_ones_it_skipped() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut published = mixed_workbook();
    published.scripts = vec![function_library(&[("APPFN", "return 1"), ("RATE", "return 0.25")])];
    publish_sheets(&dir, prof.path(), &published, vec![0]);

    // The developer's workbook already has a library of their own, with a
    // function named like the application's and one that reaches the network.
    let h = Harness::new();
    {
        let mine = function_library(&[
            ("RATE", "return 0.5"),
            ("PRIVATE", "return fetch('https://example.invalid')"),
        ]);
        h.scripts.workbook_scripts.write(&test_effect()).unwrap().insert(
            mine.id.clone(),
            crate::scripting::types::WorkbookScript {
                id: mine.id.clone(),
                name: mine.name.clone(),
                description: None,
                source: mine.source.clone(),
                scope: crate::scripting::types::ScriptScope::Workbook,
                source_package: None,
            },
        );
    }
    let pulled = checkout_pull(&dir, prof.path());
    let base_script_ids: Vec<String> = pulled.module_scripts.iter().map(|s| s.id.clone()).collect();
    h.materialize(pulled, MaterializeMode::Checkout);

    let recorded = crate::calp_commands::custom_function_keys_applied_by(&h.scripts, "literals")
        .expect("the library reads");
    assert_eq!(recorded, vec!["APPFN"], "only what the merge applied is the application's");

    // The next push, filtered against that record.
    let workspace = dir.path().to_string_lossy().to_string();
    let mut link = calp::WorkingCopyLink::new(
        &workspace,
        "literals",
        "report",
        "1.0.0",
        "2026-09-30T00:00:00Z",
        Vec::new(),
    );
    link.record_content(calp::WorkingCopyContent {
        script_ids: base_script_ids,
        custom_function_names: recorded,
        ..calp::WorkingCopyContent::default()
    });
    let live = h
        .scripts
        .workbook_scripts
        .read()
        .unwrap()
        .get(crate::calp_push_scope::CUSTOM_FUNCTIONS_LIB_ID)
        .cloned()
        .expect("the merged library");
    let mut carrier = Workbook::default();
    carrier.scripts = vec![persistence::SavedScript {
        id: live.id,
        name: live.name,
        description: live.description,
        source: live.source,
        scope: persistence::SavedScriptScope::Workbook,
        source_package: live.source_package,
    }];
    let mut object_scripts = None;
    let withheld = crate::calp_push_scope::withhold_content_not_in_application(
        &mut carrier,
        &mut object_scripts,
        &crate::calp_push_scope::PushScope {
            registry_path: &workspace,
            package_name: "literals",
            link: Some(&link),
            subscriptions: &[],
            published_sheets: &[],
            included: &[],
        },
    )
    .withheld;

    let shipped: serde_json::Value = serde_json::from_str(&carrier.scripts[0].source).unwrap();
    let shipped: Vec<(&str, &str)> = shipped["functions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["name"].as_str().unwrap(), f["body"].as_str().unwrap()))
        .collect();
    assert_eq!(
        shipped,
        vec![("APPFN", "return 1")],
        "the application's function ships, and only it"
    );
    let mut named: Vec<(&str, crate::calp_push_scope::WithheldReason)> =
        withheld.iter().map(|w| (w.name.as_str(), w.reason)).collect();
    named.sort_by(|a, b| a.0.cmp(b.0));
    assert_eq!(
        named,
        vec![
            ("PRIVATE", crate::calp_push_scope::WithheldReason::NotInApplication),
            ("RATE", crate::calp_push_scope::WithheldReason::NotInApplication),
        ],
        "the developer's own functions stay home, named"
    );
}

/// The checkout command takes its function record AFTER the materializer ran
/// (before it there is nothing merged to read) and BEFORE it writes the link.
/// A census of the command body, because the command itself needs a window.
///
/// SABOTAGE: delete the `custom_function_keys_applied_by(` line from
/// `calp_checkout`.
#[test]
fn checkout_records_its_functions_after_the_merge_and_before_the_link() {
    let body = calp_commands_fn_code("pub fn calp_checkout(");
    let merged = body.find("materialize_pull_result(").expect("checkout materializes");
    let read = body
        .find("custom_function_keys_applied_by(")
        .expect("checkout no longer records the functions its merge applied");
    let linked = body.find(".record_content(").expect("checkout records the base content");
    assert!(merged < read && read < linked, "materialize, then read the merge, then record");
    assert!(
        body.contains("base_content.custom_function_names ="),
        "the functions read back are the ones recorded"
    );
}

// ---------------------------------------------------------------------------
// BUG-0263: a slicer's COMPUTED PROPERTIES travel -- to a working copy and back
// out of it unchanged, and to a subscriber, live.
// ---------------------------------------------------------------------------

/// A computed property of the test slicer, as the store holds it.
fn slicer_prop(id: identity::EntityId, attribute: &str, formula: &str) -> persistence::SavedSlicerComputedProperty {
    persistence::SavedSlicerComputedProperty {
        id,
        attribute: attribute.to_string(),
        formula: formula.to_string(),
    }
}

/// ["Data" (A1 = 300), "Report" (A1 = 3)] and one slicer on Report whose width
/// follows `=Data!A1+A1` (a CROSS-sheet reference, so a collision rename has
/// something to rewrite) and whose column count follows `=A1`. The saved
/// attributes are the values those formulas last produced (303 wide, 3
/// columns), as a real save writes them.
fn report_with_a_computed_slicer() -> (Workbook, identity::EntityId) {
    let mut data = Sheet::new("Data".to_string());
    data.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(300.0)));
    let mut report = Sheet::new("Report".to_string());
    report.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(3.0)));
    let report_id = report.id;
    let slicer_id = new_entity();
    let mut wb = Workbook::default();
    wb.sheets = vec![data, report];
    wb.slicers = vec![persistence::SavedSlicer {
        id: slicer_id,
        name: "ByRegion".to_string(),
        header_text: None,
        sheet_id: report_id,
        x: 40.0,
        y: 60.0,
        width: 303.0,
        height: 220.0,
        source_type: persistence::SavedSlicerSourceType::Table,
        cache_source_id: new_entity(),
        field_name: "Region".to_string(),
        selected_items: None,
        show_header: true,
        columns: 3,
        style_preset: "SlicerStyleLight1".to_string(),
        selection_mode: persistence::SavedSlicerSelectionMode::default(),
        hide_no_data: false,
        indicate_no_data: true,
        sort_no_data_last: true,
        force_selection: false,
        show_select_all: false,
        arrangement: persistence::SavedSlicerArrangement::default(),
        rows: 0,
        item_gap: 4.0,
        autogrid: true,
        item_padding: 0.0,
        button_radius: 2.0,
        computed_properties: vec![
            slicer_prop(new_entity(), "width", "=Data!A1+A1"),
            slicer_prop(new_entity(), "columns", "=A1"),
        ],
        connected_sources: Vec::new(),
        filter_level: 1,
        data_source_id: None,
        container: None,
    }];
    (wb, slicer_id)
}

/// The live formulas of one slicer, by attribute.
fn live_slicer_formulas(h: &Harness, slicer: identity::EntityId) -> std::collections::BTreeMap<String, String> {
    h.slicer
        .computed_properties
        .read()
        .unwrap()
        .get(&slicer)
        .map(|props| props.iter().map(|p| (p.attribute.clone(), p.formula.clone())).collect())
        .unwrap_or_default()
}

/// Write Report!A1 and re-evaluate the slicer properties that depend on it,
/// exactly as the recalculation flow does (`commands/data.rs`).
fn edit_and_reevaluate(h: &Harness, sheet: usize, value: f64) -> std::collections::HashSet<identity::EntityId> {
    let effect = test_effect();
    h.state.grids.write(&effect).unwrap()[sheet].set_cell(0, 0, Cell::new_number(value));
    let grids = h.state.grids.read().unwrap();
    let names = h.state.sheet_names.read().unwrap();
    let styles = h.state.style_registry.read().unwrap();
    crate::slicer::computed::re_evaluate_slicer_computed_properties(
        &effect,
        &[(sheet, 0, 0)],
        &grids,
        &names,
        &std::collections::HashMap::new(),
        &std::collections::HashMap::new(),
        &styles,
        &h.slicer,
        None,
    )
}

/// SUBSCRIBE. The application's slicer arrives WITH its computed properties,
/// installed with the dependency index they are re-evaluated through, and the
/// cross-sheet formula follows the collision rename: the subscriber owns a
/// "Data" (A1 = 1000), so the application's arrives as "Data (2)", and a width
/// computed from the subscriber's own sheet would be 1005, not 305.
///
/// SABOTAGE (each alone): put the `computed_properties = Vec::new()` strip back
/// on the pull door; drop `rename_slicer_formulas` from `rename_pull`.
#[test]
fn a_subscriber_receives_the_slicers_computed_properties_live_on_the_renamed_sheet() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let (wb, slicer) = report_with_a_computed_slicer();
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 0, 0), None);
    let h = harness_with_own_data();
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);

    let report = h.index_of("Report");
    h.index_of("Data (2)");
    let formulas = live_slicer_formulas(&h, slicer);
    assert_eq!(
        formulas.get("width").map(String::as_str),
        Some("='Data (2)'!A1+A1"),
        "the slicer's computed properties did not arrive, or still name the subscriber's own Data: {formulas:?}"
    );
    assert_eq!(formulas.get("columns").map(String::as_str), Some("=A1"));

    // LIVE, not merely listed: editing the cell they read moves the slicer.
    let modified = edit_and_reevaluate(&h, report, 5.0);
    assert!(modified.contains(&slicer), "no computed property re-evaluated: the dependency index is empty");
    let slicers = h.slicer.slicers.read().unwrap();
    assert_eq!(slicers[&slicer].columns, 5, "columns follows =A1");
    assert_eq!(
        slicers[&slicer].width, 305.0,
        "width must read the APPLICATION's Data (300 + 5), never the subscriber's own (1000 + 5)"
    );
}

/// REFRESH. v2 changes the width formula; the refresh replaces the
/// application's slicer, computed properties and all, through the same
/// materializer -- renamed onto "Data (2)" like the first pull.
///
/// SABOTAGE: put the `computed_properties = Vec::new()` strip back on the
/// refresh door.
#[test]
fn a_refresh_brings_the_new_versions_computed_properties() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let (mut wb, slicer) = report_with_a_computed_slicer();
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 0, 0), None);
    let h = harness_with_own_data();
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);

    wb.slicers[0].computed_properties[0].formula = "=Data!A1+A1*2".to_string();
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);

    let formulas = live_slicer_formulas(&h, slicer);
    assert_eq!(
        formulas.get("width").map(String::as_str),
        Some("='Data (2)'!A1+A1*2"),
        "the refresh dropped v2's computed properties: {formulas:?}"
    );
    let report = h.index_of("Report");
    edit_and_reevaluate(&h, report, 5.0);
    assert_eq!(h.slicer.slicers.read().unwrap()[&slicer].width, 310.0, "v2's width is live: 300 + 5*2");
}

/// CHECKOUT, then an untouched push: the application's `slicers.json` comes
/// back BYTE FOR BYTE. Checkout used to empty every slicer's computed
/// properties, so this push republished the slicer without them. The author's
/// own "Data" sends the application's in as "Data (2)"; the checkout renames
/// the slicer's reference to follow it and the push puts it back
/// (`restore_published_sheet_references`), exactly as it does for a cell.
///
/// SABOTAGE (each alone): put the strip back on the pull door (the push loses
/// the properties); drop the slicer loop from
/// `restore_published_sheet_references` (the push ships "Data (2)").
#[test]
fn an_untouched_push_republishes_the_slicers_computed_properties_byte_for_byte() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let (wb, slicer) = report_with_a_computed_slicer();
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 0, 0), None);
    let h = harness_with_own_data();
    h.materialize(checkout_pull(&dir, prof.path()), MaterializeMode::Checkout);
    h.index_of("Data (2)");
    assert_eq!(
        live_slicer_formulas(&h, slicer).get("width").map(String::as_str),
        Some("='Data (2)'!A1+A1"),
        "the working copy's slicer reads the application's Data"
    );

    // The push carrier: the application's sheets, this workbook's slicers --
    // what `build_workbook_for_save_with_slicers` collects -- with the
    // published names put back, as `assemble_publish_workbook` does.
    let mut carrier = wb.clone();
    carrier.slicers =
        crate::persistence::collect_slicers_for_save(&h.slicer, &h.state.sheet_ids.read().unwrap());
    let published: std::collections::HashMap<String, String> =
        [("data (2)".to_string(), "Data".to_string())].into_iter().collect();
    let counts = crate::calp_commands::restore_published_sheet_references(&mut carrier, &[0, 1], &published);
    assert_eq!(counts.slicer_formulas, 1, "the slicer's reference is restored to the published name");
    publish_as(&dir, prof.path(), &carrier, vec![0, 1], "literals", (1, 0, 1), Some((1, 0, 0)));

    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let base = reg.read_artifact("literals", "1.0.0", "slicers.json").unwrap().expect("v1.0.0 has slicers");
    let pushed = reg.read_artifact("literals", "1.0.1", "slicers.json").unwrap().expect("v1.0.1 has slicers");
    assert_eq!(
        String::from_utf8_lossy(&pushed),
        String::from_utf8_lossy(&base),
        "an untouched push changed the application's slicers"
    );
}

/// No door strips a slicer's computed properties any more, and nothing may
/// quietly bring the strip back under another name.
///
/// SABOTAGE: re-add a `computed_properties = Vec::new()` anywhere in
/// `calp_commands.rs`.
#[test]
fn no_door_strips_a_slicers_computed_properties() {
    let src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/calp_commands.rs"),
    )
    .expect("cannot read calp_commands.rs");
    let code: String = src
        .lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!code.contains("sanitize_distributed_slicers"), "the slicer strip is back");
    assert!(
        !code.contains("computed_properties = Vec::new()"),
        "a door empties slicers' computed properties again"
    );
}

// ===========================================================================
// BUG-0449 / D-NAV: page targets follow the subscriber's sheets on every pull
// ===========================================================================

/// The canvases "Sales" and "Detail". On Sales: a navigate button at (1, 1)
/// whose action targets Detail by id and name, and a Page Navigator at (2, 1)
/// with an override on Detail (caption "Details") and the given `gap`.
fn sales_and_detail(gap: &str) -> Workbook {
    let mut sales = Sheet::new("Sales".to_string());
    sales.kind = persistence::SheetKind::new_canvas();
    let mut detail = Sheet::new("Detail".to_string());
    detail.kind = persistence::SheetKind::new_canvas();
    let (sales_id, detail_id) = (sales.id, detail.id);
    let overrides = calcula_format::page_navigator::serialize_page_overrides(&[
        calcula_format::page_navigator::PageOverrideWire {
            sheet_id: detail_id.to_string(),
            sheet_name: "Detail".to_string(),
            text: Some("Details".to_string()),
            hidden: None,
            fill: None,
            color: None,
            border_color: None,
        },
    ]);
    let mut wb = Workbook::default();
    wb.sheets = vec![sales, detail];
    wb.controls = vec![persistence::SavedSheetControls {
        sheet_id: sales_id,
        // Every control a build publishes carries its stable uid (WP-D S5a).
        controls: serde_json::json!([
            { "row": 1, "col": 1, "controlType": "button", "uid": "app-nav-button", "properties": {
                "text": static_prop("Go to detail"),
                "pinToGrid": static_prop("false"),
                "action": static_prop("navigate"),
                "actionTarget": static_prop(&detail_id.to_string()),
                "actionTargetName": static_prop("Detail") } },
            { "row": 2, "col": 1, "controlType": "pageNavigator", "uid": "app-navigator", "properties": {
                "pinToGrid": static_prop("false"),
                "orientation": static_prop("horizontal"),
                "gap": static_prop(gap),
                "pageOverrides": static_prop(&overrides) } }
        ]),
    }];
    wb
}

/// A harness whose one sheet is the subscriber's (or author's) OWN "Detail".
fn harness_with_own_detail() -> Harness {
    let h = Harness::new();
    h.state.sheet_names.write(&test_effect()).unwrap()[0] = "Detail".to_string();
    h
}

/// The live (button, navigator) pair on the sheet named `sales`.
fn page_target_controls(h: &Harness, sales: &str) -> (crate::controls::ControlMetadata, crate::controls::ControlMetadata) {
    let idx = h.index_of(sales);
    let controls = h.state.controls.read().unwrap();
    (
        controls.get(&(idx, 1, 1)).expect("the navigate button landed").clone(),
        controls.get(&(idx, 2, 1)).expect("the page navigator landed").clone(),
    )
}

/// The one override of a navigator, parsed.
fn the_override(nav: &crate::controls::ControlMetadata) -> calcula_format::page_navigator::PageOverrideWire {
    let raw = &nav.properties["pageOverrides"].value;
    let mut list = calcula_format::page_navigator::parse_page_overrides(raw).expect("the overrides still parse");
    assert_eq!(list.len(), 1, "{raw}");
    list.remove(0)
}

fn local_sheet_id(h: &Harness, name: &str) -> String {
    h.state.sheet_ids.read().unwrap()[h.index_of(name)].to_string()
}

/// BUG-0449 at SUBSCRIBE. The subscriber owns "Detail", so the application's
/// arrives as "Detail (2)". The navigate button's `actionTarget` and the
/// navigator override's `sheetId` named the APPLICATION's id, which resolves to
/// nothing here, so a click fell back to the name "Detail" -- the subscriber's
/// own sheet. Ids now follow the local sheet (`controls.rs`), names follow the
/// collision rename (`sheet_renames`).
///
/// SABOTAGE: pass `PageTargetRemap::identity()` in `materialize_pull_result` ->
/// the id assertions go red.
#[test]
fn bug_0449_a_subscribed_navigate_button_and_navigator_go_to_the_pulled_page_after_a_collision_rename() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let wb = sales_and_detail("8");
    let app_detail = wb.sheets[1].id.to_string();
    publish_sheets(&dir, prof.path(), &wb, vec![0, 1]);
    let h = harness_with_own_detail();
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);

    let pulled_detail = local_sheet_id(&h, "Detail (2)");
    assert_ne!(pulled_detail, app_detail, "precondition: a subscribe gives the pulled sheet an id of its own");
    assert_ne!(pulled_detail, local_sheet_id(&h, "Detail"), "precondition: not the subscriber's own Detail");
    let (button, nav) = page_target_controls(&h, "Sales");
    assert_eq!(button.properties["actionTarget"].value, pulled_detail, "the button's id names the pulled page");
    assert_eq!(button.properties["actionTargetName"].value, "Detail (2)", "and so does its name fallback");
    assert_eq!(button.properties["action"].value, "navigate", "the action stays live");
    let o = the_override(&nav);
    assert_eq!(o.sheet_id, pulled_detail, "the navigator override's id names the pulled page");
    assert_eq!(o.sheet_name, "Detail (2)");
    assert_eq!(o.text.as_deref(), Some("Details"), "the caption survives the rewrite");
}

/// BUG-0449 at REFRESH -- the door that throws the controls away and
/// re-materialises them. The subscriber renamed "Detail (2)" to "Detail Local"
/// after subscribing; v2 still ships the button and the navigator (with a new
/// gap, the proof the refresh replaced them). Both must name the LOCAL id of
/// "Detail Local" and its local name.
///
/// SABOTAGE: pass `PageTargetRemap::identity()` in `apply_refresh_payloads` ->
/// red (with every other test green, BUG-0449 would return after the first
/// refresh).
#[test]
fn a_refreshed_navigate_button_and_navigator_keep_their_local_page_targets() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let wb = sales_and_detail("8");
    let app_detail = wb.sheets[1].id.to_string();
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 0, 0), None);
    let h = harness_with_own_detail();
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    let pulled = h.index_of("Detail (2)");
    crate::sheets::rename_sheet_inner(
        &h.state,
        &crate::persistence::FileState::default(),
        &h.pivot,
        pulled,
        "Detail Local".to_string(),
        false,
    )
    .expect("the subscriber renames the pulled page");
    let local = local_sheet_id(&h, "Detail Local");

    publish_as(&dir, prof.path(), &sales_and_detail_v2(&wb), vec![0, 1], "literals", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);

    assert_eq!(local_sheet_id(&h, "Detail Local"), local, "precondition: the refresh kept the local sheet");
    let (button, nav) = page_target_controls(&h, "Sales");
    assert_eq!(nav.properties["gap"].value, "24", "the refresh replaced the navigator with v2's");
    assert_ne!(local, app_detail);
    assert_eq!(button.properties["actionTarget"].value, local);
    assert_eq!(button.properties["actionTargetName"].value, "Detail Local");
    let o = the_override(&nav);
    assert_eq!(o.sheet_id, local);
    assert_eq!(o.sheet_name, "Detail Local");
}

/// v2 of `sales_and_detail`: the same sheets (same ids), the navigator's gap 24.
fn sales_and_detail_v2(v1: &Workbook) -> Workbook {
    let mut v2 = v1.clone();
    if let Some(entries) = v2.controls[0].controls.as_array_mut() {
        entries[1]["properties"]["gap"] = static_prop("24");
    }
    v2
}

/// The WIRING: every pull door states its page-target rule as `from_pull`,
/// and no door in calp_commands.rs passes `identity()` (that is for `.cala`
/// load and unit tests only) -- a door passing it would compile and pass every
/// unit test while a subscriber's navigation opened the wrong page.
///
/// SABOTAGE: pass `PageTargetRemap::identity()` at any one door.
#[test]
fn no_pull_door_materializes_controls_with_an_identity_page_remap() {
    let from_pull = ["PageTargetRemap", "::from_pull("].concat();
    for signature in [
        "pub(crate) fn materialize_pull_result(",
        "pub(crate) fn apply_refresh_payloads(",
        "fn materialize_dev_controls(",
    ] {
        let code = calp_commands_fn_code(signature);
        assert!(code.contains("materialize_saved_controls("), "{signature} no longer materializes controls");
        assert!(code.contains(&from_pull), "{signature} does not build its page-target remap with from_pull");
    }
    let src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/calp_commands.rs"),
    )
    .expect("cannot read calp_commands.rs");
    let code: String = src
        .lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let identity = ["PageTargetRemap", "::identity("].concat();
    assert!(!code.contains(&identity), "a .calp door materializes controls with an identity page-target remap");
}

/// CHECKOUT + PUSH. The author owns "Detail", so the application's arrives in
/// the working copy as "Detail (2)" -- with the APPLICATION's id (a checkout
/// keeps ids). The working copy's targets read the local name; an untouched
/// push puts the published name back and republishes the controls byte for
/// byte.
///
/// SABOTAGE: drop the `visit_control_page_target_names` call from
/// `rename_control_entries` (the working copy keeps "Detail", the
/// author's own sheet), or re-serialise unconditionally in the remap.
#[test]
fn an_untouched_checkout_push_republishes_navigator_targets_byte_for_byte() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let wb = sales_and_detail("8");
    let app_detail = wb.sheets[1].id.to_string();
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 0, 0), None);
    let h = harness_with_own_detail();
    h.materialize(checkout_pull(&dir, prof.path()), MaterializeMode::Checkout);

    assert_eq!(local_sheet_id(&h, "Detail (2)"), app_detail, "precondition: a checkout keeps the application's ids");
    let (button, nav) = page_target_controls(&h, "Sales");
    assert_eq!(button.properties["actionTarget"].value, app_detail);
    assert_eq!(button.properties["actionTargetName"].value, "Detail (2)", "the working copy's name, not the author's own");
    let o = the_override(&nav);
    assert_eq!(o.sheet_id, app_detail);
    assert_eq!(o.sheet_name, "Detail (2)");

    let mut carrier = wb.clone();
    carrier.controls =
        crate::controls::collect_controls_for_save(&h.state.controls.read().unwrap(), &h.state.sheet_ids.read().unwrap());
    let published: std::collections::HashMap<String, String> =
        [("detail (2)".to_string(), "Detail".to_string())].into_iter().collect();
    let counts = crate::calp_commands::restore_published_sheet_references(&mut carrier, &[0, 1], &published);
    assert_eq!(counts.controls, 2, "the button's and the override's names are restored");
    publish_as(&dir, prof.path(), &carrier, vec![0, 1], "literals", (1, 0, 1), Some((1, 0, 0)));

    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let base = reg.read_artifact("literals", "1.0.0", "controls.json").unwrap().expect("v1.0.0 has controls");
    let pushed = reg.read_artifact("literals", "1.0.1", "controls.json").unwrap().expect("v1.0.1 has controls");
    assert_eq!(
        String::from_utf8_lossy(&pushed),
        String::from_utf8_lossy(&base),
        "an untouched push changed the application's page targets"
    );
}

// ===========================================================================
// A working copy keeps the application's writeback regions (2026-10-21).
// ===========================================================================

/// One writeback region over B3:B5 of `sheet`, as the designate dialog writes it.
fn writeback_region_on(sheet: identity::SheetId, id: &str) -> calp::WritebackRegionDeclaration {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "selector": {
            "sheetId": sheet.to_string(),
            "rowStart": 2, "rowEnd": 4, "colStart": 1, "colEnd": 1
        },
        "mode": "per_subscriber",
        "schema": { "valueType": "number", "required": false },
        "visibility": "own_plus_aggregate",
        "submissionPolicy": "on_submit"
    }))
    .expect("a valid declaration")
}

/// Publish sheet 0 of `wb` as "literals" v1.0.0 carrying `regions`.
fn publish_with_writeback(
    dir: &TempDir,
    prof: &Path,
    wb: &Workbook,
    regions: Vec<calp::WritebackRegionDeclaration>,
) {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let request = PublishRequest {
        workbook: wb,
        package_name: "literals".to_string(),
        version: SemVer::new(1, 0, 0),
        kind: "report".to_string(),
        mode: PushMode::CreateNew,
        change_summary: "first".to_string(),
        sheet_indices: vec![0],
        now: "2026-10-21T00:00:00Z".to_string(),
        published_by: "author".to_string(),
        writeback_regions: Some(regions),
        model_writebacks: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: Vec::new(),
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        identity_policy: None,
        min_app_version: String::new(),
    };
    publish::publish(&reg, &request, prof).expect("publish failed");
}

/// CHECKOUT hands the application's writeback regions back to the author as
/// this workbook's own designations, on the working copy's sheet, next to any
/// the author already had.
///
/// Before the fix checkout dropped them: the owner opened `writeback-test` for
/// editing and "could not see the writeback regions I had designated", and --
/// because a push publishes exactly `writeback_draft_regions` -- the next push
/// would have published the application with its regions silently removed.
///
/// SABOTAGE: empty the `MaterializeMode::Checkout` arm's region merge in
/// `materialize_pull_result`.
#[test]
fn a_checkout_keeps_the_applications_writeback_regions_as_the_authors_own() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Form".to_string())];
    let form = wb.sheets[0].id;
    let app_region = "01a15d70-0000-7000-8000-00000000a001";
    publish_with_writeback(&dir, prof.path(), &wb, vec![writeback_region_on(form, app_region)]);

    let h = Harness::new();
    // The author's own region on a sheet of their own, designated before the
    // checkout. Additive checkout must keep it.
    let own_sheet = new_sheet_id();
    let own_region = "01a15d70-0000-7000-8000-00000000b002";
    h.state
        .writeback_draft_regions
        .write(&test_effect())
        .unwrap()
        .push(writeback_region_on(own_sheet, own_region));

    let pulled = checkout_pull(&dir, prof.path());
    assert_eq!(pulled.writeback_regions.len(), 1, "the verified manifest's regions ride the pull");
    h.materialize(pulled, MaterializeMode::Checkout);

    let drafts = h.state.writeback_draft_regions.read().unwrap().clone();
    let ids: Vec<&str> = drafts.iter().map(|d| d.id.as_str()).collect();
    assert!(ids.contains(&own_region), "the author's own region survives the checkout: {ids:?}");
    let restored = drafts
        .iter()
        .find(|d| d.id == app_region)
        .unwrap_or_else(|| panic!("the application's region is the author's again: {ids:?}"));
    assert_eq!(restored.selector.sheet_id, form, "on the application's own sheet id");
    assert_eq!(
        (restored.selector.row_start, restored.selector.row_end),
        (2, 4),
        "exactly as signed",
    );
    let sheet_ids = h.state.sheet_ids.read().unwrap().clone();
    assert!(
        sheet_ids.contains(&form),
        "and that sheet IS in the working copy, so the frame and the push both find it",
    );
    assert_eq!(drafts.len(), 2, "nothing duplicated");
}

/// A SUBSCRIBE never makes the application's regions the subscriber's own
/// designations -- they arrive through the index, and the subscriber's next
/// publish of their own must not carry someone else's regions.
#[test]
fn a_subscribe_does_not_adopt_the_applications_writeback_regions() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Form".to_string())];
    let form = wb.sheets[0].id;
    publish_with_writeback(
        &dir,
        prof.path(),
        &wb,
        vec![writeback_region_on(form, "01a15d70-0000-7000-8000-00000000c003")],
    );
    let h = Harness::new();
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);
    assert!(
        h.state.writeback_draft_regions.read().unwrap().is_empty(),
        "a subscriber designated nothing",
    );
}

// ===========================================================================
// BUG-0588 -- a subscribed design-query chart finds its model. A chart binds
// its model by `data.connectionId`, a per-SESSION uuid; a pull mints a fresh
// connection for every embedded data source and every open re-mints it, and
// nothing rewrote the chart's uuid: BI pivots re-bound through their
// data-source id, slicers healed themselves, charts kept the PUBLISHER's uuid
// and found no model. The publisher's connection uuid IS the application
// data-source id at publish time (`let ds_id = conn.id.to_string()` in the
// push), which is the key the re-bind resolves by.
// ===========================================================================

/// A minimal BI model as published JSON: one table, one measure (the
/// `published_strategy_gate_tests` fixture in calp_commands.rs, verbatim).
fn sales_model_json() -> serde_json::Value {
    let model = bi_engine::DataModel::builder()
        .add_table(
            bi_engine::Table::new(
                "Sales",
                vec![
                    bi_engine::Column::new("Amount", bi_engine::DataType::Float64),
                    bi_engine::Column::new("Region", bi_engine::DataType::String),
                ],
            )
            .unwrap(),
        )
        .add_measure(bi_engine::sum_measure("Revenue", "Sales", "Amount"))
        .build()
        .expect("the fixture model builds");
    serde_json::to_value(&model).expect("the model serializes")
}

/// `publish_as`, with ONE embedded data source whose application id is
/// `publisher_connection` -- the publisher's connection uuid, exactly as the
/// push keys it (`collect_publish_data_sources`: `let ds_id = conn.id.to_string()`).
#[allow(clippy::too_many_arguments)]
fn publish_with_model(
    dir: &TempDir,
    prof: &Path,
    wb: &Workbook,
    sheet_indices: Vec<usize>,
    package: &str,
    version: (u32, u32, u32),
    base: Option<(u32, u32, u32)>,
    publisher_connection: &str,
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
        now: "2026-10-23T00:00:00Z".to_string(),
        published_by: "author".to_string(),
        writeback_regions: None,
        model_writebacks: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: vec![calp::publish::PublishDataSource {
            id: publisher_connection.to_string(),
            name: "Sales model".to_string(),
            connection_type: "embedded".to_string(),
            server: String::new(),
            database: String::new(),
            model_json: sales_model_json(),
            bindings: Vec::new(),
            calculated_table_snapshots: Vec::new(),
            writeback_history_json: None,
        }],
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        identity_policy: None,
        min_app_version: String::new(),
    };
    publish::publish(&reg, &request, prof).expect("publish failed");
}

/// A design-query chart ENVELOPE on `host`, bound to `connection` (a uuid
/// string) exactly as the Charts extension writes it: `{type: "designQuery",
/// dslText, connectionId}` -- no package key; the publisher never had one.
fn design_query_chart(host: identity::SheetId, connection: &str, name: &str) -> persistence::SavedChart {
    persistence::SavedChart {
        id: new_entity(),
        sheet_id: host,
        spec: serde_json::json!({
            "chartId": 1,
            "name": name,
            "sheetIndex": 0,
            "spec": {
                "mark": "bar",
                "data": {
                    "type": "designQuery",
                    "dslText": "ROWS: [Sales.Region]\nVALUES: [Revenue]",
                    "connectionId": connection
                },
                "series": []
            }
        }),
    }
}

/// `(spec.data.connectionId, spec.data.packageDataSourceId)` of a chart envelope.
fn spec_connection(spec_json: &str) -> (String, Option<String>) {
    let v: serde_json::Value = serde_json::from_str(spec_json).unwrap();
    (
        v["spec"]["data"]["connectionId"].as_str().unwrap_or_default().to_string(),
        v["spec"]["data"]["packageDataSourceId"].as_str().map(str::to_string),
    )
}

/// The live connection materialised for the application data source `ds_id`,
/// and how many connections carry that id (one, or the pull double-minted).
fn connection_for(h: &Harness, ds_id: &str) -> (identity::EntityId, usize) {
    let conns = h.bi.connections.lock().unwrap();
    let matching: Vec<identity::EntityId> = conns
        .iter()
        .filter(|(_, c)| c.package_data_source_id.as_deref() == Some(ds_id))
        .map(|(id, _)| *id)
        .collect();
    let first = *matching.first().expect("the application's data source was materialised");
    (first, matching.len())
}

/// `get_connection_bi_model`'s question, asked of the store: does the id the
/// chart now names have a connection with an engine behind it?
fn has_engine(h: &Harness, connection: &str) -> bool {
    let Some(id) = identity::EntityId::parse(connection) else {
        return false;
    };
    h.bi.connections.lock().unwrap().get(&id).is_some_and(|c| c.engine.is_some())
}

/// SUBSCRIBE: the pulled chart comes out naming the connection THIS pull
/// minted for the application's data source -- not the publisher's uuid, which
/// is no connection here -- and carries the stable package data-source id
/// beside it, so the next open can re-bind by it.
///
/// SABOTAGE: drop the `remap_chart_bi_connections` call after
/// `load_embedded_data_sources` in `materialize_pull_result` -- the first
/// `assert_eq!` on `connection_id` fails.
#[test]
fn a_subscribed_design_query_chart_is_bound_to_the_connection_the_pull_minted() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let publisher_connection = new_entity().to_string();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    let dashboard = wb.sheets[0].id;
    wb.charts = vec![design_query_chart(dashboard, &publisher_connection, "Revenue by region")];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None, &publisher_connection);

    let h = Harness::new();
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);

    let (live, minted) = connection_for(&h, &publisher_connection);
    assert_eq!(minted, 1, "one connection per embedded data source");
    assert_ne!(
        live.to_string(),
        publisher_connection,
        "the premise: a pull mints a FRESH uuid, so the publisher's names no connection here"
    );
    let charts = h.state.charts.read().unwrap();
    let chart = charts.iter().find(|c| c.id == wb.charts[0].id).expect("the chart landed");
    let (connection_id, package_key) = spec_connection(&chart.spec_json);
    assert_eq!(connection_id, live.to_string(), "bound to the connection the pull minted");
    assert_eq!(
        package_key.as_deref(),
        Some(publisher_connection.as_str()),
        "and the stable package data-source id is recorded beside it"
    );
    assert!(has_engine(&h, &connection_id), "the connection it names has a model behind it");
    // The query itself is untouched.
    let v: serde_json::Value = serde_json::from_str(&chart.spec_json).unwrap();
    assert_eq!(v["spec"]["data"]["dslText"], "ROWS: [Sales.Region]\nVALUES: [Revenue]");
    assert_eq!(v["name"], "Revenue by region");
}

/// A CHECKOUT re-binds too. Unlike the sheet ids a checkout preserves, the
/// connection uuid never survives a pull (the working copy mints its own), so
/// a design-query chart opened for editing would otherwise find no model
/// either. A range-bound chart in the same checkout still keeps its bytes
/// (`a_checked_out_chart_keeps_its_spec_bytes`): the walk touches design-query
/// sources only.
///
/// SABOTAGE: gate the re-bind on `MaterializeMode::Subscribe` as the sheet-id
/// remap is -- the `connection_id` assertion fails.
#[test]
fn a_checked_out_design_query_chart_is_bound_to_the_working_copys_connection() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let publisher_connection = new_entity().to_string();
    let mut wb = dashboard_and_data(); // Dashboard (a RANGE chart reading Data), Data
    let dashboard = wb.sheets[0].id;
    wb.charts.push(design_query_chart(dashboard, &publisher_connection, "Revenue by region"));
    publish_with_model(&dir, prof.path(), &wb, vec![0, 1], "literals", (1, 0, 0), None, &publisher_connection);
    let checked_out = checkout_pull(&dir, prof.path());
    let range_spec_published = checked_out.charts.iter().find(|c| c.id == wb.charts[0].id).unwrap().spec.clone();

    let h = Harness::new();
    h.empty_as_checkout_does();
    h.materialize(checked_out, MaterializeMode::Checkout);

    let (live, _) = connection_for(&h, &publisher_connection);
    let charts = h.state.charts.read().unwrap();
    let design = charts.iter().find(|c| c.id == wb.charts[1].id).expect("the design-query chart landed");
    let (connection_id, package_key) = spec_connection(&design.spec_json);
    assert_eq!(connection_id, live.to_string(), "the working copy's own connection");
    assert_eq!(package_key.as_deref(), Some(publisher_connection.as_str()));
    let range = charts.iter().find(|c| c.id == wb.charts[0].id).expect("the range chart landed");
    let stored: serde_json::Value = serde_json::from_str(&range.spec_json).unwrap();
    assert_eq!(stored, range_spec_published, "a range-bound chart is not rewritten by the re-bind");
}

/// REFRESH: v2's chart lands through `apply_refreshed_charts`, which has no
/// data-source map, still naming the publisher's uuid; the re-bind after the
/// refresh map is built points it at the EXISTING application connection (the
/// refresh swaps that connection's engine rather than minting a second one).
///
/// SABOTAGE: drop the chart re-bind beside `remap_slicer_bi_connections` in
/// `apply_refresh_payloads` -- the v2 `connection_id` assertion fails.
#[test]
fn a_refreshed_design_query_chart_is_bound_to_the_existing_application_connection() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let publisher_connection = new_entity().to_string();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    let dashboard = wb.sheets[0].id;
    wb.charts = vec![design_query_chart(dashboard, &publisher_connection, "Revenue v1")];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None, &publisher_connection);

    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    let (live_v1, _) = connection_for(&h, &publisher_connection);

    // v2 replaces the chart (a new id, as a re-created chart has).
    wb.charts = vec![design_query_chart(dashboard, &publisher_connection, "Revenue v2")];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 1, 0), Some((1, 0, 0)), &publisher_connection);
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);

    let (live_v2, minted) = connection_for(&h, &publisher_connection);
    assert_eq!(minted, 1, "the refresh re-used the connection rather than minting a second");
    assert_eq!(live_v2, live_v1, "the same connection serves v2");
    let charts = h.state.charts.read().unwrap();
    let chart = charts.iter().find(|c| c.id == wb.charts[0].id).expect("v2's chart landed");
    let (connection_id, package_key) = spec_connection(&chart.spec_json);
    assert_eq!(connection_id, live_v2.to_string(), "v2's chart names the live connection");
    assert_eq!(package_key.as_deref(), Some(publisher_connection.as_str()));
    assert!(has_engine(&h, &connection_id));
}

/// THE WIRING AND ITS ORDER, which the behavioural tests above cannot pin for
/// the open path (`restore_application_bi_connections` verifies against the
/// real profile's pins, so no temp workspace reaches it): each of the three
/// doors re-binds charts AFTER the connections it binds them to exist -- the
/// pull after `load_embedded_data_sources`, the refresh after the full
/// data-source map (beside the slicer remap), the open path after its loader
/// loop -- and the open path does it under the clean effect, because a re-bind
/// on open must not dirty a freshly opened workbook.
#[test]
fn every_connection_door_re_binds_design_query_charts_after_minting_their_connections() {
    let pull = calp_commands_fn_code("pub(crate) fn materialize_pull_result(");
    let minted = pull.find("load_embedded_data_sources(").expect("the pull mints connections");
    let rebound = pull.find("remap_chart_bi_connections(").expect("the pull does not re-bind charts");
    assert!(minted < rebound, "the pull re-binds charts before their connections exist");

    let refresh = calp_commands_fn_code("pub(crate) fn apply_refresh_payloads(");
    let map = refresh
        .find("remap_slicer_bi_connections(")
        .expect("the refresh lost its slicer remap, the marker of the full data-source map");
    let rebound = refresh.find("remap_chart_bi_connections(").expect("the refresh does not re-bind charts");
    assert!(map < rebound, "the refresh re-binds charts before the full data-source map exists");

    // The body lives in the `_in` form (an explicit trust profile, for tests).
    let open = calp_commands_fn_code("pub(crate) fn restore_application_bi_connections_in(");
    // The open path mints through its verified-sources half (which decides the
    // shared ids first, rev10B).
    assert!(
        calp_commands_fn_code("pub(crate) fn materialize_verified_application_connections(")
            .contains("load_embedded_data_sources("),
        "the open path's minting half no longer mints connections"
    );
    let minted = open
        .find("materialize_verified_application_connections(")
        .expect("the open path mints connections");
    let rebound = open.find("remap_chart_bi_connections(").expect("the open path does not re-bind charts");
    assert!(minted < rebound, "the open path re-binds charts before its connections exist");
    let clean = open
        .find("CleanReason::LoadingFromDisk")
        .expect("the open path's re-bind must run under the loading-from-disk effect");
    assert!(clean < rebound, "the clean effect is constructed before the charts are written");
}

// ---------------------------------------------------------------------------
// The SAVE-time package key (drill-through fix round, 2026-10-23). The remap
// above re-binds a design-query chart on the next open by its stable
// `packageDataSourceId`; the save is where that key is written, from the live
// connection the chart names, for every chart -- whoever wrote it.
// ---------------------------------------------------------------------------

/// A connection authored in THIS workbook: no package data source behind it.
fn local_connection(id: identity::EntityId) -> crate::bi::types::Connection {
    crate::bi::types::Connection {
        id,
        name: "My model".into(),
        description: String::new(),
        connection_type: crate::bi::types::ConnectionType::PostgreSQL,
        connection_string: String::new(),
        server: String::new(),
        database: String::new(),
        preferred_auth: "Integrated".into(),
        model_path: None,
        engine: None,
        model_key: None,
        connector_index: None,
        bindings: vec![],
        last_refreshed: None,
        created_at: String::new(),
        is_connected: false,
        active_queries: std::collections::HashMap::new(),
        package_data_source_id: None,
        active_role: None,
        base_model: None,
        calculated_measures: vec![],
    }
}

/// A design-query chart RECORD as the chart store holds it (`ChartEntry`) on
/// sheet `sheet_index`: `{type, dslText, connectionId[, packageDataSourceId]}`
/// -- what a drill-through's chart, the Insert Chart dialog or a script writes.
fn design_query_entry(sheet_index: usize, connection: &str, package: Option<&str>) -> crate::api_types::ChartEntry {
    let mut data = serde_json::json!({
        "type": "designQuery",
        "dslText": "ROWS: [Sales.Region]\nVALUES: [Revenue]",
        "connectionId": connection
    });
    if let Some(p) = package {
        data["packageDataSourceId"] = serde_json::Value::String(p.to_string());
    }
    let id = new_entity();
    crate::api_types::ChartEntry {
        id,
        sheet_index,
        spec_json: serde_json::json!({
            "chartId": id.to_string(),
            "name": "Region detail",
            "sheetIndex": sheet_index,
            "spec": { "mark": "bar", "data": data, "series": [] }
        })
        .to_string(),
    }
}

/// The saved `spec.data` of chart `id`.
fn saved_data(saved: &[persistence::SavedChart], id: identity::EntityId) -> &serde_json::Value {
    &saved.iter().find(|c| c.id == id).expect("the chart was saved").spec["spec"]["data"]
}

/// THE KEPT DRILL CHART SURVIVES THE NEXT OPEN, AND A RE-POINT IS NOT UNDONE
/// (review findings rust/kept-drill-chart-has-no-package-key,
/// charts/no-writer-of-package-key, contracts/drill-chart-no-package-key,
/// charts/stale-package-key-reverts-repoint).
///
/// A subscriber's workbook: the pull minted an application connection for the
/// publisher's data source, and the subscriber has a model of their own. The
/// chart store then holds three charts no TypeScript writer keyed correctly --
/// a kept drill-through chart naming the application connection by its
/// SESSION uuid only, a chart re-pointed to the local model that still carries
/// the application's key (the store's deep merge kept it), and a chart whose
/// uuid names no live connection. The save stamps the first, strips the second
/// and leaves the third alone -- in the SAVED copy only: the store keeps its
/// bytes. Then the next open (every application connection re-minted) re-binds
/// the drill chart and leaves the re-pointed one on the local model, which is
/// exactly what the unstamped records could not do.
///
/// SABOTAGE: skip `stamp_saved_chart_package_keys` in `collect_charts_for_save`
/// -- the drill chart's key assertion fails (and so does the re-bind).
#[test]
fn a_save_stamps_each_design_query_chart_from_its_live_connection_and_never_touches_the_store() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let publisher_connection = new_entity().to_string();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    let dashboard = wb.sheets[0].id;
    wb.charts = vec![design_query_chart(dashboard, &publisher_connection, "Revenue by region")];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None, &publisher_connection);

    let h = Harness::new();
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);
    let (application, _) = connection_for(&h, &publisher_connection);
    let local = new_entity();
    h.bi.connections.lock().unwrap().insert(local, local_connection(local));

    let kept_drill = design_query_entry(0, &application.to_string(), None);
    let re_pointed = design_query_entry(0, &local.to_string(), Some(&publisher_connection));
    let orphan = design_query_entry(0, &new_entity().to_string(), Some("ds-not-loaded"));
    {
        let effect = crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default());
        let mut charts = h.state.charts.write(&effect).unwrap();
        charts.extend([kept_drill.clone(), re_pointed.clone(), orphan.clone()]);
    }
    let store = |h: &Harness| -> Vec<(identity::EntityId, String)> {
        h.state.charts.read().unwrap().iter().map(|c| (c.id, c.spec_json.clone())).collect()
    };
    let store_before = store(&h);

    let keys = crate::persistence::chart_connection_keys(&h.bi).expect("the connections are readable");
    // Pins the OWNED return. SABOTAGE: make `ChartConnectionKeys` a MutexGuard
    // over `BiState.connections` (the stamp reading `package_data_source_id`
    // through it) -- this assertion fails and nothing else does.
    assert!(h.bi.connections.try_lock().is_ok(), "the connections lock is released before the charts are read");
    let sheet_ids = h.state.sheet_ids.read().unwrap().clone();
    let saved = crate::persistence::collect_charts_for_save(&h.state, &sheet_ids, &keys);

    // (a) The kept drill chart: its live application connection's key is
    //     written beside the session uuid, which is not rewritten.
    let drill = saved_data(&saved, kept_drill.id);
    assert_eq!(drill["packageDataSourceId"], publisher_connection.as_str(), "the stable key is saved");
    assert_eq!(drill["connectionId"], application.to_string().as_str());
    // (b) The re-pointed chart: a local connection has no key, so the stale
    //     application key is removed -- not nulled, not emptied.
    let mine = saved_data(&saved, re_pointed.id);
    assert!(mine.get("packageDataSourceId").is_none(), "the stale key is not saved: {mine}");
    assert_eq!(mine["connectionId"], local.to_string().as_str());
    // (c) A uuid no live connection answers to: saved exactly as stored.
    let parse = |text: &str| serde_json::from_str::<serde_json::Value>(text).unwrap();
    let orphan_saved = saved.iter().find(|c| c.id == orphan.id).expect("the orphan was saved");
    assert_eq!(orphan_saved.spec, parse(&orphan.spec_json), "the key that may still heal it is kept");
    // (d) The pulled chart was already bound and keyed: saved as stored.
    let pulled = saved.iter().find(|c| c.id == wb.charts[0].id).expect("the pulled chart was saved");
    let pulled_stored = &store_before.iter().find(|(id, _)| *id == wb.charts[0].id).unwrap().1;
    assert_eq!(pulled.spec, parse(pulled_stored));
    // (e) Only the SAVED copy: the chart store keeps every byte.
    assert_eq!(store(&h), store_before, "the save wrote its stamp back into the chart store");

    // (f) The next open: the application's data source gets a FRESH connection.
    let reopened = new_entity();
    let open: std::collections::HashMap<String, crate::bi::types::ConnectionId> =
        [(publisher_connection.clone(), reopened)].into_iter().collect();
    let mut from_disk: Vec<crate::api_types::ChartEntry> = saved
        .iter()
        .filter(|c| c.id == kept_drill.id || c.id == re_pointed.id)
        .map(|c| crate::api_types::ChartEntry {
            id: c.id,
            sheet_index: 0,
            spec_json: crate::persistence::chart_spec_text_from_saved(&c.spec),
        })
        .collect();
    assert_eq!(crate::calp_commands::remap_chart_bi_connections(&mut from_disk, &open, None), 1);
    let reopened_spec = |id: identity::EntityId| {
        spec_connection(&from_disk.iter().find(|c| c.id == id).unwrap().spec_json).0
    };
    assert_eq!(reopened_spec(kept_drill.id), reopened.to_string(), "the kept drill chart finds its model");
    assert_eq!(reopened_spec(re_pointed.id), local.to_string(), "the user's re-point survives the reopen");
    // The premise, on the records as the store holds them: unstamped, the
    // drill chart cannot be re-bound and the stale key pulls the other back.
    let mut unstamped = vec![kept_drill.clone()];
    assert_eq!(crate::calp_commands::remap_chart_bi_connections(&mut unstamped, &open, None), 0);
    let mut stale = vec![re_pointed.clone()];
    assert_eq!(crate::calp_commands::remap_chart_bi_connections(&mut stale, &open, None), 1);
    assert_eq!(spec_connection(&stale[0].spec_json).0, reopened.to_string());
}

/// A WORKING COPY'S PUSH KEYS ITS DESIGN-QUERY CHARTS BY THE ID IT FILES THEIR
/// DATA SOURCE UNDER -- and that id is the APPLICATION'S OWN data-source id,
/// the one the previous version filed it under (BUG-0589). A checkout mints the
/// developer's connection with a fresh session uuid and the application's
/// data-source id as its package key. Review RB-1 made the carrier and the
/// capture agree on the session uuid, which re-keyed every data source on
/// every push; now both use the stable key, so the `.cala` save and the
/// carrier give a checked-out chart the SAME key, and an existing subscriber's
/// refresh -- which re-uses its one connection for that id -- binds every
/// chart to the connection now serving the new version.
///
/// SABOTAGE: return `connection.id.to_string()` from `published_data_source_id`
/// -- the `filed_under` assertion fails (and the carrier key assertions with it).
///
/// The builder's `ChartKeysFor` choice cannot be seen here: for a connection a
/// checkout minted, both arms now give the same key. Flipping it to
/// `ChartKeysFor::Document` in `build_workbook_for_save_with_slicers` is caught
/// only by the source pin in
/// `every_door_that_serialises_charts_stamps_them_through_the_one_collector`
/// (it differs for a connection authored in the publishing workbook, whose
/// `.cala` key is none), which must not be deleted as redundant with this one.
#[test]
fn the_carrier_keys_a_checked_out_design_query_chart_by_the_id_its_data_source_is_filed_under() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let publisher_connection = new_entity().to_string();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    let dashboard = wb.sheets[0].id;
    wb.charts = vec![design_query_chart(dashboard, &publisher_connection, "Revenue by region")];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None, &publisher_connection);

    let h = Harness::new();
    h.empty_as_checkout_does();
    h.materialize(checkout_pull(&dir, prof.path()), MaterializeMode::Checkout);
    let (working, _) = connection_for(&h, &publisher_connection);
    assert_ne!(working.to_string(), publisher_connection, "the premise: a checkout mints a fresh session uuid");
    // A chart the developer made in the working copy (Insert Chart, a kept
    // drill chart): bound by the session uuid only.
    let made_here = design_query_entry(0, &working.to_string(), None);
    {
        let effect = crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default());
        h.state.charts.write(&effect).unwrap().push(made_here.clone());
    }
    let sheet_ids = h.state.sheet_ids.read().unwrap().clone();
    let filed_under = {
        let connections = h.bi.connections.lock().unwrap();
        crate::calp_commands::published_data_source_id(&connections[&working])
    };
    assert_eq!(
        filed_under, publisher_connection,
        "a push files the data source under the application's own id, not the session uuid"
    );

    // The .cala save: the package key, which the next open's re-mint answers to.
    let document = crate::persistence::chart_connection_keys(&h.bi).unwrap();
    let saved = crate::persistence::collect_charts_for_save(&h.state, &sheet_ids, &document);
    assert_eq!(saved_data(&saved, made_here.id)["packageDataSourceId"], publisher_connection.as_str());

    // The carrier: the id the data source is filed under in THIS package --
    // for the chart made here AND for the pulled one.
    let package = crate::persistence::published_chart_connection_keys(&h.bi).unwrap();
    let carried = crate::persistence::collect_charts_for_save(&h.state, &sheet_ids, &package);
    assert_eq!(saved_data(&carried, made_here.id)["packageDataSourceId"], filed_under.as_str());
    assert_eq!(saved_data(&carried, wb.charts[0].id)["packageDataSourceId"], filed_under.as_str());
    assert_eq!(saved_data(&carried, made_here.id)["connectionId"], working.to_string().as_str(), "the session uuid is not rewritten");

    // At an EXISTING subscriber the refresh re-uses its one connection for
    // that id, now serving v2: every carried chart binds to it.
    let serving_v2 = new_entity();
    let live: std::collections::HashMap<String, crate::bi::types::ConnectionId> =
        [(publisher_connection.clone(), serving_v2)].into_iter().collect();
    let entry = |saved: &[persistence::SavedChart], id: identity::EntityId| crate::api_types::ChartEntry {
        id,
        sheet_index: 0,
        spec_json: crate::persistence::chart_spec_text_from_saved(&saved.iter().find(|c| c.id == id).unwrap().spec),
    };
    let mut from_v2 = vec![entry(&carried, made_here.id), entry(&carried, wb.charts[0].id)];
    assert_eq!(crate::calp_commands::remap_chart_bi_connections(&mut from_v2, &live, None), 2);
    for chart in &from_v2 {
        assert_eq!(spec_connection(&chart.spec_json).0, serving_v2.to_string(), "bound to the connection serving v2");
    }
}

/// THE EMBEDDED DATA SOURCE AND THE CARRIED CHART NAME THE SAME THING -- checked
/// on what the capture really captures (review RB1-WIRING-PIN-GAPS (b)). The
/// source pin below can only check substrings, and a fix applied to one side
/// alone -- the capture filing under one key while the carrier stamps another
/// -- keeps every pin green while every subscriber's design-query chart names a
/// data source the package does not have. Since BUG-0589 both sides use the
/// stable key, which for a checked-out connection is the application's own
/// data-source id.
///
/// SABOTAGE: file the data source under `conn.id.to_string()` in
/// `capture_bi_data_sources_of` -- the first data-source assertion fails.
#[test]
fn a_checked_out_push_files_each_data_source_under_the_key_its_carried_charts_name() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let publisher_connection = new_entity().to_string();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    let dashboard = wb.sheets[0].id;
    wb.charts = vec![design_query_chart(dashboard, &publisher_connection, "Revenue by region")];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None, &publisher_connection);

    let h = Harness::new();
    h.empty_as_checkout_does();
    h.materialize(checkout_pull(&dir, prof.path()), MaterializeMode::Checkout);
    let (working, minted) = connection_for(&h, &publisher_connection);
    assert_eq!(minted, 1, "fixture: one connection for the application's one data source");
    assert_eq!(h.bi.connections.lock().unwrap().len(), 1, "fixture: the checkout's connection is the only one");
    assert_ne!(
        working.to_string(),
        publisher_connection,
        "the premise: a checkout mints a fresh id, so the connection's own id and its package key differ"
    );

    let (sources, _) = crate::calp_commands::capture_bi_data_sources(&h.state, &h.bi).expect("the capture runs");
    let ids: Vec<&str> = sources.iter().map(|ds| ds.id.as_str()).collect();
    assert_eq!(sources.len(), 1, "the checked-out connection's model is captured: {ids:?}");

    let package = crate::persistence::published_chart_connection_keys(&h.bi).unwrap();
    let keyed = package.get(&working).cloned().flatten().expect("the carrier keys the checkout's connection");
    let sheet_ids = h.state.sheet_ids.read().unwrap().clone();
    let carried = crate::persistence::collect_charts_for_save(&h.state, &sheet_ids, &package);
    let carried_key = saved_data(&carried, wb.charts[0].id)["packageDataSourceId"]
        .as_str()
        .expect("the carried chart is keyed")
        .to_string();
    for ds in &sources {
        assert_eq!(ds.id, keyed, "the data source is filed under the key the carrier gives its connection");
        assert_eq!(ds.id, carried_key, "the carried chart names the data source the package embeds");
        assert_eq!(ds.id, publisher_connection, "the push keeps the application's data-source id (BUG-0589)");
    }
}

/// A ribbon filter as the publisher's carrier writes it, on `connection` with
/// the stamped data-source id `data_source_id` (None: a filter authored on a
/// local connection, whose uuid IS the application data-source id).
fn ribbon_filter_on(connection: &str, data_source_id: Option<&str>, name: &str) -> persistence::SavedRibbonFilter {
    serde_json::from_value(serde_json::json!({
        "id": new_entity().to_string(),
        "name": name,
        "connection_id": connection,
        "data_source_id": data_source_id,
        "field_name": "Sales.Region",
        "selected_items": null,
    }))
    .expect("a minimal ribbon filter deserialises")
}

/// The PUSH a working copy makes, through the real carrier
/// (`build_workbook_for_save_with_slicers`, which stamps the design-query
/// charts and collects the ribbon filters), the real pivot collector and the
/// real data-source capture -- everything `assemble_publish_snapshot` hands to
/// core publish for an untouched working copy, minus the steps that do not
/// touch a data source's identity (renames, pruning, regions, scripts).
fn push_working_copy(dir: &TempDir, prof: &Path, w: &Harness, version: (u32, u32, u32), base: (u32, u32, u32)) {
    let (mut carrier, _) = crate::persistence::build_workbook_for_save_with_slicers(
        &w.state,
        &crate::persistence::UserFilesState::default(),
        &w.bi,
        &w.slicer,
        &w.ribbon,
        &w.pivot,
        &w.timeline,
    )
    .expect("the carrier builds");
    crate::persistence::collect_pivot_definitions(&w.pivot, &w.state, &mut carrier);
    let (data_sources, model_writebacks) =
        crate::calp_commands::capture_bi_data_sources(&w.state, &w.bi).expect("the capture runs");
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let request = PublishRequest {
        workbook: &carrier,
        package_name: "literals".to_string(),
        version: SemVer::new(version.0, version.1, version.2),
        kind: "report".to_string(),
        mode: PushMode::Update { expected_base: SemVer::new(base.0, base.1, base.2) },
        change_summary: "an untouched working-copy push".to_string(),
        sheet_indices: vec![0],
        now: "2026-10-30T00:00:00Z".to_string(),
        published_by: "author".to_string(),
        writeback_regions: None,
        model_writebacks: if model_writebacks.is_empty() { None } else { Some(model_writebacks) },
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources,
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        identity_policy: None,
        min_app_version: String::new(),
    };
    publish::publish(&reg, &request, prof).expect("the push publishes");
}

/// The ribbon filters of `h`: (name, connection, stamped data-source id).
fn ribbon_filters_of(h: &Harness) -> Vec<(String, identity::EntityId, Option<String>)> {
    let mut out: Vec<_> = h
        .ribbon
        .filters
        .read()
        .unwrap()
        .values()
        .map(|f| (f.name.clone(), f.connection_id, f.data_source_id.clone()))
        .collect();
    out.sort();
    out
}

/// BUG-0589, END TO END: publish -> subscribe -> check out -> push UNTOUCHED ->
/// refresh the existing subscriber, and subscribe a fresh one. Before the fix
/// the push filed the model under the checkout's session uuid, so (1) every
/// subscriber lost the application's ribbon filters (the pull skips a filter
/// whose data source the package does not embed), (2) the existing subscriber's
/// refresh minted a SECOND connection for the new id and kept the first on
/// v1's model, and (3) a design-query chart followed the new id while
/// everything keyed by the stable id stayed on the old connection.
///
/// Also pins the ribbon filter's fallback to its carried connection uuid (the
/// model-slicer rule): a filter whose stamped id names nothing embedded but
/// whose connection uuid IS the embedded data source is kept, not skipped.
///
/// SABOTAGE: file data sources under `connection.id.to_string()` in
/// `published_data_source_id` -- the "one connection" assertion after the
/// refresh fails. SABOTAGE (fallback): restore the bare
/// `.unwrap_or_else(|| saved.connection_id.to_string())` in
/// `materialize_pulled_ribbon_filters` -- the subscriber's filter count fails.
#[test]
fn an_untouched_working_copy_push_keeps_every_subscribers_model_and_ribbon_filters() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let publisher_connection = new_entity().to_string();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    let dashboard = wb.sheets[0].id;
    wb.charts = vec![design_query_chart(dashboard, &publisher_connection, "Revenue by region")];
    wb.ribbon_filters = vec![
        ribbon_filter_on(&publisher_connection, None, "Region"),
        // Stamped with an id the package does not embed, on the connection
        // whose uuid it does: kept by the connection fallback.
        ribbon_filter_on(&publisher_connection, Some("ds-from-elsewhere"), "Channel"),
    ];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None, &publisher_connection);

    // An existing subscriber.
    let s = Harness::new();
    s.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);
    let (s_conn, _) = connection_for(&s, &publisher_connection);
    let filters_v1 = ribbon_filters_of(&s);
    assert_eq!(filters_v1.len(), 2, "the subscriber got both ribbon filters: {filters_v1:?}");
    for (name, connection, ds) in &filters_v1 {
        assert_eq!(*connection, s_conn, "filter {name} reads the subscriber's connection");
        assert_eq!(ds.as_deref(), Some(publisher_connection.as_str()), "filter {name} keeps the stable id");
    }

    // The developer checks v1 out and pushes v1.1 without touching the model.
    let w = Harness::new();
    w.empty_as_checkout_does();
    w.materialize(checkout_pull(&dir, prof.path()), MaterializeMode::Checkout);
    let (w_conn, _) = connection_for(&w, &publisher_connection);
    assert_ne!(w_conn.to_string(), publisher_connection, "the premise: the checkout minted a fresh session uuid");
    assert_eq!(ribbon_filters_of(&w).len(), 2, "the working copy holds the application's ribbon filters");
    push_working_copy(&dir, prof.path(), &w, (1, 1, 0), (1, 0, 0));

    // The existing subscriber refreshes.
    s.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);
    let (s_after, minted) = connection_for(&s, &publisher_connection);
    assert_eq!(s.bi.connections.lock().unwrap().len(), 1, "the refresh re-used the one connection, never minting a second");
    assert_eq!(minted, 1);
    assert_eq!(s_after, s_conn, "the same connection serves v1.1");
    let filters_v2 = ribbon_filters_of(&s);
    assert_eq!(filters_v2.len(), 2, "the refresh kept the application's ribbon filters: {filters_v2:?}");
    for (name, connection, ds) in &filters_v2 {
        assert_eq!(*connection, s_conn, "filter {name} still reads the subscriber's one connection");
        assert_eq!(ds.as_deref(), Some(publisher_connection.as_str()), "filter {name} keeps the stable id for the next open");
    }
    let charts = s.state.charts.read().unwrap();
    let chart = charts.iter().find(|c| c.id == wb.charts[0].id).expect("the chart is still there");
    let (bound, key) = spec_connection(&chart.spec_json);
    assert_eq!(bound, s_conn.to_string(), "the design-query chart reads the same connection as everything else");
    assert_eq!(key.as_deref(), Some(publisher_connection.as_str()));
    drop(charts);

    // A fresh subscriber of v1.1.
    let f = Harness::new();
    f.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    let (f_conn, _) = connection_for(&f, &publisher_connection);
    let fresh = ribbon_filters_of(&f);
    assert_eq!(fresh.len(), 2, "a fresh subscriber of the pushed version gets the ribbon filters: {fresh:?}");
    assert!(fresh.iter().all(|(_, c, _)| *c == f_conn));
}

/// The pivot fallback for metadata that names no embedded data source answers
/// only for an application with ONE data source (BUG-0589): with several, the
/// old `values().next()` gave an arbitrary connection by hash order.
///
/// SABOTAGE: make `sole_connection` return `ds_to_conn.values().next().copied()`
/// -- the two-source assertion fails.
#[test]
fn the_pivot_fallback_answers_only_for_a_single_data_source() {
    let (a, b) = (new_entity(), new_entity());
    let one: std::collections::HashMap<String, crate::bi::types::ConnectionId> =
        [("ds-a".to_string(), a)].into_iter().collect();
    assert_eq!(crate::calp_commands::sole_connection(&one), Some(a));
    let two: std::collections::HashMap<String, crate::bi::types::ConnectionId> =
        [("ds-a".to_string(), a), ("ds-b".to_string(), b)].into_iter().collect();
    assert_eq!(crate::calp_commands::sole_connection(&two), None, "two data sources: no arbitrary pick");
    assert_eq!(crate::calp_commands::sole_connection(&std::collections::HashMap::new()), None);
}

/// Two live connections of ONE application data source cannot both be filed
/// under its id: the capture refuses, naming them, instead of letting hash
/// order decide which model the package carries (BUG-0589).
///
/// SABOTAGE: drop the `filed.insert` refusal in `capture_bi_data_sources_of`
/// -- the `expect_err` fails.
#[test]
fn a_capture_refuses_two_connections_filed_under_one_data_source() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let publisher_connection = new_entity().to_string();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None, &publisher_connection);

    let h = Harness::new();
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);
    let (first, _) = connection_for(&h, &publisher_connection);
    // A second connection minted from the same data source, sharing the engine.
    let second = new_entity();
    {
        let mut connections = h.bi.connections.lock().unwrap();
        let engine = connections[&first].engine.clone();
        let mut twin = local_connection(second);
        twin.name = "Sales model (2)".into();
        twin.engine = engine;
        twin.package_data_source_id = Some(publisher_connection.clone());
        connections.insert(second, twin);
    }
    let err = match crate::calp_commands::capture_bi_data_sources(&h.state, &h.bi) {
        Ok((sources, _)) => panic!("two connections of one data source must refuse; captured {}", sources.len()),
        Err(e) => e,
    };
    assert!(err.contains("Sales model (2)"), "the refusal names the connections: {err}");
    // The model-only publish of ONE of them still captures just that one.
    let (only, _) = crate::calp_commands::capture_bi_data_sources_of(&h.state, &h.bi, Some(&first))
        .expect("a single connection is captured");
    assert_eq!(only.len(), 1);
    assert_eq!(only[0].id, publisher_connection, "filed under the application's id, not the session uuid");
}

/// A BI pivot created on a connection a subscribe or a checkout minted names
/// the connection's STABLE key, not its session uuid (BUG-0589): the session
/// uuid names nothing after the next open's re-mint, nor in a package this
/// workbook pushes. `create_pivot_from_bi_model` is an async Tauri command
/// taking `State` handles, so this is a source pin on the one stamp.
///
/// SABOTAGE: stamp `data_source_id: Some(connection_id.to_string())` again --
/// the stamp assertion fails.
#[test]
fn a_bi_pivot_is_created_naming_its_connections_stable_key() {
    let create = crate_fn_code("src/pivot/commands.rs", "pub async fn create_pivot_from_bi_model(");
    assert!(
        create.contains("crate::calp_commands::published_data_source_id(conn)"),
        "the pivot no longer takes its key from published_data_source_id"
    );
    assert!(
        create.contains("data_source_id: Some(data_source_key)"),
        "the pivot's metadata no longer names the connection's stable key"
    );
}

/// Every file of application `package`'s versions in the workspace at `dir`
/// (the folder named after it), as bytes.
fn package_files(dir: &TempDir, package: &str) -> Vec<(std::path::PathBuf, Vec<u8>)> {
    fn walk(at: &Path, out: &mut Vec<(std::path::PathBuf, Vec<u8>)>) {
        for entry in std::fs::read_dir(at).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else {
                out.push((path.clone(), std::fs::read(&path).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(&dir.path().join(package), &mut out);
    out
}

/// ONE KEY, ONE APPLICATION (round 11; review rev9A, calpds D3). A NEW
/// application published from a workbook that SUBSCRIBES to another files the
/// subscribed model under its OWN data-source id -- deterministic per
/// (application, source id) -- and every store it carries that names the
/// model follows, so the source id appears nowhere in the new package. A
/// subscriber to both then holds two connections under two keys, each
/// application's chart reading its own.
///
/// Before the fix the new application re-used the source's id (BUG-0589's
/// stable key): a subscriber to both minted two connections under ONE key,
/// and refresh, the filter/slicer remap and every key lookup took whichever
/// the connection map returned first.
///
/// SABOTAGE: make `data_source_rekeys_for_target` return an empty map -- the
/// "files under its own id" assertion fails.
#[test]
fn a_new_application_from_a_subscribed_workbook_files_its_model_under_its_own_key() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let source_key = new_entity().to_string();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    wb.ribbon_filters = vec![ribbon_filter_on(&source_key, None, "Region")];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None, &source_key);

    // W subscribes to A and builds a report of its own on A's model.
    let w = Harness::new();
    w.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);
    let (w_conn, _) = connection_for(&w, &source_key);
    let mine = design_query_entry(0, &w_conn.to_string(), Some(&source_key));
    {
        let effect = crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default());
        w.state.charts.write(&effect).unwrap().push(mine.clone());
    }
    let own_sheet = w.state.sheet_ids.read().unwrap()[0];
    let registry = dir.path().to_str().unwrap().to_string();

    // ...and publishes it as the NEW application B, through the real carrier.
    let carrier = crate::calp_commands::assemble_publish_workbook(
        &w.state,
        &w.bi,
        &w.pivot,
        &w.scripts,
        &w.slicer,
        &w.ribbon,
        &w.pane,
        &crate::persistence::UserFilesState::default(),
        &w.timeline,
        &crate::calp_commands::PublishSheetIds { sheets: vec![own_sheet], backing: vec![] },
        &registry,
        "report-b",
        &[],
        "published",
    )
    .expect("the carrier assembles");
    let b_key = crate::calp_commands::data_source_key_for_application("report-b", &source_key);
    assert_ne!(b_key, source_key);
    let filed: Vec<&str> = carrier.assembly.data_sources.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(filed, vec![b_key.as_str()], "B files the subscribed model under its OWN id, not A's");
    assert_eq!(
        b_key,
        crate::calp_commands::data_source_key_for_application("report-b", &source_key),
        "the id is deterministic: the next push of B files it under the same one"
    );
    let assembly = carrier.assembly;
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let request = PublishRequest {
        workbook: &assembly.workbook,
        package_name: "report-b".to_string(),
        version: SemVer::new(1, 0, 0),
        kind: "report".to_string(),
        mode: PushMode::CreateNew,
        change_summary: String::new(),
        sheet_indices: carrier.sheet_indices.clone(),
        now: "2026-10-30T00:00:00Z".to_string(),
        published_by: "author".to_string(),
        writeback_regions: None,
        model_writebacks: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: assembly.data_sources,
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        identity_policy: None,
        min_app_version: String::new(),
    };
    publish::publish(&reg, &request, prof.path()).expect("B publishes");

    // Nothing in B's package names A's id any more -- the data source, the
    // ribbon filter and the chart all followed.
    let files = package_files(&dir, "report-b");
    assert!(!files.is_empty(), "fixture: B's package is where the scan looks");
    for (path, bytes) in &files {
        let text = String::from_utf8_lossy(bytes);
        assert!(!text.contains(&source_key), "{} still names A's data-source id", path.display());
    }
    assert!(
        files.iter().any(|(_, b)| String::from_utf8_lossy(b).contains(&b_key)),
        "B's package names its own id"
    );

    // A subscriber to both: two connections, one per key, each application's
    // objects on its own.
    let s = Harness::new();
    s.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);
    s.materialize(pull_latest(&dir, prof.path(), "report-b"), MaterializeMode::Subscribe);
    let (s_a, a_count) = connection_for(&s, &source_key);
    let (s_b, b_count) = connection_for(&s, &b_key);
    assert_eq!((a_count, b_count), (1, 1), "one connection per key");
    assert_ne!(s_a, s_b, "two applications, two connections");
    let charts = s.state.charts.read().unwrap();
    let chart = charts.iter().find(|c| c.id == mine.id).expect("B's chart arrived");
    let (bound, key) = spec_connection(&chart.spec_json);
    assert_eq!(bound, s_b.to_string(), "B's chart reads B's model");
    assert_eq!(key.as_deref(), Some(b_key.as_str()));
    drop(charts);
    let filters = ribbon_filters_of(&s);
    assert!(
        filters.iter().any(|(_, c, ds)| *c == s_a && ds.as_deref() == Some(source_key.as_str())),
        "A's ribbon filter stays on A's connection: {filters:?}"
    );
}

/// THE DATA-SOURCE IDENTITY CONTRACT, clause by clause (owner decision
/// 2026-11-04, BUG-0616 note (c); docs/design/calp-workspace-collaboration.md
/// "Data-source identity"). A data source's id is OWNED BY THE APPLICATION
/// that publishes it:
///   1. stable across that application's versions -- a subscriber's refresh
///      re-uses its one connection (pinned end to end by
///      `an_untouched_working_copy_push_keeps_every_subscribers_model_and_ribbon_filters`);
///   2. a working copy pushing back to ITS OWN application keeps the id, in
///      whichever spelling the workspace is reached (the marker file is the
///      folder);
///   3. anything published as a DIFFERENT application -- another name, or the
///      same name in another workspace -- files it under a derived id of its
///      own (a fork);
///   4. ids are never shared across applications: the derived id is
///      deterministic per (application, source id), distinct per application
///      and per source, never the source's own; and a model ANOTHER
///      subscription brought into a working copy is re-keyed even on a push to
///      the working copy's own application;
///   5. a package carrying an id another subscription claims is refused
///      (`a_model_under_an_id_another_connection_serves_is_refused`,
///      `after_an_open_that_connected_neither_shared_model_no_refresh_mints_one`).
/// Clauses 2-4 are asked of `data_source_rekeys_for_target`, the one function
/// every publish door (`assemble_publish_workbook`, `calp_publish_model`)
/// consults; `push_working_copy` above bypasses it, so nothing else pins them.
///
/// SABOTAGES (separate builds): (1) make its filter keep every key (re-key
/// even the working copy's own application) -- clause 2 fails. (2) drop
/// `|| subscribed.contains(key)` -- clause 4's subscription case fails.
#[test]
fn the_data_source_identity_contract_holds_clause_by_clause() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let source_key = new_entity().to_string();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None, &source_key);
    let registry = dir.path().to_str().unwrap().to_string();

    // A working copy of "literals".
    let w = Harness::new();
    w.empty_as_checkout_does();
    w.materialize(checkout_pull(&dir, prof.path()), MaterializeMode::Checkout);
    *w.state.working_copy_link.write(&test_effect()).unwrap() = Some(calp::WorkingCopyLink::new(
        &registry,
        "literals",
        "report",
        "1.0.0",
        "2026-11-04T00:00:00Z",
        Vec::new(),
    ));
    let (w_conn, _) = connection_for(&w, &source_key);
    assert_ne!(w_conn.to_string(), source_key, "the premise: the checkout minted a session uuid");
    let rekeys = |registry: &str, package: &str| {
        crate::calp_commands::data_source_rekeys_for_target(&w.state, &w.bi, registry, package)
            .expect("the rekey question answers")
    };
    let derived = crate::calp_commands::data_source_key_for_application;

    // Clause 2: a push to its OWN application keeps the id...
    assert!(
        rekeys(&registry, "literals").is_empty(),
        "a working copy pushing back to its own application must keep the data-source id"
    );
    // ...reached through the workspace's marker file too.
    let marker = dir.path().join(calp::workspace_id::WORKSPACE_MARKER_FILE).to_str().unwrap().to_string();
    assert!(rekeys(&marker, "literals").is_empty(), "the marker file names the same workspace");

    // Clause 3: a different application -- a fork -- gets its own id.
    let fork = rekeys(&registry, "literals-fork");
    assert_eq!(
        fork.get(&source_key),
        Some(&derived("literals-fork", &source_key)),
        "a working copy published as ANOTHER application files the model under that application's id"
    );
    let elsewhere = TempDir::new().unwrap();
    let other_workspace = rekeys(elsewhere.path().to_str().unwrap(), "literals");
    assert_eq!(
        other_workspace.get(&source_key),
        Some(&derived("literals", &source_key)),
        "the same name in another workspace is another application"
    );

    // Clause 4: never shared across applications.
    assert_eq!(derived("literals-fork", &source_key), derived("literals-fork", &source_key), "deterministic");
    assert_ne!(derived("literals-fork", &source_key), source_key, "never the source's own id");
    assert_ne!(derived("literals-fork", &source_key), derived("literals-fork2", &source_key), "distinct per application");
    let other_source = new_entity().to_string();
    assert_ne!(derived("literals-fork", &source_key), derived("literals-fork", &other_source), "distinct per source");
    // The two inputs are NUL-separated: moving bytes between the application
    // name and the source id does not land on another pair's id.
    assert_ne!(derived("ab", "c"), derived("a", "bc"));

    // ...and a model another SUBSCRIPTION brought into the working copy is
    // that application's, never the working copy's: re-keyed even on a push
    // to the working copy's own application.
    let b_key = new_entity().to_string();
    let mut model_wb = Workbook::default();
    model_wb.sheets = vec![Sheet::new("Model".to_string())];
    publish_with_model(&dir, prof.path(), &model_wb, vec![0], "model-b", (1, 0, 0), None, &b_key);
    w.materialize(pull_latest(&dir, prof.path(), "model-b"), MaterializeMode::Subscribe);
    let own = rekeys(&registry, "literals");
    assert_eq!(
        own.get(&b_key),
        Some(&derived("literals", &b_key)),
        "a subscribed model pushed in a working copy must be filed under the working copy's application's own id"
    );
    assert!(!own.contains_key(&source_key), "the application's own model still keeps its id: {own:?}");
}

/// THE SUBSCRIBER'S SIDE: a model arriving under an id another connection
/// already serves is REFUSED, by name, before anything is written -- an
/// application published before round 11 that re-used another's id, or a
/// checkout of an application this workbook subscribes to. And a refresh may
/// re-use only the one connection its own subscription's ledger claims: not
/// one another subscription claims too (one connection serving two
/// applications).
///
/// SABOTAGE: make `refuse_data_source_already_served` return `Ok(())` at once
/// -- the subscribe `expect_err` fails.
#[test]
fn a_model_under_an_id_another_connection_serves_is_refused() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let source_key = new_entity().to_string();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None, &source_key);
    // An application that files ITS model under A's id (the pre-fix shape).
    let mut other = Workbook::default();
    other.sheets = vec![Sheet::new("Report".to_string())];
    publish_with_model(&dir, prof.path(), &other, vec![0], "copy-b", (1, 0, 0), None, &source_key);

    let s = Harness::new();
    s.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);
    let sheets_before = s.state.sheet_names.read().unwrap().clone();
    let err = materialize_pull_result(
        &s.state,
        &test_effect(),
        &s.pivot,
        &s.bi,
        &s.scripts,
        &s.ribbon,
        &s.pane,
        &s.slicer,
        &s.timeline,
        pull_latest(&dir, prof.path(), "copy-b"),
        MaterializeMode::Subscribe,
        None,
    )
    .expect_err("a second connection under one key must be refused");
    assert!(err.contains("CALP_DATA_SOURCE_SHARED"), "a structured refusal: {err}");
    assert!(err.contains("copy-b"), "it names the application: {err}");
    assert_eq!(connection_for(&s, &source_key).1, 1, "no second connection was minted");
    assert_eq!(*s.state.sheet_names.read().unwrap(), sheets_before, "nothing was installed");
    assert_eq!(s.state.subscriptions.read().unwrap().subscriptions.len(), 1);

    // A refresh of A re-uses A's own connection...
    let payload = |pull| vec![calp::refresh::RefreshPayload { subscription_index: 0, pull_result: pull }];
    crate::calp_commands::refuse_refreshed_data_sources_already_served(
        &s.state,
        &s.bi,
        &payload(pull_latest(&dir, prof.path(), "literals")),
    )
    .expect("a subscription refreshes onto its own connection");
    // ...but not one a second subscription claims as well.
    {
        let effect = test_effect();
        let mut subs = s.state.subscriptions.write(&effect).unwrap();
        let mut twin = subs.subscriptions[0].clone();
        twin.package_name = "copy-b".to_string();
        subs.subscriptions.push(twin);
    }
    let err = crate::calp_commands::refuse_refreshed_data_sources_already_served(
        &s.state,
        &s.bi,
        &payload(pull_latest(&dir, prof.path(), "literals")),
    )
    .expect_err("one connection serving two subscriptions is ambiguous");
    assert!(err.contains("CALP_DATA_SOURCE_SHARED"), "{err}");

    // The doors run the gate before their effect.
    for (door, gate) in [
        ("pub fn calp_pull(", "refuse_data_source_already_served("),
        ("pub fn calp_checkout(", "refuse_data_source_already_served("),
        ("pub fn calp_refresh_apply(", "refuse_refreshed_data_sources_already_served("),
    ] {
        let code = crate_fn_code("src/calp_commands.rs", door);
        let at = code.find(gate).unwrap_or_else(|| panic!("{door} no longer runs {gate}"));
        let effect = code.find("DocumentEffect::mutates(").expect("the door has an effect");
        assert!(at < effect, "{door} runs {gate} after its effect: a refusal would dirty the workbook");
    }
}

/// THE OPEN PATH'S SIDE of one key, one application (calpkey remaining). A
/// document written before round 11 can hold two subscriptions whose models
/// share one data-source id. The open used to mint the FIRST one it verified
/// and skip the other as "already connected", so the second application's
/// pivots, filters and charts silently read the first one's model. Now neither
/// is connected under the shared id, and each is reported as
/// `sharedDataSource` with the structured refusal text.
///
/// SABOTAGE: the partition in `materialize_verified_application_connections`
/// never treats a key as shared -- a connection is minted.
#[test]
fn opening_two_subscriptions_that_claim_one_data_source_id_connects_neither() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let source_key = new_entity().to_string();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None, &source_key);
    let mut other = Workbook::default();
    other.sheets = vec![Sheet::new("Report".to_string())];
    publish_with_model(&dir, prof.path(), &other, vec![0], "copy-b", (1, 0, 0), None, &source_key);
    let count = |h: &Harness| {
        h.bi.connections
            .lock()
            .unwrap()
            .values()
            .filter(|c| c.package_data_source_id.as_deref() == Some(source_key.as_str()))
            .count()
    };

    let s = Harness::new();
    s.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    // The pre-round-11 document: a second subscription filed under the same id.
    {
        let effect = test_effect();
        let mut subs = s.state.subscriptions.write(&effect).unwrap();
        let mut twin = subs.subscriptions[0].clone();
        twin.package_name = "copy-b".to_string();
        subs.subscriptions.push(twin);
    }
    let subscriptions = s.state.subscriptions.read().unwrap().subscriptions.clone();
    let verified_of = |package: &str, index: usize| {
        (index, "workspace".to_string(), pull_latest(&dir, prof.path(), package).data_sources)
    };

    // Positive control: the same call, with ONE claimant, mints the model.
    let fresh = Harness::new();
    let mut skips = Vec::new();
    let minted = crate::calp_commands::materialize_verified_application_connections(
        &subscriptions[..1],
        vec![verified_of("literals", 0)],
        &fresh.bi,
        &fresh.ribbon,
        &fresh.slicer,
        &mut skips,
    );
    assert!(minted.contains_key(&source_key), "precondition: an unshared model is connected: {minted:?}");
    assert_eq!(count(&fresh), 1);
    assert!(skips.is_empty(), "{skips:?}");

    // The open of the two-claimant document (no live connection yet).
    let opened = Harness::new();
    let mut skips = Vec::new();
    let minted = crate::calp_commands::materialize_verified_application_connections(
        &subscriptions,
        vec![verified_of("literals", 0), verified_of("copy-b", 1)],
        &opened.bi,
        &opened.ribbon,
        &opened.slicer,
        &mut skips,
    );
    assert_eq!(count(&opened), 0, "the open served one application's model under an id two claim");
    assert!(minted.is_empty(), "{minted:?}");
    let mut reported: Vec<(&str, &str)> = skips.iter().map(|k| (k.package_name.as_str(), k.reason.as_str())).collect();
    reported.sort();
    assert_eq!(reported, vec![("copy-b", "sharedDataSource"), ("literals", "sharedDataSource")]);
    for skip in &skips {
        assert!(skip.detail.starts_with("CALP_DATA_SOURCE_SHARED"), "{}", skip.detail);
        assert!(skip.detail.contains(&source_key), "the id is named: {}", skip.detail);
    }
    let literals = skips.iter().find(|k| k.package_name == "literals").unwrap();
    assert!(literals.detail.contains("'copy-b'"), "the other claimant is named: {}", literals.detail);
}

/// AFTER THE OPEN CONNECTED NEITHER (rev12C). A document in which two
/// subscriptions claim one data-source id opens with neither model connected.
/// No connection then serves the id, and the gate used to count connections
/// only -- so a refresh (or a subscribe) minted one application's model under
/// the shared id and the other application's pivots, slicers and charts read
/// it with no error. Now a claim in another subscription's ledger refuses on
/// its own, and so do two payloads of one refresh carrying one id. When the
/// copy is re-published under its own id and updated, its stale claim is
/// dropped from its ledger, the original's model is connected by the
/// after-refresh re-ask, and the pane's rows are re-written.
///
/// SABOTAGES: (1) the `claimed_elsewhere` refusal in
/// `refuse_data_source_already_served` never fires -- the first refresh is
/// admitted. (2) the ledger merge keeps every carried dataSource row -- the
/// original's update stays refused. (3)
/// `reconnect_application_models_after_refresh_in` returns at once -- the
/// original's model is not connected and the rows are stale.
#[test]
fn after_an_open_that_connected_neither_shared_model_no_refresh_mints_one() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let source_key = new_entity().to_string();
    let copy_key = new_entity().to_string();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None, &source_key);
    let mut other = Workbook::default();
    other.sheets = vec![Sheet::new("Report".to_string())];
    publish_with_model(&dir, prof.path(), &other, vec![0], "copy-b", (1, 0, 0), None, &source_key);
    let count = |h: &Harness, key: &str| {
        h.bi.connections
            .lock()
            .unwrap()
            .values()
            .filter(|c| c.package_data_source_id.as_deref() == Some(key))
            .count()
    };

    // The pre-round-11 document, as the open leaves it: two subscriptions
    // claiming one id, NEITHER model connected, a sharedDataSource row each.
    let s = Harness::new();
    s.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    {
        let effect = test_effect();
        let mut subs = s.state.subscriptions.write(&effect).unwrap();
        let mut twin = subs.subscriptions[0].clone();
        twin.package_name = "copy-b".to_string();
        twin.sheets.clear();
        twin.objects.retain(|o| o.kind == "dataSource");
        subs.subscriptions.push(twin);
    }
    s.bi.connections.lock().unwrap().clear();
    {
        let subscriptions = s.state.subscriptions.read().unwrap().subscriptions.clone();
        let mut skips = Vec::new();
        crate::calp_commands::materialize_verified_application_connections(
            &subscriptions,
            vec![
                (0, "workspace".to_string(), pull_latest(&dir, prof.path(), "literals").data_sources),
                (1, "workspace".to_string(), pull_latest(&dir, prof.path(), "copy-b").data_sources),
            ],
            &s.bi,
            &s.ribbon,
            &s.slicer,
            &mut skips,
        );
        assert_eq!(skips.len(), 2, "precondition: the open reports both: {skips:?}");
        *s.state.application_connection_restore_skips.lock().unwrap() = skips;
    }
    assert_eq!(count(&s, &source_key), 0, "precondition: the open connected neither");

    // A refresh of either one is refused, though no connection serves the id.
    let payload = |index: usize, package: &str| calp::refresh::RefreshPayload {
        subscription_index: index,
        pull_result: pull_latest(&dir, prof.path(), package),
    };
    let err = crate::calp_commands::refuse_refreshed_data_sources_already_served(
        &s.state,
        &s.bi,
        &[payload(0, "literals")],
    )
    .expect_err("a refresh minted one model under an id another subscription claims");
    assert!(err.contains("CALP_DATA_SOURCE_SHARED") && err.contains("'copy-b'"), "{err}");
    // ...and so is a subscribe of a third application under the id.
    {
        let fresh = Harness::new();
        fresh.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
        fresh.bi.connections.lock().unwrap().clear();
        let err = materialize_pull_result(
            &fresh.state,
            &test_effect(),
            &fresh.pivot,
            &fresh.bi,
            &fresh.scripts,
            &fresh.ribbon,
            &fresh.pane,
            &fresh.slicer,
            &fresh.timeline,
            pull_latest(&dir, prof.path(), "copy-b"),
            MaterializeMode::Subscribe,
            None,
        )
        .expect_err("a subscribe minted a model under an id a subscription claims");
        assert!(err.contains("CALP_DATA_SOURCE_SHARED") && err.contains("'literals'"), "{err}");
        assert_eq!(count(&fresh, &source_key), 0);
    }
    // Two payloads carrying one id, with ledgers that claim nothing: refused.
    {
        let effect = test_effect();
        let mut subs = s.state.subscriptions.write(&effect).unwrap();
        let saved: Vec<Vec<calp::manifest::SubscribedObject>> =
            subs.subscriptions.iter().map(|x| x.objects.clone()).collect();
        for sub in subs.subscriptions.iter_mut() {
            sub.objects.retain(|o| o.kind != "dataSource");
        }
        drop(subs);
        let err = crate::calp_commands::refuse_refreshed_data_sources_already_served(
            &s.state,
            &s.bi,
            &[payload(0, "literals"), payload(1, "copy-b")],
        )
        .expect_err("two payloads of one refresh under one id");
        assert!(err.contains("CALP_DATA_SOURCE_SHARED"), "{err}");
        let mut subs = s.state.subscriptions.write(&effect).unwrap();
        for (sub, objects) in subs.subscriptions.iter_mut().zip(saved) {
            sub.objects = objects;
        }
    }

    // The copy is published again under its own id and updated: admitted, and
    // its ledger no longer claims the original's id.
    publish_with_model(&dir, prof.path(), &other, vec![0], "copy-b", (2, 0, 0), Some((1, 0, 0)), &copy_key);
    s.refresh(vec![(1, pull_latest(&dir, prof.path(), "copy-b"))]);
    {
        let subs = s.state.subscriptions.read().unwrap();
        let claims: Vec<&str> = subs.subscriptions[1]
            .objects
            .iter()
            .filter(|o| o.kind == "dataSource")
            .map(|o| o.id.as_str())
            .collect();
        assert_eq!(claims, vec![copy_key.as_str()], "the copy's ledger still claims the shared id");
    }
    assert_eq!(count(&s, &copy_key), 1, "the copy's own model is connected");

    // The after-refresh re-ask (as `apply_refresh_payloads` runs it, over this
    // test's trust profile): the original's model is connected and the rows say so.
    crate::calp_commands::reconnect_application_models_after_refresh_in(
        &s.state,
        &test_effect(),
        &s.bi,
        &s.pivot,
        &s.ribbon,
        &s.slicer,
        prof.path(),
    );
    assert_eq!(count(&s, &source_key), 1, "the original's model was not connected after the update");
    let rows = s.state.application_connection_restore_skips.lock().unwrap().clone();
    assert!(rows.is_empty(), "the pane's rows were not re-asked: {rows:?}");
    // ...and the original refreshes onto it from now on.
    crate::calp_commands::refuse_refreshed_data_sources_already_served(&s.state, &s.bi, &[payload(0, "literals")])
        .expect("the original refreshes onto its own connection");
    // The refresh runs the re-ask itself, with no guard held.
    let code = crate_fn_code("src/calp_commands.rs", "pub(crate) fn apply_refresh_payloads(");
    assert!(code.contains("reconnect_application_models_after_refresh_in("), "the refresh no longer re-asks");
}

/// rev14B (MAJOR): the remedy for two subscriptions claiming one data-source
/// id is to re-publish the copy under its own id. When BOTH applications had
/// an update, Refresh Subscriptions ran both payloads in one refresh: the
/// original's payload minted its model under the shared id, and the copy's
/// ledger merge then kept its stale claim on that id because "a live
/// connection serves it" -- the ORIGINAL's, minted a moment earlier. The
/// original's next refresh was refused again (CALP_DATA_SOURCE_SHARED naming
/// the copy) and the next open connected neither. A carried claim now counts
/// only connections that were live BEFORE the refresh
/// (`data_source_claim_carries`).
///
/// SABOTAGE: read the merge's liveness AFTER the payload loop again (as round
/// 15 did) -- the copy's ledger still claims the shared id.
#[test]
fn a_refresh_of_the_original_and_its_re_keyed_copy_together_drops_the_copys_stale_claim() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let source_key = new_entity().to_string();
    let copy_key = new_entity().to_string();
    let mut wb = Workbook::default();
    wb.sheets = vec![Sheet::new("Dashboard".to_string())];
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (1, 0, 0), None, &source_key);
    let mut other = Workbook::default();
    other.sheets = vec![Sheet::new("Report".to_string())];
    publish_with_model(&dir, prof.path(), &other, vec![0], "copy-b", (1, 0, 0), None, &source_key);
    let count = |h: &Harness, key: &str| {
        h.bi.connections
            .lock()
            .unwrap()
            .values()
            .filter(|c| c.package_data_source_id.as_deref() == Some(key))
            .count()
    };
    let claims_of = |h: &Harness, index: usize| -> Vec<String> {
        h.state.subscriptions.read().unwrap().subscriptions[index]
            .objects
            .iter()
            .filter(|o| o.kind == "dataSource")
            .map(|o| o.id.clone())
            .collect()
    };

    // The document the open leaves: two subscriptions claiming one id,
    // NEITHER model connected.
    let s = Harness::new();
    s.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    {
        let effect = test_effect();
        let mut subs = s.state.subscriptions.write(&effect).unwrap();
        let mut twin = subs.subscriptions[0].clone();
        twin.package_name = "copy-b".to_string();
        twin.sheets.clear();
        twin.objects.retain(|o| o.kind == "dataSource");
        subs.subscriptions.push(twin);
    }
    s.bi.connections.lock().unwrap().clear();
    assert_eq!(claims_of(&s, 1), vec![source_key.clone()], "precondition: the copy claims the shared id");
    assert_eq!(count(&s, &source_key), 0, "precondition: the open connected neither");

    // The copy is re-published under its own id AND the original has a new
    // version: Refresh Subscriptions updates both in one refresh.
    publish_with_model(&dir, prof.path(), &other, vec![0], "copy-b", (2, 0, 0), Some((1, 0, 0)), &copy_key);
    publish_with_model(&dir, prof.path(), &wb, vec![0], "literals", (2, 0, 0), Some((1, 0, 0)), &source_key);
    s.refresh(vec![
        (0, pull_latest(&dir, prof.path(), "literals")),
        (1, pull_latest(&dir, prof.path(), "copy-b")),
    ]);
    assert_eq!(count(&s, &source_key), 1, "the original's model is connected by its own update");
    assert_eq!(count(&s, &copy_key), 1, "the copy's own model is connected");
    assert_eq!(
        claims_of(&s, 1),
        vec![copy_key.clone()],
        "the copy kept its stale claim on the shared id alive on the original's freshly minted connection"
    );
    assert_eq!(claims_of(&s, 0), vec![source_key.clone()], "the original claims its own id once");

    // ...so the original's next refresh is admitted, alone or beside the copy.
    let payload = |index: usize, package: &str| calp::refresh::RefreshPayload {
        subscription_index: index,
        pull_result: pull_latest(&dir, prof.path(), package),
    };
    crate::calp_commands::refuse_refreshed_data_sources_already_served(&s.state, &s.bi, &[payload(0, "literals")])
        .expect("the original's next refresh was refused for the copy's stale claim");
    crate::calp_commands::refuse_refreshed_data_sources_already_served(
        &s.state,
        &s.bi,
        &[payload(0, "literals"), payload(1, "copy-b")],
    )
    .expect("a Refresh-all of both was refused");
}

/// The byte offset of the first `AppState` guard taken in `code`: the first
/// `state.<store>.read(` / `.write(` / `.lock(` / `.lock_pending(`, where `state`
/// is the whole receiver (not `pivot_state.` or `bi_state.`).
fn first_state_guard(code: &str) -> Option<usize> {
    let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut first: Option<usize> = None;
    for method in [".read(", ".write(", ".lock(", ".lock_pending("] {
        for (at, _) in code.match_indices(method) {
            let before = &code[..at];
            let field_start = before.rfind(|c: char| !is_ident(c)).map_or(0, |i| i + 1);
            if field_start == at {
                continue;
            }
            let Some(receiver) = before[..field_start].strip_suffix("state.") else {
                continue;
            };
            if receiver.chars().last().is_some_and(is_ident) {
                continue;
            }
            let start = receiver.len();
            first = Some(first.map_or(start, |f| f.min(start)));
        }
    }
    first
}

/// The CODE (comments stripped per line) of one top-level function of the
/// crate file `rel` (relative to the crate root), from `signature` to the next
/// top-level item.
fn crate_fn_code(rel: &str, signature: &str) -> String {
    let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel))
        .unwrap_or_else(|e| panic!("cannot read {rel}: {e}"));
    let src = src.replace("\r\n", "\n");
    let start = src.find(signature).unwrap_or_else(|| panic!("{rel} no longer has `{signature}`"));
    let rest = &src[start + signature.len()..];
    let end = ["\npub fn ", "\npub(crate) fn ", "\nfn ", "\n#[tauri::command]", "\n#[cfg(test)]"]
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

/// EVERY DOOR THAT SERIALISES THE CHART STORE STAMPS IT. The compiler already
/// forces every caller of `build_workbook_for_save` to hand in the BI store and
/// every caller of `collect_charts_for_save` to hand in a key map; what it
/// cannot force is that the map is the LIVE one, taken before the document
/// locks, and that no second serialiser exists. This pins both:
/// - the collector stamps, and its one caller (the shared builder) copies the
///   live keys out FIRST -- before any `AppState` guard -- and passes them;
/// - the `.cala` save and AutoRecover (`assemble_workbook_for_save`) and the
///   `.calp` publish, preview and working-copy diff (`assemble_publish_workbook`
///   through `build_workbook_for_save_with_slicers`) all go through it;
/// - nothing else in the crate calls the collector.
///
/// SABOTAGE: pass `&ChartConnectionKeys::new()` instead of `&chart_keys` in
/// `build_workbook_for_save` -- the builder assertion fails. Or compute the
/// carrier's keys (`published_chart_connection_keys(bi_state)`) after the
/// builder's first AppState guard -- the key-order assertion fails. Or build the
/// carrier with `ChartKeysFor::Document` in `build_workbook_for_save_with_slicers`
/// -- the carrier assertion fails, and this is the ONLY test that catches it:
/// the behavioural carrier test cannot reach that builder (it takes Tauri
/// `State` handles), so this pin is that choice's sole guard.
#[test]
fn every_door_that_serialises_charts_stamps_them_through_the_one_collector() {
    let collect = crate_fn_code("src/persistence.rs", "pub(crate) fn collect_charts_for_save(");
    assert!(collect.contains("stamp_saved_chart_package_keys("), "the collector no longer stamps the package key");

    let build = crate_fn_code("src/persistence.rs", "pub fn build_workbook_for_save(");
    let first_guard = first_state_guard(&build).expect("the builder no longer takes any AppState guard");
    // EVERY copy of the BI keys comes before that guard -- the `.cala` arm's
    // `chart_connection_keys(` AND the carrier arm's
    // `published_chart_connection_keys(`, which contains it. A `find` saw only
    // the first (review RB1-WIRING-PIN-GAPS (a)): computing the carrier's keys
    // after `state.grid.read()` kept this test green while the publish, the
    // preview and the working-copy diff took the BI lock under every guard.
    let key_copies: Vec<usize> = build.match_indices("chart_connection_keys(").map(|(at, _)| at).collect();
    assert!(
        key_copies.len() >= 2,
        "the builder no longer copies the keys for both the document and the carrier: {key_copies:?}"
    );
    for at in &key_copies {
        assert!(
            *at < first_guard,
            "a copy of the BI keys (byte {at} of the builder) comes after its first AppState guard (byte \
             {first_guard}): the BI connections must be copied out before any AppState guard is taken"
        );
    }
    assert!(
        build.contains("collect_charts_for_save(state, &sheet_ids, &chart_keys)"),
        "the builder no longer hands the LIVE keys to the collector"
    );

    assert!(build.contains("published_chart_connection_keys(bi_state)"), "the builder no longer offers the carrier's keys");
    // The .cala save and AutoRecover build through ONE snapshot attempt, taken
    // again until no sheet renumbering overlapped it (F1, review round 7): the
    // door names the attempt, and the attempt builds with the document's keys.
    let save_door = crate_fn_code("src/persistence.rs", "pub(crate) fn assemble_workbook_for_save(");
    assert!(
        save_door.contains("take_consistent_snapshot(") && save_door.contains("assemble_workbook_snapshot("),
        "the .cala save no longer builds through its validated snapshot attempt"
    );
    let save = crate_fn_code("src/persistence.rs", "pub(crate) fn assemble_workbook_snapshot(");
    assert!(
        save.contains("build_workbook_for_save(state, user_files_state, bi_state, ChartKeysFor::Document)"),
        "the .cala save keeps the key the next open re-binds by"
    );
    let carrier = crate_fn_code("src/persistence.rs", "pub fn build_workbook_for_save_with_slicers(");
    assert!(
        carrier.contains("build_workbook_for_save(state, user_files_state, bi_state, ChartKeysFor::Package)"),
        "the .calp carrier writes the id its data sources are filed under (review RB-1)"
    );
    // ONE function names a published data source, for the embedded data source
    // and for the chart's key alike.
    let published = crate_fn_code("src/persistence.rs", "pub(crate) fn published_chart_connection_keys(");
    assert!(published.contains("published_data_source_id("), "the carrier's keys no longer come from published_data_source_id");
    let capture = calp_commands_fn_code("fn capture_bi_data_sources_of(");
    assert!(capture.contains("published_data_source_id(conn)"), "the capture no longer files data sources under published_data_source_id");
    // The publish door takes one validated attempt at a time; the attempt holds
    // the carrier's build.
    let publish_door = calp_commands_fn_code("fn assemble_publish_workbook(");
    assert!(
        publish_door.contains("take_consistent_snapshot(") && publish_door.contains("assemble_publish_snapshot("),
        "the publish door no longer builds through its validated snapshot attempt"
    );
    let publish = calp_commands_fn_code("fn assemble_publish_snapshot(");
    let call = publish.find("build_workbook_for_save_with_slicers(").expect("the publish assembly");
    let args = &publish[call..call + publish[call..].find(")?;").expect("the call's end")];
    assert!(args.contains("bi_state"), "the publish assembly no longer hands the BI store to the carrier: {args}");

    for (rel, door, assembler) in [
        ("src/persistence.rs", "pub fn save_file(", "assemble_workbook_for_save("),
        ("src/persistence.rs", "pub fn auto_recover_save(", "assemble_workbook_for_save("),
        ("src/calp_commands.rs", "pub fn calp_publish(", "assemble_publish_workbook("),
        ("src/calp_commands.rs", "pub fn calp_publish_preview(", "assemble_publish_workbook("),
        ("src/calp_commands.rs", "pub(crate) fn publish_into_for_preview(", "assemble_publish_workbook("),
    ] {
        assert!(crate_fn_code(rel, door).contains(assembler), "`{door}` no longer builds through `{assembler}`");
    }

    // No second serialiser: outside test files, the collector is defined once
    // and called once.
    fn rust_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    rust_files(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let mut calls: Vec<String> = Vec::new();
    for path in files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if name.ends_with("tests.rs") {
            continue;
        }
        let src = std::fs::read_to_string(&path).unwrap();
        for (n, line) in src.lines().enumerate() {
            let code = line.split("//").next().unwrap_or("");
            if code.contains("collect_charts_for_save(") && !code.contains("fn collect_charts_for_save(") {
                calls.push(format!("{}:{}", name, n + 1));
            }
        }
    }
    assert_eq!(calls.len(), 1, "the chart store must be serialised through exactly one call: {calls:?}");
    assert!(calls[0].starts_with("persistence.rs:"), "{calls:?}");
}

// ---------------------------------------------------------------------------
// rev5B#1 (BUG-0476): the results cache of the sheets an install brings
// ---------------------------------------------------------------------------

/// A formula cell carrying the value its workbook last computed.
fn saved_formula(formula: &str, value: engine::CellValue) -> SavedCell {
    let mut cell = Cell::new_formula(formula.to_string());
    cell.value = value;
    SavedCell::from_cell(&cell)
}

/// What `save_file` runs before every Ctrl+S (`calculate_before_save`): the
/// workbook pass with no cube data and no custom-function resolver.
fn the_save_recalculation(h: &Harness) {
    crate::calculation::run_calculation_pass(
        crate::calculation::CalcScope::Workbook,
        None,
        &h.state,
        &crate::persistence::UserFilesState::default(),
        &h.pivot,
        &h.pane,
        &h.ribbon,
        None,
    )
    .expect("the save's recalculation runs");
}

fn value_at(h: &Harness, sheet: usize, row: u32, col: u32) -> engine::CellValue {
    h.state.grids.read().unwrap()[sheet]
        .get_cell(row, col)
        .map(|c| c.value.clone())
        .unwrap_or(engine::CellValue::Empty)
}

/// Checkout, then Ctrl+S, then an edit. The application's cube and
/// custom-function cells arrive with the values the publisher's workbook
/// computed; nothing seeded their results cache (only an open did), so the
/// save's recalculation refused every one and saved `#N/A` / `#NAME?` -- and
/// any later recalculation without data that reached them did the same.
///
/// SABOTAGE (seeding): drop the `remember_installed_call_results` call in
/// `materialize_pull_result` -- the edit's cascade then refuses B1.
#[test]
fn a_checked_out_application_keeps_its_cube_and_custom_function_values_through_a_save() {
    use engine::CellValue;
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut sheet = Sheet::new("Report".to_string());
    sheet.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(3.0)));
    sheet
        .cells
        .insert((1, 0), SavedCell::from_cell(&Cell::new_text("Sales[country]=USA".to_string())));
    sheet.cells.insert((0, 1), saved_formula("=MYFN(A1)", CellValue::Number(42.0)));
    sheet
        .cells
        .insert((1, 1), saved_formula(r#"=CUBEVALUE("Sales","[Revenue]",A2)"#, CellValue::Number(175.0)));
    sheet.cells.insert((2, 1), saved_formula("=MYFN(A1+1)*2", CellValue::Number(100.0)));
    sheet
        .cells
        .insert((3, 1), saved_formula(r#"=CUBEVALUE("Sales","[Revenue]",A2)/1000"#, CellValue::Number(0.175)));
    let mut wb = Workbook::default();
    wb.sheets = vec![sheet];
    let pulled = publish_and_pull(&dir, prof.path(), &wb);

    let h = Harness::new();
    h.empty_as_checkout_does();
    h.materialize(pulled, MaterializeMode::Checkout);

    for save in 1..=2 {
        the_save_recalculation(&h);
        assert_eq!(value_at(&h, 0, 0, 1), CellValue::Number(42.0), "save {save}: =MYFN(A1)");
        assert_eq!(value_at(&h, 0, 1, 1), CellValue::Number(175.0), "save {save}: =CUBEVALUE(..,A2)");
        assert_eq!(value_at(&h, 0, 2, 1), CellValue::Number(100.0), "save {save}: =MYFN(A1+1)*2");
        assert_eq!(value_at(&h, 0, 3, 1), CellValue::Number(0.175), "save {save}: =CUBEVALUE(..,A2)/1000");
    }

    // An edit without a resolver that rewrites A1 with the SAME value: its
    // cascade re-evaluates B1, which must be answered from the seeded cache,
    // exactly as after an open -- and a new value is refused, never 42. The
    // cascade walks the active sheet's dependency maps, which the frontend's
    // activation of the working copy's sheet rebuilds; this stands in for it.
    crate::undo_commands::rebuild_all_dependencies(&h.state);
    let batch = |value: &str| {
        crate::commands::data::update_cells_batch_core(
            &h.state,
            &crate::persistence::FileState::default(),
            &crate::persistence::UserFilesState::default(),
            &h.pivot,
            vec![crate::api_types::CellUpdateInput {
                row: 0,
                col: 0,
                value: value.to_string(),
                style_index: None,
                invariant: Some(true),
                pasted: None,
                moved: None,
                source: None,
            }],
            None,
            None,
            None,
            None,
        )
        .expect("the batch writes");
    };
    batch("3");
    assert_eq!(value_at(&h, 0, 0, 1), CellValue::Number(42.0), "the cascade served MYFN(3) from the seeded cache");
    batch("4");
    assert_eq!(
        value_at(&h, 0, 0, 1),
        CellValue::Error(engine::CellError::Name),
        "MYFN(4) was never answered: refused, never MYFN(3)'s 42"
    );
}

/// SUBSCRIBE an application whose formula reads a sheet it did not publish:
/// `=MYFN(Inputs!A1)*2` was computed against the PUBLISHER's Inputs (3 -> 84)
/// and here reads the subscriber's own Inputs (5). That value is not this
/// workbook's answer, so the install must not let the save's recalculation
/// keep it; a self-contained cell on another pulled sheet still is kept.
///
/// SABOTAGE: `InstallScope::is_foreign` answers false.
#[test]
fn a_subscribed_cell_reading_what_the_application_did_not_bring_is_refused_not_kept() {
    use engine::CellValue;
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut report = Sheet::new("Report".to_string());
    report.cells.insert((0, 1), saved_formula("=MYFN(Inputs!A1)*2", CellValue::Number(84.0)));
    let mut summary = Sheet::new("Summary".to_string());
    summary.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(3.0)));
    summary.cells.insert((0, 1), saved_formula("=MYFN(A1)*2", CellValue::Number(84.0)));
    let mut inputs = Sheet::new("Inputs".to_string());
    inputs.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(3.0)));
    let mut wb = Workbook::default();
    wb.sheets = vec![report, summary, inputs];
    publish_sheets(&dir, prof.path(), &wb, vec![0, 1]);
    let pulled = subscribe_pull(&dir, prof.path());

    let h = Harness::new();
    {
        let effect = test_effect();
        h.state.sheet_names.write(&effect).unwrap()[0] = "Inputs".to_string();
        let mut grid = h.state.grid.write(&effect).unwrap();
        let mut grids = h.state.grids.write(&effect).unwrap();
        grid.set_cell(0, 0, Cell::new_number(5.0));
        grids[0].set_cell(0, 0, Cell::new_number(5.0));
    }
    h.materialize(pulled, MaterializeMode::Subscribe);
    let names = h.state.sheet_names.read().unwrap().clone();
    let report_at = names.iter().position(|n| n == "Report").expect("Report landed");
    let summary_at = names.iter().position(|n| n == "Summary").expect("Summary landed");

    the_save_recalculation(&h);
    assert_eq!(
        value_at(&h, report_at, 0, 1),
        CellValue::Error(engine::CellError::Name),
        "the save kept the publisher's MYFN(3)*2 beside this workbook's Inputs!A1 = 5"
    );
    assert_eq!(
        value_at(&h, summary_at, 0, 1),
        CellValue::Number(84.0),
        "a cell reading only what the application brought keeps its value"
    );
}

/// UPDATE, then Ctrl+S (NEW-update-refuses-composite-formulas). The update
/// re-evaluated every refreshed sheet with the cascade rule, which refuses a
/// cube or custom-function call the results cache cannot answer -- and the
/// install seeds only ROOT calls -- so every composite formula on an updated
/// sheet became `#NAME?` / `#N/A`, and the save kept the refusal. The
/// update's recalculation now keeps the publisher's value while nothing the
/// cell reads was written by the update (an override here) or changed by the
/// recalculation, and refuses it whole otherwise.
///
/// SABOTAGE (keep): call `recalculate_sheet_values` per refreshed sheet again
/// -- B1 and B2 are refused. SABOTAGE (changed set): drop the `written` cells
/// from `KeepWithoutData::for_installed_sheets` -- B3 keeps MYFN(5)'s 20
/// beside the override's 6. (Data is visited before Report since rev8A --
/// Report reads it -- so B4 is judged against Data's own changes, exactly;
/// the unsettled-sheet rule is pinned by
/// `an_update_judges_a_cell_after_the_installed_sheets_it_reads`.)
#[test]
fn an_updated_application_keeps_its_composite_values_through_a_save_and_refuses_what_an_override_changed() {
    use engine::CellValue;
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut report = Sheet::new("Report".to_string());
    report.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(3.0)));
    report
        .cells
        .insert((1, 0), SavedCell::from_cell(&Cell::new_text("Sales[country]=USA".to_string())));
    report.cells.insert((2, 0), SavedCell::from_cell(&Cell::new_number(5.0)));
    report.cells.insert((0, 1), saved_formula("=MYFN(A1)*2", CellValue::Number(84.0)));
    report
        .cells
        .insert((1, 1), saved_formula(r#"=CUBEVALUE("Sales","[Revenue]",A2)/1000"#, CellValue::Number(0.175)));
    report.cells.insert((2, 1), saved_formula("=MYFN(A3)*2", CellValue::Number(20.0)));
    report.cells.insert((3, 1), saved_formula("=MYFN(Data!A1)*2", CellValue::Number(84.0)));
    report.cells.insert((0, 2), SavedCell::from_cell(&Cell::new_number(1.0)));
    // Data comes AFTER Report: its A1 (=A2) is recalculated on its own turn.
    let mut data = Sheet::new("Data".to_string());
    data.cells.insert((0, 0), saved_formula("=A2", CellValue::Number(3.0)));
    data.cells.insert((1, 0), SavedCell::from_cell(&Cell::new_number(3.0)));
    let mut wb = Workbook::default();
    wb.sheets = vec![report, data];
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "composites", (1, 0, 0), None);

    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "composites"), MaterializeMode::Subscribe);
    let (at, data_at) = (h.index_of("Report"), h.index_of("Data"));
    assert!(at < data_at, "precondition: Report is recalculated before Data");

    // The subscriber overrides Report!A3 (5 -> 6) and Data!A2 (3 -> 4).
    {
        let effect = test_effect();
        for (sheet, position, from, to) in [(at, (2, 0), "5", 6.0), (data_at, (1, 0), "3", 4.0)] {
            let local = h.state.sheet_ids.read().unwrap()[sheet];
            h.state.grids.write(&effect).unwrap()[sheet].set_cell(position.0, position.1, Cell::new_number(to));
            h.state.override_layer.write(&effect).unwrap().set_override(calp::CellOverride {
                sheet_id: local,
                cell_id: identity::CellId::from_bytes(identity::generate_uuid_v7()),
                position,
                baseline: calp::OverrideValue::Value { display: from.to_string() },
                current: calp::OverrideValue::Value { display: format!("{}", to) },
                created_at: "2026-09-25T00:00:00Z".to_string(),
                modified_at: "2026-09-25T00:00:00Z".to_string(),
                author: String::new(),
                conflict: false,
                upstream_new: None,
                extra: std::collections::HashMap::new(),
            });
        }
    }

    // v2 changes something else; the formulas and their inputs are as they were.
    wb.sheets[0].cells.insert((0, 2), SavedCell::from_cell(&Cell::new_number(2.0)));
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "composites", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "composites"))]);

    let (at, data_at) = (h.index_of("Report"), h.index_of("Data"));
    assert_eq!(value_at(&h, at, 0, 2), CellValue::Number(2.0), "precondition: v2 landed");
    assert_eq!(value_at(&h, at, 2, 0), CellValue::Number(6.0), "precondition: the override was painted back");
    assert_eq!(value_at(&h, data_at, 0, 0), CellValue::Number(4.0), "precondition: Data!A1 follows its override");
    for pass in ["the update", "a save after it"] {
        assert_eq!(value_at(&h, at, 0, 1), CellValue::Number(84.0), "{pass}: =MYFN(A1)*2 refused");
        assert_eq!(value_at(&h, at, 1, 1), CellValue::Number(0.175), "{pass}: =CUBEVALUE(..,A2)/1000 refused");
        assert_eq!(
            value_at(&h, at, 2, 1),
            CellValue::Error(engine::CellError::Name),
            "{pass}: =MYFN(A3)*2 kept the publisher's MYFN(5)*2 beside the subscriber's A3 = 6"
        );
        assert_eq!(
            value_at(&h, at, 3, 1),
            CellValue::Error(engine::CellError::Name),
            "{pass}: =MYFN(Data!A1)*2 kept the publisher's MYFN(3)*2 although Data!A1 is now 4"
        );
        the_save_recalculation(&h);
    }
}

/// rev8A: an UPDATE refused -- and the save then kept the refusal of -- a
/// composite custom-function formula on an EARLIER installed sheet that reads
/// a LATER one, even when nothing it reads changed: the sheets were visited in
/// index order and every reference into a sheet not yet visited counted as
/// changed, a literal no recalculation can change included. Report first, data
/// after is the common layout. A sheet is now visited after the installed
/// sheets it reads. Two sheets that read EACH OTHER still meet an unsettled
/// sheet, and there the rule stays conservative.
///
/// SABOTAGE: `installed_sheet_order` returns the sheets in index order.
#[test]
fn an_update_judges_a_cell_after_the_installed_sheets_it_reads() {
    use engine::CellValue;
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut report = Sheet::new("Report".to_string());
    report.cells.insert((3, 1), saved_formula("=MYFN(Data!A2)*2", CellValue::Number(84.0)));
    report.cells.insert((4, 1), saved_formula("=MYFN(Data!A1)*2", CellValue::Number(84.0)));
    report.cells.insert((0, 2), SavedCell::from_cell(&Cell::new_number(1.0)));
    let mut data = Sheet::new("Data".to_string());
    data.cells.insert((0, 0), saved_formula("=A2", CellValue::Number(3.0)));
    data.cells.insert((1, 0), SavedCell::from_cell(&Cell::new_number(3.0)));
    let mut wb = Workbook::default();
    wb.sheets = vec![report, data];
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "readsafter", (1, 0, 0), None);

    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "readsafter"), MaterializeMode::Subscribe);
    let (at, data_at) = (h.index_of("Report"), h.index_of("Data"));
    assert!(at < data_at, "precondition: Report comes before the Data it reads");
    assert_eq!(value_at(&h, at, 3, 1), CellValue::Number(84.0), "precondition: subscribed");

    // v2 changes something else; every formula and its inputs are as they were.
    wb.sheets[0].cells.insert((0, 2), SavedCell::from_cell(&Cell::new_number(2.0)));
    publish_as(&dir, prof.path(), &wb, vec![0, 1], "readsafter", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "readsafter"))]);

    let at = h.index_of("Report");
    assert_eq!(value_at(&h, at, 0, 2), CellValue::Number(2.0), "precondition: v2 landed");
    for pass in ["the update", "a save after it"] {
        assert_eq!(
            value_at(&h, at, 3, 1),
            CellValue::Number(84.0),
            "{pass}: =MYFN(Data!A2)*2 refused although Data!A2 is a literal nothing changed"
        );
        assert_eq!(
            value_at(&h, at, 4, 1),
            CellValue::Number(84.0),
            "{pass}: =MYFN(Data!A1)*2 refused although Data!A1 recalculated to the same 3"
        );
        the_save_recalculation(&h);
    }
}

/// rev8A: an application UPDATE that replaces a custom function's code left
/// the old code's answers in the results cache, and a recalculation without a
/// resolver (the cross-sheet walk, F9, the save) served one for an argument no
/// cell held at the update as current, with no error. The update now forgets
/// every answer of a function whose definition changed, BEFORE it seeds the
/// refreshed sheets with the new code's saved values.
///
/// SABOTAGE: drop the `forget_redefined_custom_functions` call after the
/// library merge in `materialize_distributed_scripts`.
#[test]
fn an_update_that_replaces_a_custom_functions_code_forgets_the_old_codes_answers() {
    use engine::CellValue;
    let library = |body: &str| persistence::SavedScript {
        id: "__calcula_custom_functions__".to_string(),
        name: "Custom Functions (data)".to_string(),
        description: None,
        source: serde_json::json!({ "functions": [{ "name": "MYFN", "params": ["x"], "body": body }] }).to_string(),
        scope: Default::default(),
        source_package: None,
    };
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut report = Sheet::new("Report".to_string());
    report.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(3.0)));
    report.cells.insert((0, 1), saved_formula("=MYFN(A1)", CellValue::Number(30.0)));
    let mut wb = Workbook::default();
    wb.sheets = vec![report];
    wb.scripts = vec![library("return x*10;")];
    publish_as(&dir, prof.path(), &wb, vec![0], "codechange", (1, 0, 0), None);

    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "codechange"), MaterializeMode::Subscribe);
    let at = h.index_of("Report");
    let own = h.index_of("Sheet1");
    let memo_of = |sheet: usize| h.state.grids.read().unwrap()[sheet].call_memo().clone();
    let call = |x: f64| engine::cube::udf_call_fingerprint("MYFN", &[engine::EvalResult::Number(x)]).unwrap();
    assert_eq!(memo_of(at).answer(&call(3.0)), Some(engine::EvalResult::Number(30.0)), "precondition: seeded");
    // An answer the v1 code gave on the subscriber's OWN sheet for an argument
    // no cell holds at the update (`=MYFN(Report!A1)` there, served by the
    // resolver while Report!A1 was 4).
    memo_of(own).remember(call(4.0), &engine::EvalResult::Number(40.0));

    // v2: MYFN's code changes, and the saved value with it.
    wb.scripts = vec![library("return x*100;")];
    wb.sheets[0].cells.insert((0, 1), saved_formula("=MYFN(A1)", CellValue::Number(300.0)));
    publish_as(&dir, prof.path(), &wb, vec![0], "codechange", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "codechange"))]);

    let (at, own) = (h.index_of("Report"), h.index_of("Sheet1"));
    assert!(
        h.scripts.workbook_scripts.read().unwrap()["__calcula_custom_functions__"].source.contains("x*100"),
        "precondition: the update merged the new code"
    );
    assert_eq!(memo_of(own).answer(&call(4.0)), None, "the update kept the OLD code's MYFN(4) = 40");
    assert_eq!(
        memo_of(at).answer(&call(3.0)),
        Some(engine::EvalResult::Number(300.0)),
        "the refreshed sheet is seeded with the NEW code's saved value"
    );
}

/// rev10B: the forget ran once, AFTER the refresh's whole per-payload loop, so
/// an update whose SECOND payload failed returned with the first payload's new
/// library merged and every results cache still holding the old code's
/// answers -- which F9 and the save then served as current. The forget is now
/// part of each payload's library write, so it has happened whatever fails
/// afterwards. The failure here is the materialization's own inner door (a
/// reserved notebook id that reached it past the pre-effect gate).
///
/// SABOTAGE: drop the `forget_redefined_custom_functions` call after the
/// library merge in `materialize_distributed_scripts`.
#[test]
fn an_update_that_fails_after_merging_a_library_still_forgets_the_old_codes_answers() {
    use engine::CellValue;
    let library = |body: &str| persistence::SavedScript {
        id: "__calcula_custom_functions__".to_string(),
        name: "Custom Functions (data)".to_string(),
        description: None,
        source: serde_json::json!({ "functions": [{ "name": "MYFN", "params": ["x"], "body": body }] }).to_string(),
        scope: Default::default(),
        source_package: None,
    };
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut report = Sheet::new("Report".to_string());
    report.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(3.0)));
    report.cells.insert((0, 1), saved_formula("=MYFN(A1)", CellValue::Number(30.0)));
    let mut wb = Workbook::default();
    wb.sheets = vec![report];
    wb.scripts = vec![library("return x*10;")];
    publish_as(&dir, prof.path(), &wb, vec![0], "cflib", (1, 0, 0), None);
    let mut other = Workbook::default();
    let mut data = Sheet::new("Data".to_string());
    data.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(1.0)));
    other.sheets = vec![data];
    publish_as(&dir, prof.path(), &other, vec![0], "cfother", (1, 0, 0), None);

    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "cflib"), MaterializeMode::Subscribe);
    h.materialize(pull_latest(&dir, prof.path(), "cfother"), MaterializeMode::Subscribe);
    let own = h.index_of("Sheet1");
    let memo_of = |sheet: usize| h.state.grids.read().unwrap()[sheet].call_memo().clone();
    let call = |x: f64| engine::cube::udf_call_fingerprint("MYFN", &[engine::EvalResult::Number(x)]).unwrap();
    // An answer the v1 code gave on the subscriber's own sheet.
    memo_of(own).remember(call(4.0), &engine::EvalResult::Number(40.0));

    wb.scripts = vec![library("return x*100;")];
    wb.sheets[0].cells.insert((0, 1), saved_formula("=MYFN(A1)", CellValue::Number(300.0)));
    publish_as(&dir, prof.path(), &wb, vec![0], "cflib", (1, 1, 0), Some((1, 0, 0)));
    other.sheets[0].cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(2.0)));
    publish_as(&dir, prof.path(), &other, vec![0], "cfother", (1, 1, 0), Some((1, 0, 0)));

    let mut payloads = vec![
        calp::refresh::RefreshPayload { subscription_index: 0, pull_result: pull_latest(&dir, prof.path(), "cflib") },
        calp::refresh::RefreshPayload { subscription_index: 1, pull_result: pull_latest(&dir, prof.path(), "cfother") },
    ];
    let names = crate::calp_commands::prepare_refresh_payloads(&h.state, &mut payloads)
        .expect("the pre-effect pass admits both payloads");
    // The SECOND payload now fails inside its materialization, after the
    // first one's library has been merged.
    payloads[1].pull_result.notebooks.push(persistence::SavedNotebook {
        id: "__calcula_reserved_notebook".to_string(),
        name: "N".to_string(),
        cells: Vec::new(),
        source_package: Some("cfother".to_string()),
    });
    let err = crate::calp_commands::apply_refresh_payloads(
        &h.state,
        &test_effect(),
        &crate::persistence::UserFilesState::default(),
        &h.pivot,
        &h.scripts,
        &h.bi,
        &h.ribbon,
        &h.pane,
        &h.slicer,
        &h.timeline,
        payloads,
        names,
        &[],
        "2026-09-25T02:00:00Z",
        None,
    )
    .expect_err("precondition: the second payload's materialization refuses");
    assert!(err.contains("__calcula_reserved_notebook"), "precondition: refused at the inner door: {err}");
    assert!(
        h.scripts.workbook_scripts.read().unwrap()["__calcula_custom_functions__"].source.contains("x*100"),
        "precondition: the first payload merged the new code before the failure"
    );
    assert_eq!(
        memo_of(own).answer(&call(4.0)),
        None,
        "the failed update left the OLD code's MYFN(4) = 40 beside the NEW code in the library"
    );
}

/// rev10 cache2 residual (the calp window): the update merges the new
/// library in the backend and forgets the old code's answers, but the page
/// keeps serving edits from its OLD realm until it hears
/// `custom-functions:refresh` and re-installs. An answer served in that window
/// is the old code's: it answers its edit, but it must not be filed for the
/// cross-sheet walk, F9 or the save. Once the page reports the generation the
/// event carried, served answers are filed again.
///
/// SABOTAGE: drop the `hold_custom_functions_until_reinstalled` call after the
/// library merge in `materialize_distributed_scripts`.
#[test]
fn an_answer_the_old_realm_serves_before_the_page_reinstalls_is_never_filed() {
    use engine::CellValue;
    let library = |body: &str| persistence::SavedScript {
        id: "__calcula_custom_functions__".to_string(),
        name: "Custom Functions (data)".to_string(),
        description: None,
        source: serde_json::json!({ "functions": [{ "name": "MYFN", "params": ["x"], "body": body }] }).to_string(),
        scope: Default::default(),
        source_package: None,
    };
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut report = Sheet::new("Report".to_string());
    report.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(3.0)));
    report.cells.insert((0, 1), saved_formula("=MYFN(A1)", CellValue::Number(30.0)));
    let mut wb = Workbook::default();
    wb.sheets = vec![report];
    wb.scripts = vec![library("return x*10;")];
    publish_as(&dir, prof.path(), &wb, vec![0], "realmrace", (1, 0, 0), None);

    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "realmrace"), MaterializeMode::Subscribe);
    // The page installed v1 and reported it.
    crate::bi::cube::note_custom_function_registry_impl(
        &h.state,
        &h.scripts,
        vec!["MYFN".to_string()],
        Some(crate::bi::cube::custom_function_library_generation()),
    );

    wb.scripts = vec![library("return x*100;")];
    wb.sheets[0].cells.insert((0, 1), saved_formula("=MYFN(A1)", CellValue::Number(300.0)));
    publish_as(&dir, prof.path(), &wb, vec![0], "realmrace", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "realmrace"))]);

    let own = h.index_of("Sheet1");
    crate::sheets::activate_sheet(&h.state, own).expect("activate the subscriber's own sheet");
    let memo_of = |sheet: usize| h.state.grids.read().unwrap()[sheet].call_memo().clone();
    let call = |x: f64| engine::cube::udf_call_fingerprint("MYFN", &[engine::EvalResult::Number(x)]).unwrap();
    let edit = |answer: f64| {
        let served: std::collections::HashMap<String, crate::scripting::udf::UdfValue> = [(
            crate::scripting::udf::udf_key("MYFN", &[crate::scripting::udf::UdfValue::Number { value: 4.0 }]),
            crate::scripting::udf::UdfValue::Number { value: answer },
        )]
        .into_iter()
        .collect();
        crate::commands::data::update_cell_impl(
            &h.state,
            &crate::persistence::FileState::default(),
            &crate::persistence::UserFilesState::default(),
            &h.slicer,
            &h.pivot,
            &h.pane,
            &h.ribbon,
            0,
            0,
            "=MYFN(4)".to_string(),
            Some(served),
            None,
            None,
        )
        .expect("the edit writes");
    };

    // The page has not re-installed yet: its OLD realm serves MYFN(4) = 40.
    edit(40.0);
    assert_eq!(value_at(&h, own, 0, 0), CellValue::Number(40.0), "the edit shows what was served for it");
    assert_eq!(
        memo_of(own).answer(&call(4.0)),
        None,
        "the old realm's MYFN(4) = 40, served after the update replaced MYFN, was filed as current"
    );

    // The page re-installed the generation the refresh event carried.
    crate::bi::cube::note_custom_function_registry_impl(
        &h.state,
        &h.scripts,
        vec!["MYFN".to_string()],
        Some(crate::bi::cube::custom_function_library_generation()),
    );
    edit(400.0);
    assert_eq!(
        memo_of(own).answer(&call(4.0)),
        Some(engine::EvalResult::Number(400.0)),
        "once the new code is live its served answers are filed again"
    );
}

/// BUG-0613: an application update recalculates the subscriber's OWN sheets
/// that read a refreshed cell. `Sheet1!A1 = Data!A1*2` on the subscriber's own
/// sheet showed v1's 2 after an update to `Data!A1 = 7` -- only the refreshed
/// sheets were recalculated -- and the save's keep rule then had no change in
/// its pass to tell it otherwise. In Excel every reader of a changed cell
/// recalculates, on every sheet.
///
/// SABOTAGE: drop the `recalc_readers_of_installed_sheets` call in
/// `apply_refresh_payloads` -- Sheet1!A1 stays 2.
#[test]
fn an_update_recalculates_the_subscribers_own_readers_of_a_refreshed_cell() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut data = Sheet::new("Data".to_string());
    data.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(1.0)));
    let mut wb = Workbook::default();
    wb.sheets = vec![data];
    publish_as(&dir, prof.path(), &wb, vec![0], "readers", (1, 0, 0), None);

    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "readers"), MaterializeMode::Subscribe);
    let data_at = h.index_of("Data");
    let own = h.index_of("Sheet1");
    crate::sheets::activate_sheet(&h.state, own).expect("activate the subscriber's own sheet");
    crate::commands::data::update_cell_impl(
        &h.state,
        &crate::persistence::FileState::default(),
        &crate::persistence::UserFilesState::default(),
        &h.slicer,
        &h.pivot,
        &h.pane,
        &h.ribbon,
        0,
        0,
        "=Data!A1*2".to_string(),
        None,
        None,
        None,
    )
    .expect("the subscriber's own formula");
    assert_eq!(value_at(&h, own, 0, 0), engine::CellValue::Number(2.0), "precondition: v1");

    wb.sheets[0].cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(7.0)));
    publish_as(&dir, prof.path(), &wb, vec![0], "readers", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "readers"))]);

    assert_eq!(value_at(&h, data_at, 0, 0), engine::CellValue::Number(7.0), "precondition: v2 landed");
    assert_eq!(
        value_at(&h, own, 0, 0),
        engine::CellValue::Number(14.0),
        "the subscriber's own Sheet1!A1 = Data!A1*2 kept v1's value after the update"
    );
}

// ===========================================================================
// A package's NAMES are judged by the subscriber's own rule (round C)
// ===========================================================================

/// A one-column table on `sheet` (A1:A2, header "Amount").
fn saved_table_named(sheet: identity::SheetId, name: &str) -> persistence::SavedTable {
    persistence::SavedTable {
        id: new_entity(),
        name: name.to_string(),
        sheet_id: sheet,
        start_row: 0,
        start_col: 0,
        end_row: 1,
        end_col: 0,
        columns: vec![persistence::SavedTableColumn {
            id: new_entity(),
            name: "Amount".to_string(),
            totals_row_function: "none".to_string(),
            totals_row_formula: None,
            calculated_formula: None,
            totals_row_label: None,
        }],
        style_options: persistence::SavedTableStyleOptions {
            banded_rows: true,
            banded_columns: false,
            header_row: true,
            total_row: false,
            first_column: false,
            last_column: false,
            show_filter_button: true,
        },
        style_name: "TableStyleMedium2".to_string(),
    }
}

fn published_name(name: &str) -> calp::manifest::PublishedNamedRange {
    calp::manifest::PublishedNamedRange {
        name: name.to_string(),
        refers_to: "=Data!$A$1".to_string(),
        sheet_id: None,
        extra: std::collections::HashMap::new(),
    }
}

/// A SIGNED package carrying a name the subscriber's own UI refuses -- an
/// R1C1-shaped or cell-shaped defined name (`R1C1`, `Q1`), a table named `C`,
/// a table and a name sharing `Rate` -- used to land as it was: the Name
/// Manager could not have made it, and an `.xlsx` export of the workbook is a
/// file Excel refuses to open. Every door refuses the version whole, naming
/// the item, before anything is written (renaming it would break the
/// application's own formulas and hide that it shipped). The versions are
/// tampered after the signature check, as a build without the publish gate
/// would have signed them.
///
/// SABOTAGE: make `refuse_invalid_pulled_names` answer `Ok(())` at once --
/// fails at "LANDED 'R1C1'".
#[test]
fn a_pulled_name_the_subscribers_ui_would_refuse_refuses_the_whole_pull() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    publish_sheets(&dir, prof.path(), &data_and_report(), vec![0, 1]);
    let h = Harness::new();
    let sheets_before = h.state.sheet_names.read().unwrap().clone();

    type Tamper = fn(&mut calp::pull::PullResult);
    let cases: [(&str, &str, Tamper); 4] = [
        ("R1C1", "the defined name 'R1C1' is not a valid name", |p| p.named_ranges.push(published_name("R1C1"))),
        ("Q1", "the defined name 'Q1' is not a valid name", |p| p.named_ranges.push(published_name("Q1"))),
        ("C", "the table name 'C' is not a valid name", |p| {
            let sheet = p.sheets[0].package_sheet_id;
            p.tables.push(saved_table_named(sheet, "C"));
        }),
        ("rate", "the table 'rate' and the workbook-scoped defined name 'Rate' have the same name", |p| {
            let sheet = p.sheets[0].package_sheet_id;
            p.tables.push(saved_table_named(sheet, "rate"));
        }),
    ];
    for (item, sentence, tamper) in cases {
        let mut pull = subscribe_pull(&dir, prof.path());
        tamper(&mut pull);
        let result = materialize_pull_result(
            &h.state,
            &test_effect(),
            &h.pivot,
            &h.bi,
            &h.scripts,
            &h.ribbon,
            &h.pane,
            &h.slicer,
            &h.timeline,
            pull,
            MaterializeMode::Subscribe,
            None,
        );
        let err = match result {
            Ok(_) => panic!("LANDED '{item}': a package carrying it was materialized"),
            Err(e) => e,
        };
        assert!(err.starts_with("CALP_INVALID_NAME: The application 'literals'"), "a structured refusal: {err}");
        assert!(err.contains(sentence), "it names the item ({item}): {err}");
        assert_eq!(*h.state.sheet_names.read().unwrap(), sheets_before, "{item}: nothing was installed");
        assert!(h.state.named_ranges.read().unwrap().is_empty(), "{item}: no name landed");
        assert!(h.state.subscriptions.read().unwrap().subscriptions.is_empty(), "{item}: no subscription");
    }

    // The control: the same version, untampered, lands -- with its name.
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);
    assert!(h.state.named_ranges.read().unwrap().contains_key("RATE"));

    // A REFRESH carrying one is refused by its pre-effect pass, too.
    let mut v2 = subscribe_pull(&dir, prof.path());
    v2.named_ranges.push(published_name("RC1"));
    let mut payloads = vec![calp::refresh::RefreshPayload { subscription_index: 0, pull_result: v2 }];
    let err = crate::calp_commands::prepare_refresh_payloads(&h.state, &mut payloads)
        .expect_err("a refresh bringing 'RC1' is refused");
    assert!(err.contains("CALP_INVALID_NAME") && err.contains("'RC1'"), "{err}");

    // Every door asks before its effect.
    for door in ["pub fn calp_pull(", "pub fn calp_checkout(", "pub(crate) fn materialize_pull_result("] {
        let code = crate_fn_code("src/calp_commands.rs", door);
        let at = code
            .find("refuse_invalid_pulled_names(")
            .unwrap_or_else(|| panic!("{door} no longer refuses invalid names"));
        if let Some(effect) = code.find("DocumentEffect::mutates(") {
            assert!(at < effect, "{door} asks after its effect: a refusal would dirty the workbook");
        }
    }
    let prepare = crate_fn_code("src/calp_commands.rs", "pub(crate) fn prepare_refresh_payloads(");
    assert!(prepare.contains("refuse_invalid_pulled_names("), "the refresh's pre-effect pass asks");
}

/// THE PUBLISH DOOR refuses the same names, so such a version is never signed:
/// a defined name Excel reads as a reference, and a table sharing a defined
/// name.
///
/// SABOTAGE: delete the `published_name_problem` refusal from
/// `calp::publish::publish` -- fails at "SIGNED".
#[test]
fn a_name_the_ui_would_refuse_is_never_published() {
    let mut bad_name = data_and_report();
    bad_name.named_ranges[0].name = "R1C1".to_string();
    let mut shared = data_and_report();
    let data = shared.sheets[0].id;
    shared.tables = vec![saved_table_named(data, "RATE")];
    for (what, wb, item) in [("an R1C1 name", bad_name, "'R1C1'"), ("a table named like a name", shared, "'RATE'")] {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
        let request = PublishRequest {
            workbook: &wb,
            package_name: "literals".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            mode: PushMode::CreateNew,
            change_summary: "first".to_string(),
            sheet_indices: vec![0, 1],
            now: "2026-11-05T00:00:00Z".to_string(),
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
            identity_policy: None,
            min_app_version: String::new(),
        };
        let err = match publish::publish(&reg, &request, prof.path()) {
            Ok(_) => panic!("SIGNED: {what} was published"),
            Err(e) => e.to_string(),
        };
        assert!(err.starts_with("Cannot publish:") && err.contains(item), "{what}: {err}");
    }
}

/// The subscriber's OWN names and tables keep their namespace: a pulled table
/// named like a defined name the subscriber has is not added, nor a pulled
/// name like a table the subscriber has -- the additive rule a same-kind
/// collision already follows (the subscriber's own item wins). Before, both
/// landed, making a pair no door of the workbook allows.
///
/// SABOTAGE: drop the `defined_name_keys` skip in `materialize_pulled_tables`
/// -- fails at "TABLE SHADOWS"; drop the `table_names` skip of the subscribe's
/// name materialization -- fails at "NAME SHADOWS".
#[test]
fn a_pulled_table_or_name_never_shares_a_name_with_the_subscribers_own() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut wb = data_and_report();
    let data = wb.sheets[0].id;
    wb.tables = vec![saved_table_named(data, "Sales")];
    publish_sheets(&dir, prof.path(), &wb, vec![0, 1]);

    let h = Harness::new();
    let effect = test_effect();
    h.state.named_ranges.write(&effect).unwrap().insert(
        "SALES".to_string(),
        crate::named_ranges::NamedRange {
            name: "Sales".to_string(),
            sheet_index: None,
            refers_to: "=Sheet1!$B$1".to_string(),
            comment: None,
            folder: None,
        },
    );
    let own_table = new_entity();
    h.state.table_names.write(&effect).unwrap().insert("RATE".to_string(), (0, own_table));
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);

    assert!(
        !h.state.table_names.read().unwrap().contains_key("SALES"),
        "TABLE SHADOWS: the pulled table 'Sales' landed beside the subscriber's defined name 'Sales'"
    );
    assert_eq!(h.state.named_ranges.read().unwrap()["SALES"].refers_to, "=Sheet1!$B$1", "the subscriber's name is kept");
    assert!(
        !h.state.named_ranges.read().unwrap().contains_key("RATE"),
        "NAME SHADOWS: the pulled name 'Rate' landed beside the subscriber's table 'Rate'"
    );
    assert_eq!(h.state.table_names.read().unwrap()["RATE"].1, own_table, "the subscriber's table is kept");
}

/// A REFRESH upserts the publisher's latest names -- but never one a table of
/// this workbook already holds: v2 of the application adds the name `Rate`
/// while the subscriber has a table `Rate` of its own. Before, the upsert put
/// a name and a table under one name.
///
/// SABOTAGE: drop the `table_names` skip of the refresh's name upsert in
/// `apply_refresh_payloads` -- fails at "REFRESH SHADOWS".
#[test]
fn a_refreshed_name_never_shares_a_name_with_the_subscribers_table() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut v1 = data_and_report();
    v1.named_ranges.clear();
    publish_as(&dir, prof.path(), &v1, vec![0, 1], "literals", (1, 0, 0), None);

    let h = Harness::new();
    let own_table = new_entity();
    h.state.table_names.write(&test_effect()).unwrap().insert("RATE".to_string(), (0, own_table));
    h.materialize(pull_latest(&dir, prof.path(), "literals"), MaterializeMode::Subscribe);
    assert!(h.state.named_ranges.read().unwrap().is_empty(), "precondition: v1 carries no name");

    publish_as(&dir, prof.path(), &data_and_report(), vec![0, 1], "literals", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "literals"))]);
    assert!(
        !h.state.named_ranges.read().unwrap().contains_key("RATE"),
        "REFRESH SHADOWS: the refreshed name 'Rate' landed beside the subscriber's table 'Rate'"
    );
    assert_eq!(h.state.table_names.read().unwrap()["RATE"].1, own_table, "the subscriber's table is kept");
}

/// BUG-0741, THE RENAME-AND-REUSE EDGE: v2 of the application renames its own
/// table `Sales` to `SalesTbl` and reuses `Sales` for a defined name, and drops
/// its own name `Rate` for a table `Rate`. Both of the application's new
/// objects land: what the application itself owned (its ledger) never blocks
/// its own next version. Before, the names were upserted while v1's table
/// `Sales` still held the namespace (refused as "this workbook's table"), and
/// v1's leftover name `Rate` made the materializer refuse the table `Rate`.
///
/// SABOTAGE (names-reuse): the `own_tables` exemption is dropped from the
/// refresh's name upsert -- fails at "REUSED NAME".
#[test]
fn a_refresh_that_renames_its_own_table_and_reuses_the_spelling_lands_both() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut v1 = data_and_report(); // carries the workbook name `Rate`
    let (data, report) = (v1.sheets[0].id, v1.sheets[1].id);
    v1.tables = vec![saved_table_named(data, "Sales")];
    publish_as(&dir, prof.path(), &v1, vec![0, 1], "reuse", (1, 0, 0), None);

    let h = Harness::new();
    h.materialize(pull_latest(&dir, prof.path(), "reuse"), MaterializeMode::Subscribe);
    assert!(h.state.table_names.read().unwrap().contains_key("SALES"), "precondition: v1's table landed");
    assert!(h.state.named_ranges.read().unwrap().contains_key("RATE"), "precondition: v1's name landed");

    let mut v2 = v1.clone();
    v2.tables = vec![saved_table_named(data, "SalesTbl"), saved_table_named(report, "Rate")];
    v2.named_ranges = vec![persistence::SavedNamedRange {
        name: "Sales".to_string(),
        refers_to: "=Data!$A$1".to_string(),
        sheet_id: None,
        comment: None,
        folder: None,
    }];
    publish_as(&dir, prof.path(), &v2, vec![0, 1], "reuse", (1, 1, 0), Some((1, 0, 0)));
    h.refresh(vec![(0, pull_latest(&dir, prof.path(), "reuse"))]);

    let names = h.state.named_ranges.read().unwrap().clone();
    let tables = h.state.table_names.read().unwrap().clone();
    assert_eq!(names.get("SALES").map(|n| n.refers_to.as_str()), Some("=Data!$A$1"), "REUSED NAME: v2's name Sales");
    assert!(tables.contains_key("SALESTBL"), "v2's renamed table");
    assert!(!tables.contains_key("SALES"), "v1's table is gone");
    assert!(tables.contains_key("RATE"), "REUSED TABLE: v2's table Rate");
    assert!(!names.contains_key("RATE"), "v1's dropped name Rate is gone");
}

/// BUG-0741: the pull door's own table gate. A pulled table whose name Excel
/// would not take is not landed (`R1C1`, `?x`); one Excel takes is, a
/// two-character backslash name included (`\a`, which a TABLE may have
/// [LIVE q4.ps1]); and a SHEET-scoped name of the subscriber's does not block
/// a table of its spelling (Excel lets the two share one), while a workbook
/// name does.
///
/// SABOTAGE (names-pull): the `is_valid_table_name` gate in
/// `materialize_pulled_tables` is removed -- fails at "INVALID TABLE NAME".
#[test]
fn the_pull_door_lands_only_table_names_excel_takes() {
    let h = Harness::new();
    let effect = test_effect();
    let sheet = h.state.sheet_ids.read().unwrap()[0];
    for (name, scope) in [("Loc", Some(0usize)), ("Glob", None)] {
        let nr = crate::named_ranges::NamedRange {
            name: name.to_string(),
            sheet_index: scope,
            refers_to: "=1".to_string(),
            comment: None,
            folder: None,
        };
        h.state.named_ranges.write(&effect).unwrap().insert(nr.registry_key(), nr);
    }
    let tables: Vec<persistence::SavedTable> =
        ["R1C1", "?x", "\\a", "Good", "Loc", "Glob"].iter().map(|n| saved_table_named(sheet, n)).collect();
    let map: std::collections::HashMap<identity::SheetId, usize> = [(sheet, 0usize)].into_iter().collect();
    let landed = crate::calp_commands::materialize_pulled_tables(&effect, &h.state, &tables, &map, None).unwrap();
    let names = h.state.table_names.read().unwrap().clone();
    assert!(!names.contains_key("R1C1"), "INVALID TABLE NAME: a table named R1C1 landed");
    assert!(!names.contains_key("?X"), "INVALID TABLE NAME: a table named ?x landed");
    assert!(names.contains_key("\\A"), "Excel takes \\a as a table name");
    assert!(names.contains_key("GOOD"));
    assert!(names.contains_key("LOC"), "a sheet-scoped name does not block a table of its spelling");
    assert!(!names.contains_key("GLOB"), "a workbook name does");
    assert_eq!(landed, 3);
}

/// Ledger programme 2 wave 5 (misc5, obj4-verify-7): the two cases the
/// lay-in's spill rule still refused or broke. (1) A version whose array only
/// SHRANK (B1 `=SEQUENCE(5)` -> `=SEQUENCE(3)`): its diff names B4:B5 as
/// emptied, the lay-in cleared them -- but here they are this copy's own
/// spilled values, so BUG-0775's spilled-cell gate refused the whole merge.
/// They are derived on both sides now and left to the recalculation. (2) A
/// version whose array GREW over a cell where this copy still holds a literal
/// (E3 "x", E1 `=SEQUENCE(2)` -> `=SEQUENCE(3)`): the spilled position was
/// skipped, the literal stayed, and the merged array showed #SPILL!. It is
/// laid EMPTY now, so the array spills. Then the laid cells go through the
/// real batch -- the gate passes and both arrays spill as the version has them.
///
/// SABOTAGE (misc5-shr): drop the "nothing in the version, one of this copy's
/// own spilled values" skip in `published_cells_in_local_names` -- fails at
/// "SHRUNK ARRAY". SABOTAGE (misc5-lit): skip a version's spilled position
/// instead of laying it empty -- fails at "LITERAL BLOCKS THE GROWN ARRAY".
#[test]
fn a_lay_in_settles_a_shrunk_array_and_a_literal_in_a_grown_one() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    // The version: B1 = SEQUENCE(3) spilling B1:B3, E1 = SEQUENCE(3) spilling
    // E1:E3 (their spilled values value-only cells, as the writer saves them).
    let mut data = Sheet::new("Data".to_string());
    for col in [1u32, 4] {
        let mut origin = SavedCell::from_cell(&Cell::new_formula("SEQUENCE(3)".to_string()));
        origin.spill = Some((2, col));
        data.cells.insert((0, col), origin);
        for r in 1..3u32 {
            data.cells.insert((r, col), SavedCell::from_cell(&Cell::new_number(f64::from(r + 1))));
        }
    }
    let mut wb = Workbook::default();
    wb.sheets = vec![data];
    let data_id = wb.sheets[0].id.to_string();
    publish_sheets(&dir, prof.path(), &wb, vec![0]);

    // This copy: B1 = SEQUENCE(5) (B1:B5), E1 = SEQUENCE(2) (E1:E2), E3 = "x".
    let state = crate::create_app_state();
    *state.locale.lock().unwrap() = engine::LocaleSettings::invariant();
    let file = crate::persistence::FileState::default();
    let files = crate::persistence::UserFilesState::default();
    let pivots = crate::pivot::types::PivotState::new();
    let typed = |row: u32, col: u32, value: &str| crate::api_types::CellUpdateInput {
        row,
        col,
        value: value.to_string(),
        style_index: None,
        invariant: Some(true),
        pasted: None,
        moved: None,
        source: None,
    };
    let write = |updates: Vec<crate::api_types::CellUpdateInput>| {
        crate::commands::data::update_cells_batch_core(&state, &file, &files, &pivots, updates, None, None, None, None)
            .map(|_| ())
    };
    write(vec![typed(0, 1, "=SEQUENCE(5)"), typed(0, 4, "=SEQUENCE(2)"), typed(2, 4, "x")]).expect("this copy");
    let local = crate::calp_commands::local_spill_outputs(&state, 0).expect("spill map");
    let mut spilled: Vec<(u32, u32)> = local.iter().copied().collect();
    spilled.sort_unstable();
    assert_eq!(spilled, vec![(1, 1), (1, 4), (2, 1), (3, 1), (4, 1)], "precondition: this copy's spilled cells");
    assert!(
        crate::commands::data::check_spill_protection_cells(&state, 0, &[(3, 1)]).is_err(),
        "precondition: clearing B4 here is a write into a spilled value"
    );

    // What the merge's diff names: both origins, B4:B5 emptied, E2:E3 spilled.
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let manifest = reg.get_version_manifest("literals", "1.0.0").unwrap();
    let positions = [(0, 1), (3, 1), (4, 1), (0, 4), (1, 4), (2, 4)];
    let laid = crate::calp_commands::published_cells_in_local_names(
        &reg,
        "literals",
        "1.0.0",
        &manifest,
        &data_id,
        &positions,
        &calp::sheet_renames::SheetRenames::default(),
        Some(&local),
    )
    .expect("read")
    .expect("the version has the sheet");
    let at: Vec<(u32, u32)> = laid.iter().map(|(p, _)| *p).collect();
    assert!(
        !at.contains(&(3, 1)) && !at.contains(&(4, 1)),
        "SHRUNK ARRAY: B4:B5 are this copy's spilled values and must be left to the recalculation, got {at:?}"
    );
    assert!(!at.contains(&(1, 4)), "E2 is spilled on both sides");
    assert!(
        laid.iter().any(|(p, c)| *p == (2, 4) && c.is_none()),
        "LITERAL BLOCKS THE GROWN ARRAY: E3 must be laid empty, got {at:?}"
    );
    let cells: Vec<(u32, u32)> = laid.iter().map(|(p, _)| *p).collect();
    crate::commands::data::check_spill_protection_cells(&state, 0, &cells).expect("the gate passes what is laid");

    // Laid through the real batch: both arrays spill as the version has them.
    let updates: Vec<crate::api_types::CellUpdateInput> = laid
        .iter()
        .map(|((r, c), cell)| typed(*r, *c, &cell.as_ref().and_then(|s| s.formula.clone()).map(|f| format!("={f}")).unwrap_or_default()))
        .collect();
    write(updates).expect("the merged cells install");
    let grid = state.grids.read().unwrap()[0].clone();
    let value = |r: u32, c: u32| grid.get_cell(r, c).map(|cell| cell.value.clone()).unwrap_or(engine::CellValue::Empty);
    assert_eq!(value(2, 1), engine::CellValue::Number(3.0));
    assert_eq!(value(3, 1), engine::CellValue::Empty, "B4 released by the shrunk array");
    assert_eq!(value(2, 4), engine::CellValue::Number(3.0), "E3 is the grown array's, not #SPILL!");
    assert_eq!(value(0, 4), engine::CellValue::Number(1.0), "E1 spills");
}
