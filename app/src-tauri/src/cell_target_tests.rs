//! FILENAME: app/src-tauri/src/cell_target_tests.rs
//! PURPOSE: P3 S2 -- the cell-target foundation (`cell_target.rs`) and hidden
//!          lines on the floating range row.
//!
//! What is pinned here:
//!   1. THE RESOLVER answers by id, refuses an unknown id and a deleted
//!      backing sheet, and the extent refusal names the cell.
//!   2. HOST PROTECTION: a protected host protects its floating grid's cells
//!      (the backing cells' lock flags, the host's flag and options), the
//!      host's allow-edit ranges do NOT grant (they name host coordinates),
//!      and an unprotected host passes. The in-cell edit door
//!      (`update_floating_range_cell_inner`) asks it too.
//!   3. THE STYLED READ returns style-only empty cells, merges, CF results
//!      evaluated on the BACKING grid with the BACKING rules (a rule on the
//!      host at the same coordinates never leaks in), and display text in the
//!      APP locale.
//!   4. HIDDEN LINES: a LineFormat patch is governed by the host's Format Rows
//!      option (not Edit Objects), dirties, records "Hide floating grid rows",
//!      and Lock Objects still refuses it; the load path sanitises a saved set.
//!   5. LOCK ORDER: the read runs beside a style command without deadlocking.
//!
//! Child of `commands::data` (for the shared `Workbook` harness).

use super::cross_sheet_recalc_tests::Workbook;
use crate::api_types::{CellTargetRef, FloatingRangePatch};
use crate::cell_target::{
    ensure_in_extent, gate_target_cells, get_cell_target_cells_inner, resolve_cell_target, EDIT_CELLS,
};
use crate::conditional_formatting::{
    ConditionalFormat, ConditionalFormatDefinition, ConditionalFormatRange, ConditionalFormatRule,
};
use crate::floating_range::PatchGate;
use crate::protection::{AllowEditRange, SheetProtection, SheetProtectionOptions};
use engine::{Cell, CellStyle, CellValue, NumberFormat};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// A floating range on the ACTIVE sheet (sheet 0 of `wb`), window `rows` x
/// `cols`. Returns (id, backing index).
fn float_on_host(wb: &Workbook, rows: u32, cols: u32) -> (identity::EntityId, usize) {
    let info = crate::floating_range::create_floating_range_inner(&wb.state, &wb.file, None, 100.0, 50.0)
        .expect("create a floating range");
    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        FloatingRangePatch { row_count: Some(rows), col_count: Some(cols), ..Default::default() },
        PatchGate::ObjectEdit,
    )
    .expect("size the window");
    (info.range.id, info.backing_sheet_index)
}

fn target(id: identity::EntityId) -> CellTargetRef {
    CellTargetRef::FloatingRange { id }
}

/// Put a cell on a NON-active sheet's grid (the backing sheet).
fn seed_backing(wb: &Workbook, sheet: usize, row: u32, col: u32, value: CellValue, style: CellStyle) {
    let seed = crate::document_effect::test_seed_effect();
    let style_index = wb.state.style_registry.write(&seed).unwrap().get_or_create(style);
    let cell = Cell { value, ast: None, style_index, rich_text: None };
    wb.state.grids.write(&seed).unwrap()[sheet].set_cell(row, col, cell);
}

fn protect(wb: &Workbook, sheet: usize, options: SheetProtectionOptions, allow: Vec<AllowEditRange>) {
    wb.state.sheet_protection.write(&crate::document_effect::test_seed_effect()).unwrap().insert(
        sheet,
        SheetProtection {
            protected: true,
            password_hash: None,
            password_salt: None,
            options,
            allow_edit_ranges: allow,
        },
    );
}

fn allow_range(r0: u32, c0: u32, r1: u32, c1: u32) -> AllowEditRange {
    AllowEditRange {
        title: "Inputs".to_string(),
        start_row: r0,
        start_col: c0,
        end_row: r1,
        end_col: c1,
        password_hash: None,
        password_salt: None,
    }
}

fn rule(id: u64, rule: ConditionalFormatRule, fill: &str) -> ConditionalFormatDefinition {
    ConditionalFormatDefinition {
        id,
        priority: 1,
        rule,
        format: ConditionalFormat { background_color: Some(fill.to_string()), ..Default::default() },
        ranges: vec![ConditionalFormatRange { start_row: 0, start_col: 0, end_row: 3, end_col: 2 }],
        stop_if_true: false,
        enabled: true,
    }
}

fn edit_cell(wb: &Workbook, id: identity::EntityId, row: u32, col: u32, value: &str) -> Result<Vec<usize>, String> {
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
}

fn backing_value(wb: &Workbook, sheet: usize, row: u32, col: u32) -> Option<CellValue> {
    wb.state.grids.read().unwrap()[sheet].get_cell(row, col).map(|c| c.value.clone())
}

fn hide_rows(wb: &Workbook, id: identity::EntityId, rows: Vec<u32>) -> Result<crate::api_types::FloatingRangeInfo, String> {
    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        id,
        FloatingRangePatch { hidden_rows: Some(rows), ..Default::default() },
        PatchGate::LineFormat { host_option: "formatRows", what: "hide floating grid rows" },
    )
}

// ---------------------------------------------------------------------------
// 1. The resolver and the extent
// ---------------------------------------------------------------------------

#[test]
fn the_resolver_answers_by_id_and_refuses_an_unknown_id_and_a_missing_backing_sheet() {
    let wb = Workbook::new(1);
    let (id, backing) = float_on_host(&wb, 4, 3);
    let t = resolve_cell_target(&wb.state, &target(id)).expect("resolve");
    assert_eq!(t.backing_index, backing);
    assert_eq!(t.host_index, 0);
    assert_eq!(t.name, "Float1");
    assert_eq!((t.extent_rows, t.extent_cols), (4, 3));

    let unknown = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let err = resolve_cell_target(&wb.state, &target(unknown)).expect_err("an unknown id refuses");
    assert!(err.contains("No floating range"), "got: {err}");

    // The backing sheet is gone (its id no longer in the workbook).
    wb.state.sheet_ids.write(&crate::document_effect::test_seed_effect()).unwrap()[backing] =
        identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let err = resolve_cell_target(&wb.state, &target(id)).expect_err("a missing backing sheet refuses");
    assert_eq!(err, "Floating range backing sheet is missing");
}

#[test]
fn the_extent_refuses_the_first_cell_past_it_and_names_it() {
    let wb = Workbook::new(1);
    let (id, _) = float_on_host(&wb, 4, 3);
    let t = resolve_cell_target(&wb.state, &target(id)).unwrap();
    ensure_in_extent(&t, 0, 0, 3, 2).expect("the whole window is inside");
    let err = ensure_in_extent(&t, 4, 0, 4, 0).expect_err("row extent+1 (index 4) is outside");
    assert_eq!(err, "Cell A5 is outside floating grid 'Float1'. Nothing was changed.");
    let err = ensure_in_extent(&t, 0, 0, 0, 3).expect_err("column D is outside a 3-column grid");
    assert!(err.starts_with("Cell D1 is outside"), "got: {err}");
}

#[test]
fn the_extent_grows_to_the_backing_content() {
    let wb = Workbook::new(1);
    let (id, backing) = float_on_host(&wb, 2, 2);
    seed_backing(&wb, backing, 6, 4, CellValue::Number(1.0), CellStyle::new());
    let t = resolve_cell_target(&wb.state, &target(id)).unwrap();
    assert_eq!((t.extent_rows, t.extent_cols), (7, 5), "the window grown to the used range");
    ensure_in_extent(&t, 6, 4, 6, 4).expect("a stored cell past the window is writable");
}

// ---------------------------------------------------------------------------
// 2. Host protection
// ---------------------------------------------------------------------------

#[test]
fn a_protected_host_protects_the_grids_locked_cells_and_its_allow_ranges_do_not_grant() {
    let wb = Workbook::new(1);
    let (id, backing) = float_on_host(&wb, 4, 3);
    let t = resolve_cell_target(&wb.state, &target(id)).unwrap();

    // Unprotected host: everything passes.
    gate_target_cells(&wb.state, &t, (1, 1, 1, 1), EDIT_CELLS, "edit a floating grid's cells")
        .expect("an unprotected host passes");

    // Protected host with an allow-edit range over HOST B2 -- the same
    // coordinates as the grid's B2. It must NOT grant the grid's cell.
    protect(&wb, 0, SheetProtectionOptions::default(), vec![allow_range(1, 1, 1, 1)]);
    let err = gate_target_cells(&wb.state, &t, (1, 1, 1, 1), EDIT_CELLS, "edit a floating grid's cells")
        .expect_err("a locked backing cell on a protected host refuses");
    assert!(err.contains("Cannot change cell B2"), "the host's per-cell sentence, got: {err}");

    // Positive control: an UNLOCKED backing cell passes on the same host.
    let mut unlocked = CellStyle::new();
    unlocked.locked = false;
    seed_backing(&wb, backing, 1, 1, CellValue::Number(5.0), unlocked);
    gate_target_cells(&wb.state, &t, (1, 1, 1, 1), EDIT_CELLS, "edit a floating grid's cells")
        .expect("the lock flag comes from the BACKING cell");

    // An option gate answers from the HOST's options.
    let err = gate_target_cells(&wb.state, &t, (1, 1, 1, 1), "formatCells", "format a floating grid's cells")
        .expect_err("formatCells is not allowed on the host");
    assert!(err.contains("Cannot format a floating grid's cells on a protected sheet"), "got: {err}");
}

#[test]
fn the_in_cell_edit_door_is_gated_by_the_host() {
    let wb = Workbook::new(1);
    let (id, backing) = float_on_host(&wb, 4, 3);

    // Unprotected host: the edit writes.
    edit_cell(&wb, id, 0, 0, "7").expect("an unprotected host takes the edit");
    assert_eq!(backing_value(&wb, backing, 0, 0), Some(CellValue::Number(7.0)));

    // Protected host, locked backing cell: refused, document clean.
    protect(&wb, 0, SheetProtectionOptions::default(), Vec::new());
    crate::document_effect::mark_saved(&wb.file);
    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();
    let err = edit_cell(&wb, id, 1, 1, "9").expect_err("a locked cell on a protected host refuses");
    assert!(err.contains("Cannot change cell B2"), "got: {err}");
    assert!(!wb.file.is_dirty(), "a refused edit leaves the document clean");
    assert_eq!(backing_value(&wb, backing, 1, 1), None, "nothing was written");
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_depth(), depth, "and nothing recorded");
}

// ---------------------------------------------------------------------------
// 3. The styled read
// ---------------------------------------------------------------------------

#[test]
fn the_styled_read_answers_from_the_backing_sheet_in_the_app_locale() {
    let wb = Workbook::new(1);
    let (id, backing) = float_on_host(&wb, 4, 3);
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("de-DE");

    // Backing B2 = 1234.5 formatted #,##0.00; C3 a style-only EMPTY cell;
    // A4:B4 merged on the backing sheet.
    seed_backing(
        &wb,
        backing,
        1,
        1,
        CellValue::Number(1234.5),
        CellStyle::new().with_number_format(NumberFormat::Number { decimal_places: 2, use_thousands_separator: true }),
    );
    seed_backing(&wb, backing, 2, 2, CellValue::Empty, CellStyle::new().with_bold(true));
    seed_backing(&wb, backing, 3, 0, CellValue::Text("Total".to_string()), CellStyle::new());
    wb.state.all_merged_regions.write(&crate::document_effect::test_seed_effect()).unwrap()[backing].insert(
        crate::api_types::MergedRegion { start_row: 3, start_col: 0, end_row: 3, end_col: 1 },
    );
    // A CF rule on the BACKING sheet (fires on its non-blank B2) and one on the
    // HOST over the same coordinates (fires on blanks: the host's B2 is empty,
    // so a leak would paint).
    {
        let mut cf = wb.state.conditional_formats.write(&crate::document_effect::test_seed_effect()).unwrap();
        cf.insert(backing, vec![rule(7, ConditionalFormatRule::NoBlanks, "#00FF00")]);
        cf.insert(0, vec![rule(99, ConditionalFormatRule::BlankCells, "#FF0000")]);
    }

    let out = get_cell_target_cells_inner(&wb.state, &target(id), 0, 0, 3, 2).expect("read");

    let b2 = out.cells.iter().find(|c| (c.cell.row, c.cell.col) == (1, 1)).expect("B2 is returned");
    assert_eq!(b2.cell.display, "1.234,50", "display uses the APP locale (de-DE)");
    assert_eq!(b2.value_kind, "number");
    let c3 = out.cells.iter().find(|c| (c.cell.row, c.cell.col) == (2, 2)).expect("a style-only empty cell is returned");
    assert_eq!(c3.value_kind, "empty");
    assert!(out.styles.iter().any(|s| s.index == c3.cell.style_index), "its style primes the cache");
    let a4 = out.cells.iter().find(|c| (c.cell.row, c.cell.col) == (3, 0)).expect("the merge master");
    assert_eq!((a4.cell.row_span, a4.cell.col_span), (1, 2), "spans come from the BACKING merges");
    assert!(!out.cells.iter().any(|c| (c.cell.row, c.cell.col) == (3, 1)), "the covered cell is omitted");
    assert_eq!(out.merges.len(), 1);

    let hits: Vec<(u32, u32, Option<u64>)> = out.conditional.iter().map(|c| (c.row, c.col, c.rule_id)).collect();
    assert!(hits.contains(&(1, 1, Some(7))), "the backing rule fired on the backing B2, got {hits:?}");
    assert!(!hits.iter().any(|h| h.2 == Some(99)), "the HOST's rule never leaks in, got {hits:?}");
    assert_eq!(out.rules.iter().map(|r| r.id).collect::<Vec<_>>(), vec![7], "only the backing rules");
}

#[test]
fn the_styled_read_clips_to_the_extent_and_withholds_hidden_formulas_on_a_protected_host() {
    let wb = Workbook::new(1);
    let (id, backing) = float_on_host(&wb, 2, 2);
    let mut hidden = CellStyle::new();
    hidden.formula_hidden = true;
    {
        let seed = crate::document_effect::test_seed_effect();
        let style_index = wb.state.style_registry.write(&seed).unwrap().get_or_create(hidden);
        let mut cell = Cell::new_formula("1+1".to_string());
        assert!(cell.ast.is_some(), "precondition: a real formula cell");
        cell.style_index = style_index;
        wb.state.grids.write(&seed).unwrap()[backing].set_cell(0, 0, cell);
    }
    let read = || get_cell_target_cells_inner(&wb.state, &target(id), 0, 0, 500, 500).expect("read");
    let a1 = read().cells.into_iter().find(|c| (c.cell.row, c.cell.col) == (0, 0)).unwrap();
    assert!(a1.cell.formula.is_some(), "an unprotected host shows the formula");
    protect(&wb, 0, SheetProtectionOptions::default(), Vec::new());
    let a1 = read().cells.into_iter().find(|c| (c.cell.row, c.cell.col) == (0, 0)).unwrap();
    assert_eq!(a1.cell.formula, None, "a protected HOST hides the formula");

    // Past the extent: empty, never a refusal.
    let past = get_cell_target_cells_inner(&wb.state, &target(id), 10, 10, 20, 20).expect("read past");
    assert!(past.cells.is_empty());
}

// ---------------------------------------------------------------------------
// 4. Hidden lines on the object
// ---------------------------------------------------------------------------

#[test]
fn hiding_rows_dirties_records_its_name_and_round_trips_through_the_row() {
    let wb = Workbook::new(1);
    let (id, _) = float_on_host(&wb, 4, 3);
    crate::document_effect::mark_saved(&wb.file);

    let info = hide_rows(&wb, id, vec![1, 2]).expect("hide rows 2 and 3");
    assert_eq!(info.range.hidden_rows, vec![1, 2]);
    assert!(wb.file.is_dirty(), "a hide dirties the document");
    assert_eq!(
        wb.state.undo_stack.lock().unwrap().undo_description(),
        Some("Hide floating grid rows")
    );
    hide_rows(&wb, id, vec![2]).expect("unhide row 2");
    assert_eq!(
        wb.state.undo_stack.lock().unwrap().undo_description(),
        Some("Unhide floating grid rows")
    );

    // The size maps under LineFormat are named for the act.
    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        id,
        FloatingRangePatch {
            row_heights: Some(std::collections::HashMap::from([(0u32, 40.0)])),
            ..Default::default()
        },
        PatchGate::LineFormat { host_option: "formatRows", what: "change a floating grid's row height" },
    )
    .expect("row height");
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_description(), Some("Row height"));

    // A bad set refuses before any effect.
    crate::document_effect::mark_saved(&wb.file);
    for bad in [vec![3, 1], vec![1, 1], vec![1000]] {
        hide_rows(&wb, id, bad.clone()).expect_err("an unsorted, duplicated or out-of-range set refuses");
    }
    assert!(!wb.file.is_dirty(), "refusals leave the document clean");
}

#[test]
fn a_line_format_patch_is_governed_by_format_rows_not_edit_objects() {
    let wb = Workbook::new(1);
    let (id, _) = float_on_host(&wb, 4, 3);

    // formatRows ALLOWED, editObjects DENIED: the hide goes through.
    protect(
        &wb,
        0,
        SheetProtectionOptions { allow_format_rows: true, allow_edit_objects: false, ..Default::default() },
        Vec::new(),
    );
    hide_rows(&wb, id, vec![0]).expect("Format Rows governs a hide, not Edit Objects");
    // ...while the object edit itself is still refused on that host.
    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        id,
        FloatingRangePatch { x: Some(300.0), ..Default::default() },
        PatchGate::ObjectEdit,
    )
    .expect_err("a move is an object edit");

    // formatRows DENIED: refused with the act's own sentence, document clean.
    protect(&wb, 0, SheetProtectionOptions { allow_edit_objects: true, ..Default::default() }, Vec::new());
    crate::document_effect::mark_saved(&wb.file);
    let err = hide_rows(&wb, id, vec![0, 1]).expect_err("formatRows denied refuses");
    assert!(err.contains("hide floating grid rows"), "got: {err}");
    assert!(!wb.file.is_dirty());
}

#[test]
fn lock_objects_refuses_a_hide_and_a_canvas_host_is_never_asked_about_rows() {
    let wb = Workbook::new(1);
    let canvas = crate::sheets::add_sheet_inner(&wb.state, &wb.file, None, ::persistence::SheetKind::new_canvas())
        .expect("add a canvas")
        .active_index;
    let info = crate::floating_range::create_floating_range_inner(&wb.state, &wb.file, None, 10.0, 10.0)
        .expect("a floating range on the canvas");
    let id = info.range.id;

    // An UNLOCKED canvas host takes the hide: the canvas rule is asked of the
    // backing sheet, which is a worksheet.
    hide_rows(&wb, id, vec![0]).expect("a canvas host does not refuse a row act on its grid");

    crate::sheets::set_canvas_layout_inner(
        &wb.state,
        &wb.file,
        Some(canvas),
        &crate::api_types::CanvasLayoutPatch { objects_locked: Some(true), ..Default::default() },
    )
    .expect("Lock Objects");
    crate::document_effect::mark_saved(&wb.file);
    let err = hide_rows(&wb, id, Vec::new()).expect_err("Lock Objects refuses a change to the hidden set");
    assert!(err.to_lowercase().contains("lock"), "the page lock refused it, got: {err}");
    assert!(!wb.file.is_dirty());
}

#[test]
fn a_saved_hidden_set_is_sanitised_on_load_and_copied_on_save() {
    let wb = Workbook::new(1);
    let (id, _) = float_on_host(&wb, 4, 3);
    hide_rows(&wb, id, vec![1, 3]).unwrap();
    let saved = crate::persistence::collect_floating_ranges_for_save(&wb.state);
    assert_eq!(saved[0].hidden_rows, vec![1, 3], "the save direction copies the set");

    let mut corrupt = saved[0].clone();
    corrupt.hidden_rows = vec![5, 2, 2, 5000];
    corrupt.hidden_cols = vec![300, 1, 0];
    let row = crate::persistence::saved_floating_range_to_row(&corrupt);
    assert_eq!(row.hidden_rows, vec![2, 5], "filtered below the cap, sorted, deduplicated");
    assert_eq!(row.hidden_cols, vec![0, 1]);
}

// ---------------------------------------------------------------------------
// 5. Lock order: the read beside a style command
// ---------------------------------------------------------------------------

#[test]
fn the_styled_read_runs_beside_a_style_command_without_deadlocking() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let state = Arc::new(crate::create_app_state());
    let file = Arc::new(crate::persistence::FileState::default());
    let info = crate::floating_range::create_floating_range_inner(&state, &file, None, 0.0, 0.0).unwrap();
    {
        let mut cf = state.conditional_formats.write(&crate::document_effect::test_seed_effect()).unwrap();
        cf.insert(info.backing_sheet_index, vec![rule(1, ConditionalFormatRule::BlankCells, "#00FF00")]);
    }
    let id = info.range.id;

    let style_done = Arc::new(AtomicBool::new(false));
    let read_done = Arc::new(AtomicBool::new(false));
    {
        let (state, file, done) = (Arc::clone(&state), Arc::clone(&file), Arc::clone(&style_done));
        std::thread::spawn(move || {
            for i in 0..200u32 {
                let params = crate::api_types::FormattingParams {
                    rows: vec![i % 10],
                    cols: vec![0],
                    bold: Some(i % 2 == 0),
                    ..Default::default()
                };
                crate::commands::styles::apply_formatting_core(&state, &file, &params, &[]).unwrap();
            }
            done.store(true, Ordering::SeqCst);
        });
    }
    {
        let (state, done) = (Arc::clone(&state), Arc::clone(&read_done));
        std::thread::spawn(move || {
            for _ in 0..200 {
                get_cell_target_cells_inner(&state, &CellTargetRef::FloatingRange { id }, 0, 0, 0, 0).unwrap();
            }
            done.store(true, Ordering::SeqCst);
        });
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while !(style_done.load(Ordering::SeqCst) && read_done.load(Ordering::SeqCst)) {
        assert!(std::time::Instant::now() < deadline, "the read and a style command deadlocked");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
