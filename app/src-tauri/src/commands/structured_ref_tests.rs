//! FILENAME: app/src-tauri/src/commands/structured_ref_tests.rs
//! PURPOSE: §2aj — a typed formula KEEPS its structured reference, the specifier
//! resolves at EVALUATION, and growing / shrinking / renaming / deleting the
//! table moves every formula that reads it. Plus §2ai, the third restamp.
//!
//! A child module of `commands::data` (declared with `#[path]` there) so it
//! reaches `update_cell_impl` and reuses the `Workbook` harness from
//! `cross_sheet_recalc_tests`. A copied harness drifts, and a drifted harness is
//! how a recalculation defect hides.
//!
//! THE DEFECT THESE PIN. `split_entered_formula` called `resolve_positional_refs`,
//! which spliced every `TableRef` into a plain absolute `Range` **before the cell
//! stored anything**: with `Sales` over `A1:A4`, typing `=SUM(Sales[Amount])`
//! left the cell holding `=SUM($A$2:$A$4)`. Two harms, and they are different.
//!
//!   * TRANSPARENCY — the formula bar showed a substitute for what was typed.
//!   * CORRECTNESS-BY-PARITY — a fixed rectangle in absolute coordinates cannot
//!     follow a table. Adding a row left the total at 60 where Excel says 100,
//!     with nothing in the document saying so.
//!
//! It is the identical defect D2 fixed for defined names, so it is fixed the
//! same way and pinned by the same shape of test. The half that is easy to get
//! wrong is again the DEPENDENCY EDGE — a table is not a cell, so it is in none
//! of `dependents` / `column_dependents` / `row_dependents` /
//! `cross_sheet_dependents` — plus a SECOND half the name case does not have:
//! resizing a table changes which CELLS a reader reads, so the cell-level edges
//! have to be re-derived as well, or the total would follow the resize once and
//! then never notice an edit to the row it gained.

use super::*;
use super::cross_sheet_recalc_tests::{body_of, Workbook};
use crate::tables::{Table, TableColumn, TableStyleOptions};
use engine::CellValue;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

impl Workbook {
    /// Register a table straight into `AppState`, the way `create_table` does.
    ///
    /// The command takes six `State<..>` guards and cannot run in-process; the
    /// store write is reproduced here and every BEHAVIOURAL step below goes
    /// through the same shared helper the commands call. `command_wiring` at the
    /// bottom pins from source that they really do call it.
    fn add_table(&self, name: &str, sheet: usize, bounds: (u32, u32, u32, u32), columns: &[&str]) {
        let (start_row, start_col, end_row, end_col) = bounds;
        let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let table = Table {
            id,
            name: name.to_string(),
            sheet_index: sheet,
            start_row,
            start_col,
            end_row,
            end_col,
            columns: columns
                .iter()
                .map(|c| {
                    TableColumn::new(
                        identity::EntityId::from_bytes(identity::generate_uuid_v7()),
                        c.to_string(),
                    )
                })
                .collect(),
            style_options: TableStyleOptions {
                header_row: true,
                show_filter_button: false,
                ..Default::default()
            },
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        };
        let effect = crate::document_effect::test_seed_effect();
        self.state
            .tables
            .write(&effect)
            .unwrap()
            .entry(sheet)
            .or_default()
            .insert(id, table);
        self.state
            .table_names
            .write(&effect)
            .unwrap()
            .insert(name.to_uppercase(), (sheet, id));
    }

    fn table_id_of(&self, name: &str) -> identity::EntityId {
        self.state.table_names.read().unwrap()[&name.to_uppercase()].1
    }

    /// Move a table's boundary, then run exactly what every resizing command
    /// runs afterwards.
    fn resize_table_to(&self, name: &str, bounds: (u32, u32, u32, u32)) {
        let id = self.table_id_of(name);
        {
            let effect = crate::document_effect::test_seed_effect();
            let mut tables = self.state.tables.write(&effect).unwrap();
            for sheet_tables in tables.values_mut() {
                if let Some(t) = sheet_tables.get_mut(&id) {
                    t.start_row = bounds.0;
                    t.start_col = bounds.1;
                    t.end_row = bounds.2;
                    t.end_col = bounds.3;
                }
            }
        }
        self.table_changed(&[name]);
    }

    fn rename_table_to(&self, old: &str, new: &str) {
        let id = self.table_id_of(old);
        {
            let effect = crate::document_effect::test_seed_effect();
            let mut tables = self.state.tables.write(&effect).unwrap();
            let mut names = self.state.table_names.write(&effect).unwrap();
            for sheet_tables in tables.values_mut() {
                if let Some(t) = sheet_tables.get_mut(&id) {
                    t.name = new.to_string();
                }
            }
            let entry = names.remove(&old.to_uppercase()).unwrap();
            names.insert(new.to_uppercase(), entry);
        }
        // What `rename_table` does next: carry every dependent reference over.
        {
            let effect = crate::document_effect::test_seed_effect();
            let mut grids = self.state.grids.write(&effect).unwrap();
            let mut grid = self.state.grid.write(&effect).unwrap();
            let active = *self.state.active_sheet.read().unwrap();
            let old_upper = old.to_uppercase();
            for (sheet_idx, sheet_grid) in grids.iter_mut().enumerate() {
                let coords: Vec<(u32, u32)> = sheet_grid.cells.keys().copied().collect();
                for (row, col) in coords {
                    let Some(cell) = sheet_grid.get_cell(row, col) else { continue };
                    let Some(ast) = cell.get_ast() else { continue };
                    let (renamed, changed) =
                        crate::rename_table_refs_in_ast(ast, &old_upper, new);
                    if !changed {
                        continue;
                    }
                    let mut updated = cell.clone();
                    updated.ast = Some(Box::new(renamed));
                    sheet_grid.set_cell(row, col, updated.clone());
                    if sheet_idx == active {
                        grid.set_cell(row, col, updated);
                    }
                }
            }
        }
        self.table_changed(&[old, new]);
    }

    fn drop_table(&self, name: &str) {
        let id = self.table_id_of(name);
        {
            let effect = crate::document_effect::test_seed_effect();
            let mut tables = self.state.tables.write(&effect).unwrap();
            for sheet_tables in tables.values_mut() {
                sheet_tables.remove(&id);
            }
            self.state
                .table_names
                .write(&effect)
                .unwrap()
                .remove(&name.to_uppercase());
        }
        self.table_changed(&[name]);
    }

    /// What every table command runs after the store write: the shared
    /// recalculation.
    fn table_changed(&self, names: &[&str]) {
        let owned: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        crate::tables::recalc_after_table_change(
            &self.state,
            &self.files,
            &self.pivots,
            &self.pane,
            &self.filters,
            &owned,
            &[],
        );
    }

    /// The formula the FORMULA BAR would show — rendered from the stored AST,
    /// exactly as `CellData::formula` is.
    fn formula_of(&self, sheet: usize, row: u32, col: u32) -> String {
        self.state.grids.read().unwrap()[sheet]
            .get_cell(row, col)
            .and_then(|c| c.formula_string())
            .unwrap_or_default()
    }

    fn table_dependents_of(&self, name: &str) -> Vec<(u32, u32)> {
        let map = self.state.table_dependents.lock().unwrap();
        let mut v: Vec<(u32, u32)> = map
            .get(&name.to_uppercase())
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default();
        v.sort_unstable();
        v
    }

    /// A1:A4 headed `Amount` with 10/20/30 under it, and a table over it.
    fn sales_fixture(&self) -> &Self {
        self.set(0, 0, "Amount");
        self.set(1, 0, "10");
        self.set(2, 0, "20");
        self.set(3, 0, "30");
        self.add_table("Sales", 0, (0, 0, 3, 0), &["Amount"]);
        self
    }
}

// ---------------------------------------------------------------------------
// 1. The cell keeps the specifier
// ---------------------------------------------------------------------------

#[test]
fn typing_a_structured_reference_stores_the_specifier_not_its_expansion() {
    let wb = Workbook::new(1);
    wb.sales_fixture();
    wb.set(0, 2, "=SUM(Sales[Amount])");

    assert_eq!(
        wb.formula_of(0, 0, 2),
        "SUM(Sales[Amount])",
        "the document must hold the SPECIFIER. Storing `SUM($A$2:$A$4)` is what \
         made a structured reference a one-shot typing macro that could not \
         follow its own table"
    );
    assert_eq!(
        wb.number(0, 0, 2),
        60.0,
        "and it must still evaluate to the same number it always did"
    );
}

#[test]
fn the_stored_specifier_is_spelled_the_way_the_table_spells_it() {
    // §2t, one authority over. The lexer uppercases bare identifiers and
    // `parse_bracket_content` builds a column name out of identifier tokens, so
    // without the restamp the formula bar would shout `SALES[AMOUNT]`.
    let wb = Workbook::new(1);
    wb.sales_fixture();
    wb.set(0, 2, "=SUM(sales[amount])");

    assert_eq!(
        wb.formula_of(0, 0, 2),
        "SUM(Sales[Amount])",
        "Excel canonicalises a typed structured reference to the table's own \
         capitalisation; the lexer's uppercasing must not reach the document"
    );
}

#[test]
fn a_reference_to_a_table_that_does_not_exist_is_kept_exactly_as_typed() {
    // There is no authority to re-spell it from, and inventing one would let a
    // `#NAME?` acquire a plausible-looking table name it never had.
    //
    // THE TWO HALVES ARE SPELLED BY DIFFERENT RULES, and the difference is the
    // point of this row. The TABLE name comes back uppercased because the lexer
    // uppercases bare identifiers; the COLUMN name comes back exactly as typed,
    // because a structured reference's bracket body is now read as raw text
    // rather than as tokens. It used to read `[AMOUNT]` here, which was the
    // lexer leaking a spelling the user never wrote into a formula no table can
    // correct.
    let wb = Workbook::new(1);
    wb.set(0, 2, "=SUM(NoSuchTable[Amount])");
    assert_eq!(
        wb.formula_of(0, 0, 2),
        "SUM(NOSUCHTABLE[Amount])",
        "the column keeps the user's spelling; only the table name is the \
         lexer's, and nothing in the workbook can say how that should be spelled"
    );
}

// ---------------------------------------------------------------------------
// 2. The table is LIVE — the reason the whole change exists
// ---------------------------------------------------------------------------

#[test]
fn a_table_that_grows_recalculates_its_readers() {
    let wb = Workbook::new(1);
    wb.sales_fixture();
    wb.set(0, 2, "=SUM(Sales[Amount])");
    assert_eq!(wb.number(0, 0, 2), 60.0);

    // A row under the table's data, then the table grows over it — which is
    // exactly what `check_table_auto_expand` does when the user types there.
    wb.set(4, 0, "40");
    wb.resize_table_to("Sales", (0, 0, 4, 0));

    assert_eq!(
        wb.number(0, 0, 2),
        100.0,
        "THE defect §2aj is about: the stored form was a fixed rectangle, so the \
         total stayed at 60 while the table said five rows"
    );
    assert_eq!(
        wb.formula_of(0, 0, 2),
        "SUM(Sales[Amount])",
        "and the formula itself must not have been rewritten to say so"
    );
}

#[test]
fn a_row_the_table_gained_is_a_precedent_from_then_on() {
    // The half that is easy to miss. Recalculating once when the table grows is
    // not enough: the READER'S CELL EDGES have to be re-derived too, or the
    // total is right once and then silently wrong on the next edit.
    let wb = Workbook::new(1);
    wb.sales_fixture();
    wb.set(0, 2, "=SUM(Sales[Amount])");
    wb.set(4, 0, "40");
    wb.resize_table_to("Sales", (0, 0, 4, 0));
    assert_eq!(wb.number(0, 0, 2), 100.0);

    wb.set(4, 0, "50");
    assert_eq!(
        wb.number(0, 0, 2),
        110.0,
        "editing a row the table GAINED must reach the total through the \
         ordinary cell cascade -- an edge nobody re-derived is a stale value"
    );
}

#[test]
fn a_table_that_shrinks_recalculates_its_readers() {
    let wb = Workbook::new(1);
    wb.sales_fixture();
    wb.set(0, 2, "=SUM(Sales[Amount])");
    assert_eq!(wb.number(0, 0, 2), 60.0);

    wb.resize_table_to("Sales", (0, 0, 2, 0));
    assert_eq!(
        wb.number(0, 0, 2),
        30.0,
        "shrinking is the same fact in the other direction, and the OLD row must \
         stop being a precedent"
    );

    wb.set(3, 0, "999");
    assert_eq!(
        wb.number(0, 0, 2),
        30.0,
        "a row the table LOST must no longer reach the total"
    );
}

#[test]
fn a_reader_on_another_sheet_recalculates_too() {
    let wb = Workbook::new(2);
    wb.sales_fixture();
    wb.switch_to(1);
    wb.set(0, 0, "=SUM(Sheet1!A2:A4)");
    wb.switch_to(0);
    // The off-sheet half of `recalc_after_table_change` is found by asking each
    // grid whether any formula MENTIONS the table, so the reader has to be a
    // structured one to be in that population.
    wb.switch_to(1);
    wb.set(1, 0, "=SUM(Sales[Amount])");
    assert_eq!(wb.number(1, 1, 0), 60.0);

    wb.switch_to(0);
    wb.set(4, 0, "40");
    wb.resize_table_to("Sales", (0, 0, 4, 0));

    assert_eq!(
        wb.number(1, 1, 0),
        100.0,
        "the per-sheet dependency maps describe the ACTIVE sheet only, so an \
         off-sheet reader needs the grid-walking half of the recalculation"
    );
}

#[test]
fn a_structured_reference_reads_the_tables_sheet_not_the_formulas() {
    // FOUND BY THE TEST ABOVE, and it is a defect of its own, older than §2aj:
    // a table's NAME is workbook-wide, so `=SUM(Sales[Amount])` is legal on any
    // sheet -- but the resolution built its range with `sheet: None`, which
    // means "the sheet the formula is on". Written on Sheet2 against a table on
    // Sheet1 it read SHEET2's A2:A4: the right rectangle on the wrong sheet,
    // with no error anywhere. Excel reads the table.
    let wb = Workbook::new(2);
    wb.sales_fixture();
    // Decoys in Sheet2's own A2:A4, so a formula that resolved locally would
    // produce a DIFFERENT, plausible number rather than zero.
    wb.switch_to(1);
    wb.set(1, 0, "1");
    wb.set(2, 0, "2");
    wb.set(3, 0, "3");
    wb.set(0, 2, "=SUM(Sales[Amount])");

    assert_eq!(
        wb.number(1, 0, 2),
        60.0,
        "the specifier must resolve against the sheet the TABLE is on; 6 would \
         mean it read this sheet's own A2:A4"
    );
}

#[test]
fn a_reader_that_reaches_the_table_through_a_defined_name_recalculates_too() {
    // The hole a table -> cell edge cannot see: `MyRange` = `=Sales[Amount]` and
    // `=SUM(MyRange)`. The reader's own AST says only `MyRange`, so it is in no
    // table bucket and `cell_reads_any_table` answers false for it -- yet
    // growing the table changes its value. `recalc_after_table_change` asks the
    // name table which NAMES read a changed table, and seeds their readers.
    let wb = Workbook::new(1);
    wb.sales_fixture();
    {
        let mut names = wb
            .state
            .named_ranges
            .write(&crate::document_effect::test_seed_effect())
            .unwrap();
        names.insert(
            "MYRANGE".to_string(),
            crate::named_ranges::NamedRange {
                name: "MyRange".to_string(),
                sheet_index: None,
                refers_to: "=Sales[Amount]".to_string(),
                comment: None,
                folder: None,
            },
        );
    }
    wb.set(0, 2, "=SUM(MyRange)");
    assert_eq!(wb.number(0, 0, 2), 60.0);

    wb.set(4, 0, "40");
    wb.resize_table_to("Sales", (0, 0, 4, 0));

    assert_eq!(
        wb.number(0, 0, 2),
        100.0,
        "a table change must reach a reader that gets there through a name, or \
         the indirection is a place stale values hide"
    );
}

// ---------------------------------------------------------------------------
// 3. Rename and delete, as Excel does them
// ---------------------------------------------------------------------------

#[test]
fn renaming_a_table_carries_its_readers_over() {
    let wb = Workbook::new(1);
    wb.sales_fixture();
    wb.set(0, 2, "=SUM(Sales[Amount])");
    assert_eq!(wb.number(0, 0, 2), 60.0);

    wb.rename_table_to("Sales", "Revenue");

    assert_eq!(
        wb.formula_of(0, 0, 2),
        "SUM(Revenue[Amount])",
        "Excel rewrites every structured reference when a table is renamed; \
         leaving the old name would make the formula #NAME?"
    );
    assert_eq!(wb.number(0, 0, 2), 60.0, "and the value must not move");
    assert_eq!(
        wb.table_dependents_of("SALES"),
        Vec::<(u32, u32)>::new(),
        "the edge is keyed by NAME, so the old bucket must be gone"
    );
    assert_eq!(
        wb.table_dependents_of("REVENUE"),
        vec![(0, 2)],
        "...and the new one must exist, or the next resize reaches nothing"
    );
}

#[test]
fn the_renamed_table_is_still_live() {
    let wb = Workbook::new(1);
    wb.sales_fixture();
    wb.set(0, 2, "=SUM(Sales[Amount])");
    wb.rename_table_to("Sales", "Revenue");

    wb.set(4, 0, "40");
    wb.resize_table_to("Revenue", (0, 0, 4, 0));
    assert_eq!(
        wb.number(0, 0, 2),
        100.0,
        "a rename that left the edge behind would make the table stop following \
         silently, which is the whole class this change closes"
    );
}

#[test]
fn deleting_a_table_leaves_its_readers_reporting_a_name_error() {
    // EXCEL, VERIFIED BY BEHAVIOUR RATHER THAN ASSUMED: there is no Excel
    // gesture that deletes a table object and leaves the cells, so the closest
    // parity question is what an UNRESOLVABLE structured reference does — and
    // Excel answers `#NAME?`. The product's own `delete_table` command avoids
    // the situation entirely by flattening every reference to the equivalent
    // range first (`rewrite_table_refs_to_ranges`, which `convert_to_range`
    // shares and which IS Excel's Convert to Range); this test covers the
    // registry-level fact underneath it, so a future caller that forgets the
    // flattening produces an ERROR rather than a stale number.
    let wb = Workbook::new(1);
    wb.sales_fixture();
    wb.set(0, 2, "=SUM(Sales[Amount])");
    assert_eq!(wb.number(0, 0, 2), 60.0);

    wb.drop_table("Sales");

    assert!(
        matches!(wb.value(0, 0, 2), CellValue::Error(_)),
        "a reference to a table that no longer exists must report an error, not \
         keep the number it computed while the table was there; got {:?}",
        wb.value(0, 0, 2)
    );
}

#[test]
fn creating_a_table_resolves_the_formulas_that_were_waiting_for_it() {
    // The mirror of D2's "an undefined name still earns an edge": a structured
    // reference typed BEFORE its table exists is a `#NAME?` cell, and creating
    // the table has to turn it into a number.
    let wb = Workbook::new(1);
    wb.set(0, 0, "Amount");
    wb.set(1, 0, "10");
    wb.set(2, 0, "20");
    wb.set(3, 0, "30");
    wb.set(0, 2, "=SUM(Sales[Amount])");
    assert!(
        matches!(wb.value(0, 0, 2), CellValue::Error(_)),
        "no table yet, so the specifier cannot resolve"
    );

    wb.add_table("Sales", 0, (0, 0, 3, 0), &["Amount"]);
    wb.table_changed(&["Sales"]);

    assert_eq!(
        wb.number(0, 0, 2),
        60.0,
        "the edge is recorded for a table that does not exist yet precisely so \
         creating it reaches the cells that were waiting"
    );
}

// ---------------------------------------------------------------------------
// 4. The edge itself
// ---------------------------------------------------------------------------

#[test]
fn the_edge_is_recorded_and_dropped_with_the_formula() {
    let wb = Workbook::new(1);
    wb.sales_fixture();
    wb.set(0, 2, "=SUM(Sales[Amount])");
    assert_eq!(wb.table_dependents_of("SALES"), vec![(0, 2)]);

    wb.set(0, 2, "=1+1");
    assert_eq!(
        wb.table_dependents_of("SALES"),
        Vec::<(u32, u32)>::new(),
        "retyping the cell as something that reads no table must drop the edge"
    );

    wb.set(0, 2, "=SUM(Sales[Amount])");
    assert_eq!(wb.table_dependents_of("SALES"), vec![(0, 2)]);
    wb.set(0, 2, "");
    assert_eq!(
        wb.table_dependents_of("SALES"),
        Vec::<(u32, u32)>::new(),
        "and CLEARING it must drop the edge too -- the branch that clears a cell \
         is a separate one, and it is where the name edge was once forgotten"
    );
}

#[test]
fn the_edge_survives_a_sheet_switch() {
    // `rebuild_all_dependencies` re-derives the sheet-less maps on every switch.
    // A table edge it did not re-derive would leave the table looking unread.
    let wb = Workbook::new(2);
    wb.sales_fixture();
    wb.set(0, 2, "=SUM(Sales[Amount])");
    assert_eq!(wb.table_dependents_of("SALES"), vec![(0, 2)]);

    wb.switch_to(1);
    wb.switch_to(0);

    assert_eq!(
        wb.table_dependents_of("SALES"),
        vec![(0, 2)],
        "the rebuild derives table edges from the STORED tree, which is the one \
         in the grid"
    );

    wb.set(4, 0, "40");
    wb.resize_table_to("Sales", (0, 0, 4, 0));
    assert_eq!(wb.number(0, 0, 2), 100.0);
}

#[test]
fn a_bare_this_row_reference_is_reached_by_any_table_change() {
    // `[@Amount]` names no table, so it registers under BARE_TABLE_KEY and every
    // table change includes that bucket. Over-recalculating by the cells that
    // contain a bare reference is the price of never missing one.
    //
    // THE TABLE IS TWO COLUMNS WIDE ON PURPOSE. The reader sits at B2, and a
    // bare specifier only resolves from a cell the table CONTAINS (§2ar) --
    // containment is on both axes. This used to pass with a one-column table
    // because `find_table_at_cell` matched on the row range alone, i.e. for the
    // reason §2ar is a defect. In the real app B2 next to a one-column table is
    // absorbed INTO the table by `check_table_auto_expand` before any formula
    // there is resolved, so a two-column table is what that cell is actually
    // sitting in; the harness writes cells directly and never runs that step.
    let wb = Workbook::new(1);
    wb.set(0, 0, "Amount");
    wb.set(1, 0, "10");
    wb.set(2, 0, "20");
    wb.set(3, 0, "30");
    wb.set(0, 1, "Double");
    wb.add_table("Sales", 0, (0, 0, 3, 1), &["Amount", "Double"]);

    wb.set(1, 1, "=[@Amount]*2");
    assert_eq!(wb.number(0, 1, 1), 20.0);

    assert_eq!(
        wb.table_dependents_of(crate::table_deps::BARE_TABLE_KEY),
        vec![(1, 1)],
        "a bare specifier still earns an edge"
    );

    wb.set(1, 0, "15");
    assert_eq!(
        wb.number(0, 1, 1),
        30.0,
        "and the ordinary cell cascade must reach it, because the resolved form \
         does name a cell"
    );
}

#[test]
fn a_bare_specifier_far_from_the_table_is_not_in_it() {
    // §2ar. `find_table_at_cell` matched on the ROW RANGE ALONE, so a bare
    // `[@Amount]` anywhere on the same rows resolved against a table it is not
    // in -- and answered with a plausible NUMBER, not an error.
    //
    // EXCEL. The unqualified `[@Column]` form is only legal inside the table;
    // from anywhere else the reference must name its table (`Sales[@Amount]`).
    // A bare specifier in a cell outside every table is `#NAME?`.
    //
    // WHY COLUMN Z AND NOT COLUMN B. B2 is one column right of a table ending at
    // A, which is precisely where Excel's table AUTO-EXPANSION absorbs the cell
    // INTO the table -- so `[@Amount]` there is legal, and for a reason that has
    // nothing to do with this resolver (`check_table_auto_expand` handles it,
    // and `a_bare_this_row_reference_is_reached_by_any_table_change` above
    // covers that neighbour). Column Z is far outside the table on every axis,
    // so auto-expansion can never reach it and the answer is unambiguous.
    let wb = Workbook::new(1);
    wb.sales_fixture(); // Sales over A1:A4
    wb.set(1, 25, "=[@Amount]*2"); // Z2 -- same ROW as the table, nowhere near it

    assert_eq!(
        wb.value(0, 1, 25),
        CellValue::Error(engine::CellError::Name),
        "a bare specifier outside every table names no column, so it is #NAME? -- \
         resolving it against whichever table happens to share the row is a \
         WRONG ANSWER that looks like a right one"
    );
}

#[test]
fn a_bare_specifier_inside_the_table_still_resolves() {
    // The other side of the same gate: widening `find_table_at_cell` to check
    // the column must not break the case the specifier exists for. A calculated
    // column lives INSIDE the table, and that is the ordinary way `[@Col]` is
    // written.
    let wb = Workbook::new(1);
    wb.set(0, 0, "Amount");
    wb.set(1, 0, "10");
    wb.set(2, 0, "20");
    wb.set(0, 1, "Double");
    wb.add_table("Sales", 0, (0, 0, 2, 1), &["Amount", "Double"]);

    wb.set(1, 1, "=[@Amount]*2");
    assert_eq!(
        wb.number(0, 1, 1),
        20.0,
        "a bare specifier in a cell the table CONTAINS resolves against that table"
    );
}

// ---------------------------------------------------------------------------
// 5. Save / reload, and the ordering walks
// ---------------------------------------------------------------------------

#[test]
fn a_specifier_survives_the_render_reparse_round_trip() {
    // What a `.cala` reload does to every formula: render the stored AST to
    // text, parse the text back, and restamp the casing the lexer flattened
    // (`restamp_workbook_name_casing`, the load half). A specifier that does not
    // survive that is a formula the document silently loses on save -- and the
    // RESTAMP is part of the contract, not a cosmetic afterthought: without it
    // `Sales[Amount]` comes back as `SALES[AMOUNT]`, which is §2t.
    let wb = Workbook::new(1);
    wb.sales_fixture();
    for typed in [
        "=SUM(Sales[Amount])",
        "=SUM(Sales[#All])",
        "=SUM(Sales[#Data])",
        "=COUNTA(Sales[#Headers])",
        "=SUM(Sales[[Amount]:[Amount]])",
    ] {
        wb.set(0, 2, typed);
        let rendered = format!("={}", wb.formula_of(0, 0, 2));
        let mut reparsed = parser::parse(&rendered)
            .unwrap_or_else(|e| panic!("`{}` did not re-parse: {:?}", rendered, e));
        {
            let tables = wb.state.tables.read().unwrap();
            let table_names = wb.state.table_names.read().unwrap();
            crate::table_deps::restamp_table_casing(&mut reparsed, &tables, &table_names);
        }
        assert_eq!(
            format!("={}", engine::ast_render::render_formula_raw(&reparsed)),
            rendered,
            "`{}` must round-trip through render + parse + restamp unchanged",
            typed
        );
    }
}

/// The census vocabulary's guarantee: `recalc_after_table_change` is not a
/// second cascade, it SEEDS the shared one. Three censuses now accept a call to
/// it as satisfying them, so if that were ever to stop being true they would all
/// go blind at once — which is the exact hole `DELEGATING_HELPERS` was written
/// to close for `write_table_formula_cell`.
#[test]
fn the_table_recalculation_reaches_the_shared_cascade() {
    let source = include_str!("../tables.rs");
    let body = body_of(source, "recalc_after_table_change");
    for needle in [
        "recalc_after_active_sheet_bulk_rewrite(",
        "recalc_after_off_sheet_write(",
        // The EDGE half: a resize moves which cells a reader reads, and
        // nothing else re-derives that.
        "refresh_reader_edges(",
    ] {
        assert!(
            body.contains(needle),
            "`recalc_after_table_change` no longer calls `{}`. Three censuses              accept a call to it as proof that a table command recalculates;              the moment it stops seeding the ONE shared cascade, that becomes a              way to satisfy every one of them with nothing behind it.",
            needle
        );
    }
}

#[test]
fn f9_orders_a_structured_reader_after_the_cells_it_reads() {
    // `build_workbook_plan` orders F9 from `extract_all_references`, which
    // cannot see through a `TableRef` -- so without the expansion the reader
    // sorts as an INPUT and computes from whatever the table held before the
    // pass. The chain here is long enough that an unordered pass gets it wrong.
    let wb = Workbook::new(1);
    wb.set(0, 0, "Amount");
    wb.set(1, 0, "=D1*2"); // A2 depends on D1
    wb.set(2, 0, "=D1*3");
    wb.set(3, 0, "=D1*4");
    wb.add_table("Sales", 0, (0, 0, 3, 0), &["Amount"]);
    wb.set(0, 2, "=SUM(Sales[Amount])"); // C1 depends on the table
    wb.set(0, 3, "1"); // D1

    wb.recalculate_every_sheet();
    assert_eq!(
        wb.number(0, 0, 2),
        9.0,
        "2+3+4 -- a reader ordered as an input would have summed the values the \
         table's own formulas held BEFORE the pass"
    );
}

// ---------------------------------------------------------------------------
// 6. §2ai — the sheet qualifier keeps its own capitalisation
// ---------------------------------------------------------------------------

#[test]
fn a_sheet_qualifier_is_stored_the_way_the_tab_spells_it() {
    let wb = Workbook::new(2);
    {
        let effect = crate::document_effect::test_seed_effect();
        wb.state.sheet_names.write(&effect).unwrap()[1] = "Data".to_string();
    }
    wb.switch_to(1);
    wb.set(0, 0, "7");
    wb.switch_to(0);
    wb.set(0, 0, "=Data!A1");

    assert_eq!(
        wb.formula_of(0, 0, 0),
        "Data!A1",
        "§2ai: the lexer uppercases bare identifiers, so this came back as \
         `DATA!A1` -- shouting at the user and disagreeing with the sheet tab \
         AND with the quoted form, which never lost its case"
    );
    assert_eq!(wb.number(0, 0, 0), 7.0, "and it must still resolve");
}

#[test]
fn a_qualifier_naming_no_sheet_is_left_exactly_as_it_is() {
    // The delicacy of the third restamp: re-spelling a dangling qualifier would
    // let a `#REF!` acquire a plausible-looking sheet name it never had.
    let wb = Workbook::new(1);
    wb.set(0, 0, "=Ghost!A1");
    assert_eq!(
        wb.formula_of(0, 0, 0),
        "GHOST!A1",
        "no sheet by that name exists, so there is no authority to re-spell from"
    );
}

#[test]
fn renaming_a_sheet_restamps_the_formulas_that_qualify_it() {
    let wb = Workbook::new(2);
    {
        let effect = crate::document_effect::test_seed_effect();
        wb.state.sheet_names.write(&effect).unwrap()[1] = "Data".to_string();
    }
    wb.switch_to(1);
    wb.set(0, 0, "7");
    wb.switch_to(0);
    wb.set(0, 0, "=Data!A1");

    // What a rename does to the AST is a separate mechanism (`repair_named_ranges`
    // / the reference shifter); what THIS pins is that the restamp entry point
    // re-spells a grid from a changed name list, which is the load half.
    {
        let effect = crate::document_effect::test_seed_effect();
        wb.state.sheet_names.write(&effect).unwrap()[1] = "DATA_WAREHOUSE".to_string();
        wb.state.sheet_names.write(&effect).unwrap()[1] = "Data_Warehouse".to_string();
    }
    {
        let effect = crate::document_effect::test_seed_effect();
        let names = wb.state.sheet_names.read().unwrap().clone();
        let mut grid = wb.state.grids.write(&effect).unwrap();
        // The formula still says `Data`, which no longer matches any sheet, so
        // the restamp must NOT touch it -- there is nothing to re-spell it to.
        let n = crate::sheet_names::restamp_grid_sheet_casing(&mut grid[0], &names);
        assert_eq!(n, 0, "a qualifier that matches no sheet is not re-spelled");
    }

    // ...and when the spelling DOES differ only by case, it is.
    {
        let effect = crate::document_effect::test_seed_effect();
        wb.state.sheet_names.write(&effect).unwrap()[1] = "dATA".to_string();
        let names = wb.state.sheet_names.read().unwrap().clone();
        let mut grid = wb.state.grids.write(&effect).unwrap();
        let n = crate::sheet_names::restamp_grid_sheet_casing(&mut grid[0], &names);
        assert_eq!(n, 1, "a case-only difference IS re-spelled");
        assert_eq!(
            grid[0]
                .get_cell(0, 0)
                .and_then(|c| c.formula_string())
                .unwrap_or_default(),
            "dATA!A1"
        );
    }
}

// ---------------------------------------------------------------------------
// 7. Source-level wiring — the commands really do call the shared helper
// ---------------------------------------------------------------------------

/// Every table command that can move what a structured reference RESOLVES TO
/// must call `recalc_after_table_change`. Read from source, because the
/// behavioural tests above drive the helper directly: a command that skipped it
/// would leave every reader stale and every test above still green.
#[test]
fn command_wiring() {
    let source = include_str!("../tables.rs");
    for command in [
        "create_table",
        "delete_table",
        "rename_table",
        "resize_table",
        "add_table_column",
        "remove_table_column",
        "rename_table_column",
        "enforce_table_header",
        "convert_to_range",
        "check_table_auto_expand",
        "add_table_row",
        "toggle_totals_row",
        "set_totals_row_function",
    ] {
        let body = body_of(source, command);
        assert!(
            body.contains("recalc_after_table_change("),
            "`{}` moves what a structured reference resolves to, so it must \
             recalculate the formulas that read the table -- §2aj. Call \
             `recalc_after_table_change` after the guards are released.",
            command
        );
    }
}

/// The ENTRY path must not flatten a specifier back into a rectangle. Read from
/// source because a regression here is invisible to a value test: the number
/// stays right, and only the NEXT resize is wrong.
#[test]
fn entry_does_not_resolve_table_refs_into_the_stored_form() {
    let source = include_str!("../lib.rs");
    let body = body_of(source, "split_entered_formula");
    assert!(
        !body.contains("resolve_table_refs_now(state, parsed"),
        "`split_entered_formula` must not flatten the specifier before storing \
         it -- that is §2aj. The stored tree keeps `Sales[Amount]`; only the \
         `expanded` tree is resolved."
    );
    assert!(
        body.contains("restamp_table_casing"),
        "the stored tree has been through the lexer, so it must be re-spelled \
         from the table registry (§2t, for tables)"
    );
    assert!(
        body.contains("restamp_sheet_casing"),
        "...and from the sheet list (§2ai)"
    );
}
