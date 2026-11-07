//! FILENAME: app/src-tauri/src/data_table_move_tests.rs
//! PURPOSE: A CUT OF A WHOLE DATA TABLE MOVES IT; the whole-cell clear and a
//! paste SOURCE respect a data table; a copy of a body cell pastes its value.
//!
//! A child module of `whatif_recalc_tests` (declared with `#[path]` there), so
//! it drives the real bodies through that file's `Wb` harness.
//!
//! Excel [LIVE, Excel 16 over COM, 2026-11-05, dtfollow/probe1.ps1, table K1:L4
//! = formula row L1 `=B1`, input column K2:K4, body L2:L4 `{=TABLE(,A1)}`]:
//! cutting K1:L4 to P10 leaves `=TABLE(,A1)` in Q11:Q13 and nothing in L2 --
//! the table MOVED, its input reference (A1, outside the block) unchanged --
//! while cutting L2, the body L2:L4, the inputs and body K2:L4 or the formula
//! row and body L1:L4 is refused ("Can't change part of a data table."). Copy
//! + Paste of L2 writes the number 10 whatever the paste kind.

use super::Wb;
use crate::api_types::{CellUpdateInput, ClearApplyTo, ClearRangeParams, MovedFrom, PasteSource};
use engine::CellValue;

const PART: &str = engine::data_table::PART_OF_DATA_TABLE;

impl Wb {
    /// What the clipboard's snapshot holds for (row, col) on Sheet1: `=` + the
    /// formula, a number's literal, or "" -- the write's fallback `value`.
    fn snapshot_text(&self, row: u32, col: u32) -> String {
        match self.state.grids.read().unwrap()[0].get_cell(row, col) {
            Some(cell) => match cell.formula_string() {
                Some(f) => format!("={}", f),
                None => match &cell.value {
                    CellValue::Number(n) => format!("{}", n),
                    CellValue::Text(t) => t.clone(),
                    _ => String::new(),
                },
            },
            None => String::new(),
        }
    }

    /// The destination half of a Cut + Paste of Sheet1!(r0,c0)-(r1,c1) to
    /// (tr, tc), exactly as the clipboard sends it: one write per cell of the
    /// block, each carrying the snapshot's text, its MOVE claim and its paste
    /// source (unshifted). `text` overrides a write's text (a caller's claim).
    fn cut_batch(
        &self,
        (r0, c0, r1, c1): (u32, u32, u32, u32),
        (tr, tc): (u32, u32),
        text: impl Fn(u32, u32, String) -> String,
    ) -> Result<Vec<crate::api_types::CellData>, String> {
        let mut updates = Vec::new();
        for r in r0..=r1 {
            for c in c0..=c1 {
                updates.push(CellUpdateInput {
                    row: tr + (r - r0),
                    col: tc + (c - c0),
                    value: text(r, c, self.snapshot_text(r, c)),
                    style_index: None,
                    invariant: Some(true),
                    pasted: Some(true),
                    moved: Some(MovedFrom { sheet_index: 0, row: r, col: c, target: None }),
                    source: Some(PasteSource {
                        sheet_index: 0,
                        row: r,
                        col: c,
                        target: None,
                        values_only: None,
                        unshifted: Some(true),
                    }),
                });
            }
        }
        let mut cells = crate::commands::data::update_cells_batch_core(
            &self.state, &self.file, &self.files, &self.pivots, updates, None, None, None, None,
        )?;
        // The command's own tail (`update_cells_batch`): the live tables follow.
        crate::data_tables::refresh_after_edit(&self.state, &self.files, &self.pivots, &self.pane, &self.filters, &mut cells);
        Ok(cells)
    }

    /// A whole Cut + Paste with no overlap: the batch, the source cleared (one
    /// clear of the whole block, as the clipboard clears a cut between sheets),
    /// and the move's relocation.
    fn cut_paste(&self, rect: (u32, u32, u32, u32), to: (u32, u32)) -> Result<(), String> {
        self.cut_batch(rect, to, |_, _, t| t)?;
        self.clear_all(rect)?;
        crate::commands::structure::relocate_cell_references_recording(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters, rect.0, rect.1, rect.2,
            rect.3, to.0, to.1, None, true,
        )?;
        Ok(())
    }

    fn clear_all(&self, (r0, c0, r1, c1): (u32, u32, u32, u32)) -> Result<(), String> {
        crate::commands::data::clear_range_with_options_inner(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.pane,
            &self.filters,
            ClearRangeParams {
                start_row: r0,
                start_col: c0,
                end_row: r1,
                end_col: c1,
                apply_to: ClearApplyTo::All,
                sheet_index: None,
                target: None,
            },
        )
        .map(|_| ())
    }

    fn exists(&self, row: u32, col: u32) -> bool {
        self.state.grids.read().unwrap()[0].get_cell(row, col).is_some()
    }
}

/// The table K1:L3 (formula `=B1` in L1, inputs 5 and 7 in K2:K3, body L2:L3,
/// N1 = SUM(L2:L3)) cut whole to P10 MOVES: `=TABLE(,A1)` in Q11:Q12 with its
/// values, the formula row and inputs beside it, N1 following the body, the
/// source empty -- and the moved table is live.
///
/// SABOTAGE: make `data_tables::whole_table_moves` find no table (`continue`
/// before its `whole` test) -- fails at "REFUSED".
#[test]
fn cutting_a_whole_data_table_moves_it() {
    let wb = Wb::new();
    assert!(wb.one_var_k1_l3().error.is_none());
    wb.cut_paste((0, 10, 2, 11), (9, 15)).unwrap_or_else(|e| panic!("REFUSED: the whole table did not move ({e})"));

    assert_eq!(wb.formula(0, 10, 16).as_deref(), Some("TABLE(,A1)"), "Q11 holds the moved marker");
    assert_eq!(wb.formula(0, 11, 16).as_deref(), Some("TABLE(,A1)"), "Q12 holds the moved marker");
    assert_eq!((wb.number(0, 10, 16), wb.number(0, 11, 16)), (10.0, 14.0), "the moved body's values");
    assert_eq!(wb.formula(0, 9, 16).as_deref(), Some("B1"), "the formula row moved, its reference kept");
    assert_eq!((wb.number(0, 10, 15), wb.number(0, 11, 15)), (5.0, 7.0), "the input column moved");
    assert!(!wb.exists(1, 11) && !wb.exists(2, 11) && !wb.exists(1, 10), "the source was left behind");
    assert_eq!(wb.formula(0, 0, 13).as_deref(), Some("SUM(Q11:Q12)"), "N1 follows the moved body");
    assert_eq!(wb.number(0, 0, 13), 24.0);

    wb.edit(10, 15, "9").expect("P11 = 9");
    assert_eq!(wb.number(0, 10, 16), 18.0, "the moved table is live (K2 -> P11)");
    assert_eq!(wb.number(0, 0, 13), 32.0);
}

/// A cut of PART of the table's range stays refused, before anything is
/// written -- the body cell alone, the body, inputs + body, formula + body --
/// and so is the whole range claimed with two different offsets (a script's
/// batch is not a move of the table).
///
/// SABOTAGE: drop the `whole` test in `data_tables::whole_table_moves` (treat a
/// table with any moved body cell and its corner claimed as moved) -- fails at
/// "MOVED PART".
#[test]
fn cutting_part_of_a_data_tables_range_stays_refused() {
    let wb = Wb::new();
    assert!(wb.one_var_k1_l3().error.is_none());
    for (what, rect) in [
        ("the body cell L2", (1, 11, 1, 11)),
        ("the body L2:L3", (1, 11, 2, 11)),
        ("the inputs and body K2:L3", (1, 10, 2, 11)),
        ("the formula row and body L1:L3", (0, 11, 2, 11)),
        ("all but the input K3", (0, 10, 1, 11)),
    ] {
        let r = wb.cut_batch(rect, (9, 15), |_, _, t| t);
        assert_eq!(r.err().as_deref(), Some(PART), "MOVED PART of the table: {what}");
        assert!(!wb.exists(9, 15) && !wb.exists(10, 16), "{what}: something was written");
    }
    // The whole range, but K1 (the corner) claimed to land one row further.
    let mut updates: Vec<CellUpdateInput> = Vec::new();
    for r in 0..=2u32 {
        for c in 10..=11u32 {
            let shift = if (r, c) == (0, 10) { 1 } else { 0 };
            updates.push(CellUpdateInput {
                row: 9 + r + shift,
                col: 15 + (c - 10),
                value: wb.snapshot_text(r, c),
                style_index: None,
                invariant: Some(true),
                pasted: Some(true),
                moved: Some(MovedFrom { sheet_index: 0, row: r, col: c, target: None }),
                source: None,
            });
        }
    }
    let r = crate::commands::data::update_cells_batch_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, updates, None, None, None, None,
    );
    assert_eq!(r.err().as_deref(), Some(PART), "MOVED PART: a batch moving the range by two offsets");
    assert_eq!(wb.formula(0, 1, 11).as_deref(), Some("TABLE(,A1)"), "the table stayed where it was");
}

/// Under MANUAL calculation the moved body keeps the values it showed (no
/// refresh runs until F9), and the marker it lands is the SOURCE's own, never
/// the caller's text: a batch claiming `=TABLE(,Z9)` for the body writes
/// `TABLE(,A1)`.
///
/// SABOTAGE: drop the `cell.value = moved_value.clone()` override in
/// `update_cells_batch_core` -- fails at "LOST ITS VALUES"; write the caller's
/// `update.value` in `moved_table_writes` -- fails at "CALLER'S MARKER".
#[test]
fn a_moved_data_table_keeps_its_values_and_its_own_marker() {
    let wb = Wb::new();
    assert!(wb.one_var_k1_l3().error.is_none());
    wb.manual();
    wb.cut_batch((0, 10, 2, 11), (9, 15), |r, c, t| if c == 11 && r > 0 { "=TABLE(,Z9)".to_string() } else { t })
        .expect("the whole table moves");
    assert_eq!(wb.formula(0, 10, 16).as_deref(), Some("TABLE(,A1)"), "CALLER'S MARKER: the write was not bound to its source");
    assert_eq!(
        (wb.value(0, 10, 16), wb.value(0, 11, 16)),
        (CellValue::Number(10.0), CellValue::Number(14.0)),
        "LOST ITS VALUES: the moved body under manual calculation"
    );
}

/// A whole table moved ONE ROW UP lands on part of its own body (L2:L3 of the
/// old L3:L4): that is not a change to part of it -- the cut clears what the
/// batch does not overwrite -- so the batch passes and lands the markers.
///
/// SABOTAGE: pass `&[]` for the moving tables to `check_cells_write_on_sheet` in
/// `update_cells_batch_core` -- fails at "OWN BODY".
#[test]
fn a_whole_data_table_moved_onto_its_own_body_is_not_refused() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    wb.set(1, 11, "=B1"); // L2: the formula row
    wb.set(2, 10, "5"); // K3
    wb.set(3, 10, "7"); // K4
    assert!(wb.one_var((1, 10, 3, 11), (0, 0)).error.is_none(), "the table K2:L4");
    assert_eq!(wb.formula(0, 2, 11).as_deref(), Some("TABLE(,A1)"));
    wb.cut_batch((1, 10, 3, 11), (0, 10), |_, _, t| t)
        .unwrap_or_else(|e| panic!("OWN BODY: a move of the whole table onto its own body was refused ({e})"));
    assert_eq!(wb.formula(0, 1, 11).as_deref(), Some("TABLE(,A1)"), "L2 holds the moved marker");
    assert_eq!(wb.formula(0, 0, 11).as_deref(), Some("B1"), "L1 holds the moved formula row");
}

/// A COPY of a body cell pastes its CURRENT value through the paste source
/// (BUG-0657 meets BUG-0652): the backend reads the body cell at the write and
/// writes its value, never the marker -- and never the stale fallback.
///
/// SABOTAGE: return `None` for every data-table source in
/// `resolve_paste_sources` -- fails at "STALE".
#[test]
fn a_pasted_data_table_body_cell_is_its_current_value() {
    let wb = Wb::new();
    assert!(wb.one_var_k1_l3().error.is_none());
    let r = crate::commands::data::update_cells_batch_core(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        vec![CellUpdateInput {
            row: 9,
            col: 0,
            value: "1".to_string(), // the frontend's stale read
            style_index: None,
            invariant: Some(true),
            pasted: Some(true),
            moved: None,
            source: Some(PasteSource { sheet_index: 0, row: 1, col: 11, target: None, values_only: None, unshifted: None }),
        }],
        None,
        None,
        None,
        None,
    );
    assert!(r.is_ok(), "the paste of a body cell was refused: {:?}", r.err());
    assert_eq!(wb.formula(0, 9, 0), None, "the marker was pasted");
    assert_eq!(wb.value(0, 9, 0), CellValue::Number(10.0), "STALE: the paste wrote the fallback, not L2's value");
}

/// `clear_range` -- the Delete key's whole-cell wipe, and a line move's clear
/// of its target -- refuses a rectangle over PART of a table's body before
/// anything happens, as `clear_range_with_options_inner` does. The command
/// takes `tauri::State` and cannot run in-process, so the wiring is pinned in
/// the source (the gate's behaviour is `check_range_change`'s, which
/// `part_of_a_data_table_cannot_be_changed` drives through the options clear).
///
/// SABOTAGE: delete the data-table gate block from `clear_range` -- fails at
/// "NO GATE".
#[test]
fn clear_range_asks_the_data_table_gate_before_it_commits() {
    let src = include_str!("commands/data.rs");
    let start = src.find("pub fn clear_range(\n").expect("clear_range");
    let body = &src[start..];
    let body = &body[..body.find("\n}\n").expect("the end of clear_range")];
    let gate = body.find("data_tables::check_range_change(").expect("NO GATE: clear_range never asks the data-table gate");
    let effect = body.find("DocumentEffect::mutates(").expect("the effect");
    assert!(gate < effect, "the data-table gate runs after the document is marked changed");
}

// ---------------------------------------------------------------------------
// NEW-clear-cell-datatable-gate / NEW-drag-move-whole-table
// ---------------------------------------------------------------------------

impl Wb {
    /// One cell cleared through the Delete key's single-cell command body.
    fn clear_one(&self, row: u32, col: u32) -> Result<(), String> {
        crate::commands::data::clear_cell_core(&self.state, &self.file, &self.files, &self.pane, &self.filters, row, col)
    }

    /// One write of a move, as the clipboard sends it: the snapshot's text, the
    /// MOVE claim, the source named unshifted.
    fn move_write(&self, (r, c): (u32, u32), (tr, tc): (u32, u32)) -> CellUpdateInput {
        CellUpdateInput {
            row: tr,
            col: tc,
            value: self.snapshot_text(r, c),
            style_index: None,
            invariant: Some(true),
            pasted: Some(true),
            moved: Some(MovedFrom { sheet_index: 0, row: r, col: c, target: None }),
            source: Some(PasteSource { sheet_index: 0, row: r, col: c, target: None, values_only: None, unshifted: Some(true) }),
        }
    }

    fn batch(&self, updates: Vec<CellUpdateInput>) -> Result<(), String> {
        let mut cells = crate::commands::data::update_cells_batch_core(
            &self.state, &self.file, &self.files, &self.pivots, updates, None, None, None, None,
        )?;
        crate::data_tables::refresh_after_edit(&self.state, &self.files, &self.pivots, &self.pane, &self.filters, &mut cells);
        Ok(())
    }

    fn relocate(&self, rect: (u32, u32, u32, u32), to: (u32, u32)) {
        crate::commands::structure::relocate_cell_references_recording(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters, rect.0, rect.1, rect.2,
            rect.3, to.0, to.1, None, true,
        )
        .expect("the move's relocation");
    }
}

/// Clearing ONE cell of a table's body is a change to part of its one array.
/// Excel [LIVE, Excel 16 over COM, 2026-11-05, dtroot/probe1.ps1]:
/// `Range("L2").ClearContents` on the body L2:L3 raised "Can't change part of
/// a data table." and left 30 / 42. `clear_cell` had no data-table gate, so the
/// Delete key on one body cell wiped part of the table. A cell outside the
/// body clears as before.
///
/// SABOTAGE: delete the `check_range_change` gate from `clear_cell_core` --
/// fails at "CLEARED PART".
#[test]
fn clearing_one_cell_of_a_data_tables_body_is_refused() {
    let wb = Wb::new();
    assert!(wb.one_var_k1_l3().error.is_none());
    crate::document_effect::mark_saved(&wb.file);
    let r = wb.clear_one(1, 11);
    assert_eq!(r.err().as_deref(), Some(PART), "CLEARED PART of the table: L2 is one cell of the body L2:L3");
    assert_eq!(wb.formula(0, 1, 11).as_deref(), Some("TABLE(,A1)"), "L2 keeps its marker");
    assert_eq!(wb.number(0, 1, 11), 10.0, "and its value");
    assert!(!wb.file.is_dirty(), "a refused clear leaves the document clean");
    wb.clear_one(0, 13).expect("a cell outside the body (N1) clears");
    assert!(!wb.exists(0, 13), "N1 cleared");
}

/// A ROW MOVE of a whole table (Excel moves it with its rows, as with Cut +
/// Paste): the line move's batch carries only the cells that hold something,
/// each with its MOVE claim -- never the table's EMPTY top-left corner -- and
/// the table moves. It was refused ("That function isn't valid.": the batch
/// carried no claims, so the marker was a typed formula).
///
/// SABOTAGE: make `whole_table_moves` require a claim for an empty range cell
/// (`None => false`) -- fails at "ROW MOVE REFUSED".
#[test]
fn a_row_move_of_a_whole_data_table_moves_it() {
    let wb = Wb::new();
    wb.set(0, 0, "1"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    wb.set(5, 11, "=B1"); // L6: the formula row; K6, the corner, stays empty
    wb.set(6, 10, "5"); // K7
    wb.set(7, 10, "7"); // K8
    assert!(wb.one_var((5, 10, 7, 11), (0, 0)).error.is_none(), "the table K6:L8");
    assert_eq!((wb.number(0, 6, 11), wb.number(0, 7, 11)), (10.0, 14.0));
    // moveRows(5..=7 -> 10): the target rows cleared, ONE sparse batch, the
    // source rows cleared, the relocation.
    wb.clear_all((10, 0, 12, 16383)).expect("the target rows");
    let sparse = [(5, 11), (6, 10), (6, 11), (7, 10), (7, 11)];
    let updates = sparse.iter().map(|&(r, c)| wb.move_write((r, c), (r + 5, c))).collect();
    wb.batch(updates).unwrap_or_else(|e| panic!("ROW MOVE REFUSED: a whole table moved with its rows ({e})"));
    wb.clear_all((5, 0, 7, 16383)).expect("the source rows: the whole old table");
    wb.relocate((5, 0, 7, 16383), (10, 0));
    assert_eq!(wb.formula(0, 11, 11).as_deref(), Some("TABLE(,A1)"), "L12 holds the moved marker");
    assert_eq!(wb.formula(0, 12, 11).as_deref(), Some("TABLE(,A1)"), "L13 holds the moved marker");
    assert!(!wb.exists(6, 11) && !wb.exists(7, 11), "the old body is gone");
    wb.edit(11, 10, "9").expect("K12 = 9");
    assert_eq!(wb.number(0, 11, 11), 18.0, "the moved table is live");
}

/// A DRAG MOVE of a whole table one row UP lands on part of its own body: the
/// drag's ONE batch claims every cell and empties the old body cells it
/// vacates (L4), so the per-cell clear of the vacated cells -- which the gate
/// now refuses on part of a table -- meets an empty cell, and the table stands
/// at K1:L3. Without the emptying write, L4 stands beside the moved body with
/// the same call, ONE table to the gate, and its clear is refused (the
/// coupling lane clipc noted: Cut + Paste's per-cell clear worked only because
/// `clear_cell` had no gate).
///
/// SABOTAGE: delete the gate from `clear_cell_core` -- fails at "TAIL CLEARED".
#[test]
fn a_drag_move_of_a_whole_data_table_onto_its_own_body_moves_it() {
    let setup = || {
        let wb = Wb::new();
        wb.set(0, 0, "1"); // A1
        wb.set(0, 1, "=A1*2"); // B1
        wb.set(1, 11, "=B1"); // L2: the formula row
        wb.set(2, 10, "5"); // K3
        wb.set(3, 10, "7"); // K4
        assert!(wb.one_var((1, 10, 3, 11), (0, 0)).error.is_none(), "the table K2:L4");
        wb
    };
    let dense = |wb: &Wb| -> Vec<CellUpdateInput> {
        let mut updates = Vec::new();
        for r in 1..=3u32 {
            for c in 10..=11u32 {
                updates.push(wb.move_write((r, c), (r - 1, c)));
            }
        }
        updates
    };
    // The drag as it is now: the vacated body cell L4 emptied in the batch.
    let wb = setup();
    let mut updates = dense(&wb);
    updates.push(CellUpdateInput {
        row: 3,
        col: 11,
        value: String::new(),
        style_index: None,
        invariant: None,
        pasted: None,
        moved: None,
        source: None,
    });
    wb.batch(updates).expect("the whole table moves onto its own body");
    wb.clear_one(3, 10).expect("the vacated K4");
    wb.clear_one(3, 11).expect("the vacated L4, emptied by the batch");
    wb.relocate((1, 10, 3, 11), (0, 10));
    assert_eq!(wb.formula(0, 1, 11).as_deref(), Some("TABLE(,A1)"), "L2 holds the moved marker");
    assert_eq!(wb.formula(0, 2, 11).as_deref(), Some("TABLE(,A1)"), "L3 holds the moved marker");
    assert!(!wb.exists(3, 11), "the tail of the old body is gone");
    wb.edit(1, 10, "9").expect("K2 = 9");
    assert_eq!(wb.number(0, 1, 11), 18.0, "the moved table is live");

    // Without the emptying write: the tail is part of the moved table to the
    // gate, and clearing it alone is refused, as Excel refuses part of a table.
    let wb = setup();
    wb.batch(dense(&wb)).expect("the whole table moves onto its own body");
    assert_eq!(
        wb.clear_one(3, 11).err().as_deref(),
        Some(PART),
        "TAIL CLEARED: the old body's tail stands beside the moved body as one table"
    );
}
