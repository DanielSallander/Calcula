//! FILENAME: app/src-tauri/src/state_digest_lock_order_tests.rs
//! PURPOSE: The workbook digest and the recalculation pass must take
//! `state.grid` and `state.grids` in the SAME order, because they run on
//! different threads at the same time and taking them in opposite orders hangs
//! the entire application.
//!
//! # What happened
//!
//! `run_calculation_pass` was made an `async` command so the Cancel button
//! could exist, which means Tauri runs it on a background thread. A
//! SYNCHRONOUS command runs on the WebView2 main thread. `get_workbook_state_digest`
//! is synchronous. So these two really do overlap, and they used to disagree:
//!
//! ```text
//! run_calculation_pass (background):  grid.write()  ... then grids.write()
//! get_workbook_state_digest (main) :  grids.read()  ... then grid.read()
//! ```
//!
//! Interleave them and each holds what the other is waiting for. There is no
//! panic, no crash and no log line: the main thread is inside a command, so the
//! message pump stops with it and the window simply goes "Not Responding". The
//! last thing in the app log is the digest's own DIGEST line with no matching
//! CMD completion — which is exactly what was found after the soak walk on seed
//! 20260810 left the app wedged for 27 minutes, taking every subsequent
//! minimiser replay with it.
//!
//! A HANG IS INVISIBLE TO AN EXIT-STATUS CHECK, so this is pinned two ways:
//!
//!   1. `the_digest_does_not_hold_grids_while_it_waits_for_grid` runs the real
//!      digest against a real `AppState` while the pass's first lock is held,
//!      and probes with a THREAD and a deadline -- so the test reports the
//!      deadlock instead of joining it.
//!   2. `the_digest_takes_the_two_grid_locks_in_the_passs_order` reads the
//!      source, so a future edit that reintroduces the order is a build
//!      failure rather than a field report.
//!
//! Both have a non-vacuity partner.
//!
//! # ...and both were RED IN THE TREE, and the app hung again anyway (2026-08-11)
//!
//! The fix above landed as prose and tests; the two lines it describes were
//! never turned round. `build_workbook_state_digest` still took `grids` before
//! `grid`, both tests here FAILED in a plain `cargo test --lib`, and soak seed
//! 1786446166374 wedged the app for the second time with the identical
//! signature. So the guard did not fail to fire -- nobody ran it.
//!
//! Worse, when it was finally run and the fix applied, a scan of the crate
//! showed the guard had been asking far too small a question: **32 other
//! functions held the two locks in the inverted order**, and 41 in the pass's.
//! Any of the 32 could deadlock against the background pass exactly as the
//! digest did; `get_used_range` -- which the canvas asks for constantly -- was
//! one of them. Two of the 32 were found only by the census below, after the
//! mechanical pass had already been over the file (`delete_sheet` takes the two
//! locks TWICE and only the first pair had been corrected).
//!
//! There is therefore now ONE canonical order for these two locks --
//! **`grid` (the active-sheet mirror) before `grids` (every sheet)** -- and the
//! census `no_function_holds_the_two_grid_locks_in_the_inverted_order` enforces
//! it over every function in the crate rather than over the two this file is
//! named for. The direction is the pass's, and the pass's is the one that
//! cannot be changed cheaply: it is the only holder that runs on a background
//! thread, so everything else has to agree with IT.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::document_effect::{test_seed_effect, DocumentEffect};
use crate::pivot::types::PivotState;
use crate::ribbon_filter::RibbonFilterState;
use crate::slicer::SlicerState;
use crate::state_digest::build_workbook_state_digest;
use crate::AppState;

/// A workbook with one sheet and a couple of cells, shared across threads.
fn shared_state() -> Arc<AppState> {
    let state = crate::create_app_state();
    {
        let effect = test_seed_effect();
        let mut grid = state.grid.write(&effect).unwrap();
        grid.set_cell(0, 0, engine::Cell::new_number(1.0));
        grid.set_cell(1, 0, engine::Cell::new_number(2.0));
    }
    Arc::new(state)
}

/// Wait for `cond` for at most `ms`, polling; returns whether it came true.
fn wait_until(ms: u64, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    cond()
}

/// Can something else acquire `grids` within `ms`? Runs on its own thread, so
/// a "no" answer is a timeout rather than a hung test. A thread left waiting on
/// a lock that is never released costs the test binary nothing: it holds no
/// lock of its own, and the process exits without joining it.
fn probe_can_take_grids(state: &Arc<AppState>, ms: u64) -> bool {
    let got = Arc::new(AtomicBool::new(false));
    {
        let state = Arc::clone(state);
        let got = Arc::clone(&got);
        std::thread::spawn(move || {
            let guard = state.grids.read();
            got.store(guard.is_ok(), Ordering::SeqCst);
        });
    }
    wait_until(ms, || got.load(Ordering::SeqCst))
}

#[test]
fn the_digest_does_not_hold_grids_while_it_waits_for_grid() {
    let state = shared_state();
    let pivots = PivotState::new();
    let slicers = SlicerState::new();
    let filters = RibbonFilterState::new();

    // THE PASS'S FIRST LOCK, held for as long as a real recalculation holds it.
    let effect = DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::DerivedCache,
    );
    let grid_guard = state.grid.write(&effect).unwrap();

    // The digest, on another thread, exactly as the main thread runs it while a
    // background pass is mid-evaluation.
    let started = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let handle = {
        let state = Arc::clone(&state);
        let started = Arc::clone(&started);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            started.store(true, Ordering::SeqCst);
            let out = build_workbook_state_digest(&state, &pivots, &slicers, &filters, None);
            finished.store(true, Ordering::SeqCst);
            out.map(|d| d.sheets.len())
        })
    };

    assert!(
        wait_until(2_000, || started.load(Ordering::SeqCst)),
        "the digest thread never started",
    );
    // Give it long enough to reach its first grid lock and block there.
    std::thread::sleep(Duration::from_millis(250));
    assert!(
        !finished.load(Ordering::SeqCst),
        "PRECONDITION FAILED: the digest completed while `grid` was write-locked, \
         so this test is not measuring a blocked digest at all",
    );

    // THE PROPERTY. The digest is blocked -- but on WHAT? If it is blocked on
    // `grid` (the pass's first lock) it holds nothing the pass needs, and the
    // pass can take `grids` and finish. If it is blocked on `grid` while
    // HOLDING `grids` -- the old order -- this probe never comes back, and that
    // is the deadlock: the pass would wait there forever.
    //
    // The probe is a THREAD, not a `try_lock`, because `Persisted<T>` exposes
    // no fallible acquisition -- and it deliberately does not, since every
    // write has to carry a `DocumentEffect`. A probe thread cannot hang the
    // test: the test only waits for a flag, with a deadline.
    assert!(
        probe_can_take_grids(&state, 1_500),
        "DEADLOCK: the digest is holding `grids` while it waits for `grid`, so a \
         recalculation pass holding `grid` can never acquire `grids`. The app \
         hangs with no panic and no log line (soak seed 20260810).",
    );

    // Release the pass's lock; the digest must then complete on its own.
    drop(grid_guard);
    let sheets = handle
        .join()
        .expect("the digest thread panicked")
        .expect("the digest returned an error");
    assert!(sheets >= 1, "the digest produced no sheets");
}

#[test]
fn the_probe_itself_can_fail_the_way_the_defect_did() {
    // NON-VACUITY for the test above. The probe must really answer "no" while
    // something holds `grids` -- otherwise the deadlock assertion would pass no
    // matter what the digest did, and the whole test would be theatre.
    let state = shared_state();
    let held = state.grids.read().unwrap();
    assert!(
        !probe_can_take_grids(&state, 400),
        "the probe cannot detect a held `grids` lock, so the deadlock assertion \
         above proves nothing",
    );
    drop(held);
    assert!(
        probe_can_take_grids(&state, 1_000),
        "the probe reports a lock that is not held",
    );
}

// ---------------------------------------------------------------------------
// The source-level half
// ---------------------------------------------------------------------------

/// The two orders, as they appear in the source of the two functions.
fn first_index_of(body: &str, needle: &str) -> Option<usize> {
    body.find(needle)
}

fn function_body<'a>(src: &'a str, signature: &str) -> &'a str {
    let at = src
        .find(signature)
        .unwrap_or_else(|| panic!("{signature} not found — it was renamed or moved"));
    let open = src[at..].find('{').expect("no body") + at;
    let bytes = src.as_bytes();
    let mut depth = 0usize;
    for i in open..src.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return &src[open..=i];
                }
            }
            _ => {}
        }
    }
    &src[open..]
}

#[test]
fn the_digest_takes_the_two_grid_locks_in_the_passs_order() {
    let digest_src = include_str!("state_digest.rs");
    let calc_src = include_str!("calculation.rs");

    let pass = function_body(calc_src, "pub(crate) fn run_calculation_pass(");
    let pass_grid = first_index_of(pass, "state.grid.write(").expect("the pass stopped locking grid");
    let pass_grids =
        first_index_of(pass, "state.grids.write(").expect("the pass stopped locking grids");
    assert!(
        pass_grid < pass_grids,
        "the recalculation pass now takes `grids` BEFORE `grid`. That is allowed \
         — but it is the canonical order, so the digest below has to be turned \
         round with it, in the same commit.",
    );

    let digest = function_body(digest_src, "pub(crate) fn build_workbook_state_digest(");
    let d_grid = first_index_of(digest, "state.grid.read(").expect("the digest stopped locking grid");
    let d_grids =
        first_index_of(digest, "state.grids.read(").expect("the digest stopped locking grids");
    assert!(
        d_grid < d_grids,
        "LOCK ORDER INVERSION: the digest takes `grids` before `grid`, the \
         recalculation pass takes them the other way round, and they run on \
         different threads at the same time. This hangs the whole app with no \
         panic and no log line.",
    );

    // ...and `locale`, which the pass takes only AFTER both grid locks. A
    // digest that holds `locale` and waits for `grids` is the same cycle with a
    // different third party.
    let d_locale = first_index_of(digest, "state.locale.lock(").expect("the digest stopped reading the locale");
    assert!(
        d_grids < d_locale,
        "the digest takes `locale` before `grids`; the recalculation pass takes \
         it after both grid locks, so the two can deadlock on it",
    );
}

#[test]
fn the_order_detector_finds_an_inverted_order() {
    // TEETH: the same comparison, run over a body that HAS the defect.
    let inverted = r#"{
        let grids = state.grids.read().unwrap();
        let active = state.grid.read().unwrap();
    }"#;
    let g = first_index_of(inverted, "state.grid.read(").unwrap();
    let gs = first_index_of(inverted, "state.grids.read(").unwrap();
    assert!(
        gs < g,
        "the detector cannot tell the two lock names apart — note that \
         `state.grids.read(` CONTAINS no substring `state.grid.read(`, which is \
         the only reason a plain `find` is safe here",
    );
}

// ---------------------------------------------------------------------------
// THE CENSUS — the whole crate, not the two functions this file is named for
// ---------------------------------------------------------------------------
//
// The two tests above ask about `build_workbook_state_digest` and
// `run_calculation_pass`. That is the pair that hung, twice, and it is the pair
// that was in front of whoever wrote them — which is exactly why it is the
// wrong unit of proof. A deadlock needs ONE background holder and ANY main-
// thread holder, and when this question was finally asked of every function in
// the crate the answer was 32 more of them, including `get_used_range`.
//
// One canonical order, enforced everywhere: `state.grid` BEFORE `state.grids`.

/// One function that takes `grids` and then takes `grid` while the `grids`
/// guard can still be alive.
#[derive(Debug, PartialEq, Eq)]
struct InvertedHolder {
    file: String,
    function: String,
}

/// Blank `#[cfg(test)]` items: a test fixture that seeds two grids is not a
/// product path, and a census that reports fixtures gets exemptions written for
/// it until it reports nothing at all.
///
/// There are three near-copies of this helper in the crate's censuses already
/// (`spill_map_tests`, `bulk_rewrite_recalc_tests`, `document_store_census_tests`),
/// each private to a `#[cfg(test)]` module and each returning a different shape.
/// This is a fourth, and it is written here rather than shared because §3bu's
/// finding was a DEFECT in one of those copies — a brace-less
/// `#[cfg(test)] mod x;` declaration ran the skip to EOF — so the property that
/// matters is not "one copy" but "each copy is self-tested against that exact
/// input". `the_censuss_stripper_handles_both_module_shapes` below is that test.
fn strip_cfg_test_items(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        if !line.trim_start().starts_with("#[cfg(test)]") {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let mut depth: i32 = 0;
        let mut started = false;
        for inner in lines.by_ref() {
            depth += inner.matches('{').count() as i32;
            depth -= inner.matches('}').count() as i32;
            if inner.contains('{') {
                started = true;
            }
            if started && depth <= 0 {
                break;
            }
            if !started && inner.trim_end().ends_with(';') {
                // `#[cfg(test)] #[path = "..."] mod x;` — no body to skip.
                break;
            }
        }
    }
    out
}

/// Every function in `text` that takes `state.grids` and then `state.grid`
/// while the first guard's block is still open.
///
/// DELIBERATELY OVER-APPROXIMATING. It counts an acquisition whether or not it
/// is bound to a name (`*state.grid.write(e)? = g;` holds the guard for the
/// statement just as a `let` does — that form is one of the three real
/// inversions this census found), and it stops looking at the first `drop(` or
/// at the closing brace of the block the `grids` acquisition sits in. A false
/// positive costs an argument; a false negative costs an app that stops
/// answering with nothing in the log.
fn inverted_grid_lock_holders(file: &str, text: &str) -> Vec<InvertedHolder> {
    const FN_STARTS: &[&str] = &[
        "fn ",
        "pub fn ",
        "pub(crate) fn ",
        "pub(super) fn ",
        "async fn ",
        "pub async fn ",
        "pub(crate) async fn ",
    ];
    let stripped = strip_cfg_test_items(text);
    let lines: Vec<&str> = stripped.lines().collect();
    // Code only: a census that reads comments accepts a commented-out call.
    let code: Vec<&str> = lines
        .iter()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect();

    let mut out = Vec::new();
    let mut current: Option<String> = None;
    let mut depth: i32 = 0;
    // Depth at which a `grids` guard was taken, while it can still be alive.
    let mut pending: Option<i32> = None;

    for (i, raw) in lines.iter().enumerate() {
        if FN_STARTS.iter().any(|p| raw.starts_with(p)) {
            current = raw
                .split("fn ")
                .nth(1)
                .map(|r| r.split(['(', '<']).next().unwrap_or("").to_string());
            depth = 0;
            pending = None;
        }
        let line = code[i];
        let grids_at = line.find("state.grids.read(").into_iter()
            .chain(line.find("state.grids.write("))
            .min();
        let grid_at = line.find("state.grid.read(").into_iter()
            .chain(line.find("state.grid.write("))
            .min();

        if pending.is_some() {
            if let Some(g) = grid_at {
                // Same line, `grid` first, is the canonical order, not a hold.
                let inverted_here = grids_at.is_none_or(|gs| gs < g);
                if inverted_here {
                    if let Some(name) = current.clone() {
                        out.push(InvertedHolder {
                            file: file.to_string(),
                            function: name,
                        });
                    }
                    pending = None;
                }
            }
            if line.contains("drop(") {
                pending = None;
            }
        }
        if pending.is_none() {
            if let Some(gs) = grids_at {
                if grid_at.is_none_or(|g| gs < g) {
                    pending = Some(depth);
                }
            }
        }

        depth += line.matches('{').count() as i32;
        depth -= line.matches('}').count() as i32;
        if let Some(d) = pending {
            if depth < d {
                pending = None;
            }
        }
    }
    out
}

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

#[test]
fn no_function_holds_the_two_grid_locks_in_the_inverted_order() {
    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_rs_files(&src_root, &mut files);
    assert!(
        files.len() > 50,
        "the census walked {} files — it is not finding the crate",
        files.len()
    );

    let mut offenders: Vec<String> = Vec::new();
    for path in &files {
        let rel = path
            .strip_prefix(&src_root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        // Test files seed grids by hand; they run on one thread and are not a
        // product path.
        if rel.ends_with("_tests.rs") || rel == "tests.rs" || rel.starts_with("tests/") {
            continue;
        }
        let text = std::fs::read_to_string(path).unwrap_or_default();
        for holder in inverted_grid_lock_holders(&rel, &text) {
            offenders.push(format!("{}::{}", holder.file, holder.function));
        }
    }

    assert!(
        offenders.is_empty(),
        "these functions take `state.grids` and then `state.grid` while the \
         first guard is still alive:\n  {}\n\nThe recalculation pass takes them \
         the other way round (`grid` then `grids`) and it runs on a BACKGROUND \
         thread, so any of these can interleave with it and each will hold what \
         the other is waiting for. There is no panic, no crash and no log line: \
         the main thread stops inside its command and the window goes \"Not \
         Responding\". Take `state.grid` first, or hold only one at a time.",
        offenders.join("\n  ")
    );
}

#[test]
fn the_inverted_holder_detector_fires_on_planted_bodies() {
    // TEETH. Each case is one of the shapes that was really in the tree.
    const INVERTED_ADJACENT: &str = "\
pub fn a(state: &AppState) {
    let grids = state.grids.read().unwrap();
    let active = state.grid.read().unwrap();
}
";
    const INVERTED_NESTED: &str = "\
pub fn b(state: &AppState) {
    let mut grids = state.grids.write(&e).unwrap();
    if let Some(g) = grids.get_mut(i) {
        if i == active {
            let mut mirror = state.grid.write(&e).unwrap();
        }
    }
}
";
    const INVERTED_UNBOUND: &str = "\
pub fn c(state: &AppState) {
    let grids = state.grids.read().unwrap();
    *state.grid.write(&e).unwrap() = grids.get(0).cloned().unwrap();
}
";
    const CANONICAL: &str = "\
pub fn d(state: &AppState) {
    let active = state.grid.read().unwrap();
    let grids = state.grids.read().unwrap();
}
";
    const RELEASED_BY_SCOPE: &str = "\
pub fn e(state: &AppState) {
    {
        let grids = state.grids.read().unwrap();
    }
    let active = state.grid.read().unwrap();
}
";
    const RELEASED_BY_DROP: &str = "\
pub fn f(state: &AppState) {
    let grids = state.grids.read().unwrap();
    drop(grids);
    let active = state.grid.read().unwrap();
}
";
    const COMMENTED_OUT: &str = "\
pub fn g(state: &AppState) {
    let grids = state.grids.read().unwrap();
    // let active = state.grid.read().unwrap();
}
";

    for (label, src) in [
        ("adjacent", INVERTED_ADJACENT),
        ("nested in a branch", INVERTED_NESTED),
        ("unbound temporary", INVERTED_UNBOUND),
    ] {
        assert_eq!(
            inverted_grid_lock_holders("planted.rs", src).len(),
            1,
            "the detector missed the {label} inversion — every real one it found \
             in the crate was one of these three shapes",
        );
    }
    for (label, src) in [
        ("canonical order", CANONICAL),
        ("released by scope", RELEASED_BY_SCOPE),
        ("released by drop", RELEASED_BY_DROP),
        ("only in a comment", COMMENTED_OUT),
    ] {
        assert!(
            inverted_grid_lock_holders("planted.rs", src).is_empty(),
            "the detector reported {label} as an inversion; a census that cries \
             wolf gets exemptions written for it until it reports nothing",
        );
    }
}

#[test]
fn the_censuss_stripper_handles_both_module_shapes() {
    // §3bu's defect, in this copy: a brace-less `mod x;` declaration must not
    // swallow the rest of the file, and a real test module must still go.
    const SRC: &str = "\
#[cfg(test)]
#[path = \"elsewhere_tests.rs\"]
mod elsewhere_tests;

pub fn after_the_declaration(state: &AppState) {
    let grids = state.grids.read().unwrap();
    let active = state.grid.read().unwrap();
}

#[cfg(test)]
mod tests {
    fn fixture(state: &AppState) {
        let grids = state.grids.write(&e).unwrap();
        let active = state.grid.write(&e).unwrap();
    }
}
";
    let holders = inverted_grid_lock_holders("planted.rs", SRC);
    assert_eq!(
        holders.len(),
        1,
        "expected exactly the product function: {:?}",
        holders
    );
    assert_eq!(
        holders[0].function, "after_the_declaration",
        "either the brace-less `mod x;` hid everything after it (the §3bu \
         defect) or the real test module was enumerated as product code",
    );
}

// ===========================================================================
// THE SECOND DEADLOCK: `open_file` vs the gather-refresh worker (2026-08-11)
// ===========================================================================
//
// The census above closed the `grid`/`grids` PAIR, and the app wedged again on
// the very next run. Three passes had attributed that wedge to the digest, on
// the strength of the digest's entry line being the last thing in the log; the
// digest even grew a phase watchdog to report which lock it was stuck on, and
// the watchdog could not report, because the logger is inside the wedge.
//
// It was finally MEASURED, from outside: every thread of the wedged process was
// suspended and its stack walked (Windows ARM64, x29 frame-pointer chain, since
// dbghelp's StackWalk64 does not support that machine). Two threads were
// blocked, identical in two dumps five seconds apart:
//
//   main thread 44452
//     std::sync::poison::mutex::Mutex<Vec<engine::grid::Grid>>::lock
//     app_lib::document_effect::Persisted<Vec<Grid>>::read       <- WANTS grids
//     app_lib::spill_restore::recover_spill_map_by_evaluation
//     app_lib::spill_restore::restore_spill_map_on_load
//     app_lib::persistence::open_file                            <- HOLDS sheet_names
//
//   worker 88412
//     std::sync::poison::mutex::Mutex<Vec<String>>::lock
//     app_lib::document_effect::Persisted<Vec<String>>::read     <- WANTS sheet_names
//     app_lib::calculation::recalculate_sheet_values             <- HOLDS grid + grids
//     app_lib::calp_commands::queue_gather_refresh::closure$0
//
// It is NOT the digest and it is NOT the `grid`/`grids` pair. It is the
// (`sheet_names`, `grids`) pair, and the class is the one the census was built
// for: a lock-order inversion against the recalculation pass, which is the
// crate's longest lock chain that runs off the main thread.
//
// Two things follow, and both are guarded below.
//
// 1. THE PAIR WAS THE WRONG UNIT AGAIN. `state.grid`/`state.grids` are two of
//    about forty locks. The rule that actually holds is
//    **nothing else may be held when a grid lock is acquired** -- `grid` first,
//    `grids` second, every other store after -- because the pass takes them in
//    exactly that order and everything else has to agree with the pass.
//    `no_lock_is_held_while_a_grid_lock_is_acquired` enforces it crate-wide. It
//    found 49 functions on its first run.
//
// 2. "ONLY TWO COMMANDS RUN OFF THE MAIN THREAD" WAS FALSE. That claim counted
//    `#[tauri::command(async)]` and missed `#[tauri::command] pub async fn`,
//    which Tauri also runs on the async runtime -- 114 of them. And it missed
//    the plain `std::thread::spawn` workers, one of which
//    (`queue_gather_refresh`) is the thread in the dump above. There are many
//    background holders, not two.

/// Can something else acquire `sheet_names` within `ms`? The
/// `probe_can_take_grids` pattern: a THREAD with a deadline, so a "no" is a
/// timeout the test reports rather than a hang the test joins.
fn probe_can_take_sheet_names(state: &Arc<AppState>, ms: u64) -> bool {
    let got = Arc::new(AtomicBool::new(false));
    {
        let state = Arc::clone(state);
        let got = Arc::clone(&got);
        std::thread::spawn(move || {
            let guard = state.sheet_names.read();
            got.store(guard.is_ok(), Ordering::SeqCst);
        });
    }
    wait_until(ms, || got.load(Ordering::SeqCst))
}

#[test]
fn the_load_paths_spill_recovery_does_not_hold_sheet_names_while_it_waits_for_grids() {
    // THE MEASURED DEADLOCK, as a test that FAILS rather than hangs.
    //
    // Shape: this thread plays the recalculation pass and holds `grids`. The
    // function under test runs on another thread and blocks. The question is
    // WHAT IT IS HOLDING while it blocks. With the inverted order it is holding
    // `sheet_names` -- which the pass goes on to want -- and the app is dead.
    // With the canonical order it holds nothing at all.
    let state = shared_state();
    let user_files = crate::persistence::UserFilesState::default();

    let effect = DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::DerivedCache,
    );
    let grids_guard = state.grids.write(&effect).unwrap();

    let started = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let handle = {
        let state = Arc::clone(&state);
        let started = Arc::clone(&started);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            started.store(true, Ordering::SeqCst);
            let report =
                crate::spill_restore::recover_spill_map_by_evaluation(&state, &user_files);
            finished.store(true, Ordering::SeqCst);
            report.evaluated
        })
    };

    assert!(
        wait_until(2_000, || started.load(Ordering::SeqCst)),
        "the spill-recovery thread never started",
    );
    std::thread::sleep(Duration::from_millis(250));
    assert!(
        !finished.load(Ordering::SeqCst),
        "PRECONDITION FAILED: the recovery completed while `grids` was \
         write-locked, so this test is not measuring a blocked recovery at all",
    );

    assert!(
        probe_can_take_sheet_names(&state, 1_500),
        "DEADLOCK: the load path's spill recovery is holding `sheet_names` while \
         it waits for `grids`. A recalculation pass holding both grid locks then \
         waits for `sheet_names`, and neither can proceed -- and the recovery \
         runs inside `open_file`, on the MAIN thread, so the WebView2 message \
         pump stops with it and the window never answers again. Measured live on \
         2026-08-11; both stacks are in the header above.",
    );

    drop(grids_guard);
    let _evaluated = handle.join().expect("the recovery thread panicked");
}

#[test]
fn the_sheet_names_probe_itself_can_fail_the_way_the_defect_did() {
    // NON-VACUITY for the test above.
    let state = shared_state();
    let held = state.sheet_names.read().unwrap();
    assert!(
        !probe_can_take_sheet_names(&state, 400),
        "the probe cannot detect a held `sheet_names` lock, so the deadlock \
         assertion above proves nothing",
    );
    drop(held);
    assert!(
        probe_can_take_sheet_names(&state, 1_000),
        "the probe reports a lock that is not held",
    );
}

// ---------------------------------------------------------------------------
// THE CENSUS, generalised: nothing is held when a grid lock is taken
// ---------------------------------------------------------------------------

/// One function that acquires `state.grid` / `state.grids` while some OTHER
/// state guard it took earlier is still alive.
#[derive(Debug, PartialEq, Eq)]
struct GridLockHolder {
    file: String,
    function: String,
    acquiring: String,
    holding: Vec<String>,
    /// The SAME lock, acquired twice with the first guard still alive.
    /// `Persisted<T>` is a `std::sync::Mutex`; it is not re-entrant, so this is
    /// not an ordering problem at all but a one-thread hang.
    reentrant: bool,
}

/// One lock acquisition found on a line.
struct Acquisition {
    field: String,
    col: usize,
    /// Does it BIND a guard that outlives the statement, or is it a temporary?
    live: bool,
    /// The name the guard is bound to, when there is one. Needed because
    /// `drop(x)` releases ONE guard and the census has to know which.
    binding: String,
}

/// `let mut grids = ...` -> "grids". Empty when the line binds nothing.
fn binding_name(line: &str) -> String {
    let Some(after) = line.split_once("let ") else {
        return String::new();
    };
    let rest = after.1.trim_start();
    let rest = rest.strip_prefix("mut ").unwrap_or(rest).trim_start();
    rest.chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect()
}

/// Receivers whose fields are the locks this census is about. A local named
/// `pivot_state` / `user_files_state` counts too -- the pass locks several.
fn is_state_receiver(name: &str) -> bool {
    name == "state" || name.ends_with("_state")
}

/// Method calls that CONSUME the guard inside the same statement, leaving
/// nothing alive afterwards (`state.grids.read().map(|g| g.len())`).
///
/// `.ok()` WAS IN THIS LIST AND IT DOES NOT BELONG, which is how the census
/// this file is named for passed against a live deadlock (BUG-0045).
/// `LockResult<Guard>::ok()` returns `Option<Guard>` — the guard is MOVED INTO
/// the option and lives exactly as long as the binding does. So
///
///     let named_ranges = state.named_ranges.read().ok();   // HELD
///     let tables       = state.tables.read().ok();         // HELD
///     ...
///     if let Ok(mut grid) = state.grid.write(effect) { ... }
///
/// is three locks held while a grid lock is acquired, and the census read it as
/// three temporaries that had already died. That is `restamp_workbook_name_casing`
/// verbatim, and on 2026-08-13 it wedged the app for the third time in this
/// programme — the second time on soak seed 1786446166374, with a guard in the
/// tree whose entire purpose was this shape.
///
/// The genuinely consuming forms that go through `.ok()` all carry a SECOND
/// marker from this list (`.ok().map(..)`, `.ok().and_then(..)`,
/// `.ok().map(|n| n.clone())`), so removing it loses no correct case.
const CONSUMING: &[&str] = &[
    ".clone()",
    ".iter()",
    ".len()",
    ".map(",
    ".is_empty()",
    ".contains",
    ".get(",
    ".unwrap_or",
    ".copied()",
    ".cloned()",
    ".to_vec()",
    ".as_ref()",
    ".and_then(",
];

fn trailing_ident(text: &str) -> &str {
    let bytes = text.as_bytes();
    let mut start = text.len();
    while start > 0 {
        let c = bytes[start - 1];
        if c.is_ascii_alphanumeric() || c == b'_' {
            start -= 1;
        } else {
            break;
        }
    }
    &text[start..]
}

/// Every lock acquisition on one line of code, in source order.
///
/// `tail` is the rest of the STATEMENT — this line plus the following ones up
/// to the terminating `;`. It exists because the consuming call is very often
/// on the next line:
///
/// ```text
/// let old_decls = state.writeback_declarations.lock()
///     .map(|d| d.clone()).unwrap_or_default();
/// ```
///
/// which binds nothing at all. Judging that on the first line alone reads it as
/// a live guard, and `calp_refresh_apply` — which does it twice — then looks
/// like it takes the same lock twice while holding it.
fn acquisitions_in(line: &str, tail: &str) -> Vec<Acquisition> {
    let mut out = Vec::new();
    for method in [".read(", ".write(", ".lock("] {
        let mut from = 0usize;
        while let Some(rel) = line[from..].find(method) {
            let at = from + rel;
            from = at + method.len();
            let prefix = &line[..at];
            let field = trailing_ident(prefix);
            if field.is_empty() {
                continue;
            }
            let before_field = &prefix[..prefix.len() - field.len()];
            if !before_field.ends_with('.') {
                continue;
            }
            let recv_text = &before_field[..before_field.len() - 1];
            let recv = trailing_ident(recv_text);
            if !is_state_receiver(recv) {
                continue;
            }
            let recv_start = recv_text.len() - recv.len();
            let head = line[..recv_start].trim_end();
            // `*state.active_sheet.read()...` copies the value out; the guard
            // is a temporary that dies at the `;`.
            let deref_copied = head.ends_with('*');
            let rest_of_line = &line[at + method.len()..];
            let consumed = CONSUMING.iter().any(|c| rest_of_line.contains(c))
                || (!rest_of_line.contains(';')
                    && CONSUMING.iter().any(|c| tail.contains(c)));
            // Bound to a name that outlives the statement?
            let mut h = head;
            loop {
                let trimmed = h
                    .trim_end()
                    .trim_end_matches('(')
                    .trim_end_matches("mut")
                    .trim_end_matches('&')
                    .trim_end_matches("match")
                    .trim_end();
                if trimmed.len() == h.trim_end().len() {
                    h = trimmed;
                    break;
                }
                h = trimmed;
            }
            let bound = h.ends_with('=') && line.contains("let ");
            out.push(Acquisition {
                field: field.to_string(),
                col: at,
                live: bound && !deref_copied && !consumed,
                binding: binding_name(line),
            });
        }
    }
    out.sort_by_key(|a| a.col);
    out
}

/// Every function in `text` that acquires a grid lock while holding another
/// state guard.
///
/// Same over-approximating spirit as the pair census above, with two
/// refinements it needs to be usable over forty locks rather than two:
///
///   * Rust drops TEMPORARIES at the end of the statement, so
///     `let n = *state.active_sheet.read().unwrap();` holds nothing afterwards
///     and must not be reported. Without this, the first run reported 130
///     violations, 48 of them that shape.
///   * `} else {` has a net brace delta of ZERO but it ends the scope of every
///     guard the `if` arm bound. Closes are therefore applied BEFORE opens.
///     Without this, `protection.rs`'s two-armed
///     `if sheet_index == active_sheet { grid } else { grids }` reads as one
///     arm holding the other arm's guards.
fn grid_locks_taken_while_holding(file: &str, text: &str) -> Vec<GridLockHolder> {
    const FN_STARTS: &[&str] = &[
        "fn ",
        "pub fn ",
        "pub(crate) fn ",
        "pub(super) fn ",
        "async fn ",
        "pub async fn ",
        "pub(crate) async fn ",
        "pub(super) async fn ",
    ];
    let stripped = strip_cfg_test_items(text);
    let lines: Vec<&str> = stripped.lines().collect();
    // Code only: a census that reads comments accepts a commented-out call.
    let code: Vec<&str> = lines
        .iter()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect();

    let mut out = Vec::new();
    let mut current: Option<String> = None;
    let mut depth: i32 = 0;
    let mut held: Vec<(String, i32)> = Vec::new();
    // The SAME guards, tracked by binding name, for the re-entrancy question.
    //
    // Two lists rather than one, and the difference is the point. For the ORDER
    // question `held` is cleared by ANY `drop(`: that under-approximates, which
    // is the safe direction there (a missed report costs an argument). For the
    // RE-ENTRANCY question the same rule is the UNSAFE direction — a function
    // that drops four unrelated guards and then re-takes `grids` would go
    // unreported, and `apply_override_value_to_grid` is exactly that shape. So
    // this list releases only the guard `drop(name)` actually names.
    let mut held_named: Vec<(String, String, i32)> = Vec::new();
    // Depth at which a closure handed to `spawn` opened, while it is open.
    let mut spawn_until: Option<i32> = None;

    for (i, raw) in lines.iter().enumerate() {
        if FN_STARTS.iter().any(|p| raw.starts_with(p)) {
            current = raw
                .split("fn ")
                .nth(1)
                .map(|r| r.split(['(', '<']).next().unwrap_or("").to_string());
            depth = 0;
            held.clear();
            held_named.clear();
            spawn_until = None;
        }
        let line = code[i];
        // A closure handed to `thread::spawn` / `async_runtime::spawn` /
        // `spawn_blocking` runs on ANOTHER thread: what the enclosing function
        // holds is irrelevant to it, and its own acquisitions are not the
        // enclosing function's. `mcp_start` is the live example — it holds
        // `running` and hands a closure that clears `running` when the server
        // exits, which is correct and reads as re-entrant to a naive scan.
        let opens_here = line.matches('{').count() as i32;
        let closes_here = line.matches('}').count() as i32;
        if spawn_until.is_none() && line.contains("spawn(") && opens_here > closes_here {
            spawn_until = Some(depth);
        }
        // The rest of the statement: the following lines up to the one that
        // ends it. Capped, because an unterminated statement must not make the
        // census quadratic on a 14,000-line file.
        let mut tail = String::new();
        for next in code.iter().skip(i + 1).take(4) {
            tail.push_str(next);
            if next.contains(';') {
                break;
            }
        }
        let acquisitions = if spawn_until.is_some() {
            Vec::new()
        } else {
            acquisitions_in(line, &tail)
        };
        for acq in acquisitions {
            if held_named.iter().any(|(f, _, _)| *f == acq.field) {
                if let Some(name) = current.clone() {
                    out.push(GridLockHolder {
                        file: file.to_string(),
                        function: name,
                        acquiring: acq.field.clone(),
                        holding: vec![acq.field.clone()],
                        reentrant: true,
                    });
                }
            }
            if acq.field == "grid" || acq.field == "grids" {
                // `grid` before `grids` is the canonical order, not a holding.
                let blocking: Vec<String> = held
                    .iter()
                    .filter(|(f, _)| !(acq.field == "grids" && f == "grid"))
                    .map(|(f, _)| f.clone())
                    .collect();
                if !blocking.is_empty() {
                    if let Some(name) = current.clone() {
                        out.push(GridLockHolder {
                            file: file.to_string(),
                            function: name,
                            acquiring: acq.field.clone(),
                            holding: blocking,
                            reentrant: false,
                        });
                    }
                }
            }
            if acq.live {
                // A guard bound in an `if let` / `while let` HEADER lives inside
                // the block that opens on the same line, not for the rest of the
                // enclosing one.
                //
                // `let x = match state.y.read() { ... };` ALSO ends in `{` and
                // it is the opposite case -- the binding outlives the match
                // block entirely. Both shapes are in the crate and treating
                // them alike is not cosmetic: with the match arm scoped to its
                // block, this census read the MEASURED deadlock
                // (`recover_spill_map_by_evaluation`, which binds every one of
                // its six guards that way) as clean, and passed against a tree
                // with the defect deliberately re-introduced. The statement
                // being a `let` is what tells them apart.
                let is_let_binding = line.trim_start().starts_with("let ");
                let scope = if !is_let_binding && line.trim_end().ends_with('{') {
                    depth + 1
                } else {
                    depth
                };
                held.push((acq.field.clone(), scope));
                held_named.push((acq.field, acq.binding, scope));
            }
        }
        if let Some(rest) = line.split_once("drop(") {
            held.clear();
            let dropped: String = rest
                .1
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            held_named.retain(|(_, name, _)| *name != dropped);
        }
        depth -= closes_here;
        held.retain(|(_, d)| depth >= *d);
        held_named.retain(|(_, _, d)| depth >= *d);
        depth += opens_here;
        // AFTER the opens are counted, or the `spawn(` line clears its own
        // marker: on that line `depth` is still the outer depth until the `{`
        // has been counted.
        if spawn_until.is_some_and(|d| depth <= d) {
            spawn_until = None;
        }
    }
    out
}

/// Walk the whole crate once; both census tests below filter this.
fn census_over_the_crate() -> Vec<GridLockHolder> {
    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_rs_files(&src_root, &mut files);
    assert!(
        files.len() > 50,
        "the census walked {} files — it is not finding the crate",
        files.len()
    );

    let mut holders = Vec::new();
    for path in files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        // `*_tests.rs` are test modules reached through `#[cfg(test)] #[path]`.
        if name.ends_with("_tests.rs") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let rel = path
            .strip_prefix(&src_root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        holders.extend(grid_locks_taken_while_holding(&rel, &text));
    }
    holders
}

#[test]
fn no_lock_is_held_while_a_grid_lock_is_acquired() {
    let holders: Vec<GridLockHolder> = census_over_the_crate()
        .into_iter()
        .filter(|h| !h.reentrant)
        .collect();

    assert!(
        holders.is_empty(),
        "these functions acquire a grid lock while still holding another state \
         lock. The recalculation pass takes `grid`, then `grids`, and only then \
         everything else — and it runs on a background thread, so anything that \
         holds one of those `everything else` locks and then waits for a grid \
         lock closes a cycle. The app stops answering with no panic, no crash \
         and nothing in the log (measured 2026-08-11: `open_file` held \
         `sheet_names` and waited for `grids` while the gather-refresh worker \
         held both grid locks and waited for `sheet_names`).\n{}",
        holders
            .iter()
            .map(|h| format!(
                "  {}::{} takes {} while holding [{}]",
                h.file,
                h.function,
                h.acquiring,
                h.holding.join(", ")
            ))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn no_function_takes_the_same_lock_twice_while_it_still_holds_it() {
    // A DIFFERENT CLASS from everything above, and it needs saying because the
    // fix for the ordering defect is what creates it. Turning a function round
    // usually means HOISTING a guard out of the branch that used it, which
    // widens its scope — and if anything later in the function takes that same
    // lock again, `Persisted<T>` being a `std::sync::Mutex` means the thread
    // blocks on itself. Not a cycle between two threads: one thread, no
    // partner, no timeout, forever.
    //
    // This is not hypothetical. Fixing the 49 in this pass created exactly two:
    // `calp_commands::apply_override_value_to_grid`, whose tail re-reads `grids`
    // for the orphaned-spill sweep, and `tables::set_calculated_column`, whose
    // tail calls `recalc_after_active_sheet_bulk_rewrite` (which takes both grid
    // locks itself). Both are now released with an explicit `drop` carrying the
    // reason.
    let reentrant: Vec<GridLockHolder> = census_over_the_crate()
        .into_iter()
        .filter(|h| h.reentrant)
        .collect();

    assert!(
        reentrant.is_empty(),
        "these functions take a lock they are already holding. `Persisted<T>` is \
         a `std::sync::Mutex` and is NOT re-entrant, so the second acquisition \
         blocks the calling thread forever — and if that thread is the main one, \
         the whole window stops answering with no panic and nothing in the log.\n{}",
        reentrant
            .iter()
            .map(|h| format!("  {}::{} takes {} twice", h.file, h.function, h.acquiring))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn the_reentrancy_detector_has_teeth_and_knows_what_a_spawned_closure_is() {
    // FIRES on a genuine double acquisition.
    let doubled = "pub fn f(state: &AppState) {\n    let g = state.grids.read().unwrap();\n    let again = state.grids.read().unwrap();\n}\n";
    let found = grid_locks_taken_while_holding("planted.rs", doubled);
    assert!(
        found.iter().any(|h| h.reentrant),
        "the detector cannot see a lock taken twice in one function: {:?}",
        found
    );

    // QUIET on the `mcp_start` shape: the second acquisition is inside a
    // closure handed to `thread::spawn`, so it runs on another thread and is
    // not the enclosing function taking the lock twice at all.
    let spawned = "pub fn f(state: &AppState) {\n    let mut running = state.running.lock().unwrap();\n    *running = true;\n    std::thread::spawn(move || {\n        if let Ok(mut r) = state.running.lock() {\n            *r = false;\n        }\n    });\n}\n";
    let found = grid_locks_taken_while_holding("planted.rs", spawned);
    assert!(
        found.is_empty(),
        "the detector reported a spawned closure's own acquisition as the \
         enclosing function's — that is a false positive, and a census with \
         false positives gets exemptions written for it: {:?}",
        found
    );

    // ...and the spawn suppression must END with the closure, or everything
    // after a `spawn(` in the same function stops being checked.
    let after_spawn = "pub fn f(state: &AppState) {\n    std::thread::spawn(move || {\n        let x = 1;\n    });\n    let n = state.sheet_names.read().unwrap();\n    let g = state.grids.read().unwrap();\n}\n";
    let found = grid_locks_taken_while_holding("planted.rs", after_spawn);
    assert_eq!(
        found.len(),
        1,
        "the spawn suppression never turned off, so the rest of the function is \
         invisible to the census: {:?}",
        found
    );
}

#[test]
fn the_generalised_detector_fires_on_every_shape_that_deadlocked() {
    // TEETH. Each of these is a shape the real tree actually had.
    let cases: &[(&str, &str)] = &[
        (
            "adjacent",
            "pub fn f(state: &AppState) {\n    let n = state.sheet_names.read().unwrap();\n    let g = state.grids.read().unwrap();\n}\n",
        ),
        (
            "the measured one: three guards, then grids",
            "pub fn f(state: &AppState) {\n    let a = state.sheet_names.read().unwrap();\n    let b = state.tables.read().unwrap();\n    let c = state.named_ranges.read().unwrap();\n    let d = state.grids.read().unwrap();\n}\n",
        ),
        (
            "nested in a branch",
            "pub fn f(state: &AppState) {\n    let t = state.tables.read().unwrap();\n    if cond {\n        let g = state.grid.write(&e).unwrap();\n    }\n}\n",
        ),
        (
            "unbound temporary assignment",
            "pub fn f(state: &AppState) {\n    let t = state.tables.read().unwrap();\n    *state.grid.write(&e)? = other;\n}\n",
        ),
        (
            "a non-AppState state object counts too",
            "pub fn f(state: &AppState) {\n    let p = pivot_state.pivot_tables.read().unwrap();\n    let g = state.grids.read().unwrap();\n}\n",
        ),
        (
            // THE EXACT SHAPE OF THE MEASURED DEADLOCK, and the one this census
            // was blind to on its first draft: `let x = match ... { };` binds a
            // guard that outlives the match block. With that mis-scoped, the
            // census passed against a tree carrying the real defect.
            "let-bound match arms",
            "pub fn f(state: &AppState) {\n    let n = match state.sheet_names.read() {\n        Ok(g) => g,\n        Err(_) => return,\n    };\n    let g = match state.grids.read() {\n        Ok(g) => g,\n        Err(_) => return,\n    };\n}\n",
        ),
        (
            // BUG-0045, and the reason `.ok()` came out of CONSUMING.
            // `LockResult::ok()` MOVES the guard into an `Option`; it does not
            // release it. This is `restamp_workbook_name_casing` as it stood
            // when it deadlocked against the background recalculation pass, and
            // the census reported it as clean.
            "guards bound through .ok()",
            "pub fn f(state: &AppState) {\n    let named_ranges = state.named_ranges.read().ok();\n    let tables = state.tables.read().ok();\n    let table_names = state.table_names.read().ok();\n    if let Ok(mut grid) = state.grid.write(effect) {\n        respell(&mut grid);\n    }\n}\n",
        ),
    ];
    for (label, src) in cases {
        let found = grid_locks_taken_while_holding("planted.rs", src);
        assert_eq!(
            found.len(),
            1,
            "the detector did NOT fire on the `{}` shape, so the census cannot \
             see the defect it exists for: {:?}",
            label,
            found
        );
    }
}

#[test]
fn the_generalised_detector_stays_quiet_on_the_shapes_that_are_correct() {
    // The other half of the teeth: a census that fires on everything gets
    // exemptions written for it until it reports nothing at all.
    let cases: &[(&str, &str)] = &[
        (
            "canonical order",
            "pub fn f(state: &AppState) {\n    let g = state.grid.read().unwrap();\n    let gs = state.grids.read().unwrap();\n    let n = state.sheet_names.read().unwrap();\n}\n",
        ),
        (
            "a copied-out temporary holds nothing",
            "pub fn f(state: &AppState) {\n    let n = *state.active_sheet.read().unwrap();\n    let g = state.grids.read().unwrap();\n}\n",
        ),
        (
            "a consumed guard holds nothing",
            "pub fn f(state: &AppState) {\n    let n = state.sheet_names.read().map(|s| s.len()).unwrap_or(0);\n    let g = state.grids.read().unwrap();\n}\n",
        ),
        (
            // `calp_refresh_apply`'s real shape: the consuming call is on the
            // NEXT line. Judged on the first line alone this reads as a live
            // guard and the function looks like a violator.
            "a guard consumed on the following line holds nothing",
            "pub fn f(state: &AppState) {\n    let n = state.sheet_names.lock()\n        .map(|d| d.clone()).unwrap_or_default();\n    let g = state.grids.read().unwrap();\n}\n",
        ),
        (
            "released by drop",
            "pub fn f(state: &AppState) {\n    let n = state.sheet_names.read().unwrap();\n    drop(n);\n    let g = state.grids.read().unwrap();\n}\n",
        ),
        (
            "released by scope",
            "pub fn f(state: &AppState) {\n    {\n        let n = state.sheet_names.read().unwrap();\n    }\n    let g = state.grids.read().unwrap();\n}\n",
        ),
        (
            "the two arms of an if/else are not one holder",
            "pub fn f(state: &AppState) {\n    if active {\n        let g = state.grid.read().unwrap();\n        let s = state.style_registry.read().unwrap();\n    } else {\n        let gs = state.grids.read().unwrap();\n        let s2 = state.style_registry.read().unwrap();\n    }\n}\n",
        ),
        (
            "a commented-out acquisition is not code",
            "pub fn f(state: &AppState) {\n    let n = state.sheet_names.read().unwrap();\n    // let g = state.grids.read().unwrap();\n}\n",
        ),
        (
            // The counterpart to the `let-bound match arms` tooth: an `if let`
            // HEADER really does scope its guard to the block, so the census
            // must not carry it past the closing brace.
            "an if-let header scopes its guard to the block",
            "pub fn f(state: &AppState) {\n    if let Ok(mut p) = state.pending_recalc.read() {\n        p.clear();\n    }\n    let g = state.grids.read().unwrap();\n}\n",
        ),
    ];
    for (label, src) in cases {
        let found = grid_locks_taken_while_holding("planted.rs", src);
        assert!(
            found.is_empty(),
            "the detector fired on the `{}` shape, which is CORRECT code: {:?}",
            label,
            found
        );
    }
}

// ===========================================================================
// BUG-0045 — THE SAME CLASS, ON A PAIR THE GRID CENSUS DOES NOT ASK ABOUT
// ===========================================================================
//
// MEASURED 2026-08-13, soak seed 1786446166374, 200 actions. The app stopped
// answering Tauri IPC while the page stayed perfectly alive (the DOM answered,
// the window title read `oracle-save-13232-1.cala`). Two out-of-process stack
// dumps a minute apart were identical:
//
//   main thread   open_file -> restamp_workbook_name_casing
//                 HOLDS named_ranges, tables, table_names
//                 WAITS sheet_names
//
//   gather worker calp_commands::queue_gather_refresh -> recalculate_sheet_values
//                 HOLDS grid, grids, sheet_names, style_registry, ...
//                 WAITS tables
//
// Each holds what the other is waiting for. No panic, no crash, nothing in the
// app log after the checkpoint's own DIGEST line — the message pump stops with
// the main thread and the window goes "Not Responding". That is the third time
// in this programme, and the second on this very seed.
//
// TWO THINGS WERE WRONG, and only one of them was the product.
//
// 1. THE ORDER. `restamp_workbook_name_casing` took the four naming
//    authorities and only then the two grid locks, which is the crate's
//    canonical order inside out; and it took `sheet_names` LAST of the four
//    while the pass takes it FIRST. It now takes them in the pass's own order.
//    Ten other functions took `tables` / `table_names` / `named_ranges` /
//    `style_registry` before `sheet_names` and are corrected the same way.
//
// 2. THE CENSUS ABOVE HAD A HOLE, and it is the reason a guard written for
//    exactly this shape was green while the app hung. `.ok()` was in
//    `CONSUMING`. `LockResult::ok()` MOVES the guard into an `Option` — it does
//    not release it — so every one of `restamp`'s three held guards read as a
//    temporary that had already died. See the comment on `CONSUMING`.
//
// The census below asks the SECOND question, which no test in this tree asked:
// not "is a lock held while a grid lock is taken" but "are these two locks ever
// taken in the opposite order from the one the background pass takes them in".
// The pass is the fixed point for the same reason it is for `grid`/`grids`: it
// runs off the main thread, so everything else has to agree with IT.

/// One function that still holds `held` when it acquires `then`.
#[derive(Debug)]
struct PairInversion {
    file: String,
    function: String,
    line: usize,
}

/// Every function in `text` that holds `held` while acquiring `then`.
///
/// Built on `acquisitions_in`, so it inherits the temporary-versus-guard
/// analysis the grid census already has to get right — including the `.ok()`
/// correction, which is the whole reason this pair got through.
fn pair_inversions(file: &str, text: &str, held: &str, then: &str) -> Vec<PairInversion> {
    const FN_STARTS: &[&str] = &[
        "fn ",
        "pub fn ",
        "pub(crate) fn ",
        "pub(super) fn ",
        "async fn ",
        "pub async fn ",
        "pub(crate) async fn ",
        "pub(super) async fn ",
    ];
    let stripped = strip_cfg_test_items(text);
    let lines: Vec<&str> = stripped.lines().collect();
    let code: Vec<&str> = lines
        .iter()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect();

    let mut out = Vec::new();
    let mut current: Option<String> = None;
    let mut depth: i32 = 0;
    // Depths at which a live `held` guard was bound.
    let mut held_at: Vec<i32> = Vec::new();
    let mut spawn_until: Option<i32> = None;

    for (i, raw) in lines.iter().enumerate() {
        if FN_STARTS.iter().any(|p| raw.starts_with(p)) {
            current = raw
                .split("fn ")
                .nth(1)
                .map(|r| r.split(['(', '<']).next().unwrap_or("").to_string());
            depth = 0;
            held_at.clear();
            spawn_until = None;
        }
        let line = code[i];
        let opens_here = line.matches('{').count() as i32;
        let closes_here = line.matches('}').count() as i32;
        if spawn_until.is_none() && line.contains("spawn(") && opens_here > closes_here {
            spawn_until = Some(depth);
        }
        let mut tail = String::new();
        for next in code.iter().skip(i + 1).take(4) {
            tail.push_str(next);
            if next.contains(';') {
                break;
            }
        }
        let acquisitions = if spawn_until.is_some() {
            Vec::new()
        } else {
            acquisitions_in(line, &tail)
        };
        for acq in acquisitions {
            // A MOMENTARY acquisition deadlocks exactly as a held one does: the
            // thread still waits for the lock. So `live` is NOT consulted here.
            if acq.field == then && !held_at.is_empty() {
                if let Some(name) = current.clone() {
                    out.push(PairInversion {
                        file: file.to_string(),
                        function: name,
                        line: i + 1,
                    });
                }
            }
            if acq.field == held && acq.live {
                let is_let_binding = line.trim_start().starts_with("let ");
                let scope = if !is_let_binding && line.trim_end().ends_with('{') {
                    depth + 1
                } else {
                    depth
                };
                held_at.push(scope);
            }
        }
        if line.contains("drop(") {
            held_at.clear();
        }
        depth -= closes_here;
        held_at.retain(|d| depth >= *d);
        depth += opens_here;
        if spawn_until.is_some_and(|d| depth <= d) {
            spawn_until = None;
        }
    }
    out
}

/// The stores the background recalculation pass takes AFTER `sheet_names`.
///
/// The order is the pass's, and `the_recalculation_pass_still_takes_sheet_names_first`
/// reads it back out of `calculation.rs` — a list that drifts from the pass is a
/// census enforcing the wrong direction.
const AFTER_SHEET_NAMES: &[&str] = &["style_registry", "tables", "table_names", "named_ranges"];

#[test]
fn no_function_holds_a_name_authority_while_acquiring_sheet_names() {
    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_rs_files(&src_root, &mut files);
    assert!(
        files.len() > 50,
        "the census walked {} files — it is not finding the crate",
        files.len()
    );

    let mut offenders: Vec<String> = Vec::new();
    for path in &files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if name.ends_with("_tests.rs") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let rel = path
            .strip_prefix(&src_root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        for field in AFTER_SHEET_NAMES {
            for hit in pair_inversions(&rel, &text, field, "sheet_names") {
                offenders.push(format!(
                    "  {}::{} (line {}) holds `{}` and then takes `sheet_names`",
                    hit.file, hit.function, hit.line, field
                ));
            }
        }
    }
    offenders.sort();
    offenders.dedup();

    assert!(
        offenders.is_empty(),
        "these functions hold one of the naming authorities and THEN wait for \
         `sheet_names`:\n{}\n\nThe background recalculation pass \
         (`recalculate_sheet_values`, spawned per sheet by \
         `calp_commands::queue_gather_refresh`, and reached again by the async \
         `run_calculation_pass`) takes `sheet_names` FIRST and those stores \
         after — so each of these can interleave with it and each will hold what \
         the other is waiting for. There is no panic, no crash and no log line: \
         the main thread stops inside its command and the window stops \
         answering (BUG-0045). Take `sheet_names` first, or clone it and hold no \
         guard at all.",
        offenders.join("\n")
    );
}

#[test]
fn the_recalculation_pass_still_takes_sheet_names_first() {
    // The census above enforces a DIRECTION, and the direction is not a choice:
    // it is whatever the background pass does. If the pass is ever reordered,
    // this fails here rather than leaving every other function aligned to an
    // order nothing takes any more.
    let calc = include_str!("calculation.rs");
    let pass = function_body(calc, "pub(crate) fn recalculate_sheet_values(");
    let sheet_names = first_index_of(pass, "state.sheet_names.read(")
        .expect("the pass no longer locks `sheet_names` — re-derive this census");
    for field in AFTER_SHEET_NAMES {
        let needle = format!("state.{field}.read(");
        let at = first_index_of(pass, &needle).unwrap_or_else(|| {
            panic!("the pass no longer locks `{field}` — re-derive AFTER_SHEET_NAMES")
        });
        assert!(
            sheet_names < at,
            "the pass now takes `{field}` BEFORE `sheet_names`, so \
             `no_function_holds_a_name_authority_while_acquiring_sheet_names` is \
             enforcing the opposite of the order that actually runs on the \
             background thread"
        );
    }
}

#[test]
fn the_pair_detector_fires_on_the_shape_that_deadlocked() {
    // TEETH, on the real body: `restamp_workbook_name_casing` as it stood.
    let measured = "pub(crate) fn f(state: &AppState) {\n    let named_ranges = state.named_ranges.read().ok();\n    let tables = state.tables.read().ok();\n    let table_names = state.table_names.read().ok();\n    let sheet_names = state.sheet_names.read().ok();\n}\n";
    assert_eq!(
        pair_inversions("planted.rs", measured, "tables", "sheet_names").len(),
        1,
        "the detector cannot see the body that hung the app"
    );
    assert_eq!(
        pair_inversions("planted.rs", measured, "named_ranges", "sheet_names").len(),
        1,
        "the detector missed the `named_ranges` half of the same body"
    );

    // A MOMENTARY acquisition of the second lock still deadlocks — the thread
    // waits for it either way. This is `tables::delete_table` as it stood.
    let momentary = "pub fn f(state: &AppState) {\n    let tables = state.tables.write(&effect).unwrap();\n    let names = state.sheet_names.read().unwrap().clone();\n}\n";
    assert_eq!(
        pair_inversions("planted.rs", momentary, "tables", "sheet_names").len(),
        1,
        "a clone-and-drop acquisition of `sheet_names` still WAITS for the lock"
    );

    // ...and the `.ok()` correction is load-bearing: with `.ok()` treated as
    // consuming, the measured body reads as clean.
    assert!(
        !CONSUMING.contains(&".ok()"),
        "`.ok()` is back in CONSUMING — `LockResult::ok()` moves the guard into \
         an Option and every guard bound that way becomes invisible to BOTH \
         censuses. That is exactly how BUG-0045 got past the guard written for it."
    );
}

#[test]
fn the_pair_detector_stays_quiet_on_the_shapes_that_are_correct() {
    let cases: &[(&str, &str)] = &[
        (
            "canonical order",
            "pub fn f(state: &AppState) {\n    let names = state.sheet_names.read().unwrap();\n    let tables = state.tables.read().unwrap();\n}\n",
        ),
        (
            "the first guard is a temporary",
            "pub fn f(state: &AppState) {\n    let n = state.tables.read().unwrap().len();\n    let names = state.sheet_names.read().unwrap();\n}\n",
        ),
        (
            "released by scope",
            "pub fn f(state: &AppState) {\n    {\n        let t = state.tables.read().unwrap();\n    }\n    let names = state.sheet_names.read().unwrap();\n}\n",
        ),
        (
            "released by drop",
            "pub fn f(state: &AppState) {\n    let t = state.tables.read().unwrap();\n    drop(t);\n    let names = state.sheet_names.read().unwrap();\n}\n",
        ),
        (
            "a spawned closure is another thread",
            "pub fn f(state: &AppState) {\n    let t = state.tables.read().unwrap();\n    std::thread::spawn(move || {\n        let names = state.sheet_names.read().unwrap();\n    });\n}\n",
        ),
        (
            "a commented-out acquisition is not code",
            "pub fn f(state: &AppState) {\n    let t = state.tables.read().unwrap();\n    // let names = state.sheet_names.read().unwrap();\n}\n",
        ),
    ];
    for (label, src) in cases {
        let found = pair_inversions("planted.rs", src, "tables", "sheet_names");
        assert!(
            found.is_empty(),
            "the pair detector fired on the `{}` shape, which is CORRECT code: {:?}",
            label,
            found
        );
    }
}

/// Can something else acquire `tables` within `ms`? Same shape as
/// `probe_can_take_grids`: a THREAD with a deadline, so a "no" is a timeout the
/// test reports rather than a hang the test joins.
fn probe_can_take_tables(state: &Arc<AppState>, ms: u64) -> bool {
    let got = Arc::new(AtomicBool::new(false));
    {
        let state = Arc::clone(state);
        let got = Arc::clone(&got);
        std::thread::spawn(move || {
            let guard = state.tables.read();
            got.store(guard.is_ok(), Ordering::SeqCst);
        });
    }
    wait_until(ms, || got.load(Ordering::SeqCst))
}

#[test]
fn restamping_name_casing_does_not_hold_tables_while_it_waits_for_sheet_names() {
    // THE MEASURED DEADLOCK OF BUG-0045, as a test that FAILS rather than hangs.
    //
    // This thread plays the background recalculation pass: it holds
    // `sheet_names`, which the pass takes before `tables`. `restamp_workbook_name_casing`
    // then runs on another thread and blocks — that is expected and harmless.
    // The QUESTION is what it is holding while it blocks. Before the fix it held
    // `tables` (and `table_names`, and `named_ranges`), so the pass's own
    // `state.tables.read()` could never complete and the two threads sat there
    // for as long as the process lived. After it, `sheet_names` is taken FIRST
    // of the four, so nothing of the pass's is held while it waits.
    let state = shared_state();

    let pass_holds_sheet_names = state.sheet_names.read().unwrap();

    {
        let state = Arc::clone(&state);
        std::thread::spawn(move || {
            let effect = test_seed_effect();
            crate::persistence::restamp_workbook_name_casing(&state, &effect);
        });
    }
    // Long enough for the spawned thread to reach whatever it blocks on.
    std::thread::sleep(Duration::from_millis(250));

    let tables_reachable = probe_can_take_tables(&state, 3_000);
    // Release before asserting, so a failure does not leave the restamp thread
    // parked for the rest of the binary.
    drop(pass_holds_sheet_names);

    assert!(
        tables_reachable,
        "`restamp_workbook_name_casing` is holding `tables` while it waits for \
         `sheet_names`. The recalculation pass holds `sheet_names` and then asks \
         for `tables`, and it runs on a BACKGROUND thread — so this is a cycle, \
         and the app stops answering with no panic and nothing in the log \
         (BUG-0045)."
    );
}

#[test]
fn the_tables_probe_itself_can_fail_the_way_the_defect_did() {
    // NON-VACUITY. The assertion above is only worth something if the probe can
    // return false — so reproduce the pre-fix shape directly: a thread that
    // holds `tables` and then waits for a `sheet_names` this thread owns.
    let state = shared_state();

    let this_thread_holds_sheet_names = state.sheet_names.read().unwrap();

    {
        let state = Arc::clone(&state);
        std::thread::spawn(move || {
            let _tables = state.tables.read().unwrap();
            // ...and now wait for what the test thread is holding. This is the
            // body `restamp_workbook_name_casing` used to have.
            let _names = state.sheet_names.write(&test_seed_effect());
        });
    }
    std::thread::sleep(Duration::from_millis(250));

    let reachable = probe_can_take_tables(&state, 1_000);
    drop(this_thread_holds_sheet_names);

    assert!(
        !reachable,
        "the probe reported `tables` as reachable while a thread was holding it \
         and waiting for `sheet_names` — it cannot detect the defect it exists \
         for, and the test above is vacuous"
    );
}
