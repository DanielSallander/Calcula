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
