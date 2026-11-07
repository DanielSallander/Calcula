//! FILENAME: app/src-tauri/src/pivot/pivotfix_tests.rs
//! PURPOSE: Ledger programme 2, wave 3 (lane pivotfix), through the real doors.
//!
//!   BUG-0760  GETPIVOTDATA over a pivot cell holding an error answered #REF!:
//!             the lookup could carry only a number (`Option<f64>`), and a
//!             calculated field -- the cells that DO hold errors -- was no
//!             value field, so it could not be named at all.
//!   BUG-0765  an off-sheet write (`update_cell_on_sheets_as`) evaluated the
//!             formula it wrote with no pivot lookup: `=GETPIVOTDATA(..)`
//!             stored #REF!, and a write that defers its recalculation
//!             (`recalc: false`) kept it.

use super::operations::{build_cache_from_grid, safe_calculate_pivot};
use super::types::PivotState;
use crate::document_effect::test_seed_effect;
use crate::persistence::{FileState, UserFilesState};
use crate::AppState;
use engine::{CellError, CellValue};
use pivot_engine::{AggregationType, CalculatedField, PivotDefinition, PivotField, PivotId, ValueField};

struct Fx {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    slicer: crate::slicer::SlicerState,
    pivots: PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
}

/// Sheet1 (active) and Sheet2 through the real add path, en-US.
fn fx() -> Fx {
    let state = crate::create_app_state();
    let file = FileState::default();
    crate::sheets::add_sheet_inner(&state, &file, None, ::persistence::SheetKind::Worksheet).expect("add a sheet");
    let seed = test_seed_effect();
    {
        let mut grids = state.grids.write(&seed).unwrap();
        let mut active = state.active_sheet.write(&seed).unwrap();
        let mut mirror = state.grid.write(&seed).unwrap();
        if *active != 0 {
            grids[*active] = mirror.clone();
            *mirror = grids[0].clone();
            *active = 0;
        }
    }
    *state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
    Fx {
        state,
        file,
        files: UserFilesState::default(),
        slicer: crate::slicer::SlicerState::new(),
        pivots: PivotState::new(),
        pane: crate::pane_control::PaneControlState::new(),
        filters: crate::ribbon_filter::RibbonFilterState::new(),
    }
}

impl Fx {
    /// One edit through the real single-cell edit door, on the active sheet.
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
        .unwrap_or_else(|e| panic!("update_cell({row},{col}): {e}"));
    }

    fn value(&self, sheet: usize, row: u32, col: u32) -> CellValue {
        if sheet == *self.state.active_sheet.read().unwrap() {
            return self.state.grid.read().unwrap().get_cell(row, col).map(|c| c.value.clone()).unwrap_or(CellValue::Empty);
        }
        self.state.grids.read().unwrap()[sheet].get_cell(row, col).map(|c| c.value.clone()).unwrap_or(CellValue::Empty)
    }
}

/// Region (A) / Amount (B) on Sheet1: East 10, West 5. A pivot at E3 on
/// Sheet1 -- Region on rows, Sum of Amount, and (`with_ratio`) the
/// calculated field Ratio = Amount/0 -- put in the store with its view, as a
/// create or a refresh leaves it.
fn amount_pivot(fx: &Fx, with_ratio: bool) -> PivotId {
    for (r, (region, amount)) in [("Region", "Amount"), ("East", "10"), ("West", "5")].iter().enumerate() {
        fx.set(r as u32, 0, region);
        fx.set(r as u32, 1, amount);
    }
    let source = fx.state.grid.read().unwrap().clone();
    let (mut cache, headers) = build_cache_from_grid(&source, (0, 0), (2, 1), true).expect("the cache");
    for (i, h) in headers.iter().enumerate() {
        cache.set_field_name(i, h.clone());
    }
    let mut def = PivotDefinition::new(identity::EntityId::from_bytes(identity::generate_uuid_v7()), (0, 0), (2, 1));
    def.source_has_headers = true;
    def.source_sheet = Some("Sheet1".to_string());
    def.destination_sheet = Some("Sheet1".to_string());
    def.destination = (2, 4);
    def.row_fields.push(PivotField::new(0, "Region".to_string()));
    def.value_fields.push(ValueField::new(1, "Sum of Amount".to_string(), AggregationType::Sum));
    if with_ratio {
        def.calculated_fields.push(CalculatedField {
            name: "Ratio".to_string(),
            formula: "Amount/0".to_string(),
            number_format: None,
        });
    }
    let view = safe_calculate_pivot(&def, &mut cache);
    let id = def.id;
    fx.pivots.pivot_tables.write(&test_seed_effect()).unwrap().insert(id, (def, cache));
    fx.pivots.views.lock().unwrap().insert(id, view);
    id
}

/// BUG-0760, the error itself. [LIVE, Excel 16, pivotfix probe1] a pivot
/// value cell holding `#DIV/0!` -- a Sum over a source `#DIV/0!`, its grand
/// total -- answers `#DIV/0!` through GETPIVOTDATA (`ERROR.TYPE` 2), never
/// #REF!. The lookup could carry only a number, so every error cell read as
/// "no such cell" (#REF!). The view's East cell is made to hold the error the
/// Excel pivot shows there (Calcula's aggregation does not yet carry a source
/// error, see the lane report), then GETPIVOTDATA is typed through the edit
/// door.
///
/// SABOTAGE (pivotfix-sabB): `pivot_cell_answer` reads an error as no answer
/// -- fails at "EAST ERROR" with #REF!.
#[test]
fn getpivotdata_over_a_value_cell_holding_an_error_answers_that_error() {
    let fx = fx();
    let id = amount_pivot(&fx, false);
    {
        let mut views = fx.pivots.views.lock().unwrap();
        let view = views.get_mut(&id).expect("the view");
        let east = view
            .cells
            .iter_mut()
            .flatten()
            .find(|c| c.value_field_index == Some(0) && c.group_path.len() == 1 && matches!(c.value, pivot_engine::PivotCellValue::Number(n) if n == 10.0))
            .expect("fixture: East's Sum of Amount cell");
        east.value = pivot_engine::PivotCellValue::Error("DIV/0!".to_string());
    }
    fx.set(0, 7, "=GETPIVOTDATA(\"Sum of Amount\",$E$3,\"Region\",\"East\")"); // H1
    fx.set(1, 7, "=GETPIVOTDATA(\"Sum of Amount\",$E$3,\"Region\",\"West\")"); // H2
    fx.set(2, 7, "=GETPIVOTDATA(\"Sum of Amount\",$E$3,\"Region\",\"North\")"); // H3
    assert_eq!(fx.value(0, 0, 7), CellValue::Error(CellError::Div0), "EAST ERROR: the cell's own error (Excel #DIV/0!)");
    assert_eq!(fx.value(0, 1, 7), CellValue::Number(5.0), "a number cell still answers its number");
    assert_eq!(fx.value(0, 2, 7), CellValue::Error(CellError::Ref), "a cell the pivot does not show is still #REF!");
}

/// BUG-0760, the cells that hold errors today: a calculated field
/// `=Amount/0`. [LIVE, Excel 16, pivotfix probe1] `GETPIVOTDATA("Sum of
/// Ratio",$F$3,"Region","East")` and the grand total answer #DIV/0!. A
/// calculated field was no value field to the lookup, so it answered #REF!
/// under either name.
///
/// SABOTAGE (pivotfix-sabC): the calculated-field column is never found --
/// fails at "CALCULATED FIELD" with #REF!.
#[test]
fn getpivotdata_names_a_calculated_field_and_answers_its_error() {
    let fx = fx();
    amount_pivot(&fx, true);
    fx.set(0, 7, "=GETPIVOTDATA(\"Sum of Ratio\",$E$3,\"Region\",\"East\")"); // H1, Excel's name
    fx.set(1, 7, "=GETPIVOTDATA(\"Ratio\",$E$3)"); // H2, the caption, the grand total
    fx.set(2, 7, "=GETPIVOTDATA(\"Sum of Amount\",$E$3,\"Region\",\"West\")"); // H3
    fx.set(3, 7, "=GETPIVOTDATA(\"Sum of Nothing\",$E$3)"); // H4
    assert_eq!(fx.value(0, 0, 7), CellValue::Error(CellError::Div0), "CALCULATED FIELD by Excel's data-field name");
    assert_eq!(fx.value(0, 1, 7), CellValue::Error(CellError::Div0), "CALCULATED FIELD grand total by its caption");
    assert_eq!(fx.value(0, 2, 7), CellValue::Number(5.0), "the value field beside it still answers");
    assert_eq!(fx.value(0, 3, 7), CellValue::Error(CellError::Ref), "a field the pivot does not have is #REF!");
}

/// piv5 (the piv4 verifier's regression finding). Year / Region / Amount:
/// Y1 West 10, Y1 East 30, Y2 West 20 -- Year on rows, Region on columns, so
/// Y2 x East is an intersection no record reaches. [LIVE, Excel 16, piv5
/// p1] the pivot shows that cell EMPTY and `GETPIVOTDATA("Sum of
/// Amount",$A$3,"Year","Y2","Region","East")` answers 0 (`ISNUMBER` TRUE),
/// under every summary; [LIVE, piv5 p4] so does every cell Show Values As
/// leaves empty (the grand total under Running Total In). Once such cells
/// became EMPTY instead of 0, the lookup read them as no cell and answered
/// #REF!.
///
/// SABOTAGE (piv5-sabG): `pivot_cell_answer` reads an empty value cell as no
/// answer again -- fails at "EMPTY INTERSECTION" with #REF!.
#[test]
fn getpivotdata_over_an_empty_value_cell_answers_zero() {
    let fx = fx();
    for (r, row) in [["Year", "Region", "Amount"], ["Y1", "West", "10"], ["Y1", "East", "30"], ["Y2", "West", "20"]]
        .iter()
        .enumerate()
    {
        for (c, v) in row.iter().enumerate() {
            fx.set(r as u32, c as u32, v);
        }
    }
    let source = fx.state.grid.read().unwrap().clone();
    let pivot = |show: pivot_engine::ShowValuesAs, dest_row: u32| {
        let (mut cache, headers) = build_cache_from_grid(&source, (0, 0), (3, 2), true).expect("the cache");
        for (i, h) in headers.iter().enumerate() {
            cache.set_field_name(i, h.clone());
        }
        let mut def = PivotDefinition::new(identity::EntityId::from_bytes(identity::generate_uuid_v7()), (0, 0), (3, 2));
        def.source_has_headers = true;
        def.source_sheet = Some("Sheet1".to_string());
        def.destination_sheet = Some("Sheet1".to_string());
        def.destination = (dest_row, 4);
        def.row_fields.push(PivotField::new(0, "Year".to_string()));
        def.column_fields.push(PivotField::new(1, "Region".to_string()));
        let mut vf = ValueField::new(2, "Sum of Amount".to_string(), AggregationType::Sum);
        vf.show_values_as = show;
        vf.base_field_index = Some(0);
        def.value_fields.push(vf);
        let view = safe_calculate_pivot(&def, &mut cache);
        let id = def.id;
        fx.pivots.pivot_tables.write(&test_seed_effect()).unwrap().insert(id, (def, cache));
        fx.pivots.views.lock().unwrap().insert(id, view);
    };
    pivot(pivot_engine::ShowValuesAs::Normal, 5); // E6
    pivot(pivot_engine::ShowValuesAs::RunningTotal, 15); // E16
    {
        let views = fx.pivots.views.lock().unwrap();
        let empty = views
            .values()
            .flat_map(|v| v.cells.iter().flatten())
            .any(|c| c.value_field_index == Some(0) && matches!(c.value, pivot_engine::PivotCellValue::Empty));
        assert!(empty, "fixture: the pivot shows an EMPTY value cell");
    }
    fx.set(0, 10, "=GETPIVOTDATA(\"Sum of Amount\",$E$6,\"Year\",\"Y2\",\"Region\",\"East\")"); // K1
    fx.set(1, 10, "=GETPIVOTDATA(\"Sum of Amount\",$E$6,\"Year\",\"Y2\",\"Region\",\"West\")"); // K2
    fx.set(2, 10, "=GETPIVOTDATA(\"Sum of Amount\",$E$6,\"Year\",\"Y3\",\"Region\",\"East\")"); // K3
    fx.set(3, 10, "=GETPIVOTDATA(\"Sum of Amount\",$E$16)"); // K4: the running total's grand total
    assert_eq!(fx.value(0, 0, 10), CellValue::Number(0.0), "EMPTY INTERSECTION: Excel answers 0");
    assert_eq!(fx.value(0, 1, 10), CellValue::Number(20.0), "a shown number still answers itself");
    assert_eq!(fx.value(0, 2, 10), CellValue::Error(CellError::Ref), "an item the pivot does not show is still #REF!");
    assert_eq!(fx.value(0, 3, 10), CellValue::Number(0.0), "EMPTY SHOW-AS CELL: Running Total In's grand total answers 0");
}

/// BUG-0765. An off-sheet write -- a script writing Sheet2, a floating
/// grid's cell, a grouped entry -- of `=GETPIVOTDATA(..)` reads the pivot
/// at once, as the same formula typed on the active sheet does (Excel
/// evaluates an entered formula wherever it lands). The write's own
/// evaluation had no pivot lookup, so the cell stored #REF!; a write that
/// defers its recalculation (`recalc: false`: a floating grid's batch, a
/// script's bulk write) kept it.
///
/// SABOTAGE (pivotfix-sabD): the off-sheet write evaluates with no pivot
/// lookup -- fails at "OFF-SHEET ENTRY" with #REF!.
#[test]
fn an_off_sheet_getpivotdata_entry_reads_the_pivot_at_once() {
    let fx = fx();
    amount_pivot(&fx, false);
    let wrote = crate::commands::data::update_cell_on_sheets_as(
        &fx.state,
        &fx.file,
        &fx.files,
        &fx.pivots,
        &fx.pane,
        &fx.filters,
        vec![1],
        0,
        0,
        "=GETPIVOTDATA(\"Sum of Amount\",Sheet1!$E$3,\"Region\",\"East\")+1".to_string(),
        Some(true),
        Some(false),
        None,
        false,
    )
    .expect("the off-sheet write");
    assert_eq!(wrote, vec![1]);
    assert_eq!(fx.value(1, 0, 0), CellValue::Number(11.0), "OFF-SHEET ENTRY: Sheet2!A1 = East 10 + 1");
}

/// BUG-0767, NOT REAL: `recalc_after_pivot_write`'s second pass -- the
/// whole-sheet `recalc_after_off_sheet_write` after the seeded cascade --
/// is not redundant. The cascade reaches a pivot cell's STATIC readers
/// (`=F6`) and, since NEW-getpivotdata-trials, answers GETPIVOTDATA, but it
/// walks dependency edges only, and a VOLATILE reader has none:
/// `=INDIRECT("F6")` over the grand total. Excel [LIVE, Excel 16, pivotfix
/// probe2 V_AFTER] recalculates it when an item is hidden (252 -> 0 as the
/// grand total moves up and F6 empties). This pins the pass that does it.
///
/// SABOTAGE (pivotfix-sabH): drop the active-sheet branch's second pass --
/// fails at "VOLATILE READER" with the stale 15.
#[tokio::test]
async fn a_volatile_reader_of_a_pivot_follows_the_pivots_write() {
    let fx = fx();
    for (r, (region, amount)) in [("Region", "Amount"), ("East", "10"), ("West", "5")].iter().enumerate() {
        fx.set(r as u32, 0, region);
        fx.set(r as u32, 1, amount);
    }
    let created = super::commands::create_pivot_core(
        &fx.state,
        &fx.file,
        &fx.pivots,
        super::operations::PivotRecalcStates { pane: &fx.pane, ribbon: &fx.filters, user_files: &fx.files },
        super::types::CreatePivotRequest {
            source_range: "A1:B3".to_string(),
            destination_cell: "E3".to_string(),
            source_sheet: Some(0),
            destination_sheet: Some(0),
            has_headers: Some(true),
            name: None,
            source_table_name: None,
            canvas_frame: None,
        },
        vec!["Region".to_string()],
        vec![("Amount".to_string(), AggregationType::Sum)],
    )
    .expect("a pivot at E3");
    fx.set(0, 7, "=INDIRECT(\"F6\")"); // H1: volatile, no dependency edge
    fx.set(1, 7, "=F6"); // H2: static
    assert_eq!(fx.value(0, 1, 7), CellValue::Number(15.0), "fixture: F6 is the grand total, 10 + 5");
    assert_eq!(fx.value(0, 0, 7), CellValue::Number(15.0), "fixture: INDIRECT reads it too");

    let bi = crate::bi::types::BiState::new();
    let ctx = super::commands::PivotCmdCtx {
        state: &fx.state,
        file_state: &fx.file,
        pivot_state: &fx.pivots,
        pane_control_state: &fx.pane,
        ribbon_filter_state: &fx.filters,
        user_files_state: &fx.files,
        bi_state: &bi,
        slicer_state: &fx.slicer,
        record_undo: true,
    };
    super::commands::set_pivot_item_visibility_core(
        &ctx,
        super::types::SetItemVisibilityRequest {
            pivot_id: created.pivot_id,
            field_index: 0,
            item_name: "East".to_string(),
            visible: false,
        },
    )
    .await
    .expect("hide East");
    assert_eq!(fx.value(0, 1, 7), CellValue::Number(0.0), "the static reader of the emptied F6 (Excel 0)");
    assert_eq!(fx.value(0, 0, 7), CellValue::Number(0.0), "VOLATILE READER: INDIRECT follows the pivot (Excel 0)");
}
