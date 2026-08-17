//! FILENAME: app/src-tauri/src/commands/recalc_spill_tests.rs
//! PURPOSE: §3bm — the RECALCULATION pass spills, exactly as an edit does.
//!
//! A child module of `commands::data` (declared with `#[path]` there) so it
//! reaches `apply_spill_decision` and reuses the `Workbook` harness
//! `cross_sheet_recalc_tests` owns. Reusing that harness rather than copying one
//! is the rule this whole family follows: a copied harness drifts, and a drifted
//! harness is how this class of defect hides.
//!
//! # The defect
//!
//! `run_calculation_pass` (F9 and Shift+F9) and `recalculate_sheet_values` (the
//! background pass) contained no reference to spilling at all. They wrote the
//! result of `evaluate_formula_with_pivot`, which ends in
//! `EvalResult::to_cell_value()` — and that COLLAPSES an array to its first
//! element (`core/engine/src/evaluator.rs`: "Arrays collapse to the first value
//! when stored in a cell"). The three places that really decided a spill were
//! all in `commands/data.rs` and the pass reached none of them.
//!
//! Two consequences, both measured on the running app before the fix:
//!
//!   1. a BLOCKED array's `#SPILL!` became the array's first element — a
//!      plausible number where Excel shows an error. `calculate_before_save`
//!      defaults to **true**, so every Ctrl+S did this, and the collapsed
//!      number is what the file then contained;
//!   2. a RESIZED array was not re-laid: `=SEQUENCE(2)` kept rendering 1 2 3 4
//!      and `spill_ranges` kept claiming the old rectangle.
//!
//! # What "fixed" means, and how these tests are built
//!
//! There is now ONE spill decision — `apply_spill_decision` — and every
//! per-cell evaluator ends in it: the three edit paths, the cross-sheet walk,
//! and both recalculation passes. So a recalculation re-lays an array's
//! rectangle, releases what the array no longer owns, and reports `#SPILL!`
//! where it is blocked, on whatever sheet the formula lives on.
//!
//! EVERY test here carries a CONTROL — an ordinary scalar dependent of the same
//! driver — and asserts it moved. Without one, a test that "passes" because the
//! recalculation never ran at all would be indistinguishable from a test that
//! passes because the fix works, which is precisely how §3bm survived a whole
//! pass of spill work happening next to it.

use super::cross_sheet_recalc_tests::Workbook;
use super::*;
use crate::calculation::CalcScope;
use engine::{CellError, CellValue};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// F9 — the workbook pass, and the pass `save_file` runs when
/// calculate-before-save is on (which it is by default).
fn f9(wb: &Workbook) -> Vec<CellData> {
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
    .expect("run_calculation_pass(Workbook) failed")
}

/// Shift+F9 — the active sheet alone.
fn shift_f9(wb: &Workbook) -> Vec<CellData> {
    crate::calculation::run_calculation_pass(
        CalcScope::ActiveSheet,
        None,
        &wb.state,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        None,
    )
    .expect("run_calculation_pass(ActiveSheet) failed")
}

/// The background whole-sheet pass (`.calp` refresh, override revert/accept).
fn background_pass(wb: &Workbook, sheet: usize) {
    crate::calculation::recalculate_sheet_values(
        &wb.state,
        &wb.files,
        &wb.pivots,
        sheet,
        Some((&wb.pane, &wb.filters)),
    );
}

/// Manual calculation mode, so an edit writes its own cell and cascades to
/// NOTHING — the only way to leave a recalculation with real work to do, and
/// the shape a `.calp` refresh produces on a background sheet.
fn go_manual(wb: &Workbook) {
    *wb.state.calculation_mode.lock().unwrap() = "manual".to_string();
}

/// The spill map, sorted, as `get_spill_ranges` would report it.
fn spill_ranges_of(wb: &Workbook) -> Vec<((usize, u32, u32), Vec<(u32, u32)>)> {
    let mut out: Vec<((usize, u32, u32), Vec<(u32, u32)>)> = wb
        .state
        .spill_ranges
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .iter()
        .map(|(k, v)| {
            let mut cells = v.clone();
            cells.sort_unstable();
            (*k, cells)
        })
        .collect();
    out.sort_unstable();
    out
}

fn spill_hosts_of(wb: &Workbook) -> Vec<((usize, u32, u32), (u32, u32))> {
    let mut out: Vec<((usize, u32, u32), (u32, u32))> = wb
        .state
        .spill_hosts
        .lock()
        .unwrap()
        .iter()
        .map(|(k, v)| (*k, *v))
        .collect();
    out.sort_unstable();
    out
}

/// The blocking cell `note_spill_block` recorded for an origin — what the error
/// pane names when it says which cells to clear.
fn blocker_of(wb: &Workbook, sheet: usize, row: u32, col: u32) -> Option<(u32, u32)> {
    wb.state
        .spill_blocks
        .lock()
        .unwrap()
        .get(&(sheet, row, col))
        .copied()
}

/// THE INVARIANT the two halves of §3bm break in opposite directions: every
/// cell the map claims must hold a value, no cell the map does NOT claim may be
/// a leftover of an array, and `spill_hosts` must agree with `spill_ranges`
/// cell for cell.
fn assert_map_agrees_with_grid(wb: &Workbook, what: &str) {
    let ranges = spill_ranges_of(wb);
    let hosts = spill_hosts_of(wb);

    let mut expected_hosts: Vec<((usize, u32, u32), (u32, u32))> = Vec::new();
    for ((sheet, orow, ocol), cells) in &ranges {
        for &(r, c) in cells {
            expected_hosts.push(((*sheet, r, c), (*orow, *ocol)));
            assert_ne!(
                wb.value(*sheet, r, c),
                CellValue::Empty,
                "{}: the spill map claims sheet {} ({},{}) for the array at ({},{}), \
                 but the grid has nothing there",
                what,
                sheet,
                r,
                c,
                orow,
                ocol
            );
        }
        assert!(
            !cells.contains(&(*orow, *ocol)),
            "{}: the extent of the array at ({},{}) lists its own origin",
            what,
            orow,
            ocol
        );
    }
    expected_hosts.sort_unstable();
    assert_eq!(
        hosts, expected_hosts,
        "{}: spill_hosts and spill_ranges describe different arrays",
        what
    );
}

// ---------------------------------------------------------------------------
// 1. F9 re-lays an array whose LENGTH changed
// ---------------------------------------------------------------------------

/// THE SECOND HALF OF §3bm, and the one that produces a wrong ANSWER with no
/// error anywhere: `=SEQUENCE(2)` kept rendering 1 2 3 4.
#[test]
fn f9_re_lays_an_array_that_shrank() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "4"); // B1 — the length
    wb.set(0, 0, "=SEQUENCE(B1)"); // A1 spills A1:A4
    wb.set(0, 5, "=B1*10"); // F1 — the CONTROL

    assert_eq!(wb.value(0, 3, 0), CellValue::Number(4.0), "precondition: A4");
    assert_eq!(wb.number(0, 0, 5), 40.0, "precondition: the control");
    assert_map_agrees_with_grid(&wb, "before");

    go_manual(&wb);
    wb.set(0, 1, "2");
    assert_eq!(
        wb.value(0, 3, 0),
        CellValue::Number(4.0),
        "precondition: manual mode must leave the stale tail for F9 to clear"
    );

    f9(&wb);

    assert_eq!(
        wb.number(0, 0, 5),
        20.0,
        "CONTROL: the recalculation did not run, so nothing below is measured"
    );
    assert_eq!(wb.value(0, 0, 0), CellValue::Number(1.0), "A1");
    assert_eq!(wb.value(0, 1, 0), CellValue::Number(2.0), "A2");
    assert_eq!(
        wb.value(0, 2, 0),
        CellValue::Empty,
        "A3 must be EMPTY: the array shrank to two and F9 must clear what it gave up"
    );
    assert_eq!(wb.value(0, 3, 0), CellValue::Empty, "A4 must be EMPTY");
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0)])],
        "the map must claim exactly the new extent"
    );
    assert_map_agrees_with_grid(&wb, "after F9 shrank the array");
}

/// The other direction, which the shrink case cannot cover: an array that GROWS
/// has to take cells it did not own a moment ago.
#[test]
fn f9_re_lays_an_array_that_grew() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "2");
    wb.set(0, 0, "=SEQUENCE(B1)");
    wb.set(0, 5, "=B1*10");
    assert_eq!(wb.value(0, 1, 0), CellValue::Number(2.0), "precondition: A2");
    assert_eq!(wb.value(0, 2, 0), CellValue::Empty, "precondition: A3 empty");

    go_manual(&wb);
    wb.set(0, 1, "4");
    f9(&wb);

    assert_eq!(wb.number(0, 0, 5), 40.0, "CONTROL");
    assert_eq!(wb.value(0, 2, 0), CellValue::Number(3.0), "A3");
    assert_eq!(wb.value(0, 3, 0), CellValue::Number(4.0), "A4");
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])]
    );
    assert_map_agrees_with_grid(&wb, "after F9 grew the array");
}

// ---------------------------------------------------------------------------
// 2. #SPILL! through the recalculation pass
// ---------------------------------------------------------------------------

/// THE FIRST HALF OF §3bm. A blocked array reported `#SPILL!` when it was
/// typed, and a plausible `1` after any recalculation — including the one every
/// save runs.
#[test]
fn f9_keeps_the_spill_error_of_a_blocked_array() {
    let wb = Workbook::new(1);
    wb.set(1, 0, "block"); // A2 — the blocker
    wb.set(0, 0, "=SEQUENCE(2)"); // A1 cannot lay A1:A2
                                  // The COUNTERWEIGHT: an array that is NOT blocked. If arrays simply
                                  // stopped spilling, the assertion below would pass for the wrong reason.
    wb.set(0, 2, "=SEQUENCE(2)"); // C1 spills C1:C2

    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(CellError::Spill),
        "precondition: entry must produce #SPILL!, or this test measures nothing"
    );
    assert_eq!(blocker_of(&wb, 0, 0, 0), Some((1, 0)), "precondition: the blocker's address");

    f9(&wb);

    assert_eq!(
        wb.value(0, 1, 2),
        CellValue::Number(2.0),
        "COUNTERWEIGHT: the unblocked array must still spill through F9"
    );
    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(CellError::Spill),
        "a blocked array must report #SPILL! through F9, not collapse to its first element"
    );
    assert_eq!(
        wb.value(0, 1, 0),
        CellValue::Text("block".to_string()),
        "the blocker's own text must survive whatever the pass did to the origin"
    );
    assert_eq!(
        blocker_of(&wb, 0, 0, 0),
        Some((1, 0)),
        "the error pane must still be able to name the blocking cell"
    );
    assert!(
        !spill_ranges_of(&wb).iter().any(|((_, r, c), _)| *r == 0 && *c == 0),
        "a blocked array must claim nothing"
    );
    assert_map_agrees_with_grid(&wb, "after F9 over a blocked array");
}

/// The remedy has to work too: clear the blocker and the next recalculation
/// lays the array. Excel re-spills the instant the obstruction goes.
#[test]
fn f9_lays_an_array_whose_blocker_was_removed() {
    let wb = Workbook::new(1);
    wb.set(1, 0, "block");
    wb.set(0, 0, "=SEQUENCE(2)");
    wb.set(0, 5, "=1+1"); // control, so a dead pass cannot pass this test
    assert_eq!(wb.value(0, 0, 0), CellValue::Error(CellError::Spill));

    go_manual(&wb);
    wb.set(1, 0, ""); // clear the blocker; manual mode cascades to nothing
    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(CellError::Spill),
        "precondition: manual mode must leave the #SPILL! for F9 to resolve"
    );

    f9(&wb);

    assert_eq!(wb.number(0, 0, 5), 2.0, "CONTROL");
    assert_eq!(wb.value(0, 0, 0), CellValue::Number(1.0), "A1");
    assert_eq!(wb.value(0, 1, 0), CellValue::Number(2.0), "A2");
    assert_eq!(
        blocker_of(&wb, 0, 0, 0),
        None,
        "the recorded blocker must be cleared when the array lays successfully"
    );
    assert_map_agrees_with_grid(&wb, "after F9 unblocked the array");
}

/// An origin that stops producing an array at all must give its cells back AND
/// forget the `#SPILL!` address it recorded, or the next block names the wrong
/// cell.
#[test]
fn f9_releases_the_cells_of_an_origin_that_stopped_spilling() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "3");
    wb.set(0, 0, "=SEQUENCE(B1)");
    wb.set(0, 5, "=B1*10");
    assert_eq!(wb.value(0, 2, 0), CellValue::Number(3.0), "precondition: A3");

    go_manual(&wb);
    wb.set(0, 0, "=B1*2"); // no longer an array — but the edit itself releases,
                           // so re-arm the stale state the way a reload would:
    wb.state
        .spill_ranges
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert((0, 0, 0), vec![(1, 0), (2, 0)]);
    {
        let mut hosts = wb.state.spill_hosts.lock().unwrap();
        hosts.insert((0, 1, 0), (0, 0));
        hosts.insert((0, 2, 0), (0, 0));
    }

    f9(&wb);

    assert_eq!(wb.number(0, 0, 5), 30.0, "CONTROL");
    assert_eq!(wb.value(0, 0, 0), CellValue::Number(6.0), "A1 = B1*2");
    assert_eq!(
        spill_ranges_of(&wb),
        Vec::new(),
        "an origin that produces no array must claim nothing"
    );
    assert_eq!(spill_hosts_of(&wb), Vec::new());
    assert_map_agrees_with_grid(&wb, "after F9 over an origin that stopped spilling");
}

// ---------------------------------------------------------------------------
// 3. Shift+F9 and the background pass
// ---------------------------------------------------------------------------

/// Shift+F9 is the same pass with a sheet-shaped plan, so it owes the same
/// answer. Pinned separately because the two plans are built by different code.
#[test]
fn shift_f9_re_lays_an_array_that_shrank() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "4");
    wb.set(0, 0, "=SEQUENCE(B1)");
    wb.set(0, 5, "=B1*10");

    go_manual(&wb);
    wb.set(0, 1, "2");
    shift_f9(&wb);

    assert_eq!(wb.number(0, 0, 5), 20.0, "CONTROL");
    assert_eq!(wb.value(0, 1, 0), CellValue::Number(2.0), "A2");
    assert_eq!(wb.value(0, 2, 0), CellValue::Empty, "A3 must be EMPTY");
    assert_eq!(spill_ranges_of(&wb), vec![((0, 0, 0), vec![(1, 0)])]);
    assert_map_agrees_with_grid(&wb, "after Shift+F9");
}

/// `recalculate_sheet_values` is the BACKGROUND pass — a `.calp` refresh, an
/// override revert. It writes cells nobody asked it to write, which is exactly
/// why it must not silently flatten an array while doing it.
#[test]
fn the_background_sheet_pass_re_lays_an_array_that_shrank() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "4");
    wb.set(0, 0, "=SEQUENCE(B1)");
    wb.set(0, 5, "=B1*10");

    go_manual(&wb);
    wb.set(0, 1, "2");
    background_pass(&wb, 0);

    assert_eq!(wb.number(0, 0, 5), 20.0, "CONTROL");
    assert_eq!(wb.value(0, 1, 0), CellValue::Number(2.0), "A2");
    assert_eq!(wb.value(0, 2, 0), CellValue::Empty, "A3 must be EMPTY");
    assert_eq!(spill_ranges_of(&wb), vec![((0, 0, 0), vec![(1, 0)])]);
    assert_map_agrees_with_grid(&wb, "after the background pass");
}

// ---------------------------------------------------------------------------
// 4. A sheet the user is NOT looking at
// ---------------------------------------------------------------------------

/// F9 plans the WORKBOOK, so it reaches arrays on sheets that are not the
/// active one — and `apply_spill_decision` has to write those into
/// `grids[sheet]` without touching the active-sheet mirror at the same
/// coordinates. Getting that wrong would erase an unrelated cell on screen,
/// which is why the mirror is a separate parameter from the sheet.
#[test]
fn f9_re_lays_an_array_on_a_background_sheet() {
    let wb = Workbook::new(2);
    wb.set(0, 0, "4"); // Sheet1!A1 — the length
    wb.switch_to(1);
    wb.set(0, 1, "=SEQUENCE(Sheet1!A1)"); // Sheet2!B1 spills B1:B4
    wb.set(0, 3, "=Sheet1!A1*10"); // Sheet2!D1 — the CONTROL
    assert_eq!(wb.value(1, 3, 1), CellValue::Number(4.0), "precondition: Sheet2!B4");
    wb.switch_to(0);

    // A cell on the ACTIVE sheet at the coordinates the background array is
    // about to give up. If the release reached the mirror it would erase this.
    wb.set(2, 1, "keep me"); // Sheet1!B3
    wb.set(3, 1, "keep me too"); // Sheet1!B4

    go_manual(&wb);
    wb.set(0, 0, "2");
    f9(&wb);

    assert_eq!(wb.number(1, 0, 3), 20.0, "CONTROL on Sheet2");
    assert_eq!(wb.value(1, 1, 1), CellValue::Number(2.0), "Sheet2!B2");
    assert_eq!(
        wb.value(1, 2, 1),
        CellValue::Empty,
        "Sheet2!B3 must be EMPTY after the background array shrank"
    );
    assert_eq!(wb.value(1, 3, 1), CellValue::Empty, "Sheet2!B4 must be EMPTY");
    assert_eq!(
        wb.value(0, 2, 1),
        CellValue::Text("keep me".to_string()),
        "the ACTIVE sheet's own B3 was erased by a BACKGROUND sheet's release"
    );
    assert_eq!(
        wb.value(0, 3, 1),
        CellValue::Text("keep me too".to_string()),
        "the ACTIVE sheet's own B4 was erased by a BACKGROUND sheet's release"
    );
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((1, 0, 1), vec![(1, 1)])],
        "the extent must be keyed to Sheet2, and must be the NEW one"
    );
    assert_map_agrees_with_grid(&wb, "after F9 over a background sheet");
}

/// The EDIT path's cross-sheet walk owes the same answer, or the same workbook
/// holds different values depending on whether F9 or a keystroke last ran.
#[test]
fn an_edit_re_lays_an_array_on_another_sheet() {
    let wb = Workbook::new(2);
    wb.set(0, 0, "4");
    wb.switch_to(1);
    wb.set(0, 1, "=SEQUENCE(Sheet1!A1)");
    assert_eq!(wb.value(1, 3, 1), CellValue::Number(4.0), "precondition: Sheet2!B4");
    wb.switch_to(0);

    // Automatic mode: the edit's own cascade must cross the sheet boundary and
    // re-lay the array over there.
    wb.set(0, 0, "2");

    assert_eq!(wb.value(1, 1, 1), CellValue::Number(2.0), "Sheet2!B2");
    assert_eq!(
        wb.value(1, 2, 1),
        CellValue::Empty,
        "Sheet2!B3 must be EMPTY: the cross-sheet walk collapsed the array instead of re-laying it"
    );
    assert_eq!(spill_ranges_of(&wb), vec![((1, 0, 1), vec![(1, 1)])]);
    assert_map_agrees_with_grid(&wb, "after a cross-sheet edit");
}

// ---------------------------------------------------------------------------
// 5. Cost, and the shape of the common case
// ---------------------------------------------------------------------------

/// `calculate_before_save` defaults to TRUE, so this pass runs on every Ctrl+S.
/// What it added is one `spill_ranges` lock and one `is_empty()` per formula
/// cell (`take_spills_where` returns before it looks at anything else) plus one
/// `spill_blocks` lock — and this test pins that the empty case really is
/// empty, so the cheap path is the one a workbook with no dynamic array takes.
#[test]
fn a_workbook_with_no_array_leaves_both_spill_maps_empty() {
    let wb = Workbook::new(1);
    for row in 0..200u32 {
        wb.set(row, 0, &format!("{}", row));
        wb.set(row, 1, "=A1+1");
    }
    f9(&wb);
    assert_eq!(spill_ranges_of(&wb), Vec::new());
    assert_eq!(spill_hosts_of(&wb), Vec::new());
    assert!(
        wb.state.spill_blocks.lock().unwrap().is_empty(),
        "a workbook with no dynamic array must record no blocker"
    );
    assert_eq!(wb.value(0, 199, 1), CellValue::Number(1.0), "the pass still ran");
}

// ---------------------------------------------------------------------------
// 6. TEETH — there is exactly ONE spill decision
// ---------------------------------------------------------------------------

/// §3bm's cause was FOUR copies of one decision, three of them written out and
/// one missing entirely. This pins that there is now one.
///
/// `spill_ranges.insert(` is the irreducible act of claiming cells for an
/// array. Outside `spill_restore.rs` — which rebuilds the map from a file's
/// stored extents on load and decides nothing — it may appear in exactly one
/// function, and that function must be `apply_spill_decision`.
///
/// Read from SOURCE, because the alternative (a behavioural test) cannot
/// distinguish "one decision" from "four decisions that currently agree", and
/// four decisions that currently agree is exactly the state this fix ended.
#[test]
fn only_one_function_decides_a_spill() {
    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_rs_files(&src_root, &mut files);
    assert!(
        files.len() > 50,
        "only {} source files found under {} — the walk is broken, not the crate",
        files.len(),
        src_root.display()
    );

    let mut deciders: Vec<String> = Vec::new();
    for path in &files {
        let rel = path
            .strip_prefix(&src_root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if rel.ends_with("_tests.rs") || rel == "tests.rs" || rel.starts_with("tests/") {
            continue;
        }
        // The load-time rebuild is not a decision: it copies extents the file
        // already carries and evaluates nothing. `spill_restore.rs` is the one
        // place that does it, and `spill_persistence_tests` owns its rules.
        if rel == "spill_restore.rs" {
            continue;
        }
        let text = std::fs::read_to_string(path).unwrap_or_default();
        for func in functions_containing(&text, "spill_ranges.insert(") {
            deciders.push(format!("{}::{}", rel, func));
        }
    }
    deciders.sort();

    assert_eq!(
        deciders,
        vec!["commands/data.rs::apply_spill_decision".to_string()],
        "the spill decision must live in exactly ONE function. It was four \
         (`update_cell_impl`, `reevaluate_formula_cell`, `update_cells_batch_core` \
         each carried a hand-written copy, and the recalculation pass carried \
         none at all), which is how §3bm happened: three copies drifted from \
         each other and the fourth caller simply wrote \
         `EvalResult::to_cell_value()`, collapsing every array on every save. If \
         a new caller needs to spill, CALL `apply_spill_decision` — it takes the \
         sheet as a parameter precisely so a non-active-sheet caller can."
    );
}

/// Non-vacuity for the census above: the detector must actually find a function
/// when the token is present, or `only_one_function_decides_a_spill` would pass
/// against a crate that had deleted the spill machinery entirely.
#[test]
fn the_one_decision_detector_finds_what_it_looks_for() {
    const SAMPLE: &str = "\
fn untouched() {
    let x = 1;
}

pub(crate) fn claims_cells() {
    spill_ranges.insert((sheet, row, col), cells);
}

fn only_mentions_it_in_a_comment() {
    // spill_ranges.insert(...) used to live here
}
";
    assert_eq!(
        functions_containing(SAMPLE, "spill_ranges.insert("),
        vec!["claims_cells".to_string()],
        "the detector must find a real call, and must not be fooled by a comment"
    );
}

// ---------------------------------------------------------------------------
// Census plumbing
// ---------------------------------------------------------------------------

fn collect_rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Top-level functions in `text` whose body contains `needle` as CODE — the
/// comment half of every line is stripped first, because every real call site in
/// this crate is wrapped in a comment naming the function it calls, and a
/// careless delete leaves the name behind in prose.
fn functions_containing(text: &str, needle: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current: Option<(String, bool)> = None;
    for raw in text.lines() {
        let code = raw.split("//").next().unwrap_or("");
        if raw.starts_with("fn ")
            || raw.starts_with("pub fn ")
            || raw.starts_with("pub(crate) fn ")
            || raw.starts_with("pub(super) fn ")
            || raw.starts_with("async fn ")
            || raw.starts_with("pub async fn ")
        {
            if let Some((name, hit)) = current.take() {
                if hit {
                    out.push(name);
                }
            }
            let name = raw
                .rsplit("fn ")
                .next()
                .unwrap_or("")
                .split(['(', '<'])
                .next()
                .unwrap_or("")
                .to_string();
            current = Some((name, false));
        }
        if let Some((_, hit)) = current.as_mut() {
            if code.contains(needle) {
                *hit = true;
            }
        }
    }
    if let Some((name, hit)) = current.take() {
        if hit {
            out.push(name);
        }
    }
    out
}
