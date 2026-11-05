//! FILENAME: app/src-tauri/src/scripting/queued_style_tests.rs
//! PURPOSE: A module run's queued `Calcula.applyNamedStyle` is applied by Rust
//! WITH the run's cells, in ONE undo step, and a style that cannot be applied
//! takes the whole run back (owner decision B, follow-up F9, for the module
//! runtime; `apply_run_with_queued_styles`). The trail records a style only
//! once it was applied (rev-sec-3). And a named style keeps a cell's
//! protection the way Excel's IncludeProtection does (rev-sec-1).

use super::*;
use crate::slicer::SlicerState;
use crate::timeline_slicer::TimelineSlicerState;
use engine::{Cell, CellStyle, CellValue};
use script_engine::types::DeferredAction;
use std::cell::Cell as Flag;
use std::collections::HashMap as StdHashMap;
use std::sync::Mutex;

struct H {
    state: AppState,
    file: FileState,
    user_files: UserFilesState,
    pivot: PivotState,
    slicer: SlicerState,
    ribbon: RibbonFilterState,
    pane: PaneControlState,
    timeline: TimelineSlicerState,
}

fn harness() -> H {
    let state = crate::create_app_state();
    {
        let effect = crate::document_effect::test_seed_effect();
        let mut grids = state.grids.write(&effect).unwrap();
        let mut names = state.sheet_names.write(&effect).unwrap();
        let mut ids = state.sheet_ids.write(&effect).unwrap();
        while grids.len() < 2 {
            grids.push(engine::grid::Grid::new());
        }
        names.clear();
        names.extend(["Sheet1".to_string(), "Sheet2".to_string()]);
        ids.clear();
        ids.extend((0..2).map(|_| identity::SheetId::from_bytes(identity::generate_uuid_v7())));
    }
    H {
        state,
        file: FileState::default(),
        user_files: UserFilesState { files: Mutex::new(StdHashMap::new()) },
        pivot: PivotState::new(),
        slicer: SlicerState::new(),
        ribbon: RibbonFilterState::new(),
        pane: PaneControlState::new(),
        timeline: TimelineSlicerState::new(),
    }
}

impl H {
    fn stores(&self) -> RunRollbackStores<'_> {
        RunRollbackStores {
            user_files: &self.user_files,
            pivot: &self.pivot,
            slicer: &self.slicer,
            ribbon: &self.ribbon,
            pane: &self.pane,
            timeline: &self.timeline,
        }
    }

    /// The run's cell write, as the edit pipeline makes it: Sheet2!A1 = 5,
    /// recorded in the open undo step.
    fn write_cell(&self) -> Result<(), String> {
        let effect = crate::document_effect::DocumentEffect::mutates(&self.file);
        self.state.grids.write(&effect).unwrap()[1].set_cell(
            0,
            0,
            Cell { value: CellValue::Number(5.0), ast: None, style_index: 0, rich_text: None },
        );
        self.state.undo_stack.lock().unwrap().record_cell_change(1, 0, 0, None);
        Ok(())
    }

    fn sheet2_a1(&self) -> Option<CellValue> {
        self.state.grids.read().unwrap()[1].get_cell(0, 0).map(|c| c.value.clone())
    }

    fn style_index_at(&self, sheet: usize, row: u32, col: u32) -> usize {
        if sheet == *self.state.active_sheet.read().unwrap() {
            return self.state.grid.read().unwrap().effective_style_index(row, col);
        }
        self.state.grids.read().unwrap()[sheet].effective_style_index(row, col)
    }

    fn named_index(&self, name: &str) -> usize {
        self.state.named_styles.read().unwrap()[name].style_index
    }

    fn undo_depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }

    fn executed(&self) -> Vec<calp::audit::AuditEntry> {
        self.state
            .audit_log
            .read()
            .unwrap()
            .entries
            .iter()
            .filter(|e| matches!(e.event, calp::audit::AuditEvent::ScriptExecuted))
            .cloned()
            .collect()
    }

    fn protect(&self, sheet: usize) {
        let seed = crate::document_effect::test_seed_effect();
        // Default options: Format Cells NOT allowed.
        self.state.sheet_protection.write(&seed).unwrap().entry(sheet).or_default().protected = true;
    }

    fn run(&self, actions: &[DeferredAction], cells: impl FnOnce() -> Result<(), String>) -> Result<usize, String> {
        apply_run_with_queued_styles(&self.state, &self.file, &self.stores(), "run_script", "report.js", 0, actions, cells)
    }
}

fn good_on_sheet2() -> Vec<DeferredAction> {
    vec![
        DeferredAction::ActivateSheet { sheet_index: 1 },
        DeferredAction::ApplyNamedStyle { name: "Good".into(), row: 0, col: 0, end_row: Some(1), end_col: None },
    ]
}

/// The run's cells and its queued style are ONE undo step: one Ctrl+Z takes
/// both back. The style lands on the sheet the run had switched to, and is on
/// the trail once it was applied.
///
/// SABOTAGE: commit the step before the styles are applied in
/// `apply_run_with_queued_styles` -> two steps (the style its own), as the
/// page's replay used to make.
#[test]
fn a_module_runs_cells_and_queued_style_are_one_undo_step() {
    let h = harness();
    let applied = h.run(&good_on_sheet2(), || h.write_cell()).expect("the run applies");
    assert_eq!(applied, 1);
    assert_eq!(h.sheet2_a1(), Some(CellValue::Number(5.0)));
    let good = h.named_index("Good");
    assert_eq!(h.style_index_at(1, 0, 0), good, "Sheet2!A1 took the style");
    assert_eq!(h.style_index_at(1, 1, 0), good, "Sheet2!A2 too");
    assert_eq!(h.style_index_at(0, 0, 0), 0, "Sheet1 untouched");
    assert_eq!(h.undo_depth(), 1, "ONE step for the run's cells and its style");
    let step = h.state.undo_stack.lock().unwrap().pop_undo().unwrap();
    assert_eq!(step.changes.len(), 3, "the cell and the two styled cells: {:?}", step.changes.len());
    let rows = h.executed();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(rows[0].description.contains("applied the cell style 'Good' to Sheet2!A1:A2"), "{}", rows[0].description);
}

/// A style the sheet's protection refuses ends the run BEFORE anything is
/// written: no cell, no step, no "applied" row -- a refusal row instead.
///
/// SABOTAGE: drop the protection gate from the pre-pass -> the cells are
/// written (the closure runs) before the style fails.
#[test]
fn a_queued_style_a_protected_sheet_refuses_writes_nothing() {
    let h = harness();
    h.protect(1);
    let ran = Flag::new(false);
    let err = h
        .run(&good_on_sheet2(), || {
            ran.set(true);
            h.write_cell()
        })
        .unwrap_err();
    assert!(err.contains("could not be applied to Sheet2!A1:A2"), "{err}");
    assert!(err.contains("nothing was changed"), "{err}");
    assert!(!ran.get(), "the run's cells were never written");
    assert_eq!(h.sheet2_a1(), None);
    assert_eq!(h.undo_depth(), 0, "no step");
    assert!(!h.state.undo_stack.lock().unwrap().has_open_transaction(), "nothing left open");
    let rows = h.executed();
    assert!(rows.iter().all(|r| !r.description.contains("applied the cell style")), "a false applied row: {rows:?}");
    assert!(rows.iter().any(|r| r.extra.get("rolledBack") == Some(&serde_json::json!(true))), "{rows:?}");
}

/// A style that fails AFTER the cells were written (here the sheet is
/// protected between the gate and the write) takes the WHOLE run back: the
/// run's cell is gone, and there is no undo step and no redo step.
///
/// SABOTAGE: drop `take_back_and_close()` from the style loop -> Sheet2!A1
/// keeps the run's 5.
#[test]
fn a_queued_style_that_fails_after_the_cells_takes_the_whole_run_back() {
    let h = harness();
    let err = h
        .run(&good_on_sheet2(), || {
            h.write_cell()?;
            h.protect(1);
            Ok(())
        })
        .unwrap_err();
    assert!(err.contains("Every change the script made was undone"), "{err}");
    assert_eq!(h.sheet2_a1(), None, "the run's cell was taken back");
    assert_eq!(h.undo_depth(), 0, "no undo step");
    assert!(!h.state.undo_stack.lock().unwrap().can_redo(), "no redo step");
    assert!(!h.state.undo_stack.lock().unwrap().has_open_transaction());
}

/// A run with no queued style is its cells alone, unchanged.
#[test]
fn a_run_without_a_queued_style_is_its_cells_alone() {
    let h = harness();
    assert_eq!(h.run(&[DeferredAction::Calculate], || h.write_cell()).unwrap(), 0);
    assert_eq!(h.sheet2_a1(), Some(CellValue::Number(5.0)));
}

// ============================================================================
// rev-sec-1: a named style and the cell's protection (Excel's IncludeProtection)
// ============================================================================

/// A1 unlocked AND hidden, through the ordinary style door.
fn unlock_and_hide_a1(h: &H) {
    let idx = {
        let seed = crate::document_effect::test_seed_effect();
        let mut styles = h.state.style_registry.write(&seed).unwrap();
        let mut s = CellStyle::new();
        s.locked = false;
        s.formula_hidden = true;
        styles.get_or_create(s)
    };
    crate::commands::styles::set_cell_style_core(&h.state, &h.file, 0, 0, idx, None).expect("seed A1");
}

fn a1_protection(h: &H) -> (bool, bool) {
    let idx = h.style_index_at(0, 0, 0);
    let s = h.state.style_registry.read().unwrap().get(idx).clone();
    (s.locked, s.formula_hidden)
}

/// Excel [LIVE, Excel 16 COM, 2026-11-05]: every built-in style but "Normal"
/// has IncludeProtection = False, so applying "Good" keeps a cell's
/// Locked = False and FormulaHidden = True; "Normal" (True) writes its own
/// Locked = True, FormulaHidden = False; a style the user creates includes
/// protection, so it writes the flags it was made with. On a PROTECTED sheet
/// (Format Cells allowed) every style keeps both.
///
/// SABOTAGE: make `named_style_includes_protection` answer `true` -> "Good"
/// re-locks A1.
#[test]
fn a_named_style_keeps_a_cells_protection_as_excels_include_protection_does() {
    let h = harness();
    unlock_and_hide_a1(&h);
    crate::named_styles_cmd::apply_named_style_impl(&h.state, &h.file, "Good", &[0], &[0], None).unwrap();
    assert_eq!(a1_protection(&h), (false, true), "\"Good\" keeps Locked=False and Hidden=True");
    crate::named_styles_cmd::apply_named_style_impl(&h.state, &h.file, "Normal", &[0], &[0], None).unwrap();
    assert_eq!(a1_protection(&h), (true, false), "\"Normal\" writes its own protection");

    // A user's own style includes protection.
    let mine = {
        let seed = crate::document_effect::test_seed_effect();
        let mut styles = h.state.style_registry.write(&seed).unwrap();
        let mut s = CellStyle::new();
        s.locked = false;
        s.formula_hidden = true;
        s.font.bold = true;
        styles.get_or_create(s)
    };
    crate::named_styles_cmd::create_named_style_impl(&h.state, &h.file, "Mine".into(), mine, "Custom".into()).unwrap();
    crate::named_styles_cmd::apply_named_style_impl(&h.state, &h.file, "Mine", &[0], &[0], None).unwrap();
    assert_eq!(a1_protection(&h), (false, true), "a user style writes the protection it was made with");

    // Protected, Format Cells allowed: every style keeps both flags.
    unlock_and_hide_a1(&h);
    {
        let seed = crate::document_effect::test_seed_effect();
        let mut prot = h.state.sheet_protection.write(&seed).unwrap();
        let p = prot.entry(0).or_default();
        p.protected = true;
        p.options.allow_format_cells = true;
    }
    crate::named_styles_cmd::apply_named_style_impl(&h.state, &h.file, "Normal", &[0], &[0], None).unwrap();
    assert_eq!(a1_protection(&h), (false, true), "on a protected sheet even \"Normal\" keeps both");
}
