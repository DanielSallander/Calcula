//! FILENAME: app/src-tauri/src/data_table_refresh_tests.rs
//! PURPOSE: EVERY EDIT ROUTE REFRESHES THE LIVE DATA TABLES (round C, lane
//! dtrefresh, rev-dt2-1..5): structural edits, Insert / Delete Cells, a merge,
//! a Name Manager edit; the census of every command that recalculates; the
//! restore's foreign-write check; a table that reads its own body.
//!
//! A child module of `whatif_recalc_tests` (declared with `#[path]` there), so
//! it drives the real bodies through that file's `Wb` harness.

use super::Wb;
use crate::commands::structure::structure_cells::CellShift;

impl Wb {
    /// rev-dt2-1's model: A1 = 1, C10:C12 = 1 / 2 / 3, `B1 = A1*<sum>`, the
    /// formula `L1 = B1`, inputs 5 and 7 in K2:K3, and the table K1:L3 with
    /// column input A1. `sum` is what B1 multiplies A1 by.
    fn sum_model(&self, sum: &str) {
        self.set(0, 0, "1"); // A1
        self.set(9, 2, "1"); // C10
        self.set(10, 2, "2"); // C11
        self.set(11, 2, "3"); // C12
        self.set(0, 1, &format!("=A1*{}", sum)); // B1
        self.set(0, 11, "=B1"); // L1
        self.set(1, 10, "5"); // K2
        self.set(2, 10, "7"); // K3
        let r = self.one_var((0, 10, 2, 11), (0, 0));
        assert!(r.error.is_none(), "data table: {:?}", r.error);
        assert_eq!((self.number(0, 1, 11), self.number(0, 2, 11)), (30.0, 42.0), "precondition: 5*6, 7*6");
    }

    /// The body L2:L3 as it should read for B1's sum now (A1 = 1, so B1 IS the sum).
    fn body_follows_b1(&self) -> ((f64, f64), (f64, f64)) {
        let sum = self.number(0, 0, 1);
        ((self.number(0, 1, 11), self.number(0, 2, 11)), (5.0 * sum, 7.0 * sum))
    }
}

/// rev-dt2-1 (MAJOR). Excel [LIVE, Excel 16 over COM, 2026-11-05,
/// dtrefresh/probe1.ps1, automatic calculation]: A1 = 1, C10:C12 = 1 / 2 / 3,
/// `B1 = A1*SUM(C10:C12)`, `L1 = B1`, K2 = 5, K3 = 7, the table K1:L3 with
/// column input A1 (body 30 / 42): deleting row 11 turns B1 into
/// `=A1*SUM(C10:C11)` = 4 and the body into 20 / 28, xlDone. Calcula kept 30 / 42:
/// Delete Rows (like Insert Rows / Columns, Delete Columns, Insert / Delete
/// Cells, a merge, Remove Duplicates, Consolidate, a Name Manager edit and a
/// control's value) recalculated the model and never refreshed the table.
///
/// SABOTAGE: delete the refresh from `delete_rows_impl` -- fails at "STALE
/// AFTER DELETE ROWS"; from `shift_cells_impl` -- fails at "STALE AFTER DELETE
/// CELLS".
#[test]
fn a_structural_edit_refreshes_the_live_data_tables() {
    let wb = Wb::new();
    wb.sum_model("SUM(C10:C12)");
    wb.delete_rows(10, 1).expect("delete row 11");
    assert_eq!(wb.number(0, 0, 1), 4.0, "B1 = A1*SUM(C10:C11) after the delete (Excel: 4)");
    assert_eq!((wb.number(0, 1, 11), wb.number(0, 2, 11)), (20.0, 28.0), "STALE AFTER DELETE ROWS: Excel shows 20 / 28");
    assert_eq!(wb.number(0, 0, 0), 1.0, "the input cell A1 is put back");

    // Delete Cells, shift up, on C10 (Excel [LIVE]: the sum's range shrinks
    // with it and the body follows the new sum).
    wb.shift_cells(9, 2, 9, 2, CellShift::Up).expect("delete C10, shift up");
    let (body, expected) = wb.body_follows_b1();
    assert_ne!(wb.number(0, 0, 1), 4.0, "precondition: the delete changed B1");
    assert_eq!(body, expected, "STALE AFTER DELETE CELLS: the body did not follow B1");
}

/// rev-dt2-1: a merge that empties a cell the model reads, and a Name Manager
/// edit that repoints the name the model reads, refresh the table as any edit
/// does (Excel recalculates a data table with the workbook).
///
/// SABOTAGE: delete the refresh from `merge_cells_core` -- fails at "STALE
/// AFTER MERGE"; from `update_named_range_core` -- fails at "STALE AFTER NAME
/// EDIT".
#[test]
fn a_merge_and_a_name_edit_refresh_the_live_data_tables() {
    let wb = Wb::new();
    wb.sum_model("SUM(C10:C12)");
    let merged = crate::merge_commands::merge_cells_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, 9, 2, 10, 2, None, None,
    )
    .expect("merge C10:C11");
    assert!(merged.success, "merge C10:C11");
    let (body, expected) = wb.body_follows_b1();
    assert_eq!(wb.number(0, 0, 1), 4.0, "precondition: the merge kept C10's 1 and dropped C11's 2");
    assert_eq!(body, expected, "STALE AFTER MERGE");

    let wb = Wb::new();
    let created = crate::named_ranges::create_named_range_impl(
        &wb.state,
        &wb.file,
        "Vals".to_string(),
        None,
        "=Sheet1!$C$10:$C$12".to_string(),
        None,
        None,
    );
    assert!(created.success, "create Vals: {:?}", created.error);
    wb.sum_model("SUM(Vals)");
    let edited = crate::named_ranges::update_named_range_core(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        "Vals".to_string(),
        None,
        "=Sheet1!$C$10:$C$11".to_string(),
        None,
        None,
    );
    assert!(edited.success, "repoint Vals: {:?}", edited.error);
    assert_eq!(wb.number(0, 0, 1), 3.0, "precondition: B1 reads the repointed name");
    assert_eq!((wb.number(0, 1, 11), wb.number(0, 2, 11)), (15.0, 21.0), "STALE AFTER NAME EDIT");
}

/// rev-dt2-4 and rev-dt2-5. Excel [LIVE, Excel 16 over COM, 2026-11-05,
/// dtrefresh/probe3.ps1, automatic calculation]: three tables -- E1:F3 (input
/// D1, `F1 = L2*D1`), H1:I4 (input G1, `I1 = G1*2+I4+Z1`, which reads its OWN
/// body), K1:L3 (input A1, `L1 = B1`, `B1 = A1*2+Z1`). Made: L2:L3 = 10 / 14,
/// I2:I4 = 10 / 14 / 18. Z1 = 1: L2:L3 = 11 / 15 and I2:I4 = 29 / 33 / 37 --
/// the self-reading table computed ONCE from its previous values (5*2+18+1),
/// no circular-reference warning, xlDone. Calcula recomputed every table in
/// every round, so with three tables the self-reading one stepped twice.
///
/// SABOTAGE: drop the "never for its own body" condition (`ch.table != i`) in
/// `refresh_live_tables_held` -- fails at "STEPPED"; recompute every table in
/// round 1 whatever it reads (the filter answers `true`) -- fails at "STEPPED".
#[test]
fn a_table_that_reads_its_own_body_is_computed_once_per_refresh() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2+Z1"); // B1
    wb.set(1, 10, "5"); // K2
    wb.set(2, 10, "7"); // K3
    wb.set(0, 11, "=B1"); // L1
    assert!(wb.one_var((0, 10, 2, 11), (0, 0)).error.is_none(), "K1:L3");
    wb.set(0, 3, "1"); // D1
    wb.set(1, 4, "1"); // E2
    wb.set(2, 4, "2"); // E3
    wb.set(0, 5, "=L2*D1"); // F1
    assert!(wb.one_var((0, 4, 2, 5), (0, 3)).error.is_none(), "E1:F3");
    wb.set(0, 6, "1"); // G1
    wb.set(1, 7, "5"); // H2
    wb.set(2, 7, "7"); // H3
    wb.set(3, 7, "9"); // H4
    wb.set(0, 8, "=G1*2+I4+Z1"); // I1
    assert!(wb.one_var((0, 7, 3, 8), (0, 6)).error.is_none(), "H1:I4");
    assert_eq!(
        (wb.number(0, 1, 8), wb.number(0, 2, 8), wb.number(0, 3, 8)),
        (10.0, 14.0, 18.0),
        "precondition: made from an empty I4 (Excel: 10 / 14 / 18)"
    );
    assert_eq!((wb.number(0, 1, 11), wb.number(0, 2, 11)), (10.0, 14.0), "precondition");

    wb.edit(0, 25, "1").expect("Z1 = 1");
    assert_eq!((wb.number(0, 1, 11), wb.number(0, 2, 11)), (11.0, 15.0), "K1:L3 follows Z1 (Excel: 11 / 15)");
    assert_eq!(
        (wb.number(0, 1, 8), wb.number(0, 2, 8), wb.number(0, 3, 8)),
        (29.0, 33.0, 37.0),
        "STEPPED more than once: Excel computes a self-reading table once per recalculation (29 / 33 / 37)"
    );
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "done", "no circular or pending mark (Excel xlDone)");
}

/// rev-dt2-3: an entry typed into an input cell between two trials of a
/// refresh (the trials drop every lock between them) is neither overwritten by
/// the next trial nor taken back by the restore; the table is left for a later
/// calculation, and the workbook says so. Calcula's next trial wrote over the
/// entry, and the restore -- seeing the last trial's value -- then put the
/// original back: the entry was gone while its undo step stayed.
///
/// SABOTAGE: make the foreign-write check in `compute_body` answer `false` --
/// fails at "OVERWROTE THE ENTRY".
#[test]
fn an_entry_typed_into_an_input_cell_during_a_refresh_is_kept() {
    let wb = Wb::new();
    assert!(wb.one_var_k1_l3().error.is_none()); // A1 = 1, body 10 / 14
    crate::data_tables::ENTRY_AFTER_TRIAL_FOR_TEST.with(|h| h.set(Some((0, (0, 0), 42.0))));
    wb.edit(1, 10, "6").expect("K2 = 6");
    crate::data_tables::ENTRY_AFTER_TRIAL_FOR_TEST.with(|h| h.set(None));
    assert_eq!(wb.number(0, 0, 0), 42.0, "OVERWROTE THE ENTRY typed into A1 between two trials");
    assert_eq!(
        crate::calculation::calculation_state_impl(&wb.state),
        "pending",
        "a table its refresh left uncalculated leaves the workbook pending"
    );
    // The next refresh computes the table from the entry: 42 is what A1 holds,
    // and the trials put it back.
    wb.edit(2, 10, "7").expect("K3 = 7 again");
    assert_eq!((wb.number(0, 1, 11), wb.number(0, 2, 11)), (12.0, 14.0), "the table follows once nothing races it");
    assert_eq!(wb.number(0, 0, 0), 42.0, "the entry is put back after the trials");
}

/// The restore compares the WHOLE cell, not its value: an input cell that now
/// holds the last trial's number as a FORMULA (or with another format) was
/// written by someone else and is left alone; one no trial wrote is not
/// "restored" over whatever it holds (rev-dt2-3).
///
/// SABOTAGE: make `cells_to_restore` restore a cell no trial wrote -- fails at
/// "RESTORED UNWRITTEN".
#[test]
fn the_restore_takes_back_only_cells_a_trial_wrote() {
    let originals = vec![
        ((0, 0), Some(engine::Cell::new_number(1.0))),
        ((0, 3), Some(engine::Cell::new_number(2.0))),
    ];
    // Only A1 was written (the trials stopped before D1).
    let last = vec![((0, 0), (engine::CellValue::Number(7.0), 0usize))];
    let kept = crate::data_tables::cells_to_restore(originals.clone(), &last, |_| (engine::CellValue::Number(7.0), 0usize));
    assert_eq!(kept.iter().map(|(p, _)| *p).collect::<Vec<_>>(), vec![(0, 0)], "RESTORED UNWRITTEN: D1 holds what it held");
    // A1 holds 7 with another style: someone else's.
    let kept = crate::data_tables::cells_to_restore(originals, &last, |_| (engine::CellValue::Number(7.0), 3usize));
    assert!(kept.is_empty(), "a cell holding the trial's value with another format is someone else's");
}

// ---------------------------------------------------------------------------
// NEW-dt-refresh-root: every shared recalculation refreshes the live tables
// ---------------------------------------------------------------------------
//
// Excel [LIVE, Excel 16 over COM, 2026-11-05, dtroot/probe1.ps1, automatic
// calculation]: A1 = 1, C10:C12 = 1 / 2 / 3, `B1 = A1*SUBTOTAL(109,C10:C12)`,
// `L1 = B1`, K2 = 5, K3 = 7, the table K1:L3 with column input A1 (body 30 /
// 42). `Rows(11).Hidden`, an AutoFilter hiding row 11, an outline collapsed
// over it and `Range("C11").ClearContents` each gave B1 = 4 and the body 20 /
// 28, xlDone; unhiding gave 30 / 42 back. Under MANUAL calculation, after
// Calculate, the AutoFilter left B1 = 6 and the body 30 / 42 with xlPending,
// and F9 gave 20 / 28, xlDone.

impl Wb {
    /// `set_rows_hidden` as the command runs it: the hide, then the
    /// visibility recalculation its tail runs (`recalc_visibility_after_row_change`).
    fn hide_rows(&self, rows: &[u32], hidden: bool) {
        crate::commands::dimensions::set_rows_hidden_inner(&self.state, &self.file, rows, hidden).expect("hide rows");
        crate::calculation::recalc_visibility_dependents_core(
            &self.state,
            &self.files,
            &self.pivots,
            Some((&self.pane, &self.filters)),
        )
        .expect("the visibility recalculation");
    }

    fn body(&self) -> (f64, f64) {
        (self.number(0, 1, 11), self.number(0, 2, 11))
    }
}

/// A hidden row the model's SUBTOTAL skips refreshes the table, through the
/// visibility recalculation every AutoFilter, outline and hide command ends in.
/// The table used to keep 30 / 42.
///
/// SABOTAGE: delete `refresh_after_recalc` from
/// `recalc_visibility_dependents_core` -- fails at "STALE AFTER HIDING".
#[test]
fn a_hidden_row_the_model_reads_refreshes_the_live_data_tables() {
    let wb = Wb::new();
    wb.sum_model("SUBTOTAL(109,C10:C12)");
    wb.hide_rows(&[10], true);
    assert_eq!(wb.number(0, 0, 1), 4.0, "precondition: B1's SUBTOTAL skips the hidden C11 (Excel: 4)");
    assert_eq!(wb.body(), (20.0, 28.0), "STALE AFTER HIDING row 11: Excel shows 20 / 28");
    assert_eq!(wb.number(0, 0, 0), 1.0, "the input cell A1 is put back");
    wb.hide_rows(&[10], false);
    assert_eq!(wb.body(), (30.0, 42.0), "unhidden: Excel shows 30 / 42 again");
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "done", "Excel xlDone");
}

/// Clearing a cell the model reads (the Delete key's `clear_cell`, through the
/// shared active-sheet cascade) refreshes the table; so does clearing one of
/// the table's own input values.
///
/// SABOTAGE: delete `refresh_after_recalc` from
/// `recalc_after_active_sheet_bulk_rewrite` -- fails at "STALE AFTER CLEAR".
#[test]
fn a_clear_refreshes_the_live_data_tables() {
    let wb = Wb::new();
    wb.sum_model("SUM(C10:C12)");
    crate::commands::data::clear_cell_core(&wb.state, &wb.file, &wb.files, &wb.pane, &wb.filters, 10, 2)
        .expect("clear C11");
    assert_eq!(wb.number(0, 0, 1), 4.0, "precondition: B1 = A1*SUM(C10:C12) without C11 (Excel: 4)");
    assert_eq!(wb.body(), (20.0, 28.0), "STALE AFTER CLEAR of C11: Excel shows 20 / 28");
    // An input value of the table itself: no formula reads K2, and the body
    // still follows it (A1 empty -> B1 = 0).
    crate::commands::data::clear_cell_core(&wb.state, &wb.file, &wb.files, &wb.pane, &wb.filters, 1, 10)
        .expect("clear K2");
    assert_eq!(wb.number(0, 1, 11), 0.0, "STALE AFTER CLEAR of the input value K2");
    assert_eq!(wb.number(0, 2, 11), 28.0, "K3's row is unchanged");
}

/// A script's bulk off-sheet write and every pivot, slicer, BI and writeback
/// command recalculate through `recalc_after_off_sheet_write`; the table
/// follows a model that reads the sheet written.
///
/// SABOTAGE: delete `refresh_after_recalc` from `recalc_after_off_sheet_write`
/// -- fails at "STALE AFTER AN OFF-SHEET WRITE".
#[test]
fn an_off_sheet_write_refreshes_the_live_data_tables() {
    let wb = Wb::new();
    wb.set_on(1, 0, 2, "6"); // Sheet2!C1
    wb.sum_model("Sheet2!C1");
    // The script host's bulk write: the cell stored with no recalculation,
    // then ONE recalculation of the sheets written
    // (`recalculate_sheets_after_script_write`).
    crate::commands::data::update_cell_on_sheets_as(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        vec![1],
        0,
        2,
        "2".to_string(),
        None,
        Some(false),
        None,
        false,
    )
    .expect("the script's write to Sheet2!C1");
    crate::commands::data::recalc_after_off_sheet_write(&wb.state, &wb.files, &wb.pivots, &wb.pane, &wb.filters, &[1]);
    assert_eq!(wb.number(0, 0, 1), 2.0, "precondition: B1 = A1*Sheet2!C1 reads the write");
    assert_eq!(wb.body(), (10.0, 14.0), "STALE AFTER AN OFF-SHEET WRITE: the body must read 5*2 / 7*2");
}

/// MANUAL CALCULATION: a recalculation never refreshes a table (F9 does), and
/// the workbook says the body may be stale [LIVE, probe1: the AutoFilter under
/// manual left 30 / 42 with xlPending; F9 gave 20 / 28, xlDone].
///
/// SABOTAGE: delete the `note_stored_values_may_be_stale` of
/// `refresh_after_recalc`'s manual branch -- fails at "NOT PENDING".
#[test]
fn under_manual_calculation_a_recalculation_leaves_the_table_pending() {
    let wb = Wb::new();
    wb.sum_model("SUBTOTAL(109,C10:C12)");
    wb.manual();
    wb.f9();
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "done", "precondition: calculated");
    wb.hide_rows(&[10], true);
    assert_eq!(wb.body(), (30.0, 42.0), "under manual the body waits for F9 (Excel: 30 / 42)");
    assert_eq!(
        crate::calculation::calculation_state_impl(&wb.state),
        "pending",
        "NOT PENDING: a body that may be stale must keep a save from vouching for it (Excel xlPending)"
    );
    wb.f9();
    assert_eq!(wb.body(), (20.0, 28.0), "F9 refreshes it (Excel: 20 / 28)");
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "done");
}

/// A WHAT-IF WRITE never refreshes from inside: the Data Table command's own
/// trials, a Goal Seek's and an animation frame's recalculate through the
/// shared entry points, which now refresh -- and a refresh there would find the
/// single-flight (or the animation's buffer) taken and mark the workbook
/// pending, or, for an animation, persist a transient frame's tables.
///
/// SABOTAGE: delete `begin_what_if_write` from
/// `whatif_recalc::write_cells_and_recalc_on` -- fails at "PENDING AFTER".
#[test]
fn a_what_if_write_does_not_refresh_from_inside() {
    let wb = Wb::new();
    wb.sum_model("SUM(C10:C12)");
    assert_eq!(
        crate::calculation::calculation_state_impl(&wb.state),
        "done",
        "PENDING AFTER the table's own computation: its trials refreshed from inside"
    );
    // Goal Seek: B1 = A1*6 to 12 by A1.
    let r = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), super::seek((0, 1), 12.0, (0, 0)));
    assert!(r.found_solution, "goal seek: {:?}", r.error);
    assert_eq!(
        crate::calculation::calculation_state_impl(&wb.state),
        "done",
        "PENDING AFTER a Goal Seek: its trials refreshed from inside"
    );
    assert_eq!(wb.body(), (30.0, 42.0), "the table substitutes A1 itself: unchanged by the seek");

    // An animation frame driving C10 (the model reads it): transient, so the
    // table is left alone and nothing is marked or dirtied.
    let snap = crate::animation_commands::anim_snapshot_inner(
        &wb.state,
        crate::api_types::AnimSnapshotParams { token: "run".to_string(), sheet_index: 0, cells: vec![(9, 2)] },
    );
    assert!(snap.success, "snapshot: {:?}", snap.error);
    crate::document_effect::mark_saved(&wb.file);
    let frame = crate::animation_commands::anim_apply_frame_inner(
        &wb.state,
        &wb.states(),
        crate::api_types::AnimApplyFrameParams {
            token: "run".to_string(),
            sheet_index: 0,
            writes: vec![crate::api_types::TransientCellWrite { row: 9, col: 2, value: "11".to_string() }],
        },
    );
    assert!(frame.error.is_none(), "frame: {:?}", frame.error);
    assert_eq!(wb.body(), (30.0, 42.0), "a transient frame does not refresh the table");
    assert_eq!(
        crate::calculation::calculation_state_impl(&wb.state),
        "done",
        "PENDING AFTER an animation frame: it refreshed from inside"
    );
    assert!(!wb.file.is_dirty(), "a frame is transient");
    let back = crate::animation_commands::anim_restore_inner(
        &wb.state,
        &wb.states(),
        crate::api_types::AnimRestoreParams { token: "run".to_string(), sheet_index: 0 },
    );
    assert!(back.error.is_none(), "restore: {:?}", back.error);
    assert_eq!(wb.body(), (30.0, 42.0), "after Stop the table is as it was");
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "done");
}

// ---------------------------------------------------------------------------
// The census of every command that recalculates (rev-dt2-1)
// ---------------------------------------------------------------------------

/// Blank comments and the contents of string and char literals, keeping every
/// byte position, so a brace or a name inside one is invisible.
fn scrub(src: &str) -> Vec<u8> {
    let s = src.as_bytes();
    let n = s.len();
    let mut o = s.to_vec();
    fn blank(o: &mut [u8], a: usize, b: usize) {
        let b = b.min(o.len());
        for byte in o.iter_mut().take(b).skip(a) {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    }
    let ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut i = 0;
    while i < n {
        let c = s[i];
        let d = if i + 1 < n { s[i + 1] } else { 0 };
        if c == b'/' && d == b'/' {
            let end = s[i..].iter().position(|&b| b == b'\n').map_or(n, |p| i + p);
            blank(&mut o, i, end);
            i = end;
            continue;
        }
        if c == b'/' && d == b'*' {
            let start = i;
            let mut depth = 0usize;
            while i < n {
                if s[i] == b'/' && i + 1 < n && s[i + 1] == b'*' {
                    depth += 1;
                    i += 2;
                } else if s[i] == b'*' && i + 1 < n && s[i + 1] == b'/' {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            blank(&mut o, start, i);
            continue;
        }
        if c == b'r' && (d == b'"' || d == b'#') && (i == 0 || !ident(s[i - 1])) {
            let mut j = i + 1;
            let mut hashes = 0;
            while j < n && s[j] == b'#' {
                hashes += 1;
                j += 1;
            }
            if j < n && s[j] == b'"' {
                let mut k = j + 1;
                while k < n && !(s[k] == b'"' && s[k + 1..].iter().take(hashes).filter(|&&b| b == b'#').count() == hashes) {
                    k += 1;
                }
                blank(&mut o, j + 1, k);
                i = k + 1 + hashes;
                continue;
            }
        }
        if c == b'"' {
            let mut k = i + 1;
            while k < n && s[k] != b'"' {
                k += if s[k] == b'\\' { 2 } else { 1 };
            }
            blank(&mut o, i + 1, k);
            i = k + 1;
            continue;
        }
        if c == b'\'' {
            if d == b'\\' {
                if let Some(p) = s[i + 2..].iter().position(|&b| b == b'\'') {
                    blank(&mut o, i + 1, i + 2 + p);
                    i = i + 3 + p;
                    continue;
                }
            } else if i + 2 < n && s[i + 2] == b'\'' {
                blank(&mut o, i + 1, i + 2);
                i += 3;
                continue;
            } else if d >= 0x80 {
                if let Some(p) = s[i + 1..(i + 6).min(n)].iter().position(|&b| b == b'\'') {
                    blank(&mut o, i + 1, i + 1 + p);
                    i = i + 2 + p;
                    continue;
                }
            }
        }
        i += 1;
    }
    o
}

/// The index just past the bracket that closes the one at `open`.
fn close_of(s: &[u8], open: usize, l: u8, r: u8) -> Option<usize> {
    let mut depth = 0usize;
    for (k, &b) in s.iter().enumerate().skip(open) {
        if b == l {
            depth += 1;
        } else if b == r {
            depth -= 1;
            if depth == 0 {
                return Some(k + 1);
            }
        }
    }
    None
}

/// Blank every `#[cfg(test)] mod name { .. }` block: a test fixture is not a route.
fn strip_test_modules(s: &mut [u8]) {
    let pat = b"#[cfg(test)]";
    let mut i = 0;
    while let Some(p) = s[i..].windows(pat.len()).position(|w| w == pat) {
        let at = i + p;
        let mut k = at + pat.len();
        loop {
            while k < s.len() && s[k].is_ascii_whitespace() {
                k += 1;
            }
            if k < s.len() && s[k] == b'#' {
                match s[k..].iter().position(|&b| b == b']') {
                    Some(q) => k += q + 1,
                    None => break,
                }
            } else {
                break;
            }
        }
        let rest = &s[k..];
        let after_pub = if rest.starts_with(b"pub ") { 4 } else { 0 };
        if rest[after_pub..].starts_with(b"mod ") {
            if let Some(brace) = s[k..].iter().position(|&b| b == b'{' || b == b';') {
                if s[k + brace] == b'{' {
                    if let Some(end) = close_of(s, k + brace, b'{', b'}') {
                        for byte in &mut s[at..end] {
                            if *byte != b'\n' {
                                *byte = b' ';
                            }
                        }
                        i = end;
                        continue;
                    }
                }
            }
        }
        i = at + pat.len();
    }
}

struct Def {
    command: bool,
    calls: Vec<String>,
}

/// Every `fn` with a body in `s`, by name: whether it is a `#[tauri::command]`
/// and the names it calls (`name(` / `path::name(`, never a method call `.name(`
/// or a macro `name!(`).
fn defs_in(s: &[u8], out: &mut Vec<(String, Def)>) {
    let ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut i = 0;
    while i + 3 < s.len() {
        if !(s[i] == b'f' && s[i + 1] == b'n' && s[i + 2] == b' ' && (i == 0 || !ident(s[i - 1]))) {
            i += 1;
            continue;
        }
        let mut k = i + 3;
        let start = k;
        while k < s.len() && ident(s[k]) {
            k += 1;
        }
        let name = String::from_utf8_lossy(&s[start..k]).to_string();
        let fn_at = i;
        i = k;
        if name.is_empty() {
            continue;
        }
        if s.get(k) == Some(&b'<') {
            let mut depth = 0usize;
            while k < s.len() {
                match s[k] {
                    b'<' => depth += 1,
                    b'>' if s[k - 1] != b'-' => {
                        depth -= 1;
                        if depth == 0 {
                            k += 1;
                            break;
                        }
                    }
                    _ => {}
                }
                k += 1;
            }
        }
        let Some(open) = s[k..].iter().position(|&b| b == b'(').map(|p| k + p) else { continue };
        let Some(after) = close_of(s, open, b'(', b')') else { continue };
        let Some(body_at) = s[after..].iter().position(|&b| b == b'{' || b == b';').map(|p| after + p) else { continue };
        if s[body_at] == b';' {
            continue;
        }
        let Some(end) = close_of(s, body_at, b'{', b'}') else { continue };
        let window_start = fn_at.saturating_sub(800);
        let before = &s[window_start..fn_at];
        let attrs_from = before.iter().rposition(|&b| b == b'}' || b == b';').map_or(0, |p| p + 1);
        let attrs = String::from_utf8_lossy(&before[attrs_from..]);
        let command = attrs.contains("#[tauri::command");
        let body = &s[body_at..end];
        let mut calls = Vec::new();
        let mut j = 0;
        while j < body.len() {
            if ident(body[j]) && (j == 0 || !ident(body[j - 1])) && !body[j].is_ascii_digit() {
                let a = j;
                while j < body.len() && ident(body[j]) {
                    j += 1;
                }
                let mut m = j;
                while m < body.len() && body[m] == b' ' {
                    m += 1;
                }
                if body.get(m) == Some(&b'(') {
                    let mut p = a;
                    while p > 0 && body[p - 1] == b' ' {
                        p -= 1;
                    }
                    let method = p > 0 && body[p - 1] == b'.';
                    let defines = p >= 3 && &body[p - 3..p] == b"fn ";
                    if !method && !defines {
                        calls.push(String::from_utf8_lossy(&body[a..j]).to_string());
                    }
                }
                continue;
            }
            j += 1;
        }
        out.push((name, Def { command, calls }));
    }
}

/// Every `.rs` file under `dir` that is not a test file.
fn product_sources(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        if path.is_dir() {
            product_sources(&path, out);
        } else if name.ends_with(".rs") && !name.ends_with("_tests.rs") && name != "tests.rs" {
            out.push(path);
        }
    }
}

/// The shared PHASE-B recalculation entry points (CLAUDE.md, `sort_range`):
/// a command that reaches one changes what the cells read.
const RECALCULATES: &[&str] = &[
    "recalc_after_active_sheet_bulk_rewrite",
    "recalc_after_off_sheet_write",
    "cascade_cross_sheet_dependents",
    "recalc_after_name_change",
    "recalc_structural_side_effects",
    "recalc_control_dependents_core",
    "recalc_visibility_dependents_core",
];

/// The EXPLICIT data-table refreshes (an edit's tail, a calculation pass's, a
/// run's end).
const REFRESHES: &[&str] = &[
    "refresh_after_edit",
    "refresh_after_calculation_pass",
    "refresh_at_run_end",
    "refresh_live_tables",
    "refresh_live_tables_held",
];

/// The refresh at the END of a shared recalculation entry point
/// (NEW-dt-refresh-root): a command that reaches it refreshes -- unless it
/// also opens one of [`STANDS_DOWN`].
const ENTRY_POINT_REFRESH: &str = "refresh_after_recalc";

/// The entry points that end in [`ENTRY_POINT_REFRESH`] themselves. Each must
/// call it in its own body.
const REFRESHING_ENTRY_POINTS: &[(&str, &str)] = &[
    ("commands/data.rs", "recalc_after_active_sheet_bulk_rewrite"),
    ("commands/data.rs", "recalc_after_off_sheet_write"),
    ("calculation.rs", "recalc_visibility_dependents_core"),
    ("control_values.rs", "recalc_control_dependents_core"),
];

/// The entry points whose every caller refreshes at its own tail: each opens
/// `defer_refresh_to_caller` in its own body.
const DEFERRING_ENTRY_POINTS: &[(&str, &str)] =
    &[("named_ranges.rs", "recalc_after_name_change"), ("commands/structure.rs", "recalc_structural_side_effects")];

/// The scopes inside which a recalculation does NOT refresh: a what-if write
/// (its run owns the input cells) and a helper that leaves the refresh to its
/// caller's tail. A command that reaches one of these refreshes only if it
/// also reaches an explicit [`REFRESHES`] entry.
const STANDS_DOWN: &[&str] = &["begin_what_if_write", "defer_refresh_to_caller"];

/// Names too common to follow: a call to one says nothing about which
/// definition runs.
const NOT_FOLLOWED: &[&str] = &[
    "new", "default", "drop", "from", "fmt", "clone", "len", "get", "set", "is_empty", "into", "eq", "hash", "read",
    "write", "lock", "insert", "remove", "push", "iter", "next", "run", "apply", "build", "finish", "parse",
];

/// The Data Table command itself: the table's own computation, under the
/// single-flight, computing exactly the table it creates.
const DATA_TABLE: &str = "the Data Table command: it computes the table it creates, under the what-if single-flight; \
     a refresh would substitute into the input cells its own trials hold";
/// An animation frame or its restore: transient by design (CLAUDE.md rule 6),
/// never a document edit, so it refreshes nothing persisted.
const TRANSIENT: &str = "an animation frame or its restore: a transient write (CLAUDE.md rule 6) that refreshes \
     nothing persisted; Stop puts the model back, and the tables were never moved";
/// Scenario Show / Summary: they take the what-if single-flight and write the
/// changing cells as a what-if run (Summary puts them back).
const SCENARIO: &str = "a scenario run: it holds the what-if single-flight and writes its changing cells as trials \
     (Summary puts them back), so the tables are left to the next recalculation";

/// Every `#[tauri::command]` that reaches a shared recalculation but no
/// data-table refresh, with why. Kept EXACT both ways: a new command that
/// recalculates without refreshing fails the census, and so does an entry here
/// whose command now refreshes (remove it). Since NEW-dt-refresh-root the
/// shared entry points refresh themselves, so only the commands that STAND
/// DOWN are left.
const NO_REFRESH: &[(&str, &str)] = &[
    ("anim_apply_frame", TRANSIENT),
    ("anim_restore", TRANSIENT),
    ("data_table_one_var", DATA_TABLE),
    ("data_table_two_var", DATA_TABLE),
    ("scenario_show", SCENARIO),
    ("scenario_summary", SCENARIO),
];

/// rev-dt2-1: EVERY command that recalculates refreshes the live data tables
/// -- found, not listed. The command bodies are `tauri::State` functions a
/// test cannot call, so the census reads the crate's source: every
/// `#[tauri::command]` whose calls reach (by name, through the crate's own
/// functions) one of the shared recalculation entry points must also reach a
/// data-table refresh, or carry an entry in `NO_REFRESH` saying why. A new
/// route cannot be missed the way Delete Rows, Insert / Delete Cells, Remove
/// Duplicates, Merge, Consolidate, the Name Manager and a control's value were.
/// (Reaching a refresh on SOME path is what the census can see; the scenario
/// tests above pin the paths themselves.) The source is read when the test
/// RUNS, not when it is compiled: a sabotage of a product file must be live
/// while the test runs.
///
/// NEW-dt-refresh-root: the shared entry points refresh at their end
/// ([`REFRESHING_ENTRY_POINTS`]), so a command reaching one refreshes -- unless
/// it also opens a scope that stands the refresh down ([`STANDS_DOWN`]: a
/// what-if write, a helper deferring to its caller's tail), in which case it
/// must reach an explicit refresh or be listed.
///
/// SABOTAGE: a tail refresh in `remove_duplicates` is no longer there to
/// delete (round E, NEW-double-refresh: it refreshes only through the entry
/// point it recalculates through);
/// delete `refresh_after_recalc` from `recalc_visibility_dependents_core` --
/// fails at "DOES NOT END IN THE REFRESH"; delete `defer_refresh_to_caller`
/// from `recalc_after_name_change` -- fails at "NO LONGER DEFERS TO ITS
/// CALLER"; delete `begin_what_if_write` from
/// `whatif_recalc::write_cells_and_recalc_on` (the what-if commands then reach
/// the entry points' refresh with nothing standing it down) -- fails at "STALE
/// ENTRY" naming them; add an entry for a command that refreshes
/// (`fill_range`) -- fails at "STALE ENTRY".
#[test]
fn every_command_that_recalculates_refreshes_the_live_data_tables() {
    let mut files = Vec::new();
    product_sources(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    assert!(files.len() > 100, "the census read {} source files", files.len());
    let mut defs: Vec<(String, Def)> = Vec::new();
    let mut texts: std::collections::HashMap<String, Vec<(String, Def)>> = std::collections::HashMap::new();
    for file in &files {
        let text = std::fs::read_to_string(file).unwrap_or_default();
        let mut s = scrub(&text);
        strip_test_modules(&mut s);
        defs_in(&s, &mut defs);
        let rel = file
            .strip_prefix(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"))
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let mut own = Vec::new();
        defs_in(&s, &mut own);
        texts.insert(rel, own);
    }
    let mut by_name: std::collections::HashMap<&str, Vec<usize>> = std::collections::HashMap::new();
    for (i, (name, _)) in defs.iter().enumerate() {
        by_name.entry(name.as_str()).or_default().push(i);
    }
    for must in RECALCULATES.iter().chain(REFRESHES.iter()).chain(STANDS_DOWN.iter()).chain([&ENTRY_POINT_REFRESH]) {
        assert!(
            by_name.contains_key(must),
            "the census lost `{must}` (renamed?): update RECALCULATES / REFRESHES / STANDS_DOWN"
        );
    }
    // Each entry point that refreshes calls the refresh in its OWN body, and
    // each deferring one opens the deferral there.
    for (list, call, what) in [
        (REFRESHING_ENTRY_POINTS, ENTRY_POINT_REFRESH, "DOES NOT END IN THE REFRESH"),
        (DEFERRING_ENTRY_POINTS, "defer_refresh_to_caller", "NO LONGER DEFERS TO ITS CALLER"),
    ] {
        for (file, entry) in list {
            let own = texts.get(*file).unwrap_or_else(|| panic!("the census found no {file}"));
            let (_, def) = own
                .iter()
                .find(|(name, _)| name == entry)
                .unwrap_or_else(|| panic!("the census found no `{entry}` in {file}"));
            assert!(def.calls.iter().any(|c| c == call), "`{entry}` ({file}) {what}: it no longer calls `{call}`");
        }
    }
    // What each name reaches, through every definition of it, stopping at a
    // refresh: (recalculates, any refresh, an explicit refresh, stands down).
    let reach = |root: &str| -> (bool, bool, bool, bool) {
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut stack = vec![root];
        let (mut recalculates, mut refreshes, mut explicit, mut stands_down) = (false, false, false, false);
        while let Some(name) = stack.pop() {
            if !seen.insert(name) {
                continue;
            }
            if REFRESHES.contains(&name) || name == ENTRY_POINT_REFRESH {
                refreshes = true;
                explicit |= name != ENTRY_POINT_REFRESH;
                continue;
            }
            if STANDS_DOWN.contains(&name) {
                stands_down = true;
            }
            if RECALCULATES.contains(&name) {
                recalculates = true;
            }
            for &d in by_name.get(name).map(Vec::as_slice).unwrap_or(&[]) {
                for call in &defs[d].1.calls {
                    if by_name.contains_key(call.as_str()) && !NOT_FOLLOWED.contains(&call.as_str()) {
                        stack.push(call.as_str());
                    }
                }
            }
        }
        (recalculates, refreshes, explicit, stands_down)
    };
    let mut missing: Vec<String> = Vec::new();
    let mut flagged: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut commands = 0;
    for (name, def) in &defs {
        if !def.command {
            continue;
        }
        commands += 1;
        let (recalculates, refreshes, explicit, stands_down) = reach(name.as_str());
        if recalculates && (!refreshes || (stands_down && !explicit)) {
            flagged.insert(name.as_str());
            if !NO_REFRESH.iter().any(|(n, _)| n == name) {
                missing.push(name.clone());
            }
        }
    }
    assert!(commands > 700, "the census found only {commands} commands: the parse broke");
    missing.sort();
    missing.dedup();
    assert!(
        missing.is_empty(),
        "RECALCULATES BUT NEVER REFRESHES the live data tables: {missing:?} -- end the command with \
         `data_tables::refresh_after_edit(..)` once every guard is dropped, or add a NO_REFRESH entry saying why"
    );
    let stale: Vec<&str> = NO_REFRESH.iter().map(|(n, _)| *n).filter(|n| !flagged.contains(n)).collect();
    assert!(stale.is_empty(), "STALE ENTRY in NO_REFRESH (the command refreshes now, or is gone): {stale:?}");
    for (name, why) in NO_REFRESH {
        assert!(!why.trim().is_empty(), "NO_REFRESH entry {name} carries no reason");
    }
}

// ===========================================================================
// Round E (lane backende)
// ===========================================================================

/// The scrubbed body of the function `signature` opens in `src` (comments and
/// literals blanked, so only code is searched).
fn scrubbed_body(src: &str, signature: &str) -> String {
    let s = scrub(src);
    let text = String::from_utf8_lossy(&s).to_string();
    let at = text.find(signature).unwrap_or_else(|| panic!("`{signature}` not found"));
    let open = text[at..].find('{').map(|p| at + p).expect("a body");
    let end = close_of(text.as_bytes(), open, b'{', b'}').expect("the body closes");
    text[open..end].to_string()
}

/// NEW-clear-gate-toctou (CLAUDE.md, the TOCTOU rule). `clear_range` (the
/// Delete key) and `clear_range_with_options_inner` asked their data-table gate
/// -- and their sheet-protection gate, whose Locked flag lives in the grid's
/// styles -- under `read()` guards they DROPPED before taking the write guards:
/// a table made, a cell locked or a sheet protected in between let the clear
/// land on state no gate had checked. A race cannot be reproduced
/// deterministically, so the rule is pinned on the source, read when the test
/// RUNS: no grid read guard in these bodies, and every grid-reading gate after
/// the pending guards and before the effect.
///
/// SABOTAGE (backende-toctou): put `clear_range`'s data-table gate back under
/// a `state.grid.read()` scope -- fails at "TAKES state.grid.read()".
#[test]
fn the_clear_gates_are_asked_under_the_guards_the_clear_writes_through() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands/data.rs");
    let src = std::fs::read_to_string(path).expect("data.rs");
    for (signature, pending) in [
        ("pub fn clear_range(", "state.grid.lock_pending()"),
        ("pub fn clear_range_with_options_inner(", "state.grid.lock_pending()"),
        ("fn clear_range_with_options_off_sheet_at(", "state.grids.lock_pending()"),
    ] {
        let body = scrubbed_body(&src, signature);
        for forbidden in ["state.grid.read()", "state.grids.read()"] {
            assert!(!body.contains(forbidden), "`{signature}` TAKES {forbidden}: gate and write under ONE guard");
        }
        let held = body.find(pending).unwrap_or_else(|| panic!("`{signature}` takes no pending guard"));
        let effect = body.find("DocumentEffect::mutates").unwrap_or_else(|| panic!("`{signature}` builds no effect"));
        for gate in ["check_range_change(", "check_sheet_protection_range_in("] {
            let at = body.find(gate).unwrap_or_else(|| panic!("`{signature}` lost its `{gate}` gate"));
            assert!(held < at && at < effect, "`{signature}` asks `{gate}` outside the held guards");
        }
    }
    // The Delete key's protection is never the read-and-drop form.
    assert!(
        !scrubbed_body(&src, "pub fn clear_range(").contains("check_sheet_protection_range("),
        "`clear_range` asks sheet protection under guards it drops"
    );
}

/// The same gate, through the real body, on another sheet: clearing part of a
/// table's body on Sheet2 while Sheet1 is active is refused, and the whole body
/// removes the table (the gate now asked in `clear_range_with_options_off_sheet_at`).
#[test]
fn an_off_sheet_clear_of_part_of_a_data_table_is_refused_under_its_guards() {
    let wb = Wb::new();
    wb.switch_to(1);
    wb.set(0, 0, "1"); // Sheet2!A1
    wb.set(0, 1, "=A1*2"); // Sheet2!B1
    wb.set(1, 10, "5"); // Sheet2!K2
    wb.set(2, 10, "7"); // Sheet2!K3
    wb.set(0, 11, "=B1"); // Sheet2!L1
    let made = crate::data_tables::data_table_one_var_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        crate::api_types::DataTableOneVarParams {
            sheet_index: 1,
            start_row: 0,
            start_col: 10,
            end_row: 2,
            end_col: 11,
            row_input_row: None,
            row_input_col: None,
            col_input_row: Some(0),
            col_input_col: Some(0),
        },
    );
    assert!(made.error.is_none(), "a table on Sheet2: {:?}", made.error);
    wb.switch_to(0);
    let clear = |r0: u32, c0: u32, r1: u32, c1: u32| {
        crate::commands::data::clear_range_with_options_inner(
            &wb.state,
            &wb.file,
            &wb.files,
            &wb.pivots,
            &wb.pane,
            &wb.filters,
            crate::api_types::ClearRangeParams {
                start_row: r0,
                start_col: c0,
                end_row: r1,
                end_col: c1,
                apply_to: crate::api_types::ClearApplyTo::Contents,
                sheet_index: Some(1),
                target: None,
            },
        )
    };
    assert_eq!(clear(1, 11, 1, 11).err().as_deref(), Some(engine::data_table::PART_OF_DATA_TABLE));
    assert_eq!(wb.formula(1, 1, 11).as_deref(), Some("TABLE(,A1)"), "Sheet2!L2 is still the table's");
    clear(1, 11, 2, 11).expect("the whole body");
    assert_eq!(wb.formula(1, 1, 11), None, "the table is gone with its body");
}

/// NEW-manual-visibility-pending. Excel [LIVE, Excel 16 over COM, 2026-11-05,
/// dtroot/probe1.ps1 P6/P7, manual calculation]: hiding a row a SUBTOTAL reads
/// leaves the workbook xlPending until F9. Calcula's visibility recalculation
/// returned under manual WITHOUT a mark, so with no data table in the workbook
/// it said "done" and a save vouched for the stale total.
///
/// SABOTAGE (backende-vis1): delete the `note_stored_values_may_be_stale` of
/// `recalc_visibility_dependents_body`'s manual branch -- fails at "NOT PENDING".
#[test]
fn under_manual_a_hidden_row_a_subtotal_reads_leaves_the_workbook_pending() {
    let wb = Wb::new();
    wb.set(9, 2, "1"); // C10
    wb.set(10, 2, "2"); // C11
    wb.set(11, 2, "3"); // C12
    wb.set(0, 1, "=SUBTOTAL(109,C10:C12)"); // B1
    wb.manual();
    wb.f9();
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "done", "precondition: calculated");
    wb.hide_rows(&[10], true);
    assert_eq!(wb.number(0, 0, 1), 6.0, "under manual the SUBTOTAL waits for F9 (Excel: 6)");
    assert_eq!(
        crate::calculation::calculation_state_impl(&wb.state),
        "pending",
        "NOT PENDING: a hidden row a SUBTOTAL reads leaves the workbook xlPending under manual"
    );
    wb.f9();
    assert_eq!(wb.number(0, 0, 1), 4.0, "F9 skips the hidden C11 (Excel: 4)");
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "done");
}

/// The other direction. Excel [LIVE, dtroot/probe1.ps1 P7 and backende/
/// probe1.ps1 N3, manual]: hiding a row NOTHING reads stays xlDone, with a data
/// table on the sheet. Calcula marked the workbook pending whenever it held a
/// data table (`refresh_after_recalc`'s manual answer).
///
/// SABOTAGE (backende-vis2): let `recalc_visibility_dependents_core` ask the
/// refresh's manual answer again (drop its `if !automatic` return) -- fails at
/// "OVER-REPORTED".
#[test]
fn under_manual_a_hidden_row_nothing_reads_leaves_the_workbook_done_table_or_not() {
    let wb = Wb::new();
    wb.sum_model("SUM(C10:C12)");
    wb.manual();
    wb.f9();
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "done", "precondition: calculated");
    wb.hide_rows(&[19], true);
    assert_eq!(
        crate::calculation::calculation_state_impl(&wb.state),
        "done",
        "OVER-REPORTED: hiding row 20, which nothing reads, is xlDone in Excel even with a data table"
    );
    wb.hide_rows(&[10], true);
    assert_eq!(
        crate::calculation::calculation_state_impl(&wb.state),
        "done",
        "SUM ignores a hidden row: nothing reads row 11's visibility either"
    );
}

/// NEW-manual-visibility-pending, the name half. Excel [LIVE, backende/
/// probe1.ps1 N1-N3, manual calculation]: repointing a name `=SUM(Vals)` reads
/// gives xlPending (B1 keeps 6 until F9 gives 3); repointing a name nothing
/// reads stays xlDone, with a data table on the sheet. Calcula's
/// `recalc_after_name_change` returned under manual without a mark.
///
/// SABOTAGE (backende-name): delete the `note_stored_values_may_be_stale` of
/// `recalc_after_name_change`'s manual branch -- fails at "NOT PENDING".
#[test]
fn under_manual_a_name_change_is_pending_only_when_a_formula_reads_the_name() {
    let wb = Wb::new();
    for (name, refers_to) in [("Vals", "=Sheet1!$C$10:$C$12"), ("Other", "=Sheet1!$D$1")] {
        let created = crate::named_ranges::create_named_range_impl(
            &wb.state,
            &wb.file,
            name.to_string(),
            None,
            refers_to.to_string(),
            None,
            None,
        );
        assert!(created.success, "create {name}: {:?}", created.error);
    }
    wb.sum_model("SUM(Vals)");
    wb.manual();
    wb.f9();
    assert_eq!(crate::calculation::calculation_state_impl(&wb.state), "done", "precondition: calculated");
    let repoint = |name: &str, refers_to: &str| {
        let r = crate::named_ranges::update_named_range_core(
            &wb.state,
            &wb.file,
            &wb.files,
            &wb.pivots,
            &wb.pane,
            &wb.filters,
            name.to_string(),
            None,
            refers_to.to_string(),
            None,
            None,
        );
        assert!(r.success, "repoint {name}: {:?}", r.error);
    };
    repoint("Other", "=Sheet1!$D$2");
    assert_eq!(
        crate::calculation::calculation_state_impl(&wb.state),
        "done",
        "a name nothing reads, repointed under manual, is xlDone in Excel (table present)"
    );
    repoint("Vals", "=Sheet1!$C$10:$C$11");
    assert_eq!(wb.number(0, 0, 1), 6.0, "under manual B1 waits for F9 (Excel: 6)");
    assert_eq!(
        crate::calculation::calculation_state_impl(&wb.state),
        "pending",
        "NOT PENDING: a name a formula reads, repointed under manual, is xlPending in Excel"
    );
    wb.f9();
    assert_eq!(wb.number(0, 0, 1), 3.0, "F9 reads the repointed name (Excel: 3)");
}

/// How many data-table refreshes `run` made on this thread.
fn refreshes_during(run: impl FnOnce()) -> u32 {
    crate::data_tables::REFRESHES_FOR_TEST.with(|count| count.set(0));
    run();
    crate::data_tables::REFRESHES_FOR_TEST.with(|count| count.get())
}

/// NEW-double-refresh. A command that refreshes the live tables at its tail AND
/// recalculated through an entry point that refreshes them computed every
/// table twice (right answers, double the work). Each edit below changes what
/// the model reads, and each now refreshes ONCE.
///
/// SABOTAGE (backende-dbl): delete the `defer_refresh_to_caller` of
/// `delete_rows_impl` -- fails at "DELETE ROWS refreshed 2 times".
#[test]
fn every_edit_refreshes_the_live_data_tables_once() {
    use crate::commands::structure::structure_cells::CellShift;
    let wb = Wb::new();
    wb.sum_model("SUM(C10:C12)");
    let n = refreshes_during(|| wb.delete_rows(10, 1).expect("delete row 11"));
    assert_eq!(n, 1, "DELETE ROWS refreshed {n} times");
    assert_eq!(wb.body(), (20.0, 28.0), "and the body follows (Excel: 20 / 28)");
    let n = refreshes_during(|| wb.insert_rows(10, 1, None).expect("insert row 11"));
    assert_eq!(n, 1, "INSERT ROWS refreshed {n} times");
    wb.set(10, 2, "2"); // C11 again: SUM(C10:C12) = 1 + 2 + 2
    let n = refreshes_during(|| wb.shift_cells(9, 2, 9, 2, CellShift::Up).expect("delete C10, shift up"));
    assert_eq!(n, 1, "DELETE CELLS refreshed {n} times");
    let n = refreshes_during(|| wb.insert_cols(2, 1).expect("insert column C"));
    assert_eq!(n, 1, "INSERT COLUMNS refreshed {n} times");
    let n = refreshes_during(|| wb.delete_cols(2, 1).expect("delete column C"));
    assert_eq!(n, 1, "DELETE COLUMNS refreshed {n} times");
    let n = refreshes_during(|| {
        let merged = crate::merge_commands::merge_cells_core(
            &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, 9, 2, 10, 2, None, None,
        )
        .expect("merge C10:C11");
        assert!(merged.success, "merge C10:C11");
    });
    assert_eq!(n, 1, "MERGE refreshed {n} times");
    let (body, expected) = wb.body_follows_b1();
    assert_eq!(body, expected, "the body follows every edit");
    let n = refreshes_during(|| wb.edit(11, 2, "9").expect("C12 = 9"));
    assert_eq!(n, 1, "an EDIT refreshed {n} times");
}

/// NEW-double-refresh: the cost, measured. A 50x50 two-variable table (2,500
/// substitutions per refresh) over `B1 = A1*A2+SUM(C61:C63)`, then a row delete
/// below it that shrinks the sum. Round D's root fix made Delete Rows refresh
/// in its cascade AND at its tail: 5,000 substitutions for one gesture. Prints
/// the time and the count; the count is pinned.
#[test]
fn measure_a_row_delete_over_a_50x50_two_variable_table() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1, the row input
    wb.set(1, 0, "1"); // A2, the column input
    wb.set(60, 2, "1"); // C61
    wb.set(61, 2, "2"); // C62
    wb.set(62, 2, "3"); // C63
    wb.set(0, 1, "=A1*A2+SUM(C61:C63)"); // B1
    wb.set(0, 4, "=B1"); // E1, the corner
    for i in 0..50u32 {
        wb.set(0, 5 + i, &(i + 1).to_string()); // F1.., the row inputs
        wb.set(1 + i, 4, &(i + 1).to_string()); // E2.., the column inputs
    }
    let r = crate::data_tables::data_table_two_var_impl(
        &wb.state,
        &wb.file,
        &wb.states(),
        crate::api_types::DataTableTwoVarParams {
            sheet_index: 0,
            start_row: 0,
            start_col: 4,
            end_row: 50,
            end_col: 54,
            row_input_row: 0,
            row_input_col: 0,
            col_input_row: 1,
            col_input_col: 0,
        },
    );
    assert!(r.error.is_none(), "the 50x50 table: {:?}", r.error);
    assert_eq!(wb.number(0, 50, 54), 50.0 * 50.0 + 6.0, "precondition: BC51 = 50*50 + 6");
    let started = std::time::Instant::now();
    let n = refreshes_during(|| wb.delete_rows(61, 1).expect("delete row 62"));
    let elapsed = started.elapsed();
    println!("BACKENDE_MEASURE delete_rows over a 50x50 two-variable table: {n} refresh(es), {elapsed:?}");
    assert_eq!(wb.number(0, 50, 54), 50.0 * 50.0 + 4.0, "the body follows the shrunk sum (1 + 3)");
    assert_eq!(n, 1, "Delete Rows refreshed the 50x50 table {n} times");
}

/// NEW-double-refresh, found rather than listed: every function whose OWN body
/// ends in an explicit refresh (`refresh_after_edit` and its siblings) must not
/// also reach a REFRESHING entry point outside a deferral -- or its tables are
/// computed twice. The walk follows the crate's calls by name from that
/// function, stopping at a refresh, at an entry point that defers to its
/// caller, and at any function whose own body opens a stand-down scope
/// (`defer_refresh_to_caller`, `begin_what_if_write`); the function itself
/// passes when its own body opens one. The census cannot see the ORDER of a
/// deferral and the call it covers; the scenario test above pins that.
///
/// SABOTAGE (backende-dbl): delete the `defer_refresh_to_caller` of
/// `merge_cells_core` -- fails at "REFRESHES TWICE" naming it.
#[test]
fn no_command_refreshes_the_live_data_tables_twice() {
    /// A function whose explicit refresh and refreshing recalculation are on
    /// different branches, so it refreshes once -- with why.
    const ONE_BRANCH_EACH: &[(&str, &str)] = &[(
        "fill_range",
        "an OBJECT's fill returns from `fill_range_on_target`, whose `recalc_after_off_sheet_write` is its one \
         refresh, before the tail; the active sheet's `fill_range_core` reaches no refreshing entry point, so \
         the tail is its one",
    )];
    let mut files = Vec::new();
    product_sources(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let mut defs: Vec<(String, Def)> = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file).unwrap_or_default();
        let mut s = scrub(&text);
        strip_test_modules(&mut s);
        defs_in(&s, &mut defs);
    }
    let mut by_name: std::collections::HashMap<&str, Vec<usize>> = std::collections::HashMap::new();
    for (i, (name, _)) in defs.iter().enumerate() {
        by_name.entry(name.as_str()).or_default().push(i);
    }
    let refreshing: Vec<&str> = REFRESHING_ENTRY_POINTS.iter().map(|(_, n)| *n).collect();
    let deferring: Vec<&str> = DEFERRING_ENTRY_POINTS.iter().map(|(_, n)| *n).collect();
    let opens_stand_down = |def: &Def| def.calls.iter().any(|c| STANDS_DOWN.contains(&c.as_str()));
    let mut twice: Vec<String> = Vec::new();
    let mut flagged: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for (name, def) in &defs {
        let explicit = def.calls.iter().any(|c| REFRESHES.contains(&c.as_str()));
        if !explicit || opens_stand_down(def) || REFRESHES.contains(&name.as_str()) {
            continue;
        }
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut stack: Vec<&str> = def.calls.iter().map(String::as_str).collect();
        let mut hit: Option<&str> = None;
        while let Some(callee) = stack.pop() {
            if !seen.insert(callee) || NOT_FOLLOWED.contains(&callee) {
                continue;
            }
            if REFRESHES.contains(&callee) || callee == ENTRY_POINT_REFRESH || deferring.contains(&callee) {
                continue;
            }
            if refreshing.contains(&callee) {
                hit = Some(callee);
                break;
            }
            let Some(indices) = by_name.get(callee) else { continue };
            if indices.iter().any(|&d| opens_stand_down(&defs[d].1)) {
                continue;
            }
            for &d in indices {
                for call in &defs[d].1.calls {
                    stack.push(call.as_str());
                }
            }
        }
        if let Some(entry) = hit {
            flagged.insert(name.as_str());
            if !ONE_BRANCH_EACH.iter().any(|(n, _)| n == name) {
                twice.push(format!("{name} (through {entry})"));
            }
        }
    }
    let stale: Vec<&str> = ONE_BRANCH_EACH.iter().map(|(n, _)| *n).filter(|n| !flagged.contains(n)).collect();
    assert!(stale.is_empty(), "STALE ENTRY in ONE_BRANCH_EACH (no longer flagged): {stale:?}");
    twice.sort();
    twice.dedup();
    assert!(
        twice.is_empty(),
        "REFRESHES TWICE -- an explicit refresh at the tail and a refreshing recalculation before it: {twice:?}. \
         Open `data_tables::defer_refresh_to_caller()` around the recalculation, or drop the tail where it \
         directly follows one entry point"
    );
}

/// NEW-getpivotdata-trials. Excel [LIVE, Excel 16 over COM, 2026-11-05,
/// backende/probe1.ps1 G1/G2, automatic]: Region / Sales East 10, West 20, East
/// 30, North 40 in A1:B5, a pivot at E3 (Sum of Sales, total 100), H1 = 1,
/// `H2 = GETPIVOTDATA("Sales",$E$3)*H1`, `K1 = H2`, inputs 2 / 3 in J2:J3: the
/// table J1:K3 with column input H1 gives 200 / 300 and leaves H2 = 100; Goal
/// Seek of H2 to 500 by H1 answers H1 = 5. Calcula's trial cascade evaluated
/// with no pivot lookup: every trial's H2 was #REF!, so the body was #REF!, and
/// the restore's cascade left H2 itself #REF!.
///
/// SABOTAGE (backende-gpd): hand `bulk_rewrite_cascade`'s per-cell evaluator
/// no lookup -- fails at "TRIAL"; (backende-gpd2): let `recalc_walked_cell`
/// pass none -- fails at "WALK".
#[test]
fn a_data_table_and_goal_seek_over_getpivotdata_compute_from_the_pivot() {
    let wb = Wb::new();
    for (r, c, v) in [
        (0, 0, "Region"),
        (0, 1, "Sales"),
        (1, 0, "East"),
        (1, 1, "10"),
        (2, 0, "West"),
        (2, 1, "20"),
        (3, 0, "East"),
        (3, 1, "30"),
        (4, 0, "North"),
        (4, 1, "40"),
    ] {
        wb.set(r, c, v);
    }
    crate::pivot::commands::create_pivot_core(
        &wb.state,
        &wb.file,
        &wb.pivots,
        crate::pivot::operations::PivotRecalcStates { pane: &wb.pane, ribbon: &wb.filters, user_files: &wb.files },
        crate::pivot::types::CreatePivotRequest {
            source_range: "A1:B5".to_string(),
            destination_cell: "E3".to_string(),
            source_sheet: Some(0),
            destination_sheet: Some(0),
            has_headers: Some(true),
            name: None,
            source_table_name: None,
            canvas_frame: None,
        },
        vec!["Region".to_string()],
        vec![("Sales".to_string(), pivot_engine::AggregationType::Sum)],
    )
    .expect("a pivot at E3");
    wb.set(0, 7, "1"); // H1
    wb.set(1, 7, "=GETPIVOTDATA(\"Sum of Sales\",$E$3)*H1"); // H2
    assert_eq!(wb.value(0, 1, 7), engine::CellValue::Number(100.0), "precondition: the lookup works on entry");
    wb.set(0, 10, "=H2"); // K1
    wb.set(1, 9, "2"); // J2
    wb.set(2, 9, "3"); // J3
    let r = wb.one_var((0, 9, 2, 10), (0, 7));
    assert!(r.error.is_none(), "the table J1:K3: {:?}", r.error);
    assert_eq!(
        (wb.value(0, 1, 10), wb.value(0, 2, 10)),
        (engine::CellValue::Number(200.0), engine::CellValue::Number(300.0)),
        "TRIAL: each substitution must read the pivot (Excel: 200 / 300)"
    );
    assert_eq!(wb.value(0, 1, 7), engine::CellValue::Number(100.0), "H2 after the trials (Excel: 100)");
    let seek = crate::goal_seek::goal_seek_impl(&wb.state, &wb.file, &wb.states(), super::seek((1, 7), 500.0, (0, 7)));
    assert!(seek.found_solution, "goal seek: {:?}", seek.error);
    assert!((wb.number(0, 0, 7) - 5.0).abs() < 1e-6, "Goal Seek answers H1 = 5 (Excel)");
    assert_eq!(wb.value(0, 1, 7), engine::CellValue::Number(500.0), "H2 reads the pivot at the answer");

    // ACROSS THE WALK: Sheet2 reads the pivot through GETPIVOTDATA and H1.
    // Clearing H1 runs the shared cascade, whose cross-sheet walk reaches
    // Sheet2!A1; the pivot store is the one a running app manages (scoped here,
    // as the app's own is found through its handle).
    wb.set_on(1, 0, 0, "=GETPIVOTDATA(\"Sum of Sales\",Sheet1!$E$3)+Sheet1!H1");
    assert_eq!(wb.value(1, 0, 0), engine::CellValue::Number(105.0), "precondition: Sheet2!A1 = 100 + 5");
    crate::pivot::operations::with_cascade_pivots(&wb.pivots, || {
        crate::commands::data::clear_cell_core(&wb.state, &wb.file, &wb.files, &wb.pane, &wb.filters, 0, 7)
    })
    .expect("clear H1");
    assert_eq!(
        wb.value(1, 0, 0),
        engine::CellValue::Number(100.0),
        "WALK: the cross-sheet walk must answer GETPIVOTDATA from the pivot (100 + 0)"
    );
    assert_eq!(wb.value(0, 1, 7), engine::CellValue::Number(0.0), "H2 = 100 * 0 on the active sheet");
}

/// NEW-offsheet-paste-entry. A floating grid's paste (and any off-sheet write
/// told `pasted`) is not an ENTRY: a pasted formula the entry checks refuse --
/// a LET name declared twice, which typed stays TEXT -- is the copied cell's own
/// formula and is stored as one, as the batch stores it (round D,
/// `parse_pasted_input_invariant`). A typed write stays an entry.
///
/// SABOTAGE (backende-paste): parse `update_cell_on_sheets_as`'s value through
/// the typed ladder whatever `pasted` says -- fails at "PASTED FORMULA".
#[test]
fn an_off_sheet_paste_is_not_an_entry_and_a_typed_write_still_is() {
    let wb = Wb::new();
    let write = |col: u32, pasted: bool| {
        crate::commands::data::update_cell_on_sheets_as(
            &wb.state,
            &wb.file,
            &wb.files,
            &wb.pivots,
            &wb.pane,
            &wb.filters,
            vec![1],
            0,
            col,
            "=LET(a,1,a,2,a)".to_string(),
            Some(true),
            Some(false),
            None,
            pasted,
        )
        .expect("the write to Sheet2");
    };
    write(0, true);
    assert!(
        wb.state.grids.read().unwrap()[1].get_cell(0, 0).is_some_and(|c| c.has_formula()),
        "PASTED FORMULA stored as {:?}: a paste keeps the copied cell's formula",
        wb.value(1, 0, 0)
    );
    write(1, false);
    assert!(
        wb.state.grids.read().unwrap()[1].get_cell(0, 1).is_some_and(|c| !c.has_formula()),
        "a TYPED formula the entry checks refuse is kept as text"
    );
}

/// NEW-fill-core-merge. Excel [LIVE, Excel 16 COM, 2026-11-05,
/// pastec/probe-fill2.ps1]: FillDown of A1:B1 over A2:B3 with A2:B2 merged
/// changes NOTHING (no error); FillDown of a merged A1:B1 over a merged B2:C2
/// likewise; FillDown over a destination with no merged cell fills.
/// `fill_range_core` (Ctrl+D, the module runtime's `Calcula.fillDown`) had no
/// merge check and wrote straight through the merge.
///
/// SABOTAGE (backende-fill): make `fill_meets_foreign_merges` answer `false`
/// -- fails at "WROTE THROUGH".
#[test]
fn a_copy_fill_over_merged_cells_that_are_not_its_pattern_changes_nothing() {
    let wb = Wb::new();
    let merge = |r0: u32, c0: u32, r1: u32, c1: u32| {
        let m = crate::merge_commands::merge_cells_core(
            &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, r0, c0, r1, c1, None, None,
        )
        .expect("merge");
        assert!(m.success, "merge ({r0},{c0})..({r1},{c1})");
    };
    let fill = |source: (u32, u32, u32, u32), dest: (u32, u32, u32, u32)| {
        crate::commands::data::fill_range_core(&wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, source, dest)
            .expect("the fill")
    };
    let depth = || wb.state.undo_stack.lock().unwrap().undo_depth();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "2"); // B1
    merge(1, 0, 1, 1); // A2:B2
    crate::document_effect::mark_saved(&wb.file);
    let before = depth();
    let cells = fill((0, 0, 0, 1), (1, 0, 2, 1));
    assert!(cells.is_empty(), "WROTE THROUGH: the fill reported {} cells", cells.len());
    assert_eq!(wb.value(0, 2, 0), engine::CellValue::Empty, "WROTE THROUGH: A3 must stay empty (Excel)");
    assert_eq!(wb.value(0, 1, 0), engine::CellValue::Empty, "A2 (the merge) is untouched");
    assert!(!wb.file.is_dirty(), "a fill that changed nothing leaves the document clean");
    assert_eq!(depth(), before, "and records no undo step");

    // A merged source over a merged destination it only partly overlaps.
    let wb2 = Wb::new();
    let merge2 = |r0: u32, c0: u32, r1: u32, c1: u32| {
        let m = crate::merge_commands::merge_cells_core(
            &wb2.state, &wb2.file, &wb2.files, &wb2.pivots, &wb2.pane, &wb2.filters, r0, c0, r1, c1, None, None,
        )
        .expect("merge");
        assert!(m.success);
    };
    wb2.set(0, 0, "7");
    merge2(0, 0, 0, 1); // A1:B1
    merge2(1, 1, 1, 2); // B2:C2
    let cells = crate::commands::data::fill_range_core(
        &wb2.state, &wb2.file, &wb2.files, &wb2.pivots, &wb2.pane, &wb2.filters, (0, 0, 0, 1), (1, 0, 2, 1),
    )
    .expect("the fill");
    assert!(cells.is_empty(), "a merged band over B2:C2 changes nothing (Excel FILLDOWN2)");
    assert_eq!(wb2.value(0, 2, 0), engine::CellValue::Empty);

    // Control: no merge in the way -- the fill writes.
    let wb3 = Wb::new();
    wb3.set(0, 0, "1");
    wb3.set(0, 1, "2");
    crate::commands::data::fill_range_core(
        &wb3.state, &wb3.file, &wb3.files, &wb3.pivots, &wb3.pane, &wb3.filters, (0, 0, 0, 1), (1, 0, 2, 1),
    )
    .expect("the fill");
    assert_eq!(wb3.number(0, 2, 1), 2.0, "B3 = 2: a destination with no merged cell fills");
}

/// The merge rule itself, over the tiling `fill_range_core` uses: the band's
/// own merge repeated at every whole tile of the destination is clear; any
/// other merge, or only some of the repeats, is foreign (`fillMergeRefusal`).
#[test]
fn the_fill_merge_rule_accepts_only_the_bands_own_pattern() {
    use crate::api_types::MergedRegion;
    let m = |r0, c0, r1, c1| MergedRegion { start_row: r0, start_col: c0, end_row: r1, end_col: c1 };
    let set = |list: &[MergedRegion]| list.iter().cloned().collect::<std::collections::HashSet<_>>();
    let meets = crate::commands::data::fill_meets_foreign_merges;
    assert!(!meets(&set(&[]), (0, 0, 0, 1), (1, 0, 3, 1)), "nothing merged");
    assert!(!meets(&set(&[m(0, 0, 0, 1)]), (0, 0, 0, 1), (1, 0, 3, 1)), "a merged band, no merge below");
    assert!(
        !meets(&set(&[m(0, 0, 0, 1), m(1, 0, 1, 1), m(2, 0, 2, 1), m(3, 0, 3, 1)]), (0, 0, 0, 1), (1, 0, 3, 1)),
        "the pattern already repeated at every tile"
    );
    assert!(meets(&set(&[m(0, 0, 0, 1), m(2, 0, 2, 1)]), (0, 0, 0, 1), (1, 0, 3, 1)), "only some of the repeats");
    assert!(meets(&set(&[m(1, 0, 1, 1)]), (0, 0, 0, 1), (1, 0, 3, 1)), "a merge the plain band lacks");
    assert!(meets(&set(&[m(0, 0, 0, 1), m(1, 1, 1, 2)]), (0, 0, 0, 1), (1, 0, 3, 1)), "a partial overlap");
    assert!(!meets(&set(&[m(5, 5, 6, 6)]), (0, 0, 0, 1), (1, 0, 3, 1)), "a merge elsewhere is not in the way");
}
