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
