//! FILENAME: app/src-tauri/src/commands/canvas_sheet_tests.rs
//! PURPOSE: CANVAS SHEETS (M1) -- the per-sheet kind authority and the doors
//!          that keep a canvas cell-free.
//!
//! A canvas is an ordinary USER sheet whose `sheet_kinds` slot is
//! `SheetKind::Canvas(layout)`. It keeps a real, permanently empty engine grid
//! (so every index-keyed store, the active-mirror swap and `=Canvas1!A1` keep
//! working) and refuses every user-facing cell writer through ONE predicate,
//! `sheets::ensure_not_canvas`. What is pinned here:
//!
//!   1. The kind rides the sheet list and stays aligned with every other
//!      per-sheet vector through add (incl. the partition rotation), delete
//!      and hide/unhide.
//!   2. Each write door refuses a canvas AND leaves its grid empty -- a refusal
//!      that still wrote would pass an `is_err()` assertion alone.
//!   3. Object-scope actions stay legal on a canvas; cell-scope ones do not.
//!   4. The layout command applies, validates and refuses cleanly.
//!   5. A source-level wiring census over the doors no helper fronts, with the
//!      ORDER that matters: the gate must run before the early return that
//!      would otherwise skip it, and before the effect that would dirty the
//!      document on a refusal.
//!
//! Reuses the `cross_sheet_recalc_tests::Workbook` harness.

use super::cross_sheet_recalc_tests::Workbook;
use crate::sheets::{is_canvas_sheet, SheetsResult};
use persistence::{CanvasLayout, SheetKind};

fn add_canvas(wb: &Workbook) -> SheetsResult {
    crate::sheets::add_sheet_inner(&wb.state, &wb.file, None, SheetKind::new_canvas())
        .expect("add a canvas sheet")
}

fn add_worksheet(wb: &Workbook) -> SheetsResult {
    crate::sheets::add_sheet_inner(&wb.state, &wb.file, None, SheetKind::Worksheet)
        .expect("add a worksheet")
}

fn kinds(wb: &Workbook) -> Vec<SheetKind> {
    wb.state.sheet_kinds.read().unwrap().clone()
}

/// The canvas's grid, read through the authority for its index (the active
/// mirror when it is active).
fn cell_count(wb: &Workbook, index: usize) -> usize {
    let active = *wb.state.active_sheet.read().unwrap();
    if index == active {
        wb.state.grid.read().unwrap().cells.len()
    } else {
        wb.state.grids.read().unwrap()[index].cells.len()
    }
}

fn assert_refused_as_canvas(result: Result<impl std::fmt::Debug, String>, door: &str) {
    match result {
        Ok(v) => panic!("{door}: a canvas must refuse the write, got Ok({v:?})"),
        Err(e) => assert!(
            e.contains("canvas"),
            "{door}: the refusal must name the canvas so the log can act on it, got: {e}"
        ),
    }
}

// ---------------------------------------------------------------------------
// 1. The kind authority
// ---------------------------------------------------------------------------

#[test]
fn a_canvas_is_listed_as_a_canvas_with_no_headings_and_no_gridlines() {
    let wb = Workbook::new(1);
    let result = add_canvas(&wb);
    let idx = result.active_index;
    let info = result.sheets.iter().find(|s| s.index == idx).expect("the new sheet is listed");
    assert_eq!(info.kind, "canvas");
    assert_eq!(info.canvas_layout, Some(CanvasLayout::default()));

    assert!(is_canvas_sheet(&kinds(&wb), idx));
    assert_eq!(
        wb.state.show_gridlines.read().unwrap()[idx],
        false,
        "a canvas is created with gridlines off"
    );
    assert!(
        !wb.state.sheet_display_flags.read().unwrap()[idx].display_headings,
        "a canvas is created with headings off"
    );

    // A worksheet added next is unaffected by the canvas before it.
    let result = add_worksheet(&wb);
    let ws = result.active_index;
    let info = result.sheets.iter().find(|s| s.index == ws).unwrap();
    assert_eq!(info.kind, "worksheet");
    assert_eq!(info.canvas_layout, None);
    assert!(wb.state.show_gridlines.read().unwrap()[ws]);
    assert!(wb.state.sheet_display_flags.read().unwrap()[ws].display_headings);
    assert!(!is_canvas_sheet(&kinds(&wb), ws));
    assert_eq!(kinds(&wb).len(), wb.state.sheet_names.read().unwrap().len());
}

/// The partition rotation: a canvas added while a floating range's backing
/// sheet sits at the tail lands IN FRONT of it, and the kind vector rotates
/// with every other vector -- otherwise the backing sheet would read as the
/// canvas and the canvas as a worksheet.
#[test]
fn a_canvas_added_after_a_floating_range_lands_in_the_user_prefix_with_its_kind() {
    let wb = Workbook::new(1);
    crate::floating_range::create_floating_range_inner(&wb.state, &wb.file, None, 100.0, 50.0)
        .expect("create a floating range");
    let backing_before = wb.state.sheet_names.read().unwrap().len() - 1;
    assert_eq!(backing_before, 1, "precondition: the backing sheet is at the tail");

    let result = add_canvas(&wb);
    let canvas = result.active_index;
    assert_eq!(canvas, 1, "the canvas is rotated in front of the object tail");
    let k = kinds(&wb);
    assert_eq!(k.len(), 3);
    assert!(k[1].is_canvas(), "the canvas slot moved with the canvas");
    assert!(k[2].is_worksheet(), "the backing sheet (now at 2) is a plain grid");
    let vis = wb.state.sheet_visibility.read().unwrap();
    assert_eq!(vis[2], crate::sheets::OBJECT_SHEET_VISIBILITY);
}

#[test]
fn a_canvas_can_be_hidden_and_unhidden_and_stays_a_canvas() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    crate::sheets::hide_sheet_inner(&wb.state, &wb.file, canvas, None).expect("hide the canvas");
    assert_eq!(wb.state.sheet_visibility.read().unwrap()[canvas], "hidden");
    assert!(is_canvas_sheet(&kinds(&wb), canvas), "hiding must not touch the kind");
    crate::sheets::unhide_sheet_inner(&wb.state, &wb.file, canvas).expect("unhide the canvas");
    assert_eq!(wb.state.sheet_visibility.read().unwrap()[canvas], "visible");
    assert!(is_canvas_sheet(&kinds(&wb), canvas));
}

/// Deleting a sheet BEFORE a canvas shifts the canvas down one index; the kind
/// (and the page setups, which delete once forgot) must shift with it.
#[test]
fn deleting_a_sheet_before_a_canvas_keeps_the_kind_and_page_setups_aligned() {
    let wb = Workbook::new(2);
    let canvas = add_canvas(&wb).active_index;
    assert_eq!(canvas, 2);
    {
        // Give each sheet a distinguishable page setup.
        let seed = crate::document_effect::test_seed_effect();
        let mut ps = wb.state.page_setups.write(&seed).unwrap();
        while ps.len() < 3 {
            ps.push(crate::api_types::PageSetup::default());
        }
        for (i, p) in ps.iter_mut().enumerate() {
            p.orientation = format!("marker-{i}");
        }
    }
    crate::sheets::delete_sheet_impl(
        &wb.state,
        &wb.file,
        &wb.pivots,
        &wb.files,
        &wb.pane,
        &wb.filters,
        &wb.slicer,
        &wb.timeline,
        0,
        false,
    )
    .expect("delete the first sheet");

    let k = kinds(&wb);
    assert_eq!(k.len(), 2, "one kind removed with its sheet");
    assert!(k[0].is_worksheet());
    assert!(k[1].is_canvas(), "the canvas moved to index 1 and kept its kind");
    let ps = wb.state.page_setups.read().unwrap();
    assert_eq!(ps.len(), 2, "one page setup removed with its sheet");
    assert_eq!(ps[1].orientation, "marker-2", "the canvas kept ITS page setup, not a neighbour's");
}

// ---------------------------------------------------------------------------
// 2. The write doors: refused AND nothing written
// ---------------------------------------------------------------------------

#[test]
fn typing_into_the_active_canvas_is_refused_and_writes_nothing() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    let result = super::update_cell_impl(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.slicer,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        0,
        0,
        "42".to_string(),
        None,
        None,
        None,
    );
    assert_refused_as_canvas(result, "update_cell");
    assert_eq!(cell_count(&wb, canvas), 0, "the refusal must not have written the cell");
}

#[test]
fn an_off_sheet_write_aimed_at_a_canvas_is_refused_and_writes_nothing() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    wb.switch_to(0);
    let result = super::update_cell_on_sheets_inner(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        vec![canvas],
        3,
        3,
        "=1+1".to_string(),
        None,
        None,
    );
    assert_refused_as_canvas(result, "update_cell_on_sheets");
    assert_eq!(cell_count(&wb, canvas), 0);
}

/// Replace on a canvas: seed a matching value straight into the hidden grid
/// (the only way one can get there) and prove Replace refuses to touch it.
#[test]
fn replace_all_aimed_at_a_canvas_is_refused_and_leaves_its_grid_as_it_was() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    wb.switch_to(0);
    {
        let seed = crate::document_effect::test_seed_effect();
        let mut grids = wb.state.grids.write(&seed).unwrap();
        grids[canvas].set_cell(0, 0, engine::Cell::new_text("needle".to_string()));
    }
    let result = crate::commands::search::replace_all_off_sheet(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        canvas,
        "needle".to_string(),
        "thread".to_string(),
        false,
        false,
    );
    assert_refused_as_canvas(result.map(|r| r.replacement_count), "replace_all_off_sheet");
    let grids = wb.state.grids.read().unwrap();
    let cell = grids[canvas].get_cell(0, 0).expect("the seeded cell is still there");
    assert_eq!(cell.value, engine::CellValue::Text("needle".to_string()));
}

/// A script (or an MCP write_cell, which runs through the same apply path)
/// that writes into a background canvas is refused before ANY sheet is
/// touched.
#[test]
fn a_script_write_into_a_background_canvas_is_refused_before_anything_is_installed() {
    // Sheet1 active, Sheet2 a BACKGROUND worksheet, the canvas at 2. The
    // background worksheet's write goes through the real PLAN/APPLY install
    // path (the active sheet's goes through the stubbed closure instead), and
    // the plan visits sheets in index order: sheet 1 before the canvas. So a
    // gate moved after the installs would leave sheet 1 written -- which is
    // what the atomicity assertion below catches.
    let wb = Workbook::new(2);
    let canvas = add_canvas(&wb).active_index;
    assert_eq!(canvas, 2);
    wb.switch_to(0);
    let mut modified: Vec<engine::Grid> = wb.state.grids.read().unwrap().clone();
    modified[0] = wb.state.grid.read().unwrap().clone();
    modified[1].set_cell(0, 0, engine::Cell::new_number(7.0));
    modified[canvas].set_cell(5, 5, engine::Cell::new_number(9.0));
    let active_called = std::cell::Cell::new(false);
    let active = |_updates: Vec<crate::api_types::CellUpdateInput>,
                  _cv: std::sync::Arc<crate::control_values::ControlValuesMap>|
     -> Result<(), String> {
        active_called.set(true);
        Ok(())
    };
    let result = crate::scripting::commands::apply_script_modified_grids_core(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        &modified,
        0,
        2,
        "script",
        "canvas-test",
        &active,
    );
    assert_refused_as_canvas(result, "apply_script_modified_grids");
    assert_eq!(cell_count(&wb, canvas), 0, "nothing was installed into the canvas");
    assert_eq!(
        cell_count(&wb, 1),
        0,
        "the refusal is atomic: the background worksheet write did not land either"
    );
    assert!(!active_called.get(), "the active sheet's apply never ran");
}

#[test]
fn freezing_panes_on_a_canvas_is_refused_and_leaves_the_document_clean() {
    let wb = Workbook::new(1);
    add_canvas(&wb);
    crate::document_effect::mark_saved(&wb.file);
    let result = crate::sheets::set_freeze_panes_impl(&wb.state, &wb.file, Some(1), None);
    assert_refused_as_canvas(result.map(|_| ()), "set_freeze_panes");
    assert!(!wb.file.is_dirty(), "a refusal must not dirty the document");
}

// ---------------------------------------------------------------------------
// 3. Object scope stays legal; cell scope does not
// ---------------------------------------------------------------------------

#[test]
fn cell_scope_actions_are_refused_on_a_canvas_and_object_scope_actions_are_not() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    for action in ["formatCells", "formatRows", "formatColumns", "insertRows", "deleteColumns", "sort", "editScenarios"] {
        assert_refused_as_canvas(
            crate::protection::check_sheet_action(&wb.state, canvas, action, "do that"),
            action,
        );
        assert!(
            crate::protection::check_sheet_action(&wb.state, 0, action, "do that").is_ok(),
            "{action} stays legal on a worksheet"
        );
    }
    for action in crate::protection::CANVAS_OBJECT_SCOPE_ACTIONS {
        assert!(
            crate::protection::check_sheet_action(&wb.state, canvas, action, "do that").is_ok(),
            "{action} is object scope and must stay legal on a canvas"
        );
    }
}

/// The pure `_in` gates run their canvas check BEFORE the unprotected early
/// return: an UNPROTECTED canvas (the normal case) must still refuse.
#[test]
fn the_pure_protection_gates_refuse_an_unprotected_canvas() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    let k = kinds(&wb);
    let storage = crate::protection::ProtectionStorage::default();
    let grid = engine::Grid::new();
    let styles = engine::StyleRegistry::new();
    assert_refused_as_canvas(
        crate::protection::check_sheet_protection_cells_in(
            &k, &storage, &grid, &styles, canvas, std::iter::once((0, 0)),
        ),
        "check_sheet_protection_cells_in",
    );
    assert_refused_as_canvas(
        crate::protection::check_sheet_protection_range_in(&k, &storage, &grid, &styles, canvas, 0, 0, 3, 3),
        "check_sheet_protection_range_in",
    );
    assert!(crate::protection::check_sheet_protection_cells_in(
        &k, &storage, &grid, &styles, 0, std::iter::once((0, 0)),
    )
    .is_ok());
    // And the locking wrappers, which probe protection first.
    assert_refused_as_canvas(
        crate::protection::check_sheet_protection_cells(&wb.state, canvas, std::iter::once((0, 0))),
        "check_sheet_protection_cells",
    );
    assert_refused_as_canvas(
        crate::protection::check_sheet_protection_range(&wb.state, canvas, 0, 0, 0, 0),
        "check_sheet_protection_range",
    );
}

/// A one-row, one-cell pivot view: enough output that a write that happened is
/// visible, so an "it wrote nothing" assertion cannot pass on an empty view.
fn one_cell_view(pivot_id: pivot_engine::PivotId) -> pivot_engine::PivotView {
    let mut view = pivot_engine::PivotView::new(pivot_id);
    view.add_row(
        vec![pivot_engine::PivotViewCell::data(42.0)],
        pivot_engine::PivotRowDescriptor {
            view_row: 0,
            row_type: pivot_engine::PivotRowType::Data,
            depth: 0,
            visible: true,
            parent_index: None,
            children_indices: Vec::new(),
            group_values: Vec::new(),
        },
    );
    view
}

fn new_pivot_id() -> pivot_engine::PivotId {
    identity::EntityId::from_bytes(identity::generate_uuid_v7())
}

fn cell_value(wb: &Workbook, index: usize, row: u32, col: u32) -> Option<engine::CellValue> {
    let active = *wb.state.active_sheet.read().unwrap();
    if index == active {
        wb.state.grid.read().unwrap().get_cell(row, col).map(|c| c.value.clone())
    } else {
        wb.state.grids.read().unwrap()[index].get_cell(row, col).map(|c| c.value.clone())
    }
}

/// THE REVIEW'S SCENARIO (backend-locks-effects #1): a pivot whose destination
/// NAME no longer resolves, while a canvas is the active sheet. The resolver
/// used to redirect it to the FIRST WORKSHEET -- where the pivot's source data
/// typically lives -- and the refresh wrote its output straight over that data.
/// There is no redirect any more: a stale name resolves to where the pivot's
/// cells ARE (its registered region), else the active sheet as before canvases,
/// and a canvas answer is refused where the write happens.
#[test]
fn a_stale_pivot_destination_never_redirects_onto_another_worksheet() {
    let wb = Workbook::new(2);
    // Sheet1 holds the SOURCE data the old redirect wrote over.
    wb.set(3, 3, "7");
    let canvas = add_canvas(&wb).active_index;
    assert_eq!(*wb.state.active_sheet.read().unwrap(), canvas);

    let pivot_id = new_pivot_id();
    let mut def = pivot_engine::PivotDefinition::new(pivot_id, (0, 0), (0, 0));
    def.destination_sheet = Some("A sheet that was renamed away".to_string());

    // No region registered: the active sheet, exactly as before canvases. NOT
    // the first worksheet.
    let resolved = crate::pivot::operations::resolve_dest_sheet_index(&wb.state, &def);
    assert_ne!(resolved, 0, "a stale name must never be redirected onto the first worksheet");
    assert_eq!(resolved, canvas, "no region: the active sheet, as before canvases existed");

    // ...and the write aimed there refuses, naming the canvas, and writes
    // nothing anywhere: not into the canvas, not over Sheet1's source data.
    let effect = crate::document_effect::test_seed_effect();
    let refused = crate::pivot::operations::update_pivot_in_grid(
        &wb.state, &effect, pivot_id, resolved, (3, 3), &one_cell_view(pivot_id), false,
    );
    assert_refused_as_canvas(refused, "update_pivot_in_grid");
    assert_eq!(cell_count(&wb, canvas), 0, "the canvas grid stays empty");
    assert_eq!(
        cell_value(&wb, 0, 3, 3),
        Some(engine::CellValue::Number(7.0)),
        "Sheet1's source data is untouched"
    );

    // With a registered region the stale name resolves to the sheet the pivot's
    // cells are actually on -- here Sheet2, which the old redirect would never
    // have answered.
    crate::pivot::operations::update_pivot_region(&wb.state, pivot_id, 1, (0, 0), &one_cell_view(pivot_id));
    assert_eq!(crate::pivot::operations::resolve_dest_sheet_index(&wb.state, &def), 1);

    // A name that resolves is honoured, exactly and ignoring case (sheet names
    // are unique ignoring ASCII case, so a drifted spelling still means its tab).
    def.destination_sheet = Some("Sheet1".to_string());
    assert_eq!(crate::pivot::operations::resolve_dest_sheet_index(&wb.state, &def), 0);
    def.destination_sheet = Some("sheet1".to_string());
    assert_eq!(crate::pivot::operations::resolve_dest_sheet_index(&wb.state, &def), 0);
}

/// THE CAUSE of the stale names: a sheet rename never carried the pivot
/// definitions with it. Every `destination_sheet` and `source_sheet` equal to
/// the old name (ignoring case) now follows the rename, the cancel-revert
/// snapshots included, and nothing naming another sheet is touched.
#[test]
fn renaming_a_sheet_carries_every_pivot_definition_with_it() {
    let wb = Workbook::new(2);
    let seed = crate::document_effect::test_seed_effect();
    let (report, drifted, elsewhere) = (new_pivot_id(), new_pivot_id(), new_pivot_id());
    let def = |id, dest: &str, src: &str| {
        let mut d = pivot_engine::PivotDefinition::new(id, (0, 0), (3, 1));
        d.destination_sheet = Some(dest.to_string());
        d.source_sheet = Some(src.to_string());
        d
    };
    {
        let mut tables = wb.pivots.pivot_tables.write(&seed).unwrap();
        for (id, d) in [
            (report, def(report, "Sheet2", "Sheet1")),
            (drifted, def(drifted, "sheet2", "SHEET2")),
            (elsewhere, def(elsewhere, "Sheet1", "Sheet1")),
        ] {
            tables.insert(id, (d, pivot_engine::PivotCache::new(id, 0)));
        }
    }
    wb.pivots
        .previous_states
        .lock()
        .unwrap()
        .insert(report, (def(report, "Sheet2", "Sheet1"), pivot_engine::PivotCache::new(report, 0)));

    crate::sheets::rename_sheet_inner(&wb.state, &wb.file, &wb.pivots, 1, "Report".to_string(), false)
        .expect("rename Sheet2");

    let names = |id| {
        let tables = wb.pivots.pivot_tables.read().unwrap();
        let (d, _) = &tables[&id];
        (d.destination_sheet.clone(), d.source_sheet.clone())
    };
    let s = |x: &str| Some(x.to_string());
    assert_eq!(names(report), (s("Report"), s("Sheet1")), "the destination follows the rename");
    assert_eq!(names(drifted), (s("Report"), s("Report")), "a case-drifted spelling still means that sheet");
    assert_eq!(names(elsewhere), (s("Sheet1"), s("Sheet1")), "a pivot on another sheet is untouched");
    assert_eq!(
        wb.pivots.previous_states.lock().unwrap()[&report].0.destination_sheet,
        s("Report"),
        "a cancel-revert after the rename must not put the old spelling back"
    );
    {
        let tables = wb.pivots.pivot_tables.read().unwrap();
        assert_eq!(
            crate::pivot::operations::resolve_dest_sheet_index(&wb.state, &tables[&report].0),
            1,
            "the renamed destination resolves by NAME again"
        );
    }

    // The SOURCE follows a rename of its own sheet too.
    crate::sheets::rename_sheet_inner(&wb.state, &wb.file, &wb.pivots, 0, "Data".to_string(), false)
        .expect("rename Sheet1");
    assert_eq!(names(report), (s("Report"), s("Data")));
    assert_eq!(names(elsewhere), (s("Data"), s("Data")));
}

/// `update_pivot_in_grid` is the one funnel every grid-pivot write passes, so
/// it is where "a grid pivot never materializes into a canvas" holds even when
/// the resolver had nothing better to answer (a stale name that now names a
/// canvas, or a workbook with no worksheet left). Positive control first: the
/// same view DOES write into a worksheet, so the canvas assertion is not
/// passing on a view that writes nothing.
#[test]
fn a_grid_pivot_never_materializes_into_a_canvas() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    wb.switch_to(0);
    let pivot_id = new_pivot_id();
    let view = one_cell_view(pivot_id);
    let effect = crate::document_effect::test_seed_effect();

    crate::pivot::operations::update_pivot_in_grid(&wb.state, &effect, pivot_id, 0, (3, 3), &view, false)
        .expect("positive control: a worksheet destination is written");
    assert!(cell_count(&wb, 0) > 0, "positive control: the view writes into a worksheet");

    assert_refused_as_canvas(
        crate::pivot::operations::update_pivot_in_grid(&wb.state, &effect, pivot_id, canvas, (3, 3), &view, false),
        "update_pivot_in_grid",
    );
    assert_eq!(cell_count(&wb, canvas), 0, "the canvas grid stays empty");
}

/// backend-locks-effects #2: the refusal used to be SILENT (`update_pivot_in_grid`
/// returned `()`), so every caller went on to `update_pivot_region(canvas)` --
/// moving the pivot's protection off its real cells, which stayed behind as
/// unprotected, never-refreshed values -- stored the view and reported success.
/// `finalize_pivot_update` now answers `Err`, and a refused write leaves the
/// region, and the cells, exactly where they were.
#[test]
fn a_refused_pivot_write_leaves_the_region_on_its_real_sheet() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    wb.switch_to(0);
    let pivot_id = new_pivot_id();
    let view = one_cell_view(pivot_id);
    let effect = crate::document_effect::test_seed_effect();

    crate::pivot::operations::finalize_pivot_update(&wb.state, &effect, &wb.pivots, pivot_id, 0, (3, 3), &view, None)
        .expect("positive control: a worksheet destination finalizes");
    let region = crate::pivot::operations::get_pivot_region(&wb.state, pivot_id).expect("region registered");
    assert_eq!(region.sheet_index, 0);
    let written = cell_count(&wb, 0);
    assert!(written > 0);

    assert_refused_as_canvas(
        crate::pivot::operations::finalize_pivot_update(&wb.state, &effect, &wb.pivots, pivot_id, canvas, (3, 3), &view, None),
        "finalize_pivot_update",
    );
    let region = crate::pivot::operations::get_pivot_region(&wb.state, pivot_id).expect("region kept");
    assert_eq!(region.sheet_index, 0, "the region must NOT move onto the canvas");
    assert_eq!(cell_count(&wb, 0), written, "the pivot's real cells are untouched");
    assert_eq!(cell_count(&wb, canvas), 0);
}

/// The pre-effect half of #2: `pivot_write` / `pivot_mutation_token` run this
/// before they mint the command's `DocumentEffect`, so a pivot command aimed at
/// a destination of the wrong kind refuses with the document still clean. (The
/// two helpers are private to the command module; the census below pins that
/// they call this first.) Both halves of the M6 rule: a frameless pivot is
/// refused on a canvas, a framed one on a worksheet -- and each is accepted
/// where it belongs.
#[test]
fn a_pivot_command_aimed_at_the_wrong_kind_of_sheet_is_refused_before_its_effect() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    let seed = crate::document_effect::test_seed_effect();
    let (on_canvas, on_sheet) = (new_pivot_id(), new_pivot_id());
    let (framed_on_canvas, framed_on_sheet) = (new_pivot_id(), new_pivot_id());
    {
        let mut tables = wb.pivots.pivot_tables.write(&seed).unwrap();
        for (id, dest, framed) in [
            (on_canvas, canvas_name.as_str(), false),
            (on_sheet, "Sheet1", false),
            (framed_on_canvas, canvas_name.as_str(), true),
            (framed_on_sheet, "Sheet1", true),
        ] {
            let mut d = pivot_engine::PivotDefinition::new(id, (0, 0), (0, 0));
            d.destination_sheet = Some(dest.to_string());
            if framed {
                d.canvas_frame = Some(test_frame());
            }
            tables.insert(id, (d, pivot_engine::PivotCache::new(id, 0)));
        }
    }
    let gate = |id| crate::pivot::operations::ensure_pivot_destination_writable(&wb.state, &wb.pivots, id);
    assert_refused_as_canvas(gate(on_canvas), "ensure_pivot_destination_writable (frameless on a canvas)");
    gate(on_sheet).expect("a frameless pivot on a worksheet passes");
    gate(framed_on_canvas).expect("a framed pivot on a canvas passes");
    assert_refused_as_canvas(gate(framed_on_sheet), "ensure_pivot_destination_writable (framed on a worksheet)");
    gate(new_pivot_id()).expect("an unknown pivot is the existence check's refusal, not this one's");
}

fn saved_pivot(id: pivot_engine::PivotId, dest: &str) -> persistence::SavedPivotDefinition {
    let mut d = pivot_engine::PivotDefinition::new(id, (0, 0), (0, 0));
    d.destination_sheet = Some(dest.to_string());
    d.destination = (2, 2);
    persistence::SavedPivotDefinition {
        id,
        source_type: "grid".to_string(),
        source_sheet_index: None,
        definition: serde_json::to_value(&d).unwrap(),
    }
}

/// backend-locks-effects #3: the PULL materializer writes through
/// `write_pivot_to_grid` directly, so the write-site rule never saw it. A pulled
/// definition whose destination names a canvas is now skipped like one whose
/// name does not resolve: no cells, no region, no definition.
#[test]
fn a_pulled_pivot_aimed_at_a_canvas_is_skipped() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    wb.switch_to(0);
    let (to_canvas, to_sheet) = (new_pivot_id(), new_pivot_id());
    let effect = crate::document_effect::test_seed_effect();
    crate::calp_commands::restore_pulled_pivots(
        &effect,
        &[saved_pivot(to_canvas, &canvas_name), saved_pivot(to_sheet, "Sheet1")],
        &[],
        &wb.state,
        &wb.pivots,
        &[],
        &std::collections::HashMap::new(),
        &std::collections::HashMap::new(),
    );
    let tables = wb.pivots.pivot_tables.read().unwrap();
    assert!(tables.contains_key(&to_sheet), "positive control: the worksheet pivot is restored");
    assert!(
        crate::pivot::operations::get_pivot_region(&wb.state, to_sheet).is_some_and(|r| r.sheet_index == 0),
        "positive control: its region is registered on the worksheet"
    );
    assert!(!tables.contains_key(&to_canvas), "the canvas pivot is skipped, definition and all");
    assert!(crate::pivot::operations::get_pivot_region(&wb.state, to_canvas).is_none(), "no region on the canvas");
    assert_eq!(cell_count(&wb, canvas), 0, "the canvas grid stays empty");
}

/// The REFRESH path's twin of the pull test above: `apply_refreshed_pivots`
/// skips a canvas destination in its read phase exactly like a name miss.
#[test]
fn a_refreshed_pivot_aimed_at_a_canvas_is_skipped() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    wb.switch_to(0);
    let (to_canvas, to_sheet) = (new_pivot_id(), new_pivot_id());
    let effect = crate::document_effect::test_seed_effect();
    crate::calp_commands::apply_refreshed_pivots(
        &effect,
        &wb.state,
        &wb.pivots,
        &[saved_pivot(to_canvas, &canvas_name), saved_pivot(to_sheet, "Sheet1")],
        &[],
        &std::collections::HashMap::new(),
        &crate::calp_commands::RefreshSheetNames::default(),
        &std::collections::HashSet::new(),
        None,
    );
    let tables = wb.pivots.pivot_tables.read().unwrap();
    assert!(tables.contains_key(&to_sheet), "positive control: the worksheet pivot is adopted");
    assert!(!tables.contains_key(&to_canvas), "the canvas pivot is skipped");
    assert!(crate::pivot::operations::get_pivot_region(&wb.state, to_canvas).is_none());
    assert_eq!(cell_count(&wb, canvas), 0);
}

/// A FRAMED definition as an application carries it: Region on rows, Sum of
/// Sales in values over Sheet1!A1:B4 (source position 0 in the application),
/// output anchored at `destination` on `dest`, with `frame`.
fn saved_framed_pivot(
    id: pivot_engine::PivotId,
    dest: &str,
    destination: (u32, u32),
    frame: pivot_engine::CanvasFrame,
) -> persistence::SavedPivotDefinition {
    use pivot_engine::{AggregationType, PivotField, ValueField};
    let mut d = pivot_engine::PivotDefinition::new(id, (0, 0), (3, 1));
    d.source_has_headers = true;
    d.source_sheet = Some("Sheet1".to_string());
    d.destination_sheet = Some(dest.to_string());
    d.destination = destination;
    d.row_fields.push(PivotField::new(0, "Region".to_string()));
    d.value_fields.push(ValueField::new(1, "Sales".to_string(), AggregationType::Sum));
    d.canvas_frame = Some(frame);
    persistence::SavedPivotDefinition {
        id,
        source_type: "grid".to_string(),
        source_sheet_index: Some(0),
        definition: serde_json::to_value(&d).unwrap(),
    }
}

/// M6 FOLLOW-UP, the PULL half: a FRAMED pivot travels onto a pulled canvas --
/// written into the canvas's hidden grid, its region on the canvas, its frame
/// kept (and REPAIRED: a carried negative origin is clamped, the load rule) --
/// while a framed definition aimed at a WORKSHEET is skipped. The frameless half
/// stays pinned by `a_pulled_pivot_aimed_at_a_canvas_is_skipped`.
///
/// SABOTAGE: restore the unconditional canvas skip in `restore_pulled_pivots`.
#[test]
fn a_framed_pulled_pivot_is_restored_onto_the_canvas_with_its_frame() {
    let wb = Workbook::new(1);
    seed_sales(&wb);
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    wb.switch_to(0);
    let sheet1_cells = cell_count(&wb, 0);
    let (framed, framed_on_sheet) = (new_pivot_id(), new_pivot_id());
    let carried = pivot_engine::CanvasFrame { x: -12.0, ..test_frame() };
    let effect = crate::document_effect::test_seed_effect();
    // A stale merge INSIDE the box the pivot is about to own: the pivot's
    // merge set replaces it, on the CANVAS's own merge store (it is not the
    // active sheet) -- which the pull path never touched before.
    let stale = crate::api_types::MergedRegion { start_row: 1, start_col: 0, end_row: 2, end_col: 1 };
    wb.state.all_merged_regions.write(&effect).unwrap()[canvas].insert(stale.clone());

    crate::calp_commands::restore_pulled_pivots(
        &effect,
        &[
            saved_framed_pivot(framed, &canvas_name, (0, 0), carried),
            saved_framed_pivot(framed_on_sheet, "Sheet1", (0, 0), test_frame()),
        ],
        &[],
        &wb.state,
        &wb.pivots,
        &[0],
        &std::collections::HashMap::new(),
        &std::collections::HashMap::new(),
    );

    let def = stored_definition(&wb, framed);
    assert_eq!(def.canvas_frame, Some(pivot_engine::CanvasFrame { x: 0.0, ..test_frame() }), "kept, and repaired");
    let region = crate::pivot::operations::get_pivot_region(&wb.state, framed).expect("a region on the canvas");
    assert_eq!(region.sheet_index, canvas);
    assert_eq!(cell_value(&wb, canvas, 1, 1), Some(engine::CellValue::Number(15.0)), "North = 10 + 5, in the canvas grid");
    assert!(
        !wb.pivots.pivot_tables.read().unwrap().contains_key(&framed_on_sheet),
        "a framed pivot aimed at a worksheet is skipped"
    );
    assert_eq!(cell_count(&wb, 0), sheet1_cells, "the worksheet is untouched");
    assert!(
        !wb.state.all_merged_regions.read().unwrap()[canvas].contains(&stale),
        "the pivot's merges are applied to its sheet: a merge inside its box does not survive"
    );
}

/// M6 FOLLOW-UP, the REFRESH half, and the anchor a refresh cannot trust: a
/// framed pivot is ADOPTED onto a canvas that already holds the subscriber's
/// OWN pivot in the carried anchor's block. `check_pivot_overlap` tests the
/// anchor cell only; the band check re-anchors the refreshed pivot to a free
/// block, so neither pivot writes over the other.
///
/// SABOTAGE: restore the unconditional canvas skip in `apply_refreshed_pivots`
/// (nothing adopted), or drop the `canvas_pivot_anchor_if_band_taken` call (the
/// refreshed pivot lands in block 0 over the local one).
#[test]
fn a_framed_refreshed_pivot_is_adopted_and_re_anchored_off_a_taken_block() {
    use crate::pivot::operations::CANVAS_PIVOT_BLOCK_COLS;
    let wb = Workbook::new(1);
    seed_sales(&wb);
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    // The subscriber's OWN canvas pivot, in block 0.
    let local = create(&wb, create_request(canvas, Some(0), Some(test_frame_config()))).unwrap().pivot_id;
    assert_eq!(crate::pivot::operations::get_pivot_region(&wb.state, local).unwrap().start_col, 0);
    wb.switch_to(0);

    let refreshed = new_pivot_id();
    let effect = crate::document_effect::test_seed_effect();
    crate::calp_commands::apply_refreshed_pivots(
        &effect,
        &wb.state,
        &wb.pivots,
        &[saved_framed_pivot(refreshed, &canvas_name, (0, 0), test_frame())],
        &[],
        &std::collections::HashMap::new(),
        &crate::calp_commands::RefreshSheetNames::default(),
        &std::collections::HashSet::new(),
        None,
    );

    let def = stored_definition(&wb, refreshed);
    assert_eq!(def.canvas_frame, Some(test_frame()), "adopted with its frame");
    assert_eq!(def.destination, (0, CANVAS_PIVOT_BLOCK_COLS), "re-anchored to the first FREE block");
    let region = crate::pivot::operations::get_pivot_region(&wb.state, refreshed).unwrap();
    assert_eq!((region.sheet_index, region.start_col), (canvas, CANVAS_PIVOT_BLOCK_COLS));
    assert_eq!(
        cell_value(&wb, canvas, 1, CANVAS_PIVOT_BLOCK_COLS + 1),
        Some(engine::CellValue::Number(15.0)),
        "the refreshed pivot's output is in its own block"
    );
    let local_region = crate::pivot::operations::get_pivot_region(&wb.state, local).unwrap();
    assert_eq!(local_region.start_col, 0, "the local pivot keeps its block");
    assert_eq!(cell_value(&wb, canvas, 1, 1), Some(engine::CellValue::Number(15.0)), "and its cells");
}

// ---------------------------------------------------------------------------
// M6: a canvas pivot is a REAL pivot in the canvas's hidden grid
// ---------------------------------------------------------------------------

fn test_frame() -> pivot_engine::CanvasFrame {
    pivot_engine::CanvasFrame { x: 40.0, y: 60.0, width: 320.0, height: 200.0, frozen_headers: false }
}

fn test_frame_config() -> crate::pivot::types::CanvasFrameConfig {
    test_frame().into()
}

fn recalc_states(wb: &Workbook) -> crate::pivot::operations::PivotRecalcStates<'_> {
    crate::pivot::operations::PivotRecalcStates { pane: &wb.pane, ribbon: &wb.filters, user_files: &wb.files }
}

/// A definition put straight into the store, as a create would leave it.
fn insert_pivot(
    wb: &Workbook,
    dest_sheet: &str,
    destination: (u32, u32),
    frame: Option<pivot_engine::CanvasFrame>,
) -> pivot_engine::PivotId {
    let id = new_pivot_id();
    let mut def = pivot_engine::PivotDefinition::new(id, (0, 0), (0, 0));
    def.destination_sheet = Some(dest_sheet.to_string());
    def.destination = destination;
    def.canvas_frame = frame;
    wb.pivots
        .pivot_tables
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert(id, (def, pivot_engine::PivotCache::new(id, 0)));
    id
}

fn stored_definition(wb: &Workbook, id: pivot_engine::PivotId) -> pivot_engine::PivotDefinition {
    wb.pivots.pivot_tables.read().unwrap()[&id].0.clone()
}

fn data_row(view_row: usize) -> pivot_engine::PivotRowDescriptor {
    pivot_engine::PivotRowDescriptor {
        view_row,
        row_type: pivot_engine::PivotRowType::Data,
        depth: 0,
        visible: true,
        parent_index: None,
        children_indices: Vec::new(),
        group_values: Vec::new(),
    }
}

/// One row whose first cell spans two columns: the write produces one merge.
fn merged_view(pivot_id: pivot_engine::PivotId) -> pivot_engine::PivotView {
    let mut view = pivot_engine::PivotView::new(pivot_id);
    let mut spanning = pivot_engine::PivotViewCell::data(1.0);
    spanning.col_span = 2;
    view.add_row(vec![spanning, pivot_engine::PivotViewCell::blank()], data_row(0));
    view
}

/// Region | Sales on Sheet1 (the ACTIVE sheet when called), three data rows.
fn seed_sales(wb: &Workbook) {
    for (r, c, v) in [
        (0, 0, "Region"),
        (0, 1, "Sales"),
        (1, 0, "North"),
        (1, 1, "10"),
        (2, 0, "South"),
        (2, 1, "20"),
        (3, 0, "North"),
        (3, 1, "5"),
    ] {
        wb.set(r, c, v);
    }
}

trait WithDestination {
    fn with_destination(self, cell: &str) -> Self;
}

impl WithDestination for crate::pivot::types::CreatePivotRequest {
    fn with_destination(mut self, cell: &str) -> Self {
        self.destination_cell = cell.to_string();
        self
    }
}

fn create_request(
    dest_sheet: usize,
    source_sheet: Option<usize>,
    frame: Option<crate::pivot::types::CanvasFrameConfig>,
) -> crate::pivot::types::CreatePivotRequest {
    crate::pivot::types::CreatePivotRequest {
        source_range: "A1:B4".to_string(),
        // Ignored on a canvas: the allocator owns the anchor.
        destination_cell: "D5".to_string(),
        source_sheet,
        destination_sheet: Some(dest_sheet),
        has_headers: Some(true),
        name: None,
        source_table_name: None,
        canvas_frame: frame,
    }
}

/// The real create door, with Region on rows and Sum of Sales in values.
fn create(
    wb: &Workbook,
    request: crate::pivot::types::CreatePivotRequest,
) -> Result<crate::pivot::types::PivotViewResponse, String> {
    crate::pivot::commands::create_pivot_core(
        &wb.state,
        &wb.file,
        &wb.pivots,
        recalc_states(wb),
        request,
        vec!["Region".to_string()],
        vec![("Sales".to_string(), pivot_engine::AggregationType::Sum)],
    )
}

fn pivot_count(wb: &Workbook) -> usize {
    wb.pivots.pivot_tables.read().unwrap().len()
}

/// THE M6 SHAPE, end to end through the real create door: a framed pivot on a
/// canvas writes its output into the CANVAS's hidden grid, at the allocator's
/// anchor (not the requested cell), registers its protected region on the
/// canvas's index, and carries its frame into what is saved.
#[test]
fn a_framed_pivot_lands_in_the_canvas_grid_with_its_region_and_frame() {
    let wb = Workbook::new(1);
    seed_sales(&wb);
    let sheet1_cells = cell_count(&wb, 0);
    let canvas = add_canvas(&wb).active_index;
    assert_eq!(*wb.state.active_sheet.read().unwrap(), canvas, "inserted from the canvas, as the Canvas tab does");

    let response = create(&wb, create_request(canvas, Some(0), Some(test_frame_config())))
        .expect("a framed pivot on a canvas is created");
    let id = response.pivot_id;

    let region = crate::pivot::operations::get_pivot_region(&wb.state, id).expect("a region is registered");
    assert_eq!(region.sheet_index, canvas, "the region is keyed to the canvas index");
    assert_eq!((region.start_row, region.start_col), (0, 0), "the allocator's anchor, not the requested D5");
    assert!(cell_count(&wb, canvas) > 0, "the pivot's output is in the canvas's hidden grid");
    assert_eq!(cell_value(&wb, canvas, 1, 1), Some(engine::CellValue::Number(15.0)), "North = 10 + 5");
    assert_eq!(cell_count(&wb, 0), sheet1_cells, "the source sheet is untouched");

    let def = stored_definition(&wb, id);
    assert_eq!(def.canvas_frame, Some(test_frame()));
    assert_eq!(def.destination, (0, 0));
    assert_eq!(def.source_sheet.as_deref(), Some("Sheet1"));

    // Persisted: the frame rides the opaque definition JSON into the file.
    let mut saved = ::persistence::Workbook::new();
    crate::persistence::collect_pivot_definitions(&wb.pivots, &wb.state, &mut saved);
    let entry = saved.pivot_definitions.iter().find(|p| p.id == id).expect("the pivot is saved");
    let frame: pivot_engine::CanvasFrame =
        serde_json::from_value(entry.definition["canvas_frame"].clone()).expect("the saved definition carries its frame");
    assert_eq!(frame, test_frame());
}

/// Two pivots on one canvas never share cells: each owns a 1024-column block,
/// whole bands are checked (not just the anchor cell), a region on ANOTHER
/// sheet blocks nothing, and the seventeenth is refused -- before the effect.
#[test]
fn canvas_pivots_get_disjoint_blocks_and_the_seventeenth_is_refused() {
    use crate::pivot::operations::{allocate_canvas_pivot_anchor, update_pivot_region, CANVAS_PIVOT_BLOCK_COLS};
    let wb = Workbook::new(1);
    seed_sales(&wb);
    let canvas = add_canvas(&wb).active_index;

    let first = create(&wb, create_request(canvas, Some(0), Some(test_frame_config()))).unwrap().pivot_id;
    let second = create(&wb, create_request(canvas, Some(0), Some(test_frame_config()))).unwrap().pivot_id;
    let r1 = crate::pivot::operations::get_pivot_region(&wb.state, first).unwrap();
    let r2 = crate::pivot::operations::get_pivot_region(&wb.state, second).unwrap();
    assert_eq!((r1.start_row, r1.start_col), (0, 0));
    assert_eq!((r2.start_row, r2.start_col), (0, CANVAS_PIVOT_BLOCK_COLS), "the second pivot gets the next block");
    assert!(r1.end_col < r2.start_col, "the two rectangles are disjoint");
    assert_eq!(
        cell_value(&wb, canvas, 1, CANVAS_PIVOT_BLOCK_COLS + 1),
        Some(engine::CellValue::Number(15.0)),
        "the second pivot's output is in its own block"
    );

    // A region reaching INTO a band takes it, even though its anchor is in the
    // band before: whole bands, not anchor cells.
    let straddler = new_pivot_id();
    let mut wide = pivot_engine::PivotView::new(straddler);
    wide.add_row((0..40).map(|_| pivot_engine::PivotViewCell::data(1.0)).collect(), data_row(0));
    update_pivot_region(&wb.state, straddler, canvas, (0, 3 * CANVAS_PIVOT_BLOCK_COLS - 10), &wide);
    // A region on ANOTHER sheet blocks nothing here.
    update_pivot_region(&wb.state, new_pivot_id(), 0, (0, 4 * CANVAS_PIVOT_BLOCK_COLS), &one_cell_view(new_pivot_id()));
    assert_eq!(
        allocate_canvas_pivot_anchor(&wb.state, canvas).unwrap(),
        (0, 4 * CANVAS_PIVOT_BLOCK_COLS),
        "blocks 2 and 3 are both reached by the straddling region; block 4 is free on THIS sheet"
    );

    // Fill every remaining block; the next allocation is refused.
    for block in 4..crate::pivot::operations::CANVAS_PIVOT_MAX_BLOCKS {
        let id = new_pivot_id();
        update_pivot_region(&wb.state, id, canvas, (0, block * CANVAS_PIVOT_BLOCK_COLS), &one_cell_view(id));
    }
    let full = allocate_canvas_pivot_anchor(&wb.state, canvas).expect_err("sixteen blocks are all taken");
    assert!(full.contains("maximum of 16"), "{full}");

    // Through the door: refused with the document clean and nothing added.
    crate::document_effect::mark_saved(&wb.file);
    let before = (pivot_count(&wb), cell_count(&wb, canvas));
    let refused = create(&wb, create_request(canvas, Some(0), Some(test_frame_config())));
    assert!(refused.is_err_and(|e| e.contains("maximum of 16")));
    assert_eq!((pivot_count(&wb), cell_count(&wb, canvas)), before, "the refusal created and wrote nothing");
    assert!(!wb.file.is_dirty(), "a refused create leaves the document clean");
}

/// Both halves of the rule at the create door, each refused before the effect
/// and each writing nothing: a frameless pivot on a canvas (including the MCP
/// shape, which has no frame to give), a framed pivot on a worksheet, a canvas
/// pivot with no explicit source (the default would be the empty canvas) or a
/// canvas source, and an invalid frame.
#[test]
fn the_create_door_refuses_a_pivot_of_the_wrong_kind_and_writes_nothing() {
    let wb = Workbook::new(1);
    seed_sales(&wb);
    let sheet1_cells = cell_count(&wb, 0);
    let canvas = add_canvas(&wb).active_index;
    crate::document_effect::mark_saved(&wb.file);

    let invalid = crate::pivot::types::CanvasFrameConfig { width: 1.0, ..test_frame_config() };
    for (what, request) in [
        ("a frameless pivot on a canvas", create_request(canvas, Some(0), None)),
        ("a framed pivot on a worksheet", create_request(0, Some(0), Some(test_frame_config()))),
        ("a canvas pivot with the default (canvas) source", create_request(canvas, None, Some(test_frame_config()))),
        ("a canvas pivot over a canvas source", create_request(canvas, Some(canvas), Some(test_frame_config()))),
        ("an invalid frame", create_request(canvas, Some(0), Some(invalid))),
    ] {
        match create(&wb, request) {
            Ok(r) => panic!("{what}: must be refused, got pivot {}", r.pivot_id),
            Err(e) => assert!(e.contains("canvas"), "{what}: the refusal must name the canvas rule, got: {e}"),
        }
        assert_eq!(pivot_count(&wb), 0, "{what}: no pivot was created");
        assert_eq!(cell_count(&wb, canvas), 0, "{what}: the canvas grid stays empty");
        assert_eq!(cell_count(&wb, 0), sheet1_cells, "{what}: the worksheet is untouched");
        assert!(!wb.file.is_dirty(), "{what}: a refusal must not dirty the document");
    }

    // Positive control: the same door, the right kind, succeeds.
    create(&wb, create_request(canvas, Some(0), Some(test_frame_config()))).expect("positive control");
    assert_eq!(pivot_count(&wb), 1);
}

/// The write funnel's half of the rule: a FRAMED pivot never materializes into
/// a worksheet, and a canvas pivot wider than its block is refused LOUDLY --
/// never clipped, never spilled into the next pivot's block.
#[test]
fn the_write_funnel_refuses_a_framed_pivot_off_a_canvas_and_one_wider_than_its_block() {
    use crate::pivot::operations::{ensure_canvas_pivot_fits_block, update_pivot_in_grid, CANVAS_PIVOT_BLOCK_COLS};
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    wb.switch_to(0);
    let effect = crate::document_effect::test_seed_effect();
    let id = new_pivot_id();

    assert_refused_as_canvas(
        update_pivot_in_grid(&wb.state, &effect, id, 0, (0, 0), &one_cell_view(id), true),
        "update_pivot_in_grid (framed, worksheet)",
    );
    assert_eq!(cell_count(&wb, 0), 0, "nothing was written into the worksheet");

    let mut wide = pivot_engine::PivotView::new(id);
    let too_wide = CANVAS_PIVOT_BLOCK_COLS as usize + 1;
    wide.add_row((0..too_wide).map(|_| pivot_engine::PivotViewCell::data(1.0)).collect(), data_row(0));
    let refusal = update_pivot_in_grid(&wb.state, &effect, id, canvas, (0, 0), &wide, true)
        .expect_err("a view wider than its block is refused");
    assert!(refusal.contains("1025 columns wide") && refusal.contains("1024"), "{refusal}");
    assert_eq!(cell_count(&wb, canvas), 0, "the refusal wrote nothing -- not even the part that fits");

    // Exactly one block wide fits; so does the same width in a later block.
    let mut exact = pivot_engine::PivotView::new(id);
    exact.add_row((0..CANVAS_PIVOT_BLOCK_COLS).map(|_| pivot_engine::PivotViewCell::data(1.0)).collect(), data_row(0));
    ensure_canvas_pivot_fits_block(id, (0, 0), &exact).expect("a full block fits");
    ensure_canvas_pivot_fits_block(id, (0, 5 * CANVAS_PIVOT_BLOCK_COLS), &exact).expect("in any block");
    assert!(ensure_canvas_pivot_fits_block(id, (0, 1), &exact).is_err(), "an anchor off the block start leaves less room");

    // Positive control: a framed pivot that fits IS written into the canvas.
    update_pivot_in_grid(&wb.state, &effect, id, canvas, (0, 0), &one_cell_view(id), true)
        .expect("a framed pivot that fits is written into its canvas");
    assert_eq!(cell_value(&wb, canvas, 0, 0), Some(engine::CellValue::Number(42.0)));
}

/// PRE-EXISTING DEFECT (a), fixed here: merges went to the ACTIVE sheet's
/// mirror (`merged_regions`) whatever the destination. A canvas pivot
/// refiltered while Sheet1 is active put its merge on Sheet1 -- merging cells
/// there that the pivot never wrote -- and left the canvas unmerged.
#[test]
fn merges_of_a_canvas_pivot_written_while_sheet1_is_active_land_in_the_canvas_set() {
    use crate::api_types::MergedRegion;
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    wb.switch_to(0);
    let id = insert_pivot(&wb, &canvas_name, (0, 0), Some(test_frame()));
    let effect = crate::document_effect::test_seed_effect();

    crate::pivot::operations::finalize_pivot_update(&wb.state, &effect, &wb.pivots, id, canvas, (0, 0), &merged_view(id), None)
        .expect("a framed pivot is written into its canvas");

    let merge = MergedRegion { start_row: 0, start_col: 0, end_row: 0, end_col: 1 };
    let canvas_set = |wb: &Workbook| {
        wb.state.all_merged_regions.read().unwrap().get(canvas).cloned().unwrap_or_default()
    };
    assert!(
        !wb.state.merged_regions.read().unwrap().contains(&merge),
        "the canvas pivot's merge landed on Sheet1, the ACTIVE sheet, instead of its own"
    );
    assert!(canvas_set(&wb).contains(&merge), "the merge belongs to the canvas's set");

    // Re-finalized with no spanning cell: the old merge is removed from the
    // CANVAS's set (the retain goes to the same set as the insert).
    crate::pivot::operations::finalize_pivot_update(&wb.state, &effect, &wb.pivots, id, canvas, (0, 0), &one_cell_view(id), None)
        .unwrap();
    assert!(!canvas_set(&wb).contains(&merge), "the stale merge is cleared from the canvas's set");
}

/// PRE-EXISTING DEFECT (b), fixed here: every pivot write ended in
/// `recalculate_sheet_formulas`, the ACTIVE sheet only. With the user ON the
/// canvas (the slicer next to the pivot), Sheet1's `=<canvas>!A1*2` kept its
/// old value. The write now seeds the shared cascade (active-sheet branch).
#[test]
fn a_formula_reading_canvas_pivot_output_updates_while_the_canvas_is_active() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    wb.switch_to(0);
    wb.set(0, 0, &format!("={}!A1*2", canvas_name));
    assert_eq!(wb.number(0, 0, 0), 0.0, "precondition: the canvas cell is empty");
    let id = insert_pivot(&wb, &canvas_name, (0, 0), Some(test_frame()));
    wb.switch_to(canvas);
    let effect = crate::document_effect::test_seed_effect();
    crate::pivot::operations::finalize_pivot_update(
        &wb.state, &effect, &wb.pivots, id, canvas, (0, 0), &one_cell_view(id), Some(recalc_states(&wb)),
    )
    .unwrap();
    assert_eq!(
        wb.number(0, 0, 0),
        84.0,
        "Sheet1 reads the canvas pivot's output, and the write left it stale (canvas active)"
    );
}

/// The same defect's OFF-SHEET branch: a third sheet is active, so the pivot's
/// destination is off-sheet AND so is its reader. The old pass recalculated
/// Sheet2 only; the write now reaches Sheet1 through the dependent-sheet
/// closure of `recalc_after_off_sheet_write`.
#[test]
fn a_formula_reading_canvas_pivot_output_updates_while_a_third_sheet_is_active() {
    let wb = Workbook::new(2);
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    wb.switch_to(0);
    wb.set(0, 0, &format!("={}!A1*2", canvas_name));
    assert_eq!(wb.number(0, 0, 0), 0.0, "precondition: the canvas cell is empty");
    let id = insert_pivot(&wb, &canvas_name, (0, 0), Some(test_frame()));
    wb.switch_to(1);
    let effect = crate::document_effect::test_seed_effect();
    crate::pivot::operations::finalize_pivot_update(
        &wb.state, &effect, &wb.pivots, id, canvas, (0, 0), &one_cell_view(id), Some(recalc_states(&wb)),
    )
    .unwrap();
    assert_eq!(
        wb.number(0, 0, 0),
        84.0,
        "Sheet1 reads the canvas pivot's output, and the write left it stale (Sheet2 active)"
    );
}

/// The cascade the pivot write now seeds evaluates WITHOUT the GETPIVOTDATA
/// lookup (`reevaluate_formula_cell` wires none). A GETPIVOTDATA on another
/// sheet that reads a pivot on the ACTIVE sheet is reached by that cascade, and
/// must not come out of it as #REF! -- the pass must end on the pivot's number.
#[test]
fn a_cross_sheet_getpivotdata_survives_a_write_to_a_pivot_on_the_active_sheet() {
    let wb = Workbook::new(2);
    seed_sales(&wb);
    let response = create(&wb, create_request(0, Some(0), None).with_destination("E1"))
        .expect("a worksheet pivot on Sheet1");
    let id = response.pivot_id;
    wb.switch_to(1);
    // `;` -- the harness's default locale separates arguments with it. The
    // grand-total form (the field/item form answers #REF! on ENTRY today,
    // before any of this, so it cannot tell this defect apart).
    wb.set(0, 0, "=GETPIVOTDATA(\"Sum of Sales\";Sheet1!E1)");
    assert_eq!(wb.value(1, 0, 0), engine::CellValue::Number(35.0), "precondition: the lookup works on entry");
    wb.switch_to(0);

    // Re-render the pivot where it is, as a refresh or refilter does.
    let (def, view) = {
        let mut tables = wb.pivots.pivot_tables.write(&crate::document_effect::test_seed_effect()).unwrap();
        let (def, cache) = tables.get_mut(&id).unwrap();
        let view = crate::pivot::operations::safe_calculate_pivot(def, cache);
        (def.clone(), view)
    };
    wb.pivots.views.lock().unwrap().insert(id, view.clone());
    let effect = crate::document_effect::test_seed_effect();
    crate::pivot::operations::finalize_pivot_update(
        &wb.state, &effect, &wb.pivots, id, 0, def.destination, &view, Some(recalc_states(&wb)),
    )
    .unwrap();
    assert_eq!(
        wb.value(1, 0, 0),
        engine::CellValue::Number(35.0),
        "Sheet2's GETPIVOTDATA came out of the pivot write as something other than the pivot's number"
    );
}

/// BUG-0145: GETPIVOTDATA identified a pivot by its CELL only, and every
/// canvas's first pivot sits at A1 of the canvas's hidden grid -- so a
/// worksheet pivot at A1 and a canvas pivot answered for each other, whichever
/// a hash map listed first. Two pivots at the same address on different
/// sheets must each answer their own total, qualified or not. (Before the fix
/// at least one of the three assertions fails whatever the hash order: all
/// three lookups returned the same pivot.)
#[test]
fn getpivotdata_answers_from_the_pivot_on_the_referenced_sheet_not_any_pivot_at_that_cell() {
    let wb = Workbook::new(3);
    seed_sales(&wb); // Sheet1: total 35
    wb.switch_to(1);
    for (r, c, v) in [
        (0, 0, "Region"),
        (0, 1, "Sales"),
        (1, 0, "North"),
        (1, 1, "100"),
        (2, 0, "South"),
        (2, 1, "200"),
        (3, 0, "North"),
        (3, 1, "300"),
    ] {
        wb.set(r, c, v); // Sheet2: total 600
    }
    wb.switch_to(2);
    create(&wb, create_request(2, Some(0), None).with_destination("A1"))
        .expect("a worksheet pivot at Sheet3!A1 over Sheet1's data");
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    let framed = create(&wb, create_request(canvas, Some(1), Some(test_frame_config())))
        .expect("a canvas pivot over Sheet2's data");
    assert_eq!(
        crate::pivot::operations::get_pivot_region(&wb.state, framed.pivot_id).map(|r| (r.start_row, r.start_col)),
        Some((0, 0)),
        "precondition: the canvas pivot's block sits at A1, the same cell as Sheet3's pivot"
    );

    wb.switch_to(0);
    wb.set(10, 0, "=GETPIVOTDATA(\"Sum of Sales\";Sheet3!A1)");
    wb.set(11, 0, &format!("=GETPIVOTDATA(\"Sum of Sales\";'{canvas_name}'!A1)"));
    assert_eq!(wb.value(0, 10, 0), engine::CellValue::Number(35.0), "Sheet3!A1 is Sheet3's pivot");
    assert_eq!(wb.value(0, 11, 0), engine::CellValue::Number(600.0), "the canvas's A1 is the canvas pivot");

    // Unqualified: the formula's own sheet.
    wb.switch_to(2);
    wb.set(20, 0, "=GETPIVOTDATA(\"Sum of Sales\";A1)");
    assert_eq!(wb.value(2, 20, 0), engine::CellValue::Number(35.0), "an unqualified A1 is the formula's own sheet");
}

/// The frame is moved through `update_pivot_properties`: refused, with the
/// document clean, for a worksheet pivot (no grid <-> canvas conversion) and
/// for an invalid frame; applied and UNDOABLE for a canvas pivot.
#[test]
fn a_canvas_pivot_frame_moves_undoably_and_a_worksheet_pivot_refuses_one() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    let framed = insert_pivot(&wb, &canvas_name, (0, 0), Some(test_frame()));
    let unframed = insert_pivot(&wb, "Sheet1", (5, 5), None);
    let request = |id, frame| crate::pivot::types::UpdatePivotPropertiesRequest {
        pivot_id: id,
        name: None,
        allow_multiple_filters_per_field: None,
        enable_data_value_editing: None,
        refresh_on_open: None,
        use_custom_sort_lists: None,
        canvas_frame: Some(frame),
    };
    let update = |r| crate::pivot::commands::update_pivot_properties_core(&wb.state, &wb.file, &wb.pivots, r);
    crate::document_effect::mark_saved(&wb.file);
    let depth = || wb.state.undo_stack.lock().unwrap().undo_depth();
    let depth_before = depth();

    let refused = update(request(unframed, test_frame_config()));
    assert!(refused.is_err_and(|e| e.contains("canvas")), "a worksheet pivot never gets a frame");
    assert_eq!(stored_definition(&wb, unframed).canvas_frame, None);
    let bad = crate::pivot::types::CanvasFrameConfig { x: -5.0, ..test_frame_config() };
    assert!(update(request(framed, bad)).is_err(), "an invalid frame is refused, not clamped");
    assert_eq!(stored_definition(&wb, framed).canvas_frame, Some(test_frame()));
    assert!(!wb.file.is_dirty(), "the refusals left the document clean");
    assert_eq!(depth(), depth_before, "and recorded nothing");

    let moved = pivot_engine::CanvasFrame { x: 200.0, y: 10.0, width: 500.0, height: 260.0, frozen_headers: true };
    update(request(framed, moved.into())).expect("a canvas pivot's frame moves");
    assert_eq!(stored_definition(&wb, framed).canvas_frame, Some(moved));
    assert!(wb.file.is_dirty(), "moving the box is a document change");
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_description(), Some("Move pivot"));

    // Saving the SAME frame again adds no Ctrl+Z step.
    update(request(framed, moved.into())).unwrap();
    assert_eq!(depth(), depth_before + 1, "a no-op frame save records nothing");

    // Ctrl+Z puts the box back, through the real restore.
    let transaction = wb.state.undo_stack.lock().unwrap().pop_undo().unwrap();
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, &wb.timelines, transaction, true,
    );
    assert_eq!(stored_definition(&wb, framed).canvas_frame, Some(test_frame()), "undo moves the box back");
}

// ---------------------------------------------------------------------------
// M8 arrange: ONE Ctrl+Z for a cross-family arrange
// ---------------------------------------------------------------------------

fn frame_request(
    id: pivot_engine::PivotId,
    frame: pivot_engine::CanvasFrame,
) -> crate::pivot::types::UpdatePivotPropertiesRequest {
    crate::pivot::types::UpdatePivotPropertiesRequest {
        pivot_id: id,
        name: None,
        allow_multiple_filters_per_field: None,
        enable_data_value_editing: None,
        refresh_on_open: None,
        use_custom_sort_lists: None,
        canvas_frame: Some(frame.into()),
    }
}

fn undo_depth(wb: &Workbook) -> usize {
    wb.state.undo_stack.lock().unwrap().undo_depth()
}

fn transaction_open(wb: &Workbook) -> bool {
    wb.state.undo_stack.lock().unwrap().has_open_transaction()
}

/// `record_pivot_definition_undo` ran an unconditional begin/commit pair, and
/// `commit` closes WHATEVER is open -- so moving a pivot box inside an arrange
/// committed the arrange's own transaction early.
#[test]
fn a_canvas_pivot_frame_move_joins_an_open_transaction() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    let framed = insert_pivot(&wb, &canvas_name, (0, 0), Some(test_frame()));
    let depth_before = undo_depth(&wb);

    wb.state.undo_stack.lock().unwrap().begin_transaction("Align left");
    let moved = pivot_engine::CanvasFrame { x: 300.0, ..test_frame() };
    crate::pivot::commands::update_pivot_properties_core(&wb.state, &wb.file, &wb.pivots, frame_request(framed, moved))
        .expect("a canvas pivot's frame moves");
    assert!(transaction_open(&wb), "moving the pivot box committed the caller's outer transaction");
    assert_eq!(undo_depth(&wb), depth_before, "nothing may land on the stack before the caller commits");
    wb.state.undo_stack.lock().unwrap().commit_transaction();
    assert_eq!(undo_depth(&wb), depth_before + 1);
}

fn canvas_timeline(sheet_index: usize) -> crate::timeline_slicer::TimelineSlicer {
    crate::timeline_slicer::TimelineSlicer {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: "Order Date".to_string(),
        header_text: None,
        sheet_index,
        x: 10.0,
        y: 20.0,
        width: 350.0,
        height: 100.0,
        source_type: crate::timeline_slicer::TimelineSourceType::Pivot,
        source_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        field_name: "OrderDate".to_string(),
        level: crate::timeline_slicer::TimelineLevel::Months,
        selection_start: None,
        selection_end: None,
        show_header: true,
        show_level_selector: true,
        show_scrollbar: true,
        style_preset: "TimelineStyleLight1".to_string(),
        connected_pivot_ids: vec![],
    }
}

fn canvas_slicer(sheet_index: usize) -> crate::slicer::Slicer {
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    serde_json::from_value(serde_json::json!({
        "id": id.to_string(),
        "name": "Region",
        "sheetIndex": sheet_index,
        "x": 10.0, "y": 300.0, "width": 180.0, "height": 240.0,
        "sourceType": "pivot",
        "cacheSourceId": id.to_string(),
        "fieldName": "Region",
        "selectedItems": null,
        "showHeader": true,
        "columns": 1,
        "stylePreset": "SlicerStyleLight1",
        "connectedSources": []
    }))
    .expect("slicer from json")
}

fn canvas_shape() -> crate::controls::ControlMetadata {
    let mut properties = std::collections::HashMap::new();
    for (name, value) in [("x", "600"), ("y", "40"), ("width", "80"), ("height", "28"), ("pinToGrid", "false")] {
        properties.insert(
            name.to_string(),
            crate::controls::ControlPropertyValue { value_type: "static".to_string(), value: value.to_string() },
        );
    }
    crate::controls::ControlMetadata { control_type: "shape".to_string(), properties }
}

/// THE M8 CONTRACT. An arrange (Align Left here) moves a slicer, a timeline, a
/// control and a canvas pivot box inside ONE `begin_undo_transaction`: every
/// recorder must JOIN it, so the stack gains exactly one entry, and ONE Ctrl+Z
/// through the real restore path puts all four back (and one redo moves all
/// four again). Each recorder on its own still records exactly one step.
#[test]
fn a_cross_family_arrange_is_one_undo_step_and_one_ctrl_z_restores_all_four() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();

    let slicer = canvas_slicer(canvas);
    let slicer_id = slicer.id;
    wb.slicer.slicers.write(&crate::document_effect::test_seed_effect()).unwrap().insert(slicer_id, slicer);
    let timeline = canvas_timeline(canvas);
    let timeline_id = timeline.id;
    wb.timelines.timelines.write(&crate::document_effect::test_seed_effect()).unwrap().insert(timeline_id, timeline);
    let control = (canvas, 1, 1);
    wb.state.controls.write(&crate::document_effect::test_seed_effect()).unwrap().insert(control, canvas_shape());
    let pivot = insert_pivot(&wb, &canvas_name, (0, 0), Some(test_frame()));

    let slicer_frame = || {
        let s = &wb.slicer.slicers.read().unwrap()[&slicer_id];
        (s.x, s.y, s.width, s.height)
    };
    let timeline_frame = || {
        let t = &wb.timelines.timelines.read().unwrap()[&timeline_id];
        (t.x, t.y, t.width, t.height)
    };
    let control_x = || wb.state.controls.read().unwrap()[&control].properties["x"].value.clone();
    let pivot_frame = || stored_definition(&wb, pivot).canvas_frame.expect("a canvas pivot keeps its frame");
    let before = (slicer_frame(), timeline_frame(), control_x(), pivot_frame());

    // Align Left to x = 5, all four families, one transaction.
    let move_all = |x: f64| {
        crate::slicer::commands::update_slicer_position_core(&wb.state, &wb.file, &wb.slicer, slicer_id, x, 300.0, 180.0, 240.0)
            .expect("the slicer moves");
        assert!(transaction_open(&wb), "the SLICER move committed the arrange's transaction early");
        crate::timeline_slicer::commands::update_timeline_position_core(
            &wb.state, &wb.timelines, &wb.file, timeline_id, x, 20.0, 350.0, 100.0,
        )
        .expect("the timeline moves");
        assert!(transaction_open(&wb), "the TIMELINE move committed the arrange's transaction early");
        let change = crate::api_types::ControlGeometryChange {
            sheet_index: control.0,
            row: control.1,
            col: control.2,
            x,
            y: 40.0,
            width: 80.0,
            height: 28.0,
            offset_x: None,
            offset_y: None,
        };
        assert_eq!(crate::controls::set_control_geometry_core(&wb.state, &wb.file, &[change]), Ok(1));
        assert!(transaction_open(&wb), "the CONTROL batch committed the arrange's transaction early");
        crate::pivot::commands::update_pivot_properties_core(
            &wb.state,
            &wb.file,
            &wb.pivots,
            frame_request(pivot, pivot_engine::CanvasFrame { x, ..test_frame() }),
        )
        .expect("the pivot box moves");
        assert!(transaction_open(&wb), "the PIVOT BOX move committed the arrange's transaction early");
    };

    let depth_before = undo_depth(&wb);
    wb.state.undo_stack.lock().unwrap().begin_transaction("Align left");
    move_all(5.0);
    assert!(transaction_open(&wb), "a family committed the arrange's transaction early");
    assert_eq!(undo_depth(&wb), depth_before, "nothing landed before the arrange committed");
    wb.state.undo_stack.lock().unwrap().commit_transaction();
    assert_eq!(undo_depth(&wb), depth_before + 1, "the whole arrange is ONE undo step");
    let moved = (slicer_frame(), timeline_frame(), control_x(), pivot_frame());
    assert_eq!(moved.0.0, 5.0);
    assert_eq!(moved.1.0, 5.0);
    assert_eq!(moved.2, "5");
    assert_eq!(moved.3.x, 5.0);

    // ONE Ctrl+Z, through the real restore path.
    let transaction = wb.state.undo_stack.lock().unwrap().pop_undo().expect("the arrange is on the stack");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, &wb.timelines, transaction, true,
    );
    assert_eq!(
        (slicer_frame(), timeline_frame(), control_x(), pivot_frame()),
        before,
        "one Ctrl+Z must put ALL FOUR back"
    );
    assert_eq!(undo_depth(&wb), depth_before);

    // ONE redo moves all four again.
    let redo = wb.state.undo_stack.lock().unwrap().pop_redo().expect("the arrange is redoable");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, &wb.timelines, redo, false,
    );
    assert_eq!((slicer_frame(), timeline_frame(), control_x(), pivot_frame()), moved, "one redo re-applies all four");

    // Each recorder ALONE: exactly one step apiece, no outer transaction needed.
    let depth = undo_depth(&wb);
    crate::slicer::commands::update_slicer_position_core(&wb.state, &wb.file, &wb.slicer, slicer_id, 40.0, 300.0, 180.0, 240.0)
        .unwrap();
    assert_eq!(undo_depth(&wb), depth + 1, "a slicer move alone is one step");
    crate::timeline_slicer::commands::update_timeline_position_core(
        &wb.state, &wb.timelines, &wb.file, timeline_id, 40.0, 20.0, 350.0, 100.0,
    )
    .unwrap();
    assert_eq!(undo_depth(&wb), depth + 2, "a timeline move alone is one step");
    let change = crate::api_types::ControlGeometryChange {
        sheet_index: control.0,
        row: control.1,
        col: control.2,
        x: 40.0,
        y: 40.0,
        width: 80.0,
        height: 28.0,
        offset_x: None,
        offset_y: None,
    };
    crate::controls::set_control_geometry_core(&wb.state, &wb.file, &[change]).unwrap();
    assert_eq!(undo_depth(&wb), depth + 3, "a control batch alone is one step");
    crate::pivot::commands::update_pivot_properties_core(
        &wb.state,
        &wb.file,
        &wb.pivots,
        frame_request(pivot, pivot_engine::CanvasFrame { x: 40.0, ..test_frame() }),
    )
    .unwrap();
    assert_eq!(undo_depth(&wb), depth + 4, "a pivot box move alone is one step");
    assert!(!transaction_open(&wb), "no recorder left a transaction open");
}

/// `relocate_pivot` (Tauri-only, so its ordering is pinned by the census) runs
/// this before its token: a canvas pivot's cells belong to its block.
#[test]
fn relocating_a_canvas_pivot_is_refused() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    let framed = insert_pivot(&wb, &canvas_name, (0, 0), Some(test_frame()));
    let unframed = insert_pivot(&wb, "Sheet1", (5, 5), None);
    assert_refused_as_canvas(
        crate::pivot::operations::ensure_pivot_not_framed(&wb.pivots, framed, "move the cells of"),
        "relocate_pivot",
    );
    crate::pivot::operations::ensure_pivot_not_framed(&wb.pivots, unframed, "move the cells of")
        .expect("a worksheet pivot may be relocated");
}

/// The wire contract the frontend codes against (`CanvasFrameConfig` in
/// app/src/api/pivotTypes.ts): camelCase, `frozenHeaders` optional on the way
/// in, and a region without a frame carries no `canvasFrame` key at all.
#[test]
fn the_canvas_frame_wire_shape_is_camel_case_and_optional() {
    let config: crate::pivot::types::CanvasFrameConfig =
        serde_json::from_str(r#"{"x":1,"y":2,"width":300,"height":200}"#).unwrap();
    assert!(!config.frozen_headers);
    let json = serde_json::to_value(crate::pivot::types::CanvasFrameConfig { frozen_headers: true, ..config }).unwrap();
    assert_eq!(json["frozenHeaders"], serde_json::json!(true));

    let region = |frame| crate::pivot::types::PivotRegionData {
        pivot_id: new_pivot_id(),
        name: "P".to_string(),
        start_row: 0,
        start_col: 0,
        end_row: 1,
        end_col: 1,
        is_empty: false,
        canvas_frame: frame,
    };
    let bare = serde_json::to_value(region(None)).unwrap();
    assert!(bare.get("canvasFrame").is_none(), "a worksheet pivot's region has no canvasFrame key: {bare}");
    let framed = serde_json::to_value(region(Some(test_frame_config()))).unwrap();
    assert_eq!(framed["canvasFrame"]["width"], serde_json::json!(320.0));

    let request: crate::pivot::types::CreatePivotRequest =
        serde_json::from_str(r#"{"sourceRange":"A1:B4","destinationCell":"A1"}"#).unwrap();
    assert!(request.canvas_frame.is_none(), "an old request without canvasFrame still deserializes");
}

// ---------------------------------------------------------------------------
// Animation restore follows its SHEET, not the caller's index (#5)
// ---------------------------------------------------------------------------

fn snapshot(wb: &Workbook, token: &str, sheet_index: usize) {
    let r = crate::animation_commands::anim_snapshot_inner(
        &wb.state,
        crate::api_types::AnimSnapshotParams {
            token: token.to_string(),
            sheet_index,
            cells: vec![(0, 0)],
        },
    );
    assert!(r.success, "snapshot: {:?}", r.error);
}

fn restore(wb: &Workbook, token: &str, sheet_index: usize) -> crate::api_types::AnimationFrameResult {
    crate::animation_commands::anim_restore_inner(
        &wb.state,
        crate::api_types::AnimRestoreParams { token: token.to_string(), sheet_index },
    )
}

/// The review's scenario: drag the animated sheet's tab during playback. The
/// caller's index then names ANOTHER sheet; the restore goes where the
/// snapshot was taken.
#[test]
fn an_animation_restore_follows_its_sheet_when_the_tab_moves() {
    let wb = Workbook::new(3);
    wb.switch_to(1);
    wb.set(0, 0, "41");
    snapshot(&wb, "run", 1);
    wb.set(0, 0, "99"); // what playback left behind
    wb.switch_to(0);
    crate::sheets::move_sheet_impl(&wb.state, &wb.file, &wb.slicer, &wb.timeline, &wb.filters, 1, 2)
        .expect("move Sheet2 past Sheet3");
    assert_eq!(wb.state.sheet_names.read().unwrap()[2], "Sheet2");

    let r = restore(&wb, "run", 1); // the caller's stale index
    assert!(r.error.is_none(), "restore: {:?}", r.error);
    assert_eq!(cell_value(&wb, 2, 0, 0), Some(engine::CellValue::Number(41.0)), "Sheet2 is restored where it now is");
    assert_eq!(cell_value(&wb, 1, 0, 0), None, "Sheet3, now at the stale index, is untouched");
}

#[test]
fn an_animation_restore_never_writes_into_a_canvas() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    wb.switch_to(0);
    let canvas_id = wb.state.sheet_ids.read().unwrap()[canvas];
    wb.state.animation_snapshots.lock().unwrap().insert(
        "run".to_string(),
        crate::animation_commands::AnimSnapshot {
            sheet_id: Some(canvas_id),
            cells: vec![((0, 0), Some(engine::Cell::new_number(5.0)))],
        },
    );
    let r = restore(&wb, "run", 0);
    assert_refused_as_canvas(r.error.map_or(Ok(()), Err), "anim_restore");
    assert_eq!(cell_count(&wb, canvas), 0, "the canvas grid stays empty");
    assert_eq!(cell_count(&wb, 0), 0, "and the caller's index is not written instead");
    assert!(
        wb.state.animation_snapshots.lock().unwrap().contains_key("run"),
        "the refusal comes BEFORE the snapshot leaves the registry"
    );
}

#[test]
fn an_animation_restore_for_a_deleted_sheet_writes_nothing() {
    let wb = Workbook::new(3);
    wb.switch_to(1);
    wb.set(0, 0, "41");
    snapshot(&wb, "run", 1);
    wb.switch_to(0);
    crate::sheets::delete_sheet_impl(
        &wb.state, &wb.file, &wb.pivots, &wb.files, &wb.pane, &wb.filters, &wb.slicer, &wb.timeline, 1, false,
    )
    .expect("delete Sheet2");
    assert_eq!(wb.state.sheet_names.read().unwrap()[1], "Sheet3");

    let r = restore(&wb, "run", 1);
    assert!(r.error.as_deref().is_some_and(|e| e.contains("no longer exists")), "got {:?}", r.error);
    assert_eq!(cell_value(&wb, 1, 0, 0), None, "Sheet3 did not inherit Sheet2's snapshot");
    assert!(!wb.state.animation_snapshots.lock().unwrap().contains_key("run"), "an unrestorable snapshot is dropped");
}

// ---------------------------------------------------------------------------
// Lock order: remove_computed_property vs the structural remap (#0)
// ---------------------------------------------------------------------------

fn wait_until(ms: u64, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
    while std::time::Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    cond()
}

/// Can another thread take `computed_properties` and both dependency maps --
/// what `remap_sheet_keyed_stores` takes -- within `ms`? A THREAD with a
/// deadline, so a "no" is a timeout rather than a hung test (a probe left
/// waiting on a lock holds nothing of its own and is never joined).
fn probe_can_take_computed_stores(state: &std::sync::Arc<crate::AppState>, ms: u64) -> bool {
    use std::sync::atomic::{AtomicBool, Ordering};
    let got = std::sync::Arc::new(AtomicBool::new(false));
    {
        let state = std::sync::Arc::clone(state);
        let got = std::sync::Arc::clone(&got);
        std::thread::spawn(move || {
            let props = state.computed_properties.read().is_ok();
            let dependents = state.computed_prop_dependents.lock().is_ok();
            let dependencies = state.computed_prop_dependencies.lock().is_ok();
            got.store(props && dependents && dependencies, Ordering::SeqCst);
        });
    }
    wait_until(ms, || got.load(std::sync::atomic::Ordering::SeqCst))
}

/// THE ABBA (backend-locks-effects #0). move/copy/delete sheet hold
/// `column_widths` / `row_heights` while `remap_sheet_keyed_stores` takes
/// `computed_properties` and the dependency maps. `remove_computed_property`
/// used to hold exactly those while it waited for `column_widths`. Here the
/// test thread plays the structural command: it holds `column_widths`, lets
/// the remove block on it, and then asks whether the remap's stores are free.
#[test]
fn removing_a_computed_property_holds_nothing_the_structural_remap_needs() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    let state = Arc::new(crate::create_app_state());
    let file = Arc::new(crate::persistence::FileState::default());
    let seed = crate::document_effect::test_seed_effect();
    state
        .computed_properties
        .write(&seed)
        .unwrap()
        .entry(0)
        .or_default()
        .column_props
        .entry(2)
        .or_default()
        .push(crate::computed_properties::ComputedProperty {
            id: 7,
            attribute: "width".to_string(),
            formula: "=10".to_string(),
            cached_ast: None,
            cached_value: None,
        });

    // NON-VACUITY: the probe must really answer "no" while a store is held.
    {
        let held = state.computed_properties.read().unwrap();
        assert!(!probe_can_take_computed_stores(&state, 300), "the probe cannot see a held store");
        drop(held);
    }
    assert!(probe_can_take_computed_stores(&state, 1_000), "the probe reports a lock that is not held");

    // The structural command's first half: the dimension guard, held.
    let widths = state.column_widths.write(&seed).unwrap();
    let finished = Arc::new(AtomicBool::new(false));
    let handle = {
        let (state, file, finished) = (Arc::clone(&state), Arc::clone(&file), Arc::clone(&finished));
        std::thread::spawn(move || {
            let r = crate::computed_properties::remove_computed_property_inner(&state, &file, 7);
            finished.store(true, Ordering::SeqCst);
            r
        })
    };
    // The remove mints its effect (dirtying the file) right before it takes the
    // store; after that it reaches `column_widths` and blocks there.
    assert!(wait_until(2_000, || file.is_dirty()), "the remove never started");
    std::thread::sleep(std::time::Duration::from_millis(250));
    assert!(
        !finished.load(Ordering::SeqCst),
        "PRECONDITION: the remove completed while `column_widths` was held, so it is not blocked on it"
    );

    let free = probe_can_take_computed_stores(&state, 1_500);
    drop(widths); // released BEFORE asserting, so a failure never leaves the remove hung
    let result = handle.join().expect("the remove thread panicked");
    assert!(
        free,
        "DEADLOCK: remove_computed_property holds `computed_properties` / the dependency maps while \
         it waits for `column_widths`, so a sheet move/copy/delete holding `column_widths` can never \
         take them in `remap_sheet_keyed_stores`"
    );
    assert!(result.success);
    assert!(
        result.dimension_changes.iter().any(|d| d.index == 2 && d.dimension_type == "column"),
        "the width property's removal still reverts its column"
    );
}

// ---------------------------------------------------------------------------
// Move and copy keep every sheet's kind with its sheet
// ---------------------------------------------------------------------------

#[test]
fn moving_a_sheet_across_a_canvas_moves_the_kind_with_the_sheet() {
    let wb = Workbook::new(2);
    let canvas = add_canvas(&wb).active_index;
    assert_eq!(canvas, 2);
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    crate::sheets::move_sheet_impl(&wb.state, &wb.file, &wb.slicer, &wb.timeline, &wb.filters, canvas, 0)
        .expect("move the canvas to the front");
    let k = kinds(&wb);
    assert!(k[0].is_canvas(), "the canvas kind moved with the canvas");
    assert!(k[1].is_worksheet() && k[2].is_worksheet(), "the worksheets it passed stay worksheets");
    assert_eq!(wb.state.sheet_names.read().unwrap()[0], canvas_name);

    crate::sheets::move_sheet_impl(&wb.state, &wb.file, &wb.slicer, &wb.timeline, &wb.filters, 1, 0)
        .expect("move a worksheet across the canvas");
    let k = kinds(&wb);
    assert!(k[0].is_worksheet() && k[1].is_canvas() && k[2].is_worksheet());
}

#[test]
fn copying_a_worksheet_before_a_canvas_keeps_the_canvas_a_canvas() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    assert_eq!(canvas, 1);
    crate::sheets::copy_sheet_impl(&wb.state, &wb.file, &wb.slicer, &wb.timeline, &wb.filters, 0, None)
        .expect("copy the worksheet");
    let k = kinds(&wb);
    assert_eq!(k.len(), 3);
    assert!(k[0].is_worksheet() && k[1].is_worksheet(), "the copy of a worksheet is a worksheet");
    assert!(k[2].is_canvas(), "the canvas after the inserted copy kept its kind");
}

#[test]
fn copying_a_canvas_is_refused_and_leaves_the_document_clean() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    crate::document_effect::mark_saved(&wb.file);
    let result =
        crate::sheets::copy_sheet_impl(&wb.state, &wb.file, &wb.slicer, &wb.timeline, &wb.filters, canvas, None);
    assert_refused_as_canvas(result.map(|_| ()), "copy_sheet");
    assert_eq!(kinds(&wb).len(), 2, "no sheet was added");
    assert!(!wb.file.is_dirty(), "a refusal must not dirty the document");
}

// ---------------------------------------------------------------------------
// The MCP / AI canvas inventory
// ---------------------------------------------------------------------------

#[test]
fn the_canvas_inventory_lists_visible_user_canvases_only() {
    let names: Vec<String> = ["Data", "Dashboard", "__fr_backing", "Old"].iter().map(|s| s.to_string()).collect();
    let visibility = vec![
        "visible".to_string(),
        "visible".to_string(),
        crate::sheets::OBJECT_SHEET_VISIBILITY.to_string(),
        "hidden".to_string(),
    ];
    let kinds = vec![
        SheetKind::Worksheet,
        SheetKind::new_canvas(),
        SheetKind::new_canvas(),
        SheetKind::Canvas(CanvasLayout { grid_size_px: 8, ..CanvasLayout::default() }),
    ];
    let section = crate::mcp::tools::format_canvas_inventory(&names, &visibility, &kinds).expect("a section");
    assert!(section.contains("## Canvases"));
    assert!(section.contains("index=1 name=\"Dashboard\" page=1280x720px snap=on grid=16px"), "{section}");
    assert!(section.contains("index=3 name=\"Old\""), "a hidden canvas is still the user's sheet: {section}");
    assert!(!section.contains("__fr_backing"), "an object sheet is never listed: {section}");
    assert!(!section.contains("\"Data\""), "a worksheet is not a canvas: {section}");

    let no_canvas = vec![SheetKind::Worksheet; 4];
    assert!(
        crate::mcp::tools::format_canvas_inventory(&names, &visibility, &no_canvas).is_none(),
        "no canvas, no section: ordinary summaries are unchanged"
    );
}

// ---------------------------------------------------------------------------
// 4. The layout command
// ---------------------------------------------------------------------------

#[test]
fn set_canvas_layout_applies_a_patch_and_refuses_worksheets_and_bad_values_cleanly() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    crate::document_effect::mark_saved(&wb.file);

    let patch = crate::api_types::CanvasLayoutPatch {
        grid_size_px: Some(25),
        snap_to_grid: Some(false),
        page_preset: Some("4:3".to_string()),
        ..Default::default()
    };
    let changed = crate::sheets::set_canvas_layout_inner(&wb.state, &wb.file, Some(canvas), &patch)
        .expect("a valid patch applies");
    assert_eq!(changed.sheet_index, canvas);
    assert_eq!(changed.layout.grid_size_px, 25);
    assert!(!changed.layout.snap_to_grid);
    assert_eq!((changed.layout.page_width, changed.layout.page_height), (960, 720));
    assert_eq!(kinds(&wb)[canvas], SheetKind::Canvas(changed.layout.clone()));
    assert!(wb.file.is_dirty(), "a layout change is a document change");

    // An explicit size that is not the preset's switches to custom.
    let changed = crate::sheets::set_canvas_layout_inner(
        &wb.state,
        &wb.file,
        Some(canvas),
        &crate::api_types::CanvasLayoutPatch { page_width: Some(1000), ..Default::default() },
    )
    .unwrap();
    assert_eq!(changed.layout.page_preset, persistence::CANVAS_CUSTOM_PAGE_PRESET);

    crate::document_effect::mark_saved(&wb.file);
    let before = kinds(&wb);
    let bad = crate::api_types::CanvasLayoutPatch { grid_size_px: Some(1), ..Default::default() };
    assert!(crate::sheets::set_canvas_layout_inner(&wb.state, &wb.file, Some(canvas), &bad).is_err());
    assert!(
        crate::sheets::set_canvas_layout_inner(&wb.state, &wb.file, Some(0), &patch).is_err(),
        "a worksheet has no canvas layout"
    );
    assert_eq!(kinds(&wb), before, "a refused patch changes nothing");
    assert!(!wb.file.is_dirty(), "a refused patch leaves the document clean");
}

/// M8 hygiene: `zOrder` / `locked` used to be stored VERBATIM. An edit now
/// trims and dedupes them (first occurrence wins -- it is the one that
/// paints; `locked` is a set) and refuses an over-cap list or a blank ref,
/// before the effect.
#[test]
fn set_canvas_layout_dedupes_the_ref_lists_and_refuses_bad_ones_cleanly() {
    use persistence::{CanvasObjectRef, CANVAS_MAX_OBJECT_REFS};
    let obj = |kind: &str, id: &str| CanvasObjectRef { kind: kind.to_string(), id: id.to_string() };
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;

    let patch = crate::api_types::CanvasLayoutPatch {
        z_order: Some(vec![obj("chart", "1"), obj("slicer", "2"), obj(" chart", "1 "), obj("pivot", "3")]),
        locked: Some(vec![obj("slicer", "2"), obj("slicer", "2")]),
        ..Default::default()
    };
    let changed = crate::sheets::set_canvas_layout_inner(&wb.state, &wb.file, Some(canvas), &patch)
        .expect("duplicates are normalized, not refused");
    assert_eq!(changed.layout.z_order, vec![obj("chart", "1"), obj("slicer", "2"), obj("pivot", "3")]);
    assert_eq!(changed.layout.locked, vec![obj("slicer", "2")]);

    crate::document_effect::mark_saved(&wb.file);
    let before = kinds(&wb);
    let over_cap = (0..=CANVAS_MAX_OBJECT_REFS).map(|i| obj("chart", &i.to_string())).collect();
    for (label, bad) in [
        ("an over-cap zOrder", crate::api_types::CanvasLayoutPatch { z_order: Some(over_cap), ..Default::default() }),
        ("a blank ref", crate::api_types::CanvasLayoutPatch { locked: Some(vec![obj("chart", " ")]), ..Default::default() }),
    ] {
        assert!(
            crate::sheets::set_canvas_layout_inner(&wb.state, &wb.file, Some(canvas), &bad).is_err(),
            "{label} must be refused"
        );
    }
    assert_eq!(kinds(&wb), before, "a refused patch changes nothing");
    assert!(!wb.file.is_dirty(), "a refused patch leaves the document clean");
}

// ---------------------------------------------------------------------------
// 5. Wiring census: the doors no shared helper fronts
// ---------------------------------------------------------------------------

/// The body of the top-level function whose signature starts with `needle`,
/// up to its closing brace at column 0, with `//` comments stripped so a
/// COMMENT naming the gate cannot satisfy the census.
fn body_of(src: &str, needle: &str) -> String {
    // Line endings normalised first: a door file saved with CRLF would
    // otherwise never match the column-0 terminator below.
    let src = src.replace("\r\n", "\n");
    let start = src
        .find(needle)
        .unwrap_or_else(|| panic!("no longer defines `{needle}`"));
    let rest = &src[start..];
    // LOUD when the end cannot be found: silently widening to end-of-file
    // would let a gate in a LATER function satisfy this one.
    let end = rest
        .find("\n}\n")
        .map(|e| e + 2)
        .unwrap_or_else(|| panic!("`{needle}`: no column-0 closing brace -- the census cannot bound the body"));
    rest[..end]
        .lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `gate` must appear in the body, and -- when `before` is given -- BEFORE
/// the first occurrence of `before` (the early return that would skip it, or
/// the effect that would dirty the document on a refusal).
fn assert_gated(src: &str, file: &str, needle: &str, gate: &str, before: Option<&str>) {
    let body = body_of(src, needle);
    let at = body
        .find(gate)
        .unwrap_or_else(|| panic!("{file} `{needle}` no longer calls `{gate}` -- a canvas write door is open"));
    if let Some(marker) = before {
        let m = body
            .find(marker)
            .unwrap_or_else(|| panic!("{file} `{needle}`: test out of date, `{marker}` not found"));
        assert!(
            at < m,
            "{file} `{needle}`: `{gate}` must run BEFORE `{marker}`, or it is skipped (early return) \
             or dirties the document on a refusal (effect)"
        );
    }
}

#[test]
fn every_canvas_write_door_is_wired_and_ordered() {
    const PROTECTION: &str = include_str!("../protection.rs");
    const SHEETS: &str = include_str!("../sheets.rs");
    const REPORT: &str = include_str!("../report.rs");
    const PIVOT: &str = include_str!("../pivot/commands.rs");
    const PIVOT_OPS: &str = include_str!("../pivot/operations.rs");
    const TABLES: &str = include_str!("../tables.rs");
    const MCP_TOOLS: &str = include_str!("../mcp/tools.rs");
    const SCRIPTING: &str = include_str!("../scripting/commands.rs");
    const SEARCH: &str = include_str!("search.rs");
    const CONSOLIDATE: &str = include_str!("../consolidate.rs");
    const COMPUTED: &str = include_str!("../computed_properties.rs");
    const SCENARIOS: &str = include_str!("../scenario_manager.rs");
    const ANIMATION: &str = include_str!("../animation_commands.rs");
    const SOLVER: &str = include_str!("../solver.rs");
    const BI: &str = include_str!("../bi/commands.rs");
    const NOTEBOOK: &str = include_str!("../scripting/notebook_commands.rs");
    const CALP: &str = include_str!("../calp_commands.rs");
    const EFFECT: &str = "DocumentEffect::mutates";

    let doors: &[(&str, &str, &str, &str, Option<&str>)] = &[
        (PROTECTION, "protection.rs", "pub(crate) fn check_sheet_protection_cells<", "ensure_not_canvas_in_state", Some("if !protected")),
        (PROTECTION, "protection.rs", "pub(crate) fn check_sheet_protection_range(", "ensure_not_canvas_in_state", Some("if !protected")),
        (PROTECTION, "protection.rs", "pub(crate) fn check_sheet_protection_cells_in<", "ensure_not_canvas(", Some("_ => return Ok(())")),
        (PROTECTION, "protection.rs", "pub(crate) fn check_sheet_protection_range_in(", "ensure_not_canvas(", Some("_ => return Ok(())")),
        (PROTECTION, "protection.rs", "pub(crate) fn check_sheet_action(", "ensure_not_canvas_in_state", Some("let protection_storage")),
        (SHEETS, "sheets.rs", "pub(crate) fn set_freeze_panes_impl(", "ensure_not_canvas_in_state", Some(EFFECT)),
        (SHEETS, "sheets.rs", "pub fn set_split_window(", "ensure_not_canvas_in_state", Some(EFFECT)),
        (SHEETS, "sheets.rs", "pub(crate) fn copy_sheet_impl(", "is_canvas_sheet", Some(EFFECT)),
        (REPORT, "report.rs", "pub async fn create_report(", "ensure_not_canvas_in_state", Some(EFFECT)),
        (REPORT, "report.rs", "pub fn restore_report(", "ensure_not_canvas_in_state", Some(EFFECT)),
        (PIVOT, "pivot/commands.rs", "pub(crate) fn create_pivot_core(", "ensure_not_canvas_in_state", Some(EFFECT)),
        (PIVOT, "pivot/commands.rs", "pub async fn create_pivot_from_bi_model(", "ensure_not_canvas_in_state", Some(EFFECT)),
        // M6: the CANVAS half of both create doors -- the frame is required and
        // the anchor allocated before the effect; the grid door also refuses a
        // view wider than its block before anything is written.
        (PIVOT, "pivot/commands.rs", "pub(crate) fn create_pivot_core(", "canvas_create_frame(", Some(EFFECT)),
        (PIVOT, "pivot/commands.rs", "pub(crate) fn create_pivot_core(", "allocate_canvas_pivot_anchor(", Some(EFFECT)),
        (PIVOT, "pivot/commands.rs", "pub(crate) fn create_pivot_core(", "ensure_canvas_pivot_fits_block(", Some(EFFECT)),
        (PIVOT, "pivot/commands.rs", "pub async fn create_pivot_from_bi_model(", "canvas_create_frame(", Some(EFFECT)),
        (PIVOT, "pivot/commands.rs", "pub async fn create_pivot_from_bi_model(", "allocate_canvas_pivot_anchor(", Some(EFFECT)),
        (PIVOT_OPS, "pivot/operations.rs", "pub(crate) fn update_pivot_in_grid(", "ensure_not_canvas_in_state", Some("state.grid.write")),
        (PIVOT_OPS, "pivot/operations.rs", "pub(crate) fn update_pivot_in_grid(", "ensure_canvas_destination(", Some("state.grid.write")),
        (PIVOT_OPS, "pivot/operations.rs", "pub(crate) fn update_pivot_in_grid(", "ensure_canvas_pivot_fits_block(", Some("state.grid.write")),
        (PIVOT_OPS, "pivot/operations.rs", "pub(crate) fn ensure_pivot_destination_writable(", "ensure_not_canvas_in_state", None),
        (PIVOT_OPS, "pivot/operations.rs", "pub(crate) fn ensure_pivot_destination_writable(", "ensure_canvas_destination(", None),
        // The two refusal-first helpers every grid-writing pivot command mints
        // its effect through: the kind refusal comes before the effect.
        (PIVOT, "pivot/commands.rs", "fn pivot_write<", "ensure_pivot_destination_writable", Some(EFFECT)),
        (PIVOT, "pivot/commands.rs", "fn pivot_mutation_token(", "ensure_pivot_destination_writable", Some(EFFECT)),
        // A canvas pivot's anchor is the allocator's: relocating it is refused
        // before the token that mints the effect; its BOX is moved through
        // update_pivot_properties, whose frame refusals also precede the effect.
        (PIVOT, "pivot/commands.rs", "pub fn relocate_pivot(", "ensure_pivot_not_framed(", Some("pivot_mutation_token(")),
        (PIVOT, "pivot/commands.rs", "pub(crate) fn update_pivot_properties_core(", "frame.validate()", Some("pivot_write_definition_only(")),
        // The pull materializer writes through `write_pivot_to_grid` directly:
        // the kinds are snapshotted before `grids`, and checked before the write.
        (CALP, "calp_commands.rs", "pub(crate) fn restore_pulled_pivots(", "state.sheet_kinds.read", Some("state.grids.write")),
        (CALP, "calp_commands.rs", "pub(crate) fn restore_pulled_pivots(", "is_canvas_sheet", Some("write_pivot_to_grid(")),
        (CALP, "calp_commands.rs", "pub(crate) fn apply_refreshed_pivots(", "is_canvas_sheet", Some("update_pivot_in_grid(")),
        (TABLES, "tables.rs", "pub fn create_table(", "ensure_not_canvas_in_state", Some(EFFECT)),
        (MCP_TOOLS, "mcp/tools.rs", "pub fn apply_cell_formatting(", "ensure_not_canvas_in_state", Some(EFFECT)),
        (SCRIPTING, "scripting/commands.rs", "pub(crate) fn apply_script_modified_grids_core(", "&sheet_kinds", None),
        (SEARCH, "commands/search.rs", "pub(crate) fn replace_all_off_sheet(", "&sheet_kinds", None),
        (SEARCH, "commands/search.rs", "pub fn replace_all(", "&sheet_kinds", None),
        (SEARCH, "commands/search.rs", "pub(crate) fn replace_single_off_sheet(", "&sheet_kinds", None),
        (SEARCH, "commands/search.rs", "pub fn replace_single(", "&sheet_kinds", None),
        (CONSOLIDATE, "consolidate.rs", "fn consolidate_data_inner(", "&sheet_kinds", None),
        // The writers the M1 grid-writer classification found with no door.
        (COMPUTED, "computed_properties.rs", "pub fn add_computed_property(", "is_canvas_sheet", Some(EFFECT)),
        (COMPUTED, "computed_properties.rs", "pub fn update_computed_property(", "is_canvas_sheet", Some(EFFECT)),
        (SCENARIOS, "scenario_manager.rs", "pub fn scenario_show(", "ensure_not_canvas_in_state", Some(EFFECT)),
        (SCENARIOS, "scenario_manager.rs", "pub fn scenario_summary(", "ensure_not_canvas_in_state", Some(EFFECT)),
        (SCENARIOS, "scenario_manager.rs", "pub fn scenario_merge(", "check_sheet_action", Some(EFFECT)),
        (ANIMATION, "animation_commands.rs", "pub(crate) fn anim_snapshot_inner(", "ensure_not_canvas_in_state", Some("state.grids.read")),
        // The restore is gated on the SNAPSHOT's sheet before the snapshot is
        // taken out of the registry (`let saved =` is the take).
        (ANIMATION, "animation_commands.rs", "pub(crate) fn anim_restore_inner(", "ensure_not_canvas_in_state", Some("let saved =")),
        (ANIMATION, "animation_commands.rs", "pub fn anim_apply_frame(", "ensure_not_canvas_in_state", Some("frame_effect(")),
        (PROTECTION, "protection.rs", "pub fn set_cell_protection(", "ensure_not_canvas_in_state", Some(EFFECT)),
        (SOLVER, "solver.rs", "pub fn solver_revert(", "ensure_not_canvas_in_state", Some(EFFECT)),
        (BI, "bi/commands.rs", "pub async fn bi_refresh_connection(", "is_canvas_sheet", Some(EFFECT)),
        (NOTEBOOK, "scripting/notebook_commands.rs", "async fn notebook_rewind_internal(", "is_canvas_sheet", Some(EFFECT)),
        (CALP, "calp_commands.rs", "pub fn calp_import_overrides(", "is_canvas_sheet", Some(EFFECT)),
    ];
    for (src, file, needle, gate, before) in doors {
        assert_gated(src, file, needle, gate, *before);
    }

    // create_pivot_from_bi_model: the gate must also come AFTER the last
    // `.await`. Checked before the awaits, the destination was re-read from the
    // active sheet afterwards -- check-then-act across a database connect.
    {
        let body = body_of(PIVOT, "pub async fn create_pivot_from_bi_model(");
        let last_await = body.rfind(".await").expect("test out of date: no .await in create_pivot_from_bi_model");
        let gate = body.find("ensure_not_canvas_in_state").unwrap();
        assert!(
            last_await < gate,
            "create_pivot_from_bi_model: the canvas gate runs before an .await, so the destination \
             it checked can change before the pivot is written"
        );
        assert_eq!(
            body.matches("let dest_sheet_idx").count(),
            1,
            "create_pivot_from_bi_model: the destination must be resolved ONCE -- a second \
             resolution is an index the gate never saw"
        );
    }

    // The two UNGATED helpers stay pinned to the one caller each that must be
    // able to reach a pivot stranded on a canvas.
    for (helper, owner) in [
        ("pivot_exists_token(&", "pub fn delete_pivot_table("),
        // Every CALL (`(`), whatever its arguments; the definition is spelled
        // `pivot_write_definition_only<'a>(` and is not counted.
        ("pivot_write_definition_only(", "pub(crate) fn update_pivot_properties_core("),
    ] {
        assert_eq!(PIVOT.matches(helper).count(), 1, "pivot/commands.rs: `{helper}` must have exactly one caller");
        assert!(body_of(PIVOT, owner).contains(helper), "pivot/commands.rs: `{helper}` belongs to `{owner}`");
    }

    // The resolver never re-aims: no kind or visibility read (the redirect that
    // wrote over the first worksheet, and the `sheet_visibility` read that
    // inverted `delete_sheet_impl`'s lock order under `pivot_tables`).
    let resolver = body_of(PIVOT_OPS, "pub(crate) fn resolve_dest_sheet_index(");
    for forbidden in ["sheet_kinds", "sheet_visibility", "is_canvas_sheet", "is_user_sheet"] {
        assert!(
            !resolver.contains(forbidden),
            "resolve_dest_sheet_index reads `{forbidden}` again: it must not redirect a pivot, and it \
             runs under `pivot_tables`"
        );
    }

    // A rename carries the pivot definitions -- after the sheet guards drop.
    let rename = body_of(SHEETS, "pub(crate) fn rename_sheet_inner(");
    let dropped = rename.find("drop(sheet_names);").expect("test out of date: rename no longer drops sheet_names");
    let carried = rename
        .find("rename_pivot_sheet_references(")
        .expect("rename_sheet_inner no longer carries the pivot definitions' sheet names");
    assert!(dropped < carried, "rename_sheet_inner takes `pivot_tables` while still holding its sheet guards");

    // A body with TWO doors must gate both: `find` sees only the first, so the
    // position-mode consolidation could lose its gate unseen.
    let consolidate = body_of(CONSOLIDATE, "fn consolidate_data_inner(");
    let doors = consolidate.matches("check_sheet_protection_range_in(").count();
    let gated = consolidate.matches("&sheet_kinds").count();
    assert_eq!(doors, 2, "consolidate.rs: test out of date, expected the category and position doors");
    assert!(
        gated >= doors,
        "consolidate.rs: {doors} protection doors but only {gated} pass &sheet_kinds -- one mode writes into a canvas"
    );
}

/// Every `let <guard> = ...protected_regions.lock()` binding followed, within
/// the next three code lines, by a `pivot_tables` acquisition: the order
/// `protected_regions` -> `pivot_tables`. Comments are stripped first.
fn regions_before_pivot_tables(src: &str) -> Vec<String> {
    let lines: Vec<String> = src
        .replace("\r\n", "\n")
        .lines()
        .map(|l| match l.find("//") {
            Some(i) => l[..i].to_string(),
            None => l.to_string(),
        })
        .collect();
    let mut hits = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !(line.trim_start().starts_with("let ") && line.contains("protected_regions.lock()")) {
            continue;
        }
        let window = lines.iter().skip(i + 1).filter(|l| !l.trim().is_empty()).take(3);
        for next in window {
            if next.contains("pivot_tables.read()") || next.contains("pivot_tables.write(") {
                hits.push(format!("line {}: {}", i + 1, line.trim()));
            }
        }
    }
    hits
}

/// backend-locks-effects #6's other half. The resolver reads the pivot's
/// region UNDER `pivot_tables` (its callers hold it), and `delete_pivot_table`
/// and the undo delete take `pivot_tables` -> `protected_regions` too. The four
/// structural row/column shifts and `get_pivot_regions_for_sheet` took the pair
/// the other way round; they now take `pivot_tables` first. This keeps any
/// holder from turning it back.
#[test]
fn protected_regions_is_never_held_while_pivot_tables_is_taken() {
    const SOURCES: [(&str, &str); 8] = [
        ("commands/structure.rs", include_str!("structure.rs")),
        ("pivot/commands.rs", include_str!("../pivot/commands.rs")),
        ("pivot/operations.rs", include_str!("../pivot/operations.rs")),
        ("undo_commands.rs", include_str!("../undo_commands.rs")),
        ("sheets.rs", include_str!("../sheets.rs")),
        ("calp_commands.rs", include_str!("../calp_commands.rs")),
        ("report.rs", include_str!("../report.rs")),
        ("bi/commands.rs", include_str!("../bi/commands.rs")),
    ];
    let mut all = Vec::new();
    for (file, src) in SOURCES {
        for hit in regions_before_pivot_tables(src) {
            all.push(format!("{file} {hit}"));
        }
    }
    assert!(
        all.is_empty(),
        "`protected_regions` held while `pivot_tables` is taken -- the reverse of the crate's order, \
         a deadlock against every pivot command that resolves its destination:\n{}",
        all.join("\n")
    );

    // Non-vacuity: the detector fires on the shape it forbids, and not on the fix.
    let inverted = "fn f() {\n    let mut regions = state.protected_regions.lock().unwrap();\n    let mut pivot_tables = pivot_state.pivot_tables.write(effect).unwrap();\n}\n";
    assert_eq!(regions_before_pivot_tables(inverted).len(), 1);
    let fixed = "fn f() {\n    let mut pivot_tables = pivot_state.pivot_tables.write(effect).unwrap();\n    let mut regions = state.protected_regions.lock().unwrap();\n}\n";
    assert!(regions_before_pivot_tables(fixed).is_empty());
}

/// The census above has teeth: a body where the gate comes AFTER the early
/// return, or appears only in a comment, is reported.
#[test]
fn the_wiring_census_detects_a_misordered_or_commented_gate() {
    const MISORDERED: &str = "pub(crate) fn door(x: u8) -> Result<(), String> {\n    if !protected {\n        return Ok(());\n    }\n    ensure_not_canvas_in_state(state, i, \"edit\")?;\n    Ok(())\n}\n";
    let r = std::panic::catch_unwind(|| {
        assert_gated(MISORDERED, "t.rs", "pub(crate) fn door(", "ensure_not_canvas_in_state", Some("if !protected"))
    });
    assert!(r.is_err(), "a gate after the early return must be reported");

    const COMMENTED: &str = "pub fn door() {\n    // ensure_not_canvas_in_state(state, i, \"edit\")?;\n    write_cells();\n}\n";
    let r = std::panic::catch_unwind(|| {
        assert_gated(COMMENTED, "t.rs", "pub fn door(", "ensure_not_canvas_in_state", None)
    });
    assert!(r.is_err(), "a gate that exists only in a comment must be reported");

    const WIRED: &str = "pub fn door() {\n    ensure_not_canvas_in_state(state, i, \"edit\")?;\n    let effect = DocumentEffect::mutates(&f);\n}\n";
    assert_gated(WIRED, "t.rs", "pub fn door(", "ensure_not_canvas_in_state", Some("DocumentEffect::mutates"));

    // CRLF: the body is still bounded at its own closing brace, so a gate in
    // the NEXT function cannot satisfy this one.
    const CRLF: &str = "pub fn door() {\r\n    write_cells();\r\n}\r\npub fn other() {\r\n    ensure_not_canvas_in_state(s, i, \"x\")?;\r\n}\r\n";
    let r = std::panic::catch_unwind(|| {
        assert_gated(CRLF, "t.rs", "pub fn door(", "ensure_not_canvas_in_state", None)
    });
    assert!(r.is_err(), "a CRLF body must be bounded at its own brace, not widened to end-of-file");

    // No terminator at all: loud, never a silent widening.
    let r = std::panic::catch_unwind(|| body_of("pub fn door() {\n    x();", "pub fn door("));
    assert!(r.is_err(), "an unbounded body must panic");
}
