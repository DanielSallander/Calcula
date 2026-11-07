//! FILENAME: app/src-tauri/src/data_table_dtable_tests.rs
//! PURPOSE: The live data table's creation is ONE undo step (BUG-0753),
//! "Automatic except for data tables" (BUG-0754), a fill over a WHOLE body
//! replaces the table (BUG-0756), Scenario Show refreshes the tables
//! (BUG-0755), and a `.calp` merge installs a version's own table through the
//! data-table door with its marker claim (BUG-0757).
//!
//! A child module of `whatif_recalc_tests` (declared with `#[path]` there), so
//! it drives the real bodies through that file's `Wb` harness. Excel facts are
//! [LIVE, Excel 16 over COM, 2026-11-06, the lane's dtable/probe*.ps1].

use super::Wb;
use crate::api_types::CellUpdateInput;
use engine::CellValue;

const PART: &str = engine::data_table::PART_OF_DATA_TABLE;

impl Wb {
    fn exists_on(&self, row: u32, col: u32) -> bool {
        self.state.grids.read().unwrap()[0].get_cell(row, col).is_some()
    }

    /// Ctrl+Z / Ctrl+Y as the commands do it, minus the Tauri handles.
    fn history(&self, undo: bool) -> crate::undo_commands::UndoResult {
        let step = {
            let mut stack = self.state.undo_stack.lock().unwrap();
            if undo { stack.pop_undo() } else { stack.pop_redo() }
        }
        .expect("a step to take");
        let slicers = crate::slicer::SlicerState::new();
        let timelines = self.timeline();
        let mut result = crate::undo_commands::apply_changes(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &slicers,
            &self.filters,
            &self.pane,
            &timelines,
            step,
            undo,
        );
        crate::data_tables::refresh_after_edit(
            &self.state,
            &self.files,
            &self.pivots,
            &self.pane,
            &self.filters,
            &mut result.updated_cells,
        );
        result
    }

    fn typed(&self, row: u32, col: u32, value: &str) -> CellUpdateInput {
        CellUpdateInput {
            row,
            col,
            value: value.to_string(),
            style_index: None,
            invariant: Some(true),
            pasted: None,
            moved: None,
            source: None,
        }
    }

    fn write_batch(&self, updates: Vec<CellUpdateInput>) -> Result<(), String> {
        let mut cells = crate::commands::data::update_cells_batch_core(
            &self.state, &self.file, &self.files, &self.pivots, updates, None, None, None, None,
        )?;
        crate::data_tables::refresh_after_edit(&self.state, &self.files, &self.pivots, &self.pane, &self.filters, &mut cells);
        Ok(())
    }

    fn fill(&self, source: (u32, u32, u32, u32), dest: (u32, u32, u32, u32)) -> Result<(), String> {
        let mut cells = crate::commands::data::fill_range_core(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters, source, dest,
        )?;
        crate::data_tables::refresh_after_edit(&self.state, &self.files, &self.pivots, &self.pane, &self.filters, &mut cells);
        Ok(())
    }

    /// A batch with the tail `update_cells_batch` runs: only the tables its
    /// cells reach follow it (BUG-0755).
    fn write_batch_reaching(&self, updates: Vec<CellUpdateInput>) -> Result<(), String> {
        let written: Vec<(usize, u32, u32)> = updates.iter().map(|u| (0, u.row, u.col)).collect();
        let mut cells = crate::commands::data::update_cells_batch_core(
            &self.state, &self.file, &self.files, &self.pivots, updates, None, None, None, None,
        )?;
        crate::data_tables::refresh_after_cell_writes(
            &self.state, &self.files, &self.pivots, &self.pane, &self.filters, &written, &mut cells,
        );
        Ok(())
    }

    fn state_now(&self) -> &'static str {
        crate::calculation::calculation_state_impl(&self.state)
    }
}

/// BUG-0753: creating a data table is ONE undo step. Ctrl+Z takes the body
/// away (the cells as they were, its reader N1 = SUM(L2:L3) back to 0), and
/// Ctrl+Y brings the live table back.
///
/// SABOTAGE: drop the `push_own_step` in `create_data_table` -- fails at
/// "NOT UNDOABLE".
#[test]
fn creating_a_data_table_is_one_undo_step_and_redo_brings_it_back() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    wb.set(1, 10, "5"); // K2
    wb.set(2, 10, "7"); // K3
    wb.set(0, 11, "=B1"); // L1
    wb.set(0, 13, "=SUM(L2:L3)"); // N1
    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();
    assert!(wb.one_var((0, 10, 2, 11), (0, 0)).error.is_none());
    let (after, top) = {
        let stack = wb.state.undo_stack.lock().unwrap();
        (stack.undo_depth(), stack.undo_description().map(str::to_string))
    };
    assert_eq!(top.as_deref(), Some(crate::data_tables::DATA_TABLE_STEP), "NOT UNDOABLE: the top step is {top:?}");
    assert_eq!(after, depth + 1, "ONE step for the table");
    assert_eq!((wb.number(0, 1, 11), wb.number(0, 0, 13)), (10.0, 24.0));

    let undone = wb.history(true);
    assert!(undone.success, "{:?}", undone.refusal);
    assert!(!wb.exists_on(1, 11) && !wb.exists_on(2, 11), "Ctrl+Z left the body");
    assert_eq!(wb.number(0, 0, 13), 0.0, "N1 reads the emptied body");
    assert_eq!(wb.number(0, 0, 0), 1.0, "the borrowed input cell is as it was");

    let redone = wb.history(false);
    assert!(redone.success, "{:?}", redone.refusal);
    assert_eq!(wb.formula(0, 1, 11).as_deref(), Some("TABLE(,A1)"), "Ctrl+Y brings the marker back");
    wb.edit(1, 10, "9").expect("K2 = 9");
    assert_eq!(wb.number(0, 1, 11), 18.0, "and the table is live");
}

/// BUG-0754, Excel [LIVE, dtable/probe2.ps1 and probe5.ps1]: under Automatic
/// except for data tables an edit leaves the body as it was and the workbook
/// pending while every other formula follows; F9 refreshes it; a table created
/// in the mode shows 0 (pending); switching to Automatic refreshes the tables,
/// switching to it from Manual leaves them for F9.
///
/// SABOTAGE: make `data_tables::automatic` ignore `calculation_except_tables`
/// -- fails at "SEMI REFRESHED".
#[test]
fn automatic_except_for_data_tables_leaves_the_tables_for_f9() {
    use crate::calculation::{calculation_mode_name, set_calculation_mode_impl, AUTOMATIC_EXCEPT_TABLES};
    let wb = Wb::new();
    assert!(wb.one_var_k1_l3().error.is_none());
    assert_eq!(wb.number(0, 1, 11), 10.0);
    set_calculation_mode_impl(&wb.state, AUTOMATIC_EXCEPT_TABLES);
    {
        let mode = wb.state.calculation_mode.lock().unwrap();
        assert_eq!(*mode, "automatic", "every other formula stays automatic");
        assert_eq!(calculation_mode_name(&wb.state, &mode), AUTOMATIC_EXCEPT_TABLES);
    }
    wb.edit(1, 10, "9").expect("K2 = 9");
    assert_eq!(wb.number(0, 1, 11), 10.0, "SEMI REFRESHED: the body followed an edit");
    assert_eq!(wb.state_now(), "pending", "the workbook says the table is uncalculated");
    wb.edit(0, 0, "3").expect("A1 = 3");
    assert_eq!(wb.number(0, 0, 1), 6.0, "an ordinary formula recalculates at once");
    wb.f9();
    assert_eq!(wb.number(0, 1, 11), 18.0, "F9 refreshes the table");
    assert_eq!(wb.state_now(), "done");

    // A table created in the mode shows 0 until F9.
    wb.set(0, 16, "=B1"); // Q1
    wb.set(1, 15, "3"); // P2
    wb.set(2, 15, "4"); // P3
    let r = wb.one_var((0, 15, 2, 16), (0, 0));
    assert!(r.error.is_none(), "{:?}", r.error);
    assert_eq!(wb.number(0, 1, 16), 0.0, "a table created in the mode shows 0");
    assert_eq!(wb.state_now(), "pending");

    // Leaving the mode for Automatic recalculates the tables.
    let applied = std::sync::atomic::AtomicU64::new(0);
    let (mode, recalc) = crate::calculation::switch_calculation_mode_in_order(&wb.state, "automatic", 1, &applied);
    assert_eq!((mode.as_str(), recalc), ("automatic", true), "leaving the mode is a recalculation");
    crate::calculation::recalculate_after_leaving_manual(None, &wb.state, &wb.files, &wb.pivots, &wb.pane, &wb.filters, None)
        .expect("the recalculation");
    assert_eq!(wb.number(0, 1, 16), 6.0, "the new table is computed (P2 = 3 -> B1 = 6)");
    assert_eq!(wb.state_now(), "done");

    // Manual -> the mode: the recalculation leaves the tables for F9.
    set_calculation_mode_impl(&wb.state, "manual");
    wb.edit(1, 10, "7").expect("K2 = 7 under manual");
    let (mode, recalc) =
        crate::calculation::switch_calculation_mode_in_order(&wb.state, AUTOMATIC_EXCEPT_TABLES, 2, &applied);
    assert_eq!((mode.as_str(), recalc), (AUTOMATIC_EXCEPT_TABLES, true));
    crate::calculation::recalculate_after_leaving_manual(None, &wb.state, &wb.files, &wb.pivots, &wb.pane, &wb.filters, None)
        .expect("the recalculation");
    assert_eq!(wb.number(0, 1, 11), 18.0, "the body waits for F9");
    assert_eq!(wb.state_now(), "pending");
    // Any other mode clears the qualifier.
    set_calculation_mode_impl(&wb.state, "manual");
    set_calculation_mode_impl(&wb.state, "automatic");
    assert!(!wb.state.calculation_except_tables.load(std::sync::atomic::Ordering::SeqCst));
}

/// BUG-0754: a save records the mode and an open adopts it -- `.cala` through
/// `Workbook::calculation_except_tables` (`calc_mode.json`).
///
/// SABOTAGE: drop the `calculation_except_tables` line from
/// `record_session_calculation_mode` -- fails at "NOT RECORDED".
#[test]
fn automatic_except_for_data_tables_is_recorded_by_a_save_and_adopted_by_an_open() {
    use crate::calculation::{set_calculation_mode_impl, AUTOMATIC_EXCEPT_TABLES};
    let wb = Wb::new();
    set_calculation_mode_impl(&wb.state, AUTOMATIC_EXCEPT_TABLES);
    let mut workbook = persistence::Workbook::new();
    crate::persistence::record_session_calculation_mode(&wb.state, &mut workbook);
    assert!(workbook.calculation_except_tables && !workbook.calculation_manual, "NOT RECORDED");
    set_calculation_mode_impl(&wb.state, "manual");
    assert_eq!(crate::persistence::adopt_cala_calculation_mode(&wb.state, &workbook), AUTOMATIC_EXCEPT_TABLES);
    assert_eq!(*wb.state.calculation_mode.lock().unwrap(), "automatic");
    assert!(wb.state.calculation_except_tables.load(std::sync::atomic::Ordering::SeqCst), "the open adopts the mode");
}

/// BUG-0756, Excel [LIVE, dtable/probe1.ps1, table K1:L4, body L2:L4]: a fill
/// whose target covers the WHOLE body replaces the table (FillDown L1:L5
/// wrote `=B2`..), one over part of it is refused (FillDown L2:L4: "Can't
/// change part of a data table."). Calcula refused both.
///
/// SABOTAGE: call `check_no_array_within` instead of `check_fill_target` in
/// `fill_range_core` -- fails at "FILL REFUSED".
#[test]
fn a_fill_over_a_whole_data_table_body_replaces_the_table() {
    let wb = Wb::new();
    assert!(wb.one_var_k1_l3().error.is_none());
    assert_eq!(wb.fill((1, 11, 1, 11), (2, 11, 2, 11)).err().as_deref(), Some(PART), "a fill over PART of the body");
    assert_eq!(wb.formula(0, 2, 11).as_deref(), Some("TABLE(,A1)"), "L3 keeps its marker");
    wb.fill((0, 11, 0, 11), (1, 11, 2, 11)).unwrap_or_else(|e| panic!("FILL REFUSED over the whole body: {e}"));
    assert_eq!(wb.formula(0, 1, 11).as_deref(), Some("B2"), "L2 holds the filled formula");
    assert_eq!(wb.formula(0, 2, 11).as_deref(), Some("B3"));
    let tables = engine::data_table::data_tables_in(&wb.state.grids.read().unwrap()[0]);
    assert!(tables.is_empty(), "the table is gone: {tables:?}");
}

/// BUG-0755, Excel [LIVE, dtable/probe4.ps1]: Scenario Show reaches the live
/// data tables -- under automatic calculation the body follows (C1 = 100: L2
/// 10 -> 110, xlDone); under manual it waits for F9 (xlPending).
///
/// SABOTAGE: delete the `refresh_live_tables_held` call from
/// `scenario_show_impl` -- fails at "SCENARIO STALE".
#[test]
fn a_shown_scenario_refreshes_the_live_data_tables_under_automatic_calculation() {
    let wb = Wb::new();
    assert!(wb.one_var_k1_l3().error.is_none());
    wb.set(0, 1, "=A1*2+C1"); // B1, now reading C1
    assert_eq!(wb.number(0, 1, 11), 10.0);
    wb.add_scenario("S1", &[(0, 2, "100")]);
    wb.add_scenario("S2", &[(0, 2, "200")]);
    wb.show("S1");
    assert_eq!(wb.number(0, 1, 11), 110.0, "SCENARIO STALE: the body kept the old scenario's numbers");
    assert_eq!(wb.number(0, 2, 11), 114.0);
    assert_eq!(wb.state_now(), "done");
    wb.manual();
    wb.show("S2");
    assert_eq!(wb.number(0, 1, 11), 110.0, "under manual the body waits for F9");
    assert_eq!(wb.state_now(), "pending");
    wb.f9();
    assert_eq!(wb.number(0, 1, 11), 210.0);
}

/// BUG-0757: a `.calp` merge that brings a NEW data table writes its marker
/// cells through the batch gate, which refused them as a typed `=TABLE(..)`
/// ("That function isn't valid.") and the merge with them. Under the merge's
/// marker claim -- exactly the marker cells of the grids it lays -- the active
/// sheet's batch installs the table, live; a marker anywhere else stays a
/// typed formula, and without the claim the write is refused as before.
///
/// SABOTAGE: make `version_claims_marker` answer false -- fails at "MERGE
/// REFUSED".
#[test]
fn a_merge_installs_a_new_data_table_through_the_marker_claim() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    wb.set(1, 10, "5"); // K2
    wb.set(2, 10, "7"); // K3
    wb.set(0, 11, "=B1"); // L1
    let locale = engine::LocaleSettings::invariant();
    let mut theirs = wb.state.grids.read().unwrap().clone();
    for row in [1, 2] {
        theirs[0].set_cell(row, 11, crate::parse_cell_input_invariant("=TABLE(,A1)", &locale));
    }
    let markers = || vec![wb.typed(1, 11, "=TABLE(,A1)"), wb.typed(2, 11, "=TABLE(,A1)")];
    assert_eq!(
        wb.write_batch(markers()).err().as_deref(),
        Some(engine::data_table::TABLE_NOT_VALID),
        "precondition: without the claim the marker is a typed formula"
    );
    {
        let _claim = crate::data_tables::claim_version_tables(&theirs);
        let mut stray = markers();
        stray.push(wb.typed(5, 5, "=TABLE(,A1)"));
        assert_eq!(
            wb.write_batch(stray).err().as_deref(),
            Some(engine::data_table::TABLE_NOT_VALID),
            "a marker the version does not hold is still a typed formula"
        );
        wb.write_batch(markers()).unwrap_or_else(|e| panic!("MERGE REFUSED: the version's own table ({e})"));
    }
    assert_eq!(wb.formula(0, 1, 11).as_deref(), Some("TABLE(,A1)"), "L2 holds the version's marker");
    assert_eq!((wb.number(0, 1, 11), wb.number(0, 2, 11)), (10.0, 14.0), "the installed table is computed");
    wb.edit(1, 10, "9").expect("K2 = 9");
    assert_eq!(wb.number(0, 1, 11), 18.0, "and live");
    assert_eq!(
        wb.write_batch(vec![wb.typed(9, 9, "=TABLE(,A1)")]).err().as_deref(),
        Some(engine::data_table::TABLE_NOT_VALID),
        "the claim closed with its scope"
    );
    let _ = CellValue::Empty;
}

/// BUG-0757: the merge itself opens the marker claim over the grids it lays,
/// before it hands them to the script pipeline (the behaviour above is the
/// gate's; this pins that the merge reaches it). Read when the test RUNS.
///
/// SABOTAGE: delete the `claim_version_tables` line from
/// `calp_push_merge_apply` -- fails at "NO CLAIM".
#[test]
fn the_calp_merge_opens_the_marker_claim_before_it_writes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("calp_merge.rs");
    let text = std::fs::read_to_string(path).expect("calp_merge.rs");
    let start = text.find("pub fn calp_push_merge_apply(").expect("the merge moved");
    let body = &text[start..];
    let body = &body[..body.find("\n}\n").expect("the merge's end")];
    let claim = body.find("claim_version_tables(&modified_grids)").expect("NO CLAIM: the merge lays version tables unclaimed");
    let write = body.find("apply_script_modified_grids(").expect("the merge's write moved");
    assert!(claim < write, "the claim is open before the write");
}

/// BUG-0755 (the precedent trigger), Excel [LIVE, Excel 16 over COM,
/// 2026-11-06, dtable/probe1.ps1]: a table is recomputed only when an edit
/// reaches its precedents. The self-reading table K1:L4 (`L1 = B1+L4`, inputs
/// 5 / 7 / 9 in K2:K4 over `B1 = A1*2`) is 10 / 14 / 18 when made; edits of
/// the unrelated Z1 and A5 left it 10 / 18; K2 = 6 stepped it to 30 / 36. A
/// table that recomputed on every edit stepped once per unrelated edit
/// (10 + 18 = 28 ...). A precedent reached through a formula (C1 under B1),
/// through a whole column (D:D) and the input cell itself still refresh it.
///
/// SABOTAGE: make `tables_reached_by` reach every table -- fails at
/// "UNRELATED EDIT STEPPED".
#[test]
fn a_data_table_is_recomputed_only_when_an_edit_reaches_its_precedents() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    wb.set(1, 10, "5"); // K2
    wb.set(2, 10, "7"); // K3
    wb.set(3, 10, "9"); // K4
    wb.set(0, 11, "=B1+L4"); // L1
    assert!(wb.one_var((0, 10, 3, 11), (0, 0)).error.is_none());
    assert_eq!((wb.number(0, 1, 11), wb.number(0, 3, 11)), (10.0, 18.0), "as made");
    wb.edit(0, 25, "1").expect("Z1 = 1");
    wb.edit(4, 0, "1").expect("A5 = 1");
    wb.write_batch_reaching(vec![wb.typed(9, 25, "4"), wb.typed(10, 25, "=Z10+1")]).expect("a batch nothing in the table reads");
    assert_eq!(
        (wb.number(0, 1, 11), wb.number(0, 3, 11)),
        (10.0, 18.0),
        "UNRELATED EDIT STEPPED: an edit no precedent of the table reads recomputed it"
    );
    wb.edit(1, 10, "6").expect("K2 = 6");
    assert_eq!((wb.number(0, 1, 11), wb.number(0, 3, 11)), (30.0, 36.0), "an input value of the table steps it once");

    // Reached through a formula, a whole column, the input cell itself.
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 2, "0"); // C1
    wb.set(0, 1, "=A1*2+C1+SUM(D:D)"); // B1
    wb.set(1, 10, "5"); // K2
    wb.set(2, 10, "7"); // K3
    wb.set(0, 11, "=B1"); // L1
    assert!(wb.one_var((0, 10, 2, 11), (0, 0)).error.is_none());
    assert_eq!(wb.number(0, 1, 11), 10.0);
    wb.edit(0, 2, "100").expect("C1 = 100");
    assert_eq!(wb.number(0, 1, 11), 110.0, "NOT REACHED: a precedent of the table's formula");
    wb.write_batch_reaching(vec![wb.typed(6, 3, "1000")]).expect("D7 = 1000");
    assert_eq!(wb.number(0, 1, 11), 1110.0, "NOT REACHED: a cell of a column the formula reads");
    wb.edit(0, 0, "2").expect("A1 = 2");
    assert_eq!(wb.number(0, 1, 11), 1110.0, "the input cell's own value is replaced in every trial");
}

/// BUG-0755 / W2: under Automatic except for data tables an edit nothing in a
/// table reads leaves the workbook calculated; one that reaches a table marks
/// it pending (Excel: xlPending only after the input value changed [LIVE,
/// dtable/probe2.ps1]).
///
/// SABOTAGE: make `tables_reached_by` reach every table -- fails at
/// "UNREAD EDIT LEFT PENDING".
#[test]
fn automatic_except_tables_marks_pending_only_for_an_edit_a_table_reads() {
    use crate::calculation::{set_calculation_mode_impl, AUTOMATIC_EXCEPT_TABLES};
    let wb = Wb::new();
    assert!(wb.one_var_k1_l3().error.is_none());
    set_calculation_mode_impl(&wb.state, AUTOMATIC_EXCEPT_TABLES);
    wb.f9();
    assert_eq!(wb.state_now(), "done");
    wb.edit(20, 20, "5").expect("U21 = 5");
    assert_eq!(wb.state_now(), "done", "UNREAD EDIT LEFT PENDING: nothing in the table reads U21");
    wb.edit(1, 10, "9").expect("K2 = 9");
    assert_eq!(wb.state_now(), "pending", "the table's input value leaves it for F9");
    set_calculation_mode_impl(&wb.state, "automatic");
}

/// BUG-0755 (the precedent trigger through a spill), Excel [LIVE, Excel 16
/// over COM, 2026-11-06, verify-dtui/p1.ps1]: `C4 = SEQUENCE(B9)` spills
/// C4:C6 and the table K1:L4 reads it through `L1 = A1*C5` (input A1), body
/// 2 / 4 / 6. Excel recomputes the table whenever the spill moves the cells it
/// reads: (a) B9 = 1 shrinks the spill and empties C5 -> 0 / 0 / 0; (b) a
/// spill BLOCKED (here by growing it, B9 = 4, onto a value in C7) empties C5
/// -> 0 / 0 / 0; (c) clearing the blocking cell C7 fills C5 again -> 2 / 4 /
/// 6; (d) a table reading the anchor C4 itself shows the #SPILL! and follows
/// its unblocking. In (a), (b) and (c) neither the typed cell nor anything the
/// table's reach names after the write was typed -- the spill moved them; (d)
/// the same for the unblocking. (Calcula refuses typing INTO a spill member,
/// the verifier's other route to blocking; that is a separate defect.)
///
/// SABOTAGE: drop the reported cells from `refresh_after_cell_writes`'s
/// footprint -- fails at "SPILL SHRANK", the first case.
#[test]
fn a_change_that_reaches_a_table_through_a_spill_recomputes_it() {
    fn spill_table(l1: &str) -> Wb {
        let wb = Wb::new();
        wb.set(0, 0, "1"); // A1, the input cell
        wb.set(8, 1, "3"); // B9
        wb.set(3, 2, "=SEQUENCE(B9)"); // C4 spills C4:C6
        wb.set(6, 2, "9"); // C7, just below the spill
        wb.set(1, 10, "1"); // K2
        wb.set(2, 10, "2"); // K3
        wb.set(3, 10, "3"); // K4
        wb.set(0, 11, l1); // L1
        assert!(wb.one_var((0, 10, 3, 11), (0, 0)).error.is_none());
        wb
    }
    fn body(wb: &Wb) -> Vec<CellValue> {
        (1..=3).map(|r| wb.value(0, r, 11)).collect()
    }
    let n = |v: f64| CellValue::Number(v);

    let wb = spill_table("=A1*C5");
    assert_eq!(body(&wb), vec![n(2.0), n(4.0), n(6.0)], "as made");
    wb.edit(8, 1, "1").expect("B9 = 1");
    assert_eq!(body(&wb), vec![n(0.0), n(0.0), n(0.0)], "SPILL SHRANK: C5 emptied and the table still shows its old values");

    let wb = spill_table("=A1*C5");
    wb.edit(8, 1, "4").expect("B9 = 4");
    assert!(matches!(wb.value(0, 3, 2), CellValue::Error(_)), "precondition: C4 is blocked by C7, got {:?}", wb.value(0, 3, 2));
    assert_eq!(body(&wb), vec![n(0.0), n(0.0), n(0.0)], "SPILL BLOCKED: C5 emptied and the table still shows its old values");
    wb.edit(6, 2, "").expect("C7 cleared");
    assert_eq!(wb.value(0, 4, 2), n(2.0), "precondition: the spill came back");
    assert_eq!(body(&wb), vec![n(2.0), n(4.0), n(6.0)], "SPILL UNBLOCKED: C5 is 2 again and the table did not follow");

    let wb = spill_table("=A1*C4");
    assert_eq!(body(&wb), vec![n(1.0), n(2.0), n(3.0)], "as made, reading the anchor");
    wb.edit(8, 1, "4").expect("B9 = 4");
    for (i, v) in body(&wb).into_iter().enumerate() {
        assert!(matches!(v, CellValue::Error(_)), "ANCHOR AT #SPILL!: body row {} shows {v:?}", i + 1);
    }
    wb.edit(6, 2, "").expect("C7 cleared");
    assert_eq!(body(&wb), vec![n(1.0), n(2.0), n(3.0)], "ANCHOR UNBLOCKED: the table still shows #SPILL!");
}

/// Ledger programme 2 wave 3 (W2 dtable new defect): the hold-back of a push
/// lays the base version's cells through the script pipeline, as the merge
/// does, and a base whose data table the author deleted was refused "That
/// function isn't valid." -- it opened no marker claim. It now opens the same
/// claim as `calp_push_merge_apply` before it writes. (The claim's behaviour
/// through `apply_script_modified_grids` is pinned by
/// `a_merge_installs_a_new_data_table_through_the_marker_claim`.)
///
/// SABOTAGE: drop the claim line from `calp_hold_back_cells` -- fails at
/// "HOLD-BACK UNCLAIMED".
#[test]
fn the_calp_hold_back_opens_the_marker_claim_before_it_writes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("calp_commands.rs");
    let text = std::fs::read_to_string(path).expect("calp_commands.rs").replace("\r\n", "\n");
    let start = text.find("pub fn calp_hold_back_cells(").expect("the hold-back moved");
    let body = &text[start..];
    let body = &body[..body.find("\n}\n").expect("the hold-back's end")];
    let claim = body
        .find("claim_version_tables(&grids)")
        .expect("HOLD-BACK UNCLAIMED: the hold-back lays version tables unclaimed");
    let write = body.find("apply_script_modified_grids(").expect("the hold-back's write moved");
    let closed = body.find("drop(version_tables)").expect("the claim is closed after the write");
    assert!(claim < write && write < closed, "the claim is open across the write, and only it");
}

/// BUG-0755 remainder (W2 dtable new defect): under MANUAL calculation a
/// route that lays cells -- a `.calp` merge, a script's batch, both ending in
/// `refresh_after_edit` -- installed a data-table body whose values nothing
/// had computed and left the workbook claiming to be calculated. Excel shows a
/// table created under manual as 0 and the workbook xlPending until F9 [LIVE,
/// dtable/probe2.ps1]. The workbook is now pending; F9 computes the body.
///
/// SABOTAGE: make `refresh_after_edit` ignore `CLAIMED_MARKER_LAID` (`if laid
/// && false`) -- fails at "MANUAL INSTALL LOOKS CALCULATED".
#[test]
fn a_table_a_merge_installs_under_manual_leaves_the_workbook_pending() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    wb.set(1, 10, "5"); // K2
    wb.set(2, 10, "7"); // K3
    wb.set(0, 11, "=B1"); // L1
    crate::calculation::set_calculation_mode_impl(&wb.state, "manual");
    wb.f9();
    assert_eq!(wb.state_now(), "done", "precondition: calculated");
    let locale = engine::LocaleSettings::invariant();
    let mut theirs = wb.state.grids.read().unwrap().clone();
    for row in [1, 2] {
        theirs[0].set_cell(row, 11, crate::parse_cell_input_invariant("=TABLE(,A1)", &locale));
    }
    {
        let _claim = crate::data_tables::claim_version_tables(&theirs);
        wb.write_batch(vec![wb.typed(1, 11, "=TABLE(,A1)"), wb.typed(2, 11, "=TABLE(,A1)")])
            .unwrap_or_else(|e| panic!("the merge's table: {e}"));
    }
    assert_eq!(wb.state_now(), "pending", "MANUAL INSTALL LOOKS CALCULATED: the installed body was never computed");
    wb.f9();
    assert_eq!((wb.number(0, 1, 11), wb.number(0, 2, 11)), (10.0, 14.0), "F9 computes the installed table");
    assert_eq!(wb.state_now(), "done");
    crate::calculation::set_calculation_mode_impl(&wb.state, "automatic");
}

/// Ledger programme 2 wave 5 (dtcf4-verify-3): the batch gate sets
/// `CLAIMED_MARKER_LAID` as soon as ITS rule passes, but the batch's later
/// gates (sheet protection, a pivot region, a writeback claim, a spilled value)
/// can still refuse it -- and a refused merge laid nothing. The flag lingered on
/// the thread and the NEXT edit there, under manual calculation, marked the
/// workbook pending for a table nobody installed. The claim's close now clears
/// it. Here the version's markers ride a batch that also writes over a spilled
/// value (C2, inside `C1 = SEQUENCE(3)`), refused after the data-table gate.
///
/// SABOTAGE: drop the clear from `VersionTablesClaim`'s drop -- fails at
/// "REFUSED MERGE LEAKED".
#[test]
fn a_refused_merge_leaves_no_laid_table_mark_for_the_next_edit() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    wb.set(1, 10, "5"); // K2
    wb.set(2, 10, "7"); // K3
    wb.set(0, 11, "=B1"); // L1
    wb.set(0, 2, "=SEQUENCE(3)"); // C1 spills C1:C3
    crate::calculation::set_calculation_mode_impl(&wb.state, "manual");
    wb.f9();
    assert_eq!(wb.state_now(), "done", "precondition: calculated");
    let locale = engine::LocaleSettings::invariant();
    let mut theirs = wb.state.grids.read().unwrap().clone();
    for row in [1, 2] {
        theirs[0].set_cell(row, 11, crate::parse_cell_input_invariant("=TABLE(,A1)", &locale));
    }
    {
        let _claim = crate::data_tables::claim_version_tables(&theirs);
        let refused = wb.write_batch(vec![
            wb.typed(1, 11, "=TABLE(,A1)"),
            wb.typed(2, 11, "=TABLE(,A1)"),
            wb.typed(1, 2, "5"), // C2, a spilled value
        ]);
        assert!(refused.is_err(), "precondition: a later gate refuses the batch, got {refused:?}");
        assert!(!wb.exists_on(1, 11), "precondition: the refused batch laid nothing");
    }
    assert_eq!(wb.state_now(), "done", "precondition: the refusal changed nothing");
    wb.write_batch(vec![wb.typed(20, 20, "5")]).expect("U21 = 5, a cell nothing reads");
    assert_eq!(
        wb.state_now(),
        "done",
        "REFUSED MERGE LEAKED: an edit after a refused merge marked the workbook pending for a table never laid"
    );
    crate::calculation::set_calculation_mode_impl(&wb.state, "automatic");
}
