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
        &wb.state, &effect, pivot_id, resolved, (3, 3), &one_cell_view(pivot_id),
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

    crate::pivot::operations::update_pivot_in_grid(&wb.state, &effect, pivot_id, 0, (3, 3), &view)
        .expect("positive control: a worksheet destination is written");
    assert!(cell_count(&wb, 0) > 0, "positive control: the view writes into a worksheet");

    assert_refused_as_canvas(
        crate::pivot::operations::update_pivot_in_grid(&wb.state, &effect, pivot_id, canvas, (3, 3), &view),
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
/// a canvas refuses with the document still clean. (The two helpers are private
/// to the command module; the census below pins that they call this first.)
#[test]
fn a_pivot_command_aimed_at_a_canvas_is_refused_before_its_effect() {
    let wb = Workbook::new(1);
    let canvas = add_canvas(&wb).active_index;
    let canvas_name = wb.state.sheet_names.read().unwrap()[canvas].clone();
    let seed = crate::document_effect::test_seed_effect();
    let (on_canvas, on_sheet) = (new_pivot_id(), new_pivot_id());
    {
        let mut tables = wb.pivots.pivot_tables.write(&seed).unwrap();
        for (id, dest) in [(on_canvas, canvas_name.as_str()), (on_sheet, "Sheet1")] {
            let mut d = pivot_engine::PivotDefinition::new(id, (0, 0), (0, 0));
            d.destination_sheet = Some(dest.to_string());
            tables.insert(id, (d, pivot_engine::PivotCache::new(id, 0)));
        }
    }
    assert_refused_as_canvas(
        crate::pivot::operations::ensure_pivot_destination_is_grid(&wb.state, &wb.pivots, on_canvas),
        "ensure_pivot_destination_is_grid",
    );
    crate::pivot::operations::ensure_pivot_destination_is_grid(&wb.state, &wb.pivots, on_sheet)
        .expect("a worksheet destination passes");
    crate::pivot::operations::ensure_pivot_destination_is_grid(&wb.state, &wb.pivots, new_pivot_id())
        .expect("an unknown pivot is the existence check's refusal, not this one's");
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
        0,
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
        &std::collections::HashMap::new(),
        &std::collections::HashSet::new(),
        None,
    );
    let tables = wb.pivots.pivot_tables.read().unwrap();
    assert!(tables.contains_key(&to_sheet), "positive control: the worksheet pivot is adopted");
    assert!(!tables.contains_key(&to_canvas), "the canvas pivot is skipped");
    assert!(crate::pivot::operations::get_pivot_region(&wb.state, to_canvas).is_none());
    assert_eq!(cell_count(&wb, canvas), 0);
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
        (PIVOT, "pivot/commands.rs", "pub fn create_pivot_inner(", "ensure_not_canvas_in_state", Some(EFFECT)),
        (PIVOT, "pivot/commands.rs", "pub async fn create_pivot_from_bi_model(", "ensure_not_canvas_in_state", Some(EFFECT)),
        (PIVOT_OPS, "pivot/operations.rs", "pub(crate) fn update_pivot_in_grid(", "ensure_not_canvas_in_state", Some("state.grid.write")),
        (PIVOT_OPS, "pivot/operations.rs", "pub(crate) fn ensure_pivot_destination_is_grid(", "ensure_not_canvas_in_state", None),
        // The two refusal-first helpers every grid-writing pivot command mints
        // its effect through: the canvas refusal comes before the effect.
        (PIVOT, "pivot/commands.rs", "fn pivot_write<", "ensure_pivot_destination_is_grid", Some(EFFECT)),
        (PIVOT, "pivot/commands.rs", "fn pivot_mutation_token(", "ensure_pivot_destination_is_grid", Some(EFFECT)),
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
        ("pivot_write_definition_only(&", "pub fn update_pivot_properties("),
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
