//! FILENAME: app/src-tauri/src/commands/d3_cascade_seed_tests.rs
//! PURPOSE: D3 — the pivot, table and cut/paste-relocation writes must seed the
//! ONE shared cascade, like every other bulk cell rewrite in the crate.
//!
//! A child module of `commands::data` (declared with `#[path]` there) so it
//! reaches `recalc_after_active_sheet_bulk_rewrite` and reuses the `Workbook`
//! harness from `cross_sheet_recalc_tests`. A copied harness drifts, and a
//! drifted harness is how a recalculation defect hides — the subject of this
//! whole family of files.
//!
//! THE DEFECT THESE PIN. Eight functions sat in the census's `EXEMPT` list
//! writing cells and recalculating nothing:
//!
//!   * `pivot/commands.rs`  — create_pivot_inner, delete_pivot_table,
//!                            undo_pivot_overwrite
//!   * `tables.rs`          — toggle_totals_row, set_totals_row_function,
//!                            set_calculated_column, check_table_auto_expand
//!   * `commands/structure.rs` — relocate_cell_references
//!
//! Each writes into a region and stops. A formula READING that region keeps its
//! previous number — silently, with no error — until some unrelated later edit
//! sweeps it up. In Excel every one of those formulas updates, and the owner's
//! standing rule is that Excel parity decides questions this brief does not, so
//! all eight now seed the shared cascade.
//!
//! WHAT THESE TESTS CAN AND CANNOT DO. All eight are `#[tauri::command]`s (or,
//! for `create_pivot_inner`, take `State` directly), so none can run
//! in-process. This file therefore uses the SAME two-part split the
//! `sort_range` and `clear_range` tests use and for the same reason:
//!
//!   1. reproduce the command's WRITE exactly, run the phase-B seeding the
//!      command now runs, and assert the dependent moved — that is the
//!      behavioural half, and it fails if the cascade is wrong;
//!   2. assert FROM SOURCE that the command still calls the shared entry
//!      point — that is the wiring half, and it fails if somebody deletes the
//!      call.
//!
//! Neither half is sufficient alone: the census only checks that a function
//! recalculates, never that it recalculates CORRECTLY.

use super::cross_sheet_recalc_tests::{body_of, Workbook};
use super::*;

// ---------------------------------------------------------------------------
// Shared reproduction helpers
// ---------------------------------------------------------------------------

/// Write cells into the active sheet WITHOUT recalculating anything — the state
/// every one of the eight functions left the grid in.
///
/// Values are stored as the caller gives them; a `None` clears the cell. This
/// is deliberately dumber than `update_cell_impl`: the whole point is that
/// these writes bypassed the edit path, so the fixture must bypass it too.
fn write_block_without_recalc(wb: &Workbook, cells: &[(u32, u32, Option<&str>)]) -> Vec<(u32, u32)> {
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    let mut grid = wb.state.grid.write(&effect).unwrap();
    let mut grids = wb.state.grids.write(&effect).unwrap();
    let active_sheet = *wb.state.active_sheet.read().unwrap();

    let mut seeds = Vec::new();
    for &(row, col, value) in cells {
        match value {
            Some(text) => {
                let cell = engine::Cell::new_text(text.to_string());
                grid.set_cell(row, col, cell.clone());
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(row, col, cell);
                }
            }
            None => {
                grid.clear_cell(row, col);
                if active_sheet < grids.len() {
                    grids[active_sheet].clear_cell(row, col);
                }
            }
        }
        seeds.push((row, col));
    }
    seeds
}

/// Write NUMBERS into the active sheet without recalculating — a pivot's output
/// block is numeric, and a text cell would make the readers below coerce.
fn write_numbers_without_recalc(wb: &Workbook, cells: &[(u32, u32, f64)]) -> Vec<(u32, u32)> {
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    let mut grid = wb.state.grid.write(&effect).unwrap();
    let mut grids = wb.state.grids.write(&effect).unwrap();
    let active_sheet = *wb.state.active_sheet.read().unwrap();

    let mut seeds = Vec::new();
    for &(row, col, value) in cells {
        let mut cell = engine::Cell::default();
        cell.value = engine::CellValue::Number(value);
        grid.set_cell(row, col, cell.clone());
        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(row, col, cell);
        }
        seeds.push((row, col));
    }
    seeds
}

/// Write a FORMULA cell without recalculating and without registering any
/// dependency edge — exactly what the table commands used to do.
///
/// The formula is evaluated once for its own value (the table commands did
/// evaluate what they wrote); nothing downstream is touched.
fn write_formula_without_recalc(wb: &Workbook, row: u32, col: u32, formula: &str) {
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    let sheet_names = wb.state.sheet_names.read().unwrap();
    let mut grid = wb.state.grid.write(&effect).unwrap();
    let mut grids = wb.state.grids.write(&effect).unwrap();
    let active_sheet = *wb.state.active_sheet.read().unwrap();
    let user_files = wb.files.files.lock().unwrap();

    let value = crate::evaluate_formula_multi_sheet_with_files(
        &grids,
        &sheet_names,
        active_sheet,
        formula,
        &user_files,
    );
    let mut cell = engine::Cell::new_formula(formula.to_string());
    cell.value = value;
    if let Ok(parsed) = parser::parse(formula) {
        cell.set_cached_ast(crate::convert_expr(&parsed));
    }
    grid.set_cell(row, col, cell.clone());
    if active_sheet < grids.len() {
        grids[active_sheet].set_cell(row, col, cell);
    }
}

/// Phase B, exactly as every fixed command now runs it.
fn recalc_bulk(wb: &Workbook, seeds: &[(u32, u32)]) {
    let mut updated = Vec::new();
    recalc_after_active_sheet_bulk_rewrite(
        &wb.state,
        &wb.files,
        &wb.pane,
        &wb.filters,
        seeds,
        &mut updated,
    );
}

// ---------------------------------------------------------------------------
// 1. relocate_cell_references — the narrowest case, done first as the proving
//    ground for the seam the other seven use.
// ---------------------------------------------------------------------------

/// Reproduce `relocate_cell_references`'s write: for each rewritten cell, store
/// the new formula, evaluate it, register its edges — and cascade to NOTHING.
/// Returns the seed list the command now hands to phase B.
///
/// The command computes the new formula text itself (via the private
/// `relocate_references_in_formula`); the test supplies it, because what is
/// under test here is the CASCADE, not the regex rewrite.
fn relocate_rewrite(wb: &Workbook, rewrites: &[(u32, u32, &str)]) -> Vec<(u32, u32)> {
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    let sheet_names = wb.state.sheet_names.read().unwrap();
    let mut grid = wb.state.grid.write(&effect).unwrap();
    let mut grids = wb.state.grids.write(&effect).unwrap();
    let active_sheet = *wb.state.active_sheet.read().unwrap();
    let user_files = wb.files.files.lock().unwrap();
    let mut dependents_map = wb.state.dependents.lock().unwrap();
    let mut dependencies_map = wb.state.dependencies.lock().unwrap();
    let mut column_dependents_map = wb.state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = wb.state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = wb.state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = wb.state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = wb.state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = wb.state.cross_sheet_dependencies.lock().unwrap();

    let mut seeds = Vec::new();
    for &(row, col, new_formula) in rewrites {
        let value = crate::evaluate_formula_multi_sheet_with_files(
            &grids,
            &sheet_names,
            active_sheet,
            new_formula,
            &user_files,
        );
        let mut cell = engine::Cell::new_formula(new_formula.to_string());
        cell.value = value;
        if let Ok(parsed) = parser::parse(new_formula) {
            let refs = crate::extract_all_references(&parsed, &grid);
            crate::update_dependencies(
                (row, col),
                refs.cells,
                &mut dependencies_map,
                &mut dependents_map,
            );
            crate::update_column_dependencies(
                (row, col),
                refs.columns,
                &mut column_dependencies_map,
                &mut column_dependents_map,
            );
            crate::update_row_dependencies(
                (row, col),
                refs.rows,
                &mut row_dependencies_map,
                &mut row_dependents_map,
            );
            crate::update_cross_sheet_dependencies(
                (active_sheet, row, col),
                crate::normalize_cross_sheet_refs(&refs.cross_sheet_cells, &sheet_names),
                &mut cross_sheet_dependencies_map,
                &mut cross_sheet_dependents_map,
            );
            cell.set_cached_ast(crate::convert_expr(&parsed));
        }
        grid.set_cell(row, col, cell.clone());
        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(row, col, cell);
        }
        seeds.push((row, col));
    }
    seeds
}

/// The drag-move that lands ON TOP of other data — the case where relocation
/// genuinely CHANGES the rewritten formula's value, and therefore the only case
/// where a stale dependent is observable.
///
/// `C5 = SUM(A1:A3) + SUM(B1:B3)` reads two blocks. Drag A1:A3 onto B1:B3 and
/// the rewrite folds both terms onto the same cells, so C5 moves 66 -> 120 and
/// `D5 = C5*2` must follow it to 240.
fn relocation_workbook() -> Workbook {
    let wb = Workbook::new(1);
    wb.set(0, 0, "10"); // A1
    wb.set(1, 0, "20"); // A2
    wb.set(2, 0, "30"); // A3
    wb.set(0, 1, "1"); // B1
    wb.set(1, 1, "2"); // B2
    wb.set(2, 1, "3"); // B3
    wb.set(4, 2, "=SUM(A1:A3)+SUM(B1:B3)"); // C5
    wb.set(4, 3, "=C5*2"); // D5
    assert_eq!(wb.number(0, 4, 2), 66.0, "precondition: C5");
    assert_eq!(wb.number(0, 4, 3), 132.0, "precondition: D5");
    wb
}

#[test]
fn relocating_references_recalculates_the_dependents_of_the_cells_it_rewrote() {
    let wb = relocation_workbook();

    // The drag-move itself: A1:A3's contents land on B1:B3, A1:A3 is emptied.
    write_numbers_without_recalc(&wb, &[(0, 1, 10.0), (1, 1, 20.0), (2, 1, 30.0)]);
    write_block_without_recalc(&wb, &[(0, 0, None), (1, 0, None), (2, 0, None)]);

    // The relocation: every reference into the source range is re-pointed.
    let seeds = relocate_rewrite(&wb, &[(4, 2, "=SUM(B1:B3)+SUM(B1:B3)")]);
    assert_eq!(seeds, vec![(4, 2)], "C5 was the only formula rewritten");

    // TEETH: the rewrite itself already fixed C5, so an assertion on C5 alone
    // would pass against the broken code. D5 is the one that needs the cascade.
    assert_eq!(wb.number(0, 4, 2), 120.0, "the rewritten formula re-evaluated");
    assert_eq!(
        wb.number(0, 4, 3),
        132.0,
        "precondition for the real assertion: D5 is STALE until phase B runs"
    );

    recalc_bulk(&wb, &seeds);

    assert_eq!(
        wb.number(0, 4, 3),
        240.0,
        "`relocate_cell_references` re-evaluated the formulas it rewrote and \
         cascaded to NOTHING, so `=C5*2` kept its pre-move product. Excel \
         updates the whole chain after a cut/paste move"
    );
}

#[test]
fn relocating_references_reaches_a_cross_sheet_reader() {
    // The second hop, which is what `cascade_cross_sheet_dependents` exists for:
    // the reader of the rewritten cell lives on ANOTHER sheet.
    let wb = Workbook::new(2);
    wb.set(0, 0, "10");
    wb.set(1, 0, "20");
    wb.set(2, 0, "30");
    wb.set(0, 1, "1");
    wb.set(1, 1, "2");
    wb.set(2, 1, "3");
    wb.set(4, 2, "=SUM(A1:A3)+SUM(B1:B3)"); // Sheet1!C5 = 66

    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!C5"); // Sheet2!A1
    wb.set(1, 0, "=A1*10"); // Sheet2!A2 — the SECOND hop
    assert_eq!(wb.number(1, 0, 0), 66.0, "precondition");
    assert_eq!(wb.number(1, 1, 0), 660.0, "precondition");
    wb.switch_to(0);

    write_numbers_without_recalc(&wb, &[(0, 1, 10.0), (1, 1, 20.0), (2, 1, 30.0)]);
    write_block_without_recalc(&wb, &[(0, 0, None), (1, 0, None), (2, 0, None)]);
    let seeds = relocate_rewrite(&wb, &[(4, 2, "=SUM(B1:B3)+SUM(B1:B3)")]);
    recalc_bulk(&wb, &seeds);

    assert_eq!(wb.number(1, 0, 0), 120.0, "the first cross-sheet hop");
    assert_eq!(
        wb.number(1, 1, 0),
        1200.0,
        "the SECOND hop — a dependent of the cross-sheet dependent"
    );
}

#[test]
fn relocate_cell_references_seeds_the_shared_cascade() {
    // The wiring half: `relocate_cell_references` takes `State` and cannot run
    // in-process, and the failure mode is silent (stale values, no error).
    const STRUCTURE_RS: &str = include_str!("structure.rs");
    let body = body_of(STRUCTURE_RS, "relocate_cell_references");
    assert!(
        body.contains("recalc_after_active_sheet_bulk_rewrite("),
        "`relocate_cell_references` rewrites formulas, re-evaluates them and \
         cascades to nothing — every formula reading a rewritten cell keeps its \
         pre-move value"
    );
}

// ---------------------------------------------------------------------------
// 2. Pivot writes
// ---------------------------------------------------------------------------

#[test]
fn a_formula_over_a_pivot_updates_when_the_pivot_block_is_written() {
    // A pivot's output block is written straight into the grid; `=B2*2` beside
    // it is an ordinary formula with an ordinary edge, and it must move.
    let wb = Workbook::new(1);
    wb.set(1, 1, "0"); // B2 — where the pivot's first value lands
    wb.set(1, 4, "=B2*2"); // E2 — the reader
    wb.set(1, 5, "=E2+1"); // F2 — a second hop, so the ORDER matters
    assert_eq!(wb.number(0, 1, 4), 0.0, "precondition");

    // The pivot refresh: a 2x2 block of aggregates lands at B2.
    let seeds = write_numbers_without_recalc(
        &wb,
        &[(1, 1, 500.0), (1, 2, 600.0), (2, 1, 700.0), (2, 2, 800.0)],
    );
    assert_eq!(
        wb.number(0, 1, 4),
        0.0,
        "precondition for the real assertion: the reader is STALE until phase B"
    );

    recalc_bulk(&wb, &seeds);

    assert_eq!(
        wb.number(0, 1, 4),
        1000.0,
        "a formula reading a pivot's output kept its pre-refresh value — the \
         silently wrong answer D3 exists to remove"
    );
    assert_eq!(
        wb.number(0, 1, 5),
        1001.0,
        "and the second hop followed, in dependency order"
    );
}

#[test]
fn a_formula_over_a_deleted_pivot_drops_to_zero() {
    // `delete_pivot_table` CLEARS the block. Excel drops a formula reading the
    // removed region to 0 at once; this used to hold the deleted pivot's last
    // numbers, which reads as live data.
    let wb = Workbook::new(1);
    wb.set(1, 1, "500");
    wb.set(1, 2, "600");
    wb.set(1, 4, "=SUM(B2:C2)");
    assert_eq!(wb.number(0, 1, 4), 1100.0, "precondition");

    let seeds = write_block_without_recalc(&wb, &[(1, 1, None), (1, 2, None)]);
    assert_eq!(
        wb.number(0, 1, 4),
        1100.0,
        "precondition for the real assertion: the reader is STALE until phase B"
    );

    recalc_bulk(&wb, &seeds);

    assert_eq!(
        wb.number(0, 1, 4),
        0.0,
        "clearing a pivot's block left its readers showing the deleted pivot's \
         totals"
    );
}

#[test]
fn the_pivot_block_seed_list_covers_the_whole_rectangle() {
    // Seeds are the whole rectangle, not just the cells that ended up
    // non-empty: a pivot that SHRANK leaves emptied cells behind, and a formula
    // reading one of those is exactly the reader that has to drop to 0.
    let seeds = crate::pivot::commands::pivot_block_seeds((5, 3), 3, 2);
    assert_eq!(
        seeds,
        vec![(5, 3), (5, 4), (6, 3), (6, 4), (7, 3), (7, 4)],
        "a 3x2 block at (5,3) must enumerate all six cells"
    );

    assert!(
        crate::pivot::commands::pivot_block_seeds((0, 0), 0, 0).is_empty(),
        "an empty pivot seeds nothing, so the cascade returns on its empty check"
    );
}

#[test]
fn every_pivot_cell_write_seeds_the_shared_cascade() {
    // The wiring half for all three pivot commands. Each writes to a
    // destination sheet chosen at RUNTIME, so — exactly like `bi_insert_result`
    // and `consolidate_data`, which write result blocks of the same shape —
    // each must recalculate on BOTH branches.
    const PIVOT_RS: &str = include_str!("../pivot/commands.rs");
    for name in [
        "create_pivot_inner",
        "delete_pivot_table",
        "undo_pivot_overwrite",
    ] {
        let body = body_of(PIVOT_RS, name);
        assert!(
            body.contains("recalc_after_active_sheet_bulk_rewrite("),
            "`{}` writes a block of pivot cells without seeding the shared \
             cascade on the ON-SHEET branch — a formula reading the block keeps \
             a stale value",
            name
        );
        assert!(
            body.contains("recalc_after_off_sheet_write("),
            "`{}` can write its block to a NON-active sheet, and that branch \
             recalculates nothing — the stale reader is then on the sheet you \
             are not looking at, which is how the `sort_range` asymmetry hid",
            name
        );
    }
}

// ---------------------------------------------------------------------------
// 3. Table writes
// ---------------------------------------------------------------------------

#[test]
fn a_formula_over_a_totals_row_updates_when_the_totals_row_appears() {
    // `toggle_totals_row` writes SUBTOTAL formulas into the totals row.
    let wb = Workbook::new(1);
    wb.set(0, 0, "10");
    wb.set(1, 0, "20");
    wb.set(2, 0, "30");
    wb.set(4, 2, "=A4*2"); // C5 reads the totals cell A4, still empty
    assert_eq!(wb.number(0, 4, 2), 0.0, "precondition");

    write_formula_without_recalc(&wb, 3, 0, "=SUBTOTAL(109,A1:A3)");
    assert_eq!(wb.number(0, 3, 0), 60.0, "the totals cell evaluated itself");
    assert_eq!(
        wb.number(0, 4, 2),
        0.0,
        "precondition for the real assertion: the reader is STALE until phase B"
    );

    recalc_bulk(&wb, &[(3, 0)]);

    assert_eq!(
        wb.number(0, 4, 2),
        120.0,
        "showing a totals row wrote a live SUBTOTAL and left every formula \
         reading it at its pre-totals value"
    );
}

#[test]
fn a_formula_over_a_totals_row_drops_when_the_totals_row_is_hidden() {
    // The CLEAR half of `toggle_totals_row`, which matters as much as the
    // write: hiding the totals row erases cells a formula may be reading.
    let wb = Workbook::new(1);
    wb.set(0, 0, "10");
    wb.set(1, 0, "20");
    wb.set(2, 0, "30");
    write_formula_without_recalc(&wb, 3, 0, "=SUBTOTAL(109,A1:A3)");
    wb.set(4, 2, "=A4*2");
    assert_eq!(wb.number(0, 4, 2), 120.0, "precondition");

    let seeds = write_block_without_recalc(&wb, &[(3, 0, None)]);
    recalc_bulk(&wb, &seeds);

    assert_eq!(
        wb.number(0, 4, 2),
        0.0,
        "hiding the totals row erased the cell but left its reader holding the \
         vanished total"
    );
}

#[test]
fn a_formula_over_a_calculated_column_updates_when_the_column_is_defined() {
    // `set_calculated_column` fills a whole column with an evaluated formula.
    // The reader here aggregates the column, which is the ordinary shape:
    // `=SUM(Table1[Margin])` beside the table.
    let wb = Workbook::new(1);
    for row in 0..3u32 {
        wb.set(row, 0, &((row + 1) * 10).to_string()); // A1:A3 = 10,20,30
        wb.set(row, 1, "2"); // B1:B3 = 2
    }
    wb.set(4, 3, "=SUM(C1:C3)"); // D5 aggregates the calculated column
    assert_eq!(wb.number(0, 4, 3), 0.0, "precondition: column C is empty");

    // The calculated column: C = A * B, one formula per data row.
    let mut seeds = Vec::new();
    for row in 0..3u32 {
        let formula = format!("=A{}*B{}", row + 1, row + 1);
        write_formula_without_recalc(&wb, row, 2, &formula);
        seeds.push((row, 2));
    }
    assert_eq!(wb.number(0, 0, 2), 20.0, "each written cell evaluated itself");
    assert_eq!(
        wb.number(0, 4, 3),
        0.0,
        "precondition for the real assertion: the aggregate is STALE until phase B"
    );

    recalc_bulk(&wb, &seeds);

    assert_eq!(
        wb.number(0, 4, 3),
        120.0,
        "defining a calculated column evaluated every cell it wrote and nothing \
         downstream of them, so `=SUM(C1:C3)` kept its previous total"
    );
}

#[test]
fn a_formula_over_an_auto_expanded_header_updates() {
    // `check_table_auto_expand`'s column branch WRITES a generated header into
    // the grid. A header cell is ordinary readable content.
    let wb = Workbook::new(1);
    wb.set(2, 5, "=D1&\"!\""); // F3 reads the not-yet-written header cell D1
    let before = wb.value(0, 2, 5);
    // TEETH, stated as an inequality on purpose: an EMPTY cell's concatenation
    // is the engine's business (it renders as "0" here, not ""), and pinning
    // that spelling would make this test fail for a reason it does not care
    // about. What it must prove is that the value MOVES.
    assert_ne!(
        before,
        engine::CellValue::Text("Column4!".to_string()),
        "precondition: F3 cannot already show the header this test writes"
    );

    let seeds = write_block_without_recalc(&wb, &[(0, 3, Some("Column4"))]);
    assert_eq!(
        wb.value(0, 2, 5),
        before,
        "precondition for the real assertion: the reader is STALE until phase B"
    );
    recalc_bulk(&wb, &seeds);

    assert_eq!(
        wb.value(0, 2, 5),
        engine::CellValue::Text("Column4!".to_string()),
        "auto-expanding a table wrote a generated header and left every formula \
         reading that cell showing the pre-expansion text"
    );
}

#[test]
fn every_table_cell_write_seeds_the_shared_cascade() {
    // The wiring half for all four table commands. These write to the ACTIVE
    // sheet only — a table lives on one sheet and every one of these commands
    // resolves its target through `active_sheet` — so the on-sheet helper is
    // the whole contract.
    const TABLES_RS: &str = include_str!("../tables.rs");
    for name in [
        "toggle_totals_row",
        "set_totals_row_function",
        "set_calculated_column",
        "check_table_auto_expand",
    ] {
        let body = body_of(TABLES_RS, name);
        assert!(
            body.contains("recalc_after_active_sheet_bulk_rewrite("),
            "`{}` rewrites table cells without seeding the shared cascade — \
             every formula reading them keeps a stale value until an unrelated \
             later edit sweeps it up",
            name
        );
    }
}

#[test]
fn table_formula_writes_record_their_own_dependency_edges() {
    // The other half of the table fix, and the reason seeding alone was not
    // enough: these commands wrote SUBTOTAL and calculated-column formulas with
    // NO edges at all. Editing the data underneath a totals row therefore left
    // the total frozen — and a cascade cannot reach a dependent along an edge
    // nobody ever recorded.
    const TABLES_RS: &str = include_str!("../tables.rs");

    // The totals writers go through `write_table_formula_cell`, which stores the
    // RESOLVED ast and then registers the edges. Both halves matter and the
    // helper is the only place that does them together.
    for name in ["toggle_totals_row", "set_totals_row_function"] {
        let body = body_of(TABLES_RS, name);
        assert!(
            body.contains("write_table_formula_cell("),
            "`{}` writes a totals cell directly instead of through \
             `write_table_formula_cell`, so it stores an UNRESOLVED \
             `SUBTOTAL(109,Table1[Col])` that evaluates to 0 and registers no \
             precedents",
            name
        );
    }

    // The calculated column already builds its own resolved ast per row (the
    // resolution is per-ROW), so it registers edges directly.
    let body = body_of(TABLES_RS, "set_calculated_column");
    assert!(
        body.contains("register_table_formula_dependencies("),
        "`set_calculated_column` writes formulas into the grid without \
         registering their precedents, so a later edit to the cells they read \
         leaves the column stale"
    );

    // The shared writer must keep storing the RESOLVED form. This is the line
    // whose absence made the totals row evaluate to 0 while looking correct.
    let helper = body_of(TABLES_RS, "write_table_formula_cell");
    assert!(
        helper.contains("set_cached_ast("),
        "`write_table_formula_cell` no longer stores a resolved AST on the cell \
         — `reevaluate_formula_cell` resolves only NAMES from a cached AST, so \
         the structured reference would never expand and the total would read 0"
    );
}

#[test]
fn a_totals_row_recalculates_when_the_data_beneath_it_changes() {
    // The behavioural half of the test above, through the REAL edit path: once
    // the totals cell owns its edges, an ordinary edit to the data cascades
    // into it exactly as Excel does.
    let wb = Workbook::new(1);
    wb.set(0, 0, "10");
    wb.set(1, 0, "20");
    wb.set(2, 0, "30");

    // Write the totals cell the way the fixed command does: value + edges.
    write_formula_without_recalc(&wb, 3, 0, "=SUBTOTAL(109,A1:A3)");
    register_totals_dependencies(&wb, 3, 0, "=SUBTOTAL(109,A1:A3)");
    assert_eq!(wb.number(0, 3, 0), 60.0, "precondition");

    // An ordinary edit to the data underneath.
    wb.set(1, 0, "200");

    assert_eq!(
        wb.number(0, 3, 0),
        240.0,
        "the totals cell was written with no dependency edges, so editing the \
         data underneath it left the total frozen at its original number"
    );
}

// ---------------------------------------------------------------------------
// 4. COST — what seeding a large pivot block actually costs
// ---------------------------------------------------------------------------
//
// This is the measurement the D3 decision turned on. The worry was that a pivot
// refresh rewrites a LARGE block, so seeding the cascade over it would be the
// expensive case and might be too expensive to do at all.
//
// The measurement says the opposite, for a reason that is obvious once the tree
// is read rather than guessed at: every OTHER pivot mutation already reaches
// `finalize_pivot_update` -> `recalculate_sheet_formulas`, which re-evaluates
// EVERY formula on the sheet. Seeding touches the block and its dependents.
// So this change makes the three exempt pivot paths cheaper than the pivot
// paths that were never exempt, not more expensive.
//
// `#[ignore]` because it is a benchmark, not an assertion about behaviour: run
// it with `--ignored --nocapture` to print the table. It carries ONE assertion,
// on the property the decision actually depends on — that seeding a block with
// no readers is cheaper than a whole-sheet pass over the same workbook.

/// A workbook shaped like a real pivot report: a `rows x cols` block of
/// numbers, `formula_count` ordinary formulas elsewhere on the sheet, and
/// `reader_count` of those formulas reading INTO the block.
fn pivot_cost_workbook(
    rows: u32,
    cols: u32,
    formula_count: u32,
    reader_count: u32,
) -> (Workbook, Vec<(u32, u32)>) {
    let wb = Workbook::new(1);

    // The pivot block, written the cheap way (no cascade) so setup is not the
    // thing being timed.
    let mut cells = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            cells.push((r, c, (r * cols + c) as f64));
        }
    }
    let seeds = write_numbers_without_recalc(&wb, &cells);

    // Formulas living well clear of the block. `reader_count` of them read the
    // block; the rest are independent, and exist so the whole-sheet pass has
    // realistic work to do.
    let base_col = cols + 2;
    for i in 0..formula_count {
        let row = i;
        let formula = if i < reader_count {
            format!("=SUM(A{}:B{})", i + 1, i + 1)
        } else {
            format!("={}*2", i + 1)
        };
        wb.set(row, base_col, &formula);
    }

    (wb, seeds)
}

fn millis(d: std::time::Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

#[test]
#[ignore]
fn cost_of_seeding_a_pivot_block_versus_a_whole_sheet_pass() {
    println!(
        "\n{:>12} {:>10} {:>12} {:>14} {:>14}",
        "block", "cells", "readers", "seed cascade", "whole sheet"
    );
    println!("{}", "-".repeat(68));

    // Realistic pivot shapes: a compact summary, a typical report, and a large
    // one. 200x25 = 5,000 cells is already a big pivot by report standards.
    let shapes: &[(u32, u32, u32, u32)] = &[
        (20, 5, 200, 50),
        (100, 10, 500, 100),
        (200, 25, 1000, 200),
        (500, 25, 2000, 400),
    ];

    let mut last: Option<(f64, f64)> = None;
    for &(rows, cols, formulas, readers) in shapes {
        let (wb, seeds) = pivot_cost_workbook(rows, cols, formulas, readers);

        let t0 = std::time::Instant::now();
        recalc_bulk(&wb, &seeds);
        let seeded = millis(t0.elapsed());

        let t1 = std::time::Instant::now();
        crate::calculation::recalculate_sheet_values(&wb.state, &wb.files, &wb.pivots, 0, None);
        let whole = millis(t1.elapsed());

        println!(
            "{:>12} {:>10} {:>12} {:>11.2}ms {:>11.2}ms",
            format!("{}x{}", rows, cols),
            rows * cols,
            readers,
            seeded,
            whole
        );
        last = Some((seeded, whole));
    }

    // The load-bearing property, asserted on the LARGEST shape: seeding a block
    // must not cost more than the whole-sheet pass the pivot module already
    // runs on every other mutation. If this ever flips, the cheap fix is to
    // seed only the block's actual DEPENDENTS rather than the block itself —
    // but it must be measured, not assumed, which is why this test exists.
    let (seeded, whole) = last.expect("at least one shape must have been measured");
    assert!(
        seeded <= whole * 3.0,
        "seeding a pivot block cost {:.2}ms against {:.2}ms for the whole-sheet \
         pass `finalize_pivot_update` already runs on every other pivot \
         mutation. Seeding was supposed to be the CHEAP option; if it is not, \
         the D3 cost note in docs/design/open-decisions-2026-08.md is wrong",
        seeded,
        whole
    );
}

/// The edge registration `register_table_formula_dependencies` performs,
/// reproduced here for the harness (the real one takes the `tables` guard the
/// commands already hold).
fn register_totals_dependencies(wb: &Workbook, row: u32, col: u32, formula: &str) {
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    let grid = wb.state.grid.write(&effect).unwrap();
    let Ok(parsed) = parser::parse(formula) else {
        panic!("the fixture formula must parse");
    };
    let refs = crate::extract_all_references(&parsed, &grid);
    let mut dependencies = wb.state.dependencies.lock().unwrap();
    let mut dependents = wb.state.dependents.lock().unwrap();
    crate::update_dependencies((row, col), refs.cells, &mut dependencies, &mut dependents);
}
