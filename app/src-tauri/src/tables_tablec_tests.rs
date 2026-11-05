//! FILENAME: app/src-tauri/src/tables_tablec_tests.rs
//! PURPOSE: Lane `tablec` -- what Excel does to the formulas around a table
//! when the table is converted, deleted, re-columned, grown, totalled or
//! copied with its sheet. A child module of `tables` (declared with `#[path]`
//! there), driven through the real command bodies.
//!
//! Every Excel fact here is [LIVE, Excel 16, 2026-11-05], from the probes in
//! the lane's scratch folder (tablefix-probe/probe6.ps1, tablec/probe1-3.ps1).

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
    timelines: crate::timeline_slicer::TimelineSlicerState,
}

impl Wb {
    fn new(sheets: usize) -> Self {
        let state = crate::create_app_state();
        *state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
        let seed = crate::document_effect::test_seed_effect();
        for i in 1..sheets {
            state.grids.write(&seed).unwrap().push(engine::Grid::new());
            state.sheet_names.write(&seed).unwrap().push(format!("Sheet{}", i + 1));
            state.all_column_widths.write(&seed).unwrap().push(HashMap::new());
            state.all_row_heights.write(&seed).unwrap().push(HashMap::new());
            state.all_user_hidden_rows.write(&seed).unwrap().push(HashSet::new());
            state.all_user_hidden_cols.write(&seed).unwrap().push(HashSet::new());
            state.sheet_ids.write(&seed).unwrap().push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        }
        {
            let mut all = state.all_merged_regions.write(&seed).unwrap();
            while all.len() < sheets {
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
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    fn set(&self, row: u32, col: u32, value: &str) {
        crate::commands::data::update_cell_impl(
            &self.state, &self.file, &self.files, &self.slicer, &self.pivots, &self.pane, &self.filters,
            row, col, value.to_string(), None, None, None,
        )
        .unwrap_or_else(|e| panic!("update_cell({},{}) failed: {}", row, col, e));
    }

    /// The recalculation-relevant half of `set_active_sheet`.
    fn switch_to(&self, index: usize) {
        {
            let clean = crate::document_effect::DocumentEffect::deliberately_clean(
                crate::document_effect::CleanReason::LoadingFromDisk,
            );
            let mut grids = self.state.grids.write(&clean).unwrap();
            let mut active = self.state.active_sheet.write(&crate::document_effect::test_seed_effect()).unwrap();
            let mut mirror = self.state.grid.write(&clean).unwrap();
            let old = *active;
            if old == index {
                return;
            }
            grids[old] = mirror.clone();
            *mirror = grids[index].clone();
            *active = index;
        }
        crate::undo_commands::rebuild_all_dependencies(&self.state);
    }

    fn table(&self, name: &str, rect: (u32, u32, u32, u32)) -> identity::EntityId {
        let created = super::create_table_core(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters,
            super::CreateTableParams {
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
        created.table.unwrap().id
    }

    fn get(&self, id: identity::EntityId) -> Option<super::Table> {
        self.state.tables.read().unwrap().values().find_map(|st| st.get(&id).cloned())
    }

    fn with_table(&self, id: identity::EntityId, f: impl FnOnce(&mut super::Table)) {
        let effect = crate::document_effect::test_seed_effect();
        let mut tables = self.state.tables.write(&effect).unwrap();
        let t = tables.values_mut().find_map(|st| st.get_mut(&id)).expect("table");
        f(t);
    }

    fn formula(&self, sheet: usize, row: u32, col: u32) -> String {
        self.state.grids.read().unwrap()[sheet]
            .get_cell(row, col)
            .and_then(|c| c.formula_string())
            .unwrap_or_default()
            .to_ascii_uppercase()
    }

    fn value(&self, sheet: usize, row: u32, col: u32) -> CellValue {
        self.state.grids.read().unwrap()[sheet]
            .get_cell(row, col)
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    }

    fn name_refers(&self, name: &str) -> String {
        self.state
            .named_ranges
            .read()
            .unwrap()
            .values()
            .find(|n| n.name == name)
            .map(|n| n.refers_to.to_ascii_uppercase())
            .unwrap_or_default()
    }

    fn define(&self, name: &str, refers_to: &str) {
        let r = crate::named_ranges::create_named_range_impl(
            &self.state, &self.file, name.to_string(), None, refers_to.to_string(), None, None,
        );
        assert!(r.success, "{:?}", r.error);
    }

    fn undo(&self) {
        let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timelines, transaction, true,
        );
    }

    fn retire(&self, id: identity::EntityId, fate: super::RetiredTableRefs) -> super::TableResult {
        super::retire_table_core(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters, &self.slicer,
            &self.timelines, id, fate,
        )
    }

    /// The fixture both retire tests share. Sheet1: `Old` on A1:B4 (A = 2,3,4;
    /// B a this-row formula `=[@A]*2`), `Oth` on D1:E4 (D = 1,2,3; E's stored
    /// calculated column and E2 itself `=[@P]+SUM(Old[A])`, a custom total
    /// naming Old), G1 `=SUM(Old[A])`, the name `NmOld`; Sheet2!A1
    /// `=SUM(Old[A])`.
    fn retire_fixture(&self) -> (identity::EntityId, identity::EntityId) {
        for (col, header) in [(0u32, "A"), (1, "B"), (3, "P"), (4, "Q")] {
            self.set(0, col, header);
        }
        for row in 1..=3u32 {
            self.set(row, 0, &(row + 1).to_string());
            self.set(row, 3, &row.to_string());
        }
        let old = self.table("Old", (0, 0, 3, 1));
        let oth = self.table("Oth", (0, 3, 3, 4));
        self.set(1, 1, "=[@A]*2");
        self.set(1, 4, "=[@P]+SUM(Old[A])");
        self.set(0, 6, "=SUM(Old[A])");
        self.with_table(oth, |t| {
            t.columns[1].calculated_formula = Some("=[@P]+SUM(Old[A])".to_string());
            t.columns[0].totals_row_formula = Some("=COUNT(Old[A])".to_string());
        });
        self.define("NmOld", "=SUM(Old[A])");
        self.switch_to(1);
        self.set(0, 0, "=SUM(Old[A])");
        self.switch_to(0);
        assert_eq!(self.value(0, 0, 6), CellValue::Number(9.0), "fixture");
        assert_eq!(self.value(1, 0, 0), CellValue::Number(9.0), "fixture (Sheet2)");
        (old, oth)
    }
}

/// rev-xlsx-3, the Convert-to-Range half. [LIVE, tablefix-probe/probe6.ps1 +
/// tablec/probe3.ps1] `Unlist` rewrites every reference to the table into the
/// rectangle it named, absolute and SHEET-QUALIFIED even on its own sheet
/// (`SUM(Sheet3!$A$2:$A$4)`), a this-row one ROW-relative (`[@H1]*2` ->
/// `Inunlist!$A2*2`) -- in cells on any sheet, in another table's calculated
/// column and custom total, and in a defined name -- and keeps `[@P]` in a
/// formula that also names another table. Calcula skipped a mixed formula
/// altogether (it read a table that no longer existed: `#NAME?`), left the
/// stored formulas and the name naming `Old`, and wrote unqualified ranges.
/// One Ctrl+Z puts every one of them back.
/// SABOTAGE (tablec-conv): `retire_table_refs_in_ast` keeps every node
/// (`ours` always false).
#[test]
fn convert_to_range_rewrites_only_its_own_references_everywhere_as_excel_does() {
    let wb = Wb::new(2);
    let (old, oth) = wb.retire_fixture();
    let r = wb.retire(old, super::RetiredTableRefs::ToRange);
    assert!(r.success, "{:?}", r.error);

    assert_eq!(wb.formula(0, 0, 6), "SUM(SHEET1!$A$2:$A$4)", "a plain reader");
    assert_eq!(wb.value(0, 0, 6), CellValue::Number(9.0), "values do not move");
    let mixed = wb.formula(0, 1, 4);
    assert!(mixed.contains("[@P]") && mixed.contains("SHEET1!$A$2:$A$4"), "mixed formula: {}", mixed);
    assert_eq!(wb.formula(0, 1, 1), "SHEET1!$A2*2", "a this-row reference is row-relative");
    assert_eq!(wb.formula(1, 0, 0), "SUM(SHEET1!$A$2:$A$4)", "another sheet's reader");
    let t = wb.get(oth).expect("Oth survives");
    let calc = t.columns[1].calculated_formula.clone().unwrap_or_default().to_ascii_uppercase();
    assert!(calc.contains("[@P]") && calc.contains("SHEET1!$A$2:$A$4"), "Oth's calculated column: {}", calc);
    let total = t.columns[0].totals_row_formula.clone().unwrap_or_default().to_ascii_uppercase();
    assert!(total.contains("SHEET1!$A$2:$A$4"), "Oth's custom total: {}", total);
    assert!(wb.name_refers("NmOld").contains("SHEET1!$A$2:$A$4"), "the name: {}", wb.name_refers("NmOld"));
    assert!(wb.get(old).is_none());
    assert_eq!(wb.value(0, 1, 0), CellValue::Number(2.0), "Convert keeps the cells");

    wb.undo();
    assert!(wb.get(old).is_some(), "one Ctrl+Z brings the table back");
    assert!(wb.formula(0, 1, 4).contains("OLD[A]"), "and the mixed formula: {}", wb.formula(0, 1, 4));
    assert!(wb.name_refers("NmOld").contains("OLD[A]"));
    let calc = wb.get(oth).unwrap().columns[1].calculated_formula.clone().unwrap_or_default().to_ascii_uppercase();
    assert!(calc.contains("OLD[A]"), "and Oth's stored formula: {}", calc);
}

/// rev-xlsx-3, the Delete half. [LIVE, probe6 + tablec/probe1.ps1 + probe3]
/// `ListObject.Delete` empties the table's cells (contents and formats; the
/// cells around it do not move) and every reference to it becomes `#REF!`
/// -- `SUM(#REF!)`, `[@P]+SUM(#REF!)` -- in cells, stored formulas and names
/// alike. Calcula's Delete kept the cells and flattened the references:
/// Convert to Range under another name, which no Excel gesture does.
/// SABOTAGE (tablec-del): the Delete arm of `retire_table_refs_in_ast` resolves
/// to the range as Convert does.
#[test]
fn delete_table_clears_its_cells_and_turns_every_reference_into_ref_errors() {
    let wb = Wb::new(2);
    let (old, oth) = wb.retire_fixture();
    wb.set(5, 0, "below");
    let r = wb.retire(old, super::RetiredTableRefs::ToRefError);
    assert!(r.success, "{:?}", r.error);

    assert_eq!(wb.formula(0, 0, 6), "SUM(#REF!)");
    assert!(matches!(wb.value(0, 0, 6), CellValue::Error(_)), "{:?}", wb.value(0, 0, 6));
    assert_eq!(wb.formula(0, 1, 4), "[@P]+SUM(#REF!)", "only Old's reference");
    assert_eq!(wb.formula(1, 0, 0), "SUM(#REF!)", "another sheet's reader");
    assert!(matches!(wb.value(1, 0, 0), CellValue::Error(_)), "and its value: {:?}", wb.value(1, 0, 0));
    let t = wb.get(oth).unwrap();
    assert!(t.columns[1].calculated_formula.clone().unwrap_or_default().contains("#REF!"));
    assert!(t.columns[0].totals_row_formula.clone().unwrap_or_default().contains("#REF!"));
    assert!(wb.name_refers("NmOld").contains("#REF!"), "{}", wb.name_refers("NmOld"));
    for (row, col) in [(0u32, 0u32), (1, 0), (3, 0), (0, 1), (1, 1)] {
        assert!(wb.state.grids.read().unwrap()[0].get_cell(row, col).is_none(), "cell {},{} kept", row, col);
    }
    assert_eq!(wb.value(0, 5, 0), CellValue::Text("below".to_string()), "nothing below moves");

    wb.undo();
    assert_eq!(wb.value(0, 1, 0), CellValue::Number(2.0), "one Ctrl+Z brings the cells back");
    assert_eq!(wb.formula(0, 0, 6), "SUM(OLD[A])");
    assert!(wb.name_refers("NmOld").contains("OLD[A]"));
}

/// NEW-rename-column-stale. [LIVE, tablec/probe1.ps1] `ListColumn.Name` (and
/// a header-cell edit) rewrite the cells, ANOTHER table's calculated column
/// and custom total and a defined name: `[@P]+SUM(OldC[A])` ->
/// `..OldC[Z]`. Only the cells followed. The renamed table's own calculated
/// column (`[@A]*2`) follows too, and Ctrl+Z puts the column's name back with
/// the formulas -- it used to restore the formulas onto a column that kept
/// its new name.
/// SABOTAGE (tablec-rencol): `rename_table_column_in_text` returns None.
#[test]
fn renaming_a_column_rewrites_stored_formulas_and_names_in_one_step() {
    let wb = Wb::new(2);
    let (old, oth) = wb.retire_fixture();
    wb.with_table(old, |t| t.columns[1].calculated_formula = Some("=[@A]*2".to_string()));
    let r = super::rename_table_column_core(
        &wb.file, &wb.state, &wb.files, &wb.pivots, &wb.pane, &wb.filters, old, "A".to_string(), "Z".to_string(),
    );
    assert!(r.success, "{:?}", r.error);
    assert!(wb.formula(0, 0, 6).contains("OLD[Z]"), "the cell: {}", wb.formula(0, 0, 6));
    let t = wb.get(oth).unwrap();
    let calc = t.columns[1].calculated_formula.clone().unwrap_or_default().to_ascii_uppercase();
    assert!(calc.contains("OLD[Z]") && calc.contains("[@P]"), "Oth's calculated column: {}", calc);
    let total = t.columns[0].totals_row_formula.clone().unwrap_or_default().to_ascii_uppercase();
    assert!(total.contains("OLD[Z]"), "Oth's custom total: {}", total);
    let own = wb.get(old).unwrap().columns[1].calculated_formula.clone().unwrap_or_default().to_ascii_uppercase();
    assert!(own.contains("[@Z]"), "the table's own calculated column: {}", own);
    assert!(wb.name_refers("NmOld").contains("OLD[Z]"), "the name: {}", wb.name_refers("NmOld"));

    wb.undo();
    assert_eq!(wb.get(old).unwrap().columns[0].name, "A", "Ctrl+Z puts the column's name back");
    assert!(wb.formula(0, 0, 6).contains("OLD[A]"));
    assert!(wb.name_refers("NmOld").contains("OLD[A]"));
    let calc = wb.get(oth).unwrap().columns[1].calculated_formula.clone().unwrap_or_default().to_ascii_uppercase();
    assert!(calc.contains("OLD[A]"), "{}", calc);
}

/// A table of H1/H2 over A1:B4 with numbers (2..4 and 20..40).
fn numbers_table(wb: &Wb) -> identity::EntityId {
    wb.set(0, 0, "H1");
    wb.set(0, 1, "H2");
    for row in 1..=3u32 {
        wb.set(row, 0, &(row + 1).to_string());
        wb.set(row, 1, &(10 * (row + 1)).to_string());
    }
    wb.table("", (0, 0, 3, 1))
}

fn totals(wb: &Wb, id: identity::EntityId, show: bool) -> super::TableResult {
    super::toggle_totals_row_core(&wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, id, show)
}

fn auto_expand(wb: &Wb, row: u32, col: u32) -> Option<super::Table> {
    super::check_table_auto_expand_core(&wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, row, col)
}

/// NEW-totals-row-autoexpand. [LIVE, tablec/probe1.ps1] with a totals row on
/// A5, a value written into A5 edits the total and the table stays A1:B5;
/// one written into A6 stays outside it. Calcula grew the table over its
/// own totals row when a total was typed (`data_end + 1` IS the totals row).
/// Without a totals row, the row under the table still grows it (control).
/// SABOTAGE (tablec-expand): the row condition back to `data_end_row() + 1`.
#[test]
fn typing_in_or_under_a_totals_row_never_grows_the_table() {
    let wb = Wb::new(1);
    let id = numbers_table(&wb);
    assert!(totals(&wb, id, true).success);
    assert_eq!(wb.get(id).unwrap().end_row, 4);
    wb.set(4, 0, "typed");
    assert!(auto_expand(&wb, 4, 0).is_none(), "typing a total grew the table");
    wb.set(5, 0, "6");
    assert!(auto_expand(&wb, 5, 0).is_none(), "typing under the totals row grew the table");
    assert_eq!(wb.get(id).unwrap().end_row, 4);

    // Control: no totals row, the row under the table grows it.
    let wb = Wb::new(1);
    let id = numbers_table(&wb);
    wb.set(4, 0, "5");
    assert_eq!(auto_expand(&wb, 4, 0).map(|t| t.end_row), Some(4));
}

/// NEW-totals-row-overwrite, the toggle half. [LIVE, tablec/probe1.ps1 +
/// probe3.ps1] `ShowTotals` on A1:B4 with A5 and B6 filled leaves both where
/// they are, takes rows 5-6 in as DATA and puts the totals row on row 7;
/// a filled row after an empty one stays outside. The totals row used to be
/// written over row 5, destroying its value. One Ctrl+Z undoes the toggle
/// (it recorded nothing).
/// SABOTAGE (tablec-landing): `totals_row_landing` returns `end_row + 1`.
#[test]
fn turning_totals_on_over_occupied_rows_takes_them_in_as_data() {
    let wb = Wb::new(1);
    let id = numbers_table(&wb);
    wb.set(4, 0, "occA5");
    wb.set(5, 1, "occB6");
    wb.set(7, 0, "after the gap");
    let shown = totals(&wb, id, true);
    assert!(shown.success, "{:?}", shown.error);
    let t = shown.table.unwrap();
    assert_eq!(t.end_row, 6, "the totals row lands on row 7");
    assert_eq!(wb.value(0, 4, 0), CellValue::Text("occA5".to_string()), "A5 was overwritten");
    assert_eq!(wb.value(0, 5, 1), CellValue::Text("occB6".to_string()));
    assert_eq!(wb.value(0, 6, 0), CellValue::Text("Total".to_string()));
    assert!(wb.formula(0, 6, 1).contains("SUBTOTAL(103,"), "a text cell in the last column: Count: {}", wb.formula(0, 6, 1));
    assert_eq!(wb.value(0, 7, 0), CellValue::Text("after the gap".to_string()));

    wb.undo();
    assert_eq!(wb.get(id).unwrap().end_row, 3, "one Ctrl+Z takes the totals row back");
    assert!(!wb.get(id).unwrap().style_options.total_row);
    assert_eq!(wb.value(0, 6, 0), CellValue::Empty, "and its label");
    assert_eq!(wb.value(0, 4, 0), CellValue::Text("occA5".to_string()));
}

/// NEW-totals-row-overwrite, the add-row half. [LIVE, tablec/probe1.ps1 +
/// probe3.ps1] `ListRows.Add` with a totals row inserts the new data row
/// above it: the totals row moves down WITH its formula, and what was under
/// it shifts down one row in the table's columns only. Calcula only advanced
/// `end_row`: the old totals row became a data row holding a SUBTOTAL and the
/// new totals row was empty.
/// SABOTAGE (tablec-addrow): the insert in `add_table_row_core` skipped.
#[test]
fn adding_a_row_moves_the_totals_row_down_with_its_formulas() {
    let wb = Wb::new(1);
    let id = numbers_table(&wb);
    assert!(totals(&wb, id, true).success);
    wb.set(5, 0, "belowA6");
    wb.set(5, 3, "sideD6");
    let before = wb.value(0, 4, 1);
    assert_eq!(before, CellValue::Number(90.0), "fixture: the total");
    super::add_table_row_core(
        &wb.file, &wb.state, &wb.files, &wb.pivots, &wb.pane, &wb.filters, &wb.slicer, &wb.timelines, id,
    )
    .expect("add a row");
    let t = wb.get(id).unwrap();
    assert_eq!(t.end_row, 5);
    assert!(t.style_options.total_row);
    assert!(wb.formula(0, 5, 1).contains("SUBTOTAL(109,"), "the totals row moved: {}", wb.formula(0, 5, 1));
    assert_eq!(wb.value(0, 5, 1), CellValue::Number(90.0));
    assert_eq!(wb.value(0, 5, 0), CellValue::Text("Total".to_string()));
    assert_eq!(wb.value(0, 4, 1), CellValue::Empty, "the new data row is empty");
    assert_eq!(wb.value(0, 6, 0), CellValue::Text("belowA6".to_string()), "the cell under it shifted down");
    assert_eq!(wb.value(0, 5, 3), CellValue::Text("sideD6".to_string()), "a cell beside the table stays");

    // A table with a totals row on ANOTHER sheet is refused, changing nothing.
    let wb = Wb::new(2);
    let id = numbers_table(&wb);
    assert!(totals(&wb, id, true).success);
    wb.switch_to(1);
    let err = super::add_table_row_core(
        &wb.file, &wb.state, &wb.files, &wb.pivots, &wb.pane, &wb.filters, &wb.slicer, &wb.timelines, id,
    )
    .unwrap_err();
    assert_eq!(err, super::ADD_ROW_OFF_SHEET_TOTALS_MESSAGE);
    assert_eq!(wb.get(id).unwrap().end_row, 4);
}

/// NEW-subtotal-escaping. [LIVE, tablec/probe1.ps1] Excel writes
/// `SUBTOTAL(109,[a'[1']])`, `['#x]`, `[it''s]`: a column name's `[ ] # '`
/// are escaped. The raw `Table[{}]` re-parsed `a[1]` as a nested specifier
/// and `#x` as a special item. The formula now names exactly the column, and
/// the total is a number.
/// SABOTAGE (tablec-esc): `build_subtotal_formula` back to the raw
/// `{}[{}]` spelling.
#[test]
fn a_totals_formula_escapes_the_column_name_like_the_renderer() {
    for name in ["a[1]", "#x", "it's", "b]c"] {
        let f = super::build_subtotal_formula(&super::TotalsRowFunction::Sum, "T", name).unwrap();
        let ast = parser::parse(&f).unwrap_or_else(|e| panic!("{} does not parse: {:?}", f, e));
        let mut columns: Vec<String> = Vec::new();
        super::map_table_refs(&ast, &mut |node| {
            if let parser::ast::Expression::TableRef { specifier: parser::ast::TableSpecifier::Column(c), .. } = node {
                columns.push(c.clone());
            }
            None
        });
        assert_eq!(columns, vec![name.to_string()], "{} names another column", f);
    }
    // Through the real toggle: the last column is called `a[1]`.
    let wb = Wb::new(1);
    wb.set(0, 0, "a[1]");
    wb.set(1, 0, "2");
    wb.set(2, 0, "3");
    let id = wb.table("", (0, 0, 2, 0));
    assert!(totals(&wb, id, true).success);
    assert_eq!(wb.value(0, 3, 0), CellValue::Number(5.0), "{}", wb.formula(0, 3, 0));
}

/// NEW-totals-function-undo. Choosing a totals function recorded no undo
/// step: Ctrl+Z left the new function and its SUBTOTAL in place. One step
/// now restores both the function and the totals cell.
/// SABOTAGE (tablec-fnundo): the undo block in `set_totals_row_function_core`
/// removed.
#[test]
fn ctrl_z_restores_the_previous_totals_function() {
    let wb = Wb::new(1);
    let id = numbers_table(&wb);
    assert!(totals(&wb, id, true).success);
    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();
    let r = super::set_totals_row_function_core(
        &wb.file, &wb.state, &wb.files, &wb.pivots, &wb.pane, &wb.filters,
        super::SetTotalsRowFunctionParams {
            table_id: id,
            column_name: "H2".to_string(),
            function: super::TotalsRowFunction::Average,
            custom_formula: None,
        },
    );
    assert!(r.success, "{:?}", r.error);
    assert_eq!(wb.value(0, 4, 1), CellValue::Number(30.0));
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_depth(), depth + 1, "one undo step");
    wb.undo();
    assert_eq!(wb.get(id).unwrap().columns[1].totals_row_function, super::TotalsRowFunction::Sum);
    assert!(wb.formula(0, 4, 1).contains("SUBTOTAL(109,"), "{}", wb.formula(0, 4, 1));
}

/// NEW-copy-sheet-tables. [LIVE, tablec/probe1.ps1 + probe3.ps1] copying a
/// sheet copies its tables under new names -- one table `Table1` -> `Table13`,
/// then `Table14` -- and the copy's formulas name the copies
/// (`=SUM(Table13[H1])`), while the source's stay as they were and a bare
/// `[@H1]` stays bare. Calcula copied no table: the copy's cells read the
/// source's.
/// SABOTAGE (tablec-copy): the `copy_tables_to_copied_sheet` call removed
/// from `copy_sheet_impl`.
#[test]
fn copying_a_sheet_copies_its_tables_under_excels_names() {
    let wb = Wb::new(1);
    let id = numbers_table(&wb);
    assert_eq!(wb.get(id).unwrap().name, "Table1");
    wb.set(0, 6, "=SUM(Table1[H1])");
    wb.with_table(id, |t| t.columns[1].calculated_formula = Some("=SUM(Table1[H1])".to_string()));
    crate::sheets::copy_sheet_impl(&wb.state, &wb.file, &wb.slicer, &wb.timelines, &wb.filters, 0, None)
        .expect("copy the sheet");
    let on = |sheet: usize| -> Vec<super::Table> {
        wb.state.tables.read().unwrap().get(&sheet).map(|st| st.values().cloned().collect()).unwrap_or_default()
    };
    let copies = on(1);
    assert_eq!(copies.len(), 1, "the copy has the table");
    assert_eq!(copies[0].name, "Table13");
    assert_eq!((copies[0].start_row, copies[0].end_row, copies[0].start_col, copies[0].end_col), (0, 3, 0, 1));
    assert_ne!(copies[0].id, id);
    assert_eq!(wb.formula(1, 0, 6), "SUM(TABLE13[H1])", "the copy's formula names the copy");
    assert_eq!(wb.formula(0, 0, 6), "SUM(TABLE1[H1])", "the source's is untouched");
    assert!(
        copies[0].columns[1].calculated_formula.clone().unwrap_or_default().to_ascii_uppercase().contains("TABLE13[H1]"),
        "the copy's stored formula names the copy"
    );
    assert!(wb.state.table_names.read().unwrap().contains_key(&super::table_name_key("Table13")));

    crate::sheets::copy_sheet_impl(&wb.state, &wb.file, &wb.slicer, &wb.timelines, &wb.filters, 0, None)
        .expect("copy again");
    assert_eq!(on(1)[0].name, "Table14", "the second copy (inserted after the source)");
}

/// Lock order (lane gatesc, 2026-11-05): `create_table_core` held `tables` /
/// `table_names` (pending) and then read `named_ranges` through
/// `name_collides_with_defined_name` -- the reverse of
/// `restamp_workbook_name_casing` (named_ranges, tables, table_names), an ABBA
/// pair. The defined names are now copied out before the first table guard.
/// Read from source: a deadlock does not show in a single-threaded test.
/// SABOTAGE: call `name_collides_with_defined_name(state, &params.name)` in
/// the name gate again -- this fails.
#[test]
fn create_table_reads_the_defined_names_before_the_table_guards() {
    let whole = include_str!("tables.rs");
    let src = &whole[..whole.find("#[cfg(test)]").expect("a test module")];
    let start = src.find("pub(crate) fn create_table_core(").expect("create_table_core");
    let rest = &src[start..];
    let body = &rest[..rest[1..].find("\npub").map(|i| i + 1).unwrap_or(rest.len())];
    let first_table_guard = body.find("state.tables.").expect("create_table_core takes `tables`");
    let names_read = body.find(".named_ranges").expect("the defined names are copied out");
    assert!(names_read < first_table_guard, "the defined names are read after a table guard is taken");
    assert!(
        !body[first_table_guard..].contains("name_collides_with_defined_name(")
            && !body[first_table_guard..].contains("named_ranges"),
        "`create_table_core` reads `named_ranges` while it holds the table guards (ABBA with \
         `restamp_workbook_name_casing`)"
    );
}
