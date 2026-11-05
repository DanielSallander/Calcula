//! FILENAME: app/src-tauri/src/namese_tests.rs
//! PURPOSE: Lane `namese` -- what a defined name and a table name MEAN in the
//! cell that uses them, driven through the real entry path (`update_cell_impl`,
//! `split_entered_formula`) and the real evaluation path
//! (`name_resolution::eval_ast`).
//!
//! NEW-relative-name-anchor: a name's relative references mean the cell that
//! uses it. [LIVE, Excel 16, lane formd SCRATCH/formd/n1.txt; lane namese
//! SCRATCH/namese/p1.txt] with `rel` = `Sheet1!D1` (A1-relative text, as Excel
//! files it) `=ROW(rel)*1000+COLUMN(rel)` in J11 is 11013 (M11), a name used
//! in another name is relative to the same cell (14013 from J14), and
//! `Sheet1!$D1` keeps its column (D12 from J12).
//!
//! NEW-bare-table-name: a bare table name is the whole table. [LIVE, lane
//! namese p1] `=ROWS(Tbl)` 3, `=SUM(Tbl)` 9, the cell shows `=ROWS(Tbl)` and is
//! filed `ROWS(Tbl[])`, `=LET(Tbl,5,Tbl)` 5.

use crate::persistence::{FileState, UserFilesState};
use crate::AppState;
use engine::CellValue;
use std::collections::HashSet;

struct Wb {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    slicer: crate::slicer::SlicerState,
    pivots: crate::pivot::types::PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
}

impl Wb {
    fn new() -> Self {
        let state = crate::create_app_state();
        *state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
        let seed = crate::document_effect::test_seed_effect();
        {
            let mut all = state.all_merged_regions.write(&seed).unwrap();
            if all.is_empty() {
                all.push(HashSet::new());
            }
        }
        Wb {
            state,
            file: FileState::default(),
            files: UserFilesState::default(),
            slicer: crate::slicer::SlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
        }
    }

    fn set(&self, row: u32, col: u32, value: &str) {
        crate::commands::data::update_cell_impl(
            &self.state, &self.file, &self.files, &self.slicer, &self.pivots, &self.pane, &self.filters,
            row, col, value.to_string(), None, None, None,
        )
        .unwrap_or_else(|e| panic!("update_cell({},{}) failed: {}", row, col, e));
    }

    fn define(&self, name: &str, refers_to: &str) {
        let r = crate::named_ranges::create_named_range_impl(
            &self.state, &self.file, name.to_string(), None, refers_to.to_string(), None, None,
        );
        assert!(r.success, "{:?}", r.error);
    }

    fn table(&self, name: &str, rect: (u32, u32, u32, u32)) {
        let created = crate::tables::create_table_core(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters,
            crate::tables::CreateTableParams {
                name: name.to_string(),
                start_row: rect.0,
                start_col: rect.1,
                end_row: rect.2,
                end_col: rect.3,
                has_headers: true,
                style_options: None,
                style_name: None,
            },
        );
        assert!(created.success, "create {}: {:?}", name, created.error);
    }

    fn value(&self, row: u32, col: u32) -> CellValue {
        self.state.grids.read().unwrap()[0]
            .get_cell(row, col)
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    }

    fn number(&self, row: u32, col: u32) -> f64 {
        match self.value(row, col) {
            CellValue::Number(n) => n,
            other => panic!("({},{}) holds {:?}, not a number", row, col, other),
        }
    }

    /// (formula bar, stored text) of a cell.
    fn texts(&self, row: u32, col: u32) -> (String, String) {
        let grids = self.state.grids.read().unwrap();
        let cell = grids[0].get_cell(row, col).expect("a cell");
        (cell.formula_string().unwrap_or_default(), cell.formula_string_raw().unwrap_or_default())
    }

    /// D1:H20 = row*100 + column (1-based), the probe's data.
    fn grid_data(&self) {
        for r in 0..20u32 {
            for c in 3..8u32 {
                self.set(r, c, &format!("{}", (r + 1) * 100 + c + 1));
            }
        }
    }
}

/// Sabotage target (namese-anchor): `resolve_names_in_ast_at` skips
/// `anchor_name_references` -- every name then means its literal cell.
#[test]
fn a_relative_name_means_the_cell_that_uses_it() {
    let wb = Wb::new();
    wb.grid_data();
    wb.define("rel", "=Sheet1!D1");
    wb.define("relmix", "=Sheet1!$D1");
    wb.define("relrng", "=Sheet1!D1:E2");
    wb.define("relin", "=rel");
    wb.set(10, 9, "=ROW(rel)*1000+COLUMN(rel)"); // J11
    assert_eq!(wb.number(10, 9), 11013.0, "rel from J11 is M11, as Excel reads it");
    wb.set(11, 9, "=relmix"); // J12
    assert_eq!(wb.number(11, 9), 1204.0, "relmix from J12 is $D12");
    wb.set(13, 9, "=ROW(relin)*1000+COLUMN(relin)"); // J14
    assert_eq!(wb.number(13, 9), 14013.0, "a name inside a name is relative to the same cell");
    wb.set(14, 0, "=SUM(relrng)"); // A15: D15:E16
    assert_eq!(wb.number(14, 0), 1504.0 + 1505.0 + 1604.0 + 1605.0, "relrng from A15 is D15:E16");
    wb.set(0, 0, "=rel"); // A1: D1 itself
    assert_eq!(wb.number(0, 0), 104.0, "used in A1, the name is its own text");
    // The cell keeps the NAME (D2).
    assert_eq!(wb.texts(10, 9).0, "ROW(rel)*1000+COLUMN(rel)");
}

/// A relative name's PRECEDENTS are the using cell's own: editing the cell the
/// name means there recalculates the formula, and editing the name's literal
/// cell does not reach it.
#[test]
fn a_relative_names_precedent_is_registered_per_using_cell() {
    let wb = Wb::new();
    wb.define("rel", "=Sheet1!D1");
    wb.set(4, 0, "=rel*2"); // A5 -> D5
    wb.set(7, 1, "=rel*2"); // B8 -> E8
    wb.set(4, 3, "21"); // D5
    assert_eq!(wb.number(4, 0), 42.0, "A5 follows D5");
    wb.set(7, 4, "5"); // E8
    assert_eq!(wb.number(7, 1), 10.0, "B8 follows E8");
    wb.set(4, 3, "50");
    assert_eq!(wb.number(4, 0), 100.0, "A5 recalculates when D5 changes");
    assert_eq!(wb.number(7, 1), 10.0, "B8 does not read D5");
}

/// Sabotage target (namese-bare): `bind_bare_table_names` declines every name.
#[test]
fn a_bare_table_name_is_the_whole_table() {
    let wb = Wb::new();
    wb.set(0, 0, "H1");
    wb.set(0, 1, "H2");
    for (r, a, b) in [(1u32, "-1", "4"), (2, "2", "-5"), (3, "3", "6")] {
        wb.set(r, 0, a);
        wb.set(r, 1, b);
    }
    wb.table("Tbl", (0, 0, 3, 1));
    wb.set(0, 9, "=ROWS(Tbl)");
    assert_eq!(wb.number(0, 9), 3.0, "=ROWS(Tbl) is 3 in Excel");
    let (shown, stored) = wb.texts(0, 9);
    assert_eq!(shown, "ROWS(Tbl)", "the formula bar shows the bare name");
    assert_eq!(stored, "ROWS(Tbl[])", "stored as Excel files it");
    wb.set(1, 9, "=SUM(tbl)");
    assert_eq!(wb.number(1, 9), 9.0);
    wb.set(2, 9, "=ROWS(Tbl[])");
    assert_eq!(wb.number(2, 9), 3.0);
    assert_eq!(wb.texts(2, 9).0, "ROWS(Tbl)", "Tbl[] shows as Tbl");
    wb.set(3, 9, "=ROWS(Tbl[#Data])");
    assert_eq!(wb.texts(3, 9).0, "ROWS(Tbl[#Data])", "an explicit #Data is kept as typed");
    wb.set(4, 9, "=LET(Tbl,5,Tbl)");
    assert_eq!(wb.number(4, 9), 5.0, "the LET binding wins");
    // A defined name whose definition is the bare table name.
    wb.define("Data", "=Tbl");
    wb.set(5, 9, "=COLUMNS(Data)");
    assert_eq!(wb.number(5, 9), 2.0, "a name that is the bare table name");
    // The table edge: a data cell edited recalculates the bare-name formula.
    wb.set(1, 0, "10");
    assert_eq!(wb.number(1, 9), 20.0, "=SUM(Tbl) follows the table's cells");
}

/// NEW-let-duplicate-case through the entry path: Excel refuses the formula
/// (the typed text is not taken as a formula).
#[test]
fn a_let_name_declared_twice_by_case_is_not_taken_as_a_formula() {
    let wb = Wb::new();
    wb.set(0, 0, "=LET(ab,1,AB,2,ab+aB)");
    let grids = wb.state.grids.read().unwrap();
    let cell = grids[0].get_cell(0, 0);
    assert!(
        cell.and_then(|c| c.get_ast()).is_none(),
        "Excel refuses =LET(ab,1,AB,2,ab+aB) at entry; Calcula held {:?}",
        cell.map(|c| c.value.clone())
    );
}
