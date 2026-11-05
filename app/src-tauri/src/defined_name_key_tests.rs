//! FILENAME: app/src-tauri/src/defined_name_key_tests.rs
//! PURPOSE: NEW-defined-name-key-expands-sharp-s -- a defined name is keyed by
//! Excel's DEFINED-NAME rule (`identity::defined_name_key`), everywhere it is
//! stored and looked up, so a formula reaches it however the lexer folded it.
//!
//! A child module of `name_resolution` (declared with `#[path]` there). Every
//! step goes through the REAL door: names through `create_named_range_impl` /
//! `update_named_range_core`, formulas through `update_cell_impl`, so the
//! parser's per-character fold (`Straße` -> `STRAẞE`), the resolver, the
//! dependency edge and the recalculation are all the shipped ones.
//!
//! Excel [LIVE, Excel 16, 2026-10-30, sv-SE regional settings, fresh unsaved
//! workbooks]: `Straße`, `STRASSE`, `STRAẞE` and `straße` are ONE defined name
//! (`Names.Add` of the second spelling replaces the first); with `STRASSE`
//! defined as 7, `=Straße*2` is 14 and Excel shows it as `=STRASSE*2`;
//! `=LET(straße,5,STRASSE)` is 7 and `=LET(STRASSE,5,straße)` is 7 -- a LET
//! binding is matched per character, so neither binding captures the other
//! spelling, which then reads the defined name.

use crate::persistence::{FileState, UserFilesState};
use crate::AppState;
use engine::{CellError, CellValue};

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

    fn define(&self, name: &str, refers_to: &str) -> crate::named_ranges::NamedRangeResult {
        crate::named_ranges::create_named_range_impl(
            &self.state,
            &self.file,
            name.to_string(),
            None,
            refers_to.to_string(),
            None,
            None,
        )
    }

    fn repoint(&self, name: &str, refers_to: &str) {
        let r = crate::named_ranges::update_named_range_core(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.pane,
            &self.filters,
            name.to_string(),
            None,
            refers_to.to_string(),
            None,
            None,
        );
        assert!(r.success, "update_named_range({name}): {:?}", r.error);
    }

    fn value(&self, row: u32, col: u32) -> CellValue {
        self.state.grid.read().unwrap().get_cell(row, col).map(|c| c.value.clone()).unwrap_or(CellValue::Empty)
    }
}

/// `=Straße` beside a name defined as `STRASSE` reads that name, and so does
/// every other spelling Excel treats as the same name; defining `Straße` again
/// is refused as a duplicate; repointing the name moves every reader; and a LET
/// binding is matched per character, as in Excel.
///
/// SABOTAGE: key defined names with `to_uppercase` again (`name_key`).
#[test]
fn a_formula_spelled_with_sharp_s_reads_the_name_excel_says_it_is() {
    let wb = Wb::new();
    let created = wb.define("STRASSE", "=7");
    assert!(created.success, "define STRASSE: {:?}", created.error);

    wb.set(0, 0, "=Straße"); // A1
    wb.set(1, 0, "=straße*2"); // A2
    wb.set(2, 0, "=STRAẞE+1"); // A3
    wb.set(3, 0, "=LET(straße,5,STRASSE)"); // A4: the binding does not capture STRASSE
    wb.set(4, 0, "=LET(STRASSE,5,straße)"); // A5: nor STRASSE straße
    wb.set(5, 0, "=LET(straße,5,STRAẞE)"); // A6: the per-character spelling IS the binding

    assert_eq!(
        wb.value(0, 0),
        CellValue::Number(7.0),
        "=Straße must read the defined name STRASSE (Excel: one name), not #NAME?"
    );
    assert_ne!(wb.value(0, 0), CellValue::Error(CellError::Name));
    assert_eq!(wb.value(1, 0), CellValue::Number(14.0), "=straße*2");
    assert_eq!(wb.value(2, 0), CellValue::Number(8.0), "=STRAẞE+1");
    assert_eq!(wb.value(3, 0), CellValue::Number(7.0), "LET(straße,5,STRASSE) reads the defined name [LIVE 7]");
    assert_eq!(wb.value(4, 0), CellValue::Number(7.0), "LET(STRASSE,5,straße) reads the defined name [LIVE 7]");
    assert_eq!(wb.value(5, 0), CellValue::Number(5.0), "LET(straße,5,STRAẞE) is its own binding");

    // One name, so a second spelling is a duplicate.
    let again = wb.define("Straße", "=1");
    assert!(!again.success, "Straße is the same name as STRASSE in Excel and must be refused as a duplicate");
    assert_eq!(wb.state.named_ranges.read().unwrap().len(), 1, "still one name");

    // The dependency edge is filed under the same key, so a repoint reaches
    // every spelling's reader.
    wb.repoint("Straße", "=10");
    assert_eq!(wb.value(0, 0), CellValue::Number(10.0), "=Straße follows the repoint");
    assert_eq!(wb.value(1, 0), CellValue::Number(20.0), "=straße*2 follows the repoint");
    assert_eq!(wb.value(3, 0), CellValue::Number(10.0), "the LET body follows the repoint");
    assert_eq!(wb.value(5, 0), CellValue::Number(5.0), "the bound LET does not");
}

/// Names Excel keeps APART stay apart: `qµ` (micro sign) and `qμ` (Greek mu)
/// are two names in Excel [LIVE], and `to_uppercase` merged them (both
/// uppercase to `QΜ`), so a second definition was refused and a formula read
/// whichever was defined first.
///
/// SABOTAGE: key defined names with `to_uppercase` again (`name_key`).
#[test]
fn names_excel_keeps_apart_stay_apart() {
    let wb = Wb::new();
    assert!(wb.define("q\u{B5}", "=1").success, "define the micro-sign name");
    let mu = wb.define("q\u{3BC}", "=2");
    assert!(mu.success, "qμ is a different name from qµ in Excel: {:?}", mu.error);
    wb.set(0, 0, "=q\u{B5}");
    wb.set(1, 0, "=q\u{3BC}");
    assert_eq!(wb.value(0, 0), CellValue::Number(1.0));
    assert_eq!(wb.value(1, 0), CellValue::Number(2.0));
}

/// TABLES AND DEFINED NAMES SHARE ONE NAMESPACE, compared by Excel's
/// defined-name rule on both sides. A defined name `Pæresalg` refuses a table
/// spelled `pæresalg` (the table gate asks the name map under
/// `identity::defined_name_key`), and a table registered as `Þing` refuses a
/// defined name `THING` (the name gate asks the table registry, which is keyed
/// by `tables::table_name_key`, the same rule). Names Excel keeps apart
/// (`qµ` / `qμ`) do not collide. [LIVE, relocref/probe-tables.ps1: a table
/// `qæ` refuses `Names.Add("qae")` -- "A table with that name already exists".]
///
/// SABOTAGE: key `name_collides_with_defined_name` with `to_uppercase` again;
/// separately, `table_name_key` with `to_uppercase`.
#[test]
fn a_table_and_a_defined_name_collide_by_excels_name_rule() {
    let wb = Wb::new();
    assert!(wb.define("Pæresalg", "=1").success);
    assert!(wb.define("q\u{B5}", "=2").success);
    assert!(
        crate::tables::name_collides_with_defined_name(&wb.state, "pæresalg"),
        "a table spelled like the defined name Pæresalg must be refused"
    );
    assert!(crate::tables::name_collides_with_defined_name(&wb.state, "PAERESALG"));
    assert!(
        !crate::tables::name_collides_with_defined_name(&wb.state, "q\u{3BC}"),
        "qμ is not the name qµ in Excel"
    );

    // The other direction: a table registered as Þing holds THING.
    wb.state.table_names.write(&crate::document_effect::test_seed_effect()).unwrap().insert(
        crate::tables::table_name_key("Þing"),
        (0, identity::EntityId::from_bytes(identity::generate_uuid_v7())),
    );
    let refused = wb.define("THING", "=3");
    assert!(!refused.success, "a defined name THING beside the table Þing must be refused");
    assert!(
        refused.error.as_deref().unwrap_or("").contains("A table named"),
        "{:?}",
        refused.error
    );
}

impl Wb {
    /// A header and one data row in column `col`, for a table to sit on.
    fn seed_column(&self, col: u32) {
        self.set(0, col, "H");
        self.set(1, col, "1");
    }

    /// A table over column `col` (header row 1, one data row) through the
    /// REAL create door, `tables::create_table_core`.
    fn create_table(&self, name: &str, col: u32) -> crate::tables::TableResult {
        crate::tables::create_table_core(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.pane,
            &self.filters,
            crate::tables::CreateTableParams {
                name: name.to_string(),
                start_row: 0,
                start_col: col,
                end_row: 1,
                end_col: col,
                has_headers: true,
                style_options: None,
                style_name: None,
            },
        )
    }

    fn rename_table(&self, id: identity::EntityId, new_name: &str) -> crate::tables::TableResult {
        crate::tables::rename_table_core(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.pane,
            &self.filters,
            0,
            id,
            new_name.to_string(),
        )
    }

    fn rename_name(&self, old: &str, new: &str) -> crate::named_ranges::NamedRangeResult {
        crate::named_ranges::rename_named_range_core(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.pane,
            &self.filters,
            old,
            new,
        )
    }

    fn table_count(&self) -> usize {
        self.state.table_names.read().unwrap().len()
    }
}

/// OWNER DECISION (2026-11-04, BUG-0616 note (d)): TABLES AND DEFINED NAMES
/// REFUSE EACH OTHER IN BOTH DIRECTIONS, through every door that can claim a
/// name -- a deliberate difference from Excel, whose COM accepts a table
/// renamed onto a defined name (and a defined name renamed onto a table) and
/// then leaves the table unreachable by name in formulas. Each refusal leaves
/// the document CLEAN and the registries as they were; each door's positive
/// control (a free name) succeeds in the same test. And a GENERATED name
/// skips a defined name, as Excel's does [LIVE, 2026-11-04,
/// calpdec-probe/genname.ps1: a defined name `Table1` makes the next table
/// `Table2`].
///
/// SABOTAGES (separate builds, each fails its own assertion): (1) drop the
/// `name_collides_with_defined_name` arm from `create_table_core` -- "a table
/// CREATED onto a defined name". (2) `create_table_core` mints its effect
/// before the gates again -- "a refused create left the document dirty".
/// (3) `generate_table_name` ignores `taken_by_defined_name` -- "the
/// generated name".
#[test]
fn tables_and_defined_names_refuse_each_other_in_both_directions_through_every_door() {
    let wb = Wb::new();
    assert!(wb.define("Rate", "=1").success);
    wb.seed_column(0);
    wb.seed_column(3);

    // TABLE -> DEFINED NAME, create door.
    crate::document_effect::mark_saved(&wb.file);
    let refused = wb.create_table("rate", 0);
    assert!(!refused.success, "a table CREATED onto a defined name must be refused");
    assert!(
        refused.error.as_deref().unwrap_or("").contains("A defined name with this name already exists"),
        "{:?}",
        refused.error
    );
    assert_eq!(wb.table_count(), 0, "nothing was registered");
    assert!(!wb.file.is_dirty(), "a refused create left the document dirty");
    // Positive control: a free name is created.
    let sales = wb.create_table("Sales", 0);
    assert!(sales.success, "a free table name must be accepted: {:?}", sales.error);
    let sales_id = sales.table.expect("the created table").id;

    // TABLE -> DEFINED NAME, rename door.
    crate::document_effect::mark_saved(&wb.file);
    let refused = wb.rename_table(sales_id, "RATE");
    assert!(!refused.success, "a table RENAMED onto a defined name must be refused (Excel accepts it)");
    assert!(!wb.file.is_dirty(), "a refused rename left the document dirty");
    assert!(
        wb.state.table_names.read().unwrap().contains_key(&crate::tables::table_name_key("Sales")),
        "the table keeps its name"
    );
    assert!(wb.rename_table(sales_id, "Revenue").success, "positive control: a free name renames");

    // DEFINED NAME -> TABLE, create door.
    let refused = wb.define("REVENUE", "=2");
    assert!(!refused.success, "a defined name CREATED onto a table must be refused");
    assert!(refused.error.as_deref().unwrap_or("").contains("A table named"), "{:?}", refused.error);

    // DEFINED NAME -> TABLE, rename door (Excel's Name.Name accepts it).
    crate::document_effect::mark_saved(&wb.file);
    let refused = wb.rename_name("Rate", "revenue");
    assert!(!refused.success, "a defined name RENAMED onto a table must be refused");
    assert!(refused.error.as_deref().unwrap_or("").contains("A table named"), "{:?}", refused.error);
    assert!(!wb.file.is_dirty(), "a refused name rename left the document dirty");
    assert!(wb.rename_name("Rate", "Ratio").success, "positive control: a free name renames");

    // THE GENERATED NAME skips a defined name, as Excel's does.
    assert!(wb.define("Table1", "=3").success);
    let generated = wb.create_table("", 3);
    assert!(generated.success, "{:?}", generated.error);
    assert_eq!(
        generated.table.expect("the generated table").name,
        "Table2",
        "the generated name must skip the defined name Table1 (Excel names it Table2)"
    );
}
