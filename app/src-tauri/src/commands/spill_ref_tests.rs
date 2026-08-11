//! FILENAME: app/src-tauri/src/commands/spill_ref_tests.rs
//! PURPOSE: §3bf — `A1#` is a LIVE reference to whatever the array spans.
//!
//! A child module of `commands::data` (declared with `#[path]` there) so it
//! reuses the `Workbook` harness `cross_sheet_recalc_tests` owns and the real
//! `.cala` round trip `spill_persistence_tests` owns.
//!
//! # The defect
//!
//! `split_entered_formula` resolved a typed `A1#` into a plain `Range` **in the
//! form the cell STORES**, not merely in the form it evaluates. So `=SUM(A1#)`
//! was kept, rendered in the formula bar and written to the archive as
//! `=SUM(A1:A4)`, and stopped following its array the moment the array changed
//! length. In Excel `A1#` is a live reference to whatever the array currently
//! spans — that is the entire purpose of the operator — and the freeze was
//! SILENT: the formula bar showed the frozen range, so nothing on screen said
//! the `#` had ever been there.
//!
//! # The fix, and why it is the same fix twice already made
//!
//! This is the third indirection a stored formula keeps. D2 did it for a
//! defined name, §2aj for a structured reference, and both were resolved at
//! EVALUATION with a dependency edge so the reader follows what it names. §3bf
//! is that shape a third time: the stored tree keeps the `#`, and
//! `name_resolution::eval_ast` expands it against the live spill map every time
//! the cell is evaluated. The dependency edges come for free, because
//! `stored_ast_references` asks the same `eval_ast`.
//!
//! # What this costs, which §3bf asked to be measured
//!
//! One `ast_has_spill_refs` walk per evaluated cell — the same order as the
//! `ast_has_table_refs` walk `eval_ast` already pays — and, only for a formula
//! that really contains a `#`, one uncontended `spill_ranges` lock around a map
//! read. A workbook with no spill reference never takes the lock.

use super::cross_sheet_recalc_tests::Workbook;
use super::*;
use engine::CellValue;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// What the cell STORES — the tree the formula bar renders and the archive
/// carries, as distinct from the tree the evaluator was handed.
fn stored_formula(wb: &Workbook, row: u32, col: u32) -> Option<String> {
    wb.state
        .grid
        .read()
        .unwrap()
        .get_cell(row, col)
        .and_then(|c| c.formula_string_raw())
}

fn f9(wb: &Workbook) {
    crate::calculation::run_calculation_pass(
        crate::calculation::CalcScope::Workbook,
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

// ---------------------------------------------------------------------------
// 1. The reference follows the array
// ---------------------------------------------------------------------------

/// A `#` reference in a formula that ALSO names something else: the three
/// indirections have to compose, and the spill pass runs last precisely so a
/// name whose `refers_to` is a spill reference still works.
#[test]
fn a_spill_reference_reached_through_a_defined_name_follows_the_array() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "3");
    wb.set(0, 0, "=SEQUENCE(B1)");

    // A name whose definition is the spill reference itself. Written straight
    // into the store, the way `d2_named_range_tests` does: the CRUD commands
    // take `State<..>` and cannot run in-process.
    wb.state
        .named_ranges
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert(
            "SPILLED".to_string(),
            crate::named_ranges::NamedRange {
                name: "Spilled".to_string(),
                sheet_index: None,
                refers_to: "=A1#".to_string(),
                comment: None,
                folder: None,
            },
        );

    wb.set(0, 2, "=SUM(Spilled)");
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(6.0), "1+2+3");
    assert_eq!(
        stored_formula(&wb, 0, 2).as_deref(),
        Some("SUM(Spilled)"),
        "the NAME must be kept too (D2)"
    );

    wb.set(0, 1, "5");
    assert_eq!(
        wb.value(0, 0, 2),
        CellValue::Number(15.0),
        "a `#` reached through a name must follow the array: 1+2+3+4+5"
    );
}

/// The edge, not merely the value: the reader must be RECALCULATED when the
/// array changes, which only happens if `stored_ast_references` can see through
/// the `#`. Proved by leaving automatic mode on and touching only the driver.
#[test]
fn a_spill_reference_creates_a_dependency_edge() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "2");
    wb.set(0, 0, "=SEQUENCE(B1)");
    wb.set(0, 2, "=SUM(A1#)");
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(3.0), "1+2");

    // ONE edit, automatic mode, no F9. If C1 does not move, the `#` produced no
    // precedent edge and the reader is only ever right by accident.
    wb.set(0, 1, "4");
    assert_eq!(
        wb.value(0, 0, 2),
        CellValue::Number(10.0),
        "the reader must be recalculated by the edit cascade, not by a later F9"
    );
}

/// F9 owes the same answer through the workbook plan, whose ORDER is built from
/// the same edges.
#[test]
fn a_spill_reference_follows_its_array_through_f9() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "2");
    wb.set(0, 0, "=SEQUENCE(B1)");
    wb.set(0, 2, "=SUM(A1#)");
    wb.set(0, 5, "=B1*10"); // CONTROL
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(3.0));

    *wb.state.calculation_mode.lock().unwrap() = "manual".to_string();
    wb.set(0, 1, "4");
    assert_eq!(
        wb.value(0, 0, 2),
        CellValue::Number(3.0),
        "precondition: manual mode must leave the stale sum for F9"
    );

    f9(&wb);

    assert_eq!(wb.number(0, 0, 5), 40.0, "CONTROL: the pass ran");
    assert_eq!(
        wb.value(0, 0, 2),
        CellValue::Number(10.0),
        "1+2+3+4 — the reference must resolve against the extent this very pass \
         re-laid, not against the one it found on the way in"
    );
}

/// A QUALIFIED spill reference. `Sheet1!A1#` must resolve against SHEET1's map,
/// not the active sheet's — the defect `resolve_spill_refs_in_ast` already
/// documents, checked here through the live path now that resolution happens
/// per evaluation.
#[test]
fn a_qualified_spill_reference_follows_the_array_on_its_own_sheet() {
    let wb = Workbook::new(2);
    wb.set(0, 1, "3"); // Sheet1!B1
    wb.set(0, 0, "=SEQUENCE(B1)"); // Sheet1!A1 spills A1:A3

    wb.switch_to(1);
    // A DECOY array on Sheet2 at the same anchor, a different length. If the
    // qualifier were ignored the sum below would read this one.
    wb.set(0, 3, "5"); // Sheet2!D1
    wb.set(0, 0, "=SEQUENCE(D1)"); // Sheet2!A1 spills A1:A5
    wb.set(0, 5, "=SUM(Sheet1!A1#)"); // Sheet2!F1
    assert_eq!(
        wb.value(1, 0, 5),
        CellValue::Number(6.0),
        "1+2+3 from SHEET1's array, not 1..5 from Sheet2's"
    );

    wb.switch_to(0);
    wb.set(0, 1, "4"); // grow Sheet1's array
    assert_eq!(
        wb.value(1, 0, 5),
        CellValue::Number(10.0),
        "a qualified `#` must follow the array on the sheet it names"
    );
}

// ---------------------------------------------------------------------------
// 2. What the cell keeps, and what the file keeps
// ---------------------------------------------------------------------------

/// The `#` survives a save and a reload, and is still live afterwards. If the
/// stored form were frozen this test would pass its first half and fail its
/// second, which is why both are here.
#[test]
fn the_hash_survives_a_save_and_reload_and_is_still_live() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "3");
    wb.set(0, 0, "=SEQUENCE(B1)");
    wb.set(0, 2, "=SUM(A1#)");
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(6.0));

    let saved = super::spill_persistence_tests::round_trip(&wb);
    let c1 = saved.sheets[0]
        .cells
        .get(&(0u32, 2u32))
        .expect("C1 survives the round trip");
    assert!(
        matches!(&c1.formula, Some(f) if f.contains('#')),
        "the archive stored {:?} — the `#` must be what is written, or a \
         reopened workbook gets the frozen range back",
        c1.formula
    );

    super::spill_persistence_tests::reopen(&wb, &saved);
    assert_eq!(
        stored_formula(&wb, 0, 2).as_deref(),
        Some("SUM(A1#)"),
        "the reopened cell must still hold the `#`"
    );
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(6.0), "still 1+2+3");

    wb.set(0, 1, "5");
    assert_eq!(
        wb.value(0, 0, 2),
        CellValue::Number(15.0),
        "and it must still FOLLOW the array after a reload"
    );
}

/// KNOWN DEVIATION, pinned so a change to it is deliberate. `A1#` where A1 is
/// not a spilling array resolves to the single anchor cell; Excel answers
/// `#REF!`.
///
/// Kept because the single-cell fallback is also what makes a ONE-cell dynamic
/// array work: `spill_ranges` only records an entry when the result reaches
/// beyond its origin, so `=SEQUENCE(1)` has no extent and `A1#` on it must
/// still read 1 — which Excel also does. Answering `#REF!` needs the map to
/// record 1x1 arrays as well, and that is a `.cala` extent change, not a
/// resolution change.
#[test]
fn a_hash_on_a_cell_that_is_not_an_array_reads_the_cell_itself() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "7");
    wb.set(0, 2, "=SUM(A1#)");
    assert_eq!(
        wb.value(0, 0, 2),
        CellValue::Number(7.0),
        "Excel answers #REF! here; this build answers the anchor cell. Changing \
         it requires 1x1 arrays to be recorded in the spill map first — see the \
         doc on this test"
    );
}

// ---------------------------------------------------------------------------
// 3. TEETH — the lock this resolution takes cannot be taken twice
// ---------------------------------------------------------------------------

/// `eval_ast` locks `state.spill_ranges` to resolve a `#`. `std::sync::Mutex`
/// is not reentrant, so a caller that ALREADY holds that lock and then
/// evaluates a formula deadlocks — and a deadlock is invisible to an
/// exit-status check, which is exactly how this register lost a run once
/// already.
///
/// So: no function may both hold the spill map and resolve a formula. Read from
/// SOURCE, because the failure it guards against is a hang, and a hang cannot
/// be asserted from inside the hung process.
#[test]
fn no_spill_map_holder_also_resolves_a_formula() {
    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_rs_files_for_lock_census(&src_root, &mut files);
    assert!(files.len() > 50, "the source walk is broken, not the crate");

    let mut offenders: Vec<String> = Vec::new();
    for path in &files {
        let rel = path
            .strip_prefix(&src_root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if rel.ends_with("_tests.rs") || rel == "tests.rs" || rel.starts_with("tests/") {
            continue;
        }
        let text = std::fs::read_to_string(path).unwrap_or_default();
        for func in functions_holding_and_resolving(&text) {
            offenders.push(format!("{}::{}", rel, func));
        }
    }
    offenders.sort();

    assert!(
        offenders.is_empty(),
        "these functions hold `spill_ranges.lock()` AND resolve a formula \
         through `eval_ast` / `stored_ast_references`, which now takes the same \
         lock (§3bf). `std::sync::Mutex` is not reentrant: this is a DEADLOCK, \
         and a deadlocked test is invisible to an exit-status check. Take the \
         extent out of the map into a local and drop the guard before \
         evaluating:\n  {}",
        offenders.join("\n  ")
    );
}

/// Non-vacuity: the detector must find the pattern it is looking for, or the
/// census above passes against a crate that has stopped locking anything.
#[test]
fn the_lock_census_detector_finds_the_pattern() {
    const SAMPLE: &str = "\
fn safe_holder() {
    let map = state.spill_ranges.lock().unwrap();
    map.len();
}

fn safe_resolver() {
    let t = crate::name_resolution::eval_ast(ast, &ctx);
}

pub(crate) fn deadlocks() {
    let map = state.spill_ranges.lock().unwrap();
    let t = crate::name_resolution::eval_ast(ast, &ctx);
}

fn only_a_comment() {
    // state.spill_ranges.lock() and eval_ast( in prose
}
";
    assert_eq!(
        functions_holding_and_resolving(SAMPLE),
        vec!["deadlocks".to_string()],
        "the detector must find the unsafe combination, and only it"
    );
}

// ---------------------------------------------------------------------------
// Census plumbing
// ---------------------------------------------------------------------------

fn collect_rs_files_for_lock_census(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files_for_lock_census(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Top-level functions whose CODE both takes the spill map's lock and resolves
/// a formula through the resolver that now takes it too.
fn functions_holding_and_resolving(text: &str) -> Vec<String> {
    const HOLDS: &str = "spill_ranges.lock(";
    const RESOLVES: [&str; 2] = ["eval_ast(", "stored_ast_references("];

    let mut out: Vec<String> = Vec::new();
    let mut current: Option<(String, bool, bool)> = None;
    for raw in text.lines() {
        let code = raw.split("//").next().unwrap_or("");
        if raw.starts_with("fn ")
            || raw.starts_with("pub fn ")
            || raw.starts_with("pub(crate) fn ")
            || raw.starts_with("pub(super) fn ")
            || raw.starts_with("async fn ")
            || raw.starts_with("pub async fn ")
        {
            if let Some((name, holds, resolves)) = current.take() {
                if holds && resolves {
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
            current = Some((name, false, false));
        }
        if let Some((_, holds, resolves)) = current.as_mut() {
            if code.contains(HOLDS) {
                *holds = true;
            }
            if RESOLVES.iter().any(|n| code.contains(n)) {
                *resolves = true;
            }
        }
    }
    if let Some((name, holds, resolves)) = current.take() {
        if holds && resolves {
            out.push(name);
        }
    }
    out
}
