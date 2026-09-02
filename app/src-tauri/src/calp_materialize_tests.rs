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
            version_pin: VersionPin::Latest,
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
        }
    }

    fn materialize(&self, result: calp::pull::PullResult, mode: MaterializeMode) {
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
            result,
            mode,
            // No frontend to notify in a test — the point of the parameter
            // being optional.
            None,
        )
        .expect("materialization failed");
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
            pulled,
            MaterializeMode::Subscribe,
            None,
        )
        .expect("materialization failed")
    };

    // Workbook is now [Sheet1, __float1(hidden), pulled] — true index 2, but
    // the visible LIST holds only two entries, so `length - sheetsPulled` would
    // say 1: the backing sheet.
    let reported = response
        .first_pulled_sheet_index
        .expect("a package with a user sheet reports one to activate");
    assert_eq!(
        reported, 2,
        "the TRUE state-vector index, not a position in the filtered list"
    );

    let visibility = h.state.sheet_visibility.read().unwrap();
    assert!(
        crate::sheets::is_user_sheet(&visibility, reported),
        "and it must be a sheet the user can actually see"
    );

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
