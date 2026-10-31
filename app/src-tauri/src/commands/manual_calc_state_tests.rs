//! FILENAME: app/src-tauri/src/commands/manual_calc_state_tests.rs
//! PURPOSE: Excel's `CalculationState = xlPending` under MANUAL calculation --
//! what `get_calculation_state` answers and the status bar shows as
//! "Calculate".
//!
//! [LIVE] Excel 16, a fresh workbook, Calculation = manual, `B1 = A1*2`:
//!
//! - entering a value into a cell no formula reads: xlDone;
//! - changing only a cell's format: xlDone;
//! - changing A1: xlPending, B1 still shows the old value;
//! - saving with CalculateBeforeSave off: still xlPending; the file says
//!   `<calcPr calcMode="manual" calcCompleted="0" calcOnSave="0"/>`;
//! - reopening that file: xlPending, B1 stale;
//! - with a volatile `=RAND()` on the sheet, ANY entry: xlPending;
//! - Calculate: xlDone.
//!
//! `get_calculation_state` used to read only a CANCELLED pass's record
//! (`pending_recalc`), so it answered "done" for every one of these.
//!
//! A child module of `commands::data`, reusing the `Workbook` harness
//! `cross_sheet_recalc_tests` owns, so every edit goes through the real edit
//! path (`update_cell_impl`, `update_cells_batch_core`).

use super::cross_sheet_recalc_tests::Workbook;
use super::*;
use crate::calculation::CalcScope;
use engine::CellValue;

fn state_of(wb: &Workbook) -> &'static str {
    crate::calculation::calculation_state_impl(&wb.state)
}

fn go_manual(wb: &Workbook) {
    *wb.state.calculation_mode.lock().unwrap() = "manual".to_string();
}

/// F9: the completed workbook pass, the only thing that vouches again.
fn f9(wb: &Workbook) {
    crate::calculation::run_calculation_pass(
        CalcScope::Workbook,
        None,
        &wb.state,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        None,
    )
    .expect("run_calculation_pass(Workbook) failed");
}

fn batch(wb: &Workbook, writes: &[(u32, u32, &str)]) {
    let updates: Vec<crate::api_types::CellUpdateInput> = writes
        .iter()
        .map(|&(row, col, value)| crate::api_types::CellUpdateInput {
            row,
            col,
            value: value.to_string(),
            style_index: None,
            invariant: Some(true),
            pasted: None,
            moved: None,
        })
        .collect();
    update_cells_batch_core(&wb.state, &wb.file, &wb.files, &wb.pivots, updates, None, None, None, None)
        .expect("the batch writes");
}

/// A1 = 1, B1 = A1*2, calculated, then manual calculation.
fn manual_workbook_with_a_dependent() -> Workbook {
    let wb = Workbook::new(1);
    wb.set(0, 0, "1");
    wb.set(0, 1, "=A1*2");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(2.0));
    go_manual(&wb);
    assert_eq!(state_of(&wb), "done", "nothing is pending before the edit");
    wb
}

#[test]
fn a_manual_edit_of_a_precedent_reports_calculation_pending_until_f9() {
    let wb = manual_workbook_with_a_dependent();

    // A cell no formula reads: Excel stays xlDone.
    wb.set(4, 2, "7");
    assert_eq!(state_of(&wb), "done", "an entry nothing depends on left nothing to calculate");

    // A precedent: Excel says xlPending and B1 keeps its old value.
    wb.set(0, 0, "5");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(2.0), "manual calculation left B1 as it was");
    assert_eq!(
        state_of(&wb),
        "pending",
        "a manual edit left =A1*2 un-recalculated and the calculation state still said done; \
         Excel says xlPending (\"Calculate\")"
    );

    f9(&wb);
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(10.0));
    assert_eq!(state_of(&wb), "done", "a completed Calculate Now settles it");
}

#[test]
fn a_manual_paste_over_a_precedent_reports_pending_and_a_formula_it_enters_does_not() {
    let wb = manual_workbook_with_a_dependent();
    // A batch entering a formula no other formula reads: the batch evaluates
    // it itself, so nothing is left (Excel: xlDone).
    batch(&wb, &[(6, 3, "=1+1")]);
    assert_eq!(state_of(&wb), "done", "a written formula is not left uncalculated by its own write");

    batch(&wb, &[(0, 0, "9")]);
    assert_eq!(state_of(&wb), "pending", "a paste over A1 left =A1*2 un-recalculated");
}

#[test]
fn with_a_volatile_formula_any_manual_entry_is_pending() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "=RAND()");
    go_manual(&wb);
    assert_eq!(state_of(&wb), "done");
    wb.set(8, 3, "3");
    assert_eq!(state_of(&wb), "pending", "Excel [LIVE]: with =RAND() on the sheet any entry is xlPending");
}

#[test]
fn a_manual_edit_read_from_another_sheet_is_pending() {
    let wb = Workbook::new(2);
    wb.switch_to(1);
    wb.set(0, 1, "=Sheet1!A1*3");
    wb.switch_to(0);
    wb.set(0, 0, "2");
    assert_eq!(wb.number(1, 0, 1), 6.0);
    go_manual(&wb);
    assert_eq!(state_of(&wb), "done");
    wb.set(0, 0, "4");
    assert_eq!(state_of(&wb), "pending", "Sheet2!B1 reads A1 and was left un-recalculated");
}

#[test]
fn a_manual_bulk_rewrite_of_a_precedent_is_pending() {
    // The choke point clear, sort and the structural edits end in.
    let wb = manual_workbook_with_a_dependent();
    let mut updated = Vec::new();
    recalc_after_active_sheet_bulk_rewrite(&wb.state, &wb.files, &wb.pane, &wb.filters, &[(4, 4)], &mut updated);
    assert_eq!(state_of(&wb), "done", "a rewrite of a cell nothing reads");
    recalc_after_active_sheet_bulk_rewrite(&wb.state, &wb.files, &wb.pane, &wb.filters, &[(0, 0)], &mut updated);
    assert_eq!(state_of(&wb), "pending");
}

/// EXCEL: LEAVING MANUAL FOR AUTOMATIC IS A RECALCULATION [LIVE, Excel 16 COM:
/// manual, `B1 = A1*2`, A1 changed to 5 -> B1 = 2, xlPending;
/// `Application.Calculation = xlAutomatic` -> B1 = 10, xlDone]. Calcula
/// marked every sheet stale on the switch and recalculated nothing unless the
/// Formulas MENU chained Calculate Now, so a script's
/// `setCalculationMode("automatic")`, the release when a script holding manual
/// ended, and the workbook-swap sweep left an AUTOMATIC workbook pending: the
/// status bar said Calculate and every save stamped `calculation_incomplete`.
/// The command (`set_calculation_mode`) is these two halves -- its wiring is
/// pinned by `the_mode_command_recalculates_when_it_leaves_manual`.
///
/// SABOTAGE: make `recalculate_after_leaving_manual` return `Ok(Vec::new())`.
#[test]
fn leaving_manual_for_automatic_recalculates_and_settles_the_state() {
    let wb = manual_workbook_with_a_dependent();
    wb.set(0, 0, "5");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(2.0), "the premise: manual left B1 stale");
    assert_eq!(state_of(&wb), "pending");

    let applied = std::sync::atomic::AtomicU64::new(0);
    let (mode, left_manual) =
        crate::calculation::switch_calculation_mode_in_order(&wb.state, "automatic", 1, &applied);
    assert_eq!(mode, "automatic");
    assert!(left_manual, "manual -> automatic is the switch that recalculates");
    let cells = crate::calculation::recalculate_after_leaving_manual(
        None, &wb.state, &wb.files, &wb.pivots, &wb.pane, &wb.filters, None,
    )
    .expect("the recalculation runs");
    assert_eq!(
        wb.value(0, 0, 1),
        CellValue::Number(10.0),
        "setting calculation to automatic left =A1*2 stale; Excel recalculates on the switch"
    );
    assert_eq!(state_of(&wb), "done", "an automatic workbook was left pending after leaving manual");
    assert!(
        cells.iter().any(|c| c.row == 0 && c.col == 1 && c.display == "10"),
        "the recalculated B1 is answered for the repaint: {:?}",
        cells.iter().map(|c| (c.row, c.col, c.display.clone())).collect::<Vec<_>>()
    );

    // Only LEAVING manual asks for it: automatic -> automatic, and a switch
    // into manual, recalculate nothing.
    assert!(!crate::calculation::switch_calculation_mode_in_order(&wb.state, "automatic", 2, &applied).1);
    assert!(!crate::calculation::switch_calculation_mode_in_order(&wb.state, "manual", 3, &applied).1);
    assert!(!crate::calculation::switch_calculation_mode_in_order(&wb.state, "manual", 4, &applied).1);
}

/// UNDO AND REDO UNDER MANUAL CALCULATION leave the workbook pending, as an
/// edit does [LIVE, Excel 16, visible instance driven by SendKeys: manual,
/// `B1 = A1*2`, type 5 into A1, Calculate (B1 = 10, xlDone); Ctrl+Z -> A1 = 1,
/// B1 still 10, xlPending; Calculate -> B1 = 2, xlDone; Ctrl+Y -> A1 = 5, B1
/// still 2, xlPending]. The restore runs through the shared bulk-rewrite
/// choke point, which under manual recalculates nothing and records the
/// pending state.
///
/// SABOTAGE: drop the `note_manual_write_left_formulas_uncalculated` call in
/// `recalc_after_active_sheet_bulk_rewrite`'s manual return.
#[test]
fn undo_and_redo_of_a_precedent_under_manual_leave_the_workbook_pending() {
    let wb = manual_workbook_with_a_dependent();
    wb.set(0, 0, "5");
    f9(&wb);
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(10.0));
    assert_eq!(state_of(&wb), "done");

    super::cross_sheet_recalc_tests::undo_once(&wb);
    assert_eq!(wb.value(0, 0, 0), CellValue::Number(1.0), "Ctrl+Z put A1 back");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(10.0), "Excel leaves B1 for Calculate under manual");
    assert_eq!(
        state_of(&wb),
        "pending",
        "an undo of a precedent under manual left =A1*2 stale and the state said done; Excel says xlPending"
    );
    f9(&wb);
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(2.0));
    assert_eq!(state_of(&wb), "done");

    // Redo: the same restore with the inverse transaction.
    let transaction = wb.state.undo_stack.lock().unwrap().pop_redo().expect("the undo left a redo step");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, &wb.timelines,
        transaction, false,
    );
    assert_eq!(wb.value(0, 0, 0), CellValue::Number(5.0), "Ctrl+Y put A1 = 5 back");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(2.0), "Excel leaves B1 for Calculate under manual");
    assert_eq!(state_of(&wb), "pending", "a redo of a precedent under manual left the state done");
}

/// THE SAME UNDO, OF AN EDIT ON A SHEET THE USER IS NOT LOOKING AT. Its restore
/// goes through the off-sheet path, a whole-sheet pass over the restored sheet
/// and its readers that ran WHATEVER THE MODE: Sheet2!B1 and Sheet1!C1 were
/// recalculated behind a manual-calculation user's back (and the state then
/// read done). Excel recalculates nothing under manual calculation on any
/// sheet [LIVE, see the test above: Ctrl+Z leaves B1 at its value, xlPending].
///
/// SABOTAGE: run the off-sheet recalculation in `apply_changes` whatever the mode.
#[test]
fn an_undo_on_a_background_sheet_under_manual_recalculates_nothing_and_is_pending() {
    let wb = Workbook::new(2);
    wb.set(0, 2, "=Sheet2!A1*3"); // Sheet1!C1, a reader on another sheet
    wb.switch_to(1);
    wb.set(0, 0, "1"); // Sheet2!A1
    wb.set(0, 1, "=A1*2"); // Sheet2!B1
    wb.set(0, 0, "5"); // the edit to undo
    wb.switch_to(0);
    assert_eq!(wb.number(1, 0, 1), 10.0);
    assert_eq!(wb.number(0, 0, 2), 15.0);
    go_manual(&wb);
    assert_eq!(state_of(&wb), "done");

    super::cross_sheet_recalc_tests::undo_once(&wb);
    assert_eq!(wb.value(1, 0, 0), CellValue::Number(1.0), "Ctrl+Z put Sheet2!A1 back");
    assert_eq!(
        wb.value(1, 0, 1),
        CellValue::Number(10.0),
        "an undo on a background sheet under manual recalculated Sheet2!B1; Excel leaves it for Calculate"
    );
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(15.0), "and its reader Sheet1!C1");
    assert_eq!(state_of(&wb), "pending", "the undone precedent's dependents are stale: xlPending");
    f9(&wb);
    assert_eq!(wb.value(1, 0, 1), CellValue::Number(2.0));
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(3.0));
    assert_eq!(state_of(&wb), "done");
}

/// rev13A: AN OFF-SHEET UNDO UNDER MANUAL MARKS PENDING ONLY WHEN A FORMULA
/// READS WHAT IT RESTORED -- as the same undo on the active sheet does, and as
/// Excel does [LIVE, Excel 16, round 15, a visible instance driven by
/// SendKeys: manual, `Sheet1!A1 = Sheet2!B1*2`; Sheet2!Z99 typed 5, Ctrl+PgUp,
/// Ctrl+Z -> xlDone; Sheet2!B1 typed 7, F9, Ctrl+PgUp, Ctrl+Z -> xlPending].
/// Every restored sheet was marked, so undoing a constant nothing reads turned
/// the state to "Calculate" and stamped the next save calc_state.json (v12).
///
/// SABOTAGE: make `off_sheet_restore_left_formulas_uncalculated` return `true`
/// at once -- the first assertion fails. (Returning `false` fails the readers.)
#[test]
fn an_off_sheet_undo_under_manual_is_pending_only_when_a_formula_reads_the_restored_cell() {
    let wb = Workbook::new(2);
    wb.set(0, 4, "=Sheet2!D5"); // Sheet1!E1, reads Sheet2!D5 from another sheet
    wb.switch_to(1);
    wb.set(0, 0, "1"); // Sheet2!A1
    wb.set(0, 1, "=A1*2"); // Sheet2!B1, reads A1 only
    wb.set(0, 5, "=SUM(G:G)"); // Sheet2!F1, reads the whole G column
    wb.switch_to(0);
    go_manual(&wb);
    assert_eq!(state_of(&wb), "done");

    let edit_then_undo_from_sheet1 = |row: u32, col: u32, value: &str| {
        wb.switch_to(1);
        wb.set(row, col, value);
        wb.switch_to(0);
        f9(&wb);
        assert_eq!(state_of(&wb), "done", "the premise: calculated before the undo");
        super::cross_sheet_recalc_tests::undo_once(&wb);
        assert_eq!(wb.value(1, row, col), CellValue::Empty, "Ctrl+Z took the entry back");
        state_of(&wb)
    };

    assert_eq!(
        edit_then_undo_from_sheet1(98, 25, "5"), // Sheet2!Z99, read by nothing
        "done",
        "an off-sheet undo of a cell no formula reads left the workbook pending; Excel says xlDone"
    );
    assert_eq!(
        edit_then_undo_from_sheet1(4, 3, "5"), // Sheet2!D5, read by Sheet1!E1
        "pending",
        "an off-sheet undo of a cell another sheet reads left the state done"
    );
    f9(&wb);
    assert_eq!(
        edit_then_undo_from_sheet1(6, 6, "5"), // Sheet2!G7, read by Sheet2!F1 = SUM(G:G)
        "pending",
        "an off-sheet undo of a cell a same-sheet column reference reads left the state done"
    );
}

/// rev15B: THE SAME OFF-SHEET UNDO, READ BY A WHOLE COLUMN OR ROW, OR A 3D
/// SPAN, ON ANOTHER SHEET. `=SUM(Sheet2!G:G)` and `=SUM(Sheet1:Sheet3!K20)`
/// (Sheet2 in the MIDDLE of the span) are not edges in the cross-sheet
/// dependents map, so undoing Sheet2!G5 from Sheet1 under manual read "done"
/// while the sum stayed stale -- and the next save did not stamp
/// calc_state.json (v12), the "stale workbook comes back looking calculated"
/// lie. Excel: any un-recalculated reader of the undone cell is xlPending
/// [LIVE, round 15, the test above's probe]. The reverse: `=SUM(Sheet3!H:H)`
/// on Sheet2 reads Sheet3's H, not Sheet2's, and is no reader of Sheet2!H50.
///
/// SABOTAGE: drop the other-sheets walk in
/// `off_sheet_restore_left_formulas_uncalculated` (the G:G assertion fails);
/// and, separately, let a qualified reference on the restored sheet count as
/// its own (the H:H assertion fails).
#[test]
fn an_off_sheet_undo_under_manual_is_pending_when_another_sheet_reads_it_by_column_row_or_3d_span() {
    let wb = Workbook::new(3);
    wb.set(0, 0, "=SUM(Sheet2!G:G)"); // Sheet1!A1
    wb.set(0, 1, "=SUM(Sheet2!9:9)"); // Sheet1!B1
    wb.set(0, 2, "=SUM(Sheet1:Sheet3!K20)"); // Sheet1!C1, Sheet2 in the middle
    wb.switch_to(1);
    wb.set(0, 5, "=SUM(Sheet3!H:H)"); // Sheet2!F1 reads SHEET3's column H
    wb.switch_to(0);
    go_manual(&wb);
    f9(&wb);
    assert_eq!(state_of(&wb), "done");

    let edit_then_undo_from_sheet1 = |row: u32, col: u32, value: &str| {
        wb.switch_to(1);
        wb.set(row, col, value);
        wb.switch_to(0);
        f9(&wb);
        assert_eq!(state_of(&wb), "done", "the premise: calculated before the undo");
        super::cross_sheet_recalc_tests::undo_once(&wb);
        assert_eq!(wb.value(1, row, col), CellValue::Empty, "Ctrl+Z took the entry back");
        state_of(&wb)
    };

    assert_eq!(
        edit_then_undo_from_sheet1(49, 7, "5"), // Sheet2!H50: read by nothing
        "done",
        "=SUM(Sheet3!H:H) on Sheet2 was taken for a reader of Sheet2's own column H"
    );
    assert_eq!(
        edit_then_undo_from_sheet1(4, 6, "5"), // Sheet2!G5, read by Sheet1!A1 = SUM(Sheet2!G:G)
        "pending",
        "an off-sheet undo read by another sheet's whole-column reference left the state done"
    );
    f9(&wb);
    assert_eq!(
        edit_then_undo_from_sheet1(8, 12, "5"), // Sheet2!M9, read by Sheet1!B1 = SUM(Sheet2!9:9)
        "pending",
        "an off-sheet undo read by another sheet's whole-row reference left the state done"
    );
    f9(&wb);
    assert_eq!(
        edit_then_undo_from_sheet1(19, 10, "5"), // Sheet2!K20, inside Sheet1:Sheet3!K20
        "pending",
        "an off-sheet undo read through a 3D span that includes the sheet left the state done"
    );
}

#[test]
fn a_reopened_incomplete_workbook_reports_pending() {
    // What `restore_pending_recalc_on_load` does for a file saved with
    // `calculation_incomplete` (.cala calc_state.json, xlsx calcCompleted="0").
    let wb = Workbook::new(1);
    wb.set(0, 0, "1");
    assert_eq!(state_of(&wb), "done");
    crate::calculation::note_stored_values_may_be_stale(&wb.state);
    assert_eq!(
        state_of(&wb),
        "pending",
        "a workbook saved with calculation incomplete reopened as done; Excel [LIVE] reopens it xlPending"
    );
}

#[test]
fn automatic_calculation_is_never_left_pending_by_an_edit() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "1");
    wb.set(0, 1, "=A1*2");
    wb.set(0, 0, "5");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(10.0));
    assert_eq!(state_of(&wb), "done");
}

#[test]
fn an_autorecover_snapshot_of_an_edited_manual_document_is_marked_incomplete() {
    let wb = Workbook::new(1);
    let mut snapshot = ::persistence::Workbook::new();

    crate::persistence::mark_snapshot_calculation_incomplete(&wb.state, &mut snapshot, true);
    assert!(!snapshot.calculation_incomplete, "automatic calculation vouches for its values");

    go_manual(&wb);
    crate::persistence::mark_snapshot_calculation_incomplete(&wb.state, &mut snapshot, false);
    assert!(!snapshot.calculation_incomplete, "an unedited manual document's values are its last calculation's");

    crate::persistence::mark_snapshot_calculation_incomplete(&wb.state, &mut snapshot, true);
    assert!(
        snapshot.calculation_incomplete,
        "the AutoRecover snapshot of an edited manual document vouched for values the edits may have left stale"
    );
    assert_eq!(state_of(&wb), "done", "the snapshot never marks the live session");
}

/// The command wiring that a unit test cannot drive (both need Tauri `State`):
/// `auto_recover_save` marks its snapshot, and `calp_publish` refuses an
/// incomplete calculation before the workbook is assembled.
#[test]
fn autorecover_and_publish_are_wired_to_the_calculation_state() {
    fn body_of(src: &str, needle: &str) -> String {
        let at = src.find(needle).unwrap_or_else(|| panic!("{} not found", needle));
        let rest = &src[at..];
        let open = rest.find('{').unwrap();
        let mut depth = 0usize;
        for (i, ch) in rest[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return rest[..open + i + 1].to_string();
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced body of {}", needle)
    }
    let strip = |s: String| -> String {
        s.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let persistence_src = std::fs::read_to_string(root.join("src/persistence.rs")).unwrap();
    assert!(
        strip(body_of(&persistence_src, "pub fn auto_recover_save(")).contains("mark_snapshot_calculation_incomplete("),
        "auto_recover_save no longer marks its snapshot: a recovered manual document vouches for stale values"
    );
    // Round 11 (Excel's "Recalculate workbook before saving"): the push no
    // longer REFUSES an incomplete calculation, it finishes it first --
    // `a_publish_recalculates_an_incomplete_manual_calculation_first` runs it.
    let calp_src = std::fs::read_to_string(root.join("src/calp_commands.rs")).unwrap();
    let publish = strip(body_of(&calp_src, "pub fn calp_publish("));
    let recalc = publish
        .find("recalculate_before_publish(")
        .expect("calp_publish no longer recalculates first: subscribers receive stale values as calculated");
    // The LAST assembly is the carrier that ships (round 13: a dry one may be
    // assembled before the pass, only so its code gates can refuse first).
    let assembled = publish.rfind("assemble_publish_workbook(").expect("calp_publish assembles the workbook");
    assert!(recalc < assembled, "calp_publish must recalculate BEFORE it assembles what it ships");
    // ...and AFTER every gate that can still refuse (rev11A): a push that
    // publishes nothing must not have recalculated the author's workbook.
    for gate in ["SemVer::parse(", "resolve_identity_policy(", "preflight_workspace_gates(", "refuse_push_before_recalculation("] {
        let at = publish.find(gate).unwrap_or_else(|| panic!("`{gate}` moved out of calp_publish"));
        assert!(at < recalc, "`{gate}` runs after the recalculation before publishing");
    }
}

/// A PUSH RECALCULATES A MANUAL WORKBOOK INSTEAD OF REFUSING IT -- Excel's
/// "Recalculate workbook before saving" (on by default) [LIVE: Excel 16,
/// manual calculation, A1 edited under `B1 = A1*2`: xlPending with B1 = 2;
/// SaveAs: B1 = 10 and xlDone]. Round 10 refused the publish ("Press F9"),
/// blocking every manual-mode author.
///
/// SABOTAGE: make `recalculate_before_publish` return the round-10 refusal
/// when the state is pending -- the `expect` fails.
#[test]
fn a_publish_recalculates_an_incomplete_manual_calculation_first() {
    let wb = manual_workbook_with_a_dependent();
    // Nothing pending: the push does not run a pass at all.
    crate::calp_commands::recalculate_before_publish(
        None, &wb.state, &wb.file, wb.file.document_epoch(), &wb.files, &wb.pivots, &wb.pane, &wb.filters,
    )
    .expect("a complete calculation publishes as it is");

    wb.set(0, 0, "5");
    assert_eq!(state_of(&wb), "pending", "the premise: the manual edit left B1 stale");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(2.0));
    crate::calp_commands::recalculate_before_publish(
        None, &wb.state, &wb.file, wb.file.document_epoch(), &wb.files, &wb.pivots, &wb.pane, &wb.filters,
    )
    .expect("the push recalculates an incomplete manual calculation instead of refusing it");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(10.0), "the package carries the recalculated answer");
    assert_eq!(state_of(&wb), "done", "the push leaves the workbook calculated, as Excel's save does");
}

/// rev13A (MAJOR): `calp_publish` is `(async)`, so under manual calculation an
/// edit can land after the recalculation before publishing and before the
/// carrier is assembled. The carrier then held the edited precedent beside a
/// dependent calculated before it -- A1 = 7 with B1 = 10 -- and every
/// subscriber received it looking calculated. The carrier's own
/// `calculation_incomplete` (read under its snapshot hold) now refuses it.
///
/// SABOTAGE: make `refuse_push_on_stale_carrier` return `Ok(())` at once --
/// the `expect_err` fails.
#[test]
fn a_manual_edit_after_the_recalculation_before_publishing_refuses_the_push() {
    let wb = manual_workbook_with_a_dependent();
    wb.set(0, 0, "5");
    crate::calp_commands::recalculate_before_publish(
        None, &wb.state, &wb.file, wb.file.document_epoch(), &wb.files, &wb.pivots, &wb.pane, &wb.filters,
    )
    .expect("the push recalculates first");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(10.0));

    let assemble = |wb: &Workbook| {
        let ids = crate::calp_commands::PublishSheetIds {
            sheets: wb.state.sheet_ids.read().unwrap().clone(),
            backing: Vec::new(),
        };
        crate::calp_commands::assemble_publish_workbook(
            &wb.state,
            &crate::bi::types::BiState::new(),
            &wb.pivots,
            &crate::scripting::types::ScriptState::new(),
            &wb.slicer,
            &wb.filters,
            &wb.pane,
            &wb.files,
            &wb.timelines,
            &ids,
            "",
            "",
            &[],
            "published",
        )
        .expect("the carrier assembles")
    };
    // Positive control: nothing landed in between, the carrier ships.
    let carrier = assemble(&wb);
    crate::calp_commands::refuse_push_on_stale_carrier(&carrier.assembly.workbook)
        .expect("a carrier assembled right after the recalculation ships");

    // The edit the (async) push did not wait for.
    wb.set(0, 0, "7");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(10.0), "the premise: B1 is stale against A1 = 7");
    let carrier = assemble(&wb);
    let refused = crate::calp_commands::refuse_push_on_stale_carrier(&carrier.assembly.workbook)
        .expect_err("a carrier with B1 = 10 beside A1 = 7 shipped as calculated");
    assert!(refused.contains("Nothing was published"), "{refused}");
    assert!(refused.contains("edited while it was being published"), "{refused}");
}

/// calpref2 (pubepoch residual 1): `calp_publish` is `(async)` and reads the
/// document epoch at entry; a File > Open / New that landed before its
/// recalculation before publishing let that pass run over the NEWLY opened
/// workbook -- under manual calculation, changing B's stale values for a push
/// B never made (the push was then refused, but B had been recalculated). The
/// pass now runs pinned to the push's epoch and refuses, with nothing
/// recalculated, once it moved.
///
/// SABOTAGE: make `FileState::with_document_pinned` run its work whatever the
/// epoch -- B1 is recalculated to 10.
#[test]
fn a_push_whose_workbook_was_replaced_recalculates_nothing() {
    let wb = manual_workbook_with_a_dependent();
    wb.set(0, 0, "5");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(2.0), "the premise: B1 is stale");
    // The push read its epoch; then File > Open replaced the workbook (here the
    // same stores stand in for B: what matters is that no pass runs over them).
    let epoch = wb.file.document_epoch();
    wb.file.note_document_replaced();
    let refused = crate::calp_commands::recalculate_before_publish(
        None, &wb.state, &wb.file, epoch, &wb.files, &wb.pivots, &wb.pane, &wb.filters,
    )
    .expect_err("the push recalculated a workbook opened after it started");
    assert!(refused.starts_with("CALP_PUSH_DOCUMENT_REPLACED"), "{refused}");
    assert!(refused.contains("Nothing was published"), "{refused}");
    assert_eq!(
        wb.value(0, 0, 1),
        CellValue::Number(2.0),
        "the push's recalculation ran over the workbook opened after it started"
    );
    assert_eq!(state_of(&wb), "pending", "the opened workbook's calculation state was changed by the push");

    // Positive control: a push of the workbook on screen recalculates.
    crate::calp_commands::recalculate_before_publish(
        None, &wb.state, &wb.file, wb.file.document_epoch(), &wb.files, &wb.pivots, &wb.pane, &wb.filters,
    )
    .expect("the workbook on screen recalculates before publishing");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(10.0));
}

/// rev11A: the push PREVIEW is a dry run, so it does not recalculate -- but it
/// SAYS, while the calculation is incomplete, that the push will and that the
/// values it describes may differ. Silent before: the preview showed B1 = 2
/// for a push that ships 10. And it changes nothing.
///
/// SABOTAGE: make `incomplete_calculation_preview_warning` return `None`, or
/// drop its call from `calp_publish_preview`.
#[test]
fn the_push_preview_says_the_push_will_recalculate_an_incomplete_calculation() {
    let wb = manual_workbook_with_a_dependent();
    assert_eq!(
        crate::calp_commands::incomplete_calculation_preview_warning(&wb.state),
        None,
        "a calculated workbook needs no word"
    );
    wb.set(0, 0, "5");
    let warning = crate::calp_commands::incomplete_calculation_preview_warning(&wb.state)
        .expect("the preview said nothing of the recalculation the push will run");
    assert!(warning.contains("Publishing recalculates the workbook first"), "{warning}");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(2.0), "the preview's word recalculated nothing");
    assert_eq!(state_of(&wb), "pending");

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let calp_src = std::fs::read_to_string(root.join("src/calp_commands.rs")).unwrap();
    let at = calp_src.find("pub fn calp_publish_preview(").expect("the preview moved");
    let rest = &calp_src[at..];
    let preview: String = rest[..rest.find("\n}\n").unwrap()]
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        preview.contains("warnings.extend(incomplete_calculation_preview_warning(&state));"),
        "calp_publish_preview no longer tells the author the push will recalculate"
    );
    assert!(!preview.contains("recalculate_before_publish("), "a dry run must not recalculate");
}

/// What a script's `Calcula.getCalculationState()` answers -- run through the
/// interpreter with the host state the real run doors build
/// (`scripting::types::build_host_state`). It was a stub that said "done"
/// whatever the workbook held; Excel's VBA reads Application.CalculationState
/// = xlPending here.
fn script_calculation_state(wb: &Workbook) -> String {
    let grids = wb.state.grids.read().unwrap().clone();
    let styles = wb.state.style_registry.read().unwrap().clone();
    let names = wb.state.sheet_names.read().unwrap().clone();
    let active = *wb.state.active_sheet.read().unwrap();
    let options = script_engine::ScriptRunOptions {
        app_info: crate::scripting::types::build_app_info(&wb.state),
        host_state: crate::scripting::types::build_host_state(&wb.state, Some(&wb.file), active, None),
        ..script_engine::ScriptRunOptions::default()
    };
    let (result, _) = script_engine::ScriptEngine::run_with_options(
        "Calcula.log(Calcula.getCalculationState());",
        "calc_state_probe.js",
        grids,
        styles,
        names,
        active,
        options,
    );
    match result {
        script_engine::ScriptResult::Success { output, .. } => {
            output.last().map(|item| item.to_text()).unwrap_or_default()
        }
        other => panic!("the probe script failed: {:?}", other),
    }
}

#[test]
fn a_script_sees_the_hosts_calculation_state() {
    let wb = manual_workbook_with_a_dependent();
    assert_eq!(script_calculation_state(&wb), "done");
    wb.set(0, 0, "5");
    assert_eq!(state_of(&wb), "pending");
    assert_eq!(
        script_calculation_state(&wb),
        "pending",
        "a manual edit left =A1*2 un-recalculated and Calcula.getCalculationState() still said done"
    );
    f9(&wb);
    assert_eq!(script_calculation_state(&wb), "done", "a completed Calculate Now settles it for scripts too");
}

/// calcref (misc17's NEW-forward-manual-mark-misses-qualified-stripes): the
/// FORWARD twin of the test above. Under manual calculation a typed or pasted
/// write on Sheet2 read by Sheet1's `=SUM(Sheet2!G:G)`, `=SUM(Sheet2!9:9)` or
/// `=SUM(Sheet1:Sheet3!K20)` reported done, because
/// `note_manual_write_left_formulas_uncalculated` asks the cross-sheet
/// dependents map and `extract_references_recursive` gave none of those an
/// edge there. Excel: xlPending for G5, M9 and K20; xlDone for Sheet2!H50,
/// read only by Sheet2's own `=SUM(Sheet3!H:H)` [LIVE, round 17
/// probe-colref.ps1, COM, manual].
///
/// SABOTAGE: drop the qualified stripes from `extract_references_recursive`
/// (the G:G assertion fails); count a qualified column as the formula's own
/// (the H:H assertion fails).
#[test]
fn a_manual_write_read_by_another_sheets_column_row_or_3d_span_is_pending() {
    let wb = Workbook::new(3);
    wb.set(0, 0, "=SUM(Sheet2!G:G)"); // Sheet1!A1
    wb.set(0, 1, "=SUM(Sheet2!9:9)"); // Sheet1!B1
    wb.set(0, 2, "=SUM(Sheet1:Sheet3!K20)"); // Sheet1!C1, Sheet2 in the middle
    wb.switch_to(1);
    wb.set(0, 5, "=SUM(Sheet3!H:H)"); // Sheet2!F1 reads SHEET3's column H
    go_manual(&wb);
    f9(&wb);
    assert_eq!(state_of(&wb), "done");

    let typed = |row: u32, col: u32| {
        f9(&wb);
        assert_eq!(state_of(&wb), "done", "the premise: calculated before the write");
        wb.set(row, col, "5");
        state_of(&wb)
    };
    let pasted = |row: u32, col: u32| {
        f9(&wb);
        assert_eq!(state_of(&wb), "done", "the premise: calculated before the paste");
        batch(&wb, &[(row, col, "6")]);
        state_of(&wb)
    };
    assert_eq!(typed(49, 7), "done", "=SUM(Sheet3!H:H) on Sheet2 was taken for a reader of Sheet2's own H50");
    assert_eq!(typed(4, 6), "pending", "a manual write read by another sheet's whole column left the state done");
    assert_eq!(typed(8, 12), "pending", "a manual write read by another sheet's whole row left the state done");
    assert_eq!(typed(19, 10), "pending", "a manual write inside a 3D span (middle sheet) left the state done");
    assert_eq!(pasted(5, 6), "pending", "a manual paste read by another sheet's whole column left the state done");
    assert_eq!(pasted(49, 7), "done", "a paste on Sheet2!H50 nothing reads");
}

/// calcref: Calculate Now ORDERS a reader of another sheet's whole column or
/// of a 3D span after the formulas it reads. `build_workbook_plan` took its
/// edges from `extract_references_recursive`, which gave `=SUM(Sheet2!G:G)`
/// none on Sheet2 (and `Sheet1:Sheet3!K20` none on the middle sheet), so
/// Sheet1!A1 sorted first and summed Sheet2!G1's value from BEFORE the pass.
/// Excel's Calculate Now leaves no formula stale [LIVE, round 18, COM, manual:
/// H1 = 5, Calculate -> A1 = 10, B1 = 15].
///
/// SABOTAGE: drop the `WHOLE_LINE` expansion in `build_workbook_plan` (A1 stays 2).
#[test]
fn calculate_now_orders_another_sheets_column_and_a_3d_span_after_what_they_read() {
    let wb = Workbook::new(3);
    wb.set(0, 0, "=SUM(Sheet2!G:G)"); // Sheet1!A1
    wb.set(0, 1, "=SUM(Sheet1:Sheet3!K20)"); // Sheet1!B1
    wb.switch_to(1);
    wb.set(0, 7, "1"); // Sheet2!H1
    wb.set(0, 6, "=H1*2"); // Sheet2!G1
    wb.set(19, 10, "=H1*3"); // Sheet2!K20
    wb.switch_to(0);
    go_manual(&wb);
    wb.switch_to(1);
    wb.set(0, 7, "5"); // Sheet2!H1, left for Calculate
    wb.switch_to(0);
    f9(&wb);
    assert_eq!(wb.number(1, 0, 6), 10.0);
    assert_eq!(wb.number(0, 0, 0), 10.0, "Calculate Now summed Sheet2!G:G before it recalculated Sheet2!G1");
    assert_eq!(wb.number(0, 0, 1), 15.0, "Calculate Now read the 3D span before it recalculated Sheet2!K20");
    assert_eq!(state_of(&wb), "done");
}
