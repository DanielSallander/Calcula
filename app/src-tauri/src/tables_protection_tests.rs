//! FILENAME: app/src-tauri/src/tables_protection_tests.rs
//! PURPOSE: rev-backend-1 -- no table feature on a protected sheet.
//!
//! A child module of `tables` (declared with `#[path]` there). [LIVE, Excel
//! 16, 2026-11-05, tablefix-probe/probe4.ps1, a fresh unsaved workbook, the
//! sheet protected with the defaults AND with every Allow option on]:
//! `ListObjects.Add`, `Resize`, `ShowTotals`, `Name`, `ListColumns.Add`,
//! `ListColumn.Delete`, `ListRows.Add`, `TotalsCalculation` and `Delete` are
//! each refused "Table features aren't available because the sheet is
//! protected."; an edit of an UNLOCKED header cell renames the column.

use crate::persistence::{FileState, UserFilesState};
use crate::AppState;

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

    fn set(&self, row: u32, col: u32, value: &str) {
        crate::commands::data::update_cell_impl(
            &self.state,
            &self.file,
            &self.files,
            &self.slicer,
            &self.pivots,
            &self.pane,
            &self.filters,
            row,
            col,
            value.to_string(),
            None,
            None,
            None,
        )
        .unwrap_or_else(|e| panic!("update_cell({},{}) failed: {}", row, col, e));
    }

    fn create(&self, name: &str, col: u32) -> super::TableResult {
        super::create_table_core(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.pane,
            &self.filters,
            super::CreateTableParams {
                name: name.to_string(),
                start_row: 0,
                start_col: col,
                end_row: 2,
                end_col: col,
                has_headers: true,
                style_options: None,
                style_name: None,
            },
        )
    }

    fn protect(&self, protected: bool) {
        self.state
            .sheet_protection
            .write(&crate::document_effect::test_seed_effect())
            .unwrap()
            .insert(0, crate::protection::SheetProtection { protected, ..Default::default() });
    }
}

/// Creating a table on a protected sheet is refused with Excel's message,
/// before anything changes: no table, no name, the sheet's AutoFilter (another
/// table's) left as it was, and the document still clean. The same create on
/// the unprotected sheet succeeds (the positive control), and so does the
/// refused one once the sheet is unprotected.
///
/// SABOTAGE (tablefix-prot1): the gate in `create_table_core` removed.
#[test]
fn a_table_cannot_be_created_on_a_protected_sheet() {
    let wb = Wb::new();
    for (col, header) in [(0u32, "A"), (2, "B")] {
        wb.set(0, col, header);
        wb.set(1, col, "1");
        wb.set(2, col, "2");
    }
    let first = wb.create("First", 0);
    assert!(first.success, "positive control: {:?}", first.error);
    let owned_filter = wb.state.auto_filters.read().unwrap().get(&0).map(|af| af.id);
    assert!(owned_filter.is_some(), "the first table installs the sheet's AutoFilter");

    wb.protect(true);
    crate::document_effect::mark_saved(&wb.file);
    assert!(!wb.file.is_dirty());

    let refused = wb.create("Second", 2);
    assert!(!refused.success, "a table was created on a protected sheet");
    assert_eq!(refused.error.as_deref(), Some(super::TABLE_PROTECTED_MESSAGE));
    assert!(!wb.file.is_dirty(), "a refused create must leave the document clean");
    assert!(
        !wb.state.table_names.read().unwrap().contains_key(&super::table_name_key("Second")),
        "the refused table was registered"
    );
    assert_eq!(wb.state.tables.read().unwrap().get(&0).map(|t| t.len()), Some(1));
    assert_eq!(
        wb.state.auto_filters.read().unwrap().get(&0).map(|af| af.id),
        owned_filter,
        "the refused create replaced the sheet's AutoFilter"
    );

    // An auto-named create (the AI's, the MCP server's and a script's door,
    // which pass no name) takes the same gate.
    let auto = wb.create("", 2);
    assert_eq!(auto.error.as_deref(), Some(super::TABLE_PROTECTED_MESSAGE));

    wb.protect(false);
    let allowed = wb.create("Second", 2);
    assert!(allowed.success, "unprotected again: {:?}", allowed.error);
}

/// Every other table door shares the gate and Excel's message: a rename on a
/// protected sheet (`rename_table_core`, the core every rename door reaches)
/// is refused the same way and leaves the name as it was.
///
/// SABOTAGE (tablefix-prot2): `require_table_sheet_unprotected` returns the
/// generic protection message again.
#[test]
fn a_protected_sheet_refuses_a_table_rename_with_excels_message() {
    let wb = Wb::new();
    wb.set(0, 0, "A");
    wb.set(1, 0, "1");
    let created = wb.create("First", 0);
    assert!(created.success, "{:?}", created.error);
    let id = created.table.unwrap().id;
    wb.protect(true);
    let refused = super::rename_table_core(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        0,
        id,
        "Renamed".to_string(),
    );
    assert_eq!(refused.error.as_deref(), Some(super::TABLE_PROTECTED_MESSAGE));
    assert!(wb.state.table_names.read().unwrap().contains_key(&super::table_name_key("First")));
}

/// THE CENSUS. Every function in tables.rs that mints a `DocumentEffect` --
/// every table mutation -- asks `require_table_sheet_unprotected` BEFORE it
/// does, or hands its whole body to a core that does, or is exempt with its
/// reason. A new table command without the gate fails here, which is how
/// `create_table_core` (and `remove_table_column`, `add_table_row`,
/// `check_table_auto_expand`) went without it while every other table command
/// had it.
///
/// SABOTAGE (tablefix-prot3): the gate in `remove_table_column` removed.
#[test]
fn every_table_mutation_is_gated_on_sheet_protection() {
    let whole = include_str!("tables.rs");
    let src = &whole[..whole.find("#[cfg(test)]").expect("tables.rs has a test module")];
    // Exempt, with the reason.
    let exempt: &[(&str, &str)] = &[(
        // (the body of the `enforce_table_header` command since lane tabxlsx
        // made it testable, BUG-0742)
        "enforce_table_header_core",
        "the tail of a HEADER CELL edit: protection already decided whether the cell could be \
         edited, and [LIVE] Excel renames the column when an unlocked header cell is edited",
    )];
    // Wrappers whose whole body is a gated core.
    let delegates = ["create_table_core(", "rename_table_core("];
    // Every top-level function's start, in order; a body runs to the next.
    let mut starts: Vec<usize> = Vec::new();
    for marker in ["\npub fn ", "\npub(crate) fn ", "\nfn "] {
        starts.extend(src.match_indices(marker).map(|(i, _)| i + 1));
    }
    starts.sort_unstable();
    let mut checked = 0usize;
    let mut ungated: Vec<String> = Vec::new();
    for (k, &at) in starts.iter().enumerate() {
        let body = &src[at..starts.get(k + 1).copied().unwrap_or(src.len())];
        let after_fn = &body[body.find("fn ").unwrap() + 3..];
        let name = after_fn[..after_fn.find('(').unwrap_or(0)].trim();
        let Some(effect_at) = body.find("DocumentEffect::mutates(") else { continue };
        if exempt.iter().any(|(n, _)| *n == name) {
            continue;
        }
        checked += 1;
        if delegates.iter().any(|d| body.contains(d) && !body.contains(&format!("fn {}", d))) {
            continue;
        }
        let gate_at = body.find("require_table_sheet_unprotected(");
        if !gate_at.is_some_and(|g| g < effect_at) {
            ungated.push(name.to_string());
        }
    }
    assert!(
        ungated.is_empty(),
        "{:?} mutate a table without first asking `require_table_sheet_unprotected` -- \
         [LIVE] Excel refuses every table feature on a protected sheet",
        ungated
    );
    assert!(checked >= 12, "the census found only {} table mutations; its parser has gone blind", checked);
}

impl Wb {
    fn table_over(&self, name: &str, cols: (u32, u32)) -> identity::EntityId {
        let created = super::create_table_core(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.pane,
            &self.filters,
            super::CreateTableParams {
                name: name.to_string(),
                start_row: 0,
                start_col: cols.0,
                end_row: 3,
                end_col: cols.1,
                has_headers: true,
                style_options: None,
                style_name: None,
            },
        );
        assert!(created.success, "create {}: {:?}", name, created.error);
        created.table.unwrap().id
    }

    fn totals(&self, id: identity::EntityId, show: bool) -> super::Table {
        let r = super::toggle_totals_row_core(&self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters, id, show);
        assert!(r.success, "toggle totals: {:?}", r.error);
        r.table.unwrap()
    }

    fn cell(&self, row: u32, col: u32) -> (String, engine::CellValue) {
        let grid = self.state.grid.read().unwrap();
        let cell = grid.get_cell(row, col);
        (
            cell.and_then(|c| c.formula_string()).unwrap_or_default(),
            cell.map(|c| c.value.clone()).unwrap_or(engine::CellValue::Empty),
        )
    }
}

/// NEW-totals-row-defaults + NEW-table-totals-count-swap, through the real
/// toggle. [LIVE, Excel 16, 2026-11-05, tablefix-probe/probe1.ps1] turning
/// the totals row on writes "Total" under the first column and Sum
/// (`SUBTOTAL(109,..)`) under a numeric last column, Count
/// (`SUBTOTAL(103,..)`, COUNTA) under a text one; a one-column table gets
/// only the function. Off and on again keeps the function the user chose.
/// Count over a TEXT column counts its cells -- 3 -- where the swapped code
/// (102, COUNT) counted none.
/// SABOTAGE (tablefix-defaults): the default block removed from
/// `toggle_totals_row_core`. SABOTAGE (tablefix-swap): Count back to 102.
#[test]
fn turning_the_totals_row_on_writes_excels_label_and_default_function() {
    let wb = Wb::new();
    // A1:B4 Name/Qty, D1:E4 Amt/Note, G1:G4 Only.
    for (col, header) in [(0u32, "Name"), (1, "Qty"), (3, "Amt"), (4, "Note"), (6, "Only")] {
        wb.set(0, col, header);
    }
    for row in 1..=3u32 {
        wb.set(row, 0, &format!("n{}", row));
        wb.set(row, 1, &row.to_string());
        wb.set(row, 3, &row.to_string());
        wb.set(row, 4, &format!("x{}", row));
        wb.set(row, 6, &(row + 4).to_string());
    }
    let ta = wb.table_over("TA", (0, 1));
    let tb = wb.table_over("TB", (3, 4));
    let tc = wb.table_over("TC", (6, 6));
    wb.totals(ta, true);
    wb.totals(tb, true);
    wb.totals(tc, true);

    assert_eq!(wb.cell(4, 0).1, engine::CellValue::Text("Total".to_string()));
    let (f, v) = wb.cell(4, 1);
    assert!(f.contains("SUBTOTAL(109,"), "numeric last column: {}", f);
    assert_eq!(v, engine::CellValue::Number(6.0));

    assert_eq!(wb.cell(4, 3).1, engine::CellValue::Text("Total".to_string()));
    let (f, v) = wb.cell(4, 4);
    assert!(f.contains("SUBTOTAL(103,"), "text last column: {}", f);
    assert_eq!(v, engine::CellValue::Number(3.0), "Count counts the text cells");

    let (f, v) = wb.cell(4, 6);
    assert!(f.contains("SUBTOTAL(109,"), "a one-column table gets the function: {}", f);
    assert_eq!(v, engine::CellValue::Number(18.0));

    // Off and on again: the user's choice survives, the label comes back.
    wb.totals(ta, false);
    assert_eq!(wb.cell(4, 0).1, engine::CellValue::Empty);
    {
        let effect = crate::document_effect::test_seed_effect();
        let mut tables = wb.state.tables.write(&effect).unwrap();
        let t = tables.get_mut(&0).unwrap().get_mut(&ta).unwrap();
        t.columns[1].totals_row_function = super::TotalsRowFunction::Average;
    }
    let shown = wb.totals(ta, true);
    assert_eq!(shown.columns[1].totals_row_function, super::TotalsRowFunction::Average);
    let (f, v) = wb.cell(4, 1);
    assert!(f.contains("SUBTOTAL(101,"), "the chosen function was replaced by a default: {}", f);
    assert_eq!(v, engine::CellValue::Number(2.0));
    assert_eq!(wb.cell(4, 0).1, engine::CellValue::Text("Total".to_string()));
}

/// The default's rule over the column's values [LIVE probe5]: numbers (blanks
/// allowed) are Sum; a text cell, a boolean, a date-formatted number or an
/// empty column is Count.
#[test]
fn the_default_totals_function_follows_the_last_columns_values() {
    let wb = Wb::new();
    let cases: [(&[&str], bool); 6] = [
        (&["1", "2", "3"], true),
        (&["", "2", "3"], true),
        (&["1", "x", "y"], false),
        (&["TRUE", "FALSE", "TRUE"], false),
        (&["", "", ""], false),
        (&["=1+1", "=2+2", "=3"], true),
    ];
    for (i, (values, sum)) in cases.iter().enumerate() {
        let col = i as u32;
        for (r, v) in values.iter().enumerate() {
            if !v.is_empty() {
                wb.set(r as u32 + 1, col, v);
            }
        }
        let grid = wb.state.grid.read().unwrap();
        let styles = wb.state.style_registry.read().unwrap();
        assert_eq!(super::totals_default_is_sum(&grid, &styles, 1, 3, col), *sum, "{:?}", values);
    }
}

/// rev-xlsx-3: renaming a table rewrites EVERY formula that names it -- the
/// cells, other tables' calculated columns and custom totals, and defined
/// names. [LIVE, review rev-xlsx] Excel rewrites all of them; the stale
/// `Old[..]` an auto-expand then copied into new cells killed live Excel's
/// COM server opening the export.
/// SABOTAGE (tablefix-ren): `rename_table_refs_in_formula_text` returns None.
#[test]
fn renaming_a_table_rewrites_stored_formulas_and_defined_names() {
    let wb = Wb::new();
    for (col, header) in [(0u32, "A"), (2, "P"), (3, "Q")] {
        wb.set(0, col, header);
    }
    for row in 1..=3u32 {
        wb.set(row, 0, &row.to_string());
        wb.set(row, 2, &row.to_string());
    }
    let old = wb.table_over("Old", (0, 0));
    let other = wb.table_over("Other", (2, 3));
    {
        let effect = crate::document_effect::test_seed_effect();
        let mut tables = wb.state.tables.write(&effect).unwrap();
        let t = tables.get_mut(&0).unwrap().get_mut(&other).unwrap();
        t.columns[1].calculated_formula = Some("=[@P]+SUM(Old[A])".to_string());
        t.columns[0].totals_row_formula = Some("=COUNT(Old[A])".to_string());
    }
    let defined = crate::named_ranges::create_named_range_impl(
        &wb.state,
        &wb.file,
        "OldTotal".to_string(),
        None,
        "=SUM(Old[A])".to_string(),
        None,
        None,
    );
    assert!(defined.success, "{:?}", defined.error);

    let renamed = super::rename_table_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, 0, old, "New".to_string(),
    );
    assert!(renamed.success, "{:?}", renamed.error);

    let upper = |s: &Option<String>| s.clone().unwrap_or_default().to_ascii_uppercase();
    let tables = wb.state.tables.read().unwrap();
    let t = &tables[&0][&other];
    let calc = upper(&t.columns[1].calculated_formula);
    assert!(calc.contains("NEW[A]") && !calc.contains("OLD["), "calculated column kept the old name: {}", calc);
    let total = upper(&t.columns[0].totals_row_formula);
    assert!(total.contains("NEW[A]") && !total.contains("OLD["), "custom total kept the old name: {}", total);
    drop(tables);
    let names = wb.state.named_ranges.read().unwrap();
    let refers = names.values().find(|n| n.name == "OldTotal").map(|n| n.refers_to.to_ascii_uppercase()).unwrap();
    assert!(refers.contains("NEW[A]") && !refers.contains("OLD["), "the defined name kept the old name: {}", refers);
}

/// rev-xlsx-1: no table over a data table. [LIVE, Excel 16, review rev-xlsx]
/// `ListObjects.Add` over a data table is refused "Multi-cell array formulas
/// aren't allowed in tables.", and a file holding a data table inside a table
/// is one Excel refuses to open. The create is refused before anything
/// changes; the same create beside the data table succeeds.
/// SABOTAGE (tablefix-dt): `overlaps_data_table` returns false.
#[test]
fn a_table_cannot_be_created_over_a_data_table() {
    let wb = Wb::new();
    wb.set(0, 0, "1");
    for (r, header) in [(0u32, "In"), (0, "Out")].iter().enumerate() {
        wb.set(header.0, 1 + r as u32, header.1);
    }
    {
        let effect = crate::document_effect::test_seed_effect();
        let ast = crate::convert_expr(&parser::parse("=TABLE(,A1)").unwrap());
        let mut grid = wb.state.grid.write(&effect).unwrap();
        let mut grids = wb.state.grids.write(&effect).unwrap();
        for row in 1..=3u32 {
            let mut cell = engine::Cell::new_formula("=TABLE(,A1)".to_string());
            cell.set_cached_ast(ast.clone());
            grid.set_cell(row, 2, cell.clone());
            grids[0].set_cell(row, 2, cell);
        }
        assert!(engine::data_table::has_data_tables(&grid), "fixture: a data table on C2:C4");
    }
    crate::document_effect::mark_saved(&wb.file);
    let refused = super::create_table_core(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        super::CreateTableParams {
            name: String::new(),
            start_row: 0,
            start_col: 1,
            end_row: 3,
            end_col: 2,
            has_headers: true,
            style_options: None,
            style_name: None,
        },
    );
    assert_eq!(refused.error.as_deref(), Some(super::TABLE_OVER_ARRAY_MESSAGE));
    assert!(!wb.file.is_dirty(), "a refused create must leave the document clean");
    assert!(wb.state.tables.read().unwrap().get(&0).map_or(true, |t| t.is_empty()));
    wb.set(0, 5, "H");
    wb.set(1, 5, "1");
    let beside = wb.create("Beside", 5);
    assert!(beside.success, "positive control: {:?}", beside.error);
}
