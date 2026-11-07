//! FILENAME: app/src-tauri/src/commands/cell_target_content_tests.rs
//! PURPOSE: P3 S4 -- content, clear, sort, fill, the batch write, merge,
//!          search, Go To Special and conditional formatting take a CELL
//!          TARGET (a floating grid's cells).
//!
//! What is pinned here, for every command:
//!   1. the write lands on the object's BACKING sheet and NEVER on the active
//!      sheet at the same coordinates (BUG-0185's whole class);
//!   2. one gesture is ONE undo step, and Ctrl+Z restores the backing cells;
//!   3. a host formula reading the grid (`=Float1!A1`) recalculates;
//!   4. the HOST's protection gates the write, and a refusal leaves the
//!      document clean and the undo stack untouched;
//!   5. a rectangle outside the write extent refuses, naming the cell.
//!
//! A CHILD module of `commands::data` (for the shared `Workbook` harness and
//! the off-sheet bodies' plain-reference forms), like `cell_target_tests`.

use super::cross_sheet_recalc_tests::Workbook;
use crate::api_types::{
    CellTargetRef, CellUpdateInput, ClearApplyTo, ClearRangeParams, FloatingRangePatch, MergeOptions,
    MergedRegion, SortField, SortOrientation, SortRangeParams,
};
use crate::conditional_formatting::{
    AddCFParams, CellValueOperator, CellValueRule, ConditionalFormat, ConditionalFormatRange,
    ConditionalFormatRule,
};
use crate::floating_range::PatchGate;
use crate::protection::{SheetProtection, SheetProtectionOptions};
use engine::{Cell, CellStyle, CellValue};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// A floating range named `Float1` on the ACTIVE sheet (sheet 0), window
/// `rows` x `cols`. Returns (target, backing index).
fn float1(wb: &Workbook, rows: u32, cols: u32) -> (CellTargetRef, usize) {
    let info = crate::floating_range::create_floating_range_inner(
        &wb.state,
        &wb.file,
        Some("Float1".to_string()),
        100.0,
        50.0,
    )
    .expect("create a floating range");
    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        FloatingRangePatch { row_count: Some(rows), col_count: Some(cols), ..Default::default() },
        PatchGate::ObjectEdit,
    )
    .expect("size the window");
    (CellTargetRef::FloatingRange { id: info.range.id }, info.backing_sheet_index)
}

/// Type into a floating-grid cell through its own door.
fn type_in(wb: &Workbook, t: &CellTargetRef, row: u32, col: u32, value: &str) {
    let CellTargetRef::FloatingRange { id } = t;
    crate::floating_range::update_floating_range_cell_inner(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        *id,
        row,
        col,
        value.to_string(),
        None,
    )
    .unwrap_or_else(|e| panic!("type into ({row},{col}): {e}"));
}

fn backing_cell(wb: &Workbook, sheet: usize, row: u32, col: u32) -> Option<Cell> {
    wb.state.grids.read().unwrap()[sheet].get_cell(row, col).cloned()
}

fn backing_value(wb: &Workbook, sheet: usize, row: u32, col: u32) -> CellValue {
    backing_cell(wb, sheet, row, col).map(|c| c.value).unwrap_or(CellValue::Empty)
}

/// The ACTIVE sheet's mirror (what the user sees under the floating grid).
fn active_value(wb: &Workbook, row: u32, col: u32) -> CellValue {
    wb.state.grid.read().unwrap().get_cell(row, col).map(|c| c.value.clone()).unwrap_or(CellValue::Empty)
}

fn text(s: &str) -> CellValue {
    CellValue::Text(s.to_string())
}

fn depth(wb: &Workbook) -> usize {
    wb.state.undo_stack.lock().unwrap().undo_depth()
}

/// Ctrl+Z through the real restore path.
fn undo_once(wb: &Workbook) {
    let transaction = wb.state.undo_stack.lock().unwrap().pop_undo().expect("an undo step");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, &wb.timelines, transaction, true,
    );
}

fn protect_host(wb: &Workbook, options: SheetProtectionOptions) {
    wb.state.sheet_protection.write(&crate::document_effect::test_seed_effect()).unwrap().insert(
        0,
        SheetProtection {
            protected: true,
            password_hash: None,
            password_salt: None,
            options,
            allow_edit_ranges: Vec::new(),
        },
    );
}

/// Run `refused`, which must fail, and prove it left the document clean and
/// the undo stack untouched. Returns the sentence.
fn assert_clean_refusal<T: std::fmt::Debug>(wb: &Workbook, what: &str, refused: impl FnOnce() -> Result<T, String>) -> String {
    crate::document_effect::mark_saved(&wb.file);
    let before = depth(wb);
    let err = match refused() {
        Ok(v) => panic!("{what}: must be refused, got Ok({v:?})"),
        Err(e) => e,
    };
    assert!(!wb.file.is_dirty(), "{what}: a refusal must leave the document clean");
    assert_eq!(depth(wb), before, "{what}: a refusal records no undo step");
    err
}

fn clear(wb: &Workbook, t: &CellTargetRef, rect: (u32, u32, u32, u32), apply_to: ClearApplyTo) -> Result<crate::api_types::ClearRangeResult, String> {
    super::clear_range_on_target(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        ClearRangeParams {
            start_row: rect.0,
            start_col: rect.1,
            end_row: rect.2,
            end_col: rect.3,
            apply_to,
            sheet_index: None,
            target: Some(t.clone()),
        },
    )
}

fn batch(wb: &Workbook, t: &CellTargetRef, writes: &[(u32, u32, &str)]) -> Result<Vec<crate::api_types::CellData>, String> {
    crate::cell_target::update_cells_batch_on_target(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        t,
        writes
            .iter()
            .map(|&(row, col, value)| CellUpdateInput {
                row,
                col,
                value: value.to_string(),
                style_index: None,
                invariant: Some(true),
                pasted: None,
                moved: None,
                source: None,
            })
            .collect(),
        "Paste",
    )
}

fn merge(wb: &Workbook, t: &CellTargetRef, rect: (u32, u32, u32, u32), opts: MergeOptions) -> Result<crate::api_types::MergeResult, String> {
    crate::merge_commands::merge_cells_on_target(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        t,
        rect.0,
        rect.1,
        rect.2,
        rect.3,
        Some(opts),
    )
}

fn backing_merges(wb: &Workbook, backing: usize) -> Vec<MergedRegion> {
    let mut all: Vec<MergedRegion> = crate::report::with_sheet_merges(&wb.state, backing, |m| m.iter().cloned().collect());
    all.sort_by_key(|r| (r.start_row, r.start_col, r.end_row, r.end_col));
    all
}

fn region(r0: u32, c0: u32, r1: u32, c1: u32) -> MergedRegion {
    MergedRegion { start_row: r0, start_col: c0, end_row: r1, end_col: c1 }
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

#[test]
fn clearing_a_floating_grid_range_is_one_undo_step_on_the_backing_sheet_only() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    for row in 0..3 {
        type_in(&wb, &t, row, 1, &format!("{}", row + 1));
        wb.set(row, 1, "500"); // the ACTIVE sheet's B1:B3, under the grid
    }
    wb.set(0, 4, "=Float1!B2"); // Sheet1!E1 reads the grid
    assert_eq!(active_value(&wb, 0, 4), CellValue::Number(2.0));

    let before = depth(&wb);
    let result = clear(&wb, &t, (0, 1, 2, 1), ClearApplyTo::All).expect("clear B1:B3 on the grid");
    assert_eq!(result.count, 3);
    assert_eq!(depth(&wb), before + 1, "an N-cell clear is ONE undo step");
    for row in 0..3 {
        assert_eq!(backing_value(&wb, backing, row, 1), CellValue::Empty, "backing B{} cleared", row + 1);
        assert_eq!(active_value(&wb, row, 1), CellValue::Number(500.0), "the active sheet's B{} is untouched", row + 1);
    }
    assert_eq!(active_value(&wb, 0, 4), CellValue::Number(0.0), "the host formula recalculated");

    undo_once(&wb);
    for row in 0..3 {
        assert_eq!(backing_value(&wb, backing, row, 1), CellValue::Number(f64::from(row + 1)), "one Ctrl+Z restores B{}", row + 1);
    }
}

#[test]
fn a_clear_outside_the_extent_or_on_a_protected_host_refuses_and_leaves_the_document_clean() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    type_in(&wb, &t, 0, 0, "1");

    let err = assert_clean_refusal(&wb, "outside the extent", || clear(&wb, &t, (0, 0, 0, 5), ClearApplyTo::All));
    assert!(err.contains("is outside floating grid 'Float1'"), "got: {err}");

    protect_host(&wb, SheetProtectionOptions::default());
    let err = assert_clean_refusal(&wb, "protected host", || clear(&wb, &t, (0, 0, 0, 0), ClearApplyTo::Contents));
    assert!(err.contains("Cannot change cell A1"), "the host's per-cell sentence, got: {err}");
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Number(1.0));

    // A target together with a sheet is refused before anything is read.
    let err = assert_clean_refusal(&wb, "target and sheet", || {
        super::clear_range_on_target(
            &wb.state,
            &wb.file,
            &wb.files,
            &wb.pivots,
            &wb.pane,
            &wb.filters,
            ClearRangeParams {
                start_row: 0,
                start_col: 0,
                end_row: 0,
                end_col: 0,
                apply_to: ClearApplyTo::All,
                sheet_index: Some(0),
                target: Some(t.clone()),
            },
        )
    });
    assert_eq!(err, "Pass a floating grid target or a sheet, not both.");
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

#[test]
fn sorting_inside_a_floating_grid_moves_values_and_leaves_host_readers_text_alone() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 2);
    for (row, (letter, n)) in [("c", "1"), ("a", "2"), ("d", "3"), ("b", "4")].iter().enumerate() {
        type_in(&wb, &t, row as u32, 0, letter);
        type_in(&wb, &t, row as u32, 1, n);
    }
    wb.set(0, 3, "zzz"); // the active sheet's A1-area marker, far from the grid
    wb.set(0, 0, "keep"); // Sheet1!A1 under the grid
    wb.set(0, 4, "=Float1!B3"); // Sheet1!E1 reads the grid's B3
    assert_eq!(active_value(&wb, 0, 4), CellValue::Number(3.0));

    let result = super::sort_range_on_target(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        SortRangeParams {
            start_row: 0,
            start_col: 0,
            end_row: 3,
            end_col: 1,
            fields: vec![SortField {
                key: 0,
                ascending: true,
                sort_on: Default::default(),
                color: None,
                icon: None,
                data_option: Default::default(),
                sub_field: None,
                custom_order: None,
            }],
            match_case: false,
            has_headers: false,
            orientation: SortOrientation::Rows,
            sheet_index: None,
            target: Some(t.clone()),
        },
    )
    .expect("sort A1:B4 on the grid");
    assert!(result.success, "{:?}", result.error);
    let letters: Vec<CellValue> = (0..4).map(|r| backing_value(&wb, backing, r, 0)).collect();
    assert_eq!(letters, vec![text("a"), text("b"), text("c"), text("d")]);
    let numbers: Vec<CellValue> = (0..4).map(|r| backing_value(&wb, backing, r, 1)).collect();
    assert_eq!(
        numbers,
        vec![CellValue::Number(2.0), CellValue::Number(4.0), CellValue::Number(1.0), CellValue::Number(3.0)],
        "the B values travel with their rows"
    );
    assert_eq!(active_value(&wb, 0, 0), text("keep"), "the active sheet is untouched");
    let host = wb.state.grid.read().unwrap().get_cell(0, 4).cloned().expect("E1");
    assert_eq!(host.formula_string().as_deref(), Some("Float1!B3"), "Excel's sort never rewrites other cells' references");
    assert_eq!(active_value(&wb, 0, 4), CellValue::Number(1.0), "and the reader shows the value that arrived");

    // The Sort option is the host's.
    protect_host(&wb, SheetProtectionOptions::default());
    let err = assert_clean_refusal(&wb, "sort on a protected host", || {
        super::sort_range_on_target(
            &wb.state,
            &wb.file,
            &wb.files,
            &wb.pivots,
            &wb.pane,
            &wb.filters,
            SortRangeParams {
                start_row: 0,
                start_col: 0,
                end_row: 3,
                end_col: 1,
                fields: vec![SortField {
                    key: 0,
                    ascending: false,
                    sort_on: Default::default(),
                    color: None,
                    icon: None,
                    data_option: Default::default(),
                    sub_field: None,
                    custom_order: None,
                }],
                match_case: false,
                has_headers: false,
                orientation: SortOrientation::Rows,
                sheet_index: None,
                target: Some(t.clone()),
            },
        )
    });
    assert!(err.contains("sort"), "got: {err}");
}

// ---------------------------------------------------------------------------
// The batch write (paste)
// ---------------------------------------------------------------------------

#[test]
fn a_batch_paste_lands_on_the_backing_sheet_recalculates_the_host_and_is_one_undo_step() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    wb.set(0, 0, "111"); // Sheet1!A1, under the grid
    wb.set(1, 0, "222"); // Sheet1!A2
    wb.set(0, 5, "=Float1!A1*2"); // Sheet1!F1 reads the grid

    let before = depth(&wb);
    let cells = batch(&wb, &t, &[(0, 0, "5"), (1, 0, "=A1+1"), (2, 0, "x")]).expect("paste into the grid");
    assert_eq!(depth(&wb), before + 1, "a paste is ONE undo step");
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Number(5.0));
    assert_eq!(backing_value(&wb, backing, 1, 0), CellValue::Number(6.0), "a pasted formula evaluates on the backing sheet");
    assert_eq!(backing_value(&wb, backing, 2, 0), text("x"));
    assert_eq!(active_value(&wb, 0, 0), CellValue::Number(111.0), "the active sheet's A1 is untouched");
    assert_eq!(active_value(&wb, 1, 0), CellValue::Number(222.0), "the active sheet's A2 is untouched");
    assert_eq!(active_value(&wb, 0, 5), CellValue::Number(10.0), "the host formula recalculated (phase B)");
    let a2 = cells.iter().find(|c| (c.row, c.col) == (1, 0)).expect("A2 reported");
    assert_eq!(a2.display, "6", "the result describes the BACKING cells");

    undo_once(&wb);
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Empty, "one Ctrl+Z takes the whole paste back");
    assert_eq!(backing_value(&wb, backing, 1, 0), CellValue::Empty);
    assert_eq!(backing_value(&wb, backing, 2, 0), CellValue::Empty);
}

#[test]
fn a_batch_paste_on_a_protected_host_refuses_whole_and_leaves_the_document_clean() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    // An UNLOCKED backing cell beside a locked one: a paste over both refuses
    // whole (never half done).
    let seed = crate::document_effect::test_seed_effect();
    let mut unlocked = CellStyle::new();
    unlocked.locked = false;
    let idx = wb.state.style_registry.write(&seed).unwrap().get_or_create(unlocked);
    wb.state.grids.write(&seed).unwrap()[backing]
        .set_cell(0, 0, Cell { value: CellValue::Empty, ast: None, style_index: idx, rich_text: None });
    protect_host(&wb, SheetProtectionOptions::default());

    let err = assert_clean_refusal(&wb, "paste on a protected host", || batch(&wb, &t, &[(0, 0, "1"), (0, 1, "2")]));
    assert!(err.contains("Cannot change cell B1"), "got: {err}");
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Empty, "nothing of the paste landed");

    // Positive control: the unlocked cell alone takes the paste.
    batch(&wb, &t, &[(0, 0, "1")]).expect("an unlocked backing cell takes the paste");
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Number(1.0));

    let err = assert_clean_refusal(&wb, "paste outside the extent", || batch(&wb, &t, &[(9, 0, "1")]));
    assert!(err.contains("A10 is outside floating grid 'Float1'"), "got: {err}");
}

/// A plain paste (Ctrl+V, `useClipboard`'s floating-grid route) sends each
/// source cell's `styleIndex` with its value through the target batch. The
/// batch asked only the backing cells' lock flags, so a host that forbids
/// Format Cells received the source's format anyway (NEW-target-batch-
/// ignores-formatcells). Excel [LIVE, Excel 16 COM, Format Cells not allowed]:
/// Paste All onto unlocked cells lands the value with no bold, no fill and
/// General, and raises no error. With Format Cells allowed the format lands,
/// and each cell keeps its Locked flag [LIVE: Paste All of a locked cell onto
/// an unlocked one leaves it unlocked].
#[test]
fn a_styled_paste_onto_a_grid_lands_the_values_and_obeys_the_hosts_format_cells_option() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    let seed = crate::document_effect::test_seed_effect();
    let (unlocked_italic, locked_bold) = {
        let mut styles = wb.state.style_registry.write(&seed).unwrap();
        (
            styles.get_or_create(CellStyle { locked: false, ..CellStyle::new().with_italic(true) }),
            styles.get_or_create(CellStyle::new().with_bold(true)),
        )
    };
    // Backing A1:A3 unlocked and italic (A3 holds a value).
    {
        let mut grids = wb.state.grids.write(&seed).unwrap();
        for row in 0..3 {
            let value = if row == 2 { CellValue::Number(9.0) } else { CellValue::Empty };
            grids[backing].set_cell(row, 0, Cell { value, ast: None, style_index: unlocked_italic, rich_text: None });
        }
    }
    let styled = |cells: &[(u32, &str)]| -> Result<Vec<crate::api_types::CellData>, String> {
        crate::cell_target::update_cells_batch_on_target(
            &wb.state,
            &wb.file,
            &wb.files,
            &wb.pivots,
            &wb.pane,
            &wb.filters,
            &t,
            cells
                .iter()
                .map(|&(row, value)| CellUpdateInput {
                    row,
                    col: 0,
                    value: value.to_string(),
                    style_index: Some(locked_bold),
                    invariant: Some(true),
                    pasted: Some(true),
                    moved: None,
                    source: None,
                })
                .collect(),
            "Paste",
        )
    };
    let style_of = |row: u32| -> CellStyle {
        let grids = wb.state.grids.read().unwrap();
        let idx = grids[backing].effective_style_index(row, 0);
        wb.state.style_registry.read().unwrap().get(idx).clone()
    };

    // Format Cells NOT allowed: the values land, the format does not, and a
    // pasted blank keeps the cell's own format.
    protect_host(&wb, SheetProtectionOptions::default());
    styled(&[(0, "5"), (2, "")]).expect("the values land without their format");
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Number(5.0), "the value landed");
    let a1 = style_of(0);
    assert!(!a1.font.bold, "the source's format was dropped (Format Cells is off)");
    assert!(a1.font.italic && !a1.locked, "A1 keeps its own format and stays unlocked");
    assert_eq!(backing_value(&wb, backing, 2, 0), CellValue::Empty, "the pasted blank cleared A3");
    let a3 = style_of(2);
    assert!(a3.font.italic && !a3.locked, "a cleared A3 keeps its own format and stays unlocked");

    // Format Cells allowed: the format lands, and the cell stays unlocked
    // although the source was locked.
    protect_host(&wb, SheetProtectionOptions { allow_format_cells: true, ..SheetProtectionOptions::default() });
    styled(&[(1, "7")]).expect("the value and its format land");
    let a2 = style_of(1);
    assert!(a2.font.bold, "Format Cells allowed: the format landed");
    assert!(!a2.locked, "a paste cannot lock an unlocked cell on a protected host");
    assert_eq!(backing_value(&wb, backing, 1, 0), CellValue::Number(7.0));

    // Unprotected: a paste carries the source's Locked flag as before.
    wb.state.sheet_protection.write(&seed).unwrap().remove(&0);
    styled(&[(1, "8")]).expect("an unprotected host");
    assert!(style_of(1).locked, "unprotected, the source's Locked flag travels");
}

/// The batch's Format Cells PLAN is asked holding nothing; each write asks it
/// AGAIN under its own guards. Driven by handing the writes a stale plan
/// ("allowed") on a host whose option is now OFF -- what a host protected
/// between the plan and the write looks like: the values land, the format
/// does not, and every cell keeps its Locked flag.
#[test]
fn a_target_batch_re_asks_format_cells_and_the_hosts_protection_under_the_write_guards() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    let seed = crate::document_effect::test_seed_effect();
    let (unlocked_italic, locked_bold) = {
        let mut styles = wb.state.style_registry.write(&seed).unwrap();
        (
            styles.get_or_create(CellStyle { locked: false, ..CellStyle::new().with_italic(true) }),
            styles.get_or_create(CellStyle::new().with_bold(true)),
        )
    };
    {
        let mut grids = wb.state.grids.write(&seed).unwrap();
        for row in 0..2 {
            grids[backing].set_cell(row, 0, Cell { value: CellValue::Number(1.0), ast: None, style_index: unlocked_italic, rich_text: None });
        }
    }
    protect_host(&wb, SheetProtectionOptions::default());
    let resolved = crate::cell_target::resolve_cell_target(&wb.state, &t).expect("resolve Float1");
    let owned = wb.state.undo_stack.lock().unwrap().begin_owned_transaction("Paste".to_string());
    let written = crate::cell_target::write_batch_on_backing(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        &resolved,
        [(0u32, "5"), (1u32, "")]
            .iter()
            .map(|&(row, value)| CellUpdateInput {
                row,
                col: 0,
                value: value.to_string(),
                style_index: Some(locked_bold),
                invariant: Some(true),
                pasted: Some(true),
                moved: None,
                source: None,
            })
            .collect(),
        true, // the stale plan: "Format Cells allowed"
    );
    wb.state.undo_stack.lock().unwrap().commit_owned(owned);
    written.expect("the values land");
    let style_of = |row: u32| -> (CellStyle, usize) {
        let grids = wb.state.grids.read().unwrap();
        let own = grids[backing].get_cell(row, 0).map(|c| c.style_index).unwrap_or(0);
        let idx = grids[backing].effective_style_index(row, 0);
        (wb.state.style_registry.read().unwrap().get(idx).clone(), own)
    };
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Number(5.0), "the value landed");
    let (a1, own) = style_of(0);
    assert_eq!(own, unlocked_italic, "Format Cells is off AT THE WRITE: the format is dropped, A1 keeps its own");
    assert!(!a1.font.bold && !a1.locked, "A1 is not bold and stays unlocked");
    let (a2, own) = style_of(1);
    assert_eq!(own, unlocked_italic, "a pasted blank keeps A2's own format when the write refuses the format");
    assert!(!a2.locked, "A2 stays unlocked");
}

/// The floating-grid batch follows the SHEET route's two rules
/// (`update_cells_batch_core`, round 16): (1) a MOVED cell's format moves with
/// it on a protected host that does not allow Format Cells, and the cell keeps
/// its Locked flag [LIVE, rev14A/probe-cut.ps1: a bold 0.00 cell cut to an
/// unlocked cell of a protected sheet lands bold 0.00 with the option off or
/// on]; (2) a blank that names no style keeps the cell's OWN format,
/// unprotected and protected with the option off or on [LIVE, Excel 16 COM,
/// cutfmt/probe1.ps1: `Range.Value2 = ""` keeps bold 0.00 and the lock].
#[test]
fn a_target_batch_moves_a_cut_cells_format_and_a_blank_without_a_style_keeps_its_own() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    let seed = crate::document_effect::test_seed_effect();
    let (unlocked_italic, locked_bold) = {
        let mut styles = wb.state.style_registry.write(&seed).unwrap();
        (
            styles.get_or_create(CellStyle { locked: false, ..CellStyle::new().with_italic(true) }),
            styles.get_or_create(CellStyle::new().with_bold(true)),
        )
    };
    {
        let mut grids = wb.state.grids.write(&seed).unwrap();
        for row in 0..4 {
            grids[backing].set_cell(row, 0, Cell { value: CellValue::Number(1.0), ast: None, style_index: unlocked_italic, rich_text: None });
        }
    }
    // The cut SOURCES, on the host sheet: Sheet1!A1 (5) and the empty A2, both
    // still holding the moved look -- a move claim is honoured only when its
    // source shows the style it carries (BUG-0654, `honoured_move_claims`).
    for (row, value) in [(0u32, CellValue::Number(5.0)), (1, CellValue::Empty)] {
        let cell = Cell { value, ast: None, style_index: locked_bold, rich_text: None };
        wb.state.grid.write(&seed).unwrap().set_cell(row, 0, cell.clone());
        wb.state.grids.write(&seed).unwrap()[0].set_cell(row, 0, cell);
    }
    let write = |cells: &[(u32, &str, Option<usize>, bool)]| -> Result<Vec<crate::api_types::CellData>, String> {
        crate::cell_target::update_cells_batch_on_target(
            &wb.state,
            &wb.file,
            &wb.files,
            &wb.pivots,
            &wb.pane,
            &wb.filters,
            &t,
            cells
                .iter()
                .map(|&(row, value, style_index, moved)| CellUpdateInput {
                    row,
                    col: 0,
                    value: value.to_string(),
                    style_index,
                    invariant: Some(true),
                    pasted: Some(true),
                    // A move CLAIM naming its source cell, Sheet1!A{row+1}
                    // (seeded above); both routes bind it (BUG-0654).
                    moved: moved.then(|| crate::api_types::MovedFrom { sheet_index: 0, row, col: 0, target: None }),
                    source: None,
                })
                .collect(),
            "Paste",
        )
    };
    let style_of = |row: u32| -> CellStyle {
        let grids = wb.state.grids.read().unwrap();
        let idx = grids[backing].effective_style_index(row, 0);
        wb.state.style_registry.read().unwrap().get(idx).clone()
    };

    // (1) Protected host, Format Cells OFF: a cut lands its format (a value
    // and a blank), each cell stays unlocked; a COPY still drops it.
    protect_host(&wb, SheetProtectionOptions::default());
    write(&[(0, "5", Some(locked_bold), true), (1, "", Some(locked_bold), true), (2, "6", Some(locked_bold), false)])
        .expect("a cut lands on unlocked cells");
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Number(5.0), "the moved value landed");
    let a1 = style_of(0);
    assert!(a1.font.bold, "a MOVED cell keeps its bold on a protected host without Format Cells");
    assert!(!a1.locked, "the moved cell keeps the destination's Locked flag (unlocked)");
    let a2 = style_of(1);
    assert!(a2.font.bold, "a MOVED blank keeps its bold on a protected host without Format Cells");
    assert!(!a2.locked, "the moved blank stays unlocked");
    let a3 = style_of(2);
    assert!(!a3.font.bold && a3.font.italic, "a COPY still drops the source's format");

    // (2) A blank that names no style keeps the cell's own format, with the
    // option on, and unprotected.
    protect_host(&wb, SheetProtectionOptions { allow_format_cells: true, ..SheetProtectionOptions::default() });
    write(&[(3, "", None, false)]).expect("a blank on an unlocked cell");
    assert_eq!(backing_value(&wb, backing, 3, 0), CellValue::Empty, "the blank cleared the value");
    let a4 = style_of(3);
    assert!(a4.font.italic && !a4.locked, "Format Cells on: a blank without a style keeps A4's own format");
    wb.state.sheet_protection.write(&seed).unwrap().remove(&0);
    write(&[(2, "", None, false)]).expect("an unprotected host");
    assert_eq!(backing_value(&wb, backing, 2, 0), CellValue::Empty, "the blank cleared A3");
    let a3 = style_of(2);
    assert!(a3.font.italic && !a3.locked, "unprotected: a blank without a style keeps A3's own format");
}

/// BUG-0654: the floating-grid batch BINDS a move claim to its source, as the
/// sheet route does (`honoured_move_claims`). A claim whose source cell does
/// not show the style the write carries -- an arbitrary style index sent with
/// `moved` onto an unlocked backing cell of a protected host that refuses
/// Format Cells -- is written as a COPY: the value lands, the format is
/// dropped. A claim whose source shows it (a cut inside the grid itself, the
/// source named by the grid's target) is honoured.
#[test]
fn a_target_batch_honours_a_move_claim_only_from_a_source_that_holds_the_style() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    let seed = crate::document_effect::test_seed_effect();
    let (unlocked_italic, forged, bold) = {
        let mut styles = wb.state.style_registry.write(&seed).unwrap();
        (
            styles.get_or_create(CellStyle { locked: false, ..CellStyle::new().with_italic(true) }),
            styles.get_or_create(CellStyle { locked: false, ..CellStyle::new().with_strikethrough(true) }),
            styles.get_or_create(CellStyle::new().with_bold(true)),
        )
    };
    {
        let mut grids = wb.state.grids.write(&seed).unwrap();
        for row in 0..3 {
            grids[backing].set_cell(row, 0, Cell { value: CellValue::Number(1.0), ast: None, style_index: unlocked_italic, rich_text: None });
        }
        // Float1!C1: a real in-grid cut source, still holding its bold.
        grids[backing].set_cell(0, 2, Cell { value: CellValue::Number(9.0), ast: None, style_index: bold, rich_text: None });
    }
    // Sheet1!E1 shows the default style: a claim naming it carries nothing.
    protect_host(&wb, SheetProtectionOptions::default());
    let claim = |row: u32, style_index: usize, from: crate::api_types::MovedFrom| CellUpdateInput {
        row,
        col: 0,
        value: "5".to_string(),
        style_index: Some(style_index),
        invariant: Some(true),
        pasted: Some(true),
        moved: Some(from),
        source: None,
    };
    let on_host = |row: u32, col: u32| crate::api_types::MovedFrom { sheet_index: 0, row, col, target: None };
    let in_grid = |row: u32, col: u32| crate::api_types::MovedFrom { sheet_index: 0, row, col, target: Some(t.clone()) };
    let own_style = |row: u32| wb.state.grids.read().unwrap()[backing].get_cell(row, 0).map(|c| c.style_index).unwrap_or(0);
    let paste = |updates: Vec<CellUpdateInput>| {
        crate::cell_target::update_cells_batch_on_target(&wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, &t, updates, "Paste")
    };

    // The forgery: A1 "moved from" Sheet1!E1, carrying a style E1 does not show.
    paste(vec![claim(0, forged, on_host(0, 4))]).expect("the value lands (Excel: no error on an unlocked cell)");
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Number(5.0), "the value landed");
    assert_eq!(
        own_style(0),
        unlocked_italic,
        "an UNBOUND move claim landed its style on a protected host without Format Cells: Sheet1!E1 shows another style"
    );
    // A claim naming a sheet that does not exist is a copy too.
    paste(vec![claim(1, forged, crate::api_types::MovedFrom { sheet_index: 9, row: 0, col: 0, target: None })]).expect("the value lands");
    assert_eq!(own_style(1), unlocked_italic, "a claim on a sheet that does not exist carried a format");

    // Positive control: a cut of Float1!C1 (bold) onto A3 is honoured -- the
    // source is judged on the grid's backing sheet, whose cells are its own.
    paste(vec![claim(2, bold, in_grid(0, 2))]).expect("an in-grid cut");
    let a3 = {
        let grids = wb.state.grids.read().unwrap();
        wb.state.style_registry.read().unwrap().get(grids[backing].effective_style_index(2, 0)).clone()
    };
    assert!(a3.font.bold, "a real cut inside the grid lost its format");
    assert!(!a3.locked, "the moved cell keeps the destination's Locked flag (unlocked)");
}

/// BUG-0655: the host-side lock and option questions a formatting-only paste
/// onto a floating grid asks (`can_edit_cell` / `can_perform_action` with a
/// `target`). They answer for the GRID's own cells under the HOST's
/// protection -- never for the active sheet's cells at the same coordinates,
/// which is all the targetless question could read.
#[test]
fn the_lock_and_option_questions_with_a_target_answer_for_the_grids_own_cells() {
    use crate::protection::{can_edit_target_cells_core, ProtectionCellRef};
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    let seed = crate::document_effect::test_seed_effect();
    let unlocked = wb.state.style_registry.write(&seed).unwrap().get_or_create(CellStyle { locked: false, ..CellStyle::new() });
    // The grid's A1 unlocked, its B1 locked (the default). The HOST's B1, under
    // the grid, is unlocked: a question read from the active sheet says "editable".
    wb.state.grids.write(&seed).unwrap()[backing]
        .set_cell(0, 0, Cell { value: CellValue::Empty, ast: None, style_index: unlocked, rich_text: None });
    let host_b1 = Cell { value: CellValue::Empty, ast: None, style_index: unlocked, rich_text: None };
    wb.state.grid.write(&seed).unwrap().set_cell(0, 1, host_b1.clone());
    wb.state.grids.write(&seed).unwrap()[0].set_cell(0, 1, host_b1);
    let cells = |list: &[(u32, u32)]| Some(list.iter().map(|&(row, col)| ProtectionCellRef { row, col }).collect::<Vec<_>>());

    // Unprotected host: every cell can be edited.
    assert!(can_edit_target_cells_core(&wb.state, &t, 0, 0, cells(&[(0, 0), (0, 1)])).can_edit);

    protect_host(&wb, SheetProtectionOptions::default());
    let a1 = can_edit_target_cells_core(&wb.state, &t, 0, 0, cells(&[(0, 0)]));
    assert!(a1.can_edit, "the grid's unlocked A1 is editable on a protected host: {:?}", a1.reason);
    let both = can_edit_target_cells_core(&wb.state, &t, 0, 0, cells(&[(0, 0), (0, 1)]));
    assert!(!both.can_edit, "the grid's LOCKED B1 was answered from the host's unlocked B1 (the active sheet)");
    assert!(both.reason.as_deref().is_some_and(|r| r.contains("B1")), "the refusal names B1: {:?}", both.reason);
    let outside = can_edit_target_cells_core(&wb.state, &t, 0, 0, cells(&[(9, 0)]));
    assert!(!outside.can_edit, "a cell outside the grid's extent cannot be edited");
}

/// BUG-0655, the option half: `can_perform_action` with a `target` asks the
/// HOST's protection (the gate the grid's own format writes ask).
#[test]
fn the_option_question_with_a_target_asks_the_hosts_protection() {
    use crate::protection::can_perform_action_core;
    let wb = Workbook::new(1);
    let (t, _backing) = float1(&wb, 4, 3);
    assert!(can_perform_action_core(&wb.state, "formatCells", Some(&t)).can_edit, "an unprotected host allows it");
    protect_host(&wb, SheetProtectionOptions::default());
    assert!(
        !can_perform_action_core(&wb.state, "formatCells", Some(&t)).can_edit,
        "the HOST forbids Format Cells: the grid's option question says so"
    );
    protect_host(&wb, SheetProtectionOptions { allow_format_cells: true, ..SheetProtectionOptions::default() });
    assert!(can_perform_action_core(&wb.state, "formatCells", Some(&t)).can_edit, "the host allows Format Cells");
    let missing = crate::api_types::CellTargetRef::FloatingRange { id: identity::EntityId::from_bytes([7u8; 16]) };
    assert!(!can_perform_action_core(&wb.state, "formatCells", Some(&missing)).can_edit, "a target that does not resolve cannot");
}

/// BUG-0347: Paste (No Borders) keeps the destination's OWN borders in full --
/// a THEME-coloured (tinted) MEDIUM DASHED side stays exactly that, on the
/// sheet and on a floating grid -- because the frontend now sends the source's
/// style as a `keep_borders` style write the backend decides from the cell's
/// own style, instead of putting each side back through applyFormatting's
/// {style, color} wire (a fixed colour, width 1). Excel [LIVE, Excel 16 COM,
/// 2026-11-04, paste-x/probe1.ps1]: xlPasteAllExceptBorders onto a cell with a
/// theme-colour-5 medium dashed bottom border keeps theme colour 5, medium,
/// dashed, while the source's bold arrives and its own top border does not.
#[test]
fn no_borders_keeps_a_theme_coloured_medium_dashed_border_in_full_on_a_sheet_and_a_grid() {
    use engine::{BorderLineStyle, BorderStyle, ThemeColor, ThemeColorSlot, Tint};
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    let seed = crate::document_effect::test_seed_effect();
    let themed = BorderStyle { width: 2, color: ThemeColor::theme_tinted(ThemeColorSlot::Accent2, Tint(-2500)), style: BorderLineStyle::Dashed };
    let red_top = BorderStyle { width: 1, color: ThemeColor::absolute(255, 0, 0), style: BorderLineStyle::Solid };
    let (dest, source) = {
        let mut styles = wb.state.style_registry.write(&seed).unwrap();
        let mut d = CellStyle::new().with_italic(true);
        d.borders.bottom = themed.clone();
        let mut s = CellStyle::new().with_bold(true);
        s.borders.top = red_top.clone();
        (styles.get_or_create(d), styles.get_or_create(s))
    };
    let cell = Cell { value: CellValue::Number(1.0), ast: None, style_index: dest, rich_text: None };
    wb.state.grid.write(&seed).unwrap().set_cell(0, 0, cell.clone());
    wb.state.grids.write(&seed).unwrap()[0].set_cell(0, 0, cell.clone());
    wb.state.grids.write(&seed).unwrap()[backing].set_cell(0, 0, cell);
    let write = [crate::api_types::CellStyleWrite { row: 0, col: 0, style_index: source, keep_borders: Some(true) }];

    crate::commands::styles::set_cell_styles_core(&wb.state, &wb.file, &write, None).expect("No Borders on the sheet");
    crate::commands::styles::set_cell_styles_core(&wb.state, &wb.file, &write, Some(&t)).expect("No Borders on the grid");

    let sheet_style = {
        let grid = wb.state.grid.read().unwrap();
        wb.state.style_registry.read().unwrap().get(grid.effective_style_index(0, 0)).clone()
    };
    let grid_style = {
        let grids = wb.state.grids.read().unwrap();
        wb.state.style_registry.read().unwrap().get(grids[backing].effective_style_index(0, 0)).clone()
    };
    for (place, s) in [("sheet", sheet_style), ("grid", grid_style)] {
        assert!(s.font.bold && !s.font.italic, "{place}: the source's style arrived whole");
        assert_eq!(s.borders.bottom, themed, "{place}: the destination's theme-coloured medium dashed bottom border lost detail");
        assert_eq!(s.borders.top, BorderStyle::default(), "{place}: the source's own top border arrived");
    }
}

/// Fill Down on a floating grid of a PROTECTED host follows the sheet's rule
/// (`fill_range_core`, Excel [LIVE, protfill/probe1.ps1]): the source's format
/// only with Format Cells allowed, and every filled cell keeps its Locked flag.
#[test]
fn fill_down_on_a_protected_hosts_grid_obeys_format_cells_and_keeps_every_lock() {
    for allow_format_cells in [false, true] {
        let wb = Workbook::new(1);
        let (t, backing) = float1(&wb, 4, 3);
        let seed = crate::document_effect::test_seed_effect();
        let (unlocked_italic, locked_bold) = {
            let mut styles = wb.state.style_registry.write(&seed).unwrap();
            (
                styles.get_or_create(CellStyle { locked: false, ..CellStyle::new().with_italic(true) }),
                styles.get_or_create(CellStyle::new().with_bold(true)),
            )
        };
        {
            let mut grids = wb.state.grids.write(&seed).unwrap();
            grids[backing].set_cell(0, 0, Cell { value: CellValue::Number(5.0), ast: None, style_index: locked_bold, rich_text: None });
            for row in 1..3 {
                for col in 0..2 {
                    grids[backing].set_cell(row, col, Cell { value: CellValue::Number(1.0), ast: None, style_index: unlocked_italic, rich_text: None });
                }
            }
        }
        protect_host(&wb, SheetProtectionOptions { allow_format_cells, ..SheetProtectionOptions::default() });
        super::fill_range_on_target(
            &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, &t, (0, 0, 0, 1), (1, 0, 2, 1),
        )
        .unwrap_or_else(|e| panic!("Format Cells {allow_format_cells}: fill onto unlocked cells: {e}"));
        let style_of = |row: u32, col: u32| -> (CellStyle, usize) {
            let grids = wb.state.grids.read().unwrap();
            let own = grids[backing].get_cell(row, col).map(|c| c.style_index).unwrap_or(0);
            let idx = grids[backing].effective_style_index(row, col);
            (wb.state.style_registry.read().unwrap().get(idx).clone(), own)
        };
        for row in 1..3 {
            assert_eq!(backing_value(&wb, backing, row, 0), CellValue::Number(5.0), "the value landed");
            let (cell, own) = style_of(row, 0);
            assert!(!cell.locked, "Format Cells {allow_format_cells}: a fill cannot LOCK an unlocked cell");
            if allow_format_cells {
                assert!(cell.font.bold, "Format Cells allowed: the source's format landed");
            } else {
                assert_eq!(own, unlocked_italic, "Format Cells NOT allowed: the cell keeps its own format");
            }
            assert_eq!(backing_value(&wb, backing, row, 1), CellValue::Empty, "the empty B1 cleared the cell");
            let (blank, own) = style_of(row, 1);
            assert!(!blank.locked, "Format Cells {allow_format_cells}: a filled blank cannot lock the cell");
            if !allow_format_cells {
                assert_eq!(own, unlocked_italic, "Format Cells NOT allowed: the blank keeps its own format");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

#[test]
fn fill_down_on_a_floating_grid_shifts_relative_references_on_the_backing_sheet() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    type_in(&wb, &t, 0, 0, "2");
    type_in(&wb, &t, 1, 0, "3");
    type_in(&wb, &t, 2, 0, "4");
    type_in(&wb, &t, 0, 1, "=A1*10");
    wb.set(1, 1, "999"); // the active sheet's B2, under the grid

    let before = depth(&wb);
    super::fill_range_on_target(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        &t,
        (0, 1, 0, 1),
        (1, 1, 2, 1),
    )
    .expect("fill B1 down to B3");
    assert_eq!(depth(&wb), before + 1, "a fill is ONE undo step");
    let b2 = backing_cell(&wb, backing, 1, 1).expect("B2 filled");
    assert_eq!(b2.formula_string().as_deref(), Some("A2*10"), "the reference moved with the fill");
    assert_eq!(b2.value, CellValue::Number(30.0));
    assert_eq!(backing_value(&wb, backing, 2, 1), CellValue::Number(40.0));
    assert_eq!(active_value(&wb, 1, 1), CellValue::Number(999.0), "the active sheet's B2 is untouched");

    undo_once(&wb);
    assert!(backing_cell(&wb, backing, 1, 1).is_none(), "one Ctrl+Z takes the fill back");
    assert!(backing_cell(&wb, backing, 2, 1).is_none());

    protect_host(&wb, SheetProtectionOptions::default());
    let err = assert_clean_refusal(&wb, "fill on a protected host", || {
        super::fill_range_on_target(
            &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, &t, (0, 1, 0, 1), (1, 1, 2, 1),
        )
    });
    assert!(err.contains("Cannot change cell"), "got: {err}");
}

/// Ledger programme 2 wave 3 (W2 uimisc new defect): a floating grid's Fill
/// Down did not repeat the source's merges, which the sheet's does (BUG-0768,
/// `fill_merge_pattern`). Excel [LIVE, Excel 16 COM, 2026-11-06, lane uimisc
/// probe2 B2: FillDown A1:A6 from a merged A1:A2 merged A3:A4 and A5:A6]. The
/// repeated merges are taken back by the same Ctrl+Z; a destination holding a
/// merge that is not the source's pattern changes nothing, as on the sheet.
///
/// SABOTAGE: make the object fill's `pattern_merges` empty -- fails at
/// "MERGES NOT REPEATED".
#[test]
fn fill_down_on_a_floating_grid_repeats_the_sources_merges() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 6, 2);
    type_in(&wb, &t, 0, 0, "x");
    merge(&wb, &t, (0, 0, 1, 0), MergeOptions::default()).expect("merge A1:A2");
    let before = depth(&wb);
    super::fill_range_on_target(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, &t, (0, 0, 1, 0), (2, 0, 5, 0),
    )
    .expect("fill A1:A2 down to A6");
    assert_eq!(
        backing_merges(&wb, backing),
        vec![region(0, 0, 1, 0), region(2, 0, 3, 0), region(4, 0, 5, 0)],
        "MERGES NOT REPEATED: the source's A1:A2 merge is copied down the fill"
    );
    assert_eq!(backing_value(&wb, backing, 2, 0), CellValue::Text("x".to_string()));
    assert_eq!(depth(&wb), before + 1, "a fill is ONE undo step");
    undo_once(&wb);
    assert_eq!(backing_merges(&wb, backing), vec![region(0, 0, 1, 0)], "one Ctrl+Z takes the repeated merges back");
    assert!(backing_cell(&wb, backing, 2, 0).is_none(), "and the cells");

    // A foreign merge in the destination: nothing changes (Excel [LIVE,
    // pastec/probe-fill2.ps1]).
    merge(&wb, &t, (3, 0, 3, 1), MergeOptions::default()).expect("merge A4:B4");
    let before = depth(&wb);
    super::fill_range_on_target(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, &t, (0, 0, 1, 0), (2, 0, 5, 0),
    )
    .expect("a fill over a foreign merge changes nothing");
    assert_eq!(depth(&wb), before, "nothing recorded");
    assert!(backing_cell(&wb, backing, 2, 0).is_none(), "nothing written");
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

#[test]
fn a_merge_probe_reads_the_backing_grid_and_changes_nothing() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    type_in(&wb, &t, 0, 0, "c");
    type_in(&wb, &t, 0, 1, "1234");
    // The ACTIVE sheet's A1:B1 is empty: a probe answered from it would
    // report no loss.
    crate::document_effect::mark_saved(&wb.file);
    let before = depth(&wb);
    let probe = merge(&wb, &t, (0, 0, 0, 1), MergeOptions { probe: true, ..Default::default() }).expect("probe");
    assert_eq!(probe.lossy_regions, 1, "the loss is counted on the BACKING grid");
    assert_eq!(probe.created_regions, vec![region(0, 0, 0, 1)]);
    assert!(!wb.file.is_dirty(), "a probe leaves the document clean");
    assert_eq!(depth(&wb), before, "and records nothing");
    assert!(backing_merges(&wb, backing).is_empty());
    assert_eq!(backing_value(&wb, backing, 0, 1), CellValue::Number(1234.0));
}

#[test]
fn a_merge_on_a_floating_grid_is_one_step_and_keeps_the_upper_left_value() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    type_in(&wb, &t, 0, 0, "c");
    type_in(&wb, &t, 0, 1, "1234");
    wb.set(0, 1, "777"); // the active sheet's B1

    let before = depth(&wb);
    let result = merge(&wb, &t, (0, 0, 0, 1), MergeOptions::default()).expect("merge A1:B1");
    assert!(result.success);
    assert_eq!(depth(&wb), before + 1, "ONE undo step");
    assert_eq!(backing_merges(&wb, backing), vec![region(0, 0, 0, 1)]);
    assert!(wb.state.merged_regions.read().unwrap().is_empty(), "the ACTIVE sheet gained no merge");
    assert_eq!(backing_value(&wb, backing, 0, 0), text("c"), "the upper-left value stays");
    assert_eq!(backing_value(&wb, backing, 0, 1), CellValue::Empty, "the rest is discarded");
    assert_eq!(active_value(&wb, 0, 1), CellValue::Number(777.0), "the active sheet's B1 is untouched");

    undo_once(&wb);
    assert!(backing_merges(&wb, backing).is_empty(), "one Ctrl+Z removes the merge");
    assert_eq!(backing_value(&wb, backing, 0, 1), CellValue::Number(1234.0), "and restores B1");

    // The host gates it: Format Cells.
    protect_host(&wb, SheetProtectionOptions::default());
    let err = assert_clean_refusal(&wb, "merge on a protected host", || merge(&wb, &t, (0, 0, 0, 1), MergeOptions::default()));
    assert!(err.contains("Cannot change cell") || err.contains("merge cells"), "got: {err}");
}

#[test]
fn merge_across_makes_one_region_per_row_and_absorb_dissolves_an_inner_backing_region() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);

    merge(&wb, &t, (0, 0, 2, 2), MergeOptions { across: true, ..Default::default() }).expect("Merge Across A1:C3");
    assert_eq!(
        backing_merges(&wb, backing),
        vec![region(0, 0, 0, 2), region(1, 0, 1, 2), region(2, 0, 2, 2)],
        "one region per row"
    );
    undo_once(&wb);
    assert!(backing_merges(&wb, backing).is_empty(), "Merge Across is ONE undo step");

    // ABSORB: B2:C2 merged on the backing sheet, then A1:C3 merged around it
    // -- absorbed by every merge, as Excel's Range.Merge does (the `absorb`
    // option that once asked for it is gone; without it this used to refuse).
    merge(&wb, &t, (1, 1, 1, 2), MergeOptions::default()).expect("merge B2:C2");
    let before = depth(&wb);
    let result = merge(&wb, &t, (0, 0, 2, 2), MergeOptions::default()).expect("absorb");
    assert_eq!(result.removed_regions, vec![region(1, 1, 1, 2)], "the inner region is dissolved");
    assert_eq!(backing_merges(&wb, backing), vec![region(0, 0, 2, 2)], "and only the new one is left");
    assert_eq!(depth(&wb), before + 1);
    undo_once(&wb);
    assert_eq!(backing_merges(&wb, backing), vec![region(1, 1, 1, 2)], "one Ctrl+Z puts the inner region back");

    // A PARTIAL overlap merges the UNION (Excel [LIVE]; it used to refuse):
    // A1:B2 over B2:C2 is A1:C2.
    let result = merge(&wb, &t, (0, 0, 1, 1), MergeOptions::default()).expect("partial overlap merges the union");
    assert_eq!(result.removed_regions, vec![region(1, 1, 1, 2)]);
    assert_eq!(backing_merges(&wb, backing), vec![region(0, 0, 1, 2)], "the union A1:C2");
}

#[test]
fn keep_first_value_moves_the_value_and_re_points_its_readers_on_the_backing_sheet() {
    // Ruling Q4: ONE merge behaviour. The sheet gesture's keep-first-value
    // works on a floating grid too.
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    type_in(&wb, &t, 0, 1, "42"); // B1 holds the first value; A1 is empty
    type_in(&wb, &t, 2, 0, "=B1+1"); // A3 reads B1

    let result = merge(&wb, &t, (0, 0, 0, 1), MergeOptions::default())
        .expect("merge A1:B1 keeping the first value");
    assert_eq!(result.moved_cells.len(), 1);
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Number(42.0), "the value moved into A1");
    assert_eq!(backing_value(&wb, backing, 0, 1), CellValue::Empty);
    let a3 = backing_cell(&wb, backing, 2, 0).expect("A3");
    assert_eq!(a3.formula_string().as_deref(), Some("A1+1"), "the reader follows the moved value");
    assert_eq!(a3.value, CellValue::Number(43.0));

    undo_once(&wb);
    assert_eq!(backing_value(&wb, backing, 0, 1), CellValue::Number(42.0), "one Ctrl+Z restores B1");
    assert_eq!(
        backing_cell(&wb, backing, 2, 0).and_then(|c| c.formula_string()).as_deref(),
        Some("B1+1"),
        "and the reader's text"
    );
    assert!(backing_merges(&wb, backing).is_empty());
}

/// rev6A#4. The floating-grid merge re-pointed its backing sheet with the
/// sheet-blind `relocate_references_in_formula` while the sheet gesture used the
/// move rule, so one gesture gave two answers: a backing formula reading the
/// HOST's B1 was renumbered to the host's A1, a reader of the empty top-left
/// silently read the moved value, and the moved formula `=A8+5` landed on A8
/// reading itself. Excel [LIVE, Excel 16, 2026-10-30, shifters/probemerge.ps1,
/// merge A1:B1 with A1 empty]: `=Sheet2!B1` stays, `=A1` is `=#REF!`, `=B1` is
/// `=A1`, `=SUM(A1:B1)` is `=SUM(A1:A1)`, `=Sheet1!B1` is `=Sheet1!A1`, and a
/// moved `=A1+5` is `=#REF!+5`.
#[test]
fn keep_first_value_re_points_the_backing_sheet_the_way_excel_moves_the_value() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 8, 3);
    let backing_name = wb.state.sheet_names.read().unwrap()[backing].clone();
    wb.set(0, 0, "5"); // the HOST's A1
    wb.set(0, 1, "7"); // the HOST's B1
    type_in(&wb, &t, 0, 1, "42"); // the grid's B1 holds the first value; A1 is empty
    type_in(&wb, &t, 1, 0, "=Sheet1!B1"); // A2 reads the HOST's B1
    type_in(&wb, &t, 2, 0, "=A1"); // A3 reads the empty top-left
    type_in(&wb, &t, 3, 0, "=B1"); // A4 reads the value that moves
    type_in(&wb, &t, 4, 0, "=SUM(A1:B1)"); // A5
    let qualifier = engine::ast_render::quote_sheet_name(&backing_name);
    type_in(&wb, &t, 5, 0, &format!("={}!B1", qualifier)); // A6, qualified with its own sheet
    type_in(&wb, &t, 6, 0, "=Sheet1!A1"); // A7 reads the HOST's A1
    type_in(&wb, &t, 7, 1, "=A8+5"); // B8 reads the empty A8 it will be moved onto
    type_in(&wb, &t, 7, 2, "=C1*2"); // C8: a formula outside both merges, reading outside them
    // UPPERCASED: a qualifier keeps the case it was typed in, and these checks
    // are about where a reference points.
    let formula = |row: u32, col: u32| {
        backing_cell(&wb, backing, row, col).and_then(|c| c.formula_string()).map(|f| f.to_ascii_uppercase())
    };
    assert_eq!(backing_value(&wb, backing, 1, 0), CellValue::Number(7.0), "precondition: A2 reads the host");

    merge(&wb, &t, (0, 0, 0, 1), MergeOptions::default())
        .expect("merge A1:B1 keeping the first value");
    // The moved formula itself is re-pointed too: it read the cell it landed on.
    merge(&wb, &t, (7, 0, 7, 1), MergeOptions::default())
        .expect("merge A8:B8 keeping the first value");

    // Every disagreement with Excel is listed, not just the first.
    let mut wrong: Vec<String> = Vec::new();
    let mut check = |what: &str, got: String, excel: String| {
        if got != excel {
            wrong.push(format!("{what}: Excel {excel}, Calcula {got}"));
        }
    };
    let shown = |row: u32, col: u32| formula(row, col).unwrap_or_else(|| format!("{:?}", backing_value(&wb, backing, row, col)));
    check("A1, the merged cell", format!("{:?}", backing_value(&wb, backing, 0, 0)), format!("{:?}", CellValue::Number(42.0)));
    check("A2 =Sheet1!B1 (the host's B1, not the moved B1)", shown(1, 0), "SHEET1!B1".into());
    check("A2's value", format!("{:?}", backing_value(&wb, backing, 1, 0)), format!("{:?}", CellValue::Number(7.0)));
    check("A3 =A1 (the top-left the value overwrote)", shown(2, 0), "#REF!".into());
    check("A3's value", format!("{:?}", backing_value(&wb, backing, 2, 0)), format!("{:?}", CellValue::Error(engine::CellError::Ref)));
    check("A4 =B1 (the moved value)", shown(3, 0), "A1".into());
    check("A4's value", format!("{:?}", backing_value(&wb, backing, 3, 0)), format!("{:?}", CellValue::Number(42.0)));
    check("A5 =SUM(A1:B1)", shown(4, 0), "SUM(A1:A1)".into());
    check("A6, qualified with the backing sheet's own name", shown(5, 0), format!("{}!A1", qualifier.to_ascii_uppercase()));
    check("A7 =Sheet1!A1 (the host's A1, never overwritten)", shown(6, 0), "SHEET1!A1".into());
    check("A7's value", format!("{:?}", backing_value(&wb, backing, 6, 0)), format!("{:?}", CellValue::Number(5.0)));
    check("A8, the moved =A8+5 (it read the cell it landed on)", shown(7, 0), "#REF!+5".into());
    check("C8 =C1*2 (outside both merges)", shown(7, 2), "C1*2".into());
    assert!(wrong.is_empty(), "the floating-grid merge disagrees with Excel:\n  {}", wrong.join("\n  "));

    // One Ctrl+Z per merge puts every formula back.
    undo_once(&wb);
    assert_eq!(formula(7, 1).as_deref(), Some("A8+5"));
    undo_once(&wb);
    assert_eq!(formula(1, 0).as_deref(), Some("SHEET1!B1"));
    assert_eq!(formula(2, 0).as_deref(), Some("A1"));
    assert_eq!(formula(3, 0).as_deref(), Some("B1"));
    assert_eq!(backing_value(&wb, backing, 0, 1), CellValue::Number(42.0), "B1 is back");
}

#[test]
fn unmerging_a_range_on_a_floating_grid_dissolves_every_intersecting_backing_region_in_one_step() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    merge(&wb, &t, (0, 0, 0, 1), MergeOptions::default()).unwrap();
    merge(&wb, &t, (2, 0, 3, 0), MergeOptions::default()).unwrap();
    merge(&wb, &t, (2, 2, 3, 2), MergeOptions::default()).unwrap();

    let before = depth(&wb);
    let result = crate::merge_commands::unmerge_cells_on_target(&wb.state, &wb.file, &t, 0, 0, Some(2), Some(1))
        .expect("unmerge A1:B3");
    assert_eq!(result.removed_regions, vec![region(0, 0, 0, 1), region(2, 0, 3, 0)]);
    assert_eq!(backing_merges(&wb, backing), vec![region(2, 2, 3, 2)], "the region outside the range stays");
    assert_eq!(depth(&wb), before + 1, "ONE undo step");
    undo_once(&wb);
    assert_eq!(backing_merges(&wb, backing).len(), 3, "one Ctrl+Z restores both");
}

// ---------------------------------------------------------------------------
// Search and Go To Special
// ---------------------------------------------------------------------------

#[test]
fn find_and_replace_on_a_floating_grid_search_the_backing_sheet_and_leave_the_host_alone() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 2);
    type_in(&wb, &t, 0, 0, "c");
    type_in(&wb, &t, 2, 0, "d");
    type_in(&wb, &t, 3, 1, "dd");
    wb.set(2, 0, "d"); // the HOST's A3 holds the same text

    let found = crate::commands::search::find_all_on(&wb.state, "d", false, false, false, None, Some(&t)).expect("find");
    assert_eq!(found.matches, vec![(2, 0), (3, 1)], "the backing sheet's matches, in the grid's coordinates");

    let before = depth(&wb);
    let replaced = crate::commands::search::replace_all_on_target(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, None, &t,
        "d".to_string(), "z".to_string(), false, false,
    )
    .expect("replace all");
    assert_eq!(replaced.replacement_count, 2);
    assert_eq!(depth(&wb), before + 1, "Replace All is ONE undo step");
    assert_eq!(backing_value(&wb, backing, 2, 0), text("z"));
    assert_eq!(backing_value(&wb, backing, 3, 1), text("zz"));
    assert_eq!(active_value(&wb, 2, 0), text("d"), "the host's A3 is left alone");

    let one = crate::commands::search::replace_single_on_target(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, None, &t, 0, 0,
        "c".to_string(), "q".to_string(), false,
    )
    .expect("replace one");
    assert!(one.is_some());
    assert_eq!(backing_value(&wb, backing, 0, 0), text("q"));

    protect_host(&wb, SheetProtectionOptions::default());
    let err = assert_clean_refusal(&wb, "replace on a protected host", || {
        crate::commands::search::replace_all_on_target(
            &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, None, &t,
            "z".to_string(), "y".to_string(), false, false,
        )
    });
    assert!(err.contains("Cannot change cell"), "got: {err}");
}

#[test]
fn go_to_special_on_a_floating_grid_reads_the_backing_sheet_and_answers_last_cell_itself() {
    let wb = Workbook::new(1);
    let (t, _backing) = float1(&wb, 4, 3);
    type_in(&wb, &t, 0, 0, "1");
    type_in(&wb, &t, 1, 2, "x");
    type_in(&wb, &t, 2, 1, "=A1*2");
    wb.set(3, 0, "host constant"); // the HOST's A4: never a match

    let constants = crate::commands::nav::go_to_special_on_target(&wb.state, "constants", None, &t).expect("constants");
    let cells: Vec<(u32, u32)> = constants.cells.iter().map(|c| (c.row, c.col)).collect();
    assert_eq!(cells, vec![(0, 0), (1, 2)], "the backing sheet's constants only");

    let formulas = crate::commands::nav::go_to_special_on_target(&wb.state, "formulas", Some((0, 0, 3, 2)), &t).unwrap();
    assert_eq!(formulas.cells.iter().map(|c| (c.row, c.col)).collect::<Vec<_>>(), vec![(2, 1)]);

    let last = crate::commands::nav::go_to_special_on_target(&wb.state, "lastCell", None, &t).unwrap();
    assert_eq!(
        last.cells.iter().map(|c| (c.row, c.col)).collect::<Vec<_>>(),
        vec![(2, 2)],
        "the backing used range's far corner"
    );
}

// ---------------------------------------------------------------------------
// Conditional formatting
// ---------------------------------------------------------------------------

#[test]
fn a_rule_added_with_a_target_lives_on_the_backing_sheet_and_the_styled_read_carries_it() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 2);
    for (row, n) in ["10", "20", "30"].iter().enumerate() {
        type_in(&wb, &t, row as u32 + 1, 1, n);
    }
    let added = crate::conditional_formatting::add_conditional_format_impl(
        &wb.state,
        &wb.file,
        AddCFParams {
            rule: ConditionalFormatRule::CellValue(CellValueRule {
                operator: CellValueOperator::GreaterThan,
                value1: "15".to_string(),
                value2: None,
            }),
            format: ConditionalFormat { background_color: Some("#FFC7CE".to_string()), ..Default::default() },
            ranges: vec![ConditionalFormatRange { start_row: 1, start_col: 1, end_row: 3, end_col: 1 }],
            stop_if_true: false,
            target: Some(t.clone()),
        },
    );
    assert!(added.success, "{:?}", added.error);
    let rule_id = added.rule.expect("the rule").id;
    {
        let cf = wb.state.conditional_formats.read().unwrap();
        assert_eq!(cf.get(&backing).map(|r| r.len()), Some(1), "stored under the BACKING index");
        assert!(cf.get(&0).map(|r| r.is_empty()).unwrap_or(true), "the host has no rule");
    }
    assert!(
        crate::conditional_formatting::get_all_conditional_formats_on(&wb.state, None, None).unwrap().is_empty(),
        "the active sheet's list is empty"
    );
    assert_eq!(
        crate::conditional_formatting::get_all_conditional_formats_on(&wb.state, None, Some(&t)).unwrap().len(),
        1,
        "the grid's list has it"
    );

    let read = crate::cell_target::get_cell_target_cells_inner(&wb.state, &t, 0, 0, 3, 1).unwrap();
    let hits: Vec<(u32, u32)> = read.conditional.iter().map(|c| (c.row, c.col)).collect();
    assert_eq!(hits, vec![(2, 1), (3, 1)], "evaluated on the backing grid: B3 and B4, not B2");
    assert_eq!(read.rules.iter().map(|r| r.id).collect::<Vec<_>>(), vec![rule_id], "and the read carries the rule");

    // Clear Rules from the grid's cells: the backing rule is cut.
    let changed = crate::conditional_formatting::clear_conditional_formats_in_range_on_target(
        &wb.state, &wb.file, 0, 0, 3, 1, None, &t,
    )
    .unwrap();
    assert_eq!(changed, 1);
    assert!(crate::conditional_formatting::get_all_conditional_formats_on(&wb.state, None, Some(&t)).unwrap().is_empty());

    // A protected host without Format Cells refuses a new rule.
    protect_host(&wb, SheetProtectionOptions::default());
    crate::document_effect::mark_saved(&wb.file);
    let refused = crate::conditional_formatting::add_conditional_format_impl(
        &wb.state,
        &wb.file,
        AddCFParams {
            rule: ConditionalFormatRule::NoBlanks,
            format: ConditionalFormat::default(),
            ranges: vec![ConditionalFormatRange { start_row: 0, start_col: 0, end_row: 0, end_col: 0 }],
            stop_if_true: false,
            target: Some(t.clone()),
        },
    );
    assert!(!refused.success, "refused on a protected host");
    assert!(!wb.file.is_dirty(), "and the document stays clean");
}
