//! FILENAME: app/src-tauri/src/tables_cfeval_tests.rs
//! PURPOSE: Lane `cfeval` -- a hidden totals row's remembered LABEL survives a
//! save (NEW-totals-label-persist), and typing into a totals cell is ONE undo
//! step with the totals-function change it causes (NEW-totals-typing-undo),
//! driven through the real command bodies (`update_cell_impl`,
//! `check_table_auto_expand_core`, `toggle_totals_row_core`,
//! `build_workbook_for_save`, the `.cala` writer and reader). A child module of
//! `tables` (declared with `#[path]` there).

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
    timelines: crate::timeline_slicer::TimelineSlicerState,
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
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    /// Type `value`, then the Table extension's follow-up for that edit.
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

    /// H1/H2 over A1:B4 (2..4 and 20..40), named `TT`, with its totals row on.
    fn table_with_totals(&self) -> identity::EntityId {
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
        let id = created.table.unwrap().id;
        self.totals(id, true);
        id
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

    fn cell(&self, row: u32, col: u32) -> CellValue {
        let grid = self.state.grid.read().unwrap();
        grid.get_cell(row, col).map(|c| c.value.clone()).unwrap_or(CellValue::Empty)
    }

    fn undo_once(&self) {
        let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("nothing on the undo stack");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timelines, transaction, true,
        );
    }
}

/// NEW-totals-label-persist. [LIVE, cfdv/probe2.ps1] a `7` typed over a total
/// comes back after Total Row off and on, and Excel saves the hidden row's
/// constant as `totalsRowLabel="7"`. Calcula remembered it in the session
/// only: `SavedTableColumn` had no field, so a workbook saved with the row
/// hidden lost the 7. Through the real save assembly and `.cala` bytes; the
/// archive declares the `table_totals_row_label` feature id.
/// SABOTAGE (cfeval-label): `table_to_saved` writes `totals_row_label: None`.
#[test]
fn a_hidden_totals_rows_label_survives_a_cala_round_trip() {
    let wb = Wb::new();
    let id = wb.table_with_totals();
    wb.type_in(4, 1, "7");
    wb.totals(id, false);
    assert_eq!(wb.column(id, 1).totals_row_label.as_deref(), Some("7"));

    let bi = crate::bi::types::BiState::new();
    let (workbook, _) = crate::persistence::build_workbook_for_save(
        &wb.state, &wb.files, &bi, crate::persistence::ChartKeysFor::Document,
    )
    .expect("save assembly failed");
    let bytes = calcula_format::write_calcula_bytes(&workbook).expect("write_calcula_bytes failed");
    let manifest = calcula_format::read_calcula_manifest(&bytes).expect("manifest");
    assert!(
        manifest.features.iter().any(|f| f == calcula_format::TABLE_TOTALS_ROW_LABEL_FEATURE),
        "{:?}",
        manifest.features
    );
    let loaded = calcula_format::read_calcula_bytes(&bytes).expect("read_calcula_bytes failed");
    let saved = loaded.tables.iter().find(|t| t.name == "TT").expect("the table survives");
    let table = crate::persistence::saved_table_to_table_at(saved, 0);
    assert_eq!(table.columns[1].totals_row_label.as_deref(), Some("7"), "the hidden row's label was lost");
    assert_eq!(table.columns[1].totals_row_function, TotalsRowFunction::None);
}

/// NEW-totals-typing-undo. Typing 7 over the subtotal sets the column's
/// function to None (round D), but that change was not part of the edit's
/// undo step: Ctrl+Z put back the SUBTOTAL formula and left the function None,
/// so the next Total Row toggle showed nothing where the total had been. One
/// Ctrl+Z now restores both, and leaves no second step behind.
/// SABOTAGE (cfeval-undo): `join_totals_change_to_cell_edit` returns at once.
#[test]
fn one_undo_restores_the_typed_totals_cell_and_its_function() {
    let wb = Wb::new();
    let id = wb.table_with_totals();
    assert_eq!(wb.column(id, 1).totals_row_function, TotalsRowFunction::Sum);
    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();

    let changed = wb.type_in(4, 1, "7");
    assert!(changed.is_some());
    assert_eq!(wb.column(id, 1).totals_row_function, TotalsRowFunction::None);
    assert_eq!(
        wb.state.undo_stack.lock().unwrap().undo_depth(),
        depth + 1,
        "the totals change must join the edit's step, not add one"
    );

    wb.undo_once();
    assert_ne!(wb.cell(4, 1), CellValue::Number(7.0), "the cell edit was not undone");
    assert_eq!(
        wb.column(id, 1).totals_row_function,
        TotalsRowFunction::Sum,
        "Ctrl+Z put the cell back but left the totals function None"
    );
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_depth(), depth);
}
