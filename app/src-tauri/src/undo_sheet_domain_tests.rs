//! FILENAME: app/src-tauri/src/undo_sheet_domain_tests.rs
//! PURPOSE: The three residual undo gaps, and the non-cell announcement gap.
//! CONTEXT: A child module of `undo_commands` (declared with `#[path]` there),
//!          so it reaches the private restore registry and `apply_changes`.
//!
//! ROOT CAUSE, which is why these live in one file. Undo's restore ->
//! recalculate channel had NO sheet dimension anywhere along it:
//! `CellChange::SetCell` carried `(row, col)`, the restore reported
//! `(row, col)`, and the cascade consumed `&[(u32, u32)]` against the ACTIVE
//! sheet's dependency maps. So "undo restored the wrong sheet" and "a
//! whole-sheet restore could seed nothing" were not two defects but two faces
//! of one: an off-sheet fact could not be EXPRESSED.
//!
//! The named-range gap is genuinely separate and no sheet dimension helps it. A
//! name is resolved while a formula is evaluated and is an edge in no dependency
//! map, so no coordinate on any sheet describes the formulas it feeds.

use super::*;
use crate::persistence::{FileState, UserFilesState};
use crate::pivot::types::PivotState;
use crate::slicer::SlicerState;
use engine::{Cell, CellValue};
use std::collections::HashSet;

/// `pub(super)` so the sibling `undo_sheet_structure_tests` reuses this
/// fixture instead of growing a second one that drifts from it.
pub(super) struct Fixture {
    pub(super) state: AppState,
    file: FileState,
    files: UserFilesState,
    pivots: PivotState,
    slicer: SlicerState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
}

fn loading() -> crate::document_effect::DocumentEffect {
    crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    )
}

impl Fixture {
    pub(super) fn new(sheets: usize) -> Self {
        let state = crate::create_app_state();
        for i in 1..sheets {
            state.grids.write(&loading()).unwrap().push(engine::Grid::new());
            state.sheet_names.write(&crate::document_effect::test_seed_effect()).unwrap().push(format!("Sheet{}", i + 1));
            state.all_column_widths.write(&crate::document_effect::test_seed_effect()).unwrap().push(HashMap::new());
            state.all_row_heights.write(&crate::document_effect::test_seed_effect()).unwrap().push(HashMap::new());
            state.all_user_hidden_rows.write(&crate::document_effect::test_seed_effect()).unwrap().push(HashSet::new());
            state.all_user_hidden_cols.write(&crate::document_effect::test_seed_effect()).unwrap().push(HashSet::new());
            state
                .sheet_ids
                .write(&crate::document_effect::test_seed_effect())
                .unwrap()
        .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        }
        {
            let mut all = state.all_merged_regions.write(&crate::document_effect::test_seed_effect()).unwrap();
            while all.len() < sheets {
                all.push(HashSet::new());
            }
        }
        Fixture {
            state,
            file: FileState::default(),
            files: UserFilesState::default(),
            pivots: PivotState::new(),
            slicer: SlicerState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
        }
    }

    /// Write a cell straight into `grids[sheet]` (and the active mirror when
    /// that sheet is active), the way a load does — no undo entry, no cascade.
    pub(super) fn put(&self, sheet: usize, row: u32, col: u32, cell: Cell) {
        let active = *self.state.active_sheet.read().unwrap();
        self.state.grids.write(&loading()).unwrap()[sheet].set_cell(row, col, cell.clone());
        if sheet == active {
            self.state.grid.write(&loading()).unwrap().set_cell(row, col, cell);
        }
    }

    /// Make `sheet` the active one, mirror and all — the recalculation-relevant
    /// half of `set_active_sheet`, which needs a `State<AppState>`.
    pub(super) fn switch_to(&self, sheet: usize) {
        {
            let mut grids = self.state.grids.write(&loading()).unwrap();
            let mut mirror = self.state.grid.write(&loading()).unwrap();
            let mut active = self.state.active_sheet.write(&crate::document_effect::test_seed_effect()).unwrap();
            if *active == sheet {
                return;
            }
            grids[*active] = mirror.clone();
            *mirror = grids[sheet].clone();
            *active = sheet;
        }
        rebuild_all_dependencies(&self.state);
    }

    /// A sheet's cell, read from whichever store is AUTHORITATIVE for it.
    ///
    /// The active sheet lives in the `grid` MIRROR; `grids[active]` is a copy
    /// that is only guaranteed fresh at the moment of the last swap. Reading
    /// `grids` unconditionally was harmless while the active sheet never moved
    /// during a test, and stopped being harmless the moment undo started
    /// ACTIVATING the sheet it restores -- a test would then be asking the
    /// stale copy. This is the same active-or-`all_` rule
    /// `report::with_sheet_merges` already applies to merged regions.
    fn value(&self, sheet: usize, row: u32, col: u32) -> CellValue {
        let active = *self.state.active_sheet.read().unwrap();
        let cell = if sheet == active {
            self.state.grid.read().unwrap().get_cell(row, col).cloned()
        } else {
            self.state.grids.read().unwrap()[sheet].get_cell(row, col).cloned()
        };
        cell.map(|c| c.value).unwrap_or(CellValue::Empty)
    }

    /// A sheet's column width, active-or-`all_` (see [`Fixture::value`]).
    pub(super) fn column_width(&self, sheet: usize, col: u32) -> Option<f64> {
        let active = *self.state.active_sheet.read().unwrap();
        if sheet == active {
            self.state.column_widths.read().unwrap().get(&col).copied()
        } else {
            self.state
                .all_column_widths
                .read()
                .unwrap()
                .get(sheet)
                .and_then(|m| m.get(&col).copied())
        }
    }

    /// A sheet's row height, active-or-`all_` (see [`Fixture::value`]).
    pub(super) fn row_height(&self, sheet: usize, row: u32) -> Option<f64> {
        let active = *self.state.active_sheet.read().unwrap();
        if sheet == active {
            self.state.row_heights.read().unwrap().get(&row).copied()
        } else {
            self.state
                .all_row_heights
                .read()
                .unwrap()
                .get(sheet)
                .and_then(|m| m.get(&row).copied())
        }
    }

    /// The index of the sheet the user is looking at.
    pub(super) fn active(&self) -> usize {
        *self.state.active_sheet.read().unwrap()
    }

    /// Hide a sheet, the way `hide_sheet` does -- it records no undo entry, so
    /// an entry queued against a sheet that is later hidden is reachable.
    pub(super) fn hide(&self, sheet: usize) {
        let e = crate::document_effect::test_seed_effect();
        let mut vis = self.state.sheet_visibility.write(&e).unwrap();
        while vis.len() <= sheet {
            vis.push("visible".to_string());
        }
        vis[sheet] = "hidden".to_string();
    }

    pub(super) fn number(&self, sheet: usize, row: u32, col: u32) -> f64 {
        match self.value(sheet, row, col) {
            CellValue::Number(n) => n,
            other => panic!("sheet {sheet} ({row},{col}) is {other:?}, expected a number"),
        }
    }

    /// Evaluate every formula on every sheet — the LOAD path, the oracle each
    /// undo has to agree with.
    pub(super) fn recalculate_every_sheet(&self) {
        let sheets = self.state.sheet_names.read().unwrap().len();
        for idx in 0..sheets {
            crate::calculation::recalculate_sheet_values(
                &self.state,
                &self.files,
                &self.pivots,
                idx,
                None,
            );
        }
    }

    pub(super) fn record_custom(&self, kind: &str, payload: Vec<u8>) {
        let mut stack = self.state.undo_stack.lock().unwrap();
        stack.begin_transaction(kind.to_string());
        stack.record_custom_restore(kind.to_string(), payload, kind);
        stack.commit_transaction();
    }

    pub(super) fn undo(&self) -> UndoResult {
        let transaction = self
            .state
            .undo_stack
            .lock()
            .unwrap()
            .pop_undo()
            .expect("nothing on the undo stack");
        apply_changes(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.slicer,
            &self.filters,
            &self.pane,
            transaction,
            true,
        )
    }

    pub(super) fn redo(&self) -> UndoResult {
        let transaction = self
            .state
            .undo_stack
            .lock()
            .unwrap()
            .pop_redo()
            .expect("nothing on the redo stack");
        apply_changes(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.slicer,
            &self.filters,
            &self.pane,
            transaction,
            false,
        )
    }

    pub(super) fn undo_depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }
}

// ---------------------------------------------------------------------------
// GAP 3 — `SetCell` had no sheet dimension
// ---------------------------------------------------------------------------

#[test]
fn set_cell_restores_to_the_sheet_it_was_recorded_on() {
    // The edit is made on Sheet2; the user switches to Sheet1 and presses
    // Ctrl+Z. Before the sheet dimension existed, the restore was replayed into
    // whatever mirror was in front of the user: Sheet1 got a value it never
    // held, and Sheet2 kept the edit that was supposedly undone. Both halves
    // are asserted, because fixing only the first leaves undo silently inert.
    let f = Fixture::new(2);
    f.put(0, 0, 0, Cell::new_number(500.0));
    f.put(1, 0, 0, Cell::new_number(1.0));

    f.switch_to(1);
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(1, 0, 0, Some(Cell::new_number(1.0)));
    f.put(1, 0, 0, Cell::new_number(42.0));

    f.switch_to(0);
    f.undo();

    assert_eq!(f.number(1, 0, 0), 1.0, "Sheet2!A1 must be the cell restored");
    assert_eq!(
        f.number(0, 0, 0),
        500.0,
        "Sheet1!A1 was overwritten by an undo belonging to another sheet"
    );
    // The restore itself never touches the mirror it was not aimed at; the
    // ACTIVATION that follows it deliberately does, because Excel switches to
    // the sheet the undone action happened on. The mirror that must survive is
    // therefore SHEET1's saved copy, which is what `grids[0]` is once the swap
    // has put it back — and that is the assertion above. What the mirror shows
    // now is Sheet2, and the guard that an off-sheet restore leaves the mirror
    // ALONE lives in `undo_sheet_activation_tests`, where the target is hidden
    // and no activation happens.
    assert_eq!(
        f.state.grid.read().unwrap().get_cell(0, 0).map(|c| c.value.clone()),
        Some(CellValue::Number(1.0)),
        "undo must switch to the sheet it restored, so the mirror is Sheet2's"
    );
}

#[test]
fn an_off_sheet_set_cell_restore_recalculates_the_sheets_reading_into_it() {
    // Sheet1!A1 = 10, Sheet2!A1 = "=Sheet1!A1*2". The undone edit is on Sheet1
    // while SHEET2 is active, so the restored cell is off-sheet and the stale
    // formula is on the sheet the user is looking at. Nothing about this can be
    // expressed as an active-sheet seed.
    let f = Fixture::new(2);
    f.put(0, 0, 0, Cell::new_number(10.0));
    f.put(1, 0, 0, Cell::new_formula("=Sheet1!A1*2".to_string()));
    f.switch_to(1);
    f.recalculate_every_sheet();
    assert_eq!(f.number(1, 0, 0), 20.0, "precondition");

    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(0, 0, 0, Some(Cell::new_number(10.0)));
    f.put(0, 0, 0, Cell::new_number(99.0));
    f.recalculate_every_sheet();
    assert_eq!(f.number(1, 0, 0), 198.0, "precondition");

    f.undo();

    assert_eq!(f.number(0, 0, 0), 10.0, "the restored literal");
    assert_eq!(
        f.number(1, 0, 0),
        20.0,
        "the ACTIVE sheet's formula reading into the restored off-sheet cell kept \
         its post-edit value — the restore reported no sheet, so nothing was \
         recalculated"
    );
}

#[test]
fn an_off_sheet_set_cell_restore_reports_its_sheet_to_the_frontend() {
    // Correct values in `grids` are not enough: the frontend repaints and
    // re-caches what the command RETURNS, and an off-sheet cell must carry its
    // own sheet index (an active-sheet cell carries None, as it always has).
    //
    // SHEET2 IS HIDDEN, for the reason `redoing_an_off_sheet_set_cell_...`
    // gives: undo now ACTIVATES the sheet it restored, and `sheet_index` is
    // relative to the sheet the restore ENDED on, so on a visible Sheet2 the
    // restored cell would correctly be reported as the active one and this
    // guard would stop describing an off-sheet cell at all. A hidden target is
    // the configuration in which a restore stays off-sheet.
    let f = Fixture::new(2);
    f.hide(1);
    f.put(1, 3, 2, Cell::new_number(1.0));
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(1, 3, 2, Some(Cell::new_number(1.0)));

    let result = f.undo();

    let reported = result
        .updated_cells
        .iter()
        .find(|c| c.row == 3 && c.col == 2)
        .expect("the restored cell was not reported at all");
    assert_eq!(
        reported.sheet_index,
        Some(1),
        "an off-sheet restore reported no sheet, so the frontend would apply it \
         to whatever sheet is on screen"
    );
}

#[test]
fn redoing_an_off_sheet_set_cell_restores_the_sheet_and_recalculates_too() {
    // THE REDO TWIN of the two tests above, and the reason it is written out
    // rather than argued: redo shares `apply_changes` with undo, but that is a
    // property of today's code, not a guarantee — `is_undo` already branches
    // inside that function (merge direction, which stack the inverse goes to),
    // so "redo is the same function" is exactly the kind of claim that stops
    // being true without anybody noticing. Undo -> redo must put the edit back
    // ON SHEET1, recalculate SHEET2's formula reading into it, and report the
    // sheet index; a redo that lost the sheet dimension would write the active
    // sheet instead and leave the dependent stale.
    //
    // SHEET1 IS HIDDEN HERE, and that is not decoration. Undo now ACTIVATES the
    // sheet it restores (Excel's rule -- `undo_sheet_activation_tests`), so on a
    // visible Sheet1 both the undo and the redo below would end up on-sheet and
    // this guard would silently stop testing the off-sheet path it exists for.
    // A hidden target is the one configuration in which a restore stays
    // off-sheet, because the view cannot follow it there -- and a hidden sheet
    // holding the numbers another sheet reads is an ordinary workbook.
    let f = Fixture::new(2);
    f.put(0, 0, 0, Cell::new_number(10.0));
    f.put(1, 0, 0, Cell::new_formula("=Sheet1!A1*2".to_string()));
    f.switch_to(1);
    f.hide(0);
    f.recalculate_every_sheet();

    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(0, 0, 0, Some(Cell::new_number(10.0)));
    f.put(0, 0, 0, Cell::new_number(99.0));
    f.recalculate_every_sheet();
    assert_eq!(f.number(1, 0, 0), 198.0, "precondition: the edit is in effect");

    f.undo();
    assert_eq!(f.number(0, 0, 0), 10.0, "precondition: the undo landed");

    let result = f.redo();

    assert_eq!(
        f.number(0, 0, 0),
        99.0,
        "redo restored the edit to the wrong sheet"
    );
    assert_eq!(
        f.number(1, 0, 0),
        198.0,
        "redo put the off-sheet value back without recalculating the ACTIVE \
         sheet's formula that reads into it"
    );
    // The active mirror is SHEET2, whose A1 is the dependent formula. It must
    // hold that formula's recalculated value — not the 99 the redo wrote to
    // Sheet1, which is what a sheet-blind redo would have painted here.
    assert_eq!(
        f.state.grid.read().unwrap().get_cell(0, 0).map(|c| c.value.clone()),
        Some(CellValue::Number(198.0)),
        "redo of an off-sheet cell wrote into the ACTIVE mirror"
    );
    let reported = result
        .updated_cells
        .iter()
        .find(|c| c.row == 0 && c.col == 0 && c.sheet_index == Some(0))
        .map(|c| c.sheet_index);
    assert_eq!(
        reported,
        Some(Some(0)),
        "redo reported the restored cell without its sheet index, so the \
         frontend would apply it to whatever sheet is on screen"
    );
}

// ---------------------------------------------------------------------------
// GAP 2 — a named-range undo triggered no recalculation
// ---------------------------------------------------------------------------

fn name_pointing_at(refers_to: &str) -> crate::named_ranges::NamedRange {
    crate::named_ranges::NamedRange {
        name: "RATE".to_string(),
        sheet_index: None,
        refers_to: refers_to.to_string(),
        comment: None,
        folder: None,
    }
}

fn workbook_with_a_name() -> Fixture {
    let f = Fixture::new(1);
    f.put(0, 0, 0, Cell::new_number(10.0));
    f.put(0, 0, 1, Cell::new_number(99.0));
    f.put(0, 1, 0, Cell::new_formula("=RATE*2".to_string()));
    f.state
        .named_ranges
        .write(&loading())
        .unwrap()
        .insert("RATE".to_string(), name_pointing_at("=Sheet1!$A$1"));
    f.recalculate_every_sheet();
    assert_eq!(f.number(0, 1, 0), 20.0, "precondition");
    f
}

/// Re-point RATE from A1 to B1 the way the Name Manager does: record the undo
/// entry with the PREVIOUS definition, swap it, recalculate.
fn repoint_the_name(f: &Fixture) {
    record_named_range_undo(
        &f.state,
        "RATE",
        Some(name_pointing_at("=Sheet1!$A$1")),
        "Edit name",
    );
    f.state
        .named_ranges
        .write(&loading())
        .unwrap()
        .insert("RATE".to_string(), name_pointing_at("=Sheet1!$B$1"));
    f.recalculate_every_sheet();
    assert_eq!(f.number(0, 1, 0), 198.0, "precondition");
}

#[test]
fn undoing_a_named_range_definition_recalculates_the_formulas_that_use_it() {
    // Nothing connects A2 to RATE in any dependency map, so before this the
    // undo restored the DEFINITION and left A2 showing 198 — a number computed
    // against a definition the document no longer holds.
    let f = workbook_with_a_name();
    repoint_the_name(&f);

    f.undo();

    assert_eq!(
        f.state.named_ranges.read().unwrap()["RATE"].refers_to,
        "=Sheet1!$A$1",
        "the definition itself"
    );
    assert_eq!(
        f.number(0, 1, 0),
        20.0,
        "the formula resolving through the name kept a value computed against the \
         definition the undo just removed"
    );
}

#[test]
fn redoing_a_named_range_definition_recalculates_too() {
    // Redo has every question undo does; fixing one direction only leaves the
    // workbook right after Ctrl+Z and wrong after Ctrl+Y.
    let f = workbook_with_a_name();
    repoint_the_name(&f);

    f.undo();
    assert_eq!(f.number(0, 1, 0), 20.0);
    f.redo();
    assert_eq!(
        f.number(0, 1, 0),
        198.0,
        "redo restored the new definition without recalculating through it"
    );
}

#[test]
fn a_named_range_undo_agrees_with_a_whole_workbook_recalculation() {
    // The same oracle BUG-0019 used: whatever the undo produces must equal what
    // loading the document produces. If they disagree, saving and reopening
    // silently "corrects" the screen, which is how this class of defect hides.
    let f = workbook_with_a_name();
    repoint_the_name(&f);
    f.undo();

    let after_undo = f.value(0, 1, 0);
    f.recalculate_every_sheet();
    assert_eq!(
        after_undo,
        f.value(0, 1, 0),
        "the undo left a value the load path does not reproduce"
    );
}

// ---------------------------------------------------------------------------
// GAP 1 — restores that write cells but reported no coordinates
// ---------------------------------------------------------------------------

#[test]
fn a_report_restore_recalculates_the_other_sheets_reading_into_it() {
    // `report_restore` swaps a box of cells on a known sheet and carries their
    // cached values, so its own sheet is right the moment it lands. What it
    // could not say was WHICH sheet, so the formula on the other sheet reading
    // into the box was never re-evaluated.
    let f = Fixture::new(2);
    f.put(1, 0, 0, Cell::new_number(7.0));
    f.put(0, 0, 0, Cell::new_formula("=Sheet2!A1+1".to_string()));
    f.recalculate_every_sheet();
    assert_eq!(f.number(0, 0, 0), 8.0, "precondition");

    f.put(1, 0, 0, Cell::new_number(70.0));
    f.recalculate_every_sheet();
    assert_eq!(f.number(0, 0, 0), 71.0, "precondition");

    let snapshot = crate::report::ReportUndoSnapshot {
        sheet_index: 1,
        cells: vec![(0, 0, Some(Cell::new_number(7.0)))],
        definitions: Vec::new(),
        merges: Vec::new(),
    };
    f.record_custom("report_restore", serde_json::to_vec(&snapshot).unwrap());

    f.undo();

    assert_eq!(f.number(1, 0, 0), 7.0, "the restored report cell");
    assert_eq!(
        f.number(0, 0, 0),
        8.0,
        "the OTHER sheet's formula reading into the report box stayed stale — the \
         restore reported no coordinates for the cascade to seed from"
    );
}

#[test]
fn every_cell_writing_restore_kind_reports_the_sheet_it_wrote() {
    // A source-level guard on the thing that was actually missing. A restore
    // that writes cells and reports nothing gets no cascade in either
    // direction, and the symptom is a stale number on a sheet nobody was
    // looking at — the least likely defect to be found by hand.
    const SRC: &str = include_str!("undo_commands.rs");
    for name in [
        "apply_report_restore",
        "apply_calp_reset_restore",
        "apply_script_grid_cells_restore",
        "apply_sheet_structural_restore",
    ] {
        let start = SRC
            .find(&format!("fn {name}("))
            .unwrap_or_else(|| panic!("no `fn {name}(` in undo_commands.rs"));
        let rest = &SRC[start..];
        let end = rest[1..].find("\nfn ").map(|i| i + 1).unwrap_or(rest.len());
        assert!(
            rest[..end].contains("report.wrote_sheet("),
            "`{name}` writes cells without reporting which sheet, so the shared \
             off-sheet cascade has nothing to run over"
        );
    }
}

#[test]
fn the_off_sheet_cascade_is_the_shared_one() {
    // Undo must not grow a fourth copy of the recalculation walk. It reaches
    // the off-sheet half through the same entry point a forward off-sheet write
    // uses, so an undo and the write it reverses converge through identical
    // code rather than through two implementations that drift.
    const SRC: &str = include_str!("undo_commands.rs");
    assert!(
        SRC.contains("recalc_after_off_sheet_write("),
        "undo no longer routes its off-sheet recalculation through the shared walk"
    );
    assert!(
        !SRC.contains("work_queue"),
        "undo_commands.rs hand-rolls a cross-sheet work queue instead of calling \
         the shared cascade — that duplication WAS BUG-0019"
    );
}

// ---------------------------------------------------------------------------
// Non-cell mutations: the announcement, and the undo entry that has to exist
// before there is anything to announce
// ---------------------------------------------------------------------------

fn outline_with_one_row_group() -> crate::grouping::SheetOutline {
    let mut outline = crate::grouping::SheetOutline::new();
    outline
        .row_groups
        .push(crate::grouping::RowGroup::new(2, 5, 1));
    outline
}

#[test]
fn undoing_a_grouping_restores_the_outline_and_announces_it() {
    let f = Fixture::new(1);
    record_outline_undo(&f.state, 0, None, "Group rows");
    f.state
        .outlines
        .write(&loading())
        .unwrap()
        .insert(0, outline_with_one_row_group());

    let result = f.undo();

    assert!(
        !f.state.outlines.read().unwrap().contains_key(&0),
        "the sheet had NO outline before the grouping, so undo must remove the \
         record rather than leave an empty one behind"
    );
    assert!(
        result.refresh_domains.iter().any(|d| d == "outline"),
        "undo announced {:?} — the Grouping extension re-reads only on the outline \
         announcement, so without it the outline bar keeps painting the groups the \
         user just undid",
        result.refresh_domains
    );
}

#[test]
fn redoing_a_grouping_puts_it_back_and_announces_it() {
    let f = Fixture::new(1);
    record_outline_undo(&f.state, 0, None, "Group rows");
    f.state
        .outlines
        .write(&loading())
        .unwrap()
        .insert(0, outline_with_one_row_group());

    f.undo();
    let result = f.redo();

    assert_eq!(
        f.state.outlines.read().unwrap()[&0].row_groups.len(),
        1,
        "redo did not re-apply the grouping"
    );
    assert!(result.refresh_domains.iter().any(|d| d == "outline"));
}

#[test]
fn undoing_a_hyperlink_a_note_a_comment_or_a_validation_announces_its_domain() {
    // These restores existed and worked; what they never did was TELL the
    // frontend, so the extension's own cache — the hyperlink indicator set, the
    // annotation cache, the validation rule set — kept describing the state the
    // user had just undone.
    let cases: [(&str, serde_json::Value, &str); 4] = [
        (
            "hyperlink",
            serde_json::json!({"sheet_index": 0, "row": 0, "col": 0, "previous": null}),
            "hyperlinks",
        ),
        (
            "note",
            serde_json::json!({"sheet_index": 0, "row": 0, "col": 0, "previous": null}),
            "annotations",
        ),
        (
            "comment",
            serde_json::json!({"sheet_index": 0, "row": 0, "col": 0, "previous": null}),
            "annotations",
        ),
        (
            "obj_validation",
            serde_json::json!({"sheet_index": 0, "previous": []}),
            "validations",
        ),
    ];
    for (kind, payload, expected) in cases {
        let f = Fixture::new(1);
        f.record_custom(kind, serde_json::to_vec(&payload).unwrap());
        let result = f.undo();
        assert!(
            result.refresh_domains.iter().any(|d| d == expected),
            "undo of `{kind}` announced {:?}, not `{expected}`",
            result.refresh_domains
        );
    }
}

#[test]
fn the_legacy_flags_agree_with_the_domain_list() {
    // The booleans are DERIVED from the same set, so a kind cannot be
    // classified twice and disagree with itself — which is what a parallel flag
    // ladder and domain list eventually do.
    let f = Fixture::new(1);
    f.record_custom(
        "obj_validation",
        serde_json::to_vec(&serde_json::json!({"sheet_index": 0, "previous": []})).unwrap(),
    );
    let result = f.undo();
    assert!(result.objects_changed);
    assert!(result.refresh_domains.iter().any(|d| d == "objects"));
    assert!(result.refresh_domains.iter().any(|d| d == "validations"));
    assert!(!result.pivot_changed);
    assert!(!result.refresh_domains.iter().any(|d| d == "pivot"));
}

// ---------------------------------------------------------------------------
// Controls: create and delete are undoable, and undo does not resurrect a dead
// script binding
// ---------------------------------------------------------------------------

fn button(label: &str) -> crate::controls::ControlMetadata {
    let mut properties = HashMap::new();
    properties.insert(
        "text".to_string(),
        crate::controls::ControlPropertyValue {
            value_type: "string".to_string(),
            value: label.to_string(),
        },
    );
    crate::controls::ControlMetadata {
        control_type: "button".to_string(),
        properties,
    }
}

#[test]
fn a_control_creation_undoes_and_redoes() {
    let f = Fixture::new(1);
    record_controls_undo(&f.state, Vec::new(), "Add control");
    f.state
        .controls
        .write(&loading())
        .unwrap()
        .insert((0, 2, 1), button("Run"));

    let undone = f.undo();
    assert!(
        f.state.controls.read().unwrap().is_empty(),
        "undo of a control creation left the control on the grid"
    );
    assert!(
        undone.refresh_domains.iter().any(|d| d == "controls"),
        "the Controls extension keeps its own copy of one sheet's store and \
         re-reads only on the controls announcement; got {:?}",
        undone.refresh_domains
    );

    let redone = f.redo();
    assert!(
        f.state.controls.read().unwrap().contains_key(&(0, 2, 1)),
        "redo did not re-create the control"
    );
    assert!(redone.refresh_domains.iter().any(|d| d == "controls"));
}

#[test]
fn a_control_deletion_undoes_and_redoes() {
    let f = Fixture::new(1);
    f.state
        .controls
        .write(&loading())
        .unwrap()
        .insert((0, 2, 1), button("Run"));
    record_controls_undo(&f.state, vec![((0, 2, 1), button("Run"))], "Delete control");
    f.state.controls.write(&loading()).unwrap().remove(&(0, 2, 1));

    f.undo();
    assert_eq!(
        f.state.controls.read().unwrap()[&(0, 2, 1)].properties["text"].value,
        "Run",
        "undo of a control deletion did not bring the control back"
    );

    f.redo();
    assert!(
        !f.state.controls.read().unwrap().contains_key(&(0, 2, 1)),
        "redo did not delete the control again"
    );
}

#[test]
fn undoing_a_control_deletion_does_not_resurrect_a_dead_script_binding() {
    // A control's instance id derives from its ANCHOR
    // (`control-<sheet>-<row>-<col>`), so a binding left behind at a cell is
    // inherited by the NEXT control created there — code its author never
    // wrote, running on their click. Deleting a control therefore deletes its
    // object scripts outright; undo must bring back the CONTROL and nothing
    // else. Restoring the binding would put the orphan back, pointing at a
    // script row that no longer exists.
    let f = Fixture::new(1);
    f.state
        .controls
        .write(&loading())
        .unwrap()
        .insert((0, 2, 1), button("Run"));
    // The delete path removed the object script; the store is empty here for
    // exactly that reason.
    record_controls_undo(&f.state, vec![((0, 2, 1), button("Run"))], "Delete control");
    f.state.controls.write(&loading()).unwrap().remove(&(0, 2, 1));

    f.undo();

    assert!(
        f.state.controls.read().unwrap().contains_key(&(0, 2, 1)),
        "the control itself must come back"
    );
    assert!(
        f.state.object_scripts.read().unwrap().is_empty(),
        "undo re-created an object-script binding for `control-0-2-1`; the next \
         control created at that anchor would inherit it"
    );
}

#[test]
fn a_scripted_batch_of_non_cell_mutations_is_one_undo_step() {
    // The in-open-transaction contract: a macro that creates two shapes and
    // groups some rows inside one `begin_undo_transaction` must be ONE press of
    // Ctrl+Z, not three.
    let f = Fixture::new(1);
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .begin_transaction("Macro".to_string());
    record_controls_undo(&f.state, Vec::new(), "Add control");
    record_controls_undo(&f.state, Vec::new(), "Add control");
    record_outline_undo(&f.state, 0, None, "Group rows");
    f.state.undo_stack.lock().unwrap().commit_transaction();

    assert_eq!(f.undo_depth(), 1, "the batch left more than one undo step");
    f.undo();
    assert_eq!(f.undo_depth(), 0);
}

#[test]
fn every_outline_command_records_an_undo_entry() {
    // Grouping had no undo entry AT ALL, so Ctrl+Z after grouping a block undid
    // the user's previous action instead. Every mutating command in grouping.rs
    // goes through the one recorder; this fails if a tenth is added without it.
    const SRC: &str = include_str!("grouping.rs");
    for command in [
        "group_rows",
        "ungroup_rows",
        "group_columns",
        "ungroup_columns",
        "collapse_row_group",
        "expand_row_group",
        "collapse_column_group",
        "expand_column_group",
        "show_outline_level",
        "set_outline_settings",
        "clear_outline",
    ] {
        let start = SRC
            .find(&format!("pub fn {command}("))
            .unwrap_or_else(|| panic!("no `pub fn {command}(` in grouping.rs"));
        let rest = &SRC[start..];
        let end = rest[1..]
            .find("\n#[tauri::command]")
            .map(|i| i + 1)
            .unwrap_or(rest.len());
        assert!(
            rest[..end].contains("with_outline_undo("),
            "`{command}` mutates the outline without recording an undo entry"
        );
    }
}

// ---------------------------------------------------------------------------
// GAP 4 - the NON-CELL changes had no sheet dimension EITHER
//
// `SetCell` grew a `sheet` field (GAP 3 above) and the other four variants did
// not, so the same defect survived beside the fix for it. Column widths, row
// heights, merge regions and whole-grid snapshots were all applied to
// `state.column_widths` / `state.row_heights` / `state.merged_regions` /
// `state.grid` - the ACTIVE sheet's mirrors - no matter which sheet the change
// had been recorded on. "The active sheet" is true when they are RECORDED and
// need not be true when they are RESTORED, and nothing in between checked.
//
// The snapshot case is the severe one and it needs three ordinary actions:
// insert a row on Sheet2, click the Sheet1 tab, press Ctrl+Z. Sheet1's ENTIRE
// cell map was replaced by Sheet2's saved one, with no error and no way back.
// ---------------------------------------------------------------------------

fn undo_region(sr: u32, sc: u32, er: u32, ec: u32) -> engine::UndoMergeRegion {
    engine::UndoMergeRegion { start_row: sr, start_col: sc, end_row: er, end_col: ec }
}

fn sheet_merges(
    f: &Fixture,
    sheet: usize,
) -> std::collections::HashSet<crate::api_types::MergedRegion> {
    crate::report::with_sheet_merges(&f.state, sheet, |m| m.clone())
}

#[test]
fn a_column_width_undo_restores_the_sheet_it_was_recorded_on() {
    // Resize a column on Sheet2, switch to Sheet1, Ctrl+Z. The restore has to
    // land in `all_column_widths[1]`, not on the column the user is looking at.
    let f = Fixture::new(2);
    {
        let e = crate::document_effect::test_seed_effect();
        f.state.column_widths.write(&e).unwrap().insert(3, 111.0);
        f.state.all_column_widths.write(&e).unwrap()[1].insert(3, 222.0);
    }
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_column_width_change(1, 3, Some(64.0));

    f.undo();

    // Read per SHEET, not per store: undo activates the sheet it restored, so
    // which of `column_widths` / `all_column_widths[n]` holds a given sheet's
    // widths depends on where the user ended up. `Fixture::column_width`
    // applies the same active-or-`all_` rule `report::with_sheet_merges` does,
    // and asserting through it states the invariant the test always meant.
    assert_eq!(
        f.column_width(1, 3),
        Some(64.0),
        "Sheet2's column 3 was not restored"
    );
    assert_eq!(
        f.column_width(0, 3),
        Some(111.0),
        "the OTHER sheet's column 3 was resized by an undo belonging to Sheet2"
    );
}

#[test]
fn a_row_height_undo_restores_the_sheet_it_was_recorded_on() {
    let f = Fixture::new(2);
    {
        let e = crate::document_effect::test_seed_effect();
        f.state.row_heights.write(&e).unwrap().insert(5, 40.0);
        f.state.all_row_heights.write(&e).unwrap()[1].insert(5, 60.0);
    }
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_row_height_change(1, 5, None);

    f.undo();

    // Per sheet, not per store — see the column-width twin above.
    assert_eq!(
        f.row_height(1, 5),
        None,
        "Sheet2's row 5 should be back to the default height"
    );
    assert_eq!(
        f.row_height(0, 5),
        Some(40.0),
        "the OTHER sheet's row 5 was resized by Sheet2's undo"
    );
}

#[test]
fn a_merge_undo_applies_to_the_sheet_the_merge_was_made_on() {
    // Merge on Sheet2, switch to Sheet1, Ctrl+Z: Sheet2 unmerges, Sheet1 does
    // not. Redo puts it back on Sheet2 - asserted because the direction is
    // decided by `is_undo`, and getting that wrong is BUG-0009's double
    // negation in a new place.
    let f = Fixture::new(2);
    let region = undo_region(0, 0, 1, 1);
    crate::report::with_sheet_merges_mut(
        &f.state,
        &crate::document_effect::test_seed_effect(),
        1,
        |m| {
            m.insert(crate::api_types::MergedRegion {
                start_row: 0,
                start_col: 0,
                end_row: 1,
                end_col: 1,
            });
        },
    );
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_merge_region_added(1, region);

    let result = f.undo();
    assert!(result.merge_changed, "an off-sheet merge undo must announce itself");
    assert!(
        sheet_merges(&f, 1).is_empty(),
        "Sheet2's merge survived the undo of the merge"
    );
    assert!(
        sheet_merges(&f, 0).is_empty(),
        "Sheet1 was given a merge it never had"
    );

    f.redo();
    assert_eq!(sheet_merges(&f, 1).len(), 1, "redo must put Sheet2's merge back");
    assert!(sheet_merges(&f, 0).is_empty(), "and must not touch Sheet1");
}

#[test]
fn a_structural_snapshot_undo_does_not_replace_the_active_sheets_whole_grid() {
    // THE SEVERE ONE. `RestoreSnapshot` replaces an entire grid. Recorded on
    // Sheet2 by an insert-row; undone while Sheet1 is active. Before the sheet
    // stamp, Sheet1's cell map became Sheet2's snapshot - every value on the
    // sheet the user was looking at, gone and replaced by another sheet's.
    let f = Fixture::new(2);
    f.put(0, 0, 0, Cell::new_number(1000.0));
    f.put(0, 1, 0, Cell::new_number(2000.0));
    f.put(1, 0, 0, Cell::new_number(7.0));

    // Sheet2 as it was BEFORE the edit being undone.
    let mut before = engine::Grid::new();
    before.set_cell(0, 0, Cell::new_number(5.0));
    let snapshot = engine::GridSnapshot {
        sheet: 1,
        cells: before.cells.clone(),
        row_heights: HashMap::new(),
        column_widths: HashMap::new(),
        merged_regions: HashSet::new(),
        max_row: before.max_row,
        max_col: before.max_col,
        row_styles: HashMap::new(),
        column_styles: HashMap::new(),
    };
    {
        let mut stack = f.state.undo_stack.lock().unwrap();
        stack.begin_transaction("Insert 1 row(s)".to_string());
        stack.record_snapshot(snapshot);
        stack.commit_transaction();
    }

    let result = f.undo();

    // The catastrophic half FIRST, so a regression reports the data loss
    // rather than the missed restore that accompanies it.
    assert_eq!(
        f.number(0, 0, 0),
        1000.0,
        "SHEET1's grid was replaced by Sheet2's snapshot - the user's whole sheet"
    );
    assert_eq!(f.number(1, 0, 0), 5.0, "Sheet2 was not restored from its own snapshot");
    assert_eq!(f.number(0, 1, 0), 2000.0, "...and its second cell with it");
    // Sheet1's grid survived (asserted above) and the view has followed the
    // restore to Sheet2, which is Excel's rule. The mirror therefore shows
    // Sheet2's restored snapshot, not Sheet1.
    assert_eq!(
        f.state.grid.read().unwrap().get_cell(0, 0).map(|c| c.value.clone()),
        Some(CellValue::Number(5.0)),
        "a snapshot restore must switch to the sheet it replaced"
    );
    assert!(
        result.structural_restore,
        "a whole-grid swap must tell the frontend to refresh, wherever it landed"
    );

    // Redo returns Sheet2 to its post-edit shape and still leaves Sheet1 alone.
    f.redo();
    assert_eq!(f.number(1, 0, 0), 7.0, "redo must re-apply Sheet2's edit");
    assert_eq!(f.number(0, 0, 0), 1000.0, "and must still not touch Sheet1");
}

#[test]
fn the_active_sheet_path_is_unchanged_by_the_off_sheet_one() {
    // THE CONTROL, and it is the reason this change is safe to make without a
    // live run: when the recorded sheet IS the active one, every arm behaves
    // exactly as it always did. Only the previously-broken off-sheet branch is
    // new, and nothing reached it before because nothing could express it.
    let f = Fixture::new(2);
    {
        let e = crate::document_effect::test_seed_effect();
        f.state.column_widths.write(&e).unwrap().insert(3, 111.0);
    }
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_column_width_change(0, 3, Some(64.0));

    f.undo();

    assert_eq!(f.active(), 0, "an active-sheet undo must not switch anything");
    assert_eq!(
        f.state.column_widths.read().unwrap().get(&3).copied(),
        Some(64.0),
        "an ACTIVE-sheet width undo must still land on the mirror"
    );
    assert_eq!(
        f.state.all_column_widths.read().unwrap()[1].get(&3).copied(),
        None,
        "and must not touch any other sheet's store"
    );
}
