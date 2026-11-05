//! FILENAME: app/src-tauri/src/tables_cfdv_tests.rs
//! PURPOSE: Lane `cfdv` -- what typing into a table's TOTALS cell does to that
//! column's totals function (NEW-totals-constant-none), driven through the real
//! command bodies (`update_cell_impl`, `check_table_auto_expand_core`,
//! `toggle_totals_row_core`). A child module of `tables` (declared with
//! `#[path]` there).
//!
//! Every Excel fact here is [LIVE, Excel 16, 2026-11-05], from the lane's
//! probes (cfdv/probe1.ps1 T0-T11, cfdv/probe2.ps1 P1-P5).

use super::TotalsRowFunction;
use crate::persistence::{FileState, UserFilesState};
use crate::AppState;
use engine::CellValue;

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

    /// Type `value` into a cell, then run the Table extension's follow-up for
    /// that edit -- the totals-cell rule lives in `check_table_auto_expand_core`,
    /// which the extension calls for an edit in a table's totals row.
    fn type_in(&self, row: u32, col: u32, value: &str) -> Option<super::Table> {
        crate::commands::data::update_cell_impl(
            &self.state, &self.file, &self.files, &self.slicer, &self.pivots, &self.pane, &self.filters,
            row, col, value.to_string(), None, None, None,
        )
        .unwrap_or_else(|e| panic!("update_cell({},{}) failed: {}", row, col, e));
        super::check_table_auto_expand_core(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters, row, col,
        )
    }

    /// H1/H2 over A1:B4 (2..4 and 20..40), named `TT`.
    fn numbers_table(&self) -> identity::EntityId {
        self.type_in(0, 0, "H1");
        self.type_in(0, 1, "H2");
        for row in 1..=3u32 {
            self.type_in(row, 0, &(row + 1).to_string());
            self.type_in(row, 1, &(10 * (row + 1)).to_string());
        }
        let created = super::create_table_core(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters,
            super::CreateTableParams {
                name: "TT".to_string(),
                start_row: 0,
                start_col: 0,
                end_row: 3,
                end_col: 1,
                has_headers: true,
                style_options: None,
                style_name: None,
            },
        );
        assert!(created.success, "{:?}", created.error);
        created.table.unwrap().id
    }

    fn totals(&self, id: identity::EntityId, show: bool) {
        let r = super::toggle_totals_row_core(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters, id, show,
        );
        assert!(r.success, "{:?}", r.error);
    }

    fn column(&self, id: identity::EntityId, index: usize) -> super::TableColumn {
        self.state.tables.read().unwrap().values().find_map(|st| st.get(&id).cloned()).unwrap().columns[index].clone()
    }

    fn cell(&self, row: u32, col: u32) -> (CellValue, Option<String>) {
        let grid = self.state.grid.read().unwrap();
        match grid.get_cell(row, col) {
            Some(c) => (c.value.clone(), c.formula_string()),
            None => (CellValue::Empty, None),
        }
    }
}

/// [LIVE, cfdv/probe1.ps1 T0-T2, probe2.ps1 P1/P4] Total Row on gives
/// `Total` / `=SUBTOTAL(109,[H2])`; typing 7 over the subtotal sets the column
/// to None (`TotalsCalculation` 0), and Total Row off then on shows the 7 and
/// the label again. Calcula kept Sum, so the toggle wrote `SUBTOTAL(109,..)`
/// back over the 7 -- and once it was None the "no column has a function"
/// defaults test would have put Sum back all the same.
/// SABOTAGE (cfdv-totals-none): the totals-cell branch of
/// `check_table_auto_expand_core` never taken.
#[test]
fn a_constant_typed_over_a_total_sets_the_function_to_none_and_survives_a_toggle() {
    let wb = Wb::new();
    let id = wb.numbers_table();
    wb.totals(id, true);
    assert_eq!(wb.column(id, 1).totals_row_function, TotalsRowFunction::Sum);
    assert!(wb.cell(4, 1).1.unwrap_or_default().contains("SUBTOTAL(109"));

    let changed = wb.type_in(4, 1, "7");
    assert!(changed.is_some(), "the table's totals function did not follow the typed constant");
    assert_eq!(wb.column(id, 1).totals_row_function, TotalsRowFunction::None);

    wb.totals(id, false);
    assert_eq!(wb.cell(4, 1).0, CellValue::Empty, "hiding the totals row clears its cells, as Excel's does");
    wb.totals(id, true);
    assert_eq!(wb.cell(4, 1), (CellValue::Number(7.0), None), "the toggle rewrote the user's constant");
    assert_eq!(wb.cell(4, 0).0, CellValue::Text("Total".to_string()));
    assert_eq!(wb.column(id, 1).totals_row_function, TotalsRowFunction::None);
}

/// [LIVE, cfdv/probe1.ps1 T4/T6, probe2.ps1 P5] a FORMULA typed into the
/// totals cell: the eight menu subtotals over THIS column are recognised as
/// their function (`=SUBTOTAL(101,[H2])` -> Average, `=SUBTOTAL(109,TT[H2])`
/// -> Sum); anything else is Custom with the formula kept --
/// `=SUBTOTAL(9,[H2])`, another column's subtotal, `=1+1`. Text typed into the
/// label column keeps it None.
/// SABOTAGE (cfdv-totals-none) as above.
#[test]
fn a_formula_typed_into_a_totals_cell_is_its_function_or_custom() {
    let wb = Wb::new();
    let id = wb.numbers_table();
    wb.totals(id, true);

    wb.type_in(4, 1, "=SUBTOTAL(101,[H2])");
    assert_eq!(wb.column(id, 1).totals_row_function, TotalsRowFunction::Average);
    assert_eq!(wb.column(id, 1).totals_row_formula, None);

    wb.type_in(4, 1, "=SUBTOTAL(9,[H2])");
    let column = wb.column(id, 1);
    assert_eq!(column.totals_row_function, TotalsRowFunction::Custom);
    assert!(column.totals_row_formula.unwrap_or_default().to_ascii_uppercase().contains("SUBTOTAL(9,"));

    wb.type_in(4, 1, "=SUBTOTAL(109,TT[H2])");
    assert_eq!(wb.column(id, 1).totals_row_function, TotalsRowFunction::Sum);

    wb.type_in(4, 1, "=SUBTOTAL(109,[H1])");
    assert_eq!(wb.column(id, 1).totals_row_function, TotalsRowFunction::Custom);

    wb.type_in(4, 1, "=1+1");
    let column = wb.column(id, 1);
    assert_eq!(column.totals_row_function, TotalsRowFunction::Custom);
    assert_eq!(column.totals_row_formula.as_deref(), Some("=1+1"));
    // Off and on: a Custom column gets its formula back, not the default.
    wb.totals(id, false);
    wb.totals(id, true);
    // (`formula_string` renders without the `=`.)
    assert_eq!(wb.cell(4, 1).1.as_deref(), Some("1+1"));

    wb.type_in(4, 0, "Label");
    assert_eq!(wb.column(id, 0).totals_row_function, TotalsRowFunction::None);
    wb.totals(id, false);
    wb.totals(id, true);
    assert_eq!(wb.cell(4, 0).0, CellValue::Text("Label".to_string()), "Excel keeps a typed label (P1c)");
}
