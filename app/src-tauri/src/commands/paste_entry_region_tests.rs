//! FILENAME: app/src-tauri/src/commands/paste_entry_region_tests.rs
//! PURPOSE: Two rules of the cell BATCH (`update_cells_batch_core` and its
//! entries), round D lane pastec:
//!
//! - NEW-paste-fallback-text: a PASTE is not typing. A pasted LET / LAMBDA
//!   formula that declares a cell-shaped name and holds a `$` reference used
//!   to be put through the ENTRY checks (`parser::check_entered_formula`,
//!   `refuse_unspellable_in_r1c1`) and land as a TEXT cell. Excel [LIVE, round
//!   C shiftnames probeA copyUp]: `=LET(A1,5,A1+RC4)` (stored `$D2`) copied up
//!   a row pastes `=LET(A1,5,A1+$D1)`.
//! - NEW-paste-pivot-region: a write into a PivotTable / report output region
//!   is refused whole before any effect on EVERY batch route -- the script /
//!   MCP route (`apply_script_modified_grids_core`, every changed sheet) as
//!   well as the `update_cells_batch` command -- in Excel's words
//!   [LIVE, Excel 16 COM, 2026-11-05, pastec/probe-pivot.ps1], with a `.calp`
//!   merge's version overlay exempt only by its explicit `RegionGate`.
//!
//! A CHILD module of `commands::data` (declared with `#[path]` there), driving
//! the real bodies through the shared `cross_sheet_recalc_tests::Workbook`.

use super::cross_sheet_recalc_tests::Workbook;
use super::*;
use crate::api_types::{CellUpdateInput, PasteSource};
use engine::CellValue;

fn workbook(sheets: usize) -> Workbook {
    let wb = Workbook::new(sheets);
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
    wb
}

fn write(row: u32, col: u32, value: &str, pasted: bool) -> CellUpdateInput {
    CellUpdateInput {
        row,
        col,
        value: value.to_string(),
        style_index: None,
        invariant: Some(true),
        pasted: pasted.then_some(true),
        moved: None,
        source: None,
    }
}

fn batch(wb: &Workbook, updates: Vec<CellUpdateInput>) {
    update_cells_batch_core(&wb.state, &wb.file, &wb.files, &wb.pivots, updates, None, None, None, None)
        .expect("the batch writes");
}

fn active_cell(wb: &Workbook, row: u32, col: u32) -> engine::Cell {
    wb.state.grid.read().unwrap().get_cell(row, col).cloned().expect("a stored cell")
}

// ---------------------------------------------------------------------------
// NEW-paste-fallback-text
// ---------------------------------------------------------------------------

// SABOTAGE (pastec-rs1): the batch's `pasted_write` forced false -> the pasted
// formula is put through the entry checks and lands as the TEXT
// "=LET(A1,5,A1+$D1)".
#[test]
fn pastec_a_pasted_let_formula_with_a_dollar_reference_stays_a_formula() {
    let wb = workbook(1);
    wb.set(0, 3, "7"); // D1
    batch(&wb, vec![write(0, 4, "=LET(A1,5,A1+$D1)", true)]);
    let e1 = active_cell(&wb, 0, 4);
    assert!(e1.has_formula(), "the pasted formula landed as text: {:?}", e1.value);
    assert_eq!(e1.formula_string().as_deref(), Some("LET(A1,5,A1+$D1)"));
    assert_eq!(e1.value, CellValue::Number(12.0));
}

/// Excel's own case: the copied cell is `=LET(A1,5,A1+RC4)` (stored `$D2`),
/// pasted one row up from its SOURCE (`CellUpdateInput::source`, BUG-0657) --
/// the shift writes `$D1`, which the formula could not be TYPED with.
#[test]
fn pastec_a_source_let_formula_copied_up_a_row_pastes_its_dollar_reference_as_a_formula() {
    let wb = workbook(1);
    wb.set(0, 3, "7"); // D1
    wb.set(1, 3, "9"); // D2
    wb.set(1, 4, "=LET(A1,5,A1+RC4)"); // E2: this row's D
    let e2 = active_cell(&wb, 1, 4);
    assert_eq!(e2.formula_string().as_deref(), Some("LET(A1,5,A1+$D2)"), "the R1C1 head was not stored as $D2");
    let mut paste = write(0, 4, "stale", true);
    paste.source = Some(PasteSource { sheet_index: 0, row: 1, col: 4, target: None, values_only: None, unshifted: None });
    batch(&wb, vec![paste]);
    let e1 = active_cell(&wb, 0, 4);
    assert!(e1.has_formula(), "the pasted formula landed as text: {:?}", e1.value);
    assert_eq!(e1.formula_string().as_deref(), Some("LET(A1,5,A1+$D1)"));
    assert_eq!(e1.value, CellValue::Number(12.0));
}

/// Positive control: a TYPED write of the same text is still an entry, and
/// Excel refuses to TYPE it (`refuse_unspellable_in_r1c1`): the cell keeps
/// the text.
#[test]
fn pastec_the_same_formula_typed_is_still_refused_as_an_entry() {
    let wb = workbook(1);
    batch(&wb, vec![write(0, 4, "=LET(A1,5,A1+$D1)", false)]);
    let e1 = active_cell(&wb, 0, 4);
    assert!(!e1.has_formula(), "a TYPED formula skipped the entry checks");
    assert_eq!(e1.value, CellValue::Text("=LET(A1,5,A1+$D1)".to_string()));
}

// ---------------------------------------------------------------------------
// NEW-paste-pivot-region
// ---------------------------------------------------------------------------

fn add_region(wb: &Workbook, region_type: &str, sheet_index: usize) {
    wb.state.protected_regions.lock().unwrap().push(crate::ProtectedRegion {
        id: format!("{}-1", region_type),
        region_type: region_type.to_string(),
        owner_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        sheet_index,
        start_row: 10,
        start_col: 0,
        end_row: 15,
        end_col: 3,
        reserved_only: false,
    });
}

/// The grids a script run hands back: every sheet as it stands (the active one
/// from its mirror), with `writes` applied per sheet.
fn script_result(wb: &Workbook, writes: &[(usize, u32, u32, f64)]) -> Vec<engine::Grid> {
    let mut grids: Vec<engine::Grid> = wb.state.grids.read().unwrap().clone();
    grids[0] = wb.state.grid.read().unwrap().clone();
    for &(sheet, row, col, n) in writes {
        grids[sheet].set_cell(row, col, engine::Cell::new_number(n));
    }
    grids
}

fn apply(wb: &Workbook, grids: &[engine::Grid], regions: RegionGate, active_called: &std::cell::Cell<bool>) -> Result<(), String> {
    let active = |_updates: Vec<CellUpdateInput>, _cv: std::sync::Arc<crate::control_values::ControlValuesMap>| -> Result<(), String> {
        active_called.set(true);
        Ok(())
    };
    crate::scripting::commands::apply_script_modified_grids_core(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        grids,
        0,
        2,
        "script",
        "pastec-test",
        regions,
        &active,
    )
}

// SABOTAGE (pastec-rs2): the pre-pass's `check_batch_regions(state,
// active_sheet, ..)` call removed -> the run reaches the active-sheet write and
// installs Sheet2's cell before the batch's own gate could refuse.
#[test]
fn pastec_a_script_write_into_a_pivot_on_the_active_sheet_is_refused_before_any_sheet_is_touched() {
    let wb = workbook(2);
    add_region(&wb, "pivot", 0);
    let grids = script_result(&wb, &[(1, 0, 0, 7.0), (0, 11, 1, 5.0)]);
    let called = std::cell::Cell::new(false);
    let result = apply(&wb, &grids, RegionGate::Enforce, &called);
    assert_eq!(result, Err(PIVOT_WRITE_REFUSAL.to_string()));
    assert!(!called.get(), "the active-sheet write ran");
    assert!(
        wb.state.grids.read().unwrap()[1].get_cell(0, 0).is_none(),
        "Sheet2 was installed before the refusal"
    );
}

// SABOTAGE (pastec-rs3): the pre-pass's `check_batch_region_cells` loop
// removed -> Sheet2's pivot cell is installed wholesale.
#[test]
fn pastec_a_script_write_into_a_pivot_on_a_background_sheet_is_refused() {
    let wb = workbook(2);
    add_region(&wb, "bi", 1);
    let grids = script_result(&wb, &[(1, 12, 2, 5.0)]);
    let called = std::cell::Cell::new(false);
    let result = apply(&wb, &grids, RegionGate::Enforce, &called);
    assert_eq!(result, Err(PIVOT_WRITE_REFUSAL.to_string()));
    assert!(wb.state.grids.read().unwrap()[1].get_cell(12, 2).is_none(), "the background pivot cell was written");
}

/// A `.calp` merge / hold-back lays a version's own pivot output over this
/// workbook and names `VersionOverlay`: the region gate stands aside for it,
/// and for it alone.
#[test]
fn pastec_a_calp_version_overlay_writes_inside_a_pivot_region() {
    let wb = workbook(2);
    add_region(&wb, "pivot", 0);
    add_region(&wb, "pivot", 1);
    let grids = script_result(&wb, &[(1, 12, 2, 5.0), (0, 11, 1, 5.0)]);
    let called = std::cell::Cell::new(false);
    apply(&wb, &grids, RegionGate::VersionOverlay, &called).expect("the overlay applies");
    assert!(called.get(), "the active-sheet overlay was not written");
    assert_eq!(
        wb.state.grids.read().unwrap()[1].get_cell(12, 2).map(|c| c.value.clone()),
        Some(CellValue::Number(5.0))
    );
}

// SABOTAGE (pastec-rs4): `check_batch_regions` words every refusal as a write
// (`pasted` forced false) -> a paste gets the write sentence.
#[test]
fn pastec_the_region_gate_words_a_paste_and_a_write_as_excel_does_and_refuses_a_partial_overlap_whole() {
    let wb = workbook(1);
    add_region(&wb, "pivot", 0);
    // A two-cell paste crossing the pivot's bottom edge (row 15 in, row 16 out).
    let paste = vec![write(15, 1, "1", true), write(16, 1, "2", true)];
    assert_eq!(check_batch_regions(&wb.state, 0, &paste, RegionGate::Enforce), Err(PIVOT_PASTE_REFUSAL.to_string()));
    let typed = vec![write(16, 1, "2", false), write(11, 1, "1", false)];
    assert_eq!(check_batch_regions(&wb.state, 0, &typed, RegionGate::Enforce), Err(PIVOT_WRITE_REFUSAL.to_string()));
    // Outside every region, and the overlay: no refusal.
    assert_eq!(check_batch_regions(&wb.state, 0, &[write(16, 1, "2", true)], RegionGate::Enforce), Ok(()));
    assert_eq!(check_batch_regions(&wb.state, 0, &paste, RegionGate::VersionOverlay), Ok(()));
    // A report region keeps Calcula's own sentence, which names the cell.
    let reports = workbook(1);
    add_region(&reports, "report", 0);
    let refusal = check_batch_regions(&reports.state, 0, &paste, RegionGate::Enforce).unwrap_err();
    assert!(refusal.contains("part of a report"), "{refusal}");
}

/// The body has no region gate of its own (a `.calp` overlay may write inside
/// a pivot region, and that is the CALLER's explicit decision), so every
/// production caller of `update_cells_batch_core` must ask it first. A
/// tripwire against the hole this lane closed: a new Rust-side caller of the
/// body that skips the gate.
// SABOTAGE (pastec-rs5): the `check_batch_regions(..)` call in
// `update_cells_batch_with_controls` removed -> this goes red.
#[test]
fn every_production_batch_entry_asks_the_region_gate() {
    let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("read src").flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(&src_dir, &mut files);
    let mut callers: Vec<String> = Vec::new();
    for file in &files {
        let name = file.file_name().unwrap().to_string_lossy().to_string();
        if name.ends_with("tests.rs") || name.ends_with("_test.rs") {
            continue;
        }
        let text = std::fs::read_to_string(file).expect("read a source file");
        // The production part: everything before the file's first test item.
        let production = text.split("#[cfg(test)]").next().unwrap_or("");
        // The enclosing function of each call: the last item line declaring a
        // `fn` above it (comments skipped).
        let mut current_fn = String::from("<none>");
        for line in production.split('\n') {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") {
                continue;
            }
            for prefix in ["pub fn ", "pub(crate) fn ", "pub(super) fn ", "fn ", "async fn ", "pub async fn ", "pub(crate) async fn "] {
                if let Some(rest) = trimmed.strip_prefix(prefix) {
                    current_fn = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                    break;
                }
            }
            let code = line.split("//").next().unwrap_or("");
            if code.contains("update_cells_batch_core(") && !code.contains("fn update_cells_batch_core(") {
                callers.push(format!("{}::{}", name, current_fn));
            }
        }
    }
    callers.sort();
    assert_eq!(
        callers,
        vec!["data.rs::update_cells_batch".to_string(), "data.rs::update_cells_batch_with_controls".to_string()],
        "a new production caller of update_cells_batch_core: ask `check_batch_regions` first and add it here"
    );
    let data = include_str!("data.rs");
    for entry in ["pub fn update_cells_batch(", "pub(crate) fn update_cells_batch_with_controls("] {
        let start = data.find(entry).unwrap_or_else(|| panic!("no `{entry}`"));
        let body = &data[start..];
        let gate = body.find("check_batch_regions(").unwrap_or(usize::MAX);
        let core = body.find("update_cells_batch_core(").expect("the entry calls the core");
        assert!(gate < core, "`{entry}` reaches update_cells_batch_core without asking check_batch_regions first");
    }
}
