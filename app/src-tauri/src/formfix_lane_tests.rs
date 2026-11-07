//! FILENAME: app/src-tauri/src/formfix_lane_tests.rs
//! PURPOSE: Ledger programme 2, wave 3, lane `formfix` -- a SHEET-QUALIFIED
//! NAME in a formula (`=Sheet1!Rate`, BUG-0744/0749 remainder) read in the
//! named sheet's scope, its recalculation when the name changes, and the Name
//! Manager's arity message shown as Excel shows it, driven through the real
//! command bodies.
//!
//! [LIVE, Excel 16, 2026-11-06, lane formfix p1.json under
//! SCRATCH/formfix/] -- each test cites the measurement it holds Calcula to.

use crate::named_ranges::{create_named_range_impl, update_named_range_core};
use crate::persistence::{FileState, UserFilesState};
use crate::AppState;
use engine::{CellError, CellValue};
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

    fn define(&self, name: &str, scope: Option<usize>, refers_to: &str) -> crate::named_ranges::NamedRangeResult {
        create_named_range_impl(&self.state, &self.file, name.to_string(), scope, refers_to.to_string(), None, None)
    }

    fn redefine(&self, name: &str, scope: Option<usize>, refers_to: &str) {
        let r = update_named_range_core(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters,
            name.to_string(), scope, refers_to.to_string(), None, None,
        );
        assert!(r.success, "update {}: {:?}", name, r.error);
    }

    /// The value of a cell on `sheet` (the active sheet's authoritative grid
    /// when it is the active one).
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
}

fn n(v: f64) -> CellValue {
    CellValue::Number(v)
}

/// BUG-0744/0749 remainder: `=Sheet1!Dup` reads the name Dup in SHEET1's
/// scope wherever the formula is. [LIVE, Excel 16, lane formfix p1.json] with
/// a workbook Dup = 1, a Sheet1 Dup = 2, a workbook Glob = 7, a Sheet2 LocTwo
/// = 5 and a Sheet1 RngN = Sheet1!$A$1:$A$3 (1, 2, 3): on Sheet2 `=Sheet1!Dup`
/// is 2 and `=Dup` 1; on Sheet1 `=Sheet2!Dup` is the workbook's 1,
/// `=Sheet1!Glob` 7, `=Sheet1!LocTwo` #NAME?, `=Sheet2!LocTwo` 5,
/// `=LET(Dup,9,Sheet1!Dup)` 2 (never the LET name), `=SUM(Sheet1!RngN)` 6,
/// `=Sheet1!Dup+1` 3 shown as typed. Calcula could not parse `Sheet1!Dup` at
/// all, so each was kept as TEXT. Repointing Sheet1's Dup recalculates the
/// formulas reading it on both sheets, and defining a missing one turns the
/// #NAME? into its value, as Excel does.
///
/// SABOTAGE (formfix-qual): `resolve_qualified_name` leaves the node as it is
/// -- fails at "QUALIFIED NAME".
#[test]
fn a_sheet_qualified_name_is_read_in_that_sheets_scope() {
    let wb = Wb::new();
    for (name, scope, refers_to) in [
        ("Dup", None, "=1"),
        ("Dup", Some(0), "=2"),
        ("Glob", None, "=7"),
        ("LocTwo", Some(1), "=5"),
        ("RngN", Some(0), "=Sheet1!$A$1:$A$3"),
    ] {
        let r = wb.define(name, scope, refers_to);
        assert!(r.success, "{}: {:?}", name, r.error);
    }
    wb.set(0, 0, "1");
    wb.set(1, 0, "2");
    wb.set(2, 0, "3");
    let name_error = CellValue::Error(CellError::Name);
    let cases: [(u32, &str, CellValue); 7] = [
        (0, "=Sheet1!Dup+1", n(3.0)),
        (1, "=Sheet2!Dup", n(1.0)),
        (2, "=Sheet1!Glob", n(7.0)),
        (3, "=Sheet1!LocTwo", name_error.clone()),
        (4, "=Sheet2!LocTwo", n(5.0)),
        (5, "=LET(Dup,9,Sheet1!Dup)", n(2.0)),
        (6, "=SUM(Sheet1!RngN)", n(6.0)),
    ];
    for (row, formula, _) in &cases {
        wb.set(*row, 9, formula);
    }
    let mut wrong = Vec::new();
    for (row, formula, excel) in &cases {
        let got = wb.value(0, *row, 9);
        if got != *excel {
            wrong.push(format!("{} = {:?}, Excel {:?}", formula, got, excel));
        }
    }
    assert!(wrong.is_empty(), "QUALIFIED NAME read wrongly ({}):\n{}", wrong.len(), wrong.join("\n"));
    assert_eq!(wb.formula(0, 0, 9).as_deref(), Some("Sheet1!Dup+1"), "shown as typed");

    // On Sheet2: the qualifier, not the sheet the formula is on, picks the scope.
    wb.activate(1);
    wb.set(0, 11, "=Sheet1!Dup");
    wb.set(1, 11, "=Dup");
    assert_eq!(wb.value(1, 0, 11), n(2.0), "QUALIFIED NAME on Sheet2: Sheet1!Dup");
    assert_eq!(wb.value(1, 1, 11), n(1.0), "=Dup on Sheet2 is the workbook's");

    // Repointing Sheet1's Dup moves every formula that reads it, on both sheets.
    wb.redefine("Dup", Some(0), "=20");
    assert_eq!(wb.value(1, 0, 11), n(20.0), "Sheet2's =Sheet1!Dup follows the new definition");
    assert_eq!(wb.value(1, 1, 11), n(1.0), "the workbook's Dup did not change");
    assert_eq!(wb.value(0, 0, 9), n(21.0), "Sheet1's =Sheet1!Dup+1 follows it too");

    // A name defined later turns the waiting #NAME? into its value (the
    // `create_named_range` command's own tail after its body).
    wb.activate(0);
    let r = wb.define("LocTwo", Some(0), "=8");
    assert!(r.success, "{:?}", r.error);
    crate::named_ranges::recalc_after_name_change(
        &wb.state, &wb.files, &wb.pivots, &wb.pane, &wb.filters, &["LocTwo".to_string()],
    );
    assert_eq!(wb.value(0, 3, 9), n(8.0), "=Sheet1!LocTwo once Sheet1 has a LocTwo");
}

/// W1 (formula verifier, PLAUSIBLE): `=SUM(A1:INDEX(C1:C5,3))` spans A1:C3,
/// but only A1 and C1:C5 were its precedents, so an edit of B2 left the sum
/// stale until a full recalculation. Excel recalculates it. The span of a
/// call half now counts the box of every cell the call could return (INDEX /
/// TAKE / DROP / TRIMRANGE their range, XLOOKUP its return array, IF / CHOOSE
/// each branch).
///
/// SABOTAGE (formfix-span): `static_reference_span`'s call arm answers `None`
/// -- fails at "INTERIOR PRECEDENT".
#[test]
fn the_interior_of_a_call_half_span_is_a_precedent() {
    let wb = Wb::new();
    for r in 0..5u32 {
        wb.set(r, 2, &format!("{}", 100 * (r + 1)));
    }
    wb.set(0, 0, "1");
    wb.set(0, 9, "=SUM(A1:INDEX(C1:C5,3))");
    wb.set(1, 9, "=SUM(A1:IF(TRUE,C3,C4))");
    wb.set(2, 9, "=SUM(A1:XLOOKUP(300,C1:C5,C1:C5))");
    assert_eq!(wb.value(0, 0, 9), n(601.0));
    wb.set(1, 1, "50"); // B2, inside every span
    assert_eq!(wb.value(0, 0, 9), n(651.0), "INTERIOR PRECEDENT: INDEX half");
    assert_eq!(wb.value(0, 1, 9), n(651.0), "INTERIOR PRECEDENT: IF half");
    assert_eq!(wb.value(0, 2, 9), n(651.0), "INTERIOR PRECEDENT: XLOOKUP half");
}

/// W1 (formula lane): the Name Manager showed "There's a problem with this
/// formula." in front of every entry check's message, so an arity refusal
/// read "There's a problem with this formula. You've entered too few
/// arguments..." and the generic one said its sentence twice. [LIVE, Excel
/// 16, lane formfix p1.json, `Names.Add`] `=ROUND(1)`: "You've entered too
/// few arguments for this function."; `=PI(1)`, `=SUM()`:
/// "There's a problem with this formula." -- once.
///
/// SABOTAGE (formfix-msg): `name_formula_refusal_text` always prefixes --
/// fails at "ARITY MESSAGE ALONE".
#[test]
fn the_name_manager_shows_an_arity_refusal_as_excel_does() {
    let wb = Wb::new();
    let few = wb.define("Few", None, "=ROUND(1)");
    assert!(!few.success);
    let few = few.error.unwrap_or_default();
    assert!(few.starts_with("You've entered too few arguments for this function."), "ARITY MESSAGE ALONE: {few}");
    let none = wb.define("NoArgs", None, "=PI(1)").error.unwrap_or_default();
    assert!(none.starts_with("There's a problem with this formula."), "{none}");
    assert_eq!(none.matches("There's a problem with this formula.").count(), 1, "said once: {none}");
}
