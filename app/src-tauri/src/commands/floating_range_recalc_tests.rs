//! FILENAME: app/src-tauri/src/commands/floating_range_recalc_tests.rs
//! PURPOSE: Floating Range RECALCULATION (M3) — the feature's heart: cells in
//!          a floating range behave exactly like grid cells, in all three
//!          reference directions, through the REAL edit paths.
//!
//! Reuses the `cross_sheet_recalc_tests::Workbook` harness. The write door for
//! FR cells is `update_floating_range_cell_inner` → `update_cell_on_sheets_inner`
//! (the off-sheet path), which now registers cross-sheet edges (GAP A) and
//! whose recalc pass visits every object-backed sheet (they can never heal by
//! being visited — a backing sheet is never active).

use super::cross_sheet_recalc_tests::Workbook;
use engine::CellValue;

fn create(wb: &Workbook, name: &str) -> crate::api_types::FloatingRangeInfo {
    crate::floating_range::create_floating_range_inner(
        &wb.state,
        &wb.file,
        Some(name.to_string()),
        0.0,
        0.0,
    )
    .expect("create floating range")
}

fn grow(wb: &Workbook, id: identity::EntityId, rows: u32, cols: u32) {
    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        id,
        crate::api_types::FloatingRangePatch {
            x: None,
            y: None,
            row_count: Some(rows),
            col_count: Some(cols),
        },
    )
    .expect("grow window");
}

fn set_fr(wb: &Workbook, id: identity::EntityId, row: u32, col: u32, value: &str) {
    crate::floating_range::update_floating_range_cell_inner(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        id,
        row,
        col,
        value.to_string(),
        None,
    )
    .unwrap_or_else(|e| panic!("update_floating_range_cell({row},{col}) failed: {e}"));
}

fn number(wb: &Workbook, sheet: usize, row: u32, col: u32) -> f64 {
    match wb.value(sheet, row, col) {
        CellValue::Number(n) => n,
        other => panic!("expected a number at sheet {sheet} ({row},{col}), got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// float → grid: an FR formula reads the grid and FOLLOWS it
// ---------------------------------------------------------------------------

#[test]
fn a_floating_range_formula_follows_its_grid_precedent() {
    let wb = Workbook::new(1);
    let info = create(&wb, "Float1");
    wb.set(0, 0, "5"); // Sheet1!A1 = 5

    set_fr(&wb, info.range.id, 0, 0, "=Sheet1!A1*2");
    assert_eq!(number(&wb, info.backing_sheet_index, 0, 0), 10.0);

    // THE test: editing the precedent through the ordinary grid edit path
    // must reach the floating range through the name-keyed cascade — the
    // edge GAP A registers.
    wb.set(0, 0, "7");
    assert_eq!(
        number(&wb, info.backing_sheet_index, 0, 0),
        14.0,
        "the floating range went stale when its grid precedent changed — \
         the off-sheet write path registered no cross-sheet edge (GAP A)"
    );
}

// ---------------------------------------------------------------------------
// grid → float: a grid formula reads the FR and FOLLOWS it
// ---------------------------------------------------------------------------

#[test]
fn a_grid_formula_follows_its_floating_range_precedent() {
    let wb = Workbook::new(1);
    let info = create(&wb, "Float1");
    set_fr(&wb, info.range.id, 0, 0, "3");

    wb.set(0, 1, "=Float1!A1+1"); // Sheet1!B1
    assert_eq!(number(&wb, 0, 0, 1), 4.0);

    set_fr(&wb, info.range.id, 0, 0, "10");
    assert_eq!(
        number(&wb, 0, 0, 1),
        11.0,
        "the grid formula went stale when the floating range cell changed"
    );
}

// ---------------------------------------------------------------------------
// float → float
// ---------------------------------------------------------------------------

#[test]
fn a_floating_range_formula_follows_another_floating_range() {
    let wb = Workbook::new(1);
    let a = create(&wb, "Float1");
    let b = create(&wb, "Float2");
    set_fr(&wb, a.range.id, 0, 0, "2");
    set_fr(&wb, b.range.id, 0, 0, "=Float1!A1*3");
    assert_eq!(number(&wb, b.backing_sheet_index, 0, 0), 6.0);

    set_fr(&wb, a.range.id, 0, 0, "5");
    assert_eq!(
        number(&wb, b.backing_sheet_index, 0, 0),
        15.0,
        "float→float propagation failed — the off-sheet recalc pass must \
         visit every object-backed sheet"
    );
}

// ---------------------------------------------------------------------------
// second-order chain: grid → float → grid
// ---------------------------------------------------------------------------

#[test]
fn a_chain_through_a_floating_range_propagates_end_to_end() {
    let wb = Workbook::new(1);
    let info = create(&wb, "Float1");
    wb.set(0, 0, "4"); // A1
    set_fr(&wb, info.range.id, 0, 0, "=Sheet1!A1*10"); // Float1!A1 = 40
    wb.set(0, 2, "=Float1!A1+2"); // C1 = 42
    assert_eq!(number(&wb, 0, 0, 2), 42.0);

    wb.set(0, 0, "6"); // A1 = 6 → Float1!A1 = 60 → C1 = 62
    assert_eq!(number(&wb, info.backing_sheet_index, 0, 0), 60.0);
    assert_eq!(
        number(&wb, 0, 0, 2),
        62.0,
        "the second hop (float back into the grid) went stale"
    );
}

// ---------------------------------------------------------------------------
// The window is a write gate, not an address-space cap
// ---------------------------------------------------------------------------

#[test]
fn writes_outside_the_window_are_refused_but_cells_beyond_it_still_feed_formulas() {
    let wb = Workbook::new(1);
    let info = create(&wb, "Float1");

    crate::floating_range::update_floating_range_cell_inner(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters,
        info.range.id, 1, 0, "1".to_string(), None,
    )
    .expect_err("row 1 is outside a 1x1 window");

    // Grow, write B2, shrink back — the cell stays real and feeds formulas.
    grow(&wb, info.range.id, 2, 2);
    set_fr(&wb, info.range.id, 1, 1, "9");
    grow(&wb, info.range.id, 1, 1);
    wb.set(0, 0, "=Float1!B2");
    assert_eq!(
        number(&wb, 0, 0, 0),
        9.0,
        "shrinking the window must hide, never delete"
    );
}

// ---------------------------------------------------------------------------
// Edges survive the add_sheet partition rotation — LIVE version
// ---------------------------------------------------------------------------

#[test]
fn edges_survive_a_user_sheet_added_after_the_floating_range() {
    let wb = Workbook::new(1);
    let info = create(&wb, "Float1");
    wb.set(0, 0, "5");
    set_fr(&wb, info.range.id, 0, 0, "=Sheet1!A1*2");
    assert_eq!(number(&wb, info.backing_sheet_index, 0, 0), 10.0);

    // add_sheet rotates the object sheet to the tail and re-keys its edges.
    crate::sheets::add_sheet_inner(&wb.state, &wb.file, None).expect("add sheet");
    let new_backing =
        crate::floating_range::list_floating_ranges_inner(&wb.state)[0].backing_sheet_index;
    assert_eq!(new_backing, 2, "the object sheet rode to the tail");

    // Note: add_sheet ended the undo history but must NOT have broken edges.
    wb.switch_to(0);
    wb.set(0, 0, "8");
    assert_eq!(
        number(&wb, new_backing, 0, 0),
        16.0,
        "the rotation lost the floating range's cross-sheet edges"
    );
}

// ---------------------------------------------------------------------------
// Undo restores INTO the backing sheet, never onto the user's screen
// ---------------------------------------------------------------------------

#[test]
fn undoing_a_floating_range_cell_edit_restores_without_activating_the_backing_sheet() {
    let wb = Workbook::new(1);
    let info = create(&wb, "Float1");
    set_fr(&wb, info.range.id, 0, 0, "3");
    set_fr(&wb, info.range.id, 0, 0, "9");
    assert_eq!(number(&wb, info.backing_sheet_index, 0, 0), 9.0);

    let transaction = wb
        .state
        .undo_stack
        .lock()
        .unwrap()
        .pop_undo()
        .expect("the cell edit recorded an entry");
    let result = crate::undo_commands::apply_changes(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.slicer,
        &wb.filters,
        &wb.pane,
        transaction,
        true,
    );
    assert!(result.success);
    assert_eq!(
        number(&wb, info.backing_sheet_index, 0, 0),
        3.0,
        "the SetCell{{sheet: backing}} replay must land in grids[backing]"
    );
    assert_eq!(
        *wb.state.active_sheet.read().unwrap(),
        0,
        "Excel's switch-to-target must SKIP an object sheet (activation_target \
         treats non-visible as unswitchable) — the user stays where they are"
    );
}

// ---------------------------------------------------------------------------
// GAP B: the load-path installer brings a "present and dead" range to life
// ---------------------------------------------------------------------------

#[test]
fn the_edge_installer_revives_a_loaded_floating_range() {
    let wb = Workbook::new(1);
    let info = create(&wb, "Float1");
    wb.set(0, 0, "5");
    set_fr(&wb, info.range.id, 0, 0, "=Sheet1!A1*2");

    // Simulate a fresh load: the maps are empty (open_file rebuilds them for
    // the ACTIVE sheet only — a backing sheet is never active).
    wb.state.cross_sheet_dependents.lock().unwrap().clear();
    wb.state.cross_sheet_dependencies.lock().unwrap().clear();
    wb.set(0, 0, "6");
    assert_eq!(
        number(&wb, info.backing_sheet_index, 0, 0),
        10.0,
        "precondition: with no edges the range is present and DEAD"
    );

    crate::floating_range::register_object_sheet_edges(&wb.state);

    wb.set(0, 0, "7");
    assert_eq!(
        number(&wb, info.backing_sheet_index, 0, 0),
        14.0,
        "the installer must re-register the backing sheet's edges (GAP B / §2z)"
    );
}

// ---------------------------------------------------------------------------
// BUG-0058: a dependent on a NON-ACTIVE user sheet must follow an FR write
// ---------------------------------------------------------------------------

/// Found by the first mixed floating+sheet soak walk (seed 90140202,
/// `tests/regression/repros/BUG-0058.trace.json`, minimized to 17 actions):
/// `recalc_after_off_sheet_write` re-evaluated the WRITTEN sheets, every
/// OBJECT sheet and the ACTIVE sheet -- and no other user sheet. A formula on
/// a sheet the user is not looking at that reads a floating range therefore
/// went stale when a script/UI wrote the FR cell while a THIRD sheet was
/// active; the dependent on the active sheet updated, which is exactly the
/// asymmetry the walk's digest showed (46 stale vs 4 recalculated).
#[test]
fn a_non_active_sheet_dependent_follows_a_floating_range_write() {
    let wb = Workbook::new(3);
    let info = create(&wb, "Float1");
    set_fr(&wb, info.range.id, 0, 0, "42");

    // Sheet1!B1 reads the FR (registered while Sheet1 is active)...
    wb.set(0, 1, "=Float1!A1+4");
    assert_eq!(number(&wb, 0, 0, 1), 46.0);

    // ...and Sheet2!C1 reads Sheet1!B1 (registered while Sheet2 is active),
    // so the repair must extend TRANSITIVELY, not one hop.
    wb.switch_to(1);
    wb.set(0, 2, "=Sheet1!B1*10");
    assert_eq!(number(&wb, 1, 0, 2), 460.0);

    // The user works on Sheet3; the FR cell is rewritten off-sheet.
    wb.switch_to(2);
    set_fr(&wb, info.range.id, 0, 0, "10");

    assert_eq!(
        number(&wb, 0, 0, 1),
        14.0,
        "the NON-ACTIVE sheet's dependent went stale: recalc_after_off_sheet_write \
         never re-evaluates a user sheet that is neither written nor active \
         (BUG-0058)"
    );
    assert_eq!(
        number(&wb, 1, 0, 2),
        140.0,
        "the SECOND-hop dependent (non-active sheet reading another non-active \
         sheet) must follow too -- the dependent-sheet closure is transitive"
    );
}
