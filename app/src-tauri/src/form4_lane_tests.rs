//! FILENAME: app/src-tauri/src/form4_lane_tests.rs
//! PURPOSE: Ledger programme 2, wave 4, lane `form4` -- renaming a name
//! repoints its SHEET-QUALIFIED readers (`=Sheet1!Dup`) by the qualifier's
//! scope, and an XLOOKUP range half's if-not-found reference is a precedent,
//! driven through the real command bodies.
//!
//! [LIVE, Excel 16, 2026-11-06, lane form4, SCRATCH/form4/rename.ps1 ->
//! rename.log and rename2.log, probe2.ps1 -> p2.log] -- each test cites the
//! measurement it holds Calcula to.

use crate::named_ranges::{create_named_range_impl, rename_named_range_scoped_impl};
use crate::persistence::{FileState, UserFilesState};
use crate::AppState;
use engine::CellValue;
use std::collections::{HashMap, HashSet};

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
    /// `Sheet1` (active) and `Sheet2`.
    fn new() -> Self {
        let state = crate::create_app_state();
        *state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
        let seed = crate::document_effect::test_seed_effect();
        state.grids.write(&seed).unwrap().push(engine::Grid::new());
        state.sheet_names.write(&seed).unwrap().push("Sheet2".to_string());
        state.all_column_widths.write(&seed).unwrap().push(HashMap::new());
        state.all_row_heights.write(&seed).unwrap().push(HashMap::new());
        state.all_user_hidden_rows.write(&seed).unwrap().push(HashSet::new());
        state.all_user_hidden_cols.write(&seed).unwrap().push(HashSet::new());
        state.sheet_ids.write(&seed).unwrap().push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        {
            let mut all = state.all_merged_regions.write(&seed).unwrap();
            while all.len() < 2 {
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

    /// A cell on the ACTIVE sheet.
    fn set(&self, row: u32, col: u32, value: &str) {
        crate::commands::data::update_cell_impl(
            &self.state, &self.file, &self.files, &self.slicer, &self.pivots, &self.pane, &self.filters,
            row, col, value.to_string(), None, None, None,
        )
        .unwrap_or_else(|e| panic!("update_cell({},{}) failed: {}", row, col, e));
    }

    fn activate(&self, sheet: usize) {
        crate::sheets::activate_sheet(&self.state, sheet).expect("switch sheet");
    }

    fn define(&self, name: &str, scope: Option<usize>, refers_to: &str) {
        let r = create_named_range_impl(&self.state, &self.file, name.to_string(), scope, refers_to.to_string(), None, None);
        assert!(r.success, "{}: {:?}", name, r.error);
    }

    fn value(&self, sheet: usize, row: u32, col: u32) -> CellValue {
        let active = *self.state.active_sheet.read().unwrap();
        let value = if sheet == active {
            self.state.grid.read().unwrap().get_cell(row, col).map(|c| c.value.clone())
        } else {
            self.state.grids.read().unwrap()[sheet].get_cell(row, col).map(|c| c.value.clone())
        };
        value.unwrap_or(CellValue::Empty)
    }

    fn formula(&self, sheet: usize, row: u32, col: u32) -> Option<String> {
        let active = *self.state.active_sheet.read().unwrap();
        if sheet == active {
            self.state.grid.read().unwrap().get_cell(row, col).and_then(|c| c.formula_string())
        } else {
            self.state.grids.read().unwrap()[sheet].get_cell(row, col).and_then(|c| c.formula_string())
        }
    }

    fn refers_to(&self, name: &str) -> String {
        let names = self.state.named_ranges.read().unwrap();
        names
            .values()
            .find(|nr| nr.name.eq_ignore_ascii_case(name))
            .map(|nr| nr.refers_to.clone())
            .unwrap_or_else(|| panic!("no name {name}"))
    }

    fn recalc(&self, names: &[&str]) {
        let names: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        crate::named_ranges::recalc_after_name_change(&self.state, &self.files, &self.pivots, &self.pane, &self.filters, &names);
    }
}

fn n(v: f64) -> CellValue {
    CellValue::Number(v)
}

/// The probe's workbook: a workbook Dup = 1 and a Sheet1-scoped Dup = 2, and
/// on each sheet a plain `=Dup` and both qualified spellings (column A,
/// rows 1-3 of SCRATCH/form4/rename.ps1).
fn probe_workbook() -> Wb {
    let wb = Wb::new();
    wb.define("Dup", None, "=1");
    wb.define("Dup", Some(0), "=2");
    // Two workbook names whose DEFINITIONS read Dup qualified.
    wb.define("ViaOne", None, "=Sheet1!Dup*10");
    wb.define("ViaTwo", None, "=Sheet2!Dup*10");
    wb.set(0, 0, "=Dup");
    wb.set(1, 0, "=Sheet2!Dup");
    wb.set(2, 0, "=Sheet1!Dup");
    wb.activate(1);
    wb.set(0, 0, "=Sheet1!Dup");
    wb.set(1, 0, "=Dup");
    wb.set(2, 0, "=Sheet2!Dup");
    wb.activate(0);
    assert_eq!(
        [wb.value(0, 0, 0), wb.value(0, 1, 0), wb.value(0, 2, 0), wb.value(1, 0, 0), wb.value(1, 1, 0), wb.value(1, 2, 0)],
        [n(2.0), n(1.0), n(2.0), n(2.0), n(1.0), n(1.0)],
        "the probe's starting values (W_INIT)"
    );
    wb
}

/// Renaming the WORKBOOK Dup to DupW. [LIVE, rename.log W_RENAMED] Sheet2's
/// `=Sheet1!Dup` stays `=Sheet1!Dup` = 2 (it reads Sheet1's own Dup), Sheet1's
/// `=Sheet2!Dup` and Sheet2's `=Sheet2!Dup` become the workbook DupW = 1
/// (Excel spells them `Book1!DupW`; Calcula keeps the qualifier, which reads
/// the same name), Sheet2's `=Dup` becomes `=DupW`, and Sheet1's `=Dup` and
/// `=Sheet1!Dup` stay. Calcula walked the qualified node as two plain names:
/// Sheet2's `=Sheet1!Dup` was rewritten to `Sheet1!DupW` -- the WORKBOOK DupW,
/// 1 after a recalculation -- and Sheet1, whose own Dup shadows the
/// workbook's, was skipped whole, so its `=Sheet2!Dup` went #NAME?. A name's
/// definition follows the same rule.
///
/// SABOTAGE (form4-ren): `qualifier_denotes` answers "every qualifier" --
/// fails at "QUALIFIED READER OF SHEET1'S OWN DUP".
#[test]
fn renaming_a_workbook_name_repoints_its_qualified_readers_by_their_qualifier() {
    let wb = probe_workbook();
    let r = rename_named_range_scoped_impl(&wb.state, &wb.file, "Dup", "DupW", None);
    assert!(r.success, "{:?}", r.error);
    wb.recalc(&["Dup", "DupW"]);

    assert_eq!(wb.formula(1, 0, 0).as_deref(), Some("Sheet1!Dup"), "QUALIFIED READER OF SHEET1'S OWN DUP");
    assert_eq!(wb.value(1, 0, 0), n(2.0), "Sheet2's =Sheet1!Dup keeps reading Sheet1's Dup");
    assert_eq!(wb.formula(0, 1, 0).as_deref(), Some("Sheet2!DupW"), "QUALIFIED READER ON A SHADOWED SHEET");
    assert_eq!(wb.value(0, 1, 0), n(1.0), "Sheet1's =Sheet2!Dup reads the renamed workbook name");
    assert_eq!(wb.formula(1, 2, 0).as_deref(), Some("Sheet2!DupW"));
    assert_eq!(wb.value(1, 2, 0), n(1.0));
    assert_eq!(wb.formula(1, 1, 0).as_deref(), Some("DupW"), "Sheet2's plain =Dup");
    assert_eq!(wb.formula(0, 0, 0).as_deref(), Some("Dup"), "Sheet1's plain =Dup is its own");
    assert_eq!(wb.formula(0, 2, 0).as_deref(), Some("Sheet1!Dup"));
    assert_eq!(wb.value(0, 2, 0), n(2.0));
    assert_eq!(wb.refers_to("ViaOne"), "=Sheet1!Dup*10", "A DEFINITION reading Sheet1's own Dup");
    assert_eq!(wb.refers_to("ViaTwo"), "=Sheet2!DupW*10", "A DEFINITION reading the workbook Dup");
}

/// Renaming SHEET1's own Dup to DupL -- the other direction. [LIVE,
/// rename2.log L_RENAMED] Sheet2's `=Sheet1!Dup` becomes `=Sheet1!DupL` = 2,
/// Sheet1's `=Dup` and `=Sheet1!Dup` become `DupL` / `Sheet1!DupL`, and
/// Sheet2's `=Dup` and both `=Sheet2!Dup` (the workbook's) stay. (`Dup2` is a
/// CELL, DUP2, so Excel silently kept the old name for it.) Calcula walked
/// only Sheet1's grid, so Sheet2's `=Sheet1!Dup` was never repointed and fell
/// back to the workbook Dup.
#[test]
fn renaming_a_sheet_name_repoints_its_qualified_readers_on_every_sheet() {
    let wb = probe_workbook();
    let r = rename_named_range_scoped_impl(&wb.state, &wb.file, "Dup", "DupL", Some(0));
    assert!(r.success, "{:?}", r.error);
    wb.recalc(&["Dup", "DupL"]);

    assert_eq!(wb.formula(1, 0, 0).as_deref(), Some("Sheet1!DupL"), "SHEET2'S QUALIFIED READER OF SHEET1'S DUP");
    assert_eq!(wb.value(1, 0, 0), n(2.0));
    assert_eq!(wb.formula(0, 2, 0).as_deref(), Some("Sheet1!DupL"));
    assert_eq!(wb.formula(0, 0, 0).as_deref(), Some("DupL"), "Sheet1's plain =Dup is its own");
    assert_eq!(wb.value(0, 0, 0), n(2.0));
    assert_eq!(wb.formula(1, 1, 0).as_deref(), Some("Dup"), "Sheet2's plain =Dup is the workbook's");
    assert_eq!(wb.formula(0, 1, 0).as_deref(), Some("Sheet2!Dup"), "=Sheet2!Dup reads the workbook's");
    assert_eq!(wb.value(0, 1, 0), n(1.0));
    assert_eq!(wb.refers_to("ViaOne"), "=Sheet1!DupL*10");
    assert_eq!(wb.refers_to("ViaTwo"), "=Sheet2!Dup*10");
}

/// `=SUM(C1:XLOOKUP(99,C1:C5,C1:C5,E9))` -- no match, so the half is E9 and
/// the sum spans C1:E9. [LIVE, Excel 16, lane form4 p2.log XL1/XL2] it is
/// 122 and an edit of D5 to 1000 makes it 1122. The precedent span took only
/// the return array, so D5 was no precedent and the sum stayed 122.
///
/// SABOTAGE (form4-xl): the if-not-found argument is dropped from the span --
/// fails at "IF-NOT-FOUND PRECEDENT".
#[test]
fn an_xlookup_halfs_if_not_found_reference_is_a_precedent() {
    let wb = Wb::new();
    for r in 0..5u32 {
        wb.set(r, 2, &format!("{}", r + 1));
    }
    wb.set(8, 4, "100");
    wb.set(8, 3, "7");
    wb.set(0, 7, "=SUM(C1:XLOOKUP(99,C1:C5,C1:C5,E9))");
    assert_eq!(wb.value(0, 0, 7), n(122.0));
    wb.set(4, 3, "1000");
    assert_eq!(wb.value(0, 0, 7), n(1122.0), "IF-NOT-FOUND PRECEDENT");
}
