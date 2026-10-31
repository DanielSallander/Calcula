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

    // The pass's body (`run_calculation_pass` -> `run_calculation_pass_with` ->
    // `run_calculation_pass_gated`, round 16).
    let pass = function_body(calc_src, "pub(crate) fn run_calculation_pass_gated(");
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
        // BLANKED, NOT REMOVED (C9): every removed line leaves an empty line
        // behind, so a line number a census measures in the stripped text is
        // the file's own line. Removing them moved every reported line below a
        // test module up by the module's length, and the message pointed at
        // unrelated code.
        out.push('\n');
        let mut started = false;
        for inner in lines.by_ref() {
            out.push('\n');
            if !started {
                if inner.trim_end().ends_with(';') {
                    // `#[cfg(test)] #[path = "..."] mod x;` — no body to skip.
                    break;
                }
                if inner.contains('{') {
                    started = true;
                }
                continue;
            }
            // THE END IS A COLUMN-ZERO `}`, NOT A BRACE COUNT.
            //
            // Counting braces per line is wrong on real test code and it failed
            // silently: `{` and `}` appear inside string literals, format
            // strings (`"{}"`), JSON fixtures and embedded JS constantly, so the
            // count never returns to zero and the skip runs to EOF. Measured on
            // `calp_commands.rs` — 195 lines in one test module carry a brace
            // inside a literal, the depth ended at +3, and the census therefore
            // scanned 11,044 of 19,308 lines. **5,363 lines of PRODUCTION code
            // were exempt from a crate-wide, exemption-free guard**, including a
            // real `pivot_tables`-before-`grids` inversion in
            // `restore_pulled_pivots`, which is the exact shape this census
            // plants as its own positive control.
            //
            // A top-level `mod tests { … }` closes with a `}` in column zero,
            // and everything nested inside it is indented, so the first such
            // line is the module's own end. That is the shape
            // `document_store_census_tests.rs::strip_test_modules` already used
            // in this crate, and it is immune to literals because a line that is
            // EXACTLY `}` cannot be part of one.
            if inner == "}" {
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
    // The crate's ONE list of function-start spellings: this census kept its
    // own and lacked `pub(super) async fn` (fix round 5).
    use crate::formula_serialisation_tests::starts_a_function;
    // Literals blanked FIRST: see `blank_literals` for the brace it hid.
    let stripped = blank_literals(&strip_cfg_test_items(text));
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
        if starts_a_function(raw) {
            current = raw
                .split("fn ")
                .nth(1)
                .map(|r| r.split(['(', '<']).next().unwrap_or("").to_string());
            depth = 0;
            pending = None;
        }
        let line = code[i];
        // A chain continuation (`state\n    .grids\n    .read()`) is read as
        // its whole statement, and a call counts on the line its METHOD is on
        // (`chain_prefix`). `lock_pending` waits for the lock like `write`.
        let prefix = chain_prefix(&code, i);
        let joined = format!("{}{}", prefix, if prefix.is_empty() { line } else { line.trim_start() });
        let on_this_line = |needle: &str| {
            joined
                .match_indices(needle)
                .map(|(at, _)| at)
                .find(|at| at + needle.len() > prefix.len())
        };
        let grids_at = on_this_line("state.grids.read(").into_iter()
            .chain(on_this_line("state.grids.write("))
            .chain(on_this_line("state.grids.lock_pending("))
            .min();
        let grid_at = on_this_line("state.grid.read(").into_iter()
            .chain(on_this_line("state.grid.write("))
            .chain(on_this_line("state.grid.lock_pending("))
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

#[test]
fn the_censuss_stripper_survives_braces_inside_string_literals() {
    // THE DEFECT THIS CENSUS ACTUALLY HAD, found 2026-09-12. The stripper used
    // to count `{` and `}` per line, which is wrong on real test code: format
    // strings (`"{}"`), JSON fixtures and embedded JS carry unbalanced braces
    // inside literals, so the depth never returns to zero and the skip runs to
    // EOF — taking every product function after the first test module with it.
    //
    // Measured on the real `calp_commands.rs`: 195 lines in one test module
    // carry a brace inside a literal, the count ended at +3, and the census saw
    // 11,044 of 19,308 lines. 5,363 lines of PRODUCTION code were silently
    // exempt from a guard that is crate-wide and has no exemptions — including
    // a real inversion in `restore_pulled_pivots`.
    //
    // The failure was invisible in the worst way: the census went on passing,
    // so it read as "no violations" rather than "not looked".
    const SRC: &str = "\
#[cfg(test)]
mod tests {
    fn fixture(state: &AppState) {
        // Every one of these carries an UNBALANCED brace inside a literal,
        // which is what defeated the counter.
        assert!(err.contains(\"x\"), \"{}\", err);
        let json = r#\"{ \"scripts\": [{ \"id\": 1 }\"#;
        let js = validator(\"(value) => { throw new Error('boom'); }\");
        let opener = \"{\";
    }
}

pub fn after_the_test_module(state: &AppState) {
    let grids = state.grids.read().unwrap();
    let active = state.grid.read().unwrap();
}
";
    let holders = inverted_grid_lock_holders("planted.rs", SRC);
    assert_eq!(
        holders.len(),
        1,
        "the stripper ran past the test module's end and swallowed the product \
         code after it — the census would report no violations because it never \
         looked, not because there are none: {:?}",
        holders
    );
    assert_eq!(holders[0].function, "after_the_test_module");
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
    /// `.read(`, `.write(`, `.lock(` or `.lock_pending(`: the torn-pair census
    /// asks about READS, and a write of each store in turn is another question.
    method: &'static str,
}

/// `let mut grids = ...` -> "grids". Empty when the line binds nothing.
fn binding_name(line: &str) -> String {
    let Some(after) = line.split_once("let ") else {
        return String::new();
    };
    let rest = after.1.trim_start();
    let rest = rest.strip_prefix("mut ").unwrap_or(rest).trim_start();
    // `let Ok(guard) = .. else {`, `if let Some(mut guard) = ..`: the guard is
    // the pattern's inner binding, which is what `drop(guard)` names. Read as
    // the pattern's head, every let-else guard was named `Ok` and no `drop`
    // could ever release it (rev5C#1).
    let rest = ["Ok(", "Some("]
        .iter()
        .find_map(|head| rest.strip_prefix(head))
        .map(|inner| {
            let inner = inner.trim_start();
            inner.strip_prefix("mut ").unwrap_or(inner).trim_start()
        })
        .unwrap_or(rest);
    rest.chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect()
}

/// Receivers whose fields are the locks this census is about. A local named
/// `pivot_state` / `user_files_state` counts too -- the pass locks several.
///
/// `slicers` too (BUG-0593): the object-binding contexts hold the slicer store
/// as a field named `slicers` (`ctx.slicers.slicers.read()`,
/// `cx.slicers.slicers.read()`), and without this every one of those
/// acquisitions of the store was invisible to every census here. It is the
/// only lock reached through a receiver of that name in the crate. (They read
/// as ACQUISITIONS; a guard bound through a context path -- `let g =
/// ctx.x.y.read()` -- is never read as HELD, because the `let` test looks for
/// `=` right before the receiver. Each of the five was read by hand for
/// BUG-0593: every one is a scoped copy or an `if let` block.)
fn is_state_receiver(name: &str) -> bool {
    name == "state" || name.ends_with("_state") || name == "slicers"
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
    // `map.remove(k)` hands back the REMOVED VALUE, never the guard, so
    // `let saved = state.x.lock().unwrap().remove(&k);` binds an owned value
    // and the guard dies at the `;`. Missing here, it read as a held guard as
    // soon as the census could see split chains (fix round 4:
    // `anim_restore_inner`'s snapshot take, written over five lines).
    ".remove(",
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

/// BLANK THE INSIDE OF EVERY LITERAL, keeping the text's shape.
///
/// The census counts braces to know when a guard's block ends, and it counted
/// them in string and char literals too. `format!("Pivot table {} not found",
/// id)` is one `{` and one `}` on one line; closes are applied before opens
/// (see `grid_locks_taken_while_holding`), so the depth dipped below the
/// guard's own block for a moment and the guard it was tracking was
/// FORGOTTEN. That is how `get_pivot_source_data` held `pivot_tables` while it
/// took `grids` -- a direct ABBA against the calculation pass -- with this
/// census green (fix round 3, review finding 3). A string can also hold
/// `state.grids.read(` or `//` (a URL), which read as an acquisition and as a
/// comment start.
///
/// So the inside of every string, raw string (`r#"..."#`), byte string and
/// char literal (`'{'`, `'"'`, `'\''`) becomes spaces, and so does every block
/// comment. Delimiters, line comments (the callers strip those themselves) and
/// EVERY NEWLINE stay, so line numbers and column positions are unchanged. A
/// lifetime (`'a`, `'static`) is not a char literal and is left alone; a quote
/// inside a line comment (`// don't`) opens nothing.
fn blank_literals(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(text.len());
    let is_ident = |c: char| c.is_alphanumeric() || c == '_';
    let blank = |c: char| if c == '\n' || c == '\r' { c } else { ' ' };
    let mut i = 0usize;
    while i < n {
        let c = chars[i];
        // A line comment: copied through verbatim, so a quote in it opens nothing.
        if c == '/' && i + 1 < n && chars[i + 1] == '/' {
            while i < n && chars[i] != '\n' {
                out.push(chars[i]);
                i += 1;
            }
            continue;
        }
        // A block comment (they nest): blanked.
        if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            let mut depth = 0i32;
            while i < n {
                if chars[i] == '/' && i + 1 < n && chars[i + 1] == '*' {
                    depth += 1;
                    out.push_str("  ");
                    i += 2;
                    continue;
                }
                if chars[i] == '*' && i + 1 < n && chars[i + 1] == '/' {
                    depth -= 1;
                    out.push_str("  ");
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                    continue;
                }
                out.push(blank(chars[i]));
                i += 1;
            }
            continue;
        }
        // A raw string: `r"..."`, `r#"..."#`, `br"..."`. `r#ident` (a raw
        // identifier) has no quote after its hashes and falls through.
        let starts_word = i == 0 || !is_ident(chars[i - 1]) || (chars[i - 1] == 'b' && (i < 2 || !is_ident(chars[i - 2])));
        if c == 'r' && starts_word {
            let mut j = i + 1;
            let mut hashes = 0usize;
            while j < n && chars[j] == '#' {
                hashes += 1;
                j += 1;
            }
            if j < n && chars[j] == '"' {
                for &k in &chars[i..=j] {
                    out.push(k);
                }
                i = j + 1;
                while i < n {
                    if chars[i] == '"' && (0..hashes).all(|h| i + 1 + h < n && chars[i + 1 + h] == '#') {
                        out.push('"');
                        for _ in 0..hashes {
                            out.push('#');
                        }
                        i += 1 + hashes;
                        break;
                    }
                    out.push(blank(chars[i]));
                    i += 1;
                }
                continue;
            }
        }
        // An ordinary (or byte) string, with its escapes.
        if c == '"' {
            out.push('"');
            i += 1;
            while i < n {
                if chars[i] == '\\' && i + 1 < n {
                    out.push(' ');
                    out.push(blank(chars[i + 1]));
                    i += 2;
                    continue;
                }
                if chars[i] == '"' {
                    out.push('"');
                    i += 1;
                    break;
                }
                out.push(blank(chars[i]));
                i += 1;
            }
            continue;
        }
        // A char literal -- or a lifetime / loop label, which is left alone.
        if c == '\'' {
            if i + 1 < n && chars[i + 1] == '\\' {
                // `'\n'`, `'\''`, `'\u{7F}'`: the escaped char is skipped, then
                // the literal ends at the next quote on this line.
                let mut j = i + 3;
                while j < n && chars[j] != '\'' && chars[j] != '\n' {
                    j += 1;
                }
                if j < n && chars[j] == '\'' {
                    out.push('\'');
                    for &k in &chars[i + 1..j] {
                        out.push(blank(k));
                    }
                    out.push('\'');
                    i = j + 1;
                    continue;
                }
            } else if i + 2 < n && chars[i + 2] == '\'' && chars[i + 1] != '\n' {
                out.push_str("' '");
                i += 3;
                continue;
            }
            out.push(c);
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// The text a METHOD-CHAIN continuation line belongs to.
///
/// ```text
/// let bi_meta = pivot_state
///     .bi_metadata
///     .read()
/// ```
///
/// Judged alone, the third line has no receiver: the name before `.read(` is
/// empty, `acquisitions_in` skipped it, and the guard -- bound, and alive for
/// the rest of the block -- was invisible (fix round 3: the grid-backed
/// drill-through held `pivot_tables` and `bi_metadata`, both taken this way,
/// while it read `grids`). For a line whose code starts with `.`, this returns
/// the lines above it back to the chain's head (the first line that does not
/// start with `.`), the head with its indentation and every link trimmed, so
/// `prefix + line.trim_start()` reads as the one-line statement. Empty for a
/// line that continues nothing.
fn chain_prefix(code: &[&str], i: usize) -> String {
    if !code[i].trim_start().starts_with('.') {
        return String::new();
    }
    let mut pieces: Vec<&str> = Vec::new();
    let mut head: Option<usize> = None;
    let mut j = i;
    let mut steps = 0;
    while j > 0 && steps < 8 {
        j -= 1;
        steps += 1;
        let prev = code[j];
        let t = prev.trim();
        if t.is_empty() {
            continue;
        }
        if t.ends_with(';') || t.ends_with('{') || t.ends_with('}') {
            // A finished statement or a block edge: nothing to continue.
            break;
        }
        if t.starts_with('.') {
            pieces.push(t);
            continue;
        }
        pieces.push(prev.trim_end());
        head = Some(j);
        break;
    }
    pieces.reverse();
    // The chain's head can itself follow a `let` split after its `=`
    // (`let_head_above`): then the statement starts there.
    let above = head.map(|h| let_head_above(code, h)).unwrap_or_default();
    format!("{}{}", above, pieces.concat())
}

/// The `let` head of a statement split RIGHT AFTER ITS `=`.
///
/// ```text
/// let sheet_names_for_the_whole_workbook_guard =
///     state.sheet_names.read().unwrap();
/// ```
///
/// rustfmt breaks a long binding exactly there. Judged alone, the second line
/// has no `let` and nothing before its receiver, so the guard read as a
/// temporary that died at the `;` -- and whatever it was held across was
/// invisible to all three censuses (fix round 5, the review of round 4: the
/// same split-statement class as blind spot (c); ten statements in the crate
/// have the shape, every one consuming its guard today). For line `i`, when
/// the nearest code line above it is a `let` ending in a BARE `=` (not `==`,
/// `<=`, `+=` or another operator ending in one), returns that line trimmed
/// at the end plus a space, so `head + line.trim_start()` reads as the
/// one-line statement. Empty otherwise.
fn let_head_above(code: &[&str], i: usize) -> String {
    const OPERATORS_ENDING_IN_EQUALS: [&str; 12] =
        ["==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "^=", "|=", "&="];
    let mut j = i;
    while j > 0 {
        j -= 1;
        let t = code[j].trim();
        if t.is_empty() {
            continue;
        }
        let bare_equals = t.ends_with('=') && !OPERATORS_ENDING_IN_EQUALS.iter().any(|op| t.ends_with(op));
        if bare_equals && t.contains("let ") {
            return format!("{} ", code[j].trim_end());
        }
        return String::new();
    }
    String::new()
}

/// Every acquisition on line `i` of `code`, read as the whole statement when
/// the line continues a method chain (`chain_prefix`), plus that statement's
/// text (for the caller's `let` question). Only a call whose method is ON this
/// line counts, so a chain is never counted once per link.
fn acquisitions_at(code: &[&str], i: usize, tail: &str) -> (Vec<Acquisition>, String) {
    let mut prefix = chain_prefix(code, i);
    if prefix.is_empty() {
        // Not a chain continuation, but perhaps the right-hand side of a `let`
        // split after its `=` (`let_head_above`).
        prefix = let_head_above(code, i);
    }
    if prefix.is_empty() {
        return (acquisitions_in(code[i], tail), code[i].to_string());
    }
    let joined = format!("{}{}", prefix, code[i].trim_start());
    let found = acquisitions_in(&joined, tail)
        .into_iter()
        .filter(|a| a.col >= prefix.len())
        .collect();
    (found, joined)
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
    // `.lock_pending(` WAITS FOR THE LOCK exactly as `.write(` does -- it is
    // the same `Mutex::lock` with the dirty decision postponed -- and it was
    // missing here, so every guard taken that way was invisible to all three
    // censuses (fix round 4: `drill_through_to_sheet` took `sheet_names`,
    // `grids` and `active_sheet` that way and then waited for `grid`, and
    // `rename_sheet_inner` held `sheet_names` the same way while it took both
    // grid locks). `.lock(` does not match inside `.lock_pending(`, so the two
    // can never double-count one call.
    for method in [".read(", ".write(", ".lock(", ".lock_pending("] {
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
            // `controls` names TWO locks: AppState's control store and the pane
            // controls' own (`PaneControlState::controls`, reached as
            // `pane_control_state.controls` / `pane_state.controls`). Read as one,
            // a pane-control command holding ITS store across an undo record
            // paired with a structural edit taking AppState's under the stack
            // (round 8). The pane's is named apart.
            let field = if field == "controls" && recv.starts_with("pane") { "pane_controls" } else { field };
            // `*state.active_sheet.read()...` copies the value out; the guard
            // is a temporary that dies at the `;`.
            let deref_copied = head.ends_with('*');
            let rest_of_line = &line[at + method.len()..];
            let consumed = CONSUMING.iter().any(|c| rest_of_line.contains(c))
                || (!rest_of_line.contains(';')
                    && CONSUMING.iter().any(|c| tail.contains(c)))
                || (trailing_ident(head) == "match" && match_arm_consumes_the_guard(&format!("{rest_of_line}{tail}")));
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
                method,
            });
        }
    }
    out.sort_by_key(|a| a.col);
    out
}

/// After `let x = match state.y.lock()`: does the `Ok` arm do something with the
/// guard OTHER than hand it to `x`? `text` is the rest of the statement.
///
/// `let g = match state.y.lock() { Ok(g) => g, Err(_) => return };` binds the
/// guard, and `x` holds the lock for the rest of its block. But
/// `let pruned = match state.object_scripts.write(&effect) { Ok(mut scripts) =>
/// take_object_scripts(&mut scripts, ..), Err(_) => Vec::new() };` (the table
/// and name deletes) consumes it inside the arm: the lock is released at the
/// `;` and `pruned` holds what the arm made. Read as bound, those deletes held
/// `object_scripts` across their undo records (round 8). `false` -- the guard is
/// bound -- when the arm is exactly its binding, or when no `Ok(` arm is in
/// sight, which keeps the over-approximation.
fn match_arm_consumes_the_guard(text: &str) -> bool {
    let Some(at) = text.find("Ok(") else {
        return false;
    };
    let rest = text[at + "Ok(".len()..].trim_start();
    let rest = rest.strip_prefix("mut ").unwrap_or(rest).trim_start();
    let binding: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    if binding.is_empty() {
        return false;
    }
    let Some(arm) = rest[binding.len()..].trim_start().strip_prefix(')') else {
        return false;
    };
    let Some(arm) = arm.trim_start().strip_prefix("=>") else {
        return false;
    };
    let arm = arm.trim_start();
    let yields_the_guard = arm
        .strip_prefix(binding.as_str())
        .is_some_and(|after| after.trim_start().starts_with([',', '}']));
    !yields_the_guard
}

/// Every `.authorize(` call on one line of code: `(column, receiver)`.
fn authorized_on_line(line: &str) -> Vec<(usize, String)> {
    line.match_indices(".authorize(")
        .map(|(at, _)| (at, trailing_ident(&line[..at]).to_string()))
        .filter(|(_, receiver)| !receiver.is_empty())
        .collect()
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
///     guard the `if` arm bound. The braces are therefore read IN ORDER
///     (`brace_profile`), so that line dips below the arm's depth. Without
///     this, `protection.rs`'s two-armed
///     `if sheet_index == active_sheet { grid } else { grids }` reads as one
///     arm holding the other arm's guards. (It was "closes before opens" until
///     rev5C#1, which also dipped on `{ return; }` and forgot every guard bound
///     beside a one-line block -- see `brace_profile`.)
fn grid_locks_taken_while_holding(file: &str, text: &str) -> Vec<GridLockHolder> {
    // The crate's ONE list of function-start spellings: this census kept its
    // own and lacked `pub(super) async fn` (fix round 5).
    use crate::formula_serialisation_tests::starts_a_function;
    // Literals blanked FIRST: see `blank_literals` for the brace it hid.
    let stripped = blank_literals(&strip_cfg_test_items(text));
    let lines: Vec<&str> = stripped.lines().collect();
    // Code only: a census that reads comments accepts a commented-out call.
    let code: Vec<&str> = lines
        .iter()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect();

    let mut out = Vec::new();
    let mut current: Option<String> = None;
    let mut depth: i32 = 0;
    // (store, scope, fresh): `fresh` is `Some(survives)` on the line that bound
    // the guard, which judged it by its own column (`guard_scope_on_line`).
    let mut held: Vec<(String, i32, Option<bool>)> = Vec::new();
    // The SAME guards, tracked by binding name, for the re-entrancy question.
    //
    // Two lists rather than one, and the difference is the point. For the ORDER
    // question `held` is cleared by ANY `drop(`: that under-approximates, which
    // is the safe direction there (a missed report costs an argument). For the
    // RE-ENTRANCY question the same rule is the UNSAFE direction — a function
    // that drops four unrelated guards and then re-takes `grids` would go
    // unreported, and `apply_override_value_to_grid` is exactly that shape. So
    // this list releases only the guard `drop(name)` actually names.
    let mut held_named: Vec<(String, String, i32, Option<bool>)> = Vec::new();
    // Depth at which a closure handed to `spawn` opened, while it is open.
    let mut spawn_until: Option<i32> = None;

    for (i, raw) in lines.iter().enumerate() {
        if starts_a_function(raw) {
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
        let (acquisitions, statement) = if spawn_until.is_some() {
            (Vec::new(), line.to_string())
        } else {
            acquisitions_at(&code, i, &tail)
        };
        for acq in acquisitions {
            if held_named.iter().any(|(f, _, _, _)| *f == acq.field) {
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
                    .filter(|(f, _, _)| !(acq.field == "grids" && f == "grid"))
                    .map(|(f, _, _)| f.clone())
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
                // being a `let` is what tells them apart. A one-line
                // `let Ok(g) = .. else { return };` is a `let` too, and its
                // guard outlives the line (`guard_scope_on_line`).
                let is_let_binding = statement.trim_start().starts_with("let ");
                let at = column_in_line(&code, i, acq.col);
                let (scope, survives) = guard_scope_on_line(line, at, depth, is_let_binding);
                held.push((acq.field.clone(), scope, Some(survives)));
                held_named.push((acq.field, acq.binding, scope, Some(survives)));
            }
        }
        if let Some(rest) = line.split_once("drop(") {
            held.clear();
            let dropped: String = rest
                .1
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            held_named.retain(|(_, name, _, _)| *name != dropped);
        }
        // The braces IN ORDER (`brace_profile`): `} else {` ends the arm's
        // guards; a block that opens and closes on this line ends nothing.
        let (lowest, end) = brace_profile(line.as_bytes(), depth);
        held.retain(|(_, d, fresh)| fresh.unwrap_or(lowest >= *d));
        held_named.retain(|(_, _, d, fresh)| fresh.unwrap_or(lowest >= *d));
        for (_, _, fresh) in &mut held {
            *fresh = None;
        }
        for (_, _, _, fresh) in &mut held_named {
            *fresh = None;
        }
        depth = end;
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
        (
            // rev5C#1. A ONE-LINE let-else binds a guard that outlives its
            // line; read closes-first, its `{ return }` dipped below the
            // guard's depth and the census forgot it on the line that bound
            // it. `table_deps::refresh_reader_edges` held the three name stores
            // exactly this way while it took `grid`.
            "guards bound by one-line let-else",
            "pub fn f(state: &AppState) {\n    let Ok(named_ranges) = state.named_ranges.read() else { return };\n    let Ok(tables) = state.tables.read() else { return };\n    let Ok(grid) = state.grid.read() else { return };\n}\n",
        ),
        (
            // The same blind spot without a let-else: any block that opens
            // and closes on one line ended every guard bound beside it.
            "a one-line block beside a held guard",
            "pub fn f(state: &AppState) {\n    let n = state.named_ranges.read().unwrap();\n    if n.is_empty() { return; }\n    let g = state.grid.read().unwrap();\n}\n",
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
        (
            // The counterparts to the one-line teeth (rev5C#1): a header whose
            // block closes on its own line ends its guard there...
            "a one-line if-let header ends its guard on its own line",
            "pub fn f(state: &AppState) {\n    if let Ok(mut p) = state.pending_recalc.read() { p.clear(); }\n    let g = state.grids.read().unwrap();\n}\n",
        ),
        (
            // ...a let-else guard is released by its own name...
            "a let-else guard released by drop",
            "pub fn f(state: &AppState) {\n    let Ok(n) = state.named_ranges.read() else { return };\n    drop(n);\n    let g = state.grid.read().unwrap();\n}\n",
        ),
        (
            // ...and `} else if let .. {` still ends the first arm's guards and
            // scopes its own to the second.
            "an else-if-let arm",
            "pub fn f(state: &AppState) {\n    if a {\n        let s = state.style_registry.read().unwrap();\n    } else if let Ok(t) = state.tables.read() {\n        t.len();\n    }\n    let g = state.grids.read().unwrap();\n}\n",
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
/// correction, which is the whole reason this pair got through. One store
/// against one store, read straight from the bodies: [`held_while_acquiring`]
/// with no call graph.
fn pair_inversions(file: &str, text: &str, held: &str, then: &str) -> Vec<PairInversion> {
    held_while_acquiring(file, text, &[held], &[then], &CallGraph::new())
        .into_iter()
        .map(|hit| PairInversion { file: hit.file, function: hit.function, line: hit.line })
        .collect()
}

/// One place where a function holds one of the `held` stores while it acquires
/// one of the `then` stores -- in its own body, or inside a crate function it
/// calls.
#[derive(Debug, Clone)]
struct HeldAcquisition {
    file: String,
    function: String,
    line: usize,
    /// The store acquired, here or inside `via`.
    acquiring: String,
    /// The `held` stores alive at that moment. Never `acquiring` itself: a store
    /// taken twice is the re-entrancy census's question, not an order.
    holding: Vec<String>,
    /// EVERY state guard alive at that moment, `held` or not -- what a gate
    /// exception reads.
    alive: Vec<String>,
    /// The crate function whose own body acquires `acquiring`, for a call.
    via: Option<String>,
}

/// What each free function of the crate acquires IN ITS OWN BODY, by name: the
/// one level of call graph [`held_while_acquiring`] reads a call through
/// ([`direct_acquisitions_by_function`]).
type CallGraph = std::collections::HashMap<String, Vec<String>>;

/// The name a function's first line declares.
fn function_name_of(raw: &str) -> Option<String> {
    raw.split("fn ").nth(1).map(|r| r.split(['(', '<']).next().unwrap_or("").to_string())
}

/// The rest of the statement line `i` starts: the following lines up to the one
/// that ends it. Capped at four, because an unterminated statement must not make
/// a census quadratic on a 27,000-line file.
fn statement_tail(code: &[&str], i: usize) -> String {
    let mut tail = String::new();
    for next in code.iter().skip(i + 1).take(4) {
        tail.push_str(next);
        if next.contains(';') {
            break;
        }
    }
    tail
}

/// The depths a line's braces walk through, IN ORDER, from `start`:
/// `(lowest, end)`, where `lowest` counts `start` itself.
///
/// The censuses used to apply a line's closes before its opens, for `} else {`:
/// its net delta is zero, yet it ends every guard the `if` arm bound. That rule
/// is right for a line that STARTS by closing a block and wrong for one that
/// opens and closes a block of its own -- `if x.is_empty() { return; }`,
/// `items.for_each(|i| { .. });`, `let Ok(g) = state.x.read() else { return };`
/// -- which ends nothing around it. Read closes-first, such a line dipped below
/// the depth of every guard bound beside it, and the census FORGOT each one: a
/// function that held `named_ranges` across a one-line `if` and then waited for
/// `grid` read as clean, and every one-line let-else guard in the crate was
/// invisible (rev5C#1: `table_deps::refresh_reader_edges` held the three name
/// stores, each bound that way, while it took `grid`). Reading the braces in
/// order tells the two shapes apart: `} else {` dips, `{ return; }` does not.
fn brace_profile(line: &[u8], start: i32) -> (i32, i32) {
    let mut depth = start;
    let mut lowest = start;
    for &b in line {
        if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            depth -= 1;
            lowest = lowest.min(depth);
        }
    }
    (lowest, depth)
}

/// Where a guard bound at byte `at` of `line` lives, with the line starting at
/// `depth`: `(scope, survives the line)`.
///
///   * a `let` binding lives at the depth of its statement, and survives the
///     line unless a brace after it closes that depth (`{ let g = ..; }`);
///   * an `if let` / `while let` HEADER lives inside the block it opens: to the
///     next line when the line ends by opening it, not past the line when the
///     block closes on it too.
fn guard_scope_on_line(line: &str, at: usize, depth: i32, is_let_binding: bool) -> (i32, bool) {
    let bytes = line.as_bytes();
    let at = at.min(bytes.len());
    let (_, here) = brace_profile(&bytes[..at], depth);
    let (lowest_after, end) = brace_profile(&bytes[at..], here);
    if is_let_binding {
        (here, lowest_after >= here)
    } else if line.trim_end().ends_with('{') {
        (end, true)
    } else {
        (here + 1, false)
    }
}

/// Every name a `drop(..)` on this line of code releases (`undrop(` and other
/// identifiers that merely END in `drop` are not `drop`).
fn dropped_on_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (at, _) in line.match_indices("drop(") {
        if line[..at].chars().last().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let name: String = line[at + "drop(".len()..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        if !name.is_empty() {
            out.push(name);
        }
    }
    out
}

/// The crate functions CALLED on one line of code, with their columns: an
/// identifier directly followed by `(` that `graph` knows -- bare (`helper(`) or
/// through a module path (`crate::m::helper(`). Never a method (`.helper(`), the
/// declaration itself (`fn helper(`), or a TYPE's associated function
/// (`SheetProvenance::snapshot(`), whose name may collide with a free one.
fn calls_on_line<'g>(line: &str, graph: &'g CallGraph) -> Vec<(usize, &'g str)> {
    let bytes = line.as_bytes();
    let is_ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if !is_ident(bytes[i]) || (i > 0 && is_ident(bytes[i - 1])) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && is_ident(bytes[i]) {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'(' {
            continue;
        }
        let before = line[..start].trim_end();
        if before.ends_with('.') {
            continue;
        }
        if let Some(head) = before.strip_suffix("fn") {
            if !head.ends_with(|c: char| c.is_ascii_alphanumeric() || c == '_') {
                continue;
            }
        }
        if let Some(path) = before.strip_suffix("::") {
            let segment = path.rsplit(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).next().unwrap_or("");
            if segment.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
                continue;
            }
        }
        if let Some((name, _)) = graph.get_key_value(&line[start..i]) {
            out.push((start, name.as_str()));
        }
    }
    out
}

/// Every place in `text` where a function holds one of `held` while it acquires
/// one of `then`: [`pair_inversions`] generalised the three ways the round-6
/// censuses need.
///
///   * SEVERAL stores on each side, in one walk of the file.
///   * A CALL counts as acquiring what the callee's own body acquires (`graph`),
///     because the deadlock R5-PREVIEW-SUBS-DEADLOCK names goes through one: a
///     cell writer holds `sheet_names` and THEN calls
///     `record_subscription_override_edits`, which takes `subscriptions` -- an
///     edge no census here could see while it read bodies alone. One level, and
///     only the names the graph holds ([`direct_acquisitions_by_function`]).
///   * `drop(x)` releases the guard BOUND TO `x`, not every guard. Clearing them
///     all was the under-approximating choice -- a function that dropped one
///     guard and then waited on an inverted lock read as clean -- and
///     `build_workbook_for_save` was exactly that shape: it dropped the grid
///     guards and went on holding `sheet_ids` across the user files. Every
///     census built on this was re-run with the change and found nothing it had
///     not found before; the extra precision is in the direction a census is for.
///
/// A MOMENTARY acquisition of a `then` store counts exactly as a held one: the
/// thread still waits for the lock. A spawned closure is another thread and is
/// skipped, as in every census here.
fn held_while_acquiring(
    file: &str,
    text: &str,
    held: &[&str],
    then: &[&str],
    graph: &CallGraph,
) -> Vec<HeldAcquisition> {
    // The crate's ONE list of function-start spellings: this census kept its
    // own and lacked `pub(super) async fn` (fix round 5).
    use crate::formula_serialisation_tests::starts_a_function;
    // Literals blanked FIRST: see `blank_literals` for the brace it hid.
    let stripped = blank_literals(&strip_cfg_test_items(text));
    let lines: Vec<&str> = stripped.lines().collect();
    let code: Vec<&str> = lines
        .iter()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect();

    /// A live guard: its store, the name it is bound to, the depth it lives to.
    struct Guard {
        field: String,
        binding: String,
        scope: i32,
        /// `Some(survives)` on the line that bound it, which judged it by its
        /// own column ([`guard_scope_on_line`]); `None` from the next line on.
        fresh: Option<bool>,
    }
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    let mut depth: i32 = 0;
    let mut alive: Vec<Guard> = Vec::new();
    let mut spawn_until: Option<i32> = None;

    for (i, raw) in lines.iter().enumerate() {
        let declares = starts_a_function(raw);
        if declares {
            current = function_name_of(raw);
            depth = 0;
            alive.clear();
            spawn_until = None;
        }
        let line = code[i];
        let opens_here = line.matches('{').count() as i32;
        let closes_here = line.matches('}').count() as i32;
        if spawn_until.is_none() && line.contains("spawn(") && opens_here > closes_here {
            spawn_until = Some(depth);
        }
        // (column, store, live, binding, via): this line's own acquisitions, then
        // each call's, at the call's column.
        let mut events: Vec<(usize, String, bool, String, Option<String>)> = Vec::new();
        let mut statement = line.to_string();
        if spawn_until.is_none() {
            let (acquisitions, joined) = acquisitions_at(&code, i, &statement_tail(&code, i));
            statement = joined;
            events.extend(acquisitions.into_iter().map(|a| (a.col, a.field, a.live, a.binding, None)));
            if !declares {
                for (col, callee) in calls_on_line(line, graph) {
                    if current.as_deref() == Some(callee) {
                        continue; // recursion takes nothing the body has not
                    }
                    for field in &graph[callee] {
                        events.push((col, field.clone(), false, String::new(), Some(callee.to_string())));
                    }
                }
            }
        }
        events.sort_by_key(|event| event.0);
        for (col, field, live, binding, via) in events {
            if then.contains(&field.as_str()) {
                let mut holding: Vec<String> = Vec::new();
                let mut all: Vec<String> = Vec::new();
                for guard in &alive {
                    if guard.field != field && held.contains(&guard.field.as_str()) && !holding.contains(&guard.field) {
                        holding.push(guard.field.clone());
                    }
                    if !all.contains(&guard.field) {
                        all.push(guard.field.clone());
                    }
                }
                if let (false, Some(function)) = (holding.is_empty(), current.clone()) {
                    out.push(HeldAcquisition {
                        file: file.to_string(),
                        function,
                        line: i + 1,
                        acquiring: field.clone(),
                        holding,
                        alive: all,
                        via: via.clone(),
                    });
                }
            }
            if live {
                // A guard bound in an `if let` / `while let` HEADER lives inside
                // the block that opens on the same line; a `let x = match .. {`
                // binding outlives it (see `grid_locks_taken_while_holding`), and
                // so does a one-line `let Ok(x) = .. else { return };`.
                let is_let_binding = statement.trim_start().starts_with("let ");
                let at = column_in_line(&code, i, col);
                let (scope, survives) = guard_scope_on_line(line, at, depth, is_let_binding);
                alive.push(Guard { field, binding, scope, fresh: Some(survives) });
            }
        }
        // `.authorize(` MOVES a pending guard (`PendingGuard::authorize` takes
        // `self`). Bound by a `let`, the guard now lives as long as THAT binding
        // -- `let updated = { let mut slicers = pending.authorize(&effect); .. };`
        // releases the store at the block's end, though `pending` itself was
        // bound outside it; unbound (`pending.authorize(&effect).remove(..)`), it
        // is a temporary that dies with the statement. Read as still bound to
        // `pending`, every slicer and control writer of that shape held its store
        // across the undo record it takes after the block (round 8).
        for (at, receiver) in authorized_on_line(line) {
            let Some(pos) = alive.iter().position(|g| !g.binding.is_empty() && g.binding == receiver) else {
                continue;
            };
            let mut guard = alive.remove(pos);
            if statement.trim_start().starts_with("let ") {
                let (scope, survives) = guard_scope_on_line(line, at, depth, true);
                guard.binding = binding_name(line);
                guard.scope = scope;
                guard.fresh = Some(survives);
                alive.push(guard);
            }
        }
        let dropped = dropped_on_line(line);
        alive.retain(|guard| guard.binding.is_empty() || !dropped.contains(&guard.binding));
        // The braces IN ORDER (`brace_profile`): a block that opens and closes
        // on this line ends nothing around it.
        let (lowest, end) = brace_profile(line.as_bytes(), depth);
        alive.retain(|guard| guard.fresh.unwrap_or(lowest >= guard.scope));
        for guard in &mut alive {
            guard.fresh = None;
        }
        depth = end;
        if spawn_until.is_some_and(|d| depth <= d) {
            spawn_until = None;
        }
    }
    out
}

/// What each free function of the crate acquires in its OWN body, by name -- the
/// one level of call graph [`held_while_acquiring`] reads a call through.
///
/// A name that more than one free function declares is LEFT OUT: a call to it
/// cannot be told apart from the others, and charging it with all of their
/// stores would fail a census on a function that takes none of them. That
/// under-approximates through those few names (79 of some 4,000 today); every
/// body is still read directly. A spawned closure's acquisitions belong to
/// another thread, and an impl block's methods to no free function, so neither
/// is charged to the function above it.
fn direct_acquisitions_by_function(sources: &[(String, String)]) -> CallGraph {
    use crate::formula_serialisation_tests::starts_a_function;
    let mut graph = CallGraph::new();
    let mut declared: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (_, text) in sources {
        let stripped = blank_literals(&strip_cfg_test_items(text));
        let lines: Vec<&str> = stripped.lines().collect();
        let code: Vec<&str> = lines.iter().map(|l| l.split("//").next().unwrap_or("")).collect();
        let mut current: Option<String> = None;
        let mut depth: i32 = 0;
        let mut entered = false;
        let mut spawn_until: Option<i32> = None;
        for (i, raw) in lines.iter().enumerate() {
            if starts_a_function(raw) {
                current = function_name_of(raw);
                if let Some(name) = &current {
                    *declared.entry(name.clone()).or_default() += 1;
                }
                depth = 0;
                entered = false;
                spawn_until = None;
            }
            let line = code[i];
            let opens_here = line.matches('{').count() as i32;
            let closes_here = line.matches('}').count() as i32;
            if spawn_until.is_none() && line.contains("spawn(") && opens_here > closes_here {
                spawn_until = Some(depth);
            }
            if let (Some(name), None) = (&current, spawn_until) {
                let (acquisitions, _) = acquisitions_at(&code, i, &statement_tail(&code, i));
                let fields = graph.entry(name.clone()).or_default();
                for acq in acquisitions {
                    if !fields.contains(&acq.field) {
                        fields.push(acq.field);
                    }
                }
            }
            depth -= closes_here;
            depth += opens_here;
            entered |= opens_here > 0;
            if spawn_until.is_some_and(|d| depth <= d) {
                spawn_until = None;
            }
            // The body closed: what follows (an impl block, a static) is nobody's.
            if entered && depth <= 0 {
                current = None;
                entered = false;
            }
        }
    }
    graph.retain(|name, fields| declared.get(name) == Some(&1) && !fields.is_empty());
    graph
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
    // The pass's body is `recalculate_sheet_values_with` since round 8:
    // `recalculate_sheet_values` and an update's `recalculate_installed_sheet_values`
    // both delegate to it.
    let pass = function_body(calc, "fn recalculate_sheet_values_with(");
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

/// C9 (tooling). The census reports `line {}` so a reader can go straight to the
/// offence, and it measured that line in the text AFTER `strip_cfg_test_items`
/// had removed every `#[cfg(test)]` item. A test module ABOVE the offending
/// function therefore moved every reported line up by the module's length, so
/// the message pointed at unrelated code. The strip now keeps one blank line
/// per removed line, and every census built on it reports the file's own line.
#[test]
fn a_reported_line_is_the_files_own_line_even_after_a_test_module() {
    let src = "#[cfg(test)]\nmod tests {\n    fn helper() {\n        let x = \"}\";\n    }\n}\n\npub fn f(state: &AppState) {\n    let tables = state.tables.read().ok();\n    let sheet_names = state.sheet_names.read().ok();\n}\n";
    let found = pair_inversions("planted.rs", src, "tables", "sheet_names");
    assert_eq!(found.len(), 1, "the planted inversion must be found");
    let actual = src
        .lines()
        .position(|l| l.contains("state.sheet_names.read("))
        .unwrap()
        + 1;
    assert_eq!(
        found[0].line, actual,
        "the census must report the file's own line ({actual}), not a line counted after \
         the test module was removed"
    );
    // The strip keeps the file's shape: same number of lines, test lines blank.
    let stripped = strip_cfg_test_items(src);
    assert_eq!(stripped.lines().count(), src.lines().count());
    assert!(!stripped.contains("helper"), "the test module's body is still removed");
    // A `#[cfg(test)] mod x;` declaration (no body) keeps the shape too.
    let decl = "#[cfg(test)]\n#[path = \"x_tests.rs\"]\nmod x_tests;\nfn g() {}\n";
    let stripped_decl = strip_cfg_test_items(decl);
    assert_eq!(stripped_decl.lines().count(), decl.lines().count());
    assert_eq!(stripped_decl.lines().nth(3), Some("fn g() {}"));
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

// ===========================================================================
// FIX ROUND 4: THE THREE BLIND SPOTS ROUND 3 DEMONSTRATED
// ===========================================================================
//
// Each was a real acquisition this census could not see, and each hid a real
// inversion while the gate stayed green:
//
//   (a) `lock_pending()` was not an acquisition at all (`drill_through_to_sheet`
//       took `sheet_names`, `grids` and `active_sheet` that way and then waited
//       for `grid`);
//   (b) a `{}` inside a string literal dipped the brace depth and made the scan
//       forget the guard it was tracking (`get_pivot_source_data` held
//       `pivot_tables` while it took `grids`);
//   (c) a method chain split over lines left `.read()` with no name before it
//       (the grid-backed drill-through held `pivot_tables` and `bi_metadata`,
//       both taken that way, while it read `grids`).
//
// Each fixture below is the defect's own shape; the census must FLAG it.

#[test]
fn the_census_sees_a_lock_pending_acquisition() {
    let held_then_grids = "pub fn f(state: &AppState) {\n    let n = state.sheet_names.lock_pending().unwrap();\n    let g = state.grids.lock_pending().unwrap();\n}\n";
    let found = grid_locks_taken_while_holding("planted.rs", held_then_grids);
    assert_eq!(
        found.len(),
        1,
        "the grid census cannot see a guard taken with lock_pending(): {:?}",
        found
    );
    assert_eq!(found[0].holding, vec!["sheet_names".to_string()], "{:?}", found);

    let pair = "pub fn f(state: &AppState) {\n    let t = state.tables.lock_pending().unwrap();\n    let n = state.sheet_names.lock_pending().unwrap();\n}\n";
    assert_eq!(
        pair_inversions("planted.rs", pair, "tables", "sheet_names").len(),
        1,
        "the pair census cannot see a guard taken with lock_pending()"
    );

    let inverted = "pub fn f(state: &AppState) {\n    let gs = state.grids.lock_pending().unwrap();\n    let g = state.grid.lock_pending().unwrap();\n}\n";
    assert_eq!(
        inverted_grid_lock_holders("planted.rs", inverted).len(),
        1,
        "the grid/grids census cannot see a guard taken with lock_pending()"
    );
}

#[test]
fn a_brace_or_quote_inside_a_literal_does_not_hide_a_held_guard() {
    let cases: &[(&str, &str)] = &[
        (
            // `get_pivot_source_data` as it stood.
            "a format string's {}",
            r##"pub fn f(state: &AppState, pivot_state: &PivotState) {
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let d = pivot_tables.get(&id).ok_or_else(|| format!("Pivot table {} not found", id))?;
    let grids = state.grids.read().unwrap();
}
"##,
        ),
        (
            "a lone closing brace in a string",
            r##"pub fn f(state: &AppState, pivot_state: &PivotState) {
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    log("}");
    let grids = state.grids.read().unwrap();
}
"##,
        ),
        (
            "a closing brace char literal",
            r##"pub fn f(state: &AppState, pivot_state: &PivotState) {
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let close = '}';
    let grids = state.grids.read().unwrap();
}
"##,
        ),
        (
            "a raw string holding braces and quotes",
            r###"pub fn f(state: &AppState, pivot_state: &PivotState) {
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let json = r#"{"a": "}}"}"#;
    let grids = state.grids.read().unwrap();
}
"###,
        ),
        (
            "an escaped quote before a brace",
            r##"pub fn f(state: &AppState, pivot_state: &PivotState) {
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let s = "\"}";
    let grids = state.grids.read().unwrap();
}
"##,
        ),
        (
            // Lexed as a string opener, `'"'` would swallow everything up to the
            // next quote -- the grids acquisition with it.
            "a quote char literal opens no string",
            r##"pub fn f(state: &AppState) {
    let n = state.sheet_names.read().unwrap();
    let q = '"';
    let g = state.grids.read().unwrap();
    let r = '"';
}
"##,
        ),
        (
            // Same, for a quote inside a comment.
            "a quote inside a comment opens no string",
            r##"pub fn f(state: &AppState) {
    // a 5" gap
    let n = state.sheet_names.read().unwrap();
    let g = state.grids.read().unwrap();
    log("x");
}
"##,
        ),
    ];
    for (label, src) in cases {
        let found = grid_locks_taken_while_holding("planted.rs", src);
        assert_eq!(
            found.len(),
            1,
            "the census lost track of a held guard on the `{}` shape: {:?}",
            label,
            found
        );
        assert_eq!(found[0].acquiring, "grids", "`{}`: {:?}", label, found);
    }
    // The pair census shares the brace walk.
    let pair = r##"pub fn f(state: &AppState) {
    let t = state.tables.read().unwrap();
    let m = format!("{} tables", t.len());
    let n = state.sheet_names.read().unwrap();
}
"##;
    assert_eq!(
        pair_inversions("planted.rs", pair, "tables", "sheet_names").len(),
        1,
        "the pair census lost track of a guard after a format string's braces"
    );
}

#[test]
fn the_census_sees_a_lock_taken_through_a_method_chain_split_over_lines() {
    // The grid-backed drill-through as it stood: the held guard taken through a
    // chain, and the grid lock too.
    let chained = r##"pub fn f(state: &AppState, pivot_state: &PivotState) {
    let bi_meta = pivot_state
        .bi_metadata
        .read()
        .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
    let grids = state
        .grids
        .read()
        .map_err(|e| format!("grids lock poisoned: {}", e))?;
}
"##;
    let found = grid_locks_taken_while_holding("planted.rs", chained);
    assert_eq!(found.len(), 1, "a lock taken through a split method chain is invisible: {:?}", found);
    assert_eq!(found[0].acquiring, "grids", "{:?}", found);
    assert_eq!(found[0].holding, vec!["bi_metadata".to_string()], "{:?}", found);

    // The receiver on its own line too, and `lock_pending` through a chain.
    let receiver_split = "pub fn f(state: &AppState) {\n    let n = state\n        .sheet_names\n        .lock_pending()\n        .unwrap();\n    let g = state\n        .grid\n        .lock_pending()\n        .unwrap();\n}\n";
    let found = grid_locks_taken_while_holding("planted.rs", receiver_split);
    assert_eq!(found.len(), 1, "{:?}", found);
    assert_eq!(found[0].acquiring, "grid", "{:?}", found);

    let pair = "pub fn f(state: &AppState) {\n    let t = state\n        .tables\n        .read()\n        .unwrap();\n    let n = state\n        .sheet_names\n        .read()\n        .unwrap();\n}\n";
    assert_eq!(
        pair_inversions("planted.rs", pair, "tables", "sheet_names").len(),
        1,
        "the pair census cannot see a split method chain"
    );

    let inverted = "pub fn f(state: &AppState) {\n    let gs = state\n        .grids\n        .read()\n        .unwrap();\n    let g = state\n        .grid\n        .read()\n        .unwrap();\n}\n";
    assert_eq!(
        inverted_grid_lock_holders("planted.rs", inverted).len(),
        1,
        "the grid/grids census cannot see a split method chain"
    );
}

/// FIX ROUND 5 (the review of round 4, finding 3). rustfmt splits a long
/// binding right after its `=`, which leaves the lock call on a line with no
/// `let` before it; the census read that guard as a temporary, so everything
/// it was held across was invisible. The reviewer's fixture first, then the
/// same split over a method chain and over a `match`, then the pair and the
/// re-entrancy questions, which read guards the same way.
#[test]
fn the_census_sees_a_guard_whose_let_is_split_after_the_equals_sign() {
    let split = "pub fn f(state: &AppState) {\n    let sheet_names_for_the_whole_workbook_guard =\n        state.sheet_names.read().unwrap();\n    let g = state.grids.read().unwrap();\n}\n";
    let found = grid_locks_taken_while_holding("planted.rs", split);
    assert_eq!(found.len(), 1, "a guard bound by a `let` split after its `=` read as a temporary: {:?}", found);
    assert_eq!(found[0].acquiring, "grids", "{:?}", found);
    assert_eq!(found[0].holding, vec!["sheet_names".to_string()], "{:?}", found);

    let split_chain = "pub fn f(state: &AppState, pivot_state: &PivotState) {\n    let bi_meta =\n        pivot_state\n            .bi_metadata\n            .read()\n            .unwrap();\n    let grids = state.grids.read().unwrap();\n}\n";
    let found = grid_locks_taken_while_holding("planted.rs", split_chain);
    assert_eq!(found.len(), 1, "a split `let` over a method chain read as a temporary: {:?}", found);
    assert_eq!(found[0].holding, vec!["bi_metadata".to_string()], "{:?}", found);

    let split_match = "pub fn f(state: &AppState) {\n    let names =\n        match state.sheet_names.read() {\n            Ok(n) => n,\n            Err(_) => return,\n        };\n    let g = state.grid.read().unwrap();\n}\n";
    let found = grid_locks_taken_while_holding("planted.rs", split_match);
    assert_eq!(found.len(), 1, "a split `let ... = match` read as a temporary: {:?}", found);

    let pair = "pub fn f(state: &AppState) {\n    let t =\n        state.tables.read().unwrap();\n    let n = state.sheet_names.read().unwrap();\n}\n";
    assert_eq!(
        pair_inversions("planted.rs", pair, "tables", "sheet_names").len(),
        1,
        "the pair census cannot see a guard whose `let` is split after its `=`"
    );

    let twice = "pub fn f(state: &AppState) {\n    let first =\n        state.tables.read().unwrap();\n    let second = state.tables.read().unwrap();\n}\n";
    assert!(
        grid_locks_taken_while_holding("planted.rs", twice).iter().any(|h| h.reentrant),
        "the re-entrancy census cannot see a guard whose `let` is split after its `=`"
    );
}

/// ...and the split form stays quiet wherever the one-line form is quiet.
#[test]
fn a_split_let_that_consumes_releases_or_orders_its_guard_correctly_holds_nothing() {
    let cases: &[(&str, &str)] = &[
        (
            "consumed on the same line",
            "pub fn f(state: &AppState) {\n    let count =\n        state.sheet_names.read().unwrap().len();\n    let g = state.grids.read().unwrap();\n}\n",
        ),
        (
            "consumed on the next line",
            "pub fn f(state: &AppState) {\n    let names =\n        state.sheet_names.read().unwrap()\n            .clone();\n    let g = state.grids.read().unwrap();\n}\n",
        ),
        (
            "released by name",
            "pub fn f(state: &AppState) {\n    let names =\n        state.sheet_names.read().unwrap();\n    drop(names);\n    let g = state.grids.read().unwrap();\n}\n",
        ),
        (
            "the canonical order",
            "pub fn f(state: &AppState) {\n    let g =\n        state.grid.read().unwrap();\n    let gs =\n        state.grids.read().unwrap();\n}\n",
        ),
        (
            // Only a BARE `=` binds: a comparison split after `==` does not.
            "a comparison split after `==`",
            "pub fn f(state: &AppState) {\n    let same = expected ==\n        state.sheet_names.read().unwrap();\n    let g = state.grids.read().unwrap();\n}\n",
        ),
    ];
    for (label, src) in cases {
        let found = grid_locks_taken_while_holding("planted.rs", src);
        assert!(found.is_empty(), "the census fired on the `{}` shape, which is CORRECT code: {:?}", label, found);
    }
}

/// FIX ROUND 5 (the review of round 4, finding 4). Every census in this file
/// recognises a function start by the crate's ONE list
/// (`formula_serialisation_tests::FN_START_SPELLINGS`). The grid/grids census
/// kept its own and lacked `pub(super) async fn` -- the crate declares
/// `bi/model_editor.rs` functions that way -- so an inversion declared so was
/// charged to the function before it.
#[test]
fn every_lock_census_sees_every_function_start_spelling() {
    // A LITERAL list, not the constant: a spelling dropped from the constant
    // must fail here, not silently leave the loop.
    for start in [
        "fn ",
        "pub fn ",
        "pub(crate) fn ",
        "pub(super) fn ",
        "async fn ",
        "pub async fn ",
        "pub(crate) async fn ",
        "pub(super) async fn ",
    ] {
        let quiet = "pub fn before(state: &AppState) {\n    let n = 1;\n}\n\n";
        let inverted = format!(
            "{quiet}{start}offender(state: &AppState) {{\n    let gs = state.grids.read().unwrap();\n    let g = state.grid.read().unwrap();\n}}\n"
        );
        assert_eq!(
            inverted_grid_lock_holders("planted.rs", &inverted),
            vec![InvertedHolder { file: "planted.rs".to_string(), function: "offender".to_string() }],
            "the grid/grids census does not read `{start}` as the start of a function"
        );
        let holder = format!(
            "{quiet}{start}offender(state: &AppState) {{\n    let n = state.sheet_names.read().unwrap();\n    let g = state.grids.read().unwrap();\n}}\n"
        );
        let named: Vec<String> =
            grid_locks_taken_while_holding("planted.rs", &holder).into_iter().map(|h| h.function).collect();
        assert_eq!(named, vec!["offender".to_string()], "the grid census does not read `{start}` as the start of a function");
        let pair = format!(
            "{quiet}{start}offender(state: &AppState) {{\n    let t = state.tables.read().unwrap();\n    let n = state.sheet_names.read().unwrap();\n}}\n"
        );
        let named: Vec<String> =
            pair_inversions("planted.rs", &pair, "tables", "sheet_names").into_iter().map(|h| h.function).collect();
        assert_eq!(named, vec!["offender".to_string()], "the pair census does not read `{start}` as the start of a function");
    }
}

#[test]
fn the_sharpened_census_stays_quiet_on_correct_code() {
    let cases: &[(&str, &str)] = &[
        (
            "lifetimes are not char literals",
            r##"pub fn f<'a>(state: &'a AppState) -> &'a str {
    let g = state.grid.read().unwrap();
    let gs = state.grids.read().unwrap();
    let n = state.sheet_names.read().unwrap();
    ""
}
"##,
        ),
        (
            "an acquisition spelled inside a string is not code",
            r##"pub fn f(state: &AppState) {
    let n = state.sheet_names.read().unwrap();
    log("never state.grids.read() here");
}
"##,
        ),
        (
            "a chain consumed on a later line holds nothing",
            "pub fn f(state: &AppState) {\n    let n = state\n        .sheet_names\n        .read()\n        .map(|s| s.len())\n        .unwrap_or(0);\n    let g = state.grids.read().unwrap();\n}\n",
        ),
        (
            // A chain is ONE acquisition, not one per link: counted twice, the
            // second would read as `grid` taken while `grid` is held.
            "a chain is counted once",
            "pub fn f(state: &AppState) {\n    let g = state.grid.read()\n        .unwrap();\n    let gs = state.grids.read().unwrap();\n}\n",
        ),
        (
            "canonical order through lock_pending",
            "pub fn f(state: &AppState) {\n    let g = state.grid.lock_pending().unwrap();\n    let gs = state.grids.lock_pending().unwrap();\n    let n = state.sheet_names.lock_pending().unwrap();\n}\n",
        ),
    ];
    for (label, src) in cases {
        let found = grid_locks_taken_while_holding("planted.rs", src);
        assert!(found.is_empty(), "the census fired on the `{}` shape, which is CORRECT code: {:?}", label, found);
    }
}

#[test]
fn a_guard_consumed_by_remove_holds_nothing() {
    // `anim_restore_inner`'s snapshot take, as it is written: a chain over five
    // lines ending in `.remove(..)`, which binds the REMOVED VALUE. Before
    // `.remove(` was in CONSUMING, the sharpened census read the guard as held
    // across the grid locks taken below it.
    let src = "pub(crate) fn f(state: &AppState) {\n    let saved = state\n        .animation_snapshots\n        .lock()\n        .unwrap()\n        .remove(&params.token);\n    let mut grid = state.grid.write(&effect).unwrap();\n    let mut grids = state.grids.write(&effect).unwrap();\n}\n";
    let found = grid_locks_taken_while_holding("planted.rs", src);
    assert!(found.is_empty(), "a guard consumed by .remove() read as held: {:?}", found);
    // ...while a guard BOUND and then used for a remove is still held.
    let held = "pub(crate) fn f(state: &AppState) {\n    let mut snaps = state.animation_snapshots.lock().unwrap();\n    let saved = snaps.remove(&params.token);\n    let mut grid = state.grid.write(&effect).unwrap();\n}\n";
    assert_eq!(grid_locks_taken_while_holding("planted.rs", held).len(), 1, "a bound guard must stay held");
}

/// NON-VACUITY for `blank_literals` over the REAL crate: blanking must keep
/// every file's line count (so line numbers and spans still mean what they
/// meant), and it must never swallow a line of RUST code into a literal. A
/// mis-lexed quote -- a char literal read as a string opener, a lifetime read
/// as a char literal -- would silently blank everything up to the next quote,
/// and this census would then report "no violations" for code it never read.
/// The only lines blanked are literal contents; the JavaScript embedded in
/// `calp_commands.rs` and `script_frame.rs` is exactly that, and none of it
/// starts the way a Rust statement does.
#[test]
fn blanking_literals_swallows_no_rust_code_anywhere_in_the_crate() {
    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_rs_files(&src_root, &mut files);
    assert!(files.len() > 50, "the walk is not finding the crate");
    let mut offenders: Vec<String> = Vec::new();
    let mut blanked_any = 0usize;
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
            .replace(std::path::MAIN_SEPARATOR, "/");
        let stripped = strip_cfg_test_items(&text);
        let blanked = blank_literals(&stripped);
        let before: Vec<&str> = stripped.lines().collect();
        let after: Vec<&str> = blanked.lines().collect();
        if before.len() != after.len() {
            offenders.push(format!("  {}: {} lines became {}", rel, before.len(), after.len()));
            continue;
        }
        for (i, (was, now)) in before.iter().zip(after.iter()).enumerate() {
            let code = was.split("//").next().unwrap_or("").trim();
            if code.is_empty() || !now.trim().is_empty() {
                continue;
            }
            blanked_any += 1;
            let rust_statement = ["let ", "let mut ", "pub fn ", "pub(crate) fn ", "fn ", "match ", "state."]
                .iter()
                .any(|p| code.starts_with(p))
                && (code.ends_with(';') || code.ends_with('{'));
            if rust_statement {
                offenders.push(format!("  {}:{}: {}", rel, i + 1, code));
            }
        }
    }
    assert!(
        blanked_any > 0,
        "nothing in the crate was blanked -- the multi-line literals it carries were not recognised"
    );
    assert!(
        offenders.is_empty(),
        "blank_literals swallowed Rust code into a literal, so every census built on it \
         cannot see these lines:\n{}",
        offenders.join("\n")
    );
}

/// FIX ROUND 4. `apply_changes` (the body of Undo and Redo) took `undo_stack`
/// FIRST and then waited for `grid`. The comment beside it called that the
/// crate's canonical order; the sharpened census showed the opposite -- every
/// cell writer (update_cell, clear_range, sort_range, fill_range,
/// set_cell_style, merge_cells, the structural edits, the MCP formatting tool:
/// some forty functions) records its undo step while it HOLDS the grid locks.
/// The MCP server's tools run off the main thread, so a Ctrl+Z overlapping one
/// of them could leave each holding what the other waited for.
///
/// This thread plays the writer mid-command: it holds `grid` and takes
/// `undo_stack` next. The restore runs on another thread and must wait for
/// `grid` holding NOTHING the writer needs.
#[test]
fn undoing_never_holds_the_undo_stack_while_it_waits_for_a_grid_lock() {
    let state = crate::create_app_state();
    let file = crate::persistence::FileState::default();
    let files = crate::persistence::UserFilesState::default();
    let pivots = PivotState::new();
    let slicers = SlicerState::new();
    let filters = RibbonFilterState::new();
    let pane = crate::pane_control::PaneControlState::new();
    let timelines = crate::timeline_slicer::TimelineSlicerState::new();
    let mut transaction = crate::Transaction::new("Edit A1");
    transaction.add_change(crate::CellChange::SetCell { sheet: 0, row: 0, col: 0, previous: None });

    let (parked, reached, result) = std::thread::scope(|scope| {
        let writer_holds_grid = state.grid.write(&test_seed_effect()).unwrap();
        let runner = scope.spawn(|| {
            crate::undo_commands::apply_changes(
                &state, &file, &files, &pivots, &slicers, &filters, &pane, &timelines, transaction, true,
            )
        });
        std::thread::sleep(Duration::from_millis(300));
        // The restore needs `grid`, so it cannot have finished.
        let parked = !runner.is_finished();
        let (tx, rx) = std::sync::mpsc::channel();
        let state_ref = &state;
        let taker = scope.spawn(move || {
            let _g = state_ref.undo_stack.lock().unwrap();
            let _ = tx.send(());
        });
        let reached = rx.recv_timeout(Duration::from_secs(3)).is_ok();
        drop(writer_holds_grid); // let everyone finish, whatever happened
        let result = runner.join().unwrap();
        taker.join().unwrap();
        (parked, reached, result)
    });
    assert!(parked, "fixture: the restore did not wait for grid");
    assert!(result.success, "fixture: the restore ran");
    assert!(
        reached,
        "apply_changes held undo_stack while it waited for grid -- the reverse of every cell writer, \
         which records its undo step while it holds the grid locks"
    );
}

/// FIX ROUND 4. The two pivot stores are both `Persisted` -- a Mutex, so even
/// a read is exclusive -- and every filter command takes them `pivot_tables`
/// then `bi_metadata` (`apply_pivot_filter_core`, `clear_pivot_filter_core`,
/// the hierarchy and unique-value reads). `drill_through_to_sheet_core`, an
/// async command like the filter apply, took them the other way round, so a
/// drill-through overlapping a slicer click could leave each holding what the
/// other waited for. Nothing asked about this pair; now the census does.
#[test]
fn no_function_holds_bi_metadata_while_acquiring_pivot_tables() {
    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_rs_files(&src_root, &mut files);
    assert!(files.len() > 50, "the census walked {} files — it is not finding the crate", files.len());
    let mut offenders: Vec<String> = Vec::new();
    let mut canonical = 0usize;
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
            .replace(std::path::MAIN_SEPARATOR, "/");
        for hit in pair_inversions(&rel, &text, "bi_metadata", "pivot_tables") {
            offenders.push(format!("  {}::{} holds `bi_metadata` and then takes `pivot_tables`", hit.file, hit.function));
        }
        canonical += pair_inversions(&rel, &text, "pivot_tables", "bi_metadata").len();
    }
    offenders.sort();
    offenders.dedup();
    // Non-vacuity: the order this census enforces is the one the crate uses.
    assert!(
        canonical >= 5,
        "only {canonical} functions take `pivot_tables` then `bi_metadata` -- the census is not seeing \
         the filter commands, or the crate's order has changed and this census enforces the wrong one"
    );
    assert!(
        offenders.is_empty(),
        "these functions hold `bi_metadata` while they wait for `pivot_tables`; the filter commands take \
         the two the other way round, so the pair can deadlock:\n{}",
        offenders.join("\n")
    );
}

// ===========================================================================
// R4-LOCK-1 (FIX ROUND 5): `sheet_names` BEFORE `sheet_ids`, everywhere
// ===========================================================================
//
// Both are `Persisted<T>`, and `Persisted::read` takes an exclusive Mutex: two
// "reads" block each other exactly as two writes do. They were taken in
// OPPOSITE orders on different threads:
//
// ```text
// delete_sheet_impl  (MCP thread) :  sheet_names (pending) ... then sheet_ids
// detach_sheet_inner (main)       :  sheet_ids             ... then sheet_names
// ```
//
// `delete_sheet_impl` holds `sheet_names` pending through its formula
// pre-flight and reads `sheet_ids` under it; the MCP server's `delete_sheet`
// tool runs it on the server's own thread. The async drill-through reaches
// `append_user_sheet`, which reads `sheet_ids` under the same pending guard,
// off the main thread too. Four synchronous calp commands took the pair the
// other way round -- `calp_refresh_preview`, `apply_refresh_payloads` (the
// refresh apply), `detach_sheet_inner` (Detach) and `materialize_dev_controls`
// (dev subscribe and dev refresh) -- so an agent deleting a sheet while the
// user clicked Detach or opened the refresh preview could leave each thread
// holding what the other waited for: no panic, nothing in the log, and a main
// thread that never returns. `create_app_state` had the same order; it runs
// before any other thread exists, so it could not deadlock, but it is written
// the one way too and the census below needs no exemption.
//
// Every one of the four PAIRS `sheet_ids[i]` with `sheet_names[i]`, so the fix
// keeps BOTH guards held, `sheet_names` first. Cloning each vector and
// releasing it before taking the next avoids the deadlock but tears the pair:
// a delete or move landing between the two reads hands one sheet's id another
// sheet's name.
//
// Pinned four ways:
//   1. `no_function_holds_sheet_ids_while_acquiring_sheet_names`, the census,
//      over every function in the crate, with a non-vacuity half that names
//      the off-main-thread holders the direction comes from;
//   2. `the_sheet_ids_pair_detector_sees_every_shape_that_inverted`: the
//      census's detector on each site's own pre-fix shape (flagged) and on its
//      fixed shape (quiet, and read as the crate's order);
//   3. `the_four_calp_sites_pair_sheet_ids_with_sheet_names_under_one_hold`:
//      the fix is the ORDER, not a clone-and-release that tears the pair;
//   4. two runtime probes (Detach, the dev controls): this thread plays the
//      delete and holds `sheet_names`; the site runs on another thread and
//      must wait for it holding NOTHING the delete goes on to want. Their
//      non-vacuity partner drives the same harness with the pre-fix body.

/// Can something else acquire `sheet_ids` within `ms`? The
/// `probe_can_take_grids` pattern: a THREAD with a deadline, so a "no" is a
/// timeout the test reports rather than a hang the test joins.
fn probe_can_take_sheet_ids(state: &Arc<AppState>, ms: u64) -> bool {
    let got = Arc::new(AtomicBool::new(false));
    {
        let state = Arc::clone(state);
        let got = Arc::clone(&got);
        std::thread::spawn(move || {
            let guard = state.sheet_ids.read();
            got.store(guard.is_ok(), Ordering::SeqCst);
        });
    }
    wait_until(ms, || got.load(Ordering::SeqCst))
}

/// Run `site` on a thread of its own while THIS thread holds `sheet_names`
/// pending -- the guard `delete_sheet_impl` holds through its formula
/// pre-flight before it reads `sheet_ids` -- and report what the site holds
/// while it waits: `(parked, sheet_ids_reachable, the site's result)`.
///
/// `parked` is the precondition: a site that finished while `sheet_names` was
/// held never waited for it, and then the probe measured nothing. The lock is
/// released before the caller asserts anything, so a failure never leaves the
/// site parked for the rest of the binary.
fn run_while_the_delete_holds_sheet_names<R, F>(state: &Arc<AppState>, site: F) -> (bool, bool, R)
where
    R: Send + 'static,
    F: FnOnce(&AppState) -> R + Send + 'static,
{
    let delete_holds_sheet_names = state.sheet_names.lock_pending().unwrap();
    let started = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let handle = {
        let state = Arc::clone(state);
        let started = Arc::clone(&started);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            started.store(true, Ordering::SeqCst);
            let result = site(&*state);
            finished.store(true, Ordering::SeqCst);
            result
        })
    };
    let began = wait_until(2_000, || started.load(Ordering::SeqCst));
    // Long enough for the site to reach whatever it blocks on.
    std::thread::sleep(Duration::from_millis(250));
    let parked = began && !finished.load(Ordering::SeqCst);
    let ids_reachable = probe_can_take_sheet_ids(state, 3_000);
    drop(delete_holds_sheet_names);
    let result = handle.join().expect("the site's thread panicked");
    (parked, ids_reachable, result)
}

#[test]
fn detaching_a_sheet_does_not_hold_sheet_ids_while_it_waits_for_sheet_names() {
    // THE INVERSION AS A TEST THAT FAILS RATHER THAN HANGS. Before the fix,
    // `detach_sheet_inner` took `sheet_ids` and then waited here for
    // `sheet_names`, so the delete's own read of `sheet_ids` could never
    // complete and the user's Detach never returned.
    let state = shared_state();
    let (parked, ids_reachable, refused) = run_while_the_delete_holds_sheet_names(&state, |state| {
        let file = crate::persistence::FileState::default();
        let pivots = PivotState::new();
        let slicers = SlicerState::new();
        let timelines = crate::timeline_slicer::TimelineSlicerState::new();
        // Sheet 0 came from no application, so once it has its locks the detach
        // REFUSES and changes nothing. What it holds while it WAITS is the question.
        crate::calp_commands::detach_sheet_inner(state, &file, &pivots, &slicers, &timelines, 0).is_err()
    });
    assert!(
        parked,
        "PRECONDITION FAILED: the detach finished while `sheet_names` was held, so it never \
         waited for it and this test measured nothing"
    );
    assert!(
        ids_reachable,
        "DEADLOCK: `detach_sheet_inner` holds `sheet_ids` while it waits for `sheet_names`. \
         `delete_sheet_impl` holds `sheet_names` and then asks for `sheet_ids`, and the MCP server \
         runs it on its own thread -- so an agent's delete overlapping the user's Detach leaves \
         each holding what the other waits for, and the window never answers again (R4-LOCK-1). \
         Take `sheet_names` first, then `sheet_ids`, both held while they are paired."
    );
    assert!(refused, "fixture: a sheet that came from no application has nothing to detach");
}

#[test]
fn materialising_dev_controls_does_not_hold_sheet_ids_while_it_waits_for_sheet_names() {
    // The fourth site: the dev pull's ledger step. One sheet's (empty) control
    // payload, keyed by the id a dev pull keeps -- the local sheet's own -- is
    // enough to carry the call past the media, the page-target read and the
    // controls lock to the step that pairs each local sheet id with its name.
    let state = shared_state();
    let local_name = state.sheet_names.read().unwrap()[0].clone();
    let local_sid = state.sheet_ids.read().unwrap()[0];
    let (parked, ids_reachable, (outcome, ledger)) =
        run_while_the_delete_holds_sheet_names(&state, move |state| {
            let result = ::calp::dev_mode::DevPullResult {
                sheets: Vec::new(),
                tables: Vec::new(),
                named_ranges: Vec::new(),
                controls: vec![::persistence::SavedSheetControls {
                    sheet_id: local_sid,
                    controls: serde_json::json!([]),
                }],
                media: std::collections::HashMap::new(),
                floating_ranges: Vec::new(),
                object_bindings: Vec::new(),
            };
            let dev_map = std::collections::HashMap::from([(local_sid, 0usize)]);
            let mut ledger = Vec::new();
            let outcome = crate::calp_commands::materialize_dev_controls(
                state,
                &test_seed_effect(),
                &result,
                &dev_map,
                &mut ledger,
            );
            (outcome, ledger)
        });
    assert!(
        parked,
        "PRECONDITION FAILED: the dev controls finished while `sheet_names` was held, so the \
         call never waited for it and this test measured nothing"
    );
    assert!(
        ids_reachable,
        "DEADLOCK: `materialize_dev_controls` holds `sheet_ids` while it waits for `sheet_names`. \
         `delete_sheet_impl` holds `sheet_names` and then asks for `sheet_ids` off the main thread, \
         so a dev subscribe or dev refresh overlapping an agent's delete leaves each holding what \
         the other waits for (R4-LOCK-1). Take `sheet_names` first, then `sheet_ids`."
    );
    assert_eq!(outcome, Ok(()), "fixture: the dev controls did not materialise");
    // NON-VACUITY: the call really reached the step that pairs the two.
    assert_eq!(
        ledger.len(),
        1,
        "fixture: no controlSheet ledger row, so the site under test was never reached"
    );
    assert_eq!(
        (ledger[0].id.clone(), ledger[0].name.clone()),
        (local_sid.to_string(), local_name),
        "the controlSheet ledger row pairs the wrong id and name"
    );
}

#[test]
fn the_sheet_ids_probe_itself_can_fail_the_way_the_defect_did() {
    // NON-VACUITY for the two probes above, through the SAME harness: the
    // pre-fix body must read as `sheet_ids` unreachable, the fixed body as
    // reachable. A harness that cannot tell them apart would pass both real
    // probes whatever the four sites did.
    let state = shared_state();
    let (parked, ids_reachable, ()) = run_while_the_delete_holds_sheet_names(&state, |state| {
        let _ids = state.sheet_ids.read().unwrap();
        // ...and now wait for what the test thread holds: the body the four calp
        // sites used to have.
        let _names = state.sheet_names.read().unwrap();
    });
    assert!(parked, "fixture: the planted inverted body never waited for `sheet_names`");
    assert!(
        !ids_reachable,
        "the probe called `sheet_ids` reachable while a thread held it and waited for \
         `sheet_names` -- it cannot see the defect, so both probes above are vacuous"
    );

    let (parked, ids_reachable, ()) = run_while_the_delete_holds_sheet_names(&state, |state| {
        let _names = state.sheet_names.read().unwrap();
        let _ids = state.sheet_ids.read().unwrap();
    });
    assert!(parked, "fixture: the planted fixed body never waited for `sheet_names`");
    assert!(
        ids_reachable,
        "the probe called `sheet_ids` unreachable while the only waiter held nothing -- it \
         reports a lock that is not held"
    );
}

/// R4-LOCK-1, over every function in the crate: nothing may hold `sheet_ids`
/// while it acquires `sheet_names`.
///
/// The DIRECTION is not a choice. It is the order of the holders that run off
/// the main thread -- `delete_sheet_impl` (the MCP server's delete) and
/// `append_user_sheet` (the async drill-through) both take `sheet_names`
/// first -- so everything else has to agree with them, and the non-vacuity
/// half asks for both by name.
#[test]
fn no_function_holds_sheet_ids_while_acquiring_sheet_names() {
    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_rs_files(&src_root, &mut files);
    assert!(files.len() > 50, "the census walked {} files -- it is not finding the crate", files.len());
    let mut offenders: Vec<String> = Vec::new();
    let mut canonical: Vec<String> = Vec::new();
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
            .replace(std::path::MAIN_SEPARATOR, "/");
        for hit in pair_inversions(&rel, &text, "sheet_ids", "sheet_names") {
            offenders.push(format!(
                "  {}::{} (line {}) holds `sheet_ids` and then takes `sheet_names`",
                hit.file, hit.function, hit.line
            ));
        }
        for hit in pair_inversions(&rel, &text, "sheet_names", "sheet_ids") {
            canonical.push(format!("{}::{}", hit.file, hit.function));
        }
    }
    offenders.sort();
    offenders.dedup();
    canonical.sort();
    canonical.dedup();
    // Non-vacuity: the order this census enforces is the one the off-main-thread
    // holders take, and the census can SEE them take it.
    for anchor in ["sheets.rs::delete_sheet_impl", "sheets.rs::append_user_sheet"] {
        assert!(
            canonical.iter().any(|f| f == anchor),
            "`{anchor}` no longer holds `sheet_names` while it takes `sheet_ids` (or the census can \
             no longer see it do so) -- re-derive the direction this census enforces. The functions \
             it does see taking the pair in that order:\n  {}",
            canonical.join("\n  ")
        );
    }
    assert!(
        canonical.len() >= 10,
        "only {} functions take `sheet_names` then `sheet_ids` -- the census is not seeing the \
         sheet-structure commands:\n  {}",
        canonical.len(),
        canonical.join("\n  ")
    );
    assert!(
        offenders.is_empty(),
        "these functions hold `sheet_ids` while they wait for `sheet_names`:\n{}\n\n\
         `delete_sheet_impl` holds `sheet_names` (pending, through its formula pre-flight) and then \
         reads `sheet_ids`, on the MCP server's own thread when an agent deletes a sheet, and the \
         async drill-through's `append_user_sheet` does the same off the main thread ({} functions \
         take the pair in that order). `Persisted::read` is an exclusive Mutex, so each function \
         above can interleave with them and each will hold what the other waits for -- no panic, \
         nothing in the log, a window that never answers (R4-LOCK-1). Take `sheet_names` first and \
         keep both held while they are paired; a clone-and-release of each tears the pair.",
        offenders.join("\n"),
        canonical.len()
    );
}

/// The census's detector, on each site's OWN pre-fix shape: a guard bound
/// inside a `let (a, b) = { .. };` block (Detach, the preview), one nested two
/// blocks deep inside a `let x = { .. };` (the refresh apply), one taken right
/// after another guard was dropped (the dev controls), and the `app_state`
/// receiver with `.unwrap()` (`create_app_state`). Every pre-fix shape must be
/// FLAGGED; every fixed shape must be quiet AND read as the crate's order.
#[test]
fn the_sheet_ids_pair_detector_sees_every_shape_that_inverted() {
    let shapes: &[(&str, &str, &str)] = &[
        (
            "calp_refresh_preview",
            r##"pub fn calp_refresh_preview(state: State<AppState>) -> Result<(), String> {
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    let (local_sheet_names, mut taken_names): (std::collections::HashMap<SheetId, String>, Vec<String>) = {
        let ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        let names = state.sheet_names.read().map_err(|e| e.to_string())?;
        (
            ids.iter()
                .enumerate()
                .filter_map(|(i, id)| names.get(i).map(|n| (*id, n.clone())))
                .collect(),
            names.clone(),
        )
    };
    Ok(())
}
"##,
            r##"pub fn calp_refresh_preview(state: State<AppState>) -> Result<(), String> {
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    let (local_sheet_names, mut taken_names): (std::collections::HashMap<SheetId, String>, Vec<String>) = {
        let names = state.sheet_names.read().map_err(|e| e.to_string())?;
        let ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        (
            ids.iter()
                .enumerate()
                .filter_map(|(i, id)| names.get(i).map(|n| (*id, n.clone())))
                .collect(),
            names.clone(),
        )
    };
    Ok(())
}
"##,
        ),
        (
            "apply_refresh_payloads",
            r##"pub(crate) fn apply_refresh_payloads(state: &AppState, effect: &DocumentEffect) -> Result<(), String> {
    let on_grid_snapshot = {
        {
            let mut sparklines = state.sparklines.write(&effect).map_err(|e| e.to_string())?;
            sparklines.retain(|e| e.sheet_index != 0);
        }
        {
            let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
            let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
            let mut controls = state.controls.write(&effect).map_err(|e| e.to_string())?;
            let snapshot = controls.clone();
            snapshot
        }
    };
    Ok(())
}
"##,
            r##"pub(crate) fn apply_refresh_payloads(state: &AppState, effect: &DocumentEffect) -> Result<(), String> {
    let on_grid_snapshot = {
        {
            let mut sparklines = state.sparklines.write(&effect).map_err(|e| e.to_string())?;
            sparklines.retain(|e| e.sheet_index != 0);
        }
        {
            let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
            let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
            let mut controls = state.controls.write(&effect).map_err(|e| e.to_string())?;
            let snapshot = controls.clone();
            snapshot
        }
    };
    Ok(())
}
"##,
        ),
        (
            "detach_sheet_inner",
            r##"pub(crate) fn detach_sheet_inner(state: &AppState, sheet_index: usize) -> Result<(), String> {
    let (local_sid, sheet_name) = {
        let ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        let names = state.sheet_names.read().map_err(|e| e.to_string())?;
        let sid = *ids
            .get(sheet_index)
            .ok_or_else(|| format!("Sheet index {} is out of range.", sheet_index))?;
        (sid, names.get(sheet_index).cloned().unwrap_or_default())
    };
    let visibility: Vec<String> = state.sheet_visibility.read().map_err(|e| e.to_string())?.clone();
    Ok(())
}
"##,
            r##"pub(crate) fn detach_sheet_inner(state: &AppState, sheet_index: usize) -> Result<(), String> {
    let (local_sid, sheet_name) = {
        let names = state.sheet_names.read().map_err(|e| e.to_string())?;
        let ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        let sid = *ids
            .get(sheet_index)
            .ok_or_else(|| format!("Sheet index {} is out of range.", sheet_index))?;
        (sid, names.get(sheet_index).cloned().unwrap_or_default())
    };
    let visibility: Vec<String> = state.sheet_visibility.read().map_err(|e| e.to_string())?.clone();
    Ok(())
}
"##,
        ),
        (
            "materialize_dev_controls",
            r##"fn materialize_dev_controls(state: &AppState, effect: &DocumentEffect) -> Result<(), String> {
    let page_targets = {
        let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        PageTargetRemap::from_pull(dev_map, &sheet_ids)
    };
    let mut controls = state.controls.write(effect).map_err(|e| e.to_string())?;
    drop(controls);
    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
    Ok(())
}
"##,
            r##"fn materialize_dev_controls(state: &AppState, effect: &DocumentEffect) -> Result<(), String> {
    let page_targets = {
        let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        PageTargetRemap::from_pull(dev_map, &sheet_ids)
    };
    let mut controls = state.controls.write(effect).map_err(|e| e.to_string())?;
    drop(controls);
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
    Ok(())
}
"##,
        ),
        (
            "create_app_state",
            r##"pub fn create_app_state() -> AppState {
    let app_state = AppState { sheet_ids: Persisted::new(Vec::new()) };
    {
        let sheet_ids = app_state.sheet_ids.read().unwrap();
        let sheet_names = app_state.sheet_names.read().unwrap();
        let mut id_reg = app_state.id_registry.lock().unwrap();
        for (i, &sid) in sheet_ids.iter().enumerate() {
            if let Some(name) = sheet_names.get(i) {
                id_reg.register_sheet_with_id(name, sid);
            }
        }
    }
    app_state
}
"##,
            r##"pub fn create_app_state() -> AppState {
    let app_state = AppState { sheet_ids: Persisted::new(Vec::new()) };
    {
        let sheet_names = app_state.sheet_names.read().unwrap();
        let sheet_ids = app_state.sheet_ids.read().unwrap();
        let mut id_reg = app_state.id_registry.lock().unwrap();
        for (i, &sid) in sheet_ids.iter().enumerate() {
            if let Some(name) = sheet_names.get(i) {
                id_reg.register_sheet_with_id(name, sid);
            }
        }
    }
    app_state
}
"##,
        ),
    ];
    for (function, inverted, fixed) in shapes {
        let flagged: Vec<String> = pair_inversions("planted.rs", inverted, "sheet_ids", "sheet_names")
            .into_iter()
            .map(|h| h.function)
            .collect();
        assert_eq!(
            flagged,
            vec![function.to_string()],
            "the census cannot see `{function}`'s pre-fix shape, so it would pass the inversion R4-LOCK-1 found"
        );
        let quiet = pair_inversions("planted.rs", fixed, "sheet_ids", "sheet_names");
        assert!(quiet.is_empty(), "the census fired on `{function}`'s FIXED shape: {:?}", quiet);
        let ordered: Vec<String> = pair_inversions("planted.rs", fixed, "sheet_names", "sheet_ids")
            .into_iter()
            .map(|h| h.function)
            .collect();
        assert_eq!(
            ordered,
            vec![function.to_string()],
            "`{function}`'s fixed shape does not read as `sheet_names` held while `sheet_ids` is taken"
        );
    }

    // A MOMENTARY `sheet_names` read under a held `sheet_ids` still waits for the lock.
    let momentary = "pub fn f(state: &AppState) {\n    let ids = state.sheet_ids.read().unwrap();\n    let n = state.sheet_names.read().unwrap().len();\n}\n";
    assert_eq!(
        pair_inversions("planted.rs", momentary, "sheet_ids", "sheet_names").len(),
        1,
        "a clone-and-drop read of `sheet_names` under a held `sheet_ids` still WAITS for the lock"
    );
    // ...while a `sheet_ids` read that clones and releases holds nothing: that is
    // deadlock-free, which is why the census stays quiet on it -- and why the pin
    // below, not this census, is what forbids it at the four paired sites.
    let released = "pub fn f(state: &AppState) {\n    let ids = state.sheet_ids.read().unwrap().clone();\n    let names = state.sheet_names.read().unwrap();\n}\n";
    assert!(
        pair_inversions("planted.rs", released, "sheet_ids", "sheet_names").is_empty(),
        "a released `sheet_ids` read holds nothing while `sheet_names` is taken"
    );
}

/// The fix is the ORDER, not a clone-and-release. Each of the four calp sites
/// pairs `sheet_ids[i]` with `sheet_names[i]`; reading the two in separate
/// statements that each clone and release would satisfy the census above
/// (nothing is held while anything is acquired) and let a delete or move land
/// between the reads, pairing one sheet's id with another sheet's name. So the
/// detector must read each site's `sheet_ids` acquisition as taken WHILE
/// `sheet_names` is still held.
///
/// The sites R5-TORN-PAIR-SIBLINGS fixed after these four are pinned by name in
/// `every_pairing_site_round_six_fixed_reads_the_pair_under_one_hold`, and the
/// rule itself crate-wide by `no_function_reads_sheet_ids_and_sheet_names_in_two_holds`.
#[test]
fn the_four_calp_sites_pair_sheet_ids_with_sheet_names_under_one_hold() {
    let text = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/calp_commands.rs"),
    )
    .expect("cannot read calp_commands.rs");
    let lines: Vec<&str> = text.lines().collect();
    let held_together = pair_inversions("calp_commands.rs", &text, "sheet_names", "sheet_ids");
    for (function, ids_binding) in [
        ("calp_refresh_preview", "let ids = state.sheet_ids.read("),
        ("apply_refresh_payloads", "let sheet_ids = state.sheet_ids.read("),
        ("detach_sheet_inner", "let ids = state.sheet_ids.read("),
        ("materialize_dev_controls", "let sheet_ids = state.sheet_ids.read("),
    ] {
        let paired = held_together.iter().any(|hit| {
            hit.function == function
                && lines.get(hit.line - 1).is_some_and(|line| line.contains(ids_binding))
        });
        assert!(
            paired,
            "`{function}` no longer takes `sheet_ids` (`{ids_binding}..`) while it still holds \
             `sheet_names`. It pairs the two index by index, so they must be read under ONE hold, \
             `sheet_names` first (R4-LOCK-1): separate clone-and-release reads avoid the deadlock \
             but let a delete or move land between them and give a sheet another sheet's name."
        );
    }
}

// ===========================================================================
// R5-PREVIEW-SUBS-DEADLOCK (FIX ROUND 6): the CELL WRITERS' order
// ===========================================================================
//
// BUG-0590 put `sheet_names` before `sheet_ids` everywhere, and the census above
// enforces it. The refresh preview still deadlocked -- through stores neither
// census asked about, and through a CALL, which no census here could see:
//
// ```text
// update_cells_batch_core (AI chat / MCP / notebook thread):
//     grid, grids, sheet_names, files, styles, deps, undo, merges, locale, pivots
//       -> record_subscription_override_edits: sheet_ids, subscriptions, .., override layer
// calp_refresh_preview (main):
//     subscriptions, override layer .. then sheet_names, sheet_ids
// ```
//
// The cell writers are the fixed point. `ai_chat_run_tool`, `notebook_run_cell`
// and the MCP server reach `update_cells_batch_core` off the main thread today,
// and every writer takes the grid locks first and the recorder's stores LAST. So
// nothing may hold a store a cell writer takes late while it waits for one the
// writer already holds. Three censuses:
//
//   1. `no_function_holds_subscriptions_or_the_override_layer_while_acquiring_a_sheet_lock`:
//      the R5 rule, strict. Holding `subscriptions` or the override layer, take
//      nothing the writers hold at the recorder, nor `sheet_ids`, nor (holding
//      the layer) `subscriptions`. Copy what you need and release it.
//   2. `no_function_holds_a_store_the_cell_writers_take_late_while_acquiring_one_they_hold`:
//      the same question for `sheet_ids` (the recorder's first store) and the
//      name stores the writers take after it, with a GATE: a function holding
//      `grid` or `grids` cannot overlap a writer that is past its first lock.
//   3. `no_function_reads_sheet_ids_and_sheet_names_in_two_holds`:
//      R5-TORN-PAIR-SIBLINGS, crate-wide.
//
// What the writers hold is READ from `commands/data.rs`, never typed: a writer
// that starts holding one more store widens censuses 1 and 2 in the same commit.
// A call counts as acquiring what its callee's own body acquires
// (`held_while_acquiring`), which is how census 1 sees the writers take the
// canonical direction -- through the recorder -- and how census 2 found the save
// holding `sheet_ids` across `collect_pivot_definitions`.
//
// NO RUNTIME PROBE of the preview: the command takes a Tauri `State` and a
// `Window`, which no unit test can build, and its body is pinned inline by
// `refresh_resolution_tests.rs` and `calp_environments_tests.rs` (the id-registry
// block, the position map, the workspace loop), so the prologue cannot be
// factored out without moving what those tests read; `calp_get_application_objects`
// is pinned the same way by `calp_refresh_pivot_tests.rs`. The censuses read both
// bodies instead, and their teeth were proved on the real files.

/// The crate's `src` directory.
fn src_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// Every non-test source of the crate, as `(path relative to src, text)`.
fn crate_sources() -> Vec<(String, String)> {
    let src_root = src_root();
    let mut files = Vec::new();
    collect_rs_files(&src_root, &mut files);
    assert!(files.len() > 50, "the census walked {} files -- it is not finding the crate", files.len());
    let mut out = Vec::new();
    for path in files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
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
            .replace(std::path::MAIN_SEPARATOR, "/");
        out.push((rel, text));
    }
    out.sort();
    out
}

/// The cell write paths that call the recorder while they hold the grid locks
/// -- the three the R5 finding names, which the AI chat, the MCP server and the
/// notebook drive off the main thread.
const CELL_WRITERS: [&str; 3] = ["update_cell_impl", "update_cells_batch_core", "fill_range_core"];

/// The recorder every cell writer calls with its whole set held.
const RECORDER: &str = "record_subscription_override_edits";

/// Every store a cell writer holds when it calls [`RECORDER`], READ out of
/// `commands/data.rs` with the census's own machinery: the stores alive at each
/// writer's call, which it reaches as "holding `grid`, acquiring `subscriptions`
/// inside the recorder". Never typed.
fn what_the_cell_writers_hold_at_the_recorder(graph: &CallGraph) -> Vec<String> {
    let data = std::fs::read_to_string(src_root().join("commands/data.rs")).expect("cannot read commands/data.rs");
    let hits = held_while_acquiring("commands/data.rs", &data, &["grid"], &["subscriptions"], graph);
    let mut held: Vec<String> = Vec::new();
    for writer in CELL_WRITERS {
        let at_the_call: Vec<&HeldAcquisition> =
            hits.iter().filter(|h| h.function == writer && h.via.as_deref() == Some(RECORDER)).collect();
        assert!(
            !at_the_call.is_empty(),
            "`{writer}` no longer calls `{RECORDER}` while it holds `grid` (or the census can no longer \
             see it do so) -- re-derive the cell writers' lock set these censuses enforce"
        );
        for hit in at_the_call {
            for store in &hit.alive {
                if !held.contains(store) {
                    held.push(store.clone());
                }
            }
        }
    }
    held
}

/// One census hit as a line of its failure message.
fn describe(hit: &HeldAcquisition) -> String {
    format!(
        "  {}::{} (line {}) holds [{}] and then takes `{}`{}",
        hit.file,
        hit.function,
        hit.line,
        hit.holding.join(", "),
        hit.acquiring,
        hit.via.as_ref().map(|callee| format!(" (inside `{callee}`)")).unwrap_or_default()
    )
}

/// Census 1's question of one file: where a function holds `subscriptions` or
/// the override layer while it acquires a store the cell writers hold at the
/// recorder (`writers_hold`), or `sheet_ids` (which the recorder takes before
/// either), or -- holding the override layer -- `subscriptions`.
fn subscription_store_inversions(
    file: &str,
    text: &str,
    graph: &CallGraph,
    writers_hold: &[String],
) -> Vec<HeldAcquisition> {
    let mut then: Vec<&str> = writers_hold.iter().map(String::as_str).collect();
    for store in ["sheet_ids", "subscriptions"] {
        if !then.contains(&store) {
            then.push(store);
        }
    }
    held_while_acquiring(file, text, &["subscriptions", "override_layer"], &then, graph)
}

/// The stores a cell writer takes only AFTER it holds its whole set:
/// `sheet_ids` (the recorder's first), then the three name stores it takes once
/// the recorder has returned.
const TAKEN_LATE_BY_THE_CELL_WRITERS: [&str; 4] = ["sheet_ids", "tables", "table_names", "named_ranges"];

/// Census 2's question of one file: where a function holds one of
/// [`TAKEN_LATE_BY_THE_CELL_WRITERS`] while it acquires a store the writers
/// hold at the recorder -- unless it ALSO holds `grid` or `grids`, which every
/// writer takes first, so it cannot be overlapping a writer that is past them.
///
/// All four are read THROUGH CALLS (BUG-0592). Round 6 read the three name
/// stores in the bodies only, because through calls they reached two functions
/// it did not own: `rename_named_range_impl`, which took `named_ranges` before
/// the grid locks its repoint takes, and `remove_duplicates`, which held its
/// name tables across the dependency rebuild. The rename now takes `grid` and
/// `grids` FIRST and holds them across the move, the repoint and the undo
/// record; the rebuild reads COPIES of the name tables.
fn late_store_inversions(file: &str, text: &str, graph: &CallGraph, writers_hold: &[String]) -> Vec<HeldAcquisition> {
    let then: Vec<&str> = writers_hold.iter().map(String::as_str).collect();
    let mut hits = held_while_acquiring(file, text, &TAKEN_LATE_BY_THE_CELL_WRITERS, &then, graph);
    hits.retain(|hit| !hit.alive.iter().any(|store| store == "grid" || store == "grids"));
    hits
}

/// R5-PREVIEW-SUBS-DEADLOCK, over every function in the crate: nothing holds
/// `subscriptions` or the override layer while it waits for a store a cell
/// writer holds when it calls the recorder (or for `sheet_ids`, or -- holding
/// the layer -- for `subscriptions`).
///
/// SABOTAGE: take `subscriptions` and the override layer at the top of
/// `calp_refresh_preview` again, held across its sheet-pair block -- this fails
/// naming `sheet_names` and `sheet_ids` there.
#[test]
fn no_function_holds_subscriptions_or_the_override_layer_while_acquiring_a_sheet_lock() {
    let sources = crate_sources();
    let graph = direct_acquisitions_by_function(&sources);
    // The premises, read from the code: the recorder takes `sheet_ids`,
    // `subscriptions` and the override layer...
    let recorder = graph.get(RECORDER).unwrap_or_else(|| panic!("the call graph no longer knows `{RECORDER}`"));
    for store in ["sheet_ids", "subscriptions", "override_layer"] {
        assert!(
            recorder.iter().any(|s| s == store),
            "`{RECORDER}` no longer takes `{store}` -- re-derive what this census enforces: {recorder:?}"
        );
    }
    // ...and every cell writer calls it holding the grid locks and `sheet_names`.
    // This is also the NON-VACUITY half: the direction comes from the writers,
    // and the census sees them take it -- through the call.
    let writers_hold = what_the_cell_writers_hold_at_the_recorder(&graph);
    for store in ["grid", "grids", "sheet_names", "pivot_tables"] {
        assert!(
            writers_hold.iter().any(|s| s == store),
            "the cell writers no longer hold `{store}` at the recorder (or the census cannot see it): {writers_hold:?}"
        );
    }
    let mut offenders: Vec<String> = Vec::new();
    for (rel, text) in &sources {
        offenders.extend(subscription_store_inversions(rel, text, &graph, &writers_hold).iter().map(describe));
    }
    offenders.sort();
    offenders.dedup();
    assert!(
        offenders.is_empty(),
        "these functions hold `subscriptions` or the override layer while they wait for another store:\n{}\n\n\
         Every cell writer ({}) holds [{}] and then calls `{RECORDER}`, which takes `sheet_ids`, \
         `subscriptions` and the override layer -- and the AI chat, the MCP server and the notebook run \
         those writers off the main thread. Each function above can therefore interleave with one and \
         each will hold what the other waits for: no panic, nothing in the log, a window that never \
         answers (R5-PREVIEW-SUBS-DEADLOCK). Copy what you need out of the calp store and release it \
         first, or take the sheet locks first.",
        offenders.join("\n"),
        CELL_WRITERS.join(", "),
        writers_hold.join(", ")
    );
}

/// The same question for the stores the cell writers take LAST, gated by the
/// grid locks they take first.
///
/// SABOTAGE: in `assemble_workbook_snapshot` (the save's tail, outside the
/// body's grid hold), replace the snapshot-derived `sheet_ids_save` with a
/// guard bound to `state.sheet_ids.read()` -- this fails naming
/// `collect_pivot_definitions` and the other collectors it calls.
#[test]
fn no_function_holds_a_store_the_cell_writers_take_late_while_acquiring_one_they_hold() {
    let sources = crate_sources();
    let graph = direct_acquisitions_by_function(&sources);
    let writers_hold = what_the_cell_writers_hold_at_the_recorder(&graph);
    // The premises. The gate is sound only while every writer holds BOTH grid
    // locks at the recorder...
    for store in ["grid", "grids"] {
        assert!(
            writers_hold.iter().any(|s| s == store),
            "a cell writer reaches the recorder without `{store}`, so holding it no longer proves a \
             writer cannot be past its first lock -- the gate in this census is unsound: {writers_hold:?}"
        );
    }
    // ...`sheet_ids` is the recorder's FIRST store...
    assert_eq!(
        graph.get(RECORDER).and_then(|stores| stores.first()).map(String::as_str),
        Some("sheet_ids"),
        "`{RECORDER}` no longer takes `sheet_ids` first -- re-derive TAKEN_LATE_BY_THE_CELL_WRITERS"
    );
    // ...and every writer takes the three name stores while it holds
    // `pivot_tables`, one of its set.
    let data = std::fs::read_to_string(src_root().join("commands/data.rs")).expect("cannot read commands/data.rs");
    let late = held_while_acquiring(
        "commands/data.rs",
        &data,
        &["pivot_tables"],
        &TAKEN_LATE_BY_THE_CELL_WRITERS[1..],
        &CallGraph::new(),
    );
    for writer in CELL_WRITERS {
        for store in &TAKEN_LATE_BY_THE_CELL_WRITERS[1..] {
            assert!(
                late.iter().any(|h| h.function == writer && h.acquiring == *store),
                "`{writer}` no longer takes `{store}` while it holds `pivot_tables` -- re-derive \
                 TAKEN_LATE_BY_THE_CELL_WRITERS"
            );
        }
    }
    let mut offenders: Vec<String> = Vec::new();
    for (rel, text) in &sources {
        offenders.extend(late_store_inversions(rel, text, &graph, &writers_hold).iter().map(describe));
    }
    offenders.sort();
    offenders.dedup();
    assert!(
        offenders.is_empty(),
        "these functions hold a store the cell writers take LAST while they wait for one the writers \
         already hold, with neither grid lock held:\n{}\n\nA cell writer holds [{}], then takes \
         `sheet_ids` (in `{RECORDER}`) and the name stores -- off the main thread for the AI chat, the \
         MCP server and the notebook. A save, an AutoRecover tick or a publish shaped like the ones \
         above can leave each holding what the other waits for (R5-PREVIEW-SUBS-DEADLOCK). Copy the \
         store and release it, or take it after the stores the writers hold.",
        offenders.join("\n"),
        writers_hold.join(", ")
    );
}

/// Both detectors, on every shape the round found and on the fixed shapes.
#[test]
fn the_cell_writer_censuses_fire_on_every_shape_round_six_found_and_stay_quiet_on_the_fixes() {
    let writers_hold: Vec<String> = ["grid", "grids", "sheet_names", "files", "style_registry", "merged_regions", "pivot_tables"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let graph: CallGraph = [
        ("record_edits", vec!["sheet_ids", "subscriptions", "override_layer"]),
        ("names_helper", vec!["sheet_names"]),
        ("collect_pivot_definitions", vec!["sheet_names", "pivot_tables"]),
        ("rebuild_maps", vec!["dependents"]),
    ]
    .into_iter()
    .map(|(name, stores)| (name.to_string(), stores.into_iter().map(str::to_string).collect()))
    .collect();

    // CENSUS 1 -- (label, body, the stores it must be caught taking).
    let flagged_by_census_one: &[(&str, &str, &[&str])] = &[
        (
            "the preview as it stood",
            r##"pub fn calp_refresh_preview(state: State<AppState>) -> Result<(), String> {
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    let layer = state.override_layer.read().map_err(|e| e.to_string())?;
    let (local, taken) = {
        let names = state.sheet_names.read().map_err(|e| e.to_string())?;
        let ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        (ids.clone(), names.clone())
    };
    Ok(())
}
"##,
            &["sheet_names", "sheet_ids"],
        ),
        (
            "the Application Explorer as it stood",
            r##"pub fn calp_get_application_objects(state: State<AppState>, pivot_state: State<PivotState>) -> Result<(), String> {
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    let sheet_ids: Vec<SheetId> = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
    let sheet_names: Vec<String> = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let pivot_tables = pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
    Ok(())
}
"##,
            &["sheet_ids", "sheet_names", "pivot_tables"],
        ),
        (
            "a store taken inside a crate function the holder calls",
            r##"pub fn f(state: &AppState) -> Result<(), String> {
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    let names = crate::m::names_helper(state);
    Ok(())
}
"##,
            &["sheet_names"],
        ),
        (
            "the recorder itself called under `subscriptions`",
            r##"pub fn f(state: &AppState) {
    let subs = state.subscriptions.read().unwrap();
    record_edits(state);
}
"##,
            &["sheet_ids"],
        ),
        (
            "the override layer, then `subscriptions` (the override export as it stood)",
            r##"pub fn calp_export_overrides(state: State<AppState>) -> Result<(), String> {
    let layer = state.override_layer.read().map_err(|e| e.to_string())?;
    let baseline = {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        subs.format_version
    };
    Ok(())
}
"##,
            &["subscriptions"],
        ),
        (
            "ANOTHER guard dropped: `subscriptions` is still held",
            r##"pub fn f(state: &AppState) -> Result<(), String> {
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    let audit = state.audit_log.read().map_err(|e| e.to_string())?;
    drop(audit);
    let names = state.sheet_names.read().map_err(|e| e.to_string())?;
    Ok(())
}
"##,
            &["sheet_names"],
        ),
    ];
    for (label, src, stores) in flagged_by_census_one {
        let hits = subscription_store_inversions("planted.rs", src, &graph, &writers_hold);
        for store in *stores {
            assert!(
                hits.iter().any(|h| h.acquiring == *store),
                "census 1 missed `{store}` in `{label}`, so it cannot see the defect it exists for: {hits:?}"
            );
        }
    }

    let quiet_for_census_one: &[(&str, &str)] = &[
        (
            "the preview as it is now",
            r##"pub fn calp_refresh_preview(state: State<AppState>) -> Result<(), String> {
    let (local, taken) = {
        let names = state.sheet_names.read().map_err(|e| e.to_string())?;
        let ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        (ids.clone(), names.clone())
    };
    let (groups, layer) = {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        let layer = state.override_layer.read().map_err(|e| e.to_string())?;
        let positions = {
            let id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;
            id_reg.len()
        };
        (subs.subscriptions.clone(), layer.clone())
    };
    Ok(())
}
"##,
        ),
        (
            "a copy holds nothing (the Application Explorer as it is now)",
            r##"pub fn f(state: &AppState) -> Result<(), String> {
    let (names, ids) = (
        state.sheet_names.read().map_err(|e| e.to_string())?.clone(),
        state.sheet_ids.read().map_err(|e| e.to_string())?.clone(),
    );
    let sub = {
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
        subs.subscriptions.first().cloned()
    };
    let pivots = pivot_state.pivot_tables.read().map_err(|e| e.to_string())?.len();
    Ok(())
}
"##,
        ),
        (
            "`subscriptions`, the layer, the registry: the recorder's own order",
            r##"pub fn f(state: &AppState, effect: &DocumentEffect) -> Result<(), String> {
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    let mut layer = state.override_layer.write(effect).map_err(|e| e.to_string())?;
    let mut id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;
    Ok(())
}
"##,
        ),
        (
            "the sheet locks, then `subscriptions` (the refresh's materialize block)",
            r##"pub(crate) fn apply_refresh_payloads(state: &AppState, effect: &DocumentEffect) -> Result<(), String> {
    let mut grids = state.grids.write(effect).map_err(|e| e.to_string())?;
    let mut sheet_names = state.sheet_names.write(effect).map_err(|e| e.to_string())?;
    let mut sheet_ids = state.sheet_ids.write(effect).map_err(|e| e.to_string())?;
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    Ok(())
}
"##,
        ),
        (
            "a method or a type's function of the same name is not the crate function",
            r##"pub fn f(state: &AppState) -> Result<(), String> {
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    let a = subs.names_helper(1);
    let b = Names::names_helper(2);
    Ok(())
}
"##,
        ),
        (
            "a spawned closure is another thread",
            r##"pub fn f(state: Arc<AppState>) -> Result<(), String> {
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let names = state.sheet_names.read().unwrap();
    });
    Ok(())
}
"##,
        ),
        (
            "released by its own drop",
            r##"pub fn f(state: &AppState) -> Result<(), String> {
    let subs = state.subscriptions.read().map_err(|e| e.to_string())?;
    drop(subs);
    let names = state.sheet_names.read().map_err(|e| e.to_string())?;
    Ok(())
}
"##,
        ),
    ];
    for (label, src) in quiet_for_census_one {
        let hits = subscription_store_inversions("planted.rs", src, &graph, &writers_hold);
        assert!(hits.is_empty(), "census 1 fired on `{label}`, which is CORRECT code: {hits:?}");
    }

    // THE DERIVATION: a writer's set is what is alive at its recorder call.
    let writer = r##"pub fn update_cells_batch_core(state: &AppState, e: &DocumentEffect) {
    let grid = state.grid.write(e).unwrap();
    let grids = state.grids.write(e).unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    record_edits(state);
}
"##;
    let at_the_call = held_while_acquiring("planted.rs", writer, &["grid"], &["subscriptions"], &graph);
    assert_eq!(at_the_call.len(), 1, "the writer's recorder call was not seen: {at_the_call:?}");
    assert_eq!(at_the_call[0].via.as_deref(), Some("record_edits"));
    assert_eq!(at_the_call[0].alive, vec!["grid".to_string(), "grids".to_string(), "sheet_names".to_string()]);

    // CENSUS 2 -- (label, body, the store it must be caught taking).
    let flagged_by_census_two: &[(&str, &str, &str)] = &[
        (
            "the save as it stood: `sheet_ids` kept across the user files after the grid guards went",
            r##"pub fn build_workbook_for_save(state: &AppState, user_files_state: &UserFilesState) -> Result<(), String> {
    let active_grid = state.grid.read().map_err(|e| e.to_string())?;
    let grids = state.grids.read().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
    drop(grids);
    drop(active_grid);
    drop(sheet_names);
    let files = user_files_state.files.lock().map_err(|e| e.to_string())?.clone();
    Ok(())
}
"##,
            "files",
        ),
        (
            "the save's `sheet_ids` held across a collector that takes `sheet_names`",
            r##"fn assemble_workbook_for_save(state: &AppState) -> Result<(), String> {
    let sheet_ids_save = state.sheet_ids.read().map_err(|e| e.to_string())?;
    collect_pivot_definitions(state);
    Ok(())
}
"##,
            "pivot_tables",
        ),
        (
            "`tables` held while `pivot_tables` is waited for (the Application Explorer as it stood)",
            r##"pub fn calp_get_application_objects(state: &AppState, pivot_state: &PivotState) -> Result<(), String> {
    let tables = state.tables.read().map_err(|e| e.to_string())?;
    let named_ranges = state.named_ranges.read().map_err(|e| e.to_string())?;
    let pivot_tables = pivot_state.pivot_tables.read().map_err(|e| e.to_string())?;
    Ok(())
}
"##,
            "pivot_tables",
        ),
        (
            "`tables` held across the user files (the save as it stood, the other store)",
            r##"pub fn build_workbook_for_save(state: &AppState, user_files_state: &UserFilesState) -> Result<(), String> {
    let tables = state.tables.read().map_err(|e| e.to_string())?;
    let files = user_files_state.files.lock().map_err(|e| e.to_string())?.clone();
    Ok(())
}
"##,
            "files",
        ),
    ];
    for (label, src, store) in flagged_by_census_two {
        let hits = late_store_inversions("planted.rs", src, &graph, &writers_hold);
        assert!(
            hits.iter().any(|h| h.acquiring == *store),
            "census 2 missed `{store}` in `{label}`, so it cannot see the defect it exists for: {hits:?}"
        );
    }

    let quiet_for_census_two: &[(&str, &str)] = &[
        (
            "the gate: the refresh's materialize block holds `grids`",
            r##"pub(crate) fn apply_refresh_payloads(state: &AppState, effect: &DocumentEffect) -> Result<(), String> {
    let mut grids = state.grids.write(effect).map_err(|e| e.to_string())?;
    let mut sheet_names = state.sheet_names.write(effect).map_err(|e| e.to_string())?;
    let mut sheet_ids = state.sheet_ids.write(effect).map_err(|e| e.to_string())?;
    let mut styles = state.style_registry.write(effect).map_err(|e| e.to_string())?;
    Ok(())
}
"##,
        ),
        (
            "copied, not held (the save's builder after round 6, and its tails still)",
            r##"pub fn build_workbook_for_save(state: &AppState, user_files_state: &UserFilesState) -> Result<(), String> {
    let tables = state.tables.read().map_err(|e| e.to_string())?;
    let sheet_ids: Vec<SheetId> = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
    let saved = collect(&tables, &sheet_ids);
    drop(tables);
    let files = user_files_state.files.lock().map_err(|e| e.to_string())?.clone();
    collect_pivot_definitions(state);
    Ok(())
}
"##,
        ),
        (
            // F1, review round 7: the body holds `grid` and `grids` from its first
            // read to its last, so every store it takes while they are held is
            // past the gate -- no cell writer can be past its first lock then.
            "the gate: the save's body holds both grid locks from its first read to its last (round 7)",
            r##"pub fn build_workbook_for_save(state: &AppState, user_files_state: &UserFilesState) -> Result<(), String> {
    let active_grid = state.grid.read().map_err(|e| e.to_string())?;
    let grids = state.grids.read().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
    let tables = state.tables.read().map_err(|e| e.to_string())?;
    let sheet_ids: Vec<SheetId> = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
    drop(sheet_names);
    let files = user_files_state.files.lock().map_err(|e| e.to_string())?.clone();
    let merged = state.merged_regions.read().map_err(|e| e.to_string())?.len();
    drop(tables);
    drop(grids);
    drop(active_grid);
    Ok(())
}
"##,
        ),
        (
            // BUG-0592: the dependency rebuild reads COPIES of the name tables.
            "remove_duplicates as it is now: the name tables copied, nothing held across the rebuild",
            r##"pub fn remove_duplicates(state: &AppState) {
    let tables = state.tables.read().unwrap().clone();
    let named_ranges = state.named_ranges.read().unwrap().clone();
    rebuild_maps(state);
}
"##,
        ),
        (
            // BUG-0592: the rename takes both grid locks FIRST and keeps them.
            "the rename as it is now: both grid locks first, the registry, then the repoint",
            r##"pub(crate) fn rename_named_range_impl(state: &AppState) {
    let pending_grid = match state.grid.lock_pending() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let pending_grids = match state.grids.lock_pending() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let pending = match state.named_ranges.lock_pending() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    rename_in_grids(state);
    record_undo(state);
}
"##,
        ),
    ];
    let mut wider = writers_hold.clone();
    wider.push("dependents".to_string());
    wider.push("undo_stack".to_string());
    let mut name_graph = graph.clone();
    name_graph.insert("rename_in_grids".to_string(), vec!["grid".to_string(), "grids".to_string()]);
    name_graph.insert("record_undo".to_string(), vec!["undo_stack".to_string()]);
    for (label, src) in quiet_for_census_two {
        let hits = late_store_inversions("planted.rs", src, &name_graph, &wider);
        assert!(hits.is_empty(), "census 2 fired on `{label}`, which it must not: {hits:?}");
    }

    // BUG-0592: the name stores are read THROUGH CALLS now. Each shape below is
    // how round 6's call-graph walk read the two functions it reported open.
    let flagged_through_calls: &[(&str, &str, &str)] = &[
        (
            "remove_duplicates as round 6 read it: name tables held across the dependency rebuild",
            r##"pub fn remove_duplicates(state: &AppState) {
    let tables = state.tables.read().unwrap();
    let named_ranges = state.named_ranges.read().unwrap();
    rebuild_maps(state);
}
"##,
            "dependents",
        ),
        (
            // How round 6 read the rename: the scanner cannot see `authorize`
            // CONSUME the pending guard, so `named_ranges` read as held across
            // the repoint. (At run time the registry guard was released before
            // it; what the rename really lacked was ONE critical section --
            // see `rename_named_range_impl`.) The detector must flag the shape.
            "a name store held across a repoint that takes the grid locks",
            r##"pub(crate) fn rename_named_range_impl(state: &AppState) {
    let pending = match state.named_ranges.lock_pending() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    rename_in_grids(state);
    record_undo(state);
}
"##,
            "grid",
        ),
    ];
    for (label, src, store) in flagged_through_calls {
        let hits = late_store_inversions("planted.rs", src, &name_graph, &wider);
        assert!(
            hits.iter().any(|h| h.acquiring == *store && h.via.is_some()),
            "census 2 missed `{store}` taken THROUGH A CALL in `{label}`, so it cannot see the shape it now reads: {hits:?}"
        );
    }

    // THE CALL READER: method calls, declarations and a type's functions are not
    // calls of the free function; a path-qualified call is.
    let calls: Vec<&str> = calls_on_line(
        "    let a = crate::m::names_helper(x); b.names_helper(); Names::names_helper(); names_helper(y);",
        &graph,
    )
    .into_iter()
    .map(|(_, name)| name)
    .collect();
    assert_eq!(calls, vec!["names_helper", "names_helper"], "the bare and the path-qualified call, nothing else");
    assert!(calls_on_line("pub(crate) fn names_helper(state: &AppState) {", &graph).is_empty(), "a declaration");
}

/// The one-level call graph is what lets census 1 see the recorder: the real
/// crate's graph must know it, must charge it with what its body takes, and
/// must leave a name two free functions declare to neither.
#[test]
fn the_call_graph_knows_the_recorder_and_leaves_ambiguous_names_out() {
    let graph = direct_acquisitions_by_function(&crate_sources());
    let recorder = graph.get(RECORDER).expect("the recorder is a uniquely named free function");
    assert_eq!(
        recorder,
        &vec![
            "sheet_ids".to_string(),
            "subscriptions".to_string(),
            "writeback_index".to_string(),
            "override_layer".to_string(),
            "id_registry".to_string(),
        ],
        "the recorder's own stores, in the order it takes them"
    );
    let planted = vec![
        ("a.rs".to_string(), "pub fn twin(state: &AppState) {\n    let n = state.sheet_names.read().unwrap();\n}\n".to_string()),
        ("b.rs".to_string(), "pub fn twin(state: &AppState) {\n    let t = state.tables.read().unwrap();\n}\n".to_string()),
        (
            "c.rs".to_string(),
            "pub fn alone(state: &AppState) {\n    let t = state.tables.read().unwrap();\n}\n\nimpl Thing {\n    fn method(&self, state: &AppState) {\n        let g = state.grids.read().unwrap();\n    }\n}\n"
                .to_string(),
        ),
    ];
    let graph = direct_acquisitions_by_function(&planted);
    assert!(!graph.contains_key("twin"), "a name two free functions declare is charged to neither: {graph:?}");
    assert_eq!(
        graph.get("alone"),
        Some(&vec!["tables".to_string()]),
        "an impl block after a function is not that function's body: {graph:?}"
    );
}

// ---------------------------------------------------------------------------
// R5-TORN-PAIR-SIBLINGS: the pair is read under ONE hold, crate-wide
// ---------------------------------------------------------------------------

/// How close two separate reads of `sheet_ids` and `sheet_names` must be for the
/// torn-pair census to read them as one pairing read. Every torn read the review
/// found sits within this many lines, most of them on ADJACENT lines; a read of
/// each store for unrelated reasons is seldom this close.
const TORN_PAIR_WINDOW: usize = 4;

/// What [`sheet_pair_reads`] found in one file.
#[derive(Debug, Default)]
struct SheetPairScan {
    /// A `sheet_ids` read made in a hold of its own within [`TORN_PAIR_WINDOW`]
    /// lines of a separate `sheet_names` read: the pair torn.
    torn: Vec<PairInversion>,
    /// Functions that read `sheet_ids` while `sheet_names` is held -- a bound
    /// guard, or a temporary earlier in the same statement: the pair read under
    /// one hold.
    paired: Vec<String>,
}

/// The column in `code[i]` of an acquisition `acquisitions_at` reported at
/// `joined_col` of its joined statement.
fn column_in_line(code: &[&str], i: usize, joined_col: usize) -> usize {
    let mut prefix = chain_prefix(code, i);
    if prefix.is_empty() {
        prefix = let_head_above(code, i);
    }
    if prefix.is_empty() {
        return joined_col;
    }
    let indent = code[i].len() - code[i].trim_start().len();
    joined_col.saturating_sub(prefix.len()) + indent
}

/// Where the statement holding an acquisition at line `i`, column `col` ends, as
/// `(line, column)`: the first `;` at its own depth or outside it, or the `}`
/// that closes the block it sits in. A TEMPORARY guard of that statement --
/// `state.sheet_names.read()?.clone()` inside a tuple -- lives until then.
fn statement_end(code: &[&str], i: usize, col: usize) -> (usize, usize) {
    let mut depth: i32 = 0;
    for (j, line) in code.iter().enumerate().skip(i).take(64) {
        let start = if j == i { col.min(line.len()) } else { 0 };
        for (k, c) in line[start..].char_indices() {
            match c {
                '(' | '[' | '{' => depth += 1,
                ')' | ']' => depth -= 1,
                '}' => {
                    depth -= 1;
                    if depth < 0 {
                        return (j, start + k);
                    }
                }
                ';' if depth <= 0 => return (j, start + k),
                _ => {}
            }
        }
    }
    (code.len(), 0)
}

/// Every pairing read of `sheet_ids` and `sheet_names` in `text`, torn or held.
///
/// A function here is any `fn`, a METHOD included (`SheetProvenance::snapshot`
/// is one of the sites), unlike the lock-order censuses, which only need free
/// functions. Only READS count: a write of each store is another question.
fn sheet_pair_reads(file: &str, text: &str) -> SheetPairScan {
    use crate::formula_serialisation_tests::starts_a_function;
    let stripped = blank_literals(&strip_cfg_test_items(text));
    let lines: Vec<&str> = stripped.lines().collect();
    let code: Vec<&str> = lines.iter().map(|l| l.split("//").next().unwrap_or("")).collect();

    /// The torn reads of one finished function.
    fn close_function(
        file: &str,
        function: Option<&str>,
        names_reads: &[usize],
        lone_ids_reads: &[usize],
        torn: &mut Vec<PairInversion>,
    ) {
        let Some(name) = function else { return };
        for &ids_line in lone_ids_reads {
            if names_reads.iter().any(|&names_line| names_line.abs_diff(ids_line) <= TORN_PAIR_WINDOW) {
                torn.push(PairInversion { file: file.to_string(), function: name.to_string(), line: ids_line + 1 });
            }
        }
    }

    let mut scan = SheetPairScan::default();
    let mut current: Option<String> = None;
    let mut depth: i32 = 0;
    // Live, BOUND `sheet_names` guards (binding, scope), and where the statement
    // holding a TEMPORARY one ends.
    let mut names_guards: Vec<(String, i32)> = Vec::new();
    let mut names_statement_until: Option<(usize, usize)> = None;
    // This function's `sheet_names` reads, and its `sheet_ids` reads that had no
    // `sheet_names` hold around them.
    let mut names_reads: Vec<usize> = Vec::new();
    let mut lone_ids_reads: Vec<usize> = Vec::new();

    for (i, raw) in lines.iter().enumerate() {
        let declaration = raw.trim_start();
        if starts_a_function(declaration) {
            close_function(file, current.as_deref(), &names_reads, &lone_ids_reads, &mut scan.torn);
            names_reads.clear();
            lone_ids_reads.clear();
            current = function_name_of(declaration);
            depth = 0;
            names_guards.clear();
            names_statement_until = None;
        }
        let line = code[i];
        let (acquisitions, statement) = acquisitions_at(&code, i, &statement_tail(&code, i));
        for acq in acquisitions {
            let col = column_in_line(&code, i, acq.col);
            if acq.field == "sheet_names" {
                if acq.method == ".read(" {
                    names_reads.push(i);
                }
                if acq.live {
                    let is_let_binding = statement.trim_start().starts_with("let ");
                    let scope = if !is_let_binding && line.trim_end().ends_with('{') { depth + 1 } else { depth };
                    names_guards.push((acq.binding.clone(), scope));
                } else {
                    names_statement_until = Some(statement_end(&code, i, col));
                }
            } else if acq.field == "sheet_ids" && acq.method == ".read(" {
                let in_the_names_statement =
                    names_statement_until.is_some_and(|(end_line, end_col)| i < end_line || (i == end_line && col < end_col));
                if !names_guards.is_empty() || in_the_names_statement {
                    if let Some(name) = &current {
                        if !scan.paired.contains(name) {
                            scan.paired.push(name.clone());
                        }
                    }
                } else {
                    lone_ids_reads.push(i);
                }
            }
        }
        let dropped = dropped_on_line(line);
        names_guards.retain(|(binding, _)| binding.is_empty() || !dropped.contains(binding));
        let opens_here = line.matches('{').count() as i32;
        let closes_here = line.matches('}').count() as i32;
        depth -= closes_here;
        names_guards.retain(|(_, scope)| depth >= *scope);
        depth += opens_here;
    }
    close_function(file, current.as_deref(), &names_reads, &lone_ids_reads, &mut scan.torn);
    scan
}

/// The nine torn reads round 6 could not reach (BUG-0592) -- each read the pair
/// in two clone-and-release holds -- now read it under ONE hold, names first:
/// eight through `calp_commands::sheet_ids_and_names`, which the scan cannot see
/// read anything (a call), and `with_pane_controls_following_rename` in a
/// closure holding the names guard while it reads the ids. The allowlist that
/// tolerated them is gone; this pins that each is still a pairing read.
const ROUND_SIX_TORN_SITES_NOW_ONE_HOLD: [(&str, &str); 9] = [
    ("calp_collection.rs", "ready_author_collections"),
    ("calp_collection.rs", "list_collection_regions"),
    ("commands/sheet_blank.rs", "sheet_contents"),
    ("object_bindings/formula.rs", "read"),
    ("object_bindings/object_json.rs", "read"),
    ("object_bindings/page_overrides.rs", "read"),
    ("scripting/application_code_gate.rs", "workbook_sheet_facts"),
    // `run_cell_internal`'s phase-1 read, moved into a helper so its one hold
    // of `grids` can be proved at run time
    // (`the_notebook_reads_the_grids_and_the_sheet_ids_in_one_hold`).
    ("scripting/notebook_commands.rs", "read_cell_run_inputs"),
    ("sheets.rs", "with_pane_controls_following_rename"),
];

/// BUG-0592: each of the nine reads the pair through the shared one-hold
/// helper, or (the pane rename) reads `sheet_ids` while its `sheet_names`
/// guard is held -- and none reads either store a second time on its own.
///
/// SABOTAGE: give `sheet_contents` its two reads back -- the crate-wide census
/// below fails naming it (and this one, which finds no one-hold read in it).
#[test]
fn the_nine_round_six_torn_reads_read_the_pair_under_one_hold() {
    for (file, function) in ROUND_SIX_TORN_SITES_NOW_ONE_HOLD {
        let text = std::fs::read_to_string(src_root().join(file)).unwrap_or_else(|_| panic!("cannot read {file}"));
        let scan = sheet_pair_reads(file, &text);
        assert!(
            !scan.torn.iter().any(|hit| hit.function == function),
            "`{file}::{function}` reads `sheet_ids` and `sheet_names` in two holds again: {scan:?}"
        );
        let through_helper = {
            let blanked = blank_literals(&strip_cfg_test_items(&text));
            let mut in_function = false;
            let mut found = false;
            for line in blanked.lines() {
                if crate::formula_serialisation_tests::starts_a_function(line.trim_start()) {
                    in_function = function_name_of(line.trim_start()).as_deref() == Some(function);
                }
                let code = line.split("//").next().unwrap_or("");
                if in_function && code.contains("sheet_ids_and_names(") {
                    found = true;
                }
            }
            found
        };
        let held_together = scan.paired.iter().any(|f| f == function);
        assert!(
            through_helper || held_together,
            "`{file}::{function}` no longer reads the sheet pair under one hold -- neither through \
             `calp_commands::sheet_ids_and_names` nor with its `sheet_names` guard held while it reads \
             `sheet_ids` (BUG-0592)"
        );
    }
}

/// R5-TORN-PAIR-SIBLINGS, over every function in the crate: a function that
/// pairs `sheet_ids[i]` with `sheet_names[i]` reads them under ONE hold,
/// `sheet_names` first -- `calp_commands::sheet_ids_and_names`, a block holding
/// both guards, or one statement whose `sheet_names` temporary is still alive
/// when `sheet_ids` is read. Two separate clone-and-release reads let a delete
/// or a move land between them, and a writer takes `sheet_names` first and
/// writes `sheet_ids` late, so a reader overlapping it gets the old ids beside
/// the new names every time.
///
/// SABOTAGE: read `sheet_ids` and then `sheet_names` in two statements again in
/// `prepare_refresh_payloads` -- this fails naming it.
#[test]
fn no_function_reads_sheet_ids_and_sheet_names_in_two_holds() {
    let mut offenders: Vec<String> = Vec::new();
    let mut paired: Vec<String> = Vec::new();
    for (rel, text) in &crate_sources() {
        let scan = sheet_pair_reads(rel, text);
        for hit in scan.torn {
            offenders.push(format!("  {}::{} (line {})", hit.file, hit.function, hit.line));
        }
        paired.extend(scan.paired.into_iter().map(|function| format!("{rel}::{function}")));
    }
    // NON-VACUITY: the census SEES a one-hold read in every spelling the crate
    // uses -- the shared helper, a block, one statement, a method -- including
    // each one this round wrote.
    for anchor in [
        "calp_commands.rs::sheet_ids_and_names",
        "calp_commands.rs::calp_get_application_objects",
        "calp_commands.rs::calp_refresh_preview",
        "calp_commands.rs::detach_sheet_inner",
        "persistence.rs::build_workbook_for_save",
        "sheets.rs::snapshot",
        "sheets.rs::delete_sheet_impl",
        // BUG-0592: a closure holding the names guard while it reads the ids.
        "sheets.rs::with_pane_controls_following_rename",
    ] {
        assert!(
            paired.iter().any(|p| p == anchor),
            "the census no longer sees `{anchor}` read the pair under one hold, so it may not be reading \
             what it claims to. It sees:\n  {}",
            paired.join("\n  ")
        );
    }
    offenders.sort();
    offenders.dedup();
    assert!(
        offenders.is_empty(),
        "these functions read `sheet_ids` and `sheet_names` in two separate holds a few lines apart:\n{}\n\n\
         Each pairs `sheet_ids[i]` with `sheet_names[i]`. A delete takes `sheet_names` first and removes \
         the id late, so a reader that overlaps it gets the OLD ids beside the NEW names and pairs every \
         later sheet with its neighbour's name -- a refresh then rewrote pulled formulas to read the wrong \
         sheet and saved them (R5-TORN-PAIR-SIBLINGS). Read both under one hold, `sheet_names` first: \
         `calp_commands::sheet_ids_and_names`, or one block holding both guards.",
        offenders.join("\n")
    );
}

/// The calp sites R5-TORN-PAIR-SIBLINGS routed through `sheet_ids_and_names`.
const READ_THROUGH_SHEET_IDS_AND_NAMES: [&str; 8] = [
    "subscriber_published_names",
    "rename_pulled_references_for_reset",
    "working_copy_sheet_renames",
    "publish_preview_sheet_list",
    "materialize_pulled_floating_ranges",
    "prepare_refresh_payloads",
    "sheet_provenance_rows",
    "writeback_region_entries",
];

/// Every pairing site round 6 fixed, by name -- beside
/// `the_four_calp_sites_pair_sheet_ids_with_sheet_names_under_one_hold`, which
/// pins the four R4-LOCK-1 fixed: the eight that read through the shared
/// helper (and the helper's own one hold), the Application Explorer's single
/// statement, and the provenance snapshot's block.
///
/// SABOTAGE: give `subscriber_published_names` its two reads back -- this fails
/// naming it.
#[test]
fn every_pairing_site_round_six_fixed_reads_the_pair_under_one_hold() {
    let calp = std::fs::read_to_string(src_root().join("calp_commands.rs")).expect("cannot read calp_commands.rs");
    let blanked = blank_literals(&calp);
    for function in READ_THROUGH_SHEET_IDS_AND_NAMES {
        let body: String = function_body(&blanked, &format!("pub(crate) fn {function}("))
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            body.contains("sheet_ids_and_names(state)"),
            "`{function}` no longer reads the sheet pair through `sheet_ids_and_names` -- the one hold, \
             names first (R5-TORN-PAIR-SIBLINGS)"
        );
        for direct in ["sheet_ids.read(", "sheet_names.read("] {
            assert!(
                !body.contains(direct),
                "`{function}` reads `{direct}..` itself again beside the shared one-hold read, which is \
                 how the pair it builds gets torn"
            );
        }
    }
    let held_together = pair_inversions("calp_commands.rs", &calp, "sheet_names", "sheet_ids");
    assert!(
        held_together.iter().any(|hit| hit.function == "sheet_ids_and_names"),
        "`sheet_ids_and_names` no longer holds `sheet_names` while it reads `sheet_ids`"
    );
    let explorer = sheet_pair_reads("calp_commands.rs", &calp);
    assert!(
        explorer.paired.iter().any(|f| f == "calp_get_application_objects"),
        "`calp_get_application_objects` no longer reads `sheet_ids` while its `sheet_names` read is held"
    );
    let sheets = std::fs::read_to_string(src_root().join("sheets.rs")).expect("cannot read sheets.rs");
    let provenance = sheet_pair_reads("sheets.rs", &sheets);
    assert!(
        provenance.paired.iter().any(|f| f == "snapshot") && !provenance.torn.iter().any(|h| h.function == "snapshot"),
        "`SheetProvenance::snapshot` no longer reads the pair under one hold"
    );
}

/// The torn-pair detector, on each shape the round found and on the fixed ones.
#[test]
fn the_torn_pair_detector_fires_on_every_shape_it_exists_for() {
    let torn: &[(&str, &str, &str)] = &[
        (
            "ids, then names (the refresh's name pass as it stood)",
            r##"pub(crate) fn prepare_refresh_payloads(state: &AppState) -> Result<(), String> {
    let sheet_ids: Vec<SheetId> = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
    let mut taken: Vec<String> = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    Ok(())
}
"##,
            "prepare_refresh_payloads",
        ),
        (
            "names, then ids, in two statements",
            r##"pub(crate) fn sheet_provenance_rows(state: &AppState) -> Result<(), String> {
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
    Ok(())
}
"##,
            "sheet_provenance_rows",
        ),
        (
            "another store read between the two",
            r##"pub(crate) fn publish_preview_sheet_list(state: &AppState) -> Result<(), String> {
    let names = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let visibility = state.sheet_visibility.read().map_err(|e| e.to_string())?.clone();
    let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
    Ok(())
}
"##,
            "publish_preview_sheet_list",
        ),
        (
            "a method (the provenance snapshot as it stood)",
            r##"impl SheetProvenance {
    pub(crate) fn snapshot(state: &AppState) -> Result<Self, String> {
        let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
        let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
        Ok(Self::default())
    }
}
"##,
            "snapshot",
        ),
        (
            "two reads inside a closure",
            r##"pub(crate) fn following_rename(state: &AppState, id: SheetId) -> Option<String> {
    let name_of = |id: SheetId| -> Option<String> {
        let index = state.sheet_ids.read().ok()?.iter().position(|s| *s == id)?;
        state.sheet_names.read().ok()?.get(index).cloned()
    };
    name_of(id)
}
"##,
            "following_rename",
        ),
        (
            "ids FIRST in one statement: the ids temporary is what is held",
            r##"pub fn ids_first(state: &AppState) -> Result<(), String> {
    let (ids, names) = (
        state.sheet_ids.read().map_err(|e| e.to_string())?.clone(),
        state.sheet_names.read().map_err(|e| e.to_string())?.clone(),
    );
    Ok(())
}
"##,
            "ids_first",
        ),
        (
            "the names guard dropped before the ids read",
            r##"pub fn dropped_first(state: &AppState) -> Result<(), String> {
    let names = state.sheet_names.read().map_err(|e| e.to_string())?;
    let copy = names.clone();
    drop(names);
    let ids = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
    Ok(())
}
"##,
            "dropped_first",
        ),
    ];
    for (label, src, function) in torn {
        let scan = sheet_pair_reads("planted.rs", src);
        let named: Vec<&str> = scan.torn.iter().map(|h| h.function.as_str()).collect();
        assert_eq!(named, vec![*function], "the detector missed `{label}`: {scan:?}");
        assert!(scan.paired.is_empty(), "`{label}` read as paired: {scan:?}");
    }

    let held: &[(&str, &str, &str)] = &[
        (
            "one block, names first (the shared helper)",
            r##"pub(crate) fn sheet_ids_and_names(state: &AppState) -> Result<(Vec<SheetId>, Vec<String>), String> {
    let names = state.sheet_names.read().map_err(|e| e.to_string())?;
    let ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
    Ok((ids.clone(), names.clone()))
}
"##,
            "sheet_ids_and_names",
        ),
        (
            "one statement, names first (the Application Explorer)",
            r##"pub fn calp_get_application_objects(state: State<AppState>) -> Result<(), String> {
    let (sheet_names, sheet_ids): (Vec<String>, Vec<SheetId>) = (
        state.sheet_names.read().map_err(|e| e.to_string())?.clone(),
        state.sheet_ids.read().map_err(|e| e.to_string())?.clone(),
    );
    Ok(())
}
"##,
            "calp_get_application_objects",
        ),
        (
            "a block inside a `let` (the refresh preview)",
            r##"pub fn calp_refresh_preview(state: State<AppState>) -> Result<(), String> {
    let (local_sheet_names, mut taken_names): (std::collections::HashMap<SheetId, String>, Vec<String>) = {
        let names = state.sheet_names.read().map_err(|e| e.to_string())?;
        let ids = state.sheet_ids.read().map_err(|e| e.to_string())?;
        (
            ids.iter().enumerate().filter_map(|(i, id)| names.get(i).map(|n| (*id, n.clone()))).collect(),
            names.clone(),
        )
    };
    Ok(())
}
"##,
            "calp_refresh_preview",
        ),
    ];
    for (label, src, function) in held {
        let scan = sheet_pair_reads("planted.rs", src);
        assert!(scan.torn.is_empty(), "the detector called `{label}` torn: {scan:?}");
        assert_eq!(scan.paired, vec![function.to_string()], "`{label}` did not read as paired: {scan:?}");
    }

    let unrelated: &[(&str, &str)] = &[
        (
            "an ids read far from any names read",
            r##"pub fn far_apart(state: &AppState) -> Result<(), String> {
    let ids = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
    let a = 1;
    let b = 2;
    let c = 3;
    let d = 4;
    let e = 5;
    let names = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    Ok(())
}
"##,
        ),
        (
            "writes are not reads",
            r##"pub fn reset(state: &AppState, effect: &DocumentEffect) -> Result<(), String> {
    *state.sheet_names.write(effect).map_err(|e| e.to_string())? = vec![];
    *state.sheet_ids.write(effect).map_err(|e| e.to_string())? = vec![];
    Ok(())
}
"##,
        ),
    ];
    for (label, src) in unrelated {
        let scan = sheet_pair_reads("planted.rs", src);
        assert!(scan.torn.is_empty(), "the detector called `{label}` torn: {scan:?}");
    }
}

// ===========================================================================
// F1 (REVIEW ROUND 7): ONE SNAPSHOT, NEVER A TORN ONE
// ===========================================================================
//
// BUG-0591's fix released `grid`, `grids` and `sheet_names` right after the
// save's sheet loop -- to stop the save holding stores a cell writer takes
// late -- and so let a structural sheet operation running OFF the main thread
// land between the loop and the stores paired with the sheet list BY INDEX.
// The async drill-through's `append_user_sheet` (a tokio worker) rotated a
// floating grid's object sheet one place right under a save, which then wrote
// that sheet as a visible tab with the new sheet's kind and page setup and
// dropped its CF and DV; an MCP agent's delete gave every later sheet its
// neighbour's metadata. Nothing reported either.
//
// The fix has two halves (`persistence.rs`, "ONE SNAPSHOT, NEVER A TORN ONE"):
//
//   1. THE BODY (`build_workbook_for_save`) holds `grid` then `grids` from its
//      first store read to its last, so no renumbering can land inside it.
//      Every renumbering and every cell writer takes one of the two FIRST, and
//      the crate's order is grid, grids, then everything else -- the hold
//      closes no cycle. Checked transitively before landing: nothing the body
//      reaches re-takes a grid lock, awaits, does file IO, or takes a store any
//      other path holds while acquiring a grid lock.
//   2. THE TAILS (the rest of the `.cala` snapshot, the `.calp` carrier's slicer
//      and timeline collectors and the rest of the publish assembly) cannot be
//      held that way: they read `SlicerState::slicers`, and the async
//      `get_slicer_items_core` held the slicers while it read `grids` (until
//      BUG-0593: it copies and releases them now). They
//      keep BUG-0591's lock shape and are VALIDATED: the body reads
//      `AppState::sheet_structure_generation` under its hold, every renumbering
//      bumps it inside its `sheet_names` hold (`remap_sheet_keyed_stores`, and
//      the two whole-list installs), and `take_consistent_snapshot` re-reads it
//      after the tail under `sheet_names` alone -- an overlapped snapshot is
//      taken again, and after `SNAPSHOT_ATTEMPTS` refused retryably.
//
// Pinned by two runtime probes (each with a partner that drives the SAME
// harness with the pre-fix shape and must see the tear), a unit test of the
// retry, a source pin that the hold spans the body, a source pin that every
// snapshot door validates its tail, and a census that every renumbering moves
// the generation.

/// What a save wrote for a floating grid's object sheet: the stores a torn
/// snapshot got wrong.
#[derive(Debug, PartialEq)]
struct ObjectSheetAsSaved {
    sheet_count: usize,
    visibility: String,
    canvas: bool,
    orientation: String,
    cf_under_its_id: bool,
    dv_under_its_id: bool,
}

/// What the object sheet `object_id` looks like in a saved workbook.
fn object_sheet_as_saved(workbook: &::persistence::Workbook, object_id: identity::SheetId) -> ObjectSheetAsSaved {
    let sheet = workbook
        .sheets
        .iter()
        .find(|s| s.id == object_id)
        .expect("the snapshot lost the object sheet altogether");
    ObjectSheetAsSaved {
        sheet_count: workbook.sheets.len(),
        visibility: sheet.visibility.clone(),
        canvas: sheet.kind.is_canvas(),
        orientation: sheet.page_setup.as_ref().map(|p| p.orientation.clone()).unwrap_or_default(),
        cf_under_its_id: workbook.conditional_formats.iter().any(|c| c.sheet_id == object_id),
        dv_under_its_id: workbook.data_validations.iter().any(|d| d.sheet_id == object_id),
    }
}

/// Append a sheet through the shared push-list, as `create_floating_range` (an
/// object sheet) or a pull (a user sheet at the end) does. Test seeding only.
fn append_sheet_for_test(state: &AppState, name: &str, visibility: &str) -> (usize, identity::SheetId) {
    let effect = test_seed_effect();
    let mut grids = state.grids.write(&effect).unwrap();
    let mut sheet_names = state.sheet_names.write(&effect).unwrap();
    let mut freeze_configs = state.freeze_configs.write(&effect).unwrap();
    let mut tab_colors = state.tab_colors.write(&effect).unwrap();
    let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();
    let mut all_column_widths = state.all_column_widths.write(&effect).unwrap();
    let mut all_row_heights = state.all_row_heights.write(&effect).unwrap();
    crate::sheets::append_sheet_stores(
        state,
        &effect,
        name.to_string(),
        visibility,
        ::persistence::SheetKind::Worksheet,
        &mut sheet_names,
        &mut grids,
        &mut freeze_configs,
        &mut tab_colors,
        &mut sheet_visibility,
        &mut all_column_widths,
        &mut all_row_heights,
    )
}

/// `[Sheet1, Float1]`, where `Float1` is a floating grid's OBJECT-backed sheet
/// at the tail carrying its own page setup (landscape), a CF rule and a DV
/// range -- exactly what the torn save got wrong. Returns the state and the
/// object sheet's id.
fn workbook_with_an_object_sheet_at_the_tail() -> (Arc<AppState>, identity::SheetId) {
    use crate::conditional_formatting as cf;
    use crate::data_validation as dv;
    let state = crate::create_app_state();
    let (index, object_id) = append_sheet_for_test(&state, "Float1", crate::sheets::OBJECT_SHEET_VISIBILITY);
    assert_eq!(index, 1, "fixture: the object sheet is the second sheet");
    let effect = test_seed_effect();
    state.page_setups.write(&effect).unwrap()[index].orientation = "landscape".to_string();
    state.conditional_formats.write(&effect).unwrap().insert(
        index,
        vec![cf::ConditionalFormatDefinition {
            id: 7,
            priority: 1,
            rule: cf::ConditionalFormatRule::BlankCells,
            format: cf::ConditionalFormat { background_color: Some("#FFEE00".to_string()), ..Default::default() },
            ranges: vec![cf::ConditionalFormatRange { start_row: 0, start_col: 0, end_row: 3, end_col: 2 }],
            stop_if_true: false,
            enabled: true,
        }],
    );
    state.data_validations.write(&effect).unwrap().insert(
        index,
        vec![dv::ValidationRange {
            start_row: 0,
            start_col: 0,
            end_row: 4,
            end_col: 0,
            validation: dv::DataValidation {
                rule: dv::DataValidationRule::List(dv::ListRule {
                    source: dv::ListSource::Values(vec!["Yes".to_string(), "No".to_string()]),
                    in_cell_dropdown: true,
                }),
                ..dv::DataValidation::default()
            },
        }],
    );
    (Arc::new(state), object_id)
}

/// Run `save` on a thread of its own and park it INSIDE ITS HELD REGION: this
/// thread holds `notes`, which `enrich_workbook_metadata` reads and
/// `append_user_sheet` never takes. While it is parked, run the async
/// drill-through's add on a third thread -- an EPHEMERAL canvas sheet, which
/// lands in front of the object tail and rotates the object sheet one place to
/// the right. Returns `(parked, added_while_parked, the save's result)`.
///
/// `parked` is the precondition (a save that finished never waited). The add is
/// given a second to complete while the save is parked: a save holding the grid
/// locks makes it wait for `grid`, one that released them lets it through. The
/// park is released before anything is asserted, so a failure never leaves a
/// thread parked for the rest of the binary.
fn run_a_drill_through_add_while_the_save_is_parked<R, F>(state: &Arc<AppState>, save: F) -> (bool, bool, R)
where
    R: Send + 'static,
    F: FnOnce(&AppState) -> R + Send + 'static,
{
    let parked_on_notes = state.notes.read().unwrap();
    let started = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let saver = {
        let state = Arc::clone(state);
        let started = Arc::clone(&started);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            started.store(true, Ordering::SeqCst);
            let result = save(&*state);
            finished.store(true, Ordering::SeqCst);
            result
        })
    };
    let began = wait_until(2_000, || started.load(Ordering::SeqCst));
    // Long enough for the save to reach whatever it blocks on.
    std::thread::sleep(Duration::from_millis(250));
    let parked = began && !finished.load(Ordering::SeqCst);
    let added = Arc::new(AtomicBool::new(false));
    let adder = {
        let state = Arc::clone(state);
        let added = Arc::clone(&added);
        std::thread::spawn(move || {
            let file = crate::persistence::FileState::default();
            let appended = crate::sheets::append_user_sheet(
                &state,
                &file,
                crate::sheets::EphemeralUserSheet {
                    sheet: crate::sheets::NewUserSheet {
                        name: crate::sheets::NewSheetName::FirstFree("Drill".to_string()),
                        kind: ::persistence::SheetKind::new_canvas(),
                        cells: None,
                        activate: false,
                    },
                    refusal: "a drill-through sheet is already open",
                },
                "drill through to a sheet",
            );
            added.store(true, Ordering::SeqCst);
            appended.map(|a| a.index)
        })
    };
    let added_while_parked = wait_until(1_000, || added.load(Ordering::SeqCst));
    drop(parked_on_notes);
    let result = saver.join().expect("the save's thread panicked");
    let appended_at = adder.join().expect("the add's thread panicked");
    assert_eq!(appended_at, Ok(1), "fixture: the drill-through's sheet lands in front of the object tail");
    (parked, added_while_parked, result)
}

/// THE DEFECT AS A TEST THAT FAILS RATHER THAN WRITES A TORN FILE: a save parked
/// inside `build_workbook_for_save`'s per-sheet reads must keep the async
/// drill-through's add OUT until it has read them all, and must write the
/// object sheet as itself.
///
/// SABOTAGE: move `drop(grids); drop(active_grid);` in `build_workbook_for_save`
/// back to right after the sheet loop -- the add completes while the save is
/// parked, and the object sheet is saved visible, as a canvas, portrait, with
/// its CF and DV gone.
#[test]
fn a_drill_through_add_cannot_land_inside_the_saves_snapshot() {
    let (state, object_id) = workbook_with_an_object_sheet_at_the_tail();
    let (parked, added_while_parked, saved) = run_a_drill_through_add_while_the_save_is_parked(&state, move |state| {
        let files = crate::persistence::UserFilesState::default();
        let bi = crate::bi::types::BiState::new();
        let (workbook, _basis) = crate::persistence::build_workbook_for_save(
            state,
            &files,
            &bi,
            crate::persistence::ChartKeysFor::Document,
        )
        .expect("the save builds");
        object_sheet_as_saved(&workbook, object_id)
    });
    assert!(
        parked,
        "PRECONDITION FAILED: the save finished while `notes` was held, so it never waited inside its \
         snapshot and this test measured nothing"
    );
    assert!(
        !added_while_parked,
        "the drill-through's add completed while the save was parked inside its snapshot: \
         `build_workbook_for_save` is not holding `grid` / `grids` from its first read to its last, so a \
         structural sheet operation running off the main thread can renumber the sheets between the sheet \
         loop and the stores paired with it by index (F1, review round 7)"
    );
    assert_eq!(
        saved,
        ObjectSheetAsSaved {
            sheet_count: 2,
            visibility: crate::sheets::OBJECT_SHEET_VISIBILITY.to_string(),
            canvas: false,
            orientation: "landscape".to_string(),
            cf_under_its_id: true,
            dv_under_its_id: true,
        },
        "the save wrote a TORN snapshot of the floating grid's object sheet: its visibility, kind, page \
         setup or its formats and validations came from another sheet"
    );
    // ...and the add landed after the save, exactly where it belongs.
    assert_eq!(
        state.sheet_names.read().unwrap().clone(),
        vec!["Sheet1".to_string(), "Drill".to_string(), "Float1".to_string()],
        "fixture: the add did not land once the save let it in"
    );
}

/// NON-VACUITY for the probe above, through the SAME harness: a save in the
/// PRE-FIX SHAPE -- the sheet loop's guards released before the index-keyed
/// reads, which then park on `notes` the way `enrich_workbook_metadata` does --
/// must let the add through and read the object sheet's metadata off the sheet
/// that took its index. A harness that could not see that would pass the probe
/// whatever the save did.
#[test]
fn the_snapshot_probe_sees_the_tear_a_save_that_releases_the_grid_locks_early_writes() {
    let (state, object_id) = workbook_with_an_object_sheet_at_the_tail();
    let (parked, added_while_parked, saved) = run_a_drill_through_add_while_the_save_is_parked(&state, move |state| {
        // THE PRE-FIX SHAPE (BUG-0591's): copy the sheet list under the loop's
        // guards and release them...
        let active_grid = state.grid.read().unwrap();
        let grids = state.grids.read().unwrap();
        let sheet_names = state.sheet_names.read().unwrap();
        let ids: Vec<identity::SheetId> = state.sheet_ids.read().unwrap().clone();
        let sheet_count = sheet_names.len();
        drop(sheet_names);
        drop(grids);
        drop(active_grid);
        // ...then the index-keyed reads, the first of them parked as enrich's is.
        let _notes = state.notes.read().unwrap().len();
        let index = ids.iter().position(|id| *id == object_id).expect("fixture: the object sheet's id");
        ObjectSheetAsSaved {
            sheet_count,
            visibility: state.sheet_visibility.read().unwrap()[index].clone(),
            canvas: state.sheet_kinds.read().unwrap()[index].is_canvas(),
            orientation: state.page_setups.read().unwrap()[index].orientation.clone(),
            cf_under_its_id: state.conditional_formats.read().unwrap().keys().any(|k| ids.get(*k) == Some(&object_id)),
            dv_under_its_id: state.data_validations.read().unwrap().keys().any(|k| ids.get(*k) == Some(&object_id)),
        }
    });
    assert!(parked, "fixture: the planted pre-fix save never waited on `notes`");
    assert!(
        added_while_parked,
        "the harness kept the add out of a save that holds nothing -- it cannot tell a held snapshot from \
         an unheld one, so the probe above is vacuous"
    );
    assert_ne!(
        saved.visibility,
        crate::sheets::OBJECT_SHEET_VISIBILITY,
        "the pre-fix shape read the object sheet's own visibility -- the harness did not interleave the add"
    );
    assert!(saved.canvas, "the pre-fix shape should have read the drill-through sheet's canvas kind: {saved:?}");
    assert_ne!(saved.orientation, "landscape", "the pre-fix shape kept the object sheet's page setup: {saved:?}");
    assert!(
        !saved.cf_under_its_id && !saved.dv_under_its_id,
        "the pre-fix shape kept the object sheet's CF / DV under its id: {saved:?}"
    );
}

/// `[Sheet1, B, C]` with an AutoFilter on `C` -- a per-sheet store the save's
/// TAIL writes (`autofilters.json`, keyed by sheet INDEX). Returns the state and
/// `C`'s id.
fn three_sheets_with_an_autofilter_on_the_last() -> (Arc<AppState>, identity::SheetId) {
    let state = crate::create_app_state();
    append_sheet_for_test(&state, "B", "visible");
    let (index, c_id) = append_sheet_for_test(&state, "C", "visible");
    assert_eq!(index, 2, "fixture: C is the third sheet");
    state
        .auto_filters
        .write(&test_seed_effect())
        .unwrap()
        .insert(index, crate::autofilter::AutoFilter::new(0, 0, 9, 1));
    (Arc::new(state), c_id)
}

/// The sheet each saved AutoFilter lands on when the file is read back: the
/// archive keys `autofilters.json` by sheet index, and the reader applies index
/// `k` to `workbook.sheets[k]`. `None` for an index the file has no sheet at.
fn autofilter_sheets_as_saved(workbook: &::persistence::Workbook) -> Vec<Option<identity::SheetId>> {
    let bytes = workbook.user_files.get("autofilters.json").expect("the save dropped the AutoFilter");
    let filters: serde_json::Value = serde_json::from_slice(bytes).expect("autofilters.json is JSON");
    let mut indices: Vec<usize> = filters
        .as_object()
        .expect("autofilters.json is keyed by sheet index")
        .keys()
        .map(|k| k.parse().expect("an AutoFilter key is a sheet index"))
        .collect();
    indices.sort_unstable();
    indices.into_iter().map(|i| workbook.sheets.get(i).map(|s| s.id)).collect()
}

/// What [`run_a_renumbering_while_the_save_is_parked_in_its_tail`] saw.
struct ParkedInItsTail<R, Q> {
    /// The save was seen INSIDE its body: holding `grids` (a probe could not
    /// take it) while it waited for `notes` in `enrich_workbook_metadata`.
    in_body: bool,
    /// ...then seen to LEAVE its body without finishing: the grid locks were
    /// free again while it was parked on `pivot_layouts` in its tail.
    left_body: bool,
    /// The renumbering completed while the save was still parked there.
    renumbered_while_parked: bool,
    /// The save's result.
    saved: R,
    /// How many snapshot attempts the save took
    /// (`persistence::SNAPSHOT_ATTEMPTS_TAKEN_FOR_TEST`, counted on the save's
    /// own thread): 2 means attempt 1 was refused and the retake kept.
    attempts: usize,
    /// The renumbering's own result.
    renumbered: Q,
}

impl<R, Q> ParkedInItsTail<R, Q> {
    /// THE PRECONDITION: the renumbering landed AFTER the save's body had copied
    /// the sheets and BEFORE its tail's last read. Anything less measured nothing.
    fn parked(&self) -> bool {
        self.in_body && self.left_body && self.renumbered_while_parked
    }
}

/// Run `save` on a thread of its own and park it in its TAIL -- PROVABLY past
/// its body -- then run `renumber` on a third thread while it is parked there.
///
/// TWO PHASES (F4, review round 8). The single park this replaces held only
/// `pivot_layouts` and slept 250 ms: a saver descheduled for that long was not
/// in its tail at all, the renumbering then landed BEFORE its body, attempt 1
/// read the renumbered workbook consistently, and the probe passed with no
/// retry at all -- with the door reduced to one unvalidated attempt, which is
/// exactly the sabotage it claimed to catch. Now:
///
///   1. `notes` and `pivot_layouts` are held before the save starts. The body
///      takes `grid` and `grids` FIRST and then waits for `notes` (read by
///      `enrich_workbook_metadata` under both); the tail waits for
///      `pivot_layouts` after the body released them. Neither renumbering under
///      test takes either store.
///   2. PHASE ONE: wait until a probe cannot take `grids` -- the save is inside
///      its body (nothing else here holds `grids`).
///   3. PHASE TWO: release `notes`, then wait until `grids` is free again while
///      the save has not finished -- its body is done, and its tail cannot get
///      past `pivot_layouts`.
///   4. Only then the renumbering, which must complete while the save is still
///      parked.
///
/// The attempt count is returned too, so a probe ASSERTS that attempt 1 was
/// refused rather than inferring it from the timing. Every park is released
/// before anything is asserted, so a failure never leaves a thread parked for
/// the rest of the binary.
fn run_a_renumbering_while_the_save_is_parked_in_its_tail<R, F, Q, G>(
    state: &Arc<AppState>,
    save: F,
    renumber: G,
) -> ParkedInItsTail<R, Q>
where
    R: Send + 'static,
    F: FnOnce(&AppState) -> R + Send + 'static,
    Q: Send + 'static,
    G: FnOnce(&AppState) -> Q + Send + 'static,
{
    let parked_on_notes = state.notes.read().unwrap();
    let parked_on_layouts = state.pivot_layouts.read().unwrap();
    let started = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let saver = {
        let state = Arc::clone(state);
        let started = Arc::clone(&started);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            crate::persistence::SNAPSHOT_ATTEMPTS_TAKEN_FOR_TEST.with(|taken| taken.set(0));
            started.store(true, Ordering::SeqCst);
            let result = save(&*state);
            let attempts = crate::persistence::SNAPSHOT_ATTEMPTS_TAKEN_FOR_TEST.with(|taken| taken.get());
            finished.store(true, Ordering::SeqCst);
            (result, attempts)
        })
    };
    let began = wait_until(2_000, || started.load(Ordering::SeqCst));
    // PHASE ONE: inside the body.
    let in_body =
        began && wait_until(5_000, || !finished.load(Ordering::SeqCst) && !probe_can_take_grids(state, 100));
    // PHASE TWO: out of the body, parked in the tail.
    drop(parked_on_notes);
    let left_body = in_body
        && wait_until(5_000, || probe_can_take_grids(state, 100))
        && !finished.load(Ordering::SeqCst);
    let renumbered = Arc::new(AtomicBool::new(false));
    let renumberer = {
        let state = Arc::clone(state);
        let renumbered = Arc::clone(&renumbered);
        std::thread::spawn(move || {
            let result = renumber(&*state);
            renumbered.store(true, Ordering::SeqCst);
            result
        })
    };
    let renumbered_while_parked =
        wait_until(5_000, || renumbered.load(Ordering::SeqCst)) && !finished.load(Ordering::SeqCst);
    drop(parked_on_layouts);
    let (saved, attempts) = saver.join().expect("the save's thread panicked");
    let renumbered = renumberer.join().expect("the renumbering's thread panicked");
    ParkedInItsTail { in_body, left_body, renumbered_while_parked, saved, attempts, renumbered }
}

/// Delete the sheet at `index` the way the MCP server's `delete_sheet` tool
/// does -- on the calling thread, with fresh object stores. Returns the sheet
/// count after the delete.
fn delete_sheet_as_an_agent_does(state: &AppState, index: usize) -> Result<usize, String> {
    let file = crate::persistence::FileState::default();
    let files = crate::persistence::UserFilesState::default();
    crate::sheets::delete_sheet_impl(
        state,
        &file,
        &PivotState::new(),
        &files,
        &crate::pane_control::PaneControlState::new(),
        &RibbonFilterState::new(),
        &SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        index,
        false,
        None,
    )
    .map(|r| r.sheets.len())
}

/// The async drill-through's add of a temporary canvas sheet, as
/// `drill_through_to_sheet` makes it. Returns the index it landed at.
fn add_a_drill_through_sheet(state: &AppState) -> Result<usize, String> {
    let file = crate::persistence::FileState::default();
    crate::sheets::append_user_sheet(
        state,
        &file,
        crate::sheets::EphemeralUserSheet {
            sheet: crate::sheets::NewUserSheet {
                name: crate::sheets::NewSheetName::FirstFree("Drill".to_string()),
                kind: ::persistence::SheetKind::new_canvas(),
                cells: None,
                activate: false,
            },
            refusal: "a drill-through sheet is already open",
        },
        "drill through to a sheet",
    )
    .map(|a| a.index)
}

/// Park `save` in its tail while an agent deletes sheet 1 (see
/// [`run_a_renumbering_while_the_save_is_parked_in_its_tail`]).
fn run_an_agents_delete_while_the_save_is_parked_in_its_tail<R, F>(
    state: &Arc<AppState>,
    save: F,
) -> ParkedInItsTail<R, Result<usize, String>>
where
    R: Send + 'static,
    F: FnOnce(&AppState) -> R + Send + 'static,
{
    run_a_renumbering_while_the_save_is_parked_in_its_tail(state, save, |state| delete_sheet_as_an_agent_does(state, 1))
}

/// The precondition message every tail probe asserts first.
const TAIL_PARK_PRECONDITION: &str = "PRECONDITION FAILED: the renumbering did not land between the save's body and its \
     tail's last read (the save was never seen holding the grid locks, never seen leaving them, or finished before \
     the renumbering completed), so this probe measured nothing";

/// The `.cala` save with every State it reads, as `save_file` hands it over.
fn save_through_every_door(state: &AppState) -> Result<::persistence::Workbook, String> {
    crate::persistence::assemble_workbook_for_save(
        state,
        &crate::persistence::UserFilesState::default(),
        &SlicerState::new(),
        &RibbonFilterState::new(),
        &crate::pane_control::PaneControlState::new(),
        &crate::scripting::types::ScriptState::new(),
        &PivotState::new(),
        &crate::bi::types::BiState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
    )
}

/// THE TAIL: an agent's delete landing after the body's hold but before the
/// tail's last read must not reach the file. The first attempt reads the
/// AutoFilter AFTER the delete re-keyed it from `C`'s old index to its new one,
/// against a body that still lists `B` there; `take_consistent_snapshot` sees
/// the generation the delete moved and takes the snapshot again -- and the
/// probe COUNTS the attempts, so a pass proves attempt 1 was refused rather
/// than that the delete happened to land before the body (F4, review round 8).
///
/// SABOTAGE: remove `note_sheet_structure_change(state)` from
/// `remap_sheet_keyed_stores` (or make `snapshot_is_current` answer `true`, or
/// reduce `take_consistent_snapshot` to one unvalidated attempt) -- the torn
/// first attempt is written, `C`'s AutoFilter filed under `B`.
#[test]
fn an_agents_delete_landing_in_the_saves_tail_is_taken_again_not_written_torn() {
    let (state, c_id) = three_sheets_with_an_autofilter_on_the_last();
    let run = run_an_agents_delete_while_the_save_is_parked_in_its_tail(&state, save_through_every_door);
    assert!(run.parked(), "{TAIL_PARK_PRECONDITION}");
    assert_eq!(run.renumbered, Ok(2), "fixture: the agent's delete was refused");
    assert_eq!(
        run.attempts, 2,
        "the save did not refuse its first attempt and keep the second: the delete landed after the body copied \
         [Sheet1, B, C] and before the tail's last read, so attempt 1 was torn and must have been taken again"
    );
    let workbook = run.saved.expect("the save refused, but only one renumbering overlapped it");
    let names: Vec<&str> = workbook.sheets.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["Sheet1", "C"], "the save did not describe the workbook as it is after the delete");
    assert_eq!(
        autofilter_sheets_as_saved(&workbook),
        vec![Some(c_id)],
        "the save wrote C's AutoFilter under another sheet: its tail read the store after an agent's delete \
         renumbered it, against a body copied before, and the snapshot was not taken again (F1, review round 7)"
    );
}

/// NON-VACUITY for the probe above, through the SAME harness: ONE attempt alone
/// (`assemble_workbook_snapshot`, the tail shape before the generation check)
/// must come back torn -- the body's sheets `[Sheet1, B, C]` beside an
/// AutoFilter already re-keyed onto index 1 -- and its basis must say so.
#[test]
fn one_snapshot_attempt_alone_is_torn_by_a_delete_in_its_tail_and_its_basis_says_so() {
    let (state, c_id) = three_sheets_with_an_autofilter_on_the_last();
    let run =
        run_an_agents_delete_while_the_save_is_parked_in_its_tail(&state, |state| {
            crate::persistence::assemble_workbook_snapshot(
                state,
                &crate::persistence::UserFilesState::default(),
                &SlicerState::new(),
                &RibbonFilterState::new(),
                &crate::pane_control::PaneControlState::new(),
                &crate::scripting::types::ScriptState::new(),
                &PivotState::new(),
                &crate::bi::types::BiState::new(),
                &crate::timeline_slicer::TimelineSlicerState::new(),
            )
        });
    assert!(run.parked(), "{TAIL_PARK_PRECONDITION}");
    assert_eq!(run.renumbered, Ok(2), "fixture: the agent's delete was refused");
    let (workbook, basis) = run.saved.expect("one attempt builds");
    let names: Vec<&str> = workbook.sheets.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["Sheet1", "B", "C"], "fixture: the attempt's body ran before the delete");
    assert_ne!(
        autofilter_sheets_as_saved(&workbook),
        vec![Some(c_id)],
        "the harness did not tear the attempt's tail, so the probe above cannot tell a validated snapshot \
         from an unvalidated one"
    );
    assert_eq!(
        crate::persistence::snapshot_is_current(&state, &basis),
        Ok(false),
        "the delete renumbered the sheets inside the attempt, and its basis does not notice"
    );
}

/// The retry itself: a snapshot overlapped once is taken again and kept; one
/// overlapped every time is refused, retryably, after `SNAPSHOT_ATTEMPTS`
/// attempts; and an attempt's own error is returned as it is, never retried.
#[test]
fn an_overlapped_snapshot_is_taken_again_and_refused_after_the_last_attempt() {
    let state = crate::create_app_state();
    let files = crate::persistence::UserFilesState::default();
    let bi = crate::bi::types::BiState::new();
    let basis_now = || {
        crate::persistence::build_workbook_for_save(&state, &files, &bi, crate::persistence::ChartKeysFor::Document)
            .expect("the body builds")
            .1
    };
    let renumber = || crate::persistence::note_sheet_structure_change(&state);

    let mut attempts = 0usize;
    let kept = crate::persistence::take_consistent_snapshot(&state, "saved", || {
        attempts += 1;
        let basis = basis_now();
        if attempts == 1 {
            renumber();
        }
        Ok((attempts, basis))
    });
    assert_eq!(kept, Ok(2), "the overlapped first attempt must be thrown away and the second kept");

    let mut attempts = 0usize;
    let refused = crate::persistence::take_consistent_snapshot(&state, "saved", || {
        attempts += 1;
        let basis = basis_now();
        renumber();
        Ok((attempts, basis))
    });
    let message = refused.expect_err("a snapshot overlapped every time must be refused, never written torn");
    assert!(
        message.starts_with(crate::persistence::WORKBOOK_CHANGED_WHILE_SAVING) && message.contains("try again"),
        "the refusal must be the retryable one: {message}"
    );
    assert_eq!(attempts, crate::persistence::SNAPSHOT_ATTEMPTS, "the retry is bounded at SNAPSHOT_ATTEMPTS");

    let mut attempts = 0usize;
    let failed: Result<usize, String> = crate::persistence::take_consistent_snapshot(&state, "saved", || {
        attempts += 1;
        Err("the disk is gone".to_string())
    });
    assert_eq!(failed, Err("the disk is gone".to_string()));
    assert_eq!(attempts, 1, "an attempt's own error is not a renumbering and is not retried");
}

// ---------------------------------------------------------------------------
// The publish door carries its selection by STABLE id (F1, review round 8)
// ---------------------------------------------------------------------------
//
// The `.calp` door (`assemble_publish_workbook`) retakes its snapshot when a
// renumbering landed inside an attempt -- and used to retake it with the sheet
// POSITIONS resolved before attempt 1. The retake therefore indexed a renumbered
// list with the old positions and shipped whatever sheet now sat at each: the
// async drill-through's temporary sheet to every subscriber in place of a
// floating range's backing sheet, a deleted ticked sheet's neighbour, or a
// non-retryable "Sheet index N out of range". The selection now travels as ids
// (`PublishSheetIds`); each attempt maps them through its own sheet list
// (`publish_positions_in_snapshot`) and hands those positions back, and the
// resolution that produced the ids is itself validated by the generation
// (`resolve_publish_selection`).

/// `[Sheet1, Data, Float1]`: `Float1` is the OBJECT-backed sheet of a floating
/// range hosted on `Sheet1`, the report. Returns the state and the three ids.
fn report_with_a_floating_range() -> (Arc<AppState>, [identity::SheetId; 3]) {
    let state = crate::create_app_state();
    let report = state.sheet_ids.read().unwrap()[0];
    let (_, data) = append_sheet_for_test(&state, "Data", "visible");
    let (index, float) = append_sheet_for_test(&state, "Float1", crate::sheets::OBJECT_SHEET_VISIBILITY);
    assert_eq!(index, 2, "fixture: the object sheet is the third sheet");
    let row = crate::persistence::saved_floating_range_to_row(&saved_floating_range(report, float));
    state.floating_ranges.write(&test_seed_effect()).unwrap().push(row);
    (Arc::new(state), [report, data, float])
}

/// A floating range's saved row, hosted on `host` and backed by `backing`.
fn saved_floating_range(host: identity::SheetId, backing: identity::SheetId) -> ::persistence::SavedFloatingRange {
    ::persistence::SavedFloatingRange {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        backing_sheet_id: backing,
        host_sheet_id: host,
        x: 0.0,
        y: 0.0,
        rotation: 0.0,
        pin_to_grid: false,
        row_count: 3,
        col_count: 2,
        col_widths: std::collections::HashMap::new(),
        row_heights: std::collections::HashMap::new(),
        show_title: true,
        show_column_headers: true,
        show_row_headers: true,
        container: None,
        hidden_rows: Vec::new(),
        hidden_cols: Vec::new(),
    }
}

/// The `.calp` publish door with every State it reads, as `calp_publish` hands
/// them over -- a content-only publish (no workspace, no application).
fn publish_through_the_door(
    state: &AppState,
    selected: &crate::calp_commands::PublishSheetIds,
    what: &str,
) -> Result<crate::calp_commands::PublishedCarrier, String> {
    crate::calp_commands::assemble_publish_workbook(
        state,
        &crate::bi::types::BiState::new(),
        &PivotState::new(),
        &crate::scripting::types::ScriptState::new(),
        &SlicerState::new(),
        &RibbonFilterState::new(),
        &crate::pane_control::PaneControlState::new(),
        &crate::persistence::UserFilesState::default(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        selected,
        "",
        "",
        &[],
        what,
    )
}

/// The sheets a carrier publishes, by id, in publish order -- read through the
/// positions the door handed back, exactly as `PublishRequest.sheet_indices`
/// is.
fn published_sheet_ids(carrier: &crate::calp_commands::PublishedCarrier) -> Vec<identity::SheetId> {
    carrier.sheet_indices.iter().map(|&i| carrier.assembly.workbook.sheets[i].id).collect()
}

/// The selection `calp_publish` resolves for `requested` (positions in the
/// sheet list as it is now).
fn publish_selection(state: &AppState, requested: Vec<usize>) -> crate::calp_commands::PublishSelection {
    crate::calp_commands::resolve_publish_selection(
        state,
        &SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        &PivotState::new(),
        "report",
        crate::calp_commands::RequestedSheets::ByPosition(requested),
        "published",
    )
    .expect("the selection resolves")
}

/// THE DEFECT, through the real door: the author ticks the report, and the
/// selection brings its floating range's backing sheet (`[0, 2]`). The async
/// drill-through adds its temporary sheet in front of the object tail while the
/// publish is parked in attempt 1's tail -- `[Sheet1, Data, Drill, Float1]`.
/// Attempt 1 is refused, and attempt 2 must publish EXACTLY the ticked sheets,
/// by id: the report and its backing sheet -- never the drill sheet that slid
/// into position 2 (the backing sheet's cells would arrive as `#REF!` and the
/// drill sheet's rows would reach every subscriber under the author's key).
///
/// SABOTAGE: reuse attempt 1's positions in every retake of
/// `assemble_publish_snapshot` (the pre-fix shape: positions resolved before the
/// retake) -- the drill sheet ships in place of the backing sheet.
#[test]
fn a_renumbering_inside_the_publish_snapshot_ships_the_ticked_sheets_by_id() {
    let (state, [report, _data, float]) = report_with_a_floating_range();
    let selection = publish_selection(&state, vec![0]);
    assert_eq!(selection.indices, vec![0, 2], "fixture: the report brings its floating range's backing sheet");
    assert_eq!(
        selection.ids,
        crate::calp_commands::PublishSheetIds { sheets: vec![report], backing: vec![float] },
        "fixture: the selection carries the two sheets by id"
    );

    let ids = selection.ids.clone();
    let run = run_a_renumbering_while_the_save_is_parked_in_its_tail(
        &state,
        move |state| {
            publish_through_the_door(state, &ids, "published").map(|carrier| {
                (published_sheet_ids(&carrier), carrier.sheet_indices.clone(), carrier.assembly.workbook.sheets.len())
            })
        },
        add_a_drill_through_sheet,
    );
    assert!(run.parked(), "{TAIL_PARK_PRECONDITION}");
    assert_eq!(run.renumbered, Ok(2), "fixture: the drill-through's sheet lands in front of the object tail");
    let drill = state.sheet_ids.read().unwrap()[2];
    assert_eq!(
        run.attempts, 2,
        "the publish did not refuse its first attempt and keep the second, although the add renumbered the sheets \
         inside it"
    );
    let (published, positions, sheet_count) =
        run.saved.expect("the publish refused, but only one renumbering overlapped it");
    assert_eq!(sheet_count, 4, "fixture: the kept attempt read the workbook after the add");
    assert!(
        !published.contains(&drill),
        "the publish shipped the drill-through's TEMPORARY sheet: its retake indexed the renumbered sheet list with \
         positions resolved before the add (F1, review round 8)"
    );
    assert_eq!(
        published,
        vec![report, float],
        "the publish did not ship exactly the sheets the author ticked (the report and its floating range's \
         backing sheet), by id"
    );
    assert_eq!(positions, vec![0, 3], "the carrier's positions are the ticked sheets' positions in ITS sheet list");
}

/// NON-VACUITY for the probe above, through the SAME harness: the PRE-FIX door
/// -- the same validated retake, but every attempt indexing its sheets with the
/// positions resolved before it -- must ship the drill sheet in place of the
/// backing sheet. A harness that could not show that would pass the probe
/// whatever the door did with its positions.
#[test]
fn the_publish_probe_sees_positions_resolved_before_the_retake_ship_the_wrong_sheet() {
    let (state, [report, _data, float]) = report_with_a_floating_range();
    let resolved_before = publish_selection(&state, vec![0]).indices;
    let run = run_a_renumbering_while_the_save_is_parked_in_its_tail(
        &state,
        move |state| {
            crate::persistence::take_consistent_snapshot(state, "published", || {
                let (workbook, basis) = crate::persistence::build_workbook_for_save_with_slicers(
                    state,
                    &crate::persistence::UserFilesState::default(),
                    &crate::bi::types::BiState::new(),
                    &SlicerState::new(),
                    &RibbonFilterState::new(),
                    &PivotState::new(),
                    &crate::timeline_slicer::TimelineSlicerState::new(),
                )?;
                let shipped: Vec<identity::SheetId> =
                    resolved_before.iter().filter_map(|&i| workbook.sheets.get(i).map(|s| s.id)).collect();
                Ok((shipped, basis))
            })
        },
        add_a_drill_through_sheet,
    );
    assert!(run.parked(), "{TAIL_PARK_PRECONDITION}");
    assert_eq!(run.attempts, 2, "fixture: the planted door did not retake its overlapped first attempt");
    let drill = state.sheet_ids.read().unwrap()[2];
    let shipped = run.saved.expect("the planted door builds");
    assert_eq!(
        shipped,
        vec![report, drill],
        "the harness did not hand the retake a renumbered sheet list, so the probe above cannot tell a door that \
         maps ids from one that reuses positions"
    );
    assert!(!shipped.contains(&float), "the planted pre-fix door found the backing sheet anyway: {shipped:?}");
}

/// A TICKED SHEET DELETED inside the publish snapshot refuses the publish,
/// RETRYABLY -- never its neighbour, which slid into its position, and never the
/// non-retryable "Sheet index N out of range" the positions used to produce.
/// The author ticked B and C of `[Sheet1, B, C]`; an agent deletes B while the
/// publish is parked in attempt 1's tail; attempt 2 cannot find B by id.
///
/// SABOTAGE: skip a missing id in `publish_positions_in_snapshot` instead of
/// refusing -- C alone ships, as if the author had ticked only C.
#[test]
fn a_ticked_sheet_deleted_inside_the_publish_snapshot_refuses_retryably() {
    let (state, c_id) = three_sheets_with_an_autofilter_on_the_last();
    let b_id = state.sheet_ids.read().unwrap()[1];
    let selection = publish_selection(&state, vec![1, 2]);
    assert_eq!(selection.ids.sheets, vec![b_id, c_id], "fixture: B and C are ticked");
    let ids = selection.ids.clone();
    let run = run_an_agents_delete_while_the_save_is_parked_in_its_tail(&state, move |state| {
        publish_through_the_door(state, &ids, "published").map(|carrier| published_sheet_ids(&carrier))
    });
    assert!(run.parked(), "{TAIL_PARK_PRECONDITION}");
    assert_eq!(run.renumbered, Ok(2), "fixture: the agent's delete was refused");
    assert_eq!(run.attempts, 2, "the delete landed inside attempt 1, so attempt 1 must have been taken again");
    let refusal = run.saved.expect_err(
        "the publish shipped although a sheet the author ticked was deleted under it: a missing id must refuse, \
         never publish what is left",
    );
    assert!(
        refusal.starts_with(&format!("{}: ", crate::persistence::WORKBOOK_CHANGED_WHILE_SAVING)),
        "the refusal is not the RETRYABLE one: {refusal}"
    );
    assert!(refusal.contains("while it was being published --"), "the refusal does not name the act: {refusal}");
    assert!(!refusal.contains("out of range"), "the refusal is the old positional one: {refusal}");
}

/// THE OLDER WINDOW -- a renumbering between the resolution and attempt 1 -- is
/// closed the same way, and every door's refusal names ITS act. A ticked sheet
/// deleted after the selection was resolved refuses each door retryably, saying
/// "previewed", "compared" or "merged" for the doors that publish nothing; and a
/// ticked sheet that merely MOVED is found where it now is (C ticked at
/// position 2, B deleted, C published from position 1 -- where the positions
/// failed with "Sheet index 2 out of range").
///
/// SABOTAGE: pass the literal "published" to `take_consistent_snapshot` or to
/// `publish_positions_in_snapshot` in the door -- the three other doors lose
/// their words. Or skip a missing id -- every door ships.
#[test]
fn a_ticked_sheet_deleted_before_the_door_refuses_every_door_in_its_own_words() {
    for what in ["published", "previewed", "compared", "merged"] {
        let (state, _c) = three_sheets_with_an_autofilter_on_the_last();
        let selection = publish_selection(&state, vec![1]);
        assert_eq!(delete_sheet_as_an_agent_does(&state, 1), Ok(2), "fixture: B is deleted");
        let refusal = match publish_through_the_door(&state, &selection.ids, what) {
            Ok(carrier) => panic!(
                "{what}: the door shipped {:?} although the one sheet ticked is gone",
                published_sheet_ids(&carrier)
            ),
            Err(refusal) => refusal,
        };
        assert!(
            refusal.starts_with(&format!("{}: ", crate::persistence::WORKBOOK_CHANGED_WHILE_SAVING)),
            "{what}: the refusal is not the retryable one: {refusal}"
        );
        assert!(
            refusal.contains(&format!("while it was being {what} --")),
            "{what}: the refusal names another act: {refusal}"
        );
        if what != "published" {
            assert!(!refusal.contains("published"), "{what}: a door that publishes nothing said it did: {refusal}");
        }
    }

    let (state, c_id) = three_sheets_with_an_autofilter_on_the_last();
    let selection = publish_selection(&state, vec![2]);
    assert_eq!(delete_sheet_as_an_agent_does(&state, 1), Ok(2), "fixture: B is deleted, C slides to position 1");
    let carrier = publish_through_the_door(&state, &selection.ids, "published")
        .unwrap_or_else(|e| panic!("the ticked sheet merely moved, and the door refused: {e}"));
    assert_eq!(published_sheet_ids(&carrier), vec![c_id], "the door did not find the ticked sheet where it now is");
    assert_eq!(carrier.sheet_indices, vec![1]);
}

/// `publish_positions_in_snapshot` on hand-built carriers: ids followed through
/// a rotation; a missing user sheet refused in the caller's words; backing
/// sheets re-derived from the carrier's OWN floating ranges (a range deleted
/// since drops its sheet, one created on a published host since brings its own,
/// one now hosted on an unpublished sheet stays behind); the selection's order
/// kept; and an undisturbed carrier mapped to exactly the resolver's positions.
///
/// SABOTAGE: return the selection's resolver-time positions, or skip a missing
/// id, or keep a backing sheet whose range is gone -- each case below names it.
#[test]
fn publish_positions_follow_the_ids_and_the_carriers_own_floating_ranges() {
    use crate::calp_commands::{publish_positions_in_snapshot, PublishSheetIds};
    let fresh = || identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let (report, data, drill, float, other) = (fresh(), fresh(), fresh(), fresh(), fresh());
    let carrier = |sheets: &[identity::SheetId], ranges: &[(identity::SheetId, identity::SheetId)]| {
        let mut workbook = ::persistence::Workbook::default();
        workbook.sheets = sheets
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let mut sheet = ::persistence::Sheet::new(format!("S{i}"));
                sheet.id = *id;
                sheet
            })
            .collect();
        workbook.floating_ranges =
            ranges.iter().map(|(host, backing)| saved_floating_range(*host, *backing)).collect();
        workbook
    };
    let ticked = PublishSheetIds { sheets: vec![report], backing: vec![float] };

    // Undisturbed: exactly what the resolver resolved.
    let undisturbed = carrier(&[report, data, float], &[(report, float)]);
    assert_eq!(publish_positions_in_snapshot(&undisturbed, &ticked, "published"), Ok(vec![0, 2]));
    // A sheet added in front of the object tail: the ids are followed.
    let rotated = carrier(&[report, data, drill, float], &[(report, float)]);
    assert_eq!(
        publish_positions_in_snapshot(&rotated, &ticked, "published"),
        Ok(vec![0, 3]),
        "the positions did not follow the ids through the rotation"
    );
    // A ticked user sheet that is gone refuses, retryably, in the caller's words.
    let deleted = carrier(&[report, float], &[(report, float)]);
    let both = PublishSheetIds { sheets: vec![report, data], backing: vec![float] };
    let refusal = publish_positions_in_snapshot(&deleted, &both, "compared").expect_err("a missing ticked sheet");
    assert!(
        refusal.starts_with(&format!("{}: ", crate::persistence::WORKBOOK_CHANGED_WHILE_SAVING))
            && refusal.contains("while it was being compared --"),
        "{refusal}"
    );
    // The range was deleted since: its backing sheet goes with it.
    let range_gone = carrier(&[report, data, float], &[]);
    assert_eq!(
        publish_positions_in_snapshot(&range_gone, &ticked, "published"),
        Ok(vec![0]),
        "a backing sheet shipped without its floating range"
    );
    // A range created on a published host since brings its own backing sheet.
    let range_new = carrier(&[report, data, other], &[(report, other)]);
    assert_eq!(
        publish_positions_in_snapshot(&range_new, &PublishSheetIds { sheets: vec![report], backing: vec![] }, "published"),
        Ok(vec![0, 2]),
        "a floating range on a published host left its backing sheet behind"
    );
    // A range now hosted on a sheet this publish does not carry stays behind.
    let moved_host = carrier(&[report, data, float], &[(data, float)]);
    assert_eq!(
        publish_positions_in_snapshot(&moved_host, &ticked, "published"),
        Ok(vec![0]),
        "a backing sheet shipped although its range sits on an unpublished sheet"
    );
    // The selection's order, not the workbook's.
    let reordered = PublishSheetIds { sheets: vec![data, report], backing: vec![float] };
    assert_eq!(publish_positions_in_snapshot(&undisturbed, &reordered, "published"), Ok(vec![1, 0, 2]));
}

/// THE RESOLUTION ITSELF IS VALIDATED (F1, review round 8): a renumbering that
/// lands while `resolve_publish_selection` is between its reads is caught by the
/// generation. A request that named sheets BY POSITION is refused, retryably --
/// its positions were chosen against a sheet list that is gone -- and the
/// default selection, which reads nothing but live state, is worked out again
/// and describes the sheets as they are now. So is a request that named its
/// sheets BY ID (round 9): an id still names its sheet after any renumbering,
/// so the push dialog's request is worked out again rather than refused, and
/// finds the ticked sheet and its floating range's backing sheet where they now
/// sit.
///
/// Parked on `floating_ranges`, which the resolution reads after it copied the
/// sheet list, its visibility and its ids, and which a copy never takes; the
/// renumbering is a copy of `Data` (inserted at position 2, in front of the
/// object tail). The attempts are COUNTED on the resolver's thread.
///
/// SABOTAGE: return the first resolution in `resolve_publish_selection` without
/// asking `snapshot_is_current` -- the position request resolves instead of
/// refusing, and the default and the id request keep the positions of the list
/// before the copy. Or refuse every request that names sheets, as the round-8
/// selection did -- the id request is refused.
#[test]
fn a_renumbering_inside_the_publish_selection_is_refused_or_resolved_again() {
    for case in ["positions", "default", "ids"] {
        let (state, [report, data, float]) = report_with_a_floating_range();
        let requested = match case {
            "positions" => crate::calp_commands::RequestedSheets::ByPosition(vec![0]),
            "default" => crate::calp_commands::RequestedSheets::default(),
            _ => crate::calp_commands::RequestedSheets::ById(vec![report.to_string()]),
        };
        let parked_on_ranges = state.floating_ranges.read().unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let resolver = {
            let state = Arc::clone(&state);
            let started = Arc::clone(&started);
            let finished = Arc::clone(&finished);
            let requested = requested.clone();
            std::thread::spawn(move || {
                crate::persistence::SNAPSHOT_ATTEMPTS_TAKEN_FOR_TEST.with(|taken| taken.set(0));
                started.store(true, Ordering::SeqCst);
                let selection = crate::calp_commands::resolve_publish_selection(
                    &state,
                    &SlicerState::new(),
                    &crate::timeline_slicer::TimelineSlicerState::new(),
                    &PivotState::new(),
                    "report",
                    requested,
                    "published",
                );
                let attempts = crate::persistence::SNAPSHOT_ATTEMPTS_TAKEN_FOR_TEST.with(|taken| taken.get());
                finished.store(true, Ordering::SeqCst);
                (selection.map(|s| (s.indices, s.ids)), attempts)
            })
        };
        let began = wait_until(2_000, || started.load(Ordering::SeqCst));
        // Long enough to reach the parked read.
        std::thread::sleep(Duration::from_millis(250));
        let parked = began && !finished.load(Ordering::SeqCst);
        let copied = Arc::new(AtomicBool::new(false));
        let copier = {
            let state = Arc::clone(&state);
            let copied = Arc::clone(&copied);
            std::thread::spawn(move || {
                let file = crate::persistence::FileState::default();
                let result = crate::sheets::copy_sheet_impl(
                    &state,
                    &file,
                    &SlicerState::new(),
                    &crate::timeline_slicer::TimelineSlicerState::new(),
                    &RibbonFilterState::new(),
                    1,
                    None,
                );
                copied.store(true, Ordering::SeqCst);
                result.map(|r| r.sheets.len())
            })
        };
        let copied_while_parked = wait_until(5_000, || copied.load(Ordering::SeqCst)) && !finished.load(Ordering::SeqCst);
        drop(parked_on_ranges);
        let (resolved, attempts) = resolver.join().expect("the resolver's thread panicked");
        let copy = copier.join().expect("the copy's thread panicked");
        assert!(
            parked && copied_while_parked,
            "PRECONDITION FAILED: the copy did not land while the resolution was parked between its reads"
        );
        assert!(copy.is_ok(), "fixture: the copy was refused: {copy:?}");
        let copy_id = state.sheet_ids.read().unwrap()[2];
        match case {
            "default" => {
                assert_eq!(attempts, 2, "the default selection was not worked out again after the copy overlapped it");
                let (indices, ids) = resolved.expect("the default selection is worked out again, never refused");
                assert_eq!(indices, vec![0, 1, 2, 3], "the default selection kept the positions of the list before the copy");
                assert_eq!(
                    ids,
                    crate::calp_commands::PublishSheetIds { sheets: vec![report, data, copy_id], backing: vec![float] },
                    "the default selection does not describe the sheets as they are after the copy"
                );
            }
            "ids" => {
                assert_eq!(
                    attempts, 2,
                    "a request that named its sheets BY ID was not worked out again after the copy overlapped it"
                );
                let (indices, ids) = resolved.unwrap_or_else(|refusal| {
                    panic!("a request by id was refused although an id still names its sheet after a copy: {refusal}")
                });
                assert_eq!(
                    indices,
                    vec![0, 3],
                    "the id request kept the positions of the list before the copy (the backing sheet moved to 3)"
                );
                assert_eq!(
                    ids,
                    crate::calp_commands::PublishSheetIds { sheets: vec![report], backing: vec![float] },
                    "the id request does not carry exactly the ticked sheet and its floating range's backing sheet"
                );
            }
            _ => {
                assert_eq!(attempts, 1, "a request that named sheets by position must be refused, not resolved again");
                let refusal = resolved.expect_err(
                    "a request that named sheets by position resolved although a renumbering landed inside its \
                     resolution",
                );
                assert!(
                    refusal.starts_with(&format!("{}: ", crate::persistence::WORKBOOK_CHANGED_WHILE_SAVING))
                        && refusal.contains("while it was being published --")
                        && refusal.contains("worked out"),
                    "the refusal is not the retryable one for the selection: {refusal}"
                );
            }
        }
    }
}

/// EVERY DOOR NAMES ITS OWN ACT AND ACTS ON THE CARRIER'S POSITIONS, in the
/// source (F1 + the door-specific wording, review round 8):
///
/// * `calp_publish` says "published", `calp_publish_preview` "previewed", the
///   working-copy diff "compared", the merge "merged" -- each to the selection
///   AND to the door -- and `publish_into_for_preview` forwards its caller's
///   act, never a literal;
/// * the door hands its `what` to the retake and to the attempt;
/// * every door resolves through the VALIDATED `resolve_publish_selection` and
///   passes the selection's ids, never `selection.indices`;
/// * the attempt maps its positions right after its body, before the first
///   step that reads one, and returns them.
///
/// SABOTAGE: pass "published" from `calp_publish_preview`; or pass
/// `&selection.indices` anywhere; or move the mapping below the renames.
#[test]
fn every_publish_door_names_its_own_act_and_acts_on_the_carriers_positions() {
    let code_of = |src: &str, signature: &str| -> String {
        function_body(src, signature)
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let read = |rel: &str| std::fs::read_to_string(src_root().join(rel)).unwrap_or_else(|_| panic!("{rel}"));
    let calp = read("calp_commands.rs");
    let diff = read("calp_diff.rs");
    let merge = read("calp_merge.rs");

    // The door names: each caller's literal, to the selection and to the door.
    for (src, signature, what) in [
        (&calp, "pub fn calp_publish(", "\"published\""),
        (&calp, "pub fn calp_publish_preview(", "\"previewed\""),
    ] {
        let body = code_of(src, signature);
        for call in ["resolve_publish_selection(", "assemble_publish_workbook("] {
            let at = body.find(call).unwrap_or_else(|| panic!("`{signature}..` no longer calls `{call}..`"));
            let args = &body[at..at + body[at..].find(")?;").expect("the call's end")];
            assert!(args.contains(what), "`{signature}..` does not tell `{call}..` its act {what}: {args}");
        }
        assert!(!body.contains("selection.indices"), "`{signature}..` acts on the resolver's positions");
        assert!(!body.contains("resolve_publish_sheet_indices("), "`{signature}..` resolves without the generation check");
    }
    for (src, name, what) in [(&diff, "calp_diff.rs", "\"compared\""), (&merge, "calp_merge.rs", "\"merged\"")] {
        let code: String = src.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n");
        let at = code.find("publish_into_for_preview(").unwrap_or_else(|| panic!("{name} no longer previews"));
        let args = &code[at..at + code[at..].find(")?;").expect("the call's end")];
        assert!(args.contains(what), "{name} does not name its act {what}: {args}");
        assert!(!args.contains("\"published\""), "{name} says it publishes: {args}");
    }
    let into = code_of(&calp, "pub(crate) fn publish_into_for_preview(");
    assert!(!into.contains("\"published\"") && !into.contains("\"previewed\""), "the preview publish hard-codes an act");
    for call in ["resolve_publish_selection(", "assemble_publish_workbook("] {
        let at = into.find(call).unwrap_or_else(|| panic!("the preview publish no longer calls `{call}..`"));
        let args = &into[at..at + into[at..].find(")?;").expect("the call's end")];
        assert!(args.contains("\n        what,"), "the preview publish does not forward its caller's act to `{call}..`: {args}");
    }
    assert!(!into.contains("selection.indices"), "the preview publish acts on the resolver's positions");

    // The door hands its act on.
    let door = code_of(&calp, "fn assemble_publish_workbook(");
    assert!(door.contains("take_consistent_snapshot(state, what,"), "the door's retake does not name its caller's act");
    assert!(door.contains("\n            what,\n"), "the door's attempt is not told its caller's act");

    // The attempt maps its positions right after its body, and returns them.
    let attempt = code_of(&calp, "fn assemble_publish_snapshot(");
    let body = attempt.find("build_workbook_for_save_with_slicers(").expect("the attempt's body");
    let mapped = attempt
        .find("publish_positions_in_snapshot(&workbook, selected, what)?")
        .expect("the attempt no longer maps the selection's ids through its own sheet list");
    let first_use = attempt.find("for &idx in sheet_indices").expect("the renames no longer read the positions");
    assert!(body < mapped && mapped < first_use, "the positions are mapped after a step that reads them");
    assert!(
        attempt.contains("let sheet_indices: &[usize] = &published_positions;"),
        "the attempt's later steps do not read the positions it mapped"
    );
    let returned = attempt.rfind("Ok((").expect("the attempt's final Ok");
    assert!(attempt[returned..].contains("published_positions,"), "the attempt does not hand back the positions it published");
}

// ---------------------------------------------------------------------------
// The request names its sheets by STABLE id (round 9)
// ---------------------------------------------------------------------------
//
// The push dialog is non-modal, and it used to send the sheet POSITIONS it read
// when it listed the sheets; the backend resolved them against the list as it
// is when Push is pressed. A tab the author dragged in between handed the tick
// to its neighbour -- an unticked sheet shipped to every subscriber under the
// author's key, with no warning -- and "Try again" after a refusal resent the
// same positions (F1 of PUBLISH-BY-ID and of REFUSAL-UX, review round 8). The
// dialog now sends `sheetIds`, which take precedence over `sheetIndices` at all
// three doors (`RequestedSheets::from_wire`); the ids become positions inside
// the validated selection, and an id no sheet carries refuses by name
// (`CALP_PUSH_SHEET_GONE`). A position past the end of the list is refused as
// an index the workbook does not have, and not retryably (F2; review round 10:
// `CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE`), and an error from a resolution a
// renumbering overlapped is judged by the generation like a selection is (F3)
// -- the one retryable refusal the selection gives a request by position.

/// The stable id of the sheet at `index` -- what the dialog's row carries.
fn sheet_id_at(state: &AppState, index: usize) -> identity::SheetId {
    state.sheet_ids.read().unwrap()[index]
}

/// The selection `calp_publish` resolves for `requested`, in `what`'s words.
fn resolve_request(
    state: &AppState,
    requested: crate::calp_commands::RequestedSheets,
    what: &str,
) -> Result<crate::calp_commands::PublishSelection, String> {
    crate::calp_commands::resolve_publish_selection(
        state,
        &SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        &PivotState::new(),
        "report",
        requested,
        what,
    )
}

/// Move the sheet at `from` to `to`, as the tab strip's drag does. Returns the
/// sheet count.
fn move_sheet_as_the_tab_strip_does(state: &AppState, from: usize, to: usize) -> Result<usize, String> {
    let file = crate::persistence::FileState::default();
    crate::sheets::move_sheet_impl(
        state,
        &file,
        &SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        &RibbonFilterState::new(),
        from,
        to,
    )
    .map(|r| r.sheets.len())
}

/// Copy the sheet at `source`, as the tab menu's Copy does -- the copy lands
/// right after its source. Returns the sheet count.
fn copy_sheet_as_the_tab_menu_does(state: &AppState, source: usize) -> Result<usize, String> {
    let file = crate::persistence::FileState::default();
    crate::sheets::copy_sheet_impl(
        state,
        &file,
        &SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        &RibbonFilterState::new(),
        source,
        None,
    )
    .map(|r| r.sheets.len())
}

/// THE IDS WIN. Every door builds its request from its params through
/// `RequestedSheets::from_wire`: `sheetIds`, when present, decide whatever
/// `sheetIndices` say (an empty list is the default selection, as an empty
/// `sheetIndices` is), and a push that names its sheets by id alone parses --
/// the push's `sheetIndices` is optional now. The resolution then takes the
/// sheet the id names, not the one at the position sent beside it.
///
/// SABOTAGE: make `from_wire` keep the positions whenever there are any -- each
/// door's request with both reads as positions, and the resolution takes the
/// sheet at position 0.
#[test]
fn a_requests_sheet_ids_take_precedence_over_its_positions() {
    use crate::calp_commands::RequestedSheets;
    let (state, c) = three_sheets_with_an_autofilter_on_the_last();
    let c_text = c.to_string();

    // The wire, as each door's params carry it.
    let push = |sheets: serde_json::Value| -> crate::calp_commands::PublishParams {
        let mut params = serde_json::json!({
            "registryPath": "C:/ws",
            "packageName": "sales",
            "version": "1.0.0",
            "kind": "report",
            "publishedBy": "",
        });
        for (key, value) in sheets.as_object().expect("an object").iter() {
            params[key] = value.clone();
        }
        serde_json::from_value(params).unwrap_or_else(|e| panic!("the push's params did not parse: {e}"))
    };
    let both = push(serde_json::json!({ "sheetIndices": [0], "sheetIds": [c_text] }));
    let ids_alone = push(serde_json::json!({ "sheetIds": [c_text] }));
    assert!(ids_alone.sheet_indices.is_empty(), "a push without sheetIndices names no position");
    let preview: crate::calp_commands::PublishPreviewParams =
        serde_json::from_value(serde_json::json!({ "sheetIndices": [0], "sheetIds": [c_text] })).unwrap();
    let diff: crate::calp_diff::DiffWorkingCopyParams =
        serde_json::from_value(serde_json::json!({ "sheetIndices": [0], "sheetIds": [c_text] })).unwrap();
    let expected = RequestedSheets::ById(vec![c_text.clone()]);
    for (door, request) in [
        ("calp_publish", RequestedSheets::from_wire(both.sheet_ids, both.sheet_indices)),
        ("calp_publish, ids alone", RequestedSheets::from_wire(ids_alone.sheet_ids, ids_alone.sheet_indices)),
        (
            "calp_publish_preview",
            RequestedSheets::from_wire(preview.sheet_ids, preview.sheet_indices.unwrap_or_default()),
        ),
        (
            "calp_diff_working_copy",
            RequestedSheets::from_wire(diff.sheet_ids, diff.sheet_indices.unwrap_or_default()),
        ),
    ] {
        assert_eq!(request, expected, "{door}: the request's ids did not take precedence over its positions");
    }
    assert_eq!(
        RequestedSheets::from_wire(None, vec![0]),
        RequestedSheets::ByPosition(vec![0]),
        "positions alone stay positions (the scripted publish, the e2e helpers)"
    );
    let empty_ids = RequestedSheets::from_wire(Some(Vec::new()), vec![1]);
    assert!(
        empty_ids.names_no_sheet(),
        "an empty id list is the default selection, as an empty sheetIndices is: {empty_ids:?}"
    );

    // The resolution: the sheet the id names, never the position beside it.
    let selection = resolve_request(&state, RequestedSheets::from_wire(Some(vec![c_text.clone()]), vec![0]), "published")
        .expect("the request resolves");
    assert_eq!(selection.ids.sheets, vec![c], "the publish did not take the sheet the id names");
    assert_eq!(selection.indices, vec![2]);
}

/// A TICKED SHEET THAT MOVED IS STILL THE ONE PUBLISHED, AND AN UNTICKED ONE
/// STAYS BEHIND -- the finding's own scenario. `[Report, Private]`: the author
/// unticks Private, so the dialog names Report (position 0 when it read the
/// list), then drags Private in front of Report while the dialog is open. That
/// position now names Private -- which is what shipped -- and Report's id still
/// names Report, which is what ships now, through the selection AND the door. A
/// copy does the same to the sheets after its source (the copy lands right
/// after it), and the id follows its sheet there too.
///
/// SABOTAGE: make `from_wire` keep the positions whenever there are any --
/// Private ships and Report does not.
#[test]
fn a_ticked_sheet_that_moved_is_published_by_id_and_an_unticked_one_is_not() {
    use crate::calp_commands::RequestedSheets;
    let state = Arc::new(crate::create_app_state());
    let report = sheet_id_at(&state, 0);
    let (_, private) = append_sheet_for_test(&state, "Private", "visible");
    // What the dialog read and sends: Report's row, at position 0 back then.
    let request = RequestedSheets::from_wire(Some(vec![report.to_string()]), vec![0]);

    assert_eq!(move_sheet_as_the_tab_strip_does(&state, 1, 0), Ok(2), "fixture: Private is dragged in front of Report");
    assert_eq!(sheet_id_at(&state, 0), private, "fixture: Private now sits where Report was");
    // NON-VACUITY: the position the dialog read now names the unticked sheet.
    assert_eq!(
        publish_selection(&state, vec![0]).ids.sheets,
        vec![private],
        "the fixture did not move the unticked sheet onto the ticked sheet's old position"
    );
    let selection = resolve_request(&state, request, "published").expect("the request resolves");
    assert_eq!(selection.ids.sheets, vec![report], "the request did not publish the ticked sheet where it now sits");
    assert_eq!(selection.indices, vec![1]);
    let carrier = publish_through_the_door(&state, &selection.ids, "published")
        .unwrap_or_else(|e| panic!("the door refused: {e}"));
    let published = published_sheet_ids(&carrier);
    assert_eq!(published, vec![report], "the door did not ship exactly the ticked sheet");
    assert!(!published.contains(&private), "the door shipped the sheet the author unticked");

    // A COPY shifts the sheets after its source: Private ticked, Report copied.
    let state = Arc::new(crate::create_app_state());
    let (_, private) = append_sheet_for_test(&state, "Private", "visible");
    let ticked = RequestedSheets::from_wire(Some(vec![private.to_string()]), vec![1]);
    assert_eq!(copy_sheet_as_the_tab_menu_does(&state, 0), Ok(3), "fixture: Report is copied");
    assert_ne!(sheet_id_at(&state, 1), private, "fixture: the copy landed right after Report, in front of Private");
    let selection = resolve_request(&state, ticked, "published").expect("the request resolves");
    assert_eq!(
        selection.ids.sheets,
        vec![private],
        "the copy handed Private's tick to the sheet that slid into its position"
    );
    assert_eq!(selection.indices, vec![2]);
}

/// A TICKED SHEET THAT IS GONE REFUSES BY NAME, in every door's words, and NOT
/// retryably -- resending the same ids can never succeed. `[Sheet1, B, C]`: the
/// author ticks B and C, then an agent deletes B. Never C alone (what is left),
/// never B's neighbour (what slid into its position), never the retryable
/// `WORKBOOK_CHANGED_WHILE_SAVING`, never "out of range" or "no stable id". The
/// sheet is named while the workbook still records its name (here the
/// working-copy link's base sheets); with nothing recording it the sentence
/// says "The sheet you ticked"; several gone sheets are counted; a string that
/// is no id names no sheet either.
///
/// SABOTAGE: skip a missing id in the `ById` branch instead of refusing -- C
/// alone resolves. Or refuse with the retryable refusal. Or hard-code
/// "published" in `sheet_gone_refusal` -- the other doors lose their words.
#[test]
fn a_ticked_sheet_that_was_deleted_refuses_by_name_in_every_doors_words() {
    use crate::calp_commands::{RequestedSheets, CALP_PUSH_SHEET_GONE};
    for what in ["published", "previewed", "compared", "merged"] {
        let (state, c) = three_sheets_with_an_autofilter_on_the_last();
        let b = sheet_id_at(&state, 1);
        // The application's own sheets, by id and name, as a checkout records them.
        *state.working_copy_link.write(&test_seed_effect()).unwrap() = Some(calp::WorkingCopyLink::new(
            "C:/ws",
            "sales",
            "report",
            "1.0.0",
            "2026-10-24T00:00:00Z",
            vec![calp::WorkingCopySheetRef { sheet_id: b, name: "B".to_string() }],
        ));
        let ticked = RequestedSheets::ById(vec![b.to_string(), c.to_string()]);
        assert_eq!(delete_sheet_as_an_agent_does(&state, 1), Ok(2), "fixture: B is deleted");
        let refusal = match resolve_request(&state, ticked, what) {
            Ok(selection) => panic!(
                "{what}: the request resolved to {:?} although B, which the author ticked, is gone",
                selection.ids
            ),
            Err(refusal) => refusal,
        };
        assert!(
            refusal.starts_with(&format!("{CALP_PUSH_SHEET_GONE}: ")),
            "{what}: not the gone-sheet refusal: {refusal}"
        );
        assert!(
            refusal.contains("The sheet 'B' you ticked is no longer in the workbook"),
            "{what}: the refusal does not name the sheet the workbook still records: {refusal}"
        );
        assert!(refusal.contains(&format!("so nothing was {what}.")), "{what}: the refusal names another act: {refusal}");
        assert!(refusal.contains("Open the dialog again to see the current sheets."), "{what}: {refusal}");
        assert!(
            !refusal.contains(crate::persistence::WORKBOOK_CHANGED_WHILE_SAVING),
            "{what}: a gone sheet was refused as RETRYABLE, but resending the same ids can never succeed: {refusal}"
        );
        for stale in ["out of range", "no stable id", "save and reopen"] {
            assert!(!refusal.contains(stale), "{what}: the refusal reads '{stale}': {refusal}");
        }
    }

    // Nothing records the name: the plain sentence.
    let (state, c) = three_sheets_with_an_autofilter_on_the_last();
    let b = sheet_id_at(&state, 1);
    assert_eq!(delete_sheet_as_an_agent_does(&state, 1), Ok(2), "fixture: B is deleted");
    assert_eq!(
        resolve_request(&state, RequestedSheets::ById(vec![b.to_string()]), "published").map(|s| s.ids),
        Err(format!(
            "{CALP_PUSH_SHEET_GONE}: The sheet you ticked is no longer in the workbook, so nothing was published. \
             Open the dialog again to see the current sheets."
        ))
    );
    // Two gone: counted.
    assert_eq!(delete_sheet_as_an_agent_does(&state, 1), Ok(1), "fixture: C is deleted too");
    let refusal = resolve_request(&state, RequestedSheets::ById(vec![b.to_string(), c.to_string()]), "published")
        .map(|s| s.ids)
        .expect_err("two ticked sheets are gone");
    assert!(
        refusal.starts_with(&format!("{CALP_PUSH_SHEET_GONE}: 2 of the sheets you ticked are no longer in the workbook")),
        "{refusal}"
    );
    // A string that is no id names no sheet.
    let refusal = resolve_request(&state, RequestedSheets::ById(vec!["not-a-sheet".to_string()]), "published")
        .map(|s| s.ids)
        .expect_err("a string that is no id");
    assert!(refusal.starts_with(&format!("{CALP_PUSH_SHEET_GONE}: ")), "{refusal}");
}

/// The indexes a caller can LIST -- what `getSheets()`, the tab bar and the
/// push dialog show: `build_sheet_list` over the state's own vectors, so a
/// refusal's count is checked against the list itself, not against a number
/// the test assumed.
fn listed_sheet_indexes(state: &AppState) -> Vec<usize> {
    let sheet_names = state.sheet_names.read().unwrap();
    let freeze_configs = state.freeze_configs.read().unwrap();
    let tab_colors = state.tab_colors.read().unwrap();
    let sheet_visibility = state.sheet_visibility.read().unwrap();
    let sheet_ids = state.sheet_ids.read().unwrap();
    let sheet_kinds = state.sheet_kinds.read().unwrap();
    let ephemeral = crate::sheets::ephemeral_sheet_ids(state);
    crate::sheets::build_sheet_list(
        &sheet_names,
        &freeze_configs,
        &tab_colors,
        &sheet_visibility,
        &sheet_ids,
        &sheet_kinds,
        &ephemeral,
    )
    .into_iter()
    .map(|sheet| sheet.index)
    .collect()
}

/// A POSITION PAST THE END OF THE LIST, WITH NOTHING RENUMBERED, IS REFUSED AS AN
/// INDEX THE WORKBOOK DOES NOT HAVE -- `CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE`, in
/// the door's words, saying which indexes it has -- and NOT retryably (review
/// round 10). It used to be the retryable "the workbook changed ... try again",
/// which a script asking for sheet 3 of three (counting from 1) never made true
/// and no retry could satisfy: the push dialog offered "Try again" and resent
/// the same positions. Never a sheet with no stable id and the "save and reopen"
/// advice either, which cannot fix a stale index (F2, review round 8). Sheet 5
/// of three, the off-by-one through the selection the doors use, a one-sheet
/// and an empty workbook, and the last of three chosen before an agent deleted
/// it each get that refusal. `CALP_PUSH_SHEET_WITHOUT_ID` keeps the case its
/// remedy fits: an in-range sheet with no id, by name -- and a ticked row whose
/// id is empty, which is that same sheet.
///
/// A FLOATING GRID'S BACKING SHEET is in the state vectors but in no list a
/// caller reads (review round 11). Beside three sheets and a floating grid the
/// sentence says "3 sheets (indexes 0 to 2)" -- what `getSheets()` lists, never
/// the four the state holds -- and the backing sheet's own position is refused
/// like one past the end rather than dropped in silence: `[3]` used to resolve
/// to no sheet at all, and `[1, 2, 3]` (counting from 1) to the last two sheets
/// and the floating grid without the first.
///
/// SABOTAGE: refuse the past-the-end position with
/// `persistence::workbook_changed_refusal` again -- the refusal starts with the
/// retryable code. Or drop the past-the-end check from the `ByPosition` branch
/// of `resolve_publish_sheet_indices` -- the refusal reads "has no stable id ...
/// save and reopen". Or count `sheet_names.len()` in the sentence again -- it
/// reads "4 sheets (indexes 0 to 3)". Or refuse only a position past the end of
/// the state vectors -- `[3]` and `[1, 2, 3]` resolve.
#[test]
fn a_position_past_the_end_of_the_list_is_refused_as_out_of_range_and_not_retryably() {
    use crate::calp_commands::{RequestedSheets, CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE};
    use crate::persistence::WORKBOOK_CHANGED_WHILE_SAVING;
    // Never the retryable code, never a remedy that does not fit, never a claim
    // that something changed.
    let neither_retryable_nor_misleading = |case: &str, refusal: &str| {
        assert!(
            !refusal.starts_with(WORKBOOK_CHANGED_WHILE_SAVING),
            "{case}: a position past the end was refused as RETRYABLE, but resending the same positions can never \
             succeed: {refusal}"
        );
        // The recognisers find a code anywhere in the text, not only at its start.
        assert!(!refusal.contains(WORKBOOK_CHANGED_WHILE_SAVING), "{case}: the retryable code is in it: {refusal}");
        assert!(
            refusal.starts_with(&format!("{CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE}: ")),
            "{case}: not the out-of-range refusal: {refusal}"
        );
        for misleading in ["CALP_PUSH_SHEET_WITHOUT_ID", "no stable id", "save and reopen", "try again", "changed", "''"] {
            assert!(!refusal.contains(misleading), "{case}: the refusal reads '{misleading}': {refusal}");
        }
    };
    for what in ["published", "previewed", "compared", "merged"] {
        let (state, _c) = three_sheets_with_an_autofilter_on_the_last();
        let refusal = crate::calp_commands::resolve_publish_sheet_indices(
            &state,
            "report",
            &RequestedSheets::ByPosition(vec![0, 5]),
            what,
            &Default::default(),
        )
        .map(|s| s.indices)
        .expect_err("a position past the end of the list resolved");
        neither_retryable_nor_misleading(what, &refusal);
        assert_eq!(
            refusal,
            format!(
                "{CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE}: There is no sheet at index 5: the workbook has 3 sheets \
                 (indexes 0 to 2). Nothing was {what}; read the sheet list again and choose the sheets again."
            ),
            "{what}: not the out-of-range refusal in the door's words"
        );
    }
    // Sheet 3 of three, counting from 1 -- through the selection the doors use.
    // Nothing renumbered, so the resolver's own refusal comes back unchanged.
    let (state, _c) = three_sheets_with_an_autofilter_on_the_last();
    let refusal = resolve_request(&state, RequestedSheets::ByPosition(vec![3]), "published")
        .map(|s| s.indices)
        .expect_err("sheet index 3 of three resolved");
    neither_retryable_nor_misleading("sheet 3 of three", &refusal);
    assert!(
        refusal.contains("There is no sheet at index 3: the workbook has 3 sheets (indexes 0 to 2). Nothing was published;"),
        "{refusal}"
    );
    // One sheet, and none: each said as it is.
    let one = crate::create_app_state();
    assert_eq!(one.sheet_names.read().unwrap().len(), 1, "fixture: a new workbook has one sheet");
    let refusal = resolve_request(&one, RequestedSheets::ByPosition(vec![1]), "published")
        .map(|s| s.indices)
        .expect_err("index 1 of one sheet resolved");
    neither_retryable_nor_misleading("one sheet", &refusal);
    assert!(
        refusal.contains("There is no sheet at index 1: the workbook has 1 sheet (index 0). Nothing was published;"),
        "{refusal}"
    );
    let none = crate::create_app_state();
    none.sheet_names.write(&test_seed_effect()).unwrap().clear();
    none.sheet_ids.write(&test_seed_effect()).unwrap().clear();
    none.sheet_visibility.write(&test_seed_effect()).unwrap().clear();
    let refusal = crate::calp_commands::resolve_publish_sheet_indices(
        &none,
        "report",
        &RequestedSheets::ByPosition(vec![0]),
        "published",
        &Default::default(),
    )
    .map(|s| s.indices)
    .expect_err("index 0 of no sheets resolved");
    neither_retryable_nor_misleading("no sheets", &refusal);
    assert!(
        refusal.contains("There is no sheet at index 0: the workbook has no sheets. Nothing was published;"),
        "{refusal}"
    );
    // The last of three, chosen before an agent deleted it -- through the
    // selection, the delete long finished: the same refusal, never the
    // retryable one, because resending position 2 can never succeed either.
    let (state, _c) = three_sheets_with_an_autofilter_on_the_last();
    assert_eq!(delete_sheet_as_an_agent_does(&state, 2), Ok(2), "fixture: C is deleted");
    let refusal = resolve_request(&state, RequestedSheets::ByPosition(vec![2]), "previewed")
        .map(|s| s.indices)
        .expect_err("the deleted last sheet's position resolved");
    neither_retryable_nor_misleading("the deleted last sheet", &refusal);
    assert_eq!(
        refusal,
        format!(
            "{CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE}: There is no sheet at index 2: the workbook has 2 sheets \
             (indexes 0 to 1). Nothing was previewed; read the sheet list again and choose the sheets again."
        )
    );

    // THREE SHEETS AND A FLOATING GRID (review round 11): `[Sheet1, B, C,
    // Float1]`, where `Float1` is the OBJECT-backed sheet of a floating grid on
    // C, at the tail. Every list a caller reads shows three sheets, at 0, 1 and
    // 2; the backing sheet is at 3 in the state vectors and in no list.
    let (state, c) = three_sheets_with_an_autofilter_on_the_last();
    let (backing, float) = append_sheet_for_test(&state, "Float1", crate::sheets::OBJECT_SHEET_VISIBILITY);
    assert_eq!(backing, 3, "fixture: the floating grid's backing sheet sits at the tail, after the three sheets");
    state
        .floating_ranges
        .write(&test_seed_effect())
        .unwrap()
        .push(crate::persistence::saved_floating_range_to_row(&saved_floating_range(c, float)));
    assert_eq!(state.sheet_names.read().unwrap().len(), 4, "fixture: the state holds four sheets");
    assert_eq!(listed_sheet_indexes(&state), vec![0, 1, 2], "fixture: a caller lists three, at 0, 1 and 2");
    let three_listed = |past: usize, what: &str| -> String {
        format!(
            "{CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE}: There is no sheet at index {past}: the workbook has 3 sheets \
             (indexes 0 to 2). Nothing was {what}; read the sheet list again and choose the sheets again."
        )
    };
    // Past the end: the sentence counts the sheets a caller can LIST -- never
    // the four the state holds, whose fourth no list shows.
    let refusal = resolve_request(&state, RequestedSheets::ByPosition(vec![4]), "published")
        .map(|s| s.indices)
        .expect_err("index 4 beside three sheets and a floating grid resolved");
    neither_retryable_nor_misleading("past the end, beside a floating grid", &refusal);
    assert_eq!(refusal, three_listed(4, "published"), "the refusal counts a sheet no list shows");
    // The backing sheet's own position, in every door's words: refused like one
    // past the end. It used to resolve to NO sheet at all -- the explicit filter
    // dropped it in silence.
    for what in ["published", "previewed", "compared", "merged"] {
        let refusal = resolve_request(&state, RequestedSheets::ByPosition(vec![3]), what)
            .map(|s| s.indices)
            .expect_err("the floating grid's backing sheet, by position, resolved");
        neither_retryable_nor_misleading(what, &refusal);
        assert_eq!(refusal, three_listed(3, what), "{what}: not the out-of-range refusal over the listed sheets");
    }
    // Sheets 1 to 3, counting from 1 -- the off-by-one the refusal exists for:
    // refused, never published as B, C and C's floating grid without Sheet1.
    let refusal = resolve_request(&state, RequestedSheets::ByPosition(vec![1, 2, 3]), "published")
        .map(|s| s.indices)
        .expect_err("sheets 1 to 3 of three, counting from 1, resolved: B and C would ship without Sheet1");
    neither_retryable_nor_misleading("sheets 1 to 3 of three", &refusal);
    assert_eq!(refusal, three_listed(3, "published"));
    // The listed positions still resolve, and C still brings its floating
    // grid's backing sheet: the refusal is not wider than the list.
    let selection = resolve_request(&state, RequestedSheets::ByPosition(vec![0, 1, 2]), "published")
        .unwrap_or_else(|e| panic!("the three listed sheets were refused: {e}"));
    assert_eq!(selection.indices, vec![0, 1, 2, backing], "C's floating grid no longer travels with C");

    // NO STABLE ID, in range: by name, with the remedy that fits.
    let (state, _c) = three_sheets_with_an_autofilter_on_the_last();
    let dropped = state.sheet_ids.write(&test_seed_effect()).unwrap().pop();
    assert!(dropped.is_some(), "fixture: the last sheet keeps its name and loses its id");
    assert_eq!(
        crate::calp_commands::resolve_publish_sheet_indices(
            &state,
            "report",
            &RequestedSheets::ByPosition(vec![2]),
            "published",
            &Default::default(),
        )
        .map(|s| s.indices),
        Err("CALP_PUSH_SHEET_WITHOUT_ID: The sheet 'C' has no stable id, so a publish cannot tell it from the sheet \
             that next takes its place. Nothing was published; save and reopen the workbook, then try again."
            .to_string())
    );
    // A ticked row whose id is empty is that sheet: never "no longer in the workbook".
    let refusal = resolve_request(&state, RequestedSheets::ById(vec![String::new()]), "previewed")
        .map(|s| s.indices)
        .expect_err("an empty id resolved");
    assert!(
        refusal.starts_with("CALP_PUSH_SHEET_WITHOUT_ID: A sheet you ticked has no stable id")
            && refusal.contains("Nothing was previewed;"),
        "{refusal}"
    );
}

/// A WORKBOOK LOADED OUT OF PARTITION ORDER IS JUDGED BY ITS OWN LIST (review
/// round 11). Every mutation keeps the user sheets a contiguous prefix with the
/// object sheets at the tail (`sheets::append_user_sheet`, the pulls'
/// `restore_partition_invariant`), but a load copies the file's sheet order and
/// repairs nothing, so a file this build did not write can open as `[Sheet1,
/// Float1, B, C]` -- and `getSheets()` then lists 0, 2 and 3, by their TRUE
/// indexes. A position is refused when no list shows it, never merely for
/// sitting at or past the listed count, and the sentence names the indexes the
/// list shows instead of a range that takes in the backing sheet.
///
/// SABOTAGE: refuse every position at or past the listed count (`i >=
/// listed.len()`) in the `ByPosition` branch of
/// `resolve_publish_sheet_indices` -- `[2, 3]` is refused although the list
/// shows both. Or say any listed count as the range `0 to n-1` in
/// `sheet_index_out_of_range_refusal` -- the sentence claims index 1, the
/// backing sheet.
#[test]
fn a_workbook_loaded_out_of_partition_order_is_judged_by_its_own_list() {
    use crate::calp_commands::{RequestedSheets, CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE};
    let state = crate::create_app_state();
    let sheet1 = state.sheet_ids.read().unwrap()[0];
    let (backing, float) = append_sheet_for_test(&state, "Float1", crate::sheets::OBJECT_SHEET_VISIBILITY);
    // Appended AFTER the object sheet and never rotated in front of it: the
    // order such a file opens in.
    append_sheet_for_test(&state, "B", "visible");
    append_sheet_for_test(&state, "C", "visible");
    state
        .floating_ranges
        .write(&test_seed_effect())
        .unwrap()
        .push(crate::persistence::saved_floating_range_to_row(&saved_floating_range(sheet1, float)));
    assert_eq!(backing, 1, "fixture: the backing sheet sits between the user sheets");
    assert_eq!(listed_sheet_indexes(&state), vec![0, 2, 3], "fixture: a caller lists 0, 2 and 3");

    // What the list shows resolves, at the indexes the list gives it...
    let selection = resolve_request(&state, RequestedSheets::ByPosition(vec![2, 3]), "published")
        .unwrap_or_else(|e| panic!("two sheets the list shows were refused: {e}"));
    assert_eq!(selection.indices, vec![2, 3]);
    // ...and Sheet1 still brings its floating grid's backing sheet.
    let selection = resolve_request(&state, RequestedSheets::ByPosition(vec![0]), "published")
        .unwrap_or_else(|e| panic!("Sheet1 was refused: {e}"));
    assert_eq!(selection.indices, vec![0, backing]);

    // What it does not show is refused -- the backing sheet and past the end
    // alike -- and the sentence names the indexes it does show.
    for past in [backing, 4] {
        let refusal = resolve_request(&state, RequestedSheets::ByPosition(vec![0, past]), "published")
            .map(|s| s.indices)
            .expect_err("a position the list does not show resolved");
        assert_eq!(
            refusal,
            format!(
                "{CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE}: There is no sheet at index {past}: the workbook has 3 sheets \
                 (indexes 0, 2 and 3). Nothing was published; read the sheet list again and choose the sheets again."
            )
        );
    }
}

/// What a selection parked after its basis came to while an agent deleted a sheet.
struct ParkedSelection {
    /// The precondition: the resolution was parked when the delete started, and
    /// still unfinished once the delete had finished.
    deleted_while_parked: bool,
    /// The delete's own answer: the sheet count after it.
    deleted: Result<usize, String>,
    /// The selection as (positions, ids), or its refusal.
    resolved: Result<(Vec<usize>, crate::calp_commands::PublishSheetIds), String>,
    /// The validated attempts it made, counted on its own thread.
    attempts: usize,
}

/// Run `resolve_publish_selection` for `requested` on its own thread, PARKED in
/// the filter-object snapshot -- after it read its sheet-structure basis, before
/// it copies the sheet list -- while an agent deletes the sheet at `index`. The
/// slicer store it parks on is the probe's own, and the delete runs with fresh
/// object stores, so the delete never waits for the parked resolution.
fn run_an_agents_delete_while_the_selection_is_parked_after_its_basis(
    state: &Arc<AppState>,
    requested: crate::calp_commands::RequestedSheets,
    index: usize,
) -> ParkedSelection {
    let slicers = Arc::new(SlicerState::new());
    let parked_on_slicers = slicers.slicers.read().unwrap();
    let started = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let resolver = {
        let state = Arc::clone(state);
        let slicers = Arc::clone(&slicers);
        let started = Arc::clone(&started);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            crate::persistence::SNAPSHOT_ATTEMPTS_TAKEN_FOR_TEST.with(|taken| taken.set(0));
            started.store(true, Ordering::SeqCst);
            let resolved = crate::calp_commands::resolve_publish_selection(
                &state,
                &slicers,
                &crate::timeline_slicer::TimelineSlicerState::new(),
                &PivotState::new(),
                "report",
                requested,
                "published",
            );
            let attempts = crate::persistence::SNAPSHOT_ATTEMPTS_TAKEN_FOR_TEST.with(|taken| taken.get());
            finished.store(true, Ordering::SeqCst);
            (resolved.map(|s| (s.indices, s.ids)), attempts)
        })
    };
    let began = wait_until(2_000, || started.load(Ordering::SeqCst));
    // Long enough to read the basis and reach the parked snapshot.
    std::thread::sleep(Duration::from_millis(250));
    let parked = began && !finished.load(Ordering::SeqCst);
    let deleted_flag = Arc::new(AtomicBool::new(false));
    let deleter = {
        let state = Arc::clone(state);
        let deleted_flag = Arc::clone(&deleted_flag);
        std::thread::spawn(move || {
            let result = delete_sheet_as_an_agent_does(&state, index);
            deleted_flag.store(true, Ordering::SeqCst);
            result
        })
    };
    let deleted_in_time = wait_until(5_000, || deleted_flag.load(Ordering::SeqCst));
    let deleted_while_parked = parked && deleted_in_time && !finished.load(Ordering::SeqCst);
    drop(parked_on_slicers);
    let (resolved, attempts) = resolver.join().expect("the resolver's thread panicked");
    let deleted = deleter.join().expect("the delete's thread panicked");
    ParkedSelection { deleted_while_parked, deleted, resolved, attempts }
}

/// AN ERROR FROM A RESOLUTION A RENUMBERING OVERLAPPED IS JUDGED BY THE
/// GENERATION, like a selection is (F3, review round 8). The resolution parks
/// after it read its basis; an agent deletes the LAST of `[Sheet1, B, C]`; the
/// resolution then reads two sheets.
///
/// * BY POSITION, naming C: the resolution fails -- position 2 is past the end
///   of the list it read -- but that failure describes a list the generation
///   says was torn, so the request gets the retryable "worked out" refusal after
///   ONE attempt, never the stale description of the list -- since round 10 the
///   NON-retryable `CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE`, which would tell the
///   caller that a list which is gone lacks an index.
/// * BY ID, naming C: attempt 1 fails (C is gone) and was overlapped, so it is
///   thrown away and worked out again; attempt 2 refuses by name with nothing
///   overlapping it -- TWO attempts.
/// * BY ID, naming B, which survives: worked out again, never refused.
/// * The default: worked out again, describing the sheets as they are now.
///
/// SABOTAGE: return the resolver's result with `?` before asking
/// `snapshot_is_current`, as before the fix -- the position request gets the
/// stale, non-retryable "There is no sheet at index 2" and the id-of-C request
/// takes one attempt.
#[test]
fn an_error_from_a_resolution_a_renumbering_overlapped_is_judged_by_the_generation() {
    use crate::calp_commands::{
        PublishSheetIds, RequestedSheets, CALP_PUSH_SHEET_GONE, CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE,
    };
    for case in ["position of C", "id of C", "id of B", "default"] {
        let (state, c) = three_sheets_with_an_autofilter_on_the_last();
        let (sheet1, b) = (sheet_id_at(&state, 0), sheet_id_at(&state, 1));
        let requested = match case {
            "position of C" => RequestedSheets::ByPosition(vec![2]),
            "id of C" => RequestedSheets::ById(vec![c.to_string()]),
            "id of B" => RequestedSheets::ById(vec![b.to_string()]),
            _ => RequestedSheets::default(),
        };
        let run = run_an_agents_delete_while_the_selection_is_parked_after_its_basis(&state, requested, 2);
        assert!(
            run.deleted_while_parked,
            "{case}: PRECONDITION FAILED: the delete did not land while the selection was parked after its basis"
        );
        assert_eq!(run.deleted, Ok(2), "{case}: fixture: C was not deleted");
        match case {
            "position of C" => {
                assert_eq!(run.attempts, 1, "a request by position must be refused, not worked out again");
                let refusal = run.resolved.expect_err("the deleted sheet's position resolved");
                assert!(
                    !refusal.contains(CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE) && !refusal.contains("no sheet at index 2"),
                    "the overlapped resolution's own NON-retryable error came back, describing a sheet list the \
                     generation says was torn: {refusal}"
                );
                assert!(
                    refusal.starts_with(&format!(
                        "{}: the workbook changed while it was being published -- ",
                        crate::persistence::WORKBOOK_CHANGED_WHILE_SAVING
                    )) && refusal.contains("worked out"),
                    "the refusal is not the retryable one for an overlapped selection: {refusal}"
                );
            }
            "id of C" => {
                assert_eq!(
                    run.attempts, 2,
                    "the overlapped resolution's error was returned as it was, instead of being worked out again"
                );
                let refusal = run.resolved.expect_err("C, the sheet the id names, is gone");
                assert!(refusal.starts_with(&format!("{CALP_PUSH_SHEET_GONE}: ")), "{refusal}");
            }
            "id of B" => {
                assert_eq!(run.attempts, 2, "the id request was not worked out again after the delete overlapped it");
                let (indices, ids) = run
                    .resolved
                    .unwrap_or_else(|refusal| panic!("a request by id was refused after a renumbering: {refusal}"));
                assert_eq!(indices, vec![1]);
                assert_eq!(ids, PublishSheetIds { sheets: vec![b], backing: Vec::new() });
            }
            _ => {
                assert_eq!(run.attempts, 2, "the default was not worked out again after the delete overlapped it");
                let (indices, ids) = run.resolved.expect("the default is worked out again, never refused");
                assert_eq!(indices, vec![0, 1]);
                assert_eq!(ids, PublishSheetIds { sheets: vec![sheet1, b], backing: Vec::new() });
            }
        }
    }
}

/// EVERY DOOR TAKES THE DIALOG'S IDS, in the source: `calp_publish`,
/// `calp_publish_preview` and the working-copy diff each build their request
/// from their own params' `sheet_ids` and `sheet_indices` through
/// `RequestedSheets::from_wire` and hand THAT request on -- to the selection,
/// or to the preview publish, which hands it to the selection; the diff's
/// subscriber guard asks the request whether it names any sheet; the merge
/// names none; and no door builds a request by position itself.
///
/// SABOTAGE: hand the selection `RequestedSheets::ByPosition(params.sheet_indices)`
/// in `calp_publish`; or build the diff's request from `sheet_indices` alone; or
/// guard the subscriber diff on `params.sheet_indices` again.
#[test]
fn every_publish_door_takes_the_dialogs_sheet_ids_over_its_positions() {
    let code_of = |src: &str, signature: &str| -> String {
        function_body(src, signature)
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let call_args = |body: &str, call: &str| -> String {
        let at = body.find(call).unwrap_or_else(|| panic!("no longer calls `{call}..`"));
        body[at..at + body[at..].find(")?;").expect("the call's end")].to_string()
    };
    let read = |rel: &str| std::fs::read_to_string(src_root().join(rel)).unwrap_or_else(|_| panic!("{rel}"));
    let calp = read("calp_commands.rs");
    let diff = read("calp_diff.rs");
    let merge = read("calp_merge.rs");

    for (src, signature, builds, call) in [
        (
            &calp,
            "pub fn calp_publish(",
            // Cloned (round 13): the carrier gates read `&params` after the
            // request is built, so the ids are no longer moved out of it.
            "RequestedSheets::from_wire(params.sheet_ids.clone(), params.sheet_indices.clone())",
            "resolve_publish_selection(",
        ),
        (
            &calp,
            "pub fn calp_publish_preview(",
            "RequestedSheets::from_wire(params.sheet_ids, params.sheet_indices.unwrap_or_default())",
            "resolve_publish_selection(",
        ),
        (
            &diff,
            "pub fn calp_diff_working_copy(",
            "RequestedSheets::from_wire(\n        params.sheet_ids.clone(),\n        params.sheet_indices.clone().unwrap_or_default(),\n    )",
            "publish_into_for_preview(",
        ),
    ] {
        let body = code_of(src, signature);
        assert!(body.contains(builds), "`{signature}..` no longer builds its request from its params' ids: {builds}");
        assert!(
            call_args(&body, call).contains("\n        requested,\n"),
            "`{signature}..` does not hand its request to `{call}..`"
        );
        for raw in ["ByPosition(", "ById("] {
            assert!(!body.contains(raw), "`{signature}..` builds a request itself (`{raw}..`) instead of from its params");
        }
    }
    let guard = code_of(&diff, "pub fn calp_diff_working_copy(");
    let at = guard.find("CALP_DIFF_NEEDS_SHEETS").expect("the subscriber guard is gone");
    let condition = &guard[guard[..at].rfind("if ").expect("the guard's condition")..at];
    assert!(
        condition.contains("requested.names_no_sheet()") && !condition.contains("params.sheet_indices"),
        "the subscriber guard does not ask the request -- a diff naming its sheets by id would be refused: {condition}"
    );
    let into = code_of(&calp, "pub(crate) fn publish_into_for_preview(");
    assert!(
        call_args(&into, "resolve_publish_selection(").contains("\n        requested,\n"),
        "the preview publish does not hand its caller's request to the selection"
    );
    let merge_code: String = merge.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n");
    assert!(
        call_args(&merge_code, "publish_into_for_preview(").contains("RequestedSheets::default(),"),
        "the merge no longer previews the default selection"
    );
}

/// THE RESOLUTION COPIES ITS SHEET LIST, ITS IDS AND ITS VISIBILITY UNDER ONE
/// HOLD (F3, review round 8): `sheet_names` is held while `sheet_ids` and
/// `sheet_visibility` are copied, each exactly once, and neither of those two is
/// held while the other is taken -- names first, the order every renumbering
/// takes them in. The ids used to be copied a hundred lines after the names,
/// and a delete landing in between left a selected sheet with no id.
///
/// SABOTAGE: move the `sheet_ids` copy out of the block, below it -- the census
/// no longer sees the pair read under one hold.
#[test]
fn the_publish_resolution_copies_the_sheet_list_its_ids_and_visibility_under_one_hold() {
    const RESOLVER: &str = "resolve_publish_sheet_indices";
    let calp = std::fs::read_to_string(src_root().join("calp_commands.rs")).expect("cannot read calp_commands.rs");
    let scan = sheet_pair_reads("calp_commands.rs", &calp);
    assert!(
        scan.paired.iter().any(|f| f == RESOLVER),
        "`{RESOLVER}` no longer reads `sheet_ids` while its `sheet_names` read is held"
    );
    assert!(!scan.torn.iter().any(|hit| hit.function == RESOLVER), "`{RESOLVER}` reads the pair in two holds");
    assert!(
        pair_inversions("calp_commands.rs", &calp, "sheet_names", "sheet_visibility")
            .iter()
            .any(|hit| hit.function == RESOLVER),
        "`{RESOLVER}` no longer copies the visibility while its `sheet_names` read is held"
    );
    for (holding, taking) in [("sheet_ids", "sheet_visibility"), ("sheet_visibility", "sheet_ids")] {
        assert!(
            !pair_inversions("calp_commands.rs", &calp, holding, taking).iter().any(|hit| hit.function == RESOLVER),
            "`{RESOLVER}` holds `{holding}` while it takes `{taking}` -- copy each and release it"
        );
    }
    let body: String = function_body(&blank_literals(&calp), &format!("pub(crate) fn {RESOLVER}("))
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    for read in ["state.sheet_names.read(", "state.sheet_ids.read(", "state.sheet_visibility.read("] {
        assert_eq!(
            body.matches(read).count(),
            1,
            "`{RESOLVER}` reads `{read}..` more than once (or not at all): a second copy is a second sheet list"
        );
    }
}

// ---------------------------------------------------------------------------
// The source half: the hold spans the body, every door validates its tail,
// every renumbering moves the generation
// ---------------------------------------------------------------------------

/// Where `function`'s body reads a store -- directly, or through a crate
/// function of `graph` -- while `grid` or `grids` is NOT held, after it took
/// them. Returns `(line, store)` for each such read, and the reads made BEFORE
/// the two were taken. Empty violations mean the hold spans the body from its
/// first read to its last.
///
/// The two guards are tracked by the names they are bound to: released by
/// `drop(name)` or by the block they live in closing.
fn reads_outside_the_grid_hold(text: &str, function: &str, graph: &CallGraph) -> (Vec<(usize, String)>, Vec<String>) {
    use crate::formula_serialisation_tests::starts_a_function;
    let stripped = blank_literals(&strip_cfg_test_items(text));
    let lines: Vec<&str> = stripped.lines().collect();
    let code: Vec<&str> = lines.iter().map(|l| l.split("//").next().unwrap_or("")).collect();
    let start = lines
        .iter()
        .position(|l| starts_a_function(l) && function_name_of(l).as_deref() == Some(function))
        .unwrap_or_else(|| panic!("`{function}` not found"));
    let mut depth: i32 = 0;
    let mut entered = false;
    // (binding, scope) of the live `grid` / `grids` guards.
    let mut grid: Option<(String, i32)> = None;
    let mut grids: Option<(String, i32)> = None;
    let mut taken = false;
    let mut outside: Vec<(usize, String)> = Vec::new();
    let mut before: Vec<String> = Vec::new();
    for i in start..lines.len() {
        let line = code[i];
        let mut events: Vec<(usize, String, bool, String)> = Vec::new();
        if i > start {
            let (acquisitions, _) = acquisitions_at(&code, i, &statement_tail(&code, i));
            events.extend(acquisitions.into_iter().map(|a| (a.col, a.field, a.live, a.binding)));
            for (col, callee) in calls_on_line(line, graph) {
                for store in &graph[callee] {
                    events.push((col, store.clone(), false, String::new()));
                }
            }
        }
        events.sort_by_key(|e| e.0);
        for (_, store, live, binding) in events {
            if store == "grid" && live && grid.is_none() {
                grid = Some((binding, depth));
                continue;
            }
            if store == "grids" && live && grids.is_none() {
                grids = Some((binding, depth));
                taken = grid.is_some();
                continue;
            }
            if !taken {
                before.push(store);
            } else if grid.is_none() || grids.is_none() {
                outside.push((i + 1, store));
            }
        }
        let dropped = dropped_on_line(line);
        for guard in [&mut grid, &mut grids] {
            if guard.as_ref().is_some_and(|(name, _)| dropped.contains(name)) {
                *guard = None;
            }
        }
        let opens = line.matches('{').count() as i32;
        let closes = line.matches('}').count() as i32;
        depth -= closes;
        for guard in [&mut grid, &mut grids] {
            if guard.as_ref().is_some_and(|(_, scope)| depth < *scope) {
                *guard = None;
            }
        }
        depth += opens;
        entered |= opens > 0;
        if entered && depth <= 0 {
            break;
        }
    }
    assert!(taken, "`{function}` no longer takes `grid` and then `grids` at all");
    (outside, before)
}

/// THE HOLD SPANS THE BODY: every store `build_workbook_for_save` reads after it
/// takes `grid` and `grids` -- directly or through a crate function it calls --
/// is read while BOTH are still held; the only reads before them are the BI
/// key copies the chart stamp needs, taken and released first.
///
/// SABOTAGE: move `drop(grids); drop(active_grid);` back to right after the
/// sheet loop -- this fails naming `tables`, `charts`, `files`, `media` and the
/// stores `enrich_workbook_metadata` reads.
#[test]
fn the_save_body_holds_both_grid_locks_from_its_first_read_to_its_last() {
    let graph = direct_acquisitions_by_function(&crate_sources());
    let src = std::fs::read_to_string(src_root().join("persistence.rs")).expect("cannot read persistence.rs");
    let (outside, before) = reads_outside_the_grid_hold(&src, "build_workbook_for_save", &graph);
    assert!(
        outside.is_empty(),
        "`build_workbook_for_save` reads these stores after it released `grid` / `grids`:\n{}\n\nEvery one is \
         paired with the sheet list the loop copied, by index, and a structural sheet operation running off \
         the main thread (the async drill-through's add, an MCP agent's delete) can renumber the sheets as soon \
         as the grid locks are released -- the save then writes a torn snapshot (F1, review round 7). Hold both \
         until the last read.",
        outside.iter().map(|(line, store)| format!("  line {line}: {store}")).collect::<Vec<_>>().join("\n")
    );
    assert!(
        before.iter().all(|store| store == "connections"),
        "`build_workbook_for_save` reads stores BEFORE it takes the grid locks: {before:?}. Only the BI key \
         copies (`bi_state.connections`, taken and released) belong there"
    );
    // NON-VACUITY: the hold really covers the body's index-keyed reads, through
    // the calls the one-level graph knows.
    let (covered, _) = reads_outside_the_grid_hold(
        &src.replace("enrich_workbook_metadata(&mut workbook, state, &sheet_ids);", "")
            .replace("    drop(grids);\n    drop(active_grid);\n\n    Ok((workbook, basis))", "    drop(grids);\n    drop(active_grid);\n    enrich_workbook_metadata(&mut workbook, state, &sheet_ids);\n\n    Ok((workbook, basis))"),
        "build_workbook_for_save",
        &graph,
    );
    assert!(
        covered.iter().any(|(_, store)| store == "sheet_visibility"),
        "the pin cannot see `enrich_workbook_metadata`'s reads through the call, so it would pass a body that \
         read them outside the hold: {covered:?}"
    );
}

/// The span detector on planted bodies: the pre-fix shape is caught, the fixed
/// shape is quiet, and a read after the final release is caught too.
#[test]
fn the_grid_hold_span_detector_fires_on_the_shapes_it_exists_for() {
    let graph: CallGraph = [
        ("enrich", vec!["sheet_visibility", "page_setups"]),
        ("keys", vec!["connections"]),
    ]
    .into_iter()
    .map(|(name, stores)| (name.to_string(), stores.into_iter().map(str::to_string).collect()))
    .collect();
    let fixed = r##"pub fn build(state: &AppState) -> Result<(), String> {
    let chart_keys = keys(bi_state);
    let active_grid = state.grid.read().map_err(|e| e.to_string())?;
    let grids = state.grids.read().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
    drop(sheet_names);
    let media = state.media.read().map_err(|e| e.to_string())?.clone();
    enrich(state);
    drop(grids);
    drop(active_grid);
    Ok(())
}
"##;
    let (outside, before) = reads_outside_the_grid_hold(fixed, "build", &graph);
    assert!(outside.is_empty(), "the fixed shape read as torn: {outside:?}");
    assert_eq!(before, vec!["connections".to_string()], "the BI copy before the hold");

    let pre_fix = r##"pub fn build(state: &AppState) -> Result<(), String> {
    let active_grid = state.grid.read().map_err(|e| e.to_string())?;
    let grids = state.grids.read().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
    drop(grids);
    drop(active_grid);
    drop(sheet_names);
    let media = state.media.read().map_err(|e| e.to_string())?.clone();
    enrich(state);
    Ok(())
}
"##;
    let (outside, _) = reads_outside_the_grid_hold(pre_fix, "build", &graph);
    let stores: Vec<&str> = outside.iter().map(|(_, s)| s.as_str()).collect();
    assert_eq!(stores, ["media", "sheet_visibility", "page_setups"], "the pre-fix shape was not caught: {outside:?}");

    let read_after = r##"pub fn build(state: &AppState) -> Result<(), String> {
    let active_grid = state.grid.read().map_err(|e| e.to_string())?;
    let grids = state.grids.read().map_err(|e| e.to_string())?;
    enrich(state);
    drop(grids);
    let theme = state.theme.read().unwrap().clone();
    drop(active_grid);
    Ok(())
}
"##;
    let (outside, _) = reads_outside_the_grid_hold(read_after, "build", &graph);
    assert_eq!(outside, vec![(6, "theme".to_string())], "a read after one guard went was not caught");

    let scoped = r##"pub fn build(state: &AppState) -> Result<(), String> {
    {
        let active_grid = state.grid.read().map_err(|e| e.to_string())?;
        let grids = state.grids.read().map_err(|e| e.to_string())?;
    }
    enrich(state);
    Ok(())
}
"##;
    let (outside, _) = reads_outside_the_grid_hold(scoped, "build", &graph);
    assert_eq!(outside.len(), 2, "guards that died with their block were read as held: {outside:?}");
}

/// EVERY SNAPSHOT DOOR VALIDATES ITS TAIL against the structure its body copied:
/// the `.cala` save / AutoRecover door and the `.calp` publish door each take
/// their one attempt through `take_consistent_snapshot`; each attempt gets its
/// basis from the shared body and returns it in its final `Ok`; the body reads
/// the basis while it holds both grid locks; the check runs after the attempt
/// (after its last store read) under `sheet_names` alone, bounded, refusing
/// retryably; and the tails map their slicers and timelines through the
/// snapshot's OWN sheet ids, never a second read of the live list.
///
/// SABOTAGE: return `Ok(workbook)` from `assemble_workbook_for_save` without
/// `take_consistent_snapshot`, or move `capture_snapshot_basis(state)` above
/// `state.grid.read()` -- this fails naming the door or the body.
#[test]
fn every_snapshot_door_validates_its_tail_against_the_structure_its_body_copied() {
    let persistence = blank_literals(&std::fs::read_to_string(src_root().join("persistence.rs")).expect("persistence.rs"));
    let calp = blank_literals(&std::fs::read_to_string(src_root().join("calp_commands.rs")).expect("calp_commands.rs"));
    let code_of = |src: &str, signature: &str| -> String {
        function_body(src, signature)
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    };

    // The doors.
    for (src, door, attempt) in [
        (&persistence, "pub(crate) fn assemble_workbook_for_save(", "assemble_workbook_snapshot("),
        (&calp, "fn assemble_publish_workbook(", "assemble_publish_snapshot("),
    ] {
        let body = code_of(src, door);
        assert!(
            body.contains("take_consistent_snapshot(") && body.contains(attempt),
            "`{door}..` no longer takes its `{attempt}..` through `take_consistent_snapshot`: a tail read across \
             a sheet renumbering would be written as it is"
        );
    }

    // The attempts carry the body's basis out.
    let save_attempt = code_of(&persistence, "pub(crate) fn assemble_workbook_snapshot(");
    assert!(
        save_attempt.contains("let (mut workbook, basis) = build_workbook_for_save(")
            && save_attempt.trim_end().trim_end_matches('}').trim_end().ends_with("Ok((workbook, basis))"),
        "`assemble_workbook_snapshot` no longer hands back the basis its body read"
    );
    let publish_attempt = code_of(&calp, "fn assemble_publish_snapshot(");
    let returned = publish_attempt.rfind("Ok((").expect("the publish attempt's final Ok");
    assert!(
        publish_attempt.contains("let (mut workbook, basis) = crate::persistence::build_workbook_for_save_with_slicers(")
            && publish_attempt[returned..].contains("basis,"),
        "`assemble_publish_snapshot` no longer hands back the basis its body read"
    );
    let carrier = code_of(&persistence, "pub fn build_workbook_for_save_with_slicers(");
    assert!(
        carrier.contains("let (mut workbook, basis) = build_workbook_for_save(") && carrier.contains("Ok((workbook, basis))"),
        "the carrier's collector no longer passes the body's basis through"
    );

    // The body reads the basis INSIDE its hold.
    let body = code_of(&persistence, "pub fn build_workbook_for_save(");
    let grid = body.find("state.grid.read(").expect("the body no longer takes `grid`");
    let grids = body.find("state.grids.read(").expect("the body no longer takes `grids`");
    let basis = body.find("capture_snapshot_basis(state)").expect("the body no longer reads its basis");
    let released = body.find("drop(grids);").expect("the body no longer releases `grids` itself");
    assert!(
        grid < grids && grids < basis && basis < released,
        "the body must read its basis while it holds both grid locks, or the basis can describe a sheet list \
         other than the one the sheet loop copied"
    );

    // The check: after every attempt, under `sheet_names` alone, bounded, retryable.
    let take = code_of(&persistence, "pub(crate) fn take_consistent_snapshot<");
    let attempt = take.find("take()?").expect("the retry no longer takes an attempt");
    let check = take.find("snapshot_is_current(state, &basis)?").expect("the retry no longer checks the basis");
    assert!(attempt < check, "the basis must be checked AFTER the attempt's last store read");
    assert!(take.contains("for attempt in 1..=SNAPSHOT_ATTEMPTS"), "the retry is no longer bounded");
    assert!(take.contains("WORKBOOK_CHANGED_WHILE_SAVING"), "the refusal is no longer the retryable one");
    let current = code_of(&persistence, "pub(crate) fn snapshot_is_current(");
    let names = current.find("state.sheet_names.read(").expect("the check no longer waits out a renumbering");
    let load = current.find("sheet_structure_generation.load(").expect("the check no longer reads the generation");
    assert!(names < load, "the generation must be read while `sheet_names` is held");
    assert_eq!(
        acquisitions_in_text(&current),
        vec!["sheet_names".to_string()],
        "the check must take `sheet_names` ALONE: anything else held there can close a cycle"
    );

    // The tails map indices through the snapshot's own ids.
    for (signature, binding) in [
        ("pub(crate) fn assemble_workbook_snapshot(", "let sheet_ids_save: Vec<SheetId> = workbook.sheets.iter()"),
        ("pub fn build_workbook_for_save_with_slicers(", "let snapshot_sheet_ids: Vec<SheetId> = workbook.sheets.iter()"),
    ] {
        let tail = code_of(&persistence, signature);
        assert!(tail.contains(binding), "`{signature}..` no longer maps its tail through the snapshot's own sheet ids");
        assert!(
            !tail.contains("sheet_ids.read("),
            "`{signature}..` reads the live `sheet_ids` again: its tail would pair the slicers and timelines with \
             a sheet list other than the one its body copied"
        );
    }

    // Only the doors take an attempt: nothing else can write one unvalidated.
    for (attempt, door) in [("assemble_workbook_snapshot(", "assemble_workbook_for_save"), ("assemble_publish_snapshot(", "assemble_publish_workbook")] {
        let callers: Vec<String> = crate_sources()
            .iter()
            .flat_map(|(rel, text)| {
                crate::formula_serialisation_tests::free_function_bodies(&blank_literals(text))
                    .into_iter()
                    .filter(|(_, body)| {
                        body.lines().map(|l| l.split("//").next().unwrap_or("")).any(|l| l.contains(attempt))
                    })
                    .map(|(name, _)| format!("{rel}::{name}"))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert_eq!(callers.len(), 1, "`{attempt}..` must be called by its door alone: {callers:?}");
        assert!(callers[0].ends_with(&format!("::{door}")), "`{attempt}..` is called by {callers:?}, not by `{door}`");
    }
}

/// The state stores `text` acquires, in order, by the census's own reader.
fn acquisitions_in_text(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    for i in 0..lines.len() {
        let (acquisitions, _) = acquisitions_at(&lines, i, &statement_tail(&lines, i));
        out.extend(acquisitions.into_iter().map(|a| a.field));
    }
    out
}

/// The renumberings of the sheet list a census can recognise in one body.
#[derive(Debug, Default, PartialEq)]
struct SheetIdsMutations {
    /// An in-place renumbering: a rotation, a removal, an insertion.
    in_place: bool,
    /// A whole new list assigned.
    replaced: bool,
}

fn sheet_ids_mutations(code: &str) -> SheetIdsMutations {
    // A method called on a guard NAMED `sheet_ids`: the name must stand alone,
    // so `out.package_sheet_ids.insert(..)` (a set of package ids) is not it.
    let on_the_list = |method: &str| -> bool {
        let needle = format!("sheet_ids.{method}");
        code.match_indices(needle.as_str()).any(|(at, _)| {
            code[..at].chars().last().map_or(true, |c| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'))
        })
    };
    let in_place = code.contains("rotate_element(&mut *sheet_ids")
        || code.contains("rotate_element(&mut sheet_ids")
        || ["remove(", "insert(", "swap(", "retain(", "drain(", "truncate(", "sort", "reverse("]
            .iter()
            .any(|method| on_the_list(method));
    let replaced = code.contains("*sheet_ids = ") || code.contains("*state.sheet_ids.write(");
    SheetIdsMutations { in_place, replaced }
}

/// Every function in `sources` that renumbers the sheet list without moving the
/// sheet-structure generation: an in-place renumbering must re-key through
/// `remap_sheet_keyed_stores` (which moves it), a whole new list must call
/// `note_sheet_structure_change` itself. Returns the offenders and every
/// function seen renumbering, as `file::function`.
fn renumberings_that_do_not_move_the_generation(sources: &[(String, String)]) -> (Vec<String>, Vec<String>) {
    let mut offenders = Vec::new();
    let mut seen = Vec::new();
    for (rel, text) in sources {
        // Literals blanked, test items NOT stripped: the strip ends a test item
        // at the next column-0 brace, so a function body carrying an indented
        // `#[cfg(test)]` statement loses its own closing brace and the walker
        // runs to the end of the file. The walker takes column-0 declarations
        // only, so the functions of a test module are not read anyway.
        let blanked = blank_literals(text);
        for (name, body) in crate::formula_serialisation_tests::free_function_bodies(&blanked) {
            let code: String = body.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n");
            let mutations = sheet_ids_mutations(&code);
            if mutations == SheetIdsMutations::default() {
                continue;
            }
            seen.push(format!("{rel}::{name}"));
            if mutations.in_place && !code.contains("remap_sheet_keyed_stores(") {
                offenders.push(format!("  {rel}::{name} renumbers `sheet_ids` in place and never calls `remap_sheet_keyed_stores`"));
            }
            if mutations.replaced && !code.contains("note_sheet_structure_change(") {
                offenders.push(format!("  {rel}::{name} installs a new `sheet_ids` list and never calls `note_sheet_structure_change`"));
            }
        }
    }
    (offenders, seen)
}

/// EVERY RENUMBERING MOVES THE GENERATION, crate-wide -- the premise the tails'
/// validation stands on. The re-key every in-place renumbering goes through
/// bumps it first thing; the two paths that install a whole new list bump it
/// themselves; and nothing renumbers `sheet_ids` any other way.
///
/// SABOTAGE: delete `note_sheet_structure_change(state)` from
/// `remap_sheet_keyed_stores` -- this fails, and so does the tail probe.
#[test]
fn every_sheet_renumbering_moves_the_structure_generation() {
    let sheets = std::fs::read_to_string(src_root().join("sheets.rs")).expect("sheets.rs");
    let remap = function_body(&sheets, "fn remap_sheet_keyed_stores(");
    let first_statement = remap
        .lines()
        .map(|l| l.split("//").next().unwrap_or("").trim())
        .find(|l| !l.is_empty() && *l != "{")
        .unwrap_or("");
    assert_eq!(
        first_statement, "crate::persistence::note_sheet_structure_change(state);",
        "`remap_sheet_keyed_stores` no longer moves the sheet-structure generation FIRST: a save's tail that read \
         across this renumbering would be written torn"
    );
    let persistence = std::fs::read_to_string(src_root().join("persistence.rs")).expect("persistence.rs");
    let note = function_body(&persistence, "pub(crate) fn note_sheet_structure_change(");
    assert!(
        note.contains(".sheet_structure_generation") && note.contains(".fetch_add(1"),
        "`note_sheet_structure_change` no longer moves the generation"
    );

    let (offenders, seen) = renumberings_that_do_not_move_the_generation(&crate_sources());
    // NON-VACUITY: the census sees every renumbering the crate has today.
    for anchor in [
        "sheets.rs::append_user_sheet",
        "sheets.rs::delete_sheet_impl",
        "sheets.rs::move_sheet_impl",
        "sheets.rs::copy_sheet_impl",
        "sheets.rs::restore_partition_invariant",
        "persistence.rs::open_file",
        "persistence.rs::reset_document_scoped_stores",
    ] {
        assert!(
            seen.iter().any(|s| s == anchor),
            "the census no longer sees `{anchor}` renumber the sheet list, so it may not be reading what it claims. \
             It sees:\n  {}",
            seen.join("\n  ")
        );
    }
    assert!(
        offenders.is_empty(),
        "these functions renumber the sheets without moving the sheet-structure generation:\n{}\n\nA save, \
         AutoRecover or publish snapshot validates its tail -- the reads it cannot make under the grid locks -- by \
         comparing the generation its body read with the one after its last read. A renumbering that does not \
         move it is invisible to that check, and the snapshot is written TORN (F1, review round 7).",
        offenders.join("\n")
    );

    // TEETH, on planted bodies. (The file's first function sits after a line,
    // as in every real file: the shared walker finds declarations at line starts.)
    let planted = vec![(
        "a.rs".to_string(),
        r##"//! planted
pub fn rotates_quietly(state: &AppState) {
    let mut sheet_ids = state.sheet_ids.write(&e).unwrap();
    rotate_element(&mut *sheet_ids, 3, 1);
}

pub fn rotates_and_rekeys(state: &AppState) {
    let mut sheet_ids = state.sheet_ids.write(&e).unwrap();
    sheet_ids.remove(2);
    remap_sheet_keyed_stores(state, &e, |i| Some(i));
}

pub fn replaces_quietly(state: &AppState) {
    *state.sheet_ids.write(&e).unwrap() = Vec::new();
}

pub fn appends(state: &AppState) {
    let mut sheet_ids = state.sheet_ids.write(&e).unwrap();
    sheet_ids.push(id);
}

pub fn collects_package_ids(out: &mut Out) {
    out.package_sheet_ids.insert(id);
}
"##
        .to_string(),
    )];
    let (offenders, seen) = renumberings_that_do_not_move_the_generation(&planted);
    assert_eq!(
        seen,
        ["a.rs::rotates_quietly", "a.rs::rotates_and_rekeys", "a.rs::replaces_quietly"],
        "an append renumbers nothing, and another set's `package_sheet_ids` is not the sheet list"
    );
    assert_eq!(offenders.len(), 2, "the census missed a quiet renumbering: {offenders:?}");
    assert!(offenders[0].contains("rotates_quietly") && offenders[1].contains("replaces_quietly"), "{offenders:?}");
}

// ---------------------------------------------------------------------------
// ...and every renumbering bumps INSIDE its `sheet_names` hold (F5, review
// round 8)
// ---------------------------------------------------------------------------

/// The calls that move the sheet-structure generation: the re-key every
/// in-place renumbering goes through (its first statement is the bump) and the
/// bump itself, which the two whole-list installs call.
const STRUCTURE_BUMPS: [&str; 2] = ["remap_sheet_keyed_stores(", "note_sheet_structure_change("];

/// The other index re-keys a renumbering runs beside the bump. Each one must be
/// inside the same `sheet_names` hold: a re-key after the release lets a
/// snapshot whose body ran after the bump read the store un-rotated, against a
/// generation that already counts the renumbering.
const INDEX_REKEYS: [&str; 4] =
    ["remap_tables_store(", "remap_note_and_hyperlink_stores(", "remap_report_sheets(", "cascade_sheet_removed("];

/// Is the call at byte `at` of `code` a CALL of a free function (not its
/// declaration, not an identifier that merely ends in the same letters)?
fn is_a_call_at(code: &str, at: usize) -> bool {
    let before = &code[..at];
    !before.trim_end().ends_with("fn")
        && !before.chars().last().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Every name a `drop(..)` STATEMENT starting on line `i` of `code` releases:
/// `drop(name)` and the TUPLE form `drop((a, b, ..))`, which `move_sheet_impl`
/// and `copy_sheet_impl` spell over fourteen lines. `dropped_on_line` reads a
/// name only directly after `drop(`, so a guard released through a tuple stayed
/// "held" to the end of its block -- and a bump moved below such a drop would
/// pass any census built on it (F5, review round 8).
fn dropped_in_statement(code: &[&str], i: usize) -> Vec<String> {
    let line = code[i];
    let mut out = dropped_on_line(line);
    for (at, _) in line.match_indices("drop((") {
        if line[..at].chars().last().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let mut tuple = line[at + "drop((".len()..].to_string();
        let mut next = i + 1;
        while !tuple.contains("))") && next < code.len() && next <= i + 64 {
            tuple.push(' ');
            tuple.push_str(code[next]);
            next += 1;
        }
        let inside = tuple.split("))").next().unwrap_or("");
        out.extend(
            inside
                .split(',')
                .map(|name| name.trim().trim_start_matches('&').trim().to_string())
                .filter(|name| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')),
        );
    }
    out
}

/// Every call `function` (in `text`) makes to one of `calls`, with whether a
/// `sheet_names` guard was LIVE at it. The guard tracker
/// `reads_outside_the_grid_hold` runs -- acquisitions read by `acquisitions_at`,
/// a guard alive from its binding until `drop(name)` or until its block closes,
/// closes applied before opens -- taught the two shapes the renumberings use:
/// the tuple drop ([`dropped_in_statement`]) and the `authorize` rebinding
/// (`let mut sheet_names = pending_names.authorize(&effect);` is the SAME guard
/// under a new name, so it stays held, and a drop of either name releases it).
/// Returns `(line, call, live)` per call site, in source order.
fn sheet_names_guard_at_each_call(text: &str, function: &str, calls: &[&str]) -> Vec<(usize, String, bool)> {
    use crate::formula_serialisation_tests::starts_a_function;
    let blanked = blank_literals(text);
    let lines: Vec<&str> = blanked.lines().collect();
    let code: Vec<&str> = lines.iter().map(|l| l.split("//").next().unwrap_or("")).collect();
    let start = lines
        .iter()
        .position(|l| starts_a_function(l) && function_name_of(l).as_deref() == Some(function))
        .unwrap_or_else(|| panic!("`{function}` not found"));
    let mut depth: i32 = 0;
    let mut entered = false;
    // Every live `sheet_names` guard: the names it answers to, and the depth of
    // the block it dies with.
    let mut guards: Vec<(Vec<String>, i32)> = Vec::new();
    let mut out = Vec::new();
    for i in start..lines.len() {
        let line = code[i];
        let dropped = dropped_in_statement(&code, i);
        if i > start {
            let (acquisitions, _) = acquisitions_at(&code, i, &statement_tail(&code, i));
            for acquisition in acquisitions {
                if acquisition.field == "sheet_names" && acquisition.live && !acquisition.binding.is_empty() {
                    guards.push((vec![acquisition.binding], depth));
                }
            }
            if let Some(at) = line.find(".authorize(") {
                let source = trailing_ident(&line[..at]).to_string();
                let rebound = binding_name(line);
                if !rebound.is_empty() {
                    for guard in guards.iter_mut().filter(|(names, _)| names.contains(&source)) {
                        guard.0.push(rebound.clone());
                        guard.1 = depth;
                    }
                }
            }
            // A drop EARLIER on the same line already released what it names.
            let drop_at = line.find("drop(");
            for call in calls {
                for (at, _) in line.match_indices(*call) {
                    if !is_a_call_at(line, at) {
                        continue;
                    }
                    let live = guards.iter().any(|(names, _)| {
                        !(drop_at.is_some_and(|d| d < at) && names.iter().any(|n| dropped.contains(n)))
                    });
                    out.push((i + 1, call.trim_end_matches('(').to_string(), live));
                }
            }
        }
        guards.retain(|(names, _)| !names.iter().any(|n| dropped.contains(n)));
        // The braces IN SOURCE ORDER. Counting closes before opens -- the rule
        // `reads_outside_the_grid_hold` and `sheet_pair_reads` still use (the
        // grid and pair censuses read braces in order since rev5C#1,
        // `brace_profile`), right for `} else {` -- reads a one-line closure at the
        // guard's own depth (`let remap = |i| -> Option<usize> { Some(i) };` in
        // `restore_partition_invariant`) as the guard's block closing, and the
        // guard is forgotten one line before the remap it covers.
        for brace in line.chars().filter(|c| *c == '{' || *c == '}') {
            if brace == '{' {
                depth += 1;
                entered = true;
            } else {
                depth -= 1;
                guards.retain(|(_, scope)| depth >= *scope);
            }
        }
        if entered && depth <= 0 {
            break;
        }
    }
    out
}

/// Every production call to a [`STRUCTURE_BUMPS`] entry in `sources`, as
/// `(file, enclosing function, line)` -- found LINE BY LINE, so a caller the
/// renumbering census does not recognise as a renumbering is checked too. Not
/// a declaration, not inside a `#[cfg(test)]` item, and not inside
/// `remap_sheet_keyed_stores` itself, whose first statement IS the bump: its
/// callers are what is checked.
fn structure_bump_call_sites(sources: &[(String, String)]) -> Vec<(String, String, usize)> {
    use crate::formula_serialisation_tests::starts_a_function;
    let mut out = Vec::new();
    for (rel, text) in sources {
        let blanked = blank_literals(text);
        let lines: Vec<&str> = blanked.lines().collect();
        for (i, raw) in lines.iter().enumerate() {
            let code = raw.split("//").next().unwrap_or("");
            let calls = STRUCTURE_BUMPS
                .iter()
                .any(|call| code.match_indices(*call).any(|(at, _)| is_a_call_at(code, at)));
            if !calls {
                continue;
            }
            let Some(declared) = (0..=i).rev().find(|&j| starts_a_function(lines[j])) else { continue };
            let name = function_name_of(lines[declared]).unwrap_or_default();
            let test_only = (0..declared)
                .rev()
                .map(|j| lines[j].trim())
                .take_while(|l| l.starts_with("#[") || l.starts_with("///"))
                .any(|l| l.starts_with("#[cfg(test)]"));
            if test_only || name == "remap_sheet_keyed_stores" {
                continue;
            }
            out.push((rel.clone(), name, i + 1));
        }
    }
    out
}

/// EVERY RENUMBERING BUMPS INSIDE ITS `sheet_names` HOLD -- the property
/// `snapshot_is_current`'s wait stands on. It takes `sheet_names` to wait out a
/// renumbering in progress, so a renumbering that moved the generation, or
/// re-keyed an index-keyed store, AFTER releasing `sheet_names` lets a snapshot
/// read the rotated stores, see the old counter and be written torn. The census
/// of WHO bumps (above) cannot see that: a remap moved below
/// `move_sheet_impl`'s fourteen-line `drop((current_grid, grids, sheet_names,
/// ..))` still calls the remap, the remap still bumps first, and the tail probe
/// never runs a move (F5, review round 8).
///
/// Every production call to `remap_sheet_keyed_stores` or
/// `note_sheet_structure_change` -- found crate-wide, line by line -- must run
/// under a live `sheet_names` guard, and so must every other index re-key
/// ([`INDEX_REKEYS`]) in the same functions.
///
/// SABOTAGE: move `move_sheet_impl`'s remap below its `drop((..))`, or hoist
/// `reset_document_scoped_stores`' `note_sheet_structure_change(state)` out of
/// its block -- this fails naming the function and the line.
#[test]
fn every_sheet_renumbering_bumps_inside_its_sheet_names_hold() {
    let sources = crate_sources();
    let sites = structure_bump_call_sites(&sources);
    let mut functions: Vec<(String, String)> = sites.iter().map(|(rel, name, _)| (rel.clone(), name.clone())).collect();
    functions.dedup();
    let calls: Vec<&str> = STRUCTURE_BUMPS.iter().chain(INDEX_REKEYS.iter()).copied().collect();
    let mut checked: Vec<String> = Vec::new();
    let mut outside: Vec<String> = Vec::new();
    for (rel, name) in &functions {
        let text = &sources.iter().find(|(r, _)| r == rel).expect("the caller's file").1;
        let found = sheet_names_guard_at_each_call(text, name, &calls);
        // The tracker walked every bump the line scan attributes to this
        // function, or it cannot vouch for them.
        let walked: Vec<usize> = found
            .iter()
            .filter(|(_, call, _)| STRUCTURE_BUMPS.iter().any(|b| b.trim_end_matches('(') == call))
            .map(|(line, _, _)| *line)
            .collect();
        let expected: Vec<usize> =
            sites.iter().filter(|(r, n, _)| r == rel && n == name).map(|(_, _, line)| *line).collect();
        assert_eq!(walked, expected, "the tracker did not walk every bump of `{rel}::{name}`");
        for (line, call, live) in found {
            if !live {
                outside.push(format!("  {rel}::{name} line {line}: {call}"));
            }
        }
        checked.push(format!("{rel}::{name}"));
    }
    // NON-VACUITY: every renumbering the crate has today is checked...
    for anchor in [
        "sheets.rs::append_user_sheet",
        "sheets.rs::delete_sheet_impl",
        "sheets.rs::move_sheet_impl",
        "sheets.rs::copy_sheet_impl",
        "sheets.rs::restore_partition_invariant",
        "persistence.rs::open_file",
        "persistence.rs::reset_document_scoped_stores",
    ] {
        assert!(
            checked.iter().any(|c| c == anchor),
            "the census no longer checks `{anchor}`. It checks:\n  {}",
            checked.join("\n  ")
        );
    }
    // ...and every function the renumbering census sees renumber bumps
    // ITSELF, where this census can see the call.
    let (_, renumberers) = renumberings_that_do_not_move_the_generation(&sources);
    for renumberer in &renumberers {
        assert!(
            checked.contains(renumberer),
            "`{renumberer}` renumbers the sheet list but makes no bump call this census can check"
        );
    }
    assert!(
        outside.is_empty(),
        "these renumberings move the sheet-structure generation, or re-key an index-keyed store, with NO \
         `sheet_names` guard held:\n{}\n\n`snapshot_is_current` waits on `sheet_names` to see a renumbering whole. \
         A bump or a re-key after the release lets a save, AutoRecover or publish snapshot read the rotated (or \
         the un-rotated) store against a generation that does not say so, and the file is written TORN (F5, \
         review round 8). Keep every re-key and the bump inside the hold.",
        outside.join("\n")
    );

    // NON-VACUITY ON THE REAL SHAPE: the real `move_sheet_impl` with its remap
    // moved below a tuple drop of the guard is caught.
    let sheets = &sources.iter().find(|(rel, _)| rel == "sheets.rs").expect("sheets.rs").1;
    let remap = "        remap_sheet_keyed_stores(&state, &effect, |i| Some(remap(i)));";
    assert_eq!(sheets.matches(remap).count(), 1, "fixture: `move_sheet_impl`'s remap call moved");
    let released_first = sheets.replace(
        remap,
        &format!("        drop((\n            current_grid,\n            grids,\n            sheet_names,\n        ));\n{remap}"),
    );
    let after_the_drop: Vec<(usize, String, bool)> = sheet_names_guard_at_each_call(&released_first, "move_sheet_impl", &calls)
        .into_iter()
        .filter(|(_, call, live)| call == "remap_sheet_keyed_stores" && !live)
        .collect();
    assert_eq!(
        after_the_drop.len(),
        1,
        "a remap after `drop((.., sheet_names, ..))` in the real `move_sheet_impl` read as held"
    );
}

/// The bump-hold tracker and its call-site finder on planted bodies: a bump
/// under a live guard is quiet -- across a one-line closure and an `} else {` at
/// the guard's own depth; one after `drop(name)`, after a MULTI-LINE tuple
/// drop naming the guard, after the guard's block closed, through a temporary,
/// or after a drop of the guard's `authorize` rebinding is caught, and so is a
/// re-key after the release; a tuple drop that does not name the guard, and the
/// rebinding itself, keep it held. The finder skips declarations, `#[cfg(test)]`
/// items and the remap's own bump.
#[test]
fn the_bump_hold_tracker_fires_on_the_shapes_it_exists_for() {
    let planted = r##"//! planted
pub fn held(state: &AppState) {
    let current_grid = state.grid.write(&effect).unwrap();
    let mut sheet_names = state.sheet_names.write(&effect).unwrap();
    let remap = |i: usize| -> Option<usize> { Some(i) };
    if sheet_names.is_empty() {
        return;
    } else {
        sheet_names.push(String::new());
    }
    {
        remap_sheet_keyed_stores(&state, &effect, remap);
    }
    drop((current_grid, sheet_names));
}

pub fn dropped_by_name(state: &AppState) {
    let mut sheet_names = state.sheet_names.write(&effect).unwrap();
    drop(sheet_names);
    remap_sheet_keyed_stores(&state, &effect, |i| Some(i));
}

pub fn dropped_in_a_tuple(state: &AppState) {
    let current_grid = state.grid.write(&effect).unwrap();
    let mut sheet_names = state.sheet_names.write(&effect).unwrap();
    let mut tab_colors = state.tab_colors.write(&effect).unwrap();
    drop((
        current_grid,
        sheet_names,
        tab_colors,
    ));
    remap_sheet_keyed_stores(&state, &effect, |i| Some(i));
}

pub fn a_tuple_that_keeps_it(state: &AppState) {
    let current_grid = state.grid.write(&effect).unwrap();
    let mut sheet_names = state.sheet_names.write(&effect).unwrap();
    let mut tab_colors = state.tab_colors.write(&effect).unwrap();
    drop((current_grid, tab_colors));
    remap_sheet_keyed_stores(&state, &effect, |i| Some(i));
}

pub fn block_closed(state: &AppState) {
    {
        let sheet_names = state.sheet_names.read().unwrap();
    }
    crate::persistence::note_sheet_structure_change(state);
}

pub fn temporary(state: &AppState) {
    *state.sheet_names.write(&effect).unwrap() = vec![];
    note_sheet_structure_change(state);
}

pub fn rebound(state: &AppState) {
    let pending_names = state.sheet_names.lock_pending().unwrap();
    let mut sheet_names = pending_names.authorize(&effect);
    remap_sheet_keyed_stores(&state, &effect, |i| Some(i));
    drop(sheet_names);
    note_sheet_structure_change(state);
}

pub fn rekeys_after_the_release(state: &AppState) {
    let mut sheet_names = state.sheet_names.write(&effect).unwrap();
    remap_sheet_keyed_stores(&state, &effect, |i| Some(i));
    drop(sheet_names);
    crate::object_deps::cascade_sheet_removed(&state, &slicers, &timelines, &filters, &effect, &|i| Some(i));
}
"##;
    let calls: Vec<&str> = STRUCTURE_BUMPS.iter().chain(INDEX_REKEYS.iter()).copied().collect();
    let live = |function: &str| -> Vec<bool> {
        sheet_names_guard_at_each_call(planted, function, &calls).into_iter().map(|(_, _, live)| live).collect()
    };
    assert_eq!(live("held"), [true], "a bump under a live guard read as unheld");
    assert_eq!(live("dropped_by_name"), [false], "a bump after `drop(sheet_names)` read as held");
    assert_eq!(live("dropped_in_a_tuple"), [false], "a bump after a multi-line `drop((.., sheet_names, ..))` read as held");
    assert_eq!(live("a_tuple_that_keeps_it"), [true], "a tuple drop that does not name the guard released it");
    assert_eq!(live("block_closed"), [false], "a guard that died with its block read as held");
    assert_eq!(live("temporary"), [false], "a temporary guard read as held past its statement");
    assert_eq!(live("rebound"), [true, false], "the `authorize` rebinding was not followed");
    assert_eq!(live("rekeys_after_the_release"), [true, false], "a re-key after the release read as held");

    let sources = vec![(
        "a.rs".to_string(),
        r##"//! planted
fn remap_sheet_keyed_stores(state: &AppState) {
    crate::persistence::note_sheet_structure_change(state);
}

#[cfg(test)]
pub(crate) fn remap_sheet_keyed_stores_for_test(state: &AppState) {
    remap_sheet_keyed_stores(state);
}

pub fn renumbers(state: &AppState) {
    let sheet_names = state.sheet_names.write(&effect).unwrap();
    remap_sheet_keyed_stores(state);
}
"##
        .to_string(),
    )];
    assert_eq!(
        structure_bump_call_sites(&sources),
        vec![("a.rs".to_string(), "renumbers".to_string(), 13)],
        "the call-site finder read a declaration, a test helper or the remap's own bump as a caller"
    );
}

// ===========================================================================
// BUG-0593: THE SLICER STORE, AGAINST THE GRID LOCKS AND THE CELL WRITERS
// ===========================================================================
//
// `SlicerState::slicers` is `Persisted<T>` -- a Mutex, so even a read is
// exclusive -- but it is not an `AppState` field, so no census here asked
// about it until the drill-through's transitive lock-graph walk did:
//
// ```text
// get_slicer_items_core (async, a worker thread):
//     slicers ... then grids, style_registry, tables, locale  (a TABLE slicer)
//                 or pivot_tables                            (a pivot slicer)
// update_cell_impl (main, or the MCP / AI chat / notebook thread):
//     grid, grids, sheet_names, .., pivot_tables, .. then (re-evaluating the
//     slicers' computed properties) computed_properties, slicers
// delete / move / copy sheet:
//     grid, grids, .. then slicers (`cascade_sheet_removed`)
// ```
//
// A table slicer's item fetch racing a cell edit or a sheet operation could
// leave each thread holding what the other waited for. The item fetch now
// COPIES the store and releases it before any other read.
//
// The audit of every other acquisition of the store found one more cycle, in
// the store's own pair: the save's (and the publish carrier's) slicer
// collector takes `slicers` then `computed_properties` in the save's TAIL,
// with no grid lock held, and the re-evaluation under `update_cell_impl` took
// them the other way round. The crate's order for the two is now `slicers`
// first, everywhere.
//
// Pinned like BUG-0590 / BUG-0591:
//   1. a census over every function in the crate, through one level of calls:
//      nothing holds the slicer store while it takes a store the cell writer
//      holds when it writes the slicers (gated by the grid locks, which every
//      such writer takes first);
//   2. the pair census for the store's own two locks;
//   3. each detector on the pre-fix shapes (flagged) and the fixed ones
//      (quiet);
//   4. two runtime probes -- the item fetch while a writer holds `grids`, the
//      re-evaluation while the save's collector holds `slicers` -- each with a
//      partner that drives the SAME harness with the pre-fix body and must see
//      the deadlock.

/// The function that writes the slicer store under the cell writer's whole
/// lock set: `update_cell_impl` calls it holding the grid locks and the rest.
const SLICER_RE_EVALUATION: &str = "re_evaluate_slicer_computed_properties";

/// Every store `update_cell_impl` holds when it reaches the slicer store,
/// READ out of `commands/data.rs` (never typed): what is alive at its call of
/// [`SLICER_RE_EVALUATION`], which the census reaches as "holding `grid`,
/// acquiring `slicers` inside the callee".
fn what_the_cell_writer_holds_at_the_slicers(graph: &CallGraph) -> Vec<String> {
    let data = std::fs::read_to_string(src_root().join("commands/data.rs")).expect("cannot read commands/data.rs");
    let at_the_call: Vec<HeldAcquisition> = held_while_acquiring("commands/data.rs", &data, &["grid"], &["slicers"], graph)
        .into_iter()
        .filter(|h| h.function == "update_cell_impl" && h.via.as_deref() == Some(SLICER_RE_EVALUATION))
        .collect();
    assert!(
        !at_the_call.is_empty(),
        "`update_cell_impl` no longer calls `{SLICER_RE_EVALUATION}` while it holds `grid` (or the census can no \
         longer see it do so) -- re-derive the lock set the slicer census enforces"
    );
    let mut held: Vec<String> = Vec::new();
    for hit in at_the_call {
        for store in hit.alive {
            if !held.contains(&store) {
                held.push(store);
            }
        }
    }
    held
}

/// The slicer census's question of one file: where a function holds the slicer
/// store while it acquires `grid`, `grids` or a store the cell writer holds at
/// the slicers (`writer_holds`) -- unless it ALSO holds `grid` or `grids`,
/// which that writer and every sheet operation take first, so it cannot be
/// overlapping one that is past them.
fn slicer_store_inversions(file: &str, text: &str, graph: &CallGraph, writer_holds: &[String]) -> Vec<HeldAcquisition> {
    let mut then: Vec<&str> = writer_holds.iter().map(String::as_str).collect();
    for store in ["grid", "grids"] {
        if !then.contains(&store) {
            then.push(store);
        }
    }
    let mut hits = held_while_acquiring(file, text, &["slicers"], &then, graph);
    hits.retain(|hit| !hit.alive.iter().any(|store| store == "grid" || store == "grids"));
    hits
}

/// BUG-0593, over every function in the crate: nothing holds the slicer store
/// while it waits for a grid lock or for a store the cell writer holds when it
/// writes the slicers.
///
/// SABOTAGE: in `get_slicer_items_core`, bind the store as a guard again
/// (`let slicers = slicer_state.slicers.read().unwrap();` in place of the
/// copy) -- this fails naming it, taking `grids` inside `get_table_column_values`.
#[test]
fn no_function_holds_the_slicer_store_while_acquiring_a_store_the_cell_writer_holds_first() {
    let sources = crate_sources();
    let graph = direct_acquisitions_by_function(&sources);
    // The premises, read from the code. The re-evaluation writes the store...
    let re_evaluation =
        graph.get(SLICER_RE_EVALUATION).unwrap_or_else(|| panic!("the call graph no longer knows `{SLICER_RE_EVALUATION}`"));
    assert!(
        re_evaluation.iter().any(|s| s == "slicers"),
        "`{SLICER_RE_EVALUATION}` no longer takes `slicers` -- re-derive this census: {re_evaluation:?}"
    );
    // ...the cell writer reaches it holding the grid locks and the stores the
    // item fetch reads...
    let writer_holds = what_the_cell_writer_holds_at_the_slicers(&graph);
    for store in ["grid", "grids", "style_registry", "locale", "pivot_tables"] {
        assert!(
            writer_holds.iter().any(|s| s == store),
            "`update_cell_impl` no longer holds `{store}` when it writes the slicers (or the census cannot see it): \
             {writer_holds:?}"
        );
    }
    // ...and a sheet operation reaches the store under the grid locks, through
    // the cascade: the direction this census enforces is the crate's.
    let sheets = std::fs::read_to_string(src_root().join("sheets.rs")).expect("cannot read sheets.rs");
    let cascades: Vec<HeldAcquisition> = held_while_acquiring("sheets.rs", &sheets, &["grid", "grids"], &["slicers"], &graph)
        .into_iter()
        .filter(|h| h.via.as_deref() == Some("cascade_sheet_removed"))
        .collect();
    assert!(
        !cascades.is_empty(),
        "no sheet operation reaches the slicer store through `cascade_sheet_removed` while it holds the grid locks \
         (or the census cannot see it) -- re-derive the direction this census enforces"
    );
    let mut offenders: Vec<String> = Vec::new();
    for (rel, text) in &sources {
        offenders.extend(slicer_store_inversions(rel, text, &graph, &writer_holds).iter().map(describe));
    }
    offenders.sort();
    offenders.dedup();
    assert!(
        offenders.is_empty(),
        "these functions hold the slicer store while they wait for a grid lock or for a store the cell writer \
         holds when it writes the slicers:\n{}\n\n`update_cell_impl` holds [{}] and then writes the slicers \
         (`{SLICER_RE_EVALUATION}`), off the main thread for the MCP server, the AI chat and the notebook; delete, \
         move and copy sheet reach the store under the grid locks through `cascade_sheet_removed`. Each function \
         above can interleave with them and each will hold what the other waits for: a window that never \
         answers, nothing in the log (BUG-0593). Copy what you need out of the slicer store and release it \
         first, or take the grid locks first.",
        offenders.join("\n"),
        writer_holds.join(", ")
    );
}

/// The slicer store's own pair: `slicers` before `computed_properties`,
/// everywhere (BUG-0593's audit). The save's slicer collector takes them in
/// that order in the save's tail, with no grid lock held, so a function that
/// holds the properties while it waits for the slicers can deadlock against a
/// save. `computed_properties` is also an `AppState` field; the census reads
/// the name, so it asks the question of both, which is the safe direction --
/// the cell writer takes that one late too.
///
/// SABOTAGE: take `computed_properties` before `slicers` again in
/// `re_evaluate_slicer_computed_properties` -- this fails naming it.
#[test]
fn no_function_holds_the_slicer_properties_while_acquiring_the_slicers() {
    let mut offenders: Vec<String> = Vec::new();
    let mut canonical: Vec<String> = Vec::new();
    for (rel, text) in &crate_sources() {
        for hit in pair_inversions(rel, text, "computed_properties", "slicers") {
            offenders.push(format!(
                "  {}::{} (line {}) holds `computed_properties` and then takes `slicers`",
                hit.file, hit.function, hit.line
            ));
        }
        for hit in pair_inversions(rel, text, "slicers", "computed_properties") {
            canonical.push(format!("{}::{}", hit.file, hit.function));
        }
    }
    offenders.sort();
    offenders.dedup();
    canonical.sort();
    canonical.dedup();
    assert!(
        offenders.is_empty(),
        "these functions hold `computed_properties` while they wait for `slicers`:\n{}\n\nThe save's and the \
         publish carrier's slicer collector (`collect_slicers_for_save`) takes `slicers` first and then the \
         properties, in the save's tail with no grid lock held, and `update_cell_impl` re-evaluates the slicers' \
         properties off the main thread for the MCP server, the AI chat and the notebook. Each function above can \
         interleave with a save and each will hold what the other waits for (BUG-0593). Take `slicers` first, or \
         release the properties before taking it.",
        offenders.join("\n")
    );
    // Non-vacuity: the order enforced is the save collector's, the census can
    // see it take it, and the re-evaluation now takes it too.
    for anchor in [
        "persistence.rs::collect_slicers_for_save",
        "slicer/computed.rs::re_evaluate_slicer_computed_properties",
    ] {
        assert!(
            canonical.iter().any(|f| f == anchor),
            "`{anchor}` no longer holds `slicers` while it takes `computed_properties` (or the census cannot see it) \
             -- re-derive the order this census enforces. It sees:\n  {}",
            canonical.join("\n  ")
        );
    }
}

/// Both slicer detectors, on the shapes BUG-0593 found and on the fixed ones.
#[test]
fn the_slicer_censuses_fire_on_the_shapes_that_deadlocked_and_stay_quiet_on_the_fixes() {
    let writer_holds: Vec<String> = ["grid", "grids", "sheet_names", "style_registry", "locale", "pivot_tables"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let graph: CallGraph = [
        ("get_table_column_values", vec!["grids", "style_registry", "tables", "locale"]),
        ("get_pivot_field_members", vec!["pivot_tables"]),
        ("evaluate_on_the_grids", vec!["grids"]),
    ]
    .into_iter()
    .map(|(name, stores)| (name.to_string(), stores.into_iter().map(str::to_string).collect()))
    .collect();

    let flagged: &[(&str, &str, &str)] = &[
        (
            "the table slicer's item fetch as it stood",
            r##"pub(crate) async fn get_slicer_items_core(state: &AppState, slicer_state: &SlicerState) -> Result<(), String> {
    let (slicer, values) = {
    let slicers = slicer_state.slicers.read().unwrap();
    let slicer = slicers.get(&slicer_id).ok_or_else(|| format!("Slicer {} not found", slicer_id))?;
    let values = get_table_column_values(state, slicer.cache_source_id, &slicer.field_name)?;
    (slicer.clone(), values)
    };
    Ok(())
}
"##,
            "grids",
        ),
        (
            "the pivot slicer's item fetch as it stood",
            r##"pub(crate) async fn get_slicer_items_core(state: &AppState, slicer_state: &SlicerState) -> Result<(), String> {
    let slicers = slicer_state.slicers.read().unwrap();
    let members = get_pivot_field_members(pivot_state, id, &field, &locale)?;
    Ok(())
}
"##,
            "pivot_tables",
        ),
    ];
    for (label, src, store) in flagged {
        let hits = slicer_store_inversions("planted.rs", src, &graph, &writer_holds);
        assert!(
            hits.iter().any(|h| h.acquiring == *store),
            "the slicer census missed `{store}` in `{label}`, so it cannot see the defect it exists for: {hits:?}"
        );
    }

    let quiet: &[(&str, &str)] = &[
        (
            "the item fetch as it is now: the store copied, then the reads",
            r##"pub(crate) async fn get_slicer_items_core(state: &AppState, slicer_state: &SlicerState) -> Result<(), String> {
    let slicers: HashMap<EntityId, Slicer> =
        slicer_state.slicers.read().map_err(|e| e.to_string())?.clone();
    let slicer = slicers.get(&slicer_id).ok_or_else(|| format!("Slicer {} not found", slicer_id))?;
    let values = get_table_column_values(state, slicer.cache_source_id, &slicer.field_name)?;
    let members = get_pivot_field_members(pivot_state, id, &field, &locale)?;
    Ok(())
}
"##,
        ),
        (
            "the gate: `add_slicer_computed_property` holds `grids` when it writes the store",
            r##"pub fn add_slicer_computed_property(state: State<AppState>, slicer_state: State<SlicerState>) -> Result<(), String> {
    let grids = state.grids.read().unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    let slicer_changed = {
        let mut slicers = slicer_state.slicers.write(&effect).unwrap();
        slicers.len()
    };
    Ok(())
}
"##,
        ),
        (
            "a scoped read released before the grid read",
            r##"fn sheet_of(state: &AppState, slicer_state: &SlicerState) -> usize {
    let sheet = {
        let slicers = slicer_state.slicers.read().unwrap();
        slicers.get(&id).map(|s| s.sheet_index).unwrap_or(0)
    };
    let grids = state.grids.read().unwrap();
    sheet
}
"##,
        ),
    ];
    for (label, src) in quiet {
        let hits = slicer_store_inversions("planted.rs", src, &graph, &writer_holds);
        assert!(hits.is_empty(), "the slicer census fired on `{label}`, which is CORRECT code: {hits:?}");
    }

    // The pair: the re-evaluation and the property update as they stood are
    // flagged; their fixed shapes are quiet and read as the crate's order.
    let re_evaluation_as_it_stood = r##"pub fn re_evaluate_slicer_computed_properties(slicer_state: &SlicerState, effect: &DocumentEffect) {
    let mut props = slicer_state.computed_properties.write(effect).unwrap();
    let mut slicers = slicer_state.slicers.write(effect).unwrap();
}
"##;
    assert_eq!(
        pair_inversions("planted.rs", re_evaluation_as_it_stood, "computed_properties", "slicers").len(),
        1,
        "the pair detector cannot see the re-evaluation as it stood"
    );
    let update_as_it_stood = r##"pub fn update_slicer_computed_property(slicer_state: State<SlicerState>) -> Result<(), String> {
    let (slicer_id, sheet_index) = {
        let props = slicer_state.computed_properties.read().unwrap();
        let slicer_id = find(&props)?;
        let slicers = slicer_state.slicers.read().unwrap();
        (slicer_id, slicers.len())
    };
    Ok(())
}
"##;
    assert_eq!(
        pair_inversions("planted.rs", update_as_it_stood, "computed_properties", "slicers").len(),
        1,
        "the pair detector cannot see the property update as it stood"
    );
    let re_evaluation_now = r##"pub fn re_evaluate_slicer_computed_properties(slicer_state: &SlicerState, effect: &DocumentEffect) {
    let mut slicers = slicer_state.slicers.write(effect).unwrap();
    let mut props = slicer_state.computed_properties.write(effect).unwrap();
}
"##;
    assert!(pair_inversions("planted.rs", re_evaluation_now, "computed_properties", "slicers").is_empty());
    assert_eq!(pair_inversions("planted.rs", re_evaluation_now, "slicers", "computed_properties").len(), 1);
    let update_now = r##"pub fn update_slicer_computed_property(slicer_state: State<SlicerState>) -> Result<(), String> {
    let (slicer_id, sheet_index) = {
        let props = slicer_state.computed_properties.read().unwrap();
        let found = find(&props);
        drop(props);
        let slicers = slicer_state.slicers.read().unwrap();
        (found, slicers.len())
    };
    Ok(())
}
"##;
    assert!(
        pair_inversions("planted.rs", update_now, "computed_properties", "slicers").is_empty(),
        "the pair detector fired on the property update as it is now, which releases the properties first"
    );
    // The store reached through an object-binding context is an acquisition the
    // pair census sees (the `slicers` receiver).
    let through_a_context = r##"fn write_slicer(ctx: &LiteralWriteCtx<'_>, slicer_state: &SlicerState) -> Result<(), String> {
    let props = slicer_state.computed_properties.read().unwrap();
    let current = {
        let slicers = ctx.slicers.slicers.read().map_err(|e| e.to_string())?;
        slicers.len()
    };
    Ok(())
}
"##;
    assert_eq!(
        pair_inversions("planted.rs", through_a_context, "computed_properties", "slicers").len(),
        1,
        "the census cannot see the slicer store taken through an object-binding context"
    );
}

/// Can another thread take the slicer store within `ms`? The
/// `probe_can_take_grids` pattern: a THREAD with a deadline, so a "no" is a
/// timeout the test reports rather than a hang the test joins.
fn probe_can_take_slicers(slicers: &Arc<SlicerState>, ms: u64) -> bool {
    let got = Arc::new(AtomicBool::new(false));
    {
        let slicers = Arc::clone(slicers);
        let got = Arc::clone(&got);
        std::thread::spawn(move || {
            let guard = slicers.slicers.read();
            got.store(guard.is_ok(), Ordering::SeqCst);
        });
    }
    wait_until(ms, || got.load(Ordering::SeqCst))
}

/// Can another thread take the slicers' computed properties within `ms`?
fn probe_can_take_slicer_properties(slicers: &Arc<SlicerState>, ms: u64) -> bool {
    let got = Arc::new(AtomicBool::new(false));
    {
        let slicers = Arc::clone(slicers);
        let got = Arc::clone(&got);
        std::thread::spawn(move || {
            let guard = slicers.computed_properties.read();
            got.store(guard.is_ok(), Ordering::SeqCst);
        });
    }
    wait_until(ms, || got.load(Ordering::SeqCst))
}

/// Run `site` on a thread of its own while the caller's `held` guard is alive,
/// then ask `probe` whether the store the defect would leave held can be
/// taken: `(parked, reachable, the site's result)`. `parked` is the
/// precondition -- a site that finished while `held` was alive never waited for
/// it, and then the probe measured nothing. `held` is released before the
/// caller asserts anything, so a failure never leaves the site parked for the
/// rest of the binary.
fn run_site_while_held<H, R, F, P>(held: H, site: F, probe: P) -> (bool, bool, R)
where
    R: Send + 'static,
    F: FnOnce() -> R + Send + 'static,
    P: FnOnce() -> bool,
{
    let started = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let handle = {
        let started = Arc::clone(&started);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            started.store(true, Ordering::SeqCst);
            let result = site();
            finished.store(true, Ordering::SeqCst);
            result
        })
    };
    let began = wait_until(2_000, || started.load(Ordering::SeqCst));
    // Long enough for the site to reach whatever it blocks on.
    std::thread::sleep(Duration::from_millis(250));
    let parked = began && !finished.load(Ordering::SeqCst);
    let reachable = probe();
    drop(held);
    let result = handle.join().expect("the site's thread panicked");
    (parked, reachable, result)
}

/// A slicer of `source_type` over `source_id`'s `field`, by its wire shape.
fn slicer_over(source_type: &str, source_id: identity::EntityId, field: &str) -> crate::slicer::types::Slicer {
    serde_json::from_value(serde_json::json!({
        "id": identity::EntityId::from_bytes(identity::generate_uuid_v7()).to_string(),
        "name": field,
        "sheetIndex": 0,
        "x": 0.0, "y": 0.0, "width": 180.0, "height": 240.0,
        "sourceType": source_type,
        "cacheSourceId": source_id.to_string(),
        "fieldName": field,
        "selectedItems": null,
        "showHeader": true,
        "columns": 1,
        "stylePreset": "SlicerStyleLight1",
        "connectedSources": [{ "sourceType": source_type, "sourceId": source_id.to_string() }]
    }))
    .expect("a slicer from its wire shape")
}

/// A workbook whose sheet 0 holds a TABLE (A1 "Region", A2:A5 East, West,
/// East, North) and a slicer store with one table slicer over its column.
fn workbook_with_a_table_slicer() -> (Arc<AppState>, Arc<SlicerState>, identity::EntityId) {
    let state = shared_state();
    let seed = test_seed_effect();
    {
        let mut grid = state.grid.write(&seed).unwrap();
        let mut grids = state.grids.write(&seed).unwrap();
        if grids.is_empty() {
            grids.push(engine::Grid::new());
        }
        for (row, text) in ["Region", "East", "West", "East", "North"].iter().enumerate() {
            grid.set_cell(row as u32, 0, engine::Cell::new_text(text.to_string()));
            grids[0].set_cell(row as u32, 0, engine::Cell::new_text(text.to_string()));
        }
    }
    let new_id = || identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let table = crate::tables::Table {
        id: new_id(),
        name: "Sales".to_string(),
        sheet_index: 0,
        start_row: 0,
        start_col: 0,
        end_row: 4,
        end_col: 0,
        columns: vec![crate::tables::TableColumn::new(new_id(), "Region".to_string())],
        style_options: Default::default(),
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };
    state.tables.write(&seed).unwrap().entry(0).or_default().insert(table.id, table.clone());
    let slicers = Arc::new(SlicerState::new());
    let slicer = slicer_over("table", table.id, "Region");
    let slicer_id = slicer.id;
    slicers.slicers.write(&seed).unwrap().insert(slicer_id, slicer);
    (state, slicers, slicer_id)
}

/// THE DEFECT AS A TEST THAT FAILS RATHER THAN HANGS. This thread plays the
/// cell writer: it holds `grids` (`update_cell_impl` holds `grid` and `grids`
/// and goes on to write the slicers). The table slicer's item fetch runs on
/// another thread and blocks on `grids` -- expected, and harmless. The QUESTION
/// is what it holds while it waits. Before the fix it held the slicer store,
/// so the writer's own slicer write could never complete.
#[test]
fn a_table_slicers_item_fetch_does_not_hold_the_slicers_while_it_waits_for_grids() {
    let (state, slicers, slicer_id) = workbook_with_a_table_slicer();
    let writer_holds_grids = state.grids.lock_pending().unwrap();
    let site = {
        let state = Arc::clone(&state);
        let slicers = Arc::clone(&slicers);
        move || {
            let pivots = PivotState::new();
            let filters = RibbonFilterState::new();
            let bi = crate::bi::types::BiState::new();
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(crate::slicer::commands::get_slicer_items_core(
                &state, &pivots, &slicers, &filters, &bi, slicer_id, None,
            ))
        }
    };
    let probe_slicers = Arc::clone(&slicers);
    let (parked, slicers_reachable, items) =
        run_site_while_held(writer_holds_grids, site, move || probe_can_take_slicers(&probe_slicers, 3_000));
    assert!(
        parked,
        "PRECONDITION FAILED: the item fetch finished while `grids` was held, so it never waited for it and this \
         test measured nothing"
    );
    assert!(
        slicers_reachable,
        "DEADLOCK: `get_slicer_items_core` holds the slicer store while it waits for `grids`. A cell writer holds \
         the grid locks and then writes the slicers (`update_cell_impl` re-evaluating their computed properties, \
         off the main thread for the MCP server, the AI chat and the notebook), and delete / move / copy sheet reach \
         the store under the grid locks too -- so a table slicer's item fetch overlapping either leaves each holding \
         what the other waits for (BUG-0593). Copy the store and release it before reading the grids."
    );
    // NON-VACUITY: the fetch reached the table read and answered as before.
    let items = items.expect("the item fetch");
    let listed: Vec<(&str, bool, bool)> = items.iter().map(|i| (i.key.as_str(), i.selected, i.has_data)).collect();
    assert_eq!(
        listed,
        vec![("East", true, true), ("North", true, true), ("West", true, true)],
        "the table slicer's items changed"
    );
}

/// A slicer store whose one slicer has a `headerText` property `=A1`, indexed
/// on sheet 0's A1, and sheet 0 with A1 = "Hello".
fn slicer_with_a_computed_header() -> (Arc<SlicerState>, identity::EntityId, Vec<engine::Grid>) {
    let seed = test_seed_effect();
    let slicers = Arc::new(SlicerState::new());
    let slicer = slicer_over("table", identity::EntityId::from_bytes(identity::generate_uuid_v7()), "Region");
    let slicer_id = slicer.id;
    let prop_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    slicers.slicers.write(&seed).unwrap().insert(slicer_id, slicer);
    slicers.computed_properties.write(&seed).unwrap().insert(
        slicer_id,
        vec![crate::slicer::computed::SlicerComputedProperty {
            id: prop_id,
            slicer_id,
            attribute: "headerText".to_string(),
            formula: "=A1".to_string(),
            cached_ast: Some(crate::convert_expr(&parser::parse("=A1").expect("=A1 parses"))),
            cached_value: None,
        }],
    );
    slicers
        .computed_prop_dependents
        .lock()
        .unwrap()
        .insert((0, 0, 0), std::collections::HashSet::from([prop_id]));
    let mut grid = engine::Grid::new();
    grid.set_cell(0, 0, engine::Cell::new_text("Hello".to_string()));
    (slicers, slicer_id, vec![grid])
}

/// The store's own pair at run time. This thread plays the save's slicer
/// collector, which holds `slicers` and goes on to read the computed
/// properties (`collect_slicers_for_save`, in the save's tail). The
/// re-evaluation `update_cell_impl` runs blocks on `slicers` -- expected. Before
/// the fix it was holding the properties while it waited, so the collector's
/// own read could never complete.
#[test]
fn re_evaluating_a_slicer_property_does_not_hold_the_properties_while_it_waits_for_the_slicers() {
    let (slicers, slicer_id, grids) = slicer_with_a_computed_header();
    let collector_holds_slicers = slicers.slicers.lock_pending().unwrap();
    let site = {
        let slicers = Arc::clone(&slicers);
        move || {
            let names = vec!["Sheet1".to_string()];
            let styles = engine::StyleRegistry::new();
            let none: std::collections::HashMap<u32, f64> = std::collections::HashMap::new();
            crate::slicer::computed::re_evaluate_slicer_computed_properties(
                &test_seed_effect(),
                &[(0, 0, 0)],
                &grids,
                &names,
                &none,
                &none,
                &styles,
                &slicers,
                None,
            )
        }
    };
    let probe_slicers = Arc::clone(&slicers);
    let (parked, properties_reachable, modified) = run_site_while_held(collector_holds_slicers, site, move || {
        probe_can_take_slicer_properties(&probe_slicers, 3_000)
    });
    assert!(
        parked,
        "PRECONDITION FAILED: the re-evaluation finished while `slicers` was held, so it never waited for it and \
         this test measured nothing"
    );
    assert!(
        properties_reachable,
        "DEADLOCK: `re_evaluate_slicer_computed_properties` holds the slicers' computed properties while it waits \
         for `slicers`. The save's slicer collector holds `slicers` and then reads the properties, in the save's tail \
         with no grid lock held, and the re-evaluation runs inside `update_cell_impl` -- off the main thread for the \
         MCP server, the AI chat and the notebook (BUG-0593). Take `slicers` first."
    );
    // NON-VACUITY: the re-evaluation reached the property and applied it.
    assert!(modified.contains(&slicer_id), "fixture: the re-evaluation did not change the slicer");
    assert_eq!(
        slicers.slicers.read().unwrap().get(&slicer_id).and_then(|s| s.header_text.clone()),
        Some("Hello".to_string()),
        "fixture: the header did not follow A1"
    );
}

/// NON-VACUITY for both probes above, through the SAME harness: the pre-fix
/// body must read as the store unreachable, the fixed body as reachable. A
/// harness that cannot tell them apart would pass both probes whatever the
/// item fetch and the re-evaluation did.
#[test]
fn the_slicer_probes_themselves_can_fail_the_way_the_defect_did() {
    // The item fetch: hold the store, then wait for `grids`.
    let (state, slicers, _) = workbook_with_a_table_slicer();
    let site = {
        let state = Arc::clone(&state);
        let slicers = Arc::clone(&slicers);
        move || {
            let _slicers = slicers.slicers.read().unwrap();
            let _grids = state.grids.read().unwrap();
        }
    };
    let probe_slicers = Arc::clone(&slicers);
    let held = state.grids.lock_pending().unwrap();
    let (parked, reachable, ()) = run_site_while_held(held, site, move || probe_can_take_slicers(&probe_slicers, 1_000));
    assert!(parked, "fixture: the planted pre-fix item fetch never waited for `grids`");
    assert!(
        !reachable,
        "the probe called the slicer store reachable while a thread held it and waited for `grids` -- it cannot \
         see the defect, so the item-fetch probe is vacuous"
    );
    let site = {
        let state = Arc::clone(&state);
        let slicers = Arc::clone(&slicers);
        move || {
            let _copy = slicers.slicers.read().unwrap().clone();
            let _grids = state.grids.read().unwrap();
        }
    };
    let probe_slicers = Arc::clone(&slicers);
    let held = state.grids.lock_pending().unwrap();
    let (parked, reachable, ()) = run_site_while_held(held, site, move || probe_can_take_slicers(&probe_slicers, 3_000));
    assert!(parked, "fixture: the planted fixed item fetch never waited for `grids`");
    assert!(reachable, "the probe called the slicer store unreachable while the only waiter held nothing");

    // The re-evaluation: hold the properties, then wait for `slicers`.
    let (slicers, _, _) = slicer_with_a_computed_header();
    let site = {
        let slicers = Arc::clone(&slicers);
        move || {
            let _props = slicers.computed_properties.read().unwrap();
            let _slicers = slicers.slicers.read().unwrap();
        }
    };
    let probe_slicers = Arc::clone(&slicers);
    let held = slicers.slicers.lock_pending().unwrap();
    let (parked, reachable, ()) =
        run_site_while_held(held, site, move || probe_can_take_slicer_properties(&probe_slicers, 1_000));
    assert!(parked, "fixture: the planted pre-fix re-evaluation never waited for `slicers`");
    assert!(
        !reachable,
        "the probe called the properties reachable while a thread held them and waited for `slicers` -- it cannot \
         see the defect, so the re-evaluation probe is vacuous"
    );
    let site = {
        let slicers = Arc::clone(&slicers);
        move || {
            let _slicers = slicers.slicers.read().unwrap();
            let _props = slicers.computed_properties.read().unwrap();
        }
    };
    let probe_slicers = Arc::clone(&slicers);
    let held = slicers.slicers.lock_pending().unwrap();
    let (parked, reachable, ()) =
        run_site_while_held(held, site, move || probe_can_take_slicer_properties(&probe_slicers, 3_000));
    assert!(parked, "fixture: the planted fixed re-evaluation never waited for `slicers`");
    assert!(reachable, "the probe called the properties unreachable while the only waiter held nothing");
}

/// The census's call graph knows the slicer paths this lane rests on, and
/// charges each with what its body takes.
#[test]
fn the_call_graph_knows_the_slicer_paths() {
    let graph = direct_acquisitions_by_function(&crate_sources());
    let get = |name: &str| graph.get(name).cloned().unwrap_or_else(|| panic!("the call graph no longer knows `{name}`"));
    assert!(get("get_table_column_values").iter().any(|s| s == "grids"));
    assert!(get("get_table_available_values").iter().any(|s| s == "grids"));
    assert_eq!(
        get(SLICER_RE_EVALUATION),
        vec!["computed_prop_dependents".to_string(), "slicers".to_string(), "computed_properties".to_string()],
        "the re-evaluation's own stores, in the order it takes them"
    );
    assert!(get("cascade_sheet_removed").iter().any(|s| s == "slicers"));
}

// ===========================================================================
// BUG-0592: THE NAME STORES AGAINST THE CELL WRITERS
// ===========================================================================
//
// Round 6's call-graph census reported two functions holding a name store
// across a store the cell writers hold first. Read against the code, neither
// was a cycle at run time -- but each was the writers' order inside out, and
// one of them was not atomic:
//
//   * `remove_duplicates` holds `grid` and `grids` across its dependency
//     rebuild, which no cell writer can be past. The census read it as holding
//     its name tables WITHOUT them, because one line of the function
//     (`let data_start_row = if has_headers { .. } else { .. };`) closes two
//     braces before it opens two, and the scanner applies closes first. The
//     rebuild still held `tables` / `table_names` / `named_ranges` while it
//     took the dependency maps -- which every writer takes BEFORE the name
//     stores -- so it now reads copies.
//   * `rename_named_range_impl` released the registry before its repoint (the
//     scanner cannot see `authorize` consume the pending guard), but the move
//     and the repoint were two critical sections: a reader that takes a grid
//     lock first -- the recalculation pass, a cell writer, the save's body --
//     could land between them and see the registry say the new name while
//     every formula still said the old one (`#NAME?`). It now takes `grid` and
//     `grids` FIRST and holds them across the move, the repoint and the undo
//     record.

/// The dependency maps `rebuild_all_dependencies_from_grid` takes.
const DEPENDENCY_MAPS: [&str; 12] = [
    "dependents",
    "dependencies",
    "column_dependents",
    "column_dependencies",
    "row_dependents",
    "row_dependencies",
    "name_dependents",
    "name_dependencies",
    "table_dependents",
    "table_dependencies",
    "cross_sheet_dependents",
    "cross_sheet_dependencies",
];

/// BUG-0592: `remove_duplicates` holds no name store while its rebuild takes
/// the dependency maps -- the rebuild reads copies. The cell writers take the
/// maps BEFORE the name stores, so holding a name store across them is their
/// order inside out; what keeps that from closing a cycle is a grid lock held
/// around it (every writer takes `grid` first), and the crate-wide rule is
/// exactly that, GATED on the grid locks:
/// `no_function_holds_a_name_store_across_the_dependency_maps_without_a_grid_lock`.
/// This pin is the stricter one for this function alone: its copies are safe
/// whether or not the grid hold around them survives a later edit.
///
/// SABOTAGE: take the `.clone()` off one of the three copies -- this fails.
#[test]
fn remove_duplicates_holds_no_name_store_across_the_dependency_rebuild() {
    let sources = crate_sources();
    let graph = direct_acquisitions_by_function(&sources);
    let rebuild = graph
        .get("rebuild_all_dependencies_from_grid")
        .expect("the call graph no longer knows `rebuild_all_dependencies_from_grid`");
    for map in DEPENDENCY_MAPS {
        assert!(rebuild.iter().any(|s| s == map), "the rebuild no longer takes `{map}`: {rebuild:?}");
    }
    let data = std::fs::read_to_string(src_root().join("commands/data.rs")).expect("cannot read commands/data.rs");
    // NON-VACUITY: `remove_duplicates` still calls the rebuild, so the question
    // below is asked of a call that exists.
    let body: String = function_body(&blank_literals(&data), "pub fn remove_duplicates(")
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        body.contains("rebuild_all_dependencies_from_grid("),
        "`remove_duplicates` no longer calls `rebuild_all_dependencies_from_grid` -- re-derive this pin"
    );
    let held: Vec<String> = held_while_acquiring(
        "commands/data.rs",
        &data,
        &["tables", "table_names", "named_ranges"],
        &DEPENDENCY_MAPS,
        &graph,
    )
    .into_iter()
    .filter(|h| h.function == "remove_duplicates")
    .map(|h| describe(&h))
    .collect();
    assert!(
        held.is_empty(),
        "`remove_duplicates` holds a name store while its rebuild takes the dependency maps:\n{}\n\nEvery cell writer \
         takes the dependency maps BEFORE `tables` / `table_names` / `named_ranges` (BUG-0592). Read copies of the \
         name tables for the rebuild.",
        held.join("\n")
    );
}

/// BUG-0592: the rename takes the registry and the undo stack while it holds
/// BOTH grid locks -- the crate's order, and one critical section.
///
/// SABOTAGE: see `a_name_rename_moves_the_registry_and_the_formulas_in_one_critical_section`.
#[test]
fn the_name_rename_takes_the_registry_and_the_undo_stack_under_both_grid_locks() {
    let sources = crate_sources();
    let graph = direct_acquisitions_by_function(&sources);
    assert_eq!(
        graph.get("record_rename_undo").cloned(),
        Some(vec!["undo_stack".to_string()]),
        "the rename's undo record no longer takes only the undo stack"
    );
    assert!(
        !graph.contains_key("rename_name_in_grids"),
        "`rename_name_in_grids` takes a lock of its own again -- it walks the grids the rename already holds"
    );
    let text = std::fs::read_to_string(src_root().join("named_ranges.rs")).expect("cannot read named_ranges.rs");
    let hits: Vec<HeldAcquisition> =
        held_while_acquiring("named_ranges.rs", &text, &["grid"], &["grids", "named_ranges", "undo_stack"], &graph)
            .into_iter()
            .filter(|h| h.function == "rename_named_range_impl")
            .collect();
    for store in ["grids", "named_ranges", "undo_stack"] {
        assert!(
            hits.iter().any(|h| h.acquiring == store && h.alive.iter().any(|s| s == "grid")),
            "`rename_named_range_impl` no longer takes `{store}` while it holds `grid`: {hits:?}"
        );
    }
    for store in ["named_ranges", "undo_stack"] {
        assert!(
            hits.iter().any(|h| h.acquiring == store && h.alive.iter().any(|s| s == "grids")),
            "`rename_named_range_impl` no longer takes `{store}` while it holds `grids`: {hits:?}"
        );
    }
}

/// A workbook with the workbook-scoped name `Rate` (`=Sheet1!$A$1`, A1 = 2)
/// and `=Rate*2` in B1, on the active sheet.
fn workbook_with_a_name_and_its_reader() -> Arc<AppState> {
    let state = Arc::new(crate::create_app_state());
    let seed = test_seed_effect();
    state.named_ranges.write(&seed).unwrap().insert(
        "RATE".to_string(),
        crate::named_ranges::NamedRange {
            name: "Rate".to_string(),
            sheet_index: None,
            refers_to: "=Sheet1!$A$1".to_string(),
            comment: None,
            folder: None,
        },
    );
    let reader = engine::Cell::new_formula_with_ast(parser::parse("=Rate*2").expect("=Rate*2 parses"));
    {
        let mut grid = state.grid.write(&seed).unwrap();
        let mut grids = state.grids.write(&seed).unwrap();
        if grids.is_empty() {
            grids.push(engine::Grid::new());
        }
        grid.set_cell(0, 0, engine::Cell::new_number(2.0));
        grids[0].set_cell(0, 0, engine::Cell::new_number(2.0));
        grid.set_cell(0, 1, reader.clone());
        grids[0].set_cell(0, 1, reader);
    }
    state
}

/// The registry's keys, read on a thread of their own with a deadline.
fn name_keys_within(state: &Arc<AppState>, ms: u64) -> Option<Vec<String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    {
        let state = Arc::clone(state);
        std::thread::spawn(move || {
            if let Ok(names) = state.named_ranges.read() {
                let mut keys: Vec<String> = names.keys().cloned().collect();
                keys.sort();
                let _ = tx.send(keys);
            }
        });
    }
    rx.recv_timeout(Duration::from_millis(ms)).ok()
}

/// THE TORN RENAME AS A TEST. This thread plays a cell writer (or the
/// recalculation pass) mid-step: it holds `grid`. The rename runs on another
/// thread and waits for it. The QUESTION is what the workbook says while it
/// waits. Before the fix the rename had already moved the registry -- it took
/// the grid locks only for the repoint -- so the registry said `Tax` while B1
/// still said `=Rate*2`, which resolves to nothing (`#NAME?`), and the writer
/// holding `grid` was free to compute and store exactly that.
#[test]
fn a_name_rename_moves_the_registry_and_the_formulas_in_one_critical_section() {
    let state = workbook_with_a_name_and_its_reader();
    let file = Arc::new(crate::persistence::FileState::default());
    let writer_holds_grid = state.grid.lock_pending().unwrap();
    let site = {
        let state = Arc::clone(&state);
        let file = Arc::clone(&file);
        move || crate::named_ranges::rename_named_range_impl(&state, &file, "Rate", "Tax")
    };
    let probe_state = Arc::clone(&state);
    let seen: std::sync::Mutex<Option<Vec<String>>> = std::sync::Mutex::new(None);
    let (parked, reached, result) = run_site_while_held(writer_holds_grid, site, || {
        let keys = name_keys_within(&probe_state, 3_000);
        let reached = keys.is_some();
        *seen.lock().unwrap() = keys;
        reached
    });
    let keys = seen.into_inner().unwrap();
    assert!(
        parked,
        "PRECONDITION FAILED: the rename finished while `grid` was held, so it never waited for it and this test \
         measured nothing"
    );
    assert!(reached, "the registry could not be read while the rename waited for `grid` -- it is holding it");
    assert_eq!(
        keys,
        Some(vec!["RATE".to_string()]),
        "TORN RENAME: while the rename waited for the grid lock, the registry already said the NEW name and every \
         formula still read the OLD one -- a writer or the recalculation pass holding `grid` at that moment computes \
         `#NAME?` for each reader (BUG-0592). Take `grid` and `grids` first and hold them across the registry move, \
         the repoint and the undo record."
    );
    // NON-VACUITY: once the lock was free the rename did all of it.
    assert!(result.success, "the rename failed: {:?}", result.error);
    assert_eq!(name_keys_within(&state, 3_000), Some(vec!["TAX".to_string()]), "the registry did not move");
    let b1 = state.grid.read().unwrap().get_cell(0, 1).cloned().and_then(|c| c.formula_string()).unwrap_or_default();
    assert!(b1.to_uppercase().contains("TAX") && !b1.to_uppercase().contains("RATE"), "B1 was not repointed: {b1}");
}

/// THE NAME WRITERS AGAINST THE RENAME (BUG-0592 follow-up). `create_named_range_impl`,
/// `update_named_range_core` and `delete_named_range_core` took `named_ranges`
/// and NO grid lock -- the MCP tools and the script host reach them off the
/// main thread -- so the rename's grid hold did not order them (they take
/// `grid` first since rev3B#6, and `grids` after it since rev5C#1; the tests
/// below pin their side). This thread
/// holds the undo stack, so the rename parks exactly where it records its step.
/// Before the fix it had already released the registry at the move, so a name
/// writer could define the freed old name right then and record its "Define
/// name" BELOW the rename's step (or inside it, between its separate undo-stack
/// locks): undoing the rename then overwrote that definition, and the next
/// Ctrl+Z deleted the user's original name. The probe is a reader of the
/// registry with a deadline -- a writer would get exactly as far.
///
/// SABOTAGE: release the registry guard before the repoint again
/// (`drop(named_ranges)` right after the move) -- the probe reads the registry
/// while the rename waits.
#[test]
fn a_name_rename_holds_the_registry_until_its_undo_step_is_recorded() {
    let state = workbook_with_a_name_and_its_reader();
    let file = Arc::new(crate::persistence::FileState::default());
    let undo_held = state.undo_stack.lock().unwrap();
    let site = {
        let state = Arc::clone(&state);
        let file = Arc::clone(&file);
        move || crate::named_ranges::rename_named_range_impl(&state, &file, "Rate", "Tax")
    };
    let probe_state = Arc::clone(&state);
    let seen: std::sync::Mutex<Option<Vec<String>>> = std::sync::Mutex::new(None);
    let (parked, reached, result) = run_site_while_held(undo_held, site, || {
        let keys = name_keys_within(&probe_state, 400);
        let reached = keys.is_some();
        *seen.lock().unwrap() = keys;
        reached
    });
    assert!(
        parked,
        "PRECONDITION FAILED: the rename finished while the undo stack was held, so it never waited for it and \
         this test measured nothing"
    );
    assert!(
        !reached,
        "INTERLEAVED NAME WRITER: while the rename waited to record its undo step, the registry was free and \
         already said {:?}. A name writer (no grid lock) could define the freed old name here and land its undo \
         step below or inside \"Rename name\". Hold the registry guard until `record_rename_undo` returns.",
        seen.lock().unwrap()
    );
    // NON-VACUITY: once the stack was free the rename did all of it, as ONE step.
    assert!(result.success, "the rename failed: {:?}", result.error);
    assert_eq!(name_keys_within(&state, 3_000), Some(vec!["TAX".to_string()]), "the registry did not move");
    let undo = state.undo_stack.lock().unwrap();
    assert_eq!(undo.undo_depth(), 1, "the rename is one undo step");
    assert_eq!(undo.undo_description(), Some("Rename name"));
}

/// Whether another thread could take `grids` within `ms` -- the lock every
/// sheet mover (`move_sheet_impl`, `delete_sheet_impl`, `set_active_sheet`)
/// takes right after `grid`.
fn grids_free_within(state: &Arc<AppState>, ms: u64) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    {
        let state = Arc::clone(state);
        std::thread::spawn(move || {
            if state.grids.read().is_ok() {
                let _ = tx.send(());
            }
        });
    }
    rx.recv_timeout(Duration::from_millis(ms)).is_ok()
}

/// THE GRIDS-WITH-IDS PAIRING, AS A TEST (BUG-0592 follow-up). Two of the nine
/// torn-read sites paired `grids[i]` -- read and RELEASED first -- with
/// `sheet_ids[i]` read in a later hold: `workbook_sheet_facts` (the private-
/// sheet rule judges sheet i blank or not by `grids[i]` and names it by
/// `ids[i]`) and the notebook's phase-1 read (`read_cell_run_inputs`: a
/// checkpoint stamps `grids[i]` with `sheet_ids[i]`, and Rewind installs each
/// snapshot by that stamp). This thread holds `sheet_names`, so each reader
/// parks on its names-and-ids read. The question is whether a sheet mover could
/// take `grids` at that moment: if it can, it can permute the sheets between
/// the reader's grids and its ids. Before the fix both readers had already
/// released `grids`.
///
/// SABOTAGE: read the grids in their own statement again in either function
/// (clone and release before `sheet_ids_and_names`) -- its test fails.
fn assert_grids_and_ids_are_read_in_one_hold(label: &str, read: fn(&AppState) -> Result<usize, String>) {
    let state = Arc::new(crate::create_app_state());
    let names_held = state.sheet_names.lock_pending().unwrap();
    let site = {
        let state = Arc::clone(&state);
        move || read(&*state)
    };
    let probe_state = Arc::clone(&state);
    let (parked, grids_were_free, result) =
        run_site_while_held(names_held, site, || grids_free_within(&probe_state, 400));
    assert!(
        parked,
        "PRECONDITION FAILED: `{label}` finished while `sheet_names` was held, so it never waited for the \
         names and this test measured nothing"
    );
    assert!(
        !grids_were_free,
        "TORN PAIR: while `{label}` waited for the sheet names and ids, `grids` was free -- a `move_sheet` could \
         permute the sheets between the grids it read and the ids it pairs them with by index. Read the names \
         and ids while the `grids` guard is held (canonical order: grid, grids, then everything else)."
    );
    // NON-VACUITY: once the names were free the reader did its read.
    assert_eq!(result, Ok(1), "`{label}` did not read the one-sheet workbook");
}

#[test]
fn the_code_gate_reads_the_grids_and_the_sheet_ids_in_one_hold() {
    assert_grids_and_ids_are_read_in_one_hold("application_code_gate::workbook_sheet_facts", |state| {
        crate::scripting::application_code_gate::workbook_sheet_facts(state).map(|facts| facts.len())
    });
}

#[test]
fn the_notebook_reads_the_grids_and_the_sheet_ids_in_one_hold() {
    assert_grids_and_ids_are_read_in_one_hold("notebook_commands::read_cell_run_inputs", |state| {
        crate::scripting::notebook_commands::read_cell_run_inputs(state).map(|inputs| inputs.sheet_ids.len())
    });
}

/// revB#4: Remove Duplicates dirties the document ONLY once rows really go.
/// `DocumentEffect::mutates` dirties at construction and the command minted it
/// right after the protection gate, ahead of four exits that change nothing
/// (no key column, a range cutting a merged block, a header-only range, no
/// duplicates found), so each of them left the title-bar asterisk and the
/// close-without-saving prompt behind ([LIVE] Excel 16: `RemoveDuplicates` on a
/// range with no duplicates leaves `Workbook.Saved` True). The command takes
/// `State<..>` and cannot run in-process, so this reads its body: the effect
/// comes after every `return`, and the gates read through PENDING grid guards
/// -- never a read, a drop and a later write (the TOCTOU `lock_pending` exists
/// to rule out).
///
/// SABOTAGE: mint a `DocumentEffect::mutates` right after the protection gate
/// again -- this fails naming the exits after it.
#[test]
fn remove_duplicates_dirties_the_document_only_once_rows_really_go() {
    let data = std::fs::read_to_string(src_root().join("commands/data.rs")).expect("cannot read commands/data.rs");
    let body: String = function_body(&blank_literals(&data), "pub fn remove_duplicates(")
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    let effect_at = body
        .find("DocumentEffect::mutates(")
        .expect("`remove_duplicates` no longer mints a `DocumentEffect::mutates` -- re-derive this pin");
    let (before, after) = body.split_at(effect_at);
    let exits_after: Vec<&str> = after.lines().filter(|l| l.contains("return ")).collect();
    assert!(
        exits_after.is_empty(),
        "`remove_duplicates` can still return after it has dirtied the document:\n{}\n\nEvery exit after \
         `DocumentEffect::mutates` leaves the workbook marked modified for a command that changed nothing. Mint \
         the effect once duplicates are really removed.",
        exits_after.join("\n")
    );
    // NON-VACUITY: the protection refusal and the four no-change exits are all
    // still there, ahead of the effect.
    let exits_before = before.matches("return RemoveDuplicatesResult").count();
    assert!(
        exits_before >= 5,
        "only {exits_before} early exit(s) precede the effect in `remove_duplicates` -- expected the protection \
         refusal and the four no-change exits; re-derive this pin"
    );
    for lock in ["state.grid.lock_pending()", "state.grids.lock_pending()"] {
        assert!(
            before.contains(lock),
            "`remove_duplicates` no longer takes `{lock}` before its gates -- a gate read through a guard that is \
             dropped and re-taken for the write is a TOCTOU window"
        );
    }
    assert!(
        !before.contains(".write(&"),
        "`remove_duplicates` writes a store before it has decided the dirty flag"
    );
}

/// rev3B#8: Remove Duplicates gates sheet protection over the guards it HOLDS.
/// The gate used to run first, through `check_sheet_protection_range`, which
/// takes and RELEASES its own grid, style and protection locks -- and only then
/// were the grid locks taken pending for the write. A `protect_sheet` (it takes
/// `sheet_protection` alone) or a cell-lock change landing between the two let
/// the command compact rows on a sheet that had just become protected: the
/// read-drop-write window `lock_pending` exists to rule out. The command takes
/// `State<..>`, so this reads its body: the gate is the borrowed form over the
/// PENDING grid, after both `lock_pending` calls, and the protection guard it
/// judged is held until the rows are written.
///
/// SABOTAGE: put the self-locking `check_sheet_protection_range` call back at
/// the top of `remove_duplicates` -- this fails naming it.
#[test]
fn remove_duplicates_gates_protection_over_the_guards_it_holds() {
    let data = std::fs::read_to_string(src_root().join("commands/data.rs")).expect("cannot read commands/data.rs");
    let body: String = function_body(&blank_literals(&data), "pub fn remove_duplicates(")
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !body.contains("check_sheet_protection_range("),
        "`remove_duplicates` gates protection through `check_sheet_protection_range`, which takes and RELEASES its \
         own grid and protection locks before the command takes them for the write -- a protection change can land \
         in between. Gate over the held guards (`check_sheet_protection_range_in`)."
    );
    let gate_at = body
        .find("check_sheet_protection_range_in(")
        .expect("`remove_duplicates` has no held-guard protection gate -- re-derive this pin");
    for lock in ["state.grid.lock_pending()", "state.grids.lock_pending()", "state.sheet_protection.read()"] {
        let at = body.find(lock).unwrap_or_else(|| panic!("`remove_duplicates` no longer takes `{lock}`"));
        assert!(at < gate_at, "`remove_duplicates` gates protection BEFORE it takes `{lock}`: the gate reads state it does not hold");
    }
    let released_at = body
        .find("drop(protection_storage)")
        .expect("`remove_duplicates` no longer releases the protection guard by name -- re-derive this pin");
    let written_at = body.find("commit_owned(").expect("`remove_duplicates` no longer commits its undo step");
    assert!(
        released_at > written_at,
        "`remove_duplicates` releases the protection guard before the rows are written -- a protection change can \
         land between the gate and the write"
    );
}

fn define_fee(state: &AppState, file: &crate::persistence::FileState) -> crate::named_ranges::NamedRangeResult {
    crate::named_ranges::create_named_range_impl(state, file, "Fee".to_string(), None, "=Sheet1!$A$1".to_string(), None, None)
}

fn redefine_rate(state: &AppState, file: &crate::persistence::FileState) -> crate::named_ranges::NamedRangeResult {
    crate::named_ranges::update_named_range_core(
        state,
        file,
        &crate::persistence::UserFilesState::default(),
        &PivotState::new(),
        &crate::pane_control::PaneControlState::new(),
        &RibbonFilterState::new(),
        "Rate".to_string(),
        None,
        "=Sheet1!$A$2".to_string(),
        None,
        None,
    )
}

fn delete_rate(state: &AppState, file: &crate::persistence::FileState) -> crate::named_ranges::NamedRangeResult {
    crate::named_ranges::delete_named_range_core(
        state,
        file,
        &crate::persistence::UserFilesState::default(),
        &PivotState::new(),
        &crate::pane_control::PaneControlState::new(),
        &RibbonFilterState::new(),
        "Rate".to_string(),
    )
}

/// rev3B#6 (BUG-0592 follow-up), the MIRROR of the rename test above. The three
/// NAME WRITERS -- `create_named_range_impl`, `update_named_range_core`,
/// `delete_named_range_core`, which the MCP tools and the script host reach off
/// the main thread -- changed the registry, RELEASED it, and only then recorded
/// their undo step. A rename (which holds the registry through its own record)
/// could run in that gap and land "Rename name" between the writer's change
/// and its step: an "Edit name" of RATE recorded above a "Rename name" that had
/// already moved RATE to TAX, so Ctrl+Z re-created RATE beside TAX and the edit
/// itself was never undone. This thread holds the undo stack, so each writer
/// parks exactly where it records its step; the probe is a reader of the
/// registry with a deadline -- a rename would get exactly as far. Each writer
/// now holds `grid`, `grids` and the registry through its record (both grid
/// locks first are what keep the registry-then-undo-stack order from closing a
/// cycle with a cell writer, which holds the undo stack while it reads
/// `named_ranges` -- `grid` alone missed `update_cell_on_sheets_as`, which
/// holds `grids` without it: rev5C#1, pinned by
/// `the_name_writers_hold_both_grid_locks_while_they_record_their_undo_steps`).
///
/// SABOTAGE: release the registry before the undo record again in any one of
/// the writers -- its row fails.
#[test]
fn the_name_writers_hold_the_registry_until_their_undo_steps_are_recorded() {
    type NameWriter = fn(&AppState, &crate::persistence::FileState) -> crate::named_ranges::NamedRangeResult;
    let writers: [(&str, NameWriter); 3] = [
        ("create_named_range_impl", define_fee),
        ("update_named_range_core", redefine_rate),
        ("delete_named_range_core", delete_rate),
    ];
    // Every writer is measured before anything is asserted about the
    // interleaving, so a failure names EACH writer that releases early.
    let mut interleaved = Vec::new();
    for (label, write) in writers {
        let state = workbook_with_a_name_and_its_reader();
        let file = Arc::new(crate::persistence::FileState::default());
        let undo_held = state.undo_stack.lock().unwrap();
        let site = {
            let state = Arc::clone(&state);
            let file = Arc::clone(&file);
            move || write(&state, &file)
        };
        let probe_state = Arc::clone(&state);
        let seen: std::sync::Mutex<Option<Vec<String>>> = std::sync::Mutex::new(None);
        let (parked, reached, result) = run_site_while_held(undo_held, site, || {
            let keys = name_keys_within(&probe_state, 400);
            let reached = keys.is_some();
            *seen.lock().unwrap() = keys;
            reached
        });
        assert!(
            parked,
            "PRECONDITION FAILED: `{label}` finished while the undo stack was held, so it never waited for it and \
             this test measured nothing"
        );
        if reached {
            interleaved.push(format!("`{label}` (the registry already said {:?})", seen.lock().unwrap()));
        }
        // NON-VACUITY: once the stack was free the writer did all of it, as ONE step.
        assert!(result.success, "`{label}` failed: {:?}", result.error);
        assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), 1, "`{label}` is one undo step");
    }
    assert!(
        interleaved.is_empty(),
        "INTERLEAVED RENAME: while these writers waited to record their undo step, the registry was free -- a \
         rename could move the name there and land \"Rename name\" between the change and its own step. Hold \
         `grid` and the registry until the undo record returns:\n{}",
        interleaved.join("\n")
    );
}

/// The MOVE's name relocation (a cut-paste of a named cell) is a name writer
/// too, and records a WHOLE-registry snapshot: if it released the registry
/// before taking the undo stack (round-9 review rev8B), a rename or delete
/// could run whole in between, and undoing the move would then undo that
/// writer's registry change as well while its formulas kept the new name. So
/// while it waits for the stack, the registry must be held.
#[test]
fn the_move_s_name_relocation_holds_the_registry_until_its_undo_step_is_recorded() {
    let state = workbook_with_a_name_and_its_reader();
    let undo_held = state.undo_stack.lock().unwrap();
    let site = {
        let state = Arc::clone(&state);
        move || {
            let names = vec!["Sheet1".to_string()];
            let mv = crate::commands::structure::CellMove {
                source_sheet: "Sheet1",
                dest_sheet: "Sheet1",
                block: (0, 0, 0, 0),
                delta_row: 4,
                delta_col: 0,
            };
            crate::commands::structure::relocate_named_ranges(&state, &test_seed_effect(), &names, &mv)
        }
    };
    let probe_state = Arc::clone(&state);
    let (parked, reached, changed) = run_site_while_held(undo_held, site, || name_keys_within(&probe_state, 400).is_some());
    assert!(
        parked,
        "PRECONDITION FAILED: the relocation finished while the undo stack was held, so it never waited for it \
         and this test measured nothing"
    );
    assert_eq!(changed, vec!["Rate".to_string()], "the name on A1 follows the move");
    assert_eq!(state.named_ranges.read().unwrap()["RATE"].refers_to, "=Sheet1!$A$5");
    assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), 1, "one step for the names");
    assert!(
        !reached,
        "INTERLEAVED NAME WRITE: while the move's name relocation waited to record its step, the registry was \
         free -- a rename could land between the change and its whole-registry snapshot"
    );
}

/// The whole-list object-script snapshot (`obj_object_scripts`) put back every
/// script as the step found it, and a script SAVE records no undo -- so undoing
/// a name rename or delete, a table delete or a Convert to Range after the user
/// had edited or created another script reverted the edit or deleted the new
/// script. Every step that prunes or re-binds scripts now records only those,
/// by id (`OBJECT_SCRIPTS_BY_ID_RESTORE_KIND`). `delete_table` and
/// `convert_to_range` take `State<..>` and cannot run in-process (the names'
/// routes are pinned by runtime tests in `named_ranges::rename_tests`), so this
/// reads the crate: no step records the whole list any more.
///
/// SABOTAGE: record `object_scripts_snapshot_bytes` in `delete_table` again --
/// this fails naming `tables.rs`.
#[test]
fn no_step_records_a_whole_list_object_script_snapshot() {
    let mut offenders = Vec::new();
    let mut by_id: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for (rel, text) in crate_sources() {
        if rel == "undo_commands.rs" {
            continue;
        }
        for (n, line) in strip_cfg_test_items(&text).lines().enumerate() {
            let code = line.split("//").next().unwrap_or("");
            if code.contains("object_scripts_snapshot_bytes(") || code.contains("\"obj_object_scripts\"") {
                offenders.push(format!("{rel}:{}: {}", n + 1, code.trim()));
            }
            if code.contains("object_scripts_pruned_bytes(") || code.contains("object_scripts_rebound_bytes(") {
                *by_id.entry(rel.clone()).or_default() += 1;
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "a step still records the WHOLE object-script list -- undoing it reverts every script edit made after it \
         (a script save records no undo). Record what the step pruned or re-bound, by id \
         (`object_scripts_pruned_bytes` / `object_scripts_rebound_bytes`):\n{}",
        offenders.join("\n")
    );
    // NON-VACUITY: the four recorders this replaced are seen.
    for (file, at_least) in [("named_ranges.rs", 2), ("tables.rs", 2)] {
        assert!(
            by_id.get(file).copied().unwrap_or(0) >= at_least,
            "expected {at_least} by-id script records in {file}, saw {:?} -- re-derive this census",
            by_id
        );
    }
}

/// The three name stores the dependency rebuild expands formulas against.
const NAME_STORES: [&str; 3] = ["tables", "table_names", "named_ranges"];

/// Every place in `text` where a function holds a name store while it acquires
/// a dependency map -- in its body or through one call
/// (`rebuild_all_dependencies_from_grid` is the shape) -- WITHOUT `grid` or
/// `grids` held. Those are the ungated holds; a grid-gated one is returned by
/// [`gated_name_store_holds`].
fn ungated_name_store_holds(file: &str, text: &str, graph: &CallGraph) -> Vec<HeldAcquisition> {
    held_while_acquiring(file, text, &NAME_STORES, &DEPENDENCY_MAPS, graph)
        .into_iter()
        .filter(|hit| !hit.alive.iter().any(|store| store == "grid" || store == "grids"))
        .collect()
}

/// The grid-gated counterpart of [`ungated_name_store_holds`], for the census's
/// non-vacuity half.
fn gated_name_store_holds(file: &str, text: &str, graph: &CallGraph) -> Vec<HeldAcquisition> {
    held_while_acquiring(file, text, &NAME_STORES, &DEPENDENCY_MAPS, graph)
        .into_iter()
        .filter(|hit| hit.alive.iter().any(|store| store == "grid" || store == "grids"))
        .collect()
}

/// revB#5 / BUG-0592, over the WHOLE crate: a function holds a name store
/// across a dependency-map acquisition only while it also holds `grid` or
/// `grids`. Every cell writer takes the dependency maps BEFORE the name stores,
/// so such a hold is the writers' order inside out; the grid lock, which every
/// writer takes FIRST, is what keeps it from closing a cycle -- no writer can
/// be past its first lock while it is held. `sort_range` (twice) and
/// `undo_commands::rebuild_all_dependencies` hold the three name tables across
/// `rebuild_all_dependencies_from_grid` today, each under a grid lock; the
/// remove_duplicates pin above was the only one asked, and only of one
/// function. Drop the grid hold around any of them -- or write a new rebuild
/// caller without one -- and this fails.
///
/// SABOTAGE: plant a function that holds `named_ranges` and calls
/// `rebuild_all_dependencies_from_grid` with no grid lock (or release the grid
/// guard in `undo_commands::rebuild_all_dependencies` before its name tables)
/// -- this fails naming it.
#[test]
fn no_function_holds_a_name_store_across_the_dependency_maps_without_a_grid_lock() {
    let sources = crate_sources();
    let graph = direct_acquisitions_by_function(&sources);
    let rebuild = graph
        .get("rebuild_all_dependencies_from_grid")
        .expect("the call graph no longer knows `rebuild_all_dependencies_from_grid`");
    for map in DEPENDENCY_MAPS {
        assert!(rebuild.iter().any(|s| s == map), "the rebuild no longer takes `{map}`: {rebuild:?}");
    }
    let mut ungated: Vec<String> = Vec::new();
    let mut gated: Vec<String> = Vec::new();
    for (rel, text) in &sources {
        ungated.extend(ungated_name_store_holds(rel, text, &graph).iter().map(describe));
        gated.extend(gated_name_store_holds(rel, text, &graph).iter().map(|h| format!("{}::{}", h.file, h.function)));
    }
    ungated.sort();
    ungated.dedup();
    assert!(
        ungated.is_empty(),
        "these functions hold a name store while they take a dependency map, with neither grid lock held:\n{}\n\n\
         Every cell writer takes the dependency maps BEFORE `tables` / `table_names` / `named_ranges` -- off the \
         main thread for the MCP server, the AI chat and the notebook -- so each of these can hold what a writer \
         waits for while it waits for what the writer holds (BUG-0592). Read COPIES of the name tables for the \
         rebuild (as `remove_duplicates` does), or take `grid` first.",
        ungated.join("\n")
    );
    // NON-VACUITY: the census sees the callers that hold the name tables across
    // the rebuild today, each under a grid lock.
    for site in ["commands/data.rs::sort_range", "undo_commands.rs::rebuild_all_dependencies"] {
        assert!(
            gated.iter().any(|g| g == site),
            "the census no longer sees `{site}` hold a name store across the dependency maps under a grid lock, so \
             it may not be reading what it claims to. It sees:\n  {}",
            gated.join("\n  ")
        );
    }
}

/// The census above, on the shapes it must tell apart.
#[test]
fn the_name_store_census_fires_without_a_grid_lock_and_stays_quiet_under_one_or_on_copies() {
    let graph: CallGraph = [("rebuild_maps", vec!["dependents"])]
        .into_iter()
        .map(|(name, stores)| (name.to_string(), stores.into_iter().map(str::to_string).collect()))
        .collect();
    let ungated = r##"pub fn f(state: &AppState) {
    let named_ranges = state.named_ranges.read().unwrap();
    rebuild_maps(state);
}
"##;
    let under_grid = r##"pub fn f(state: &AppState) {
    let grid = state.grid.read().unwrap();
    let named_ranges = state.named_ranges.read().unwrap();
    rebuild_maps(state);
}
"##;
    let copies = r##"pub fn f(state: &AppState) {
    let named_ranges = state.named_ranges.read().unwrap().clone();
    rebuild_maps(state);
}
"##;
    let dropped_grid = r##"pub fn f(state: &AppState) {
    let grid = state.grid.read().unwrap();
    let snapshot = grid.clone();
    drop(grid);
    let tables = state.tables.read().unwrap();
    rebuild_maps(state);
}
"##;
    let hits = ungated_name_store_holds("planted.rs", ungated, &graph);
    assert!(
        hits.iter().any(|h| h.acquiring == "dependents" && h.via.as_deref() == Some("rebuild_maps")),
        "the census missed a name store held across the rebuild with no grid lock: {hits:?}"
    );
    let hits = ungated_name_store_holds("planted.rs", dropped_grid, &graph);
    assert!(
        hits.iter().any(|h| h.acquiring == "dependents"),
        "the census read a DROPPED grid guard as still gating the hold: {hits:?}"
    );
    assert!(ungated_name_store_holds("planted.rs", under_grid, &graph).is_empty(), "a grid-gated hold is not ungated");
    assert_eq!(gated_name_store_holds("planted.rs", under_grid, &graph).len(), 1, "...and is seen as gated");
    assert!(ungated_name_store_holds("planted.rs", copies, &graph).is_empty(), "copies hold nothing");
    assert!(gated_name_store_holds("planted.rs", copies, &graph).is_empty(), "copies hold nothing");
}

// ===========================================================================
// rev5C#1 (BUG-0592) -- THE UNDO STACK AND THE NAME STORES
// ===========================================================================
//
// rev3B#6 made the three name writers (`create_named_range_impl`,
// `update_named_range_core`, `delete_named_range_core`) hold `grid` and the
// registry while they record their undo step -- the order NAME STORE, THEN
// UNDO STACK -- and argued it safe because "every holder of the undo stack that
// then takes a name store holds `grid` first". `update_cell_on_sheets_as` did
// not: it held `grids` (never `grid`), then the undo stack, then read
// `named_ranges` for the casing restamp -- the reverse order, with no lock in
// common. The MCP server runs the name tools on its own thread, so an AI
// defining a name while the user typed a formula into a floating grid (or a
// grouped sheet replicated an entry, or a script wrote another sheet) left each
// thread holding what the other waited for: the window froze, unsaved work
// lost. No census asked about this pair, and none could have seen the writers'
// half: they reach the undo stack THREE calls down (`record_named_range_undo`
// -> `record_object_undo` -> `record_restores_joining_open_transaction`), and
// the round-6 call graph follows one.

/// What each free function of the crate acquires in its own body OR inside any
/// crate function it calls, at ANY depth: [`direct_acquisitions_by_function`]
/// closed over the call graph.
///
/// The one-level graph sees a writer hold the registry and call
/// `record_named_range_undo`, which takes nothing in its own body, and so sees
/// no undo stack at all. Here a call to a helper that takes nothing itself
/// still carries what ITS callees take. The same rules as the one-level graph
/// otherwise: free functions only, a name declared more than once is left out
/// (a call to it cannot be told apart), a spawned closure's calls belong to
/// another thread. Over-approximating by design -- a callee's acquisition counts
/// whether or not the branch that takes it runs -- which is the direction a
/// lock census is for.
fn transitive_acquisitions_by_function(sources: &[(String, String)]) -> CallGraph {
    use crate::formula_serialisation_tests::starts_a_function;
    let direct = direct_acquisitions_by_function(sources);
    // Every uniquely declared free function, whether or not it acquires
    // anything itself.
    let mut declared: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (_, text) in sources {
        for raw in blank_literals(&strip_cfg_test_items(text)).lines() {
            if starts_a_function(raw) {
                if let Some(name) = function_name_of(raw) {
                    *declared.entry(name).or_default() += 1;
                }
            }
        }
    }
    let names: CallGraph =
        declared.iter().filter(|(_, n)| **n == 1).map(|(name, _)| (name.clone(), Vec::new())).collect();
    // Who calls whom, by the walk `direct_acquisitions_by_function` makes.
    let mut calls: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for (_, text) in sources {
        let stripped = blank_literals(&strip_cfg_test_items(text));
        let lines: Vec<&str> = stripped.lines().collect();
        let code: Vec<&str> = lines.iter().map(|l| l.split("//").next().unwrap_or("")).collect();
        let mut current: Option<String> = None;
        let mut depth: i32 = 0;
        let mut entered = false;
        let mut spawn_until: Option<i32> = None;
        for (i, raw) in lines.iter().enumerate() {
            let declares = starts_a_function(raw);
            if declares {
                current = function_name_of(raw).filter(|name| names.contains_key(name));
                depth = 0;
                entered = false;
                spawn_until = None;
            }
            let line = code[i];
            let opens_here = line.matches('{').count() as i32;
            let closes_here = line.matches('}').count() as i32;
            if spawn_until.is_none() && line.contains("spawn(") && opens_here > closes_here {
                spawn_until = Some(depth);
            }
            if let (Some(caller), None, false) = (&current, spawn_until, declares) {
                for (_, callee) in calls_on_line(line, &names) {
                    if callee == caller.as_str() {
                        continue;
                    }
                    let list = calls.entry(caller.clone()).or_default();
                    if !list.iter().any(|c| c == callee) {
                        list.push(callee.to_string());
                    }
                }
            }
            depth -= closes_here;
            depth += opens_here;
            entered |= opens_here > 0;
            if spawn_until.is_some_and(|d| depth <= d) {
                spawn_until = None;
            }
            if entered && depth <= 0 {
                current = None;
                entered = false;
            }
        }
    }
    let mut graph: CallGraph =
        names.keys().map(|name| (name.clone(), direct.get(name).cloned().unwrap_or_default())).collect();
    loop {
        let mut grew = false;
        for (caller, callees) in &calls {
            let mut add: Vec<String> = Vec::new();
            for callee in callees {
                for store in graph.get(callee).into_iter().flatten() {
                    if !graph[caller].contains(store) && !add.contains(store) {
                        add.push(store.clone());
                    }
                }
            }
            if !add.is_empty() {
                graph.get_mut(caller).expect("every caller is a declared name").extend(add);
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    graph.retain(|_, stores| !stores.is_empty());
    graph
}

/// The undo stack, as the censuses spell its field.
const UNDO_STACK: &str = "undo_stack";

/// Both halves of the undo-stack / name-store question over one file, through
/// `graph`: `(the undo stack held while a name store is taken, a name store held
/// while the undo stack is taken)`.
fn undo_stack_and_name_store_holds(
    file: &str,
    text: &str,
    graph: &CallGraph,
) -> (Vec<HeldAcquisition>, Vec<HeldAcquisition>) {
    (
        held_while_acquiring(file, text, &[UNDO_STACK], &NAME_STORES, graph),
        held_while_acquiring(file, text, &NAME_STORES, &[UNDO_STACK], graph),
    )
}

/// Is `store` alive at this hit?
fn alive_at(hit: &HeldAcquisition, store: &str) -> bool {
    hit.alive.iter().any(|s| s == store)
}

/// The holds of one file that can close a cycle between the undo stack and a
/// name store.
///
/// The two orders both exist, and both are needed: the cell writers hold the
/// undo stack while they read the name tables (their formulas' casing and
/// references), and the name writers hold the registry while they record their
/// step. Neither can be turned round, so the rule is a GATE every pair shares:
///
///   * the undo stack held while a name store is taken: BOTH grid locks held --
///     the cell writers' order (`grid`, `grids`, then everything else);
///   * a name store held while the undo stack is taken: at least ONE grid lock.
///
/// Any hold of the first kind then shares a lock with any hold of the second,
/// so no two of them can each hold what the other waits for. `grid` alone on
/// both sides was the round-5 argument, and `update_cell_on_sheets_as` -- `grids`
/// without `grid` -- is the hold it missed.
fn undo_stack_name_store_cycles(file: &str, text: &str, graph: &CallGraph) -> Vec<String> {
    let (under_the_stack, under_a_name_store) = undo_stack_and_name_store_holds(file, text, graph);
    let mut out = Vec::new();
    for hit in &under_the_stack {
        if !(alive_at(hit, "grid") && alive_at(hit, "grids")) {
            out.push(format!(
                "{} -- the UNDO STACK held without both grid locks (alive: [{}])",
                describe(hit),
                hit.alive.join(", ")
            ));
        }
    }
    for hit in &under_a_name_store {
        if !(alive_at(hit, "grid") || alive_at(hit, "grids")) {
            out.push(format!(
                "{} -- a NAME STORE held with neither grid lock (alive: [{}])",
                describe(hit),
                hit.alive.join(", ")
            ));
        }
    }
    out
}

/// rev5C#1 (BUG-0592), over the WHOLE crate: no function holds the undo stack
/// and a name store (`named_ranges`, `tables`, `table_names`) in an order that
/// can close a cycle with another function holding them the other way round --
/// see [`undo_stack_name_store_cycles`] for the gate. Through the TRANSITIVE
/// call graph, because the name writers reach the undo stack three calls down.
///
/// SABOTAGE: take the undo stack in `update_cell_on_sheets_as` before the
/// casing restamp again (the pre-fix order) -- this fails naming it; or drop
/// the `grids` hold from any one name writer -- the non-vacuity half fails
/// naming that writer.
#[test]
fn no_function_holds_the_undo_stack_and_a_name_store_in_an_order_that_can_cycle() {
    let sources = crate_sources();
    let graph = transitive_acquisitions_by_function(&sources);
    // The writers' recorder reaches the stack three calls down; a graph that
    // cannot see that sees no writer at all.
    assert!(
        graph.get("record_named_range_undo").is_some_and(|stores| stores.iter().any(|s| s == UNDO_STACK)),
        "the transitive call graph no longer sees `record_named_range_undo` take the undo stack: {:?}",
        graph.get("record_named_range_undo")
    );
    let mut cycles: Vec<String> = Vec::new();
    let mut under_the_stack: Vec<HeldAcquisition> = Vec::new();
    let mut under_a_name_store: Vec<HeldAcquisition> = Vec::new();
    for (rel, text) in &sources {
        cycles.extend(undo_stack_name_store_cycles(rel, text, &graph));
        let (stack_first, name_first) = undo_stack_and_name_store_holds(rel, text, &graph);
        under_the_stack.extend(stack_first);
        under_a_name_store.extend(name_first);
    }
    cycles.sort();
    cycles.dedup();
    assert!(
        cycles.is_empty(),
        "these holds of the undo stack and a name store can close a cycle:\n{}\n\nThe name writers hold the registry \
         while they record their undo step; the cell writers hold the undo stack while they read the name tables. \
         Off the main thread (the MCP server, the AI chat, a script) the two meet, and a pair that shares no lock \
         freezes the window with no panic and no log (rev5C#1). Take both grid locks first (`grid`, then `grids`) \
         around any hold of the undo stack that reads a name store -- or read the names BEFORE taking the stack -- \
         and at least one grid lock around any hold of a name store that records an undo step.",
        cycles.join("\n")
    );
    // NON-VACUITY, and the writers' half of the fix: each name writer is seen
    // holding the registry while it reaches the undo stack, under BOTH grid
    // locks -- the rename's exact order.
    for writer in ["create_named_range_impl", "update_named_range_core", "delete_named_range_core", "rename_named_range_impl"] {
        let at: Vec<&HeldAcquisition> =
            under_a_name_store.iter().filter(|h| h.file == "named_ranges.rs" && h.function == writer).collect();
        assert!(
            !at.is_empty(),
            "the census no longer sees `{writer}` hold the registry while it records its undo step, so it may not be \
             reading what it claims to"
        );
        let short: Vec<String> =
            at.iter().filter(|h| !(alive_at(h, "grid") && alive_at(h, "grids"))).map(|h| describe(h)).collect();
        assert!(
            short.is_empty(),
            "`{writer}` records its undo step under the registry without BOTH grid locks -- the rename's order is \
             `grid`, `grids`, the registry, the undo stack:\n{}",
            short.join("\n")
        );
    }
    // ...and the cell writers' half is seen too.
    assert!(
        under_the_stack.iter().any(|h| h.file == "commands/data.rs" && h.function == "update_cell_impl"),
        "the census no longer sees `update_cell_impl` read a name store under the undo stack, so it may not be reading \
         what it claims to"
    );
}

/// The census above, on the shapes it exists for -- the round-5 pair, a
/// one-line let-else guard, a writer three calls from the stack -- and quiet on
/// the fixes.
#[test]
fn the_undo_stack_census_fires_on_the_round_five_shapes_and_stays_quiet_on_the_fixes() {
    // The TRANSITIVE graph, built from planted sources: the recorder takes the
    // stack three calls down, as the real one does.
    let recorder = r##"pub fn record_name(state: &AppState) {
    record_object(state);
}
fn record_object(state: &AppState) {
    join_open(state);
}
fn join_open(state: &AppState) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.commit();
}
"##;
    let graph = transitive_acquisitions_by_function(&[("planted.rs".to_string(), recorder.to_string())]);
    assert_eq!(graph.get("record_name").cloned(), Some(vec![UNDO_STACK.to_string()]), "three calls down: {graph:?}");
    assert!(
        !direct_acquisitions_by_function(&[("planted.rs".to_string(), recorder.to_string())]).contains_key("record_name"),
        "the one-level graph is the blind spot this exists for"
    );
    // THE ROUND-5 PAIR, cell-writer half: `grids` and NOT `grid`, the undo
    // stack, then the registry.
    let group_write_before = r##"pub fn group_write(state: &AppState) {
    let mut grids = state.grids.write(&effect).unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    if formula {
        {
            let named_ranges_map = state.named_ranges.read().unwrap();
            restamp(&named_ranges_map);
        }
    }
    undo_stack.commit();
}
"##;
    let group_write_after = r##"pub fn group_write(state: &AppState) {
    let mut grids = state.grids.write(&effect).unwrap();
    if formula {
        {
            let named_ranges_map = state.named_ranges.read().unwrap();
            restamp(&named_ranges_map);
        }
    }
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.commit();
}
"##;
    // A writer that holds the registry and records with NO grid lock, its
    // guard bound by a one-line let-else (the shape every census used to drop
    // at the end of its own line).
    let ungated_writer = r##"pub fn define(state: &AppState) {
    let Ok(pending) = state.named_ranges.lock_pending() else { return };
    if pending.is_empty() { return; }
    record_name(state);
}
"##;
    let gated_writer = r##"pub fn define(state: &AppState) {
    let Ok(grid_hold) = state.grid.lock_pending() else { return };
    let Ok(grids_hold) = state.grids.lock_pending() else { return };
    let Ok(pending) = state.named_ranges.lock_pending() else { return };
    record_name(state);
    drop(pending);
    drop(grids_hold);
    drop(grid_hold);
}
"##;
    let cell_writer = r##"pub fn write_cell(state: &AppState) {
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let names = state.named_ranges.read().unwrap();
}
"##;
    let fires = |label: &str, src: &str| {
        let found = undo_stack_name_store_cycles("planted.rs", src, &graph);
        assert!(!found.is_empty(), "the census did NOT fire on {label}: it cannot see the deadlock it exists for");
    };
    let quiet = |label: &str, src: &str| {
        let found = undo_stack_name_store_cycles("planted.rs", src, &graph);
        assert!(found.is_empty(), "the census fired on {label}, which is CORRECT code: {found:?}");
    };
    fires("the round-5 `update_cell_on_sheets_as` (grids, the undo stack, then the registry)", group_write_before);
    fires("a writer holding the registry with no grid lock, bound by a one-line let-else", ungated_writer);
    quiet("the fixed `update_cell_on_sheets_as` (the registry read and released before the stack)", group_write_after);
    quiet("a writer under both grid locks, three calls from the stack", gated_writer);
    quiet("a cell writer under both grid locks", cell_writer);
    // The gated writer IS a hold of the registry across the stack -- seen, and
    // seen gated -- not a body the census cannot read.
    let (_, name_first) = undo_stack_and_name_store_holds("planted.rs", gated_writer, &graph);
    assert!(
        name_first.iter().any(|h| h.via.as_deref() == Some("record_name") && alive_at(h, "grid") && alive_at(h, "grids")),
        "the census did not see the gated writer hold the registry across its recorder: {name_first:?}"
    );
}

/// rev5C#1's audit, the other pair it found: NOTHING reads `sheet_names` while
/// it holds the undo stack, crate-wide and through the transitive call graph.
///
/// `sheet_names` is an EARLY lock -- the recalculation pass takes it right after
/// the two grid locks, and every cell writer takes it before the undo stack --
/// and `sheets::set_freeze_panes_impl` holds it, with no grid lock, while it
/// records its undo step. Insert/Delete Rows/Columns (the active-sheet bodies
/// and `off_sheet_structural_edit`) re-read it UNDER the stack for the name
/// shift, the inverse with no lock in common, while each already held (or could
/// take) a copy from before the stack. They read that copy now. (The four
/// active-sheet bodies held `style_registry` there too, the BUG-0045 pair; the
/// name-authority census saw them only once it read a one-line `{ .. }` as
/// ending nothing.)
///
/// SABOTAGE: read the sheet names under the undo stack again in
/// `off_sheet_structural_edit` -- this fails naming it.
#[test]
fn no_function_reads_the_sheet_names_while_it_holds_the_undo_stack() {
    let sources = crate_sources();
    let graph = transitive_acquisitions_by_function(&sources);
    let mut offenders: Vec<String> = Vec::new();
    for (rel, text) in &sources {
        offenders.extend(held_while_acquiring(rel, text, &[UNDO_STACK], &["sheet_names"], &graph).iter().map(describe));
    }
    offenders.sort();
    offenders.dedup();
    assert!(
        offenders.is_empty(),
        "these functions read `sheet_names` while they hold the undo stack:\n{}\n\n`set_freeze_panes_impl` holds \
         `sheet_names` while it records its undo step, with no grid lock to order it against these, so each pair can \
         hold what the other waits for (rev5C#1). Copy the names BEFORE taking the undo stack.",
        offenders.join("\n")
    );
    // NON-VACUITY: the other half of the pair is still seen -- the freeze holds
    // the names while it reaches the stack through its recorder.
    let sheets = std::fs::read_to_string(src_root().join("sheets.rs")).expect("cannot read sheets.rs");
    assert!(
        held_while_acquiring("sheets.rs", &sheets, &["sheet_names"], &[UNDO_STACK], &graph)
            .iter()
            .any(|h| h.function == "set_freeze_panes_impl" && h.via.as_deref() == Some("record_freeze_undo")),
        "the census no longer sees `set_freeze_panes_impl` hold `sheet_names` across its undo record -- re-derive \
         which order this pair needs"
    );
}

/// Can another thread take the undo stack within `ms`?
fn undo_stack_free_within(state: &Arc<AppState>, ms: u64) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    {
        let state = Arc::clone(state);
        std::thread::spawn(move || {
            if state.undo_stack.lock().is_ok() {
                let _ = tx.send(());
            }
        });
    }
    rx.recv_timeout(Duration::from_millis(ms)).is_ok()
}

/// THE ROUND-5 DEADLOCK AS A TEST, cell-writer half (rev5C#1). This thread
/// plays a NAME WRITER mid-step: it holds the registry, as
/// `create_named_range_impl` does while it records its undo step (and so waits
/// for the undo stack). The off-sheet formula write -- a floating grid's cell, a
/// grouped-sheet entry, a script writing another sheet -- runs on another thread
/// and parks on the registry for its casing restamp. The question is whether
/// it holds the undo stack while it waits: if it does, the name writer can
/// never record, and neither thread moves again.
///
/// SABOTAGE: take the undo stack in `update_cell_on_sheets_as` before the
/// restamp again -- this fails at "DEADLOCK SHAPE".
#[test]
fn an_off_sheet_formula_write_never_holds_the_undo_stack_while_it_waits_for_the_names() {
    let state = workbook_with_a_name_and_its_reader();
    let (sheet2, _) = append_sheet_for_test(&state, "Sheet2", "visible");
    let file = Arc::new(crate::persistence::FileState::default());
    let writer_holds_the_registry = state.named_ranges.lock_pending().unwrap();
    let site = {
        let state = Arc::clone(&state);
        let file = Arc::clone(&file);
        move || {
            crate::commands::data::update_cell_on_sheets_inner(
                &state,
                &file,
                &crate::persistence::UserFilesState::default(),
                &PivotState::new(),
                &crate::pane_control::PaneControlState::new(),
                &RibbonFilterState::new(),
                vec![sheet2],
                0,
                0,
                "=rate*2".to_string(),
                None,
                Some(false),
                None,
            )
        }
    };
    let probe_state = Arc::clone(&state);
    let (parked, stack_free, result) =
        run_site_while_held(writer_holds_the_registry, site, || undo_stack_free_within(&probe_state, 400));
    assert!(
        parked,
        "PRECONDITION FAILED: the off-sheet write finished while the registry was held, so it never read the names \
         and this test measured nothing"
    );
    assert!(
        stack_free,
        "DEADLOCK SHAPE (rev5C#1, BUG-0592): while the off-sheet formula write waited for `named_ranges` (its casing \
         restamp), it HELD THE UNDO STACK. A name writer holds the registry while it waits for that stack to record \
         its step -- an MCP name edit on its own thread meeting a floating-grid entry froze the window. Read the \
         names before taking the undo stack."
    );
    // NON-VACUITY: once the registry was free the write did all of it -- one
    // step, the formula stored on Sheet2 in the name's own capitalisation.
    assert_eq!(result, Ok(vec![sheet2]), "the off-sheet write did not write Sheet2");
    let stored = state.grids.read().unwrap()[sheet2]
        .get_cell(0, 0)
        .cloned()
        .and_then(|c| c.formula_string())
        .unwrap_or_default();
    assert!(stored.contains("Rate"), "the casing restamp did not run on the stored formula: {stored:?}");
    assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), 1, "the off-sheet write is one undo step");
}

/// THE ROUND-5 DEADLOCK, name-writer half (rev5C#1): each name writer holds
/// BOTH grid locks -- the rename's exact order, `grid`, `grids`, the registry,
/// the undo stack -- while it records its step, so every function that holds
/// the undo stack while it takes a name store (which holds both first) is
/// serialized with it. This thread holds the undo stack, so each writer parks
/// at its record; the probe asks whether `grids` was free at that moment.
/// Before the fix the writers held `grid` alone, and `update_cell_on_sheets_as`
/// -- `grids` without `grid` -- was not ordered against them.
///
/// SABOTAGE: drop the `grids` hold from any one writer -- its row fails.
#[test]
fn the_name_writers_hold_both_grid_locks_while_they_record_their_undo_steps() {
    type NameWriter = fn(&AppState, &crate::persistence::FileState) -> crate::named_ranges::NamedRangeResult;
    let writers: [(&str, NameWriter); 3] = [
        ("create_named_range_impl", define_fee),
        ("update_named_range_core", redefine_rate),
        ("delete_named_range_core", delete_rate),
    ];
    let mut unordered = Vec::new();
    for (label, write) in writers {
        let state = workbook_with_a_name_and_its_reader();
        let file = Arc::new(crate::persistence::FileState::default());
        let undo_held = state.undo_stack.lock().unwrap();
        let site = {
            let state = Arc::clone(&state);
            let file = Arc::clone(&file);
            move || write(&state, &file)
        };
        let probe_state = Arc::clone(&state);
        let (parked, grids_were_free, result) =
            run_site_while_held(undo_held, site, || grids_free_within(&probe_state, 400));
        assert!(
            parked,
            "PRECONDITION FAILED: `{label}` finished while the undo stack was held, so it never waited for it and \
             this test measured nothing"
        );
        if grids_were_free {
            unordered.push(format!("`{label}`"));
        }
        // NON-VACUITY: once the stack was free the writer did all of it, as ONE step.
        assert!(result.success, "`{label}` failed: {:?}", result.error);
        assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), 1, "`{label}` is one undo step");
    }
    assert!(
        unordered.is_empty(),
        "UNORDERED NAME WRITER (rev5C#1, BUG-0592): while these writers held the registry and waited to record their \
         undo step, `grids` was free -- so a function holding `grids` and the undo stack (`update_cell_on_sheets_as`) \
         was not serialized with them. Take `grid`, then `grids`, then the registry:\n{}",
        unordered.join("\n")
    );
}

/// THE TABLE AUTO-EXPAND HALF (rev5C#1): `table_deps::refresh_reader_edges`
/// took `named_ranges`, `tables` and `table_names` BEFORE `grid` -- the
/// canonical order inside out -- while every name writer holds the grid locks
/// when it takes the registry. This thread plays a name writer at its first
/// lock (it holds `grid`); the refresh runs on another thread and parks on the
/// grid. The question is whether the registry is free while it waits.
///
/// SABOTAGE: move the grid read back below the three name stores -- this fails
/// at "DEADLOCK SHAPE".
#[test]
fn refreshing_reader_edges_takes_the_grid_before_the_name_stores() {
    let state = workbook_with_a_name_and_its_reader();
    let writer_holds_grid = state.grid.lock_pending().unwrap();
    let site = {
        let state = Arc::clone(&state);
        move || crate::table_deps::refresh_reader_edges(&state, &[(0, 1)])
    };
    let probe_state = Arc::clone(&state);
    let (parked, registry_free, ()) =
        run_site_while_held(writer_holds_grid, site, || name_keys_within(&probe_state, 400).is_some());
    assert!(
        parked,
        "PRECONDITION FAILED: the edge refresh finished while `grid` was held, so it never waited for it and this \
         test measured nothing"
    );
    assert!(
        registry_free,
        "DEADLOCK SHAPE (rev5C#1, BUG-0592): while the edge refresh waited for `grid`, it held the registry. A name \
         writer holds `grid` while it waits for the registry -- an MCP name edit meeting a table auto-expand froze \
         the window. Take the grid first (`rebuild_all_dependencies`'s order)."
    );
    // NON-VACUITY: once the grid was free the refresh re-derived B1's edge to
    // A1, the cell `Rate` names.
    let local = state.dependents.lock().unwrap().get(&(0, 0)).is_some_and(|cells| cells.contains(&(0, 1)));
    let cross = state
        .cross_sheet_dependencies
        .lock()
        .unwrap()
        .get(&(0, 0, 1))
        .is_some_and(|refs| !refs.is_empty());
    assert!(local || cross, "the refresh did not re-derive B1's edge through the name");
}

// ============================================================================
// Round 8: the undo stack against EVERY store
// ============================================================================
//
// rev5C#1's audit paired every hold of the undo stack against every store and
// found two more cycles the name census could not see, each with no lock in
// common:
//
//   * `set_column_width` / `set_row_height` held their dimension mirror while
//     they waited for the stack; the cell writers hold `grid`, `grids` and the
//     stack and then read `row_heights` / `column_widths` for every formula's
//     evaluation context (and write them for a computed property).
//   * `create_pivot_core` held `pivot_tables` (and `active_pivot_id`) across its
//     undo record, and `delete_pivot_table` held it across three; the cell
//     writers read `pivot_tables` under the stack for GETPIVOTDATA.
//
// The AI chat, the MCP server and the notebook run the cell writers off the main
// thread, so a resize, a pivot create or a pivot delete meeting one froze the
// window with no panic and no log. Each now releases its store before it takes
// the stack. The census below asks the question for EVERY store, so the next
// such pair is a test failure rather than a hang.

/// Every store the crate locks anywhere, by field name: what any line's
/// acquisition names (`acquisitions_at`), the undo stack and the two grid locks
/// left out -- the grid locks are the GATE the undo-stack census asks for, never
/// one of the stores it pairs.
fn every_store_the_crate_locks(sources: &[(String, String)]) -> Vec<String> {
    let mut all: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (_, text) in sources {
        let stripped = blank_literals(&strip_cfg_test_items(text));
        let lines: Vec<&str> = stripped.lines().collect();
        let code: Vec<&str> = lines.iter().map(|l| l.split("//").next().unwrap_or("")).collect();
        for i in 0..code.len() {
            let (acquisitions, _) = acquisitions_at(&code, i, &statement_tail(&code, i));
            for acquisition in acquisitions {
                all.insert(acquisition.field);
            }
        }
    }
    for gate in [UNDO_STACK, "grid", "grids"] {
        all.remove(gate);
    }
    all.into_iter().collect()
}

/// Both halves of the undo-stack question over one file, for every one of
/// `stores`: `(the undo stack held while a store is taken, a store held while the
/// undo stack is taken)`.
fn undo_stack_holds_against(
    file: &str,
    text: &str,
    stores: &[&str],
    graph: &CallGraph,
) -> (Vec<HeldAcquisition>, Vec<HeldAcquisition>) {
    (
        held_while_acquiring(file, text, &[UNDO_STACK], stores, graph),
        held_while_acquiring(file, text, stores, &[UNDO_STACK], graph),
    )
}

/// The lock fields the crate declares that are EXCLUSIVE: some declaration of
/// the name is a `Persisted<..>` (a `Mutex` inside) or a `Mutex<..>`, and none
/// is an `RwLock<..>` -- two readers of an `RwLock` hold it at once, so a read
/// both sides of a pair hold orders nothing. Read from the field declarations
/// (`[pub] name: Type`) of every non-test source.
fn exclusive_lock_fields(sources: &[(String, String)]) -> std::collections::BTreeSet<String> {
    let mut exclusive: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut shared: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (_, text) in sources {
        for raw in strip_cfg_test_items(text).lines() {
            let code = raw.split("//").next().unwrap_or("").trim();
            let code = code.strip_prefix("pub(crate) ").or_else(|| code.strip_prefix("pub ")).unwrap_or(code);
            let Some((name, ty)) = code.split_once(':') else { continue };
            let name = name.trim();
            if name.is_empty() || ty.starts_with(':') || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                continue;
            }
            if ty.contains("RwLock<") {
                shared.insert(name.to_string());
            } else if ty.contains("Persisted<") || ty.contains("Mutex<") {
                exclusive.insert(name.to_string());
            }
        }
    }
    exclusive.retain(|name| !shared.contains(name));
    exclusive
}

/// The pairs of holds that can close a cycle through the undo stack: one holds
/// the stack and takes store X, the other holds X and takes the stack, and no
/// EXCLUSIVE lock (`exclusive`, [`exclusive_lock_fields`]) is alive at both.
///
/// Two holds that each have the same exclusive lock alive cannot be at those two
/// points at once, so the pair cannot close. In practice that lock is a grid
/// lock -- what every function in the crate takes FIRST (`grid`, `grids`, then
/// everything else: `no_lock_is_held_while_a_grid_lock_is_acquired`) -- or the
/// style registry the cell writers take before the stack. Both orders of a pair
/// exist on purpose in the crate: the cell writers take the dimension mirrors
/// and `pivot_tables` under the stack, `apply_changes` and the structural edits
/// hold the mirrors while they take it, and they are safe exactly because each
/// side holds the grid locks. A pair that shares no exclusive lock is the
/// deadlock this exists for. A non-exclusive lock the pair shares is listed in
/// the report, never accepted as a gate.
///
/// One line per pair, grouped by store, sorted and deduplicated.
fn undo_stack_cycles(
    stack_first: &[HeldAcquisition],
    store_first: &[HeldAcquisition],
    exclusive: &std::collections::BTreeSet<String>,
) -> Vec<String> {
    let mut out: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for under_the_stack in stack_first {
        let store = under_the_stack.acquiring.as_str();
        for under_the_store in store_first.iter().filter(|h| h.holding.iter().any(|s| s == store)) {
            let shared: Vec<&str> = under_the_stack
                .alive
                .iter()
                .filter(|s| s.as_str() != UNDO_STACK && s.as_str() != store && alive_at(under_the_store, s))
                .map(String::as_str)
                .collect();
            if shared.iter().any(|s| exclusive.contains(*s)) {
                continue;
            }
            out.insert(format!(
                "`{store}`:\n    the stack first: {} [alive: {}]\n    the store first: {} [alive: {}]{}",
                describe(under_the_stack).trim(),
                under_the_stack.alive.join(", "),
                describe(under_the_store).trim(),
                under_the_store.alive.join(", "),
                if shared.is_empty() {
                    String::new()
                } else {
                    format!("\n    (both also hold [{}], none of them exclusive)", shared.join(", "))
                }
            ));
        }
    }
    out.into_iter().collect()
}

/// Round 8 (NEW-dimension-resize-undo-cycle, NEW-pivot-create-delete-undo-cycle),
/// over the WHOLE crate and EVERY store: no function holds the undo stack while
/// it takes a store that another function holds while it takes the undo stack,
/// unless the two share an exclusive lock (in practice a grid lock) -- see
/// [`undo_stack_cycles`] for the gate. Through the TRANSITIVE call graph:
/// recorders reach the stack calls down.
///
/// It generalises `no_function_holds_the_undo_stack_and_a_name_store_in_an_order_that_can_cycle`
/// (the name stores) and `no_function_reads_the_sheet_names_while_it_holds_the_undo_stack`,
/// which stay, because each pins its own fix more tightly than a pairwise
/// question can. Asking it of every store needed three corrections to the
/// guard tracker, each a hold it reported that the code does not make (round
/// 7's audit listed them as the reason the question stayed narrow): a guard
/// MOVED by `.authorize(` into an inner block (`authorized_on_line`), a
/// `let x = match state.y.write(..)` whose `Ok` arm consumes the guard
/// (`match_arm_consumes_the_guard`), and the pane controls' own store, which
/// shares the field name `controls` with AppState's (`acquisitions_in`).
///
/// SABOTAGE: hold `column_widths` across the undo record in
/// `set_column_width_inner` again, or `pivot_tables` across it in
/// `create_pivot_core` or `delete_pivot_table` -- this fails naming the store and
/// both functions of the pair.
#[test]
fn no_function_holds_the_undo_stack_and_any_store_in_an_order_that_can_cycle() {
    let sources = crate_sources();
    let graph = transitive_acquisitions_by_function(&sources);
    let stores = every_store_the_crate_locks(&sources);
    let store_refs: Vec<&str> = stores.iter().map(String::as_str).collect();
    for store in ["row_heights", "column_widths", "pivot_tables", "named_ranges", "sheet_names"] {
        assert!(
            stores.iter().any(|s| s == store),
            "the store list no longer names `{store}`, so this census may not be reading what it claims to: {stores:?}"
        );
    }
    // The gate's premise: the two grid locks are exclusive.
    let exclusive = exclusive_lock_fields(&sources);
    for gate in ["grid", "grids", "style_registry"] {
        assert!(
            exclusive.contains(gate),
            "`{gate}` no longer reads as an exclusive lock, so this census's gate is not what it claims: {exclusive:?}"
        );
    }
    let mut stack_first: Vec<HeldAcquisition> = Vec::new();
    let mut store_first: Vec<HeldAcquisition> = Vec::new();
    for (rel, text) in &sources {
        let (a, b) = undo_stack_holds_against(rel, text, &store_refs, &graph);
        stack_first.extend(a);
        store_first.extend(b);
    }
    let cycles = undo_stack_cycles(&stack_first, &store_first, &exclusive);
    assert!(
        cycles.is_empty(),
        "these pairs of holds of the undo stack and another store can close a cycle -- each holds what the other \
         waits for, and they share no exclusive lock that orders them:\n{}\n\nThe cell writers \
         (`update_cell_impl`, `update_cells_batch_core`, `fill_range`) hold `grid`, `grids` and the undo stack and \
         then take some thirty stores, and the AI chat, the MCP server and the notebook run them off the main thread. \
         A resize that held its dimension mirror, and a pivot create or delete that held `pivot_tables`, while it \
         waited for the stack froze the window with no panic and no log. Release the store before taking the undo \
         stack (copy what the step records first), or take `grid` and `grids` first.",
        cycles.join("\n")
    );
    // NON-VACUITY, the writers' half: the cell writers are seen taking the two
    // dimension mirrors and `pivot_tables` under the stack -- under both grid
    // locks, which is what makes the other half's gate sufficient.
    for store in ["row_heights", "column_widths", "pivot_tables"] {
        let at: Vec<&HeldAcquisition> = stack_first
            .iter()
            .filter(|h| h.file == "commands/data.rs" && h.function == "update_cell_impl" && h.acquiring == store)
            .collect();
        assert!(
            !at.is_empty(),
            "the census no longer sees `update_cell_impl` take `{store}` while it holds the undo stack, so it may not \
             be reading what it claims to"
        );
        assert!(
            at.iter().all(|h| alive_at(h, "grid") && alive_at(h, "grids")),
            "`update_cell_impl` takes `{store}` under the undo stack without BOTH grid locks: {:?}",
            at.iter().map(|h| describe(h)).collect::<Vec<_>>()
        );
    }
    // ...and the other half is read too: the undo restore holds both dimension
    // mirrors while it takes the stack, under the grid locks.
    for store in ["row_heights", "column_widths"] {
        assert!(
            store_first.iter().any(|h| h.file == "undo_commands.rs"
                && h.function == "apply_changes_with"
                && h.holding.iter().any(|s| s == store)
                && alive_at(h, "grid")
                && alive_at(h, "grids")),
            "the census no longer sees `apply_changes_with` hold `{store}` (under both grid locks) while it takes the \
             undo stack -- re-derive which order this pair needs"
        );
    }
}

/// The census above, on the shapes it exists for and quiet on their fixes.
#[test]
fn the_every_store_undo_census_fires_on_the_round_eight_shapes_and_stays_quiet_on_the_fixes() {
    let graph: CallGraph = [("record_cascade", vec![UNDO_STACK])]
        .iter()
        .map(|(name, stores)| (name.to_string(), stores.iter().map(|s| s.to_string()).collect()))
        .collect();
    let stores = ["row_heights", "column_widths", "pivot_tables", "active_pivot_id"];
    // The cell writers' half: the grid locks, the stack, then the stores.
    let cell_writer = r##"pub fn write_cell(state: &AppState, pivot_state: &PivotState) {
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let rh_map = state.row_heights.read().unwrap().clone();
    let cw_map = state.column_widths.read().unwrap().clone();
}
"##;
    // The pre-fix resize: the mirror held across the record, no grid lock.
    let resize_before = r##"pub fn set_column_width(state: &AppState) {
    let recorded_on = *state.active_sheet.read().unwrap();
    let mut widths = state.column_widths.write(&effect).unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let previous_width = widths.get(&col).copied();
    undo_stack.record_column_width_change(recorded_on, col, previous_width);
}
"##;
    let resize_after = r##"pub fn set_column_width(state: &AppState) {
    let recorded_on = *state.active_sheet.read().unwrap();
    let previous_width = {
        let mut widths = state.column_widths.write(&effect).unwrap();
        let previous = widths.get(&col).copied();
        widths.insert(col, width);
        previous
    };
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.record_column_width_change(recorded_on, col, previous_width);
    }
}
"##;
    // The pre-fix create: `pivot_tables` and the active id held across it.
    let create_before = r##"pub fn create_pivot(state: &AppState, pivot_state: &PivotState) {
    let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
    pivot_tables.insert(pivot_id, (definition, cache_mut));
    let mut active = pivot_state.active_pivot_id.lock().unwrap();
    *active = Some(pivot_id);
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.commit_owned(owned_txn);
    }
    drop(active);
    drop(pivot_tables);
}
"##;
    let create_after = r##"pub fn create_pivot(state: &AppState, pivot_state: &PivotState) {
    {
        let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
        pivot_tables.insert(pivot_id, (definition, cache_mut));
    }
    *pivot_state.active_pivot_id.lock().unwrap() = Some(pivot_id);
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.commit_owned(owned_txn);
    }
}
"##;
    // The pre-fix delete: a READ guard held across a recorder one call down.
    let delete_before = r##"pub fn delete_pivot(state: &AppState, pivot_state: &PivotState) {
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
    let (definition, cache) = pivot_tables.get(&pivot_id).unwrap();
    {
        record_cascade(state);
    }
    drop(pivot_tables);
}
"##;
    let delete_after = r##"pub fn delete_pivot(state: &AppState, pivot_state: &PivotState) {
    let (definition, cache) = {
        let pivot_tables = pivot_state.pivot_tables.read().unwrap();
        let (definition, cache) = pivot_tables.get(&pivot_id).unwrap();
        (definition.clone(), cache.clone())
    };
    record_cascade(state);
}
"##;
    // Both orders under a grid lock: a structural edit holds the mirror while it
    // takes the stack, and the writer the other way round -- serialized by `grid`.
    let structural_gated = r##"pub fn insert_rows(state: &AppState) {
    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let row_heights = state.row_heights.lock_pending().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
}
"##;
    // The OTHER half generalised: a hold of the stack WITHOUT the grid locks
    // that takes a store a gated function holds across the stack.
    let restore_ungated = r##"pub fn restore(state: &AppState) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let row_heights = state.row_heights.read().unwrap();
}
"##;
    // THE GATE, beyond the grid locks: a pair that shares the (exclusive) style
    // registry is ordered by it -- the AutoFilter commands hold it and `locale`
    // across their record, the cell writers take it before the stack -- and a
    // pair that shares only a lock declared as an `RwLock` is not.
    let filter_under_styles = r##"pub fn apply_filter(state: &AppState) {
    let styles = state.style_registry.write(&effect).unwrap();
    let locale = state.locale.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
}
"##;
    let writer_under_styles = r##"pub fn write_styled(state: &AppState) {
    let styles = state.style_registry.write(&effect).unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let locale = state.locale.lock().unwrap();
}
"##;
    let filter_under_a_read = r##"pub fn apply_filter(state: &AppState) {
    let view = state.shared_view.read().unwrap();
    let locale = state.locale.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
}
"##;
    let writer_under_a_read = r##"pub fn write_styled(state: &AppState) {
    let view = state.shared_view.read().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let locale = state.locale.lock().unwrap();
}
"##;
    // THE THREE TRACKER CORRECTIONS. Each "held" shape below was reported by the
    // tracker without the correction, though the code releases the store before
    // the stack; each "kept" shape really holds it.
    let writer_takes_the_object_stores = r##"pub fn shift_rows(state: &AppState, slicer_state: &SlicerState) {
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let n = slicer_state.slicers.read().unwrap().len();
    let c = state.controls.lock().unwrap().len();
    let s = state.object_scripts.write(&effect).unwrap().len();
}
"##;
    // (1) A pending guard MOVED by `.authorize(` into an inner block.
    let authorize_in_a_block = r##"pub fn update_slicer(state: &AppState, slicer_state: &SlicerState) {
    let pending = slicer_state.slicers.lock_pending().unwrap();
    let before = pending.get(&id).cloned();
    let updated = {
        let mut slicers = pending.authorize(&effect);
        slicers.insert(id, slicer);
        1
    };
    record_cascade(state);
}
"##;
    let authorize_kept = r##"pub fn update_slicer(state: &AppState, slicer_state: &SlicerState) {
    let pending = slicer_state.slicers.lock_pending().unwrap();
    let mut slicers = pending.authorize(&effect);
    slicers.insert(id, slicer);
    record_cascade(state);
}
"##;
    // (2) A `let x = match ..write(..)` whose `Ok` arm consumes the guard.
    let match_consumes = r##"pub fn delete_table(state: &AppState) {
    let pruned = match state.object_scripts.write(&effect) {
        Ok(mut scripts) => take_object_scripts(&mut scripts, |s| {
            s.instance_id.is_some()
        }),
        Err(_) => Vec::new(),
    };
    record_cascade(state);
}
"##;
    let match_binds = r##"pub fn delete_table(state: &AppState) {
    let scripts = match state.object_scripts.write(&effect) {
        Ok(s) => s,
        Err(_) => return,
    };
    record_cascade(state);
}
"##;
    // (3) The pane controls' own store, which shares the field name.
    let pane_controls_held = r##"pub fn update_pane_control(state: &AppState, pane_control_state: &PaneControlState) {
    let mut controls = pane_control_state.controls.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
}
"##;
    let app_controls_held = r##"pub fn move_control(state: &AppState) {
    let mut controls = state.controls.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
}
"##;
    let stores = [
        "row_heights",
        "column_widths",
        "pivot_tables",
        "active_pivot_id",
        "locale",
        "slicers",
        "controls",
        "pane_controls",
        "object_scripts",
    ];
    let exclusive: std::collections::BTreeSet<String> =
        ["grid", "grids", "style_registry"].iter().map(|s| s.to_string()).collect();
    let census = |srcs: &[&str]| {
        let mut a = Vec::new();
        let mut b = Vec::new();
        for (i, src) in srcs.iter().enumerate() {
            let (x, y) = undo_stack_holds_against(&format!("planted{i}.rs"), src, &stores, &graph);
            a.extend(x);
            b.extend(y);
        }
        undo_stack_cycles(&a, &b, &exclusive)
    };
    // Every case is judged before anything fails, so one sabotage shows each
    // case it breaks.
    let mut wrong: Vec<String> = Vec::new();
    let mut fires = |label: &str, srcs: &[&str], store: &str| {
        let found = census(srcs);
        if !found.iter().any(|f| f.starts_with(&format!("`{store}`"))) {
            wrong.push(format!("the census did NOT fire on {label}: it cannot see the deadlock it exists for ({found:?})"));
        }
    };
    fires("the pre-fix resize against a cell writer", &[cell_writer, resize_before], "column_widths");
    fires("the pre-fix pivot create against a cell writer", &[cell_writer, create_before], "pivot_tables");
    fires("the pre-fix pivot delete (a read guard, the stack one call down)", &[cell_writer, delete_before], "pivot_tables");
    fires("a hold of the stack with no grid lock against a gated holder of the store", &[restore_ungated, structural_gated], "row_heights");
    fires("a pair that shares only a lock declared as an `RwLock`", &[writer_under_a_read, filter_under_a_read], "locale");
    fires("an authorized guard kept to the record", &[writer_takes_the_object_stores, authorize_kept], "slicers");
    fires("a `match` arm that binds the guard", &[writer_takes_the_object_stores, match_binds], "object_scripts");
    fires("AppState's controls held across the record", &[writer_takes_the_object_stores, app_controls_held], "controls");
    let mut quiet = |label: &str, srcs: &[&str]| {
        let found = census(srcs);
        if !found.is_empty() {
            wrong.push(format!("the census fired on {label}, which is CORRECT code: {found:?}"));
        }
    };
    quiet("the fixed resize", &[cell_writer, resize_after]);
    quiet("the fixed pivot create", &[cell_writer, create_after]);
    quiet("the fixed pivot delete", &[cell_writer, delete_after]);
    quiet("both orders, each under the grid locks", &[cell_writer, structural_gated]);
    quiet("both orders, each under the exclusive style registry", &[writer_under_styles, filter_under_styles]);
    quiet("a guard authorized into an inner block that ends before the record", &[writer_takes_the_object_stores, authorize_in_a_block]);
    quiet("a `match` arm that consumes the guard", &[writer_takes_the_object_stores, match_consumes]);
    quiet("the pane controls' own store held across the record", &[writer_takes_the_object_stores, pane_controls_held]);
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    // The fired line names BOTH functions of the pair.
    let found = census(&[cell_writer, resize_before]);
    assert!(
        found.iter().any(|f| f.contains("write_cell") && f.contains("set_column_width")),
        "a reported pair must name both of its functions: {found:?}"
    );
}

/// The gate's input: the declarations decide which locks are exclusive.
#[test]
fn the_exclusive_lock_reader_tells_a_mutex_from_an_rwlock() {
    let planted = r##"pub struct Planted {
    pub grid: document_effect::Persisted<Grid>,
    pub(crate) locale: Mutex<LocaleSettings>,
    pub shared_view: RwLock<View>,
    pub mixed: Mutex<u32>,
    pub undo_stack: undo_history::UndoHistory,
}
pub struct Other {
    pub mixed: RwLock<u32>,
}
pub fn f(state: &AppState) {
    let local: Mutex<u32> = Mutex::new(0);
}
"##;
    let exclusive = exclusive_lock_fields(&[("planted.rs".to_string(), planted.to_string())]);
    let names: Vec<&str> = exclusive.iter().map(String::as_str).collect();
    assert_eq!(names, vec!["grid", "locale"], "a name any declaration makes an RwLock is never exclusive");
}

/// The two dimension mirrors, read on a thread of their own with a deadline:
/// `Some(the size line `line` has)` when `rows` / columns could be taken within
/// `ms`, `None` when not.
fn dimension_size_within(state: &Arc<AppState>, rows: bool, line: u32, ms: u64) -> Option<Option<f64>> {
    let (tx, rx) = std::sync::mpsc::channel();
    {
        let state = Arc::clone(state);
        std::thread::spawn(move || {
            let store = if rows { &state.row_heights } else { &state.column_widths };
            if let Ok(sizes) = store.read() {
                let _ = tx.send(sizes.get(&line).copied());
            }
        });
    }
    rx.recv_timeout(Duration::from_millis(ms)).ok()
}

/// NEW-dimension-resize-undo-cycle AS A TEST. This thread plays a CELL WRITER
/// mid-step: it holds the undo stack, as `update_cell_impl` does when it reads
/// the dimension mirrors for a formula's evaluation context (and so waits for
/// them). Each one-line resize runs on another thread and parks on the stack to
/// record its step. The question is whether it holds its mirror while it waits:
/// if it does, the writer can never read it, and neither thread moves again.
///
/// SABOTAGE: take the undo stack in `set_column_width_inner` (or
/// `set_row_height_inner`) while its mirror is still held -- its row fails at
/// "DEADLOCK SHAPE".
#[test]
fn a_resize_never_holds_its_dimension_mirror_while_it_waits_for_the_undo_stack() {
    type Resize = fn(&AppState, &crate::persistence::FileState, u32, f64) -> Result<(), String>;
    let doors: [(&str, bool, Resize); 2] = [
        ("set_column_width_inner", false, crate::commands::dimensions::set_column_width_inner),
        ("set_row_height_inner", true, crate::commands::dimensions::set_row_height_inner),
    ];
    let mut held_across = Vec::new();
    for (label, rows, resize) in doors {
        let state = shared_state();
        let file = Arc::new(crate::persistence::FileState::default());
        let writer_holds_the_stack = state.undo_stack.lock().unwrap();
        let site = {
            let state = Arc::clone(&state);
            let file = Arc::clone(&file);
            move || resize(&state, &file, 3, 77.0)
        };
        let probe_state = Arc::clone(&state);
        let mut seen: Option<Option<f64>> = None;
        let (parked, _, result) = run_site_while_held(writer_holds_the_stack, site, || {
            seen = dimension_size_within(&probe_state, rows, 3, 400);
            seen.is_some()
        });
        assert!(
            parked,
            "PRECONDITION FAILED: `{label}` finished while the undo stack was held, so it never waited for it and \
             this test measured nothing"
        );
        match seen {
            None => held_across.push(format!("`{label}`")),
            // NON-VACUITY: it parked AFTER its write -- the mirror it released
            // already holds the new size.
            Some(size) => assert_eq!(
                size,
                Some(77.0),
                "`{label}` parked on the undo stack BEFORE it wrote the size, so the probe measured nothing"
            ),
        }
        assert_eq!(result, Ok(()), "`{label}` failed");
        assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), 1, "`{label}` is one undo step");
    }
    assert!(
        held_across.is_empty(),
        "DEADLOCK SHAPE (NEW-dimension-resize-undo-cycle): while these resizes waited for the undo stack to record \
         their step, they HELD THEIR DIMENSION MIRROR. A cell writer holds `grid`, `grids` and the undo stack while it \
         waits for that mirror (every formula's evaluation context reads it) -- an AI, MCP or notebook write meeting \
         a column resize froze the window. Write the size, release the mirror, then record:\n{}",
        held_across.join("\n")
    );
}

/// Sheet1 holds a small sales table at A1:C4, in the per-sheet grid and the
/// active mirror.
fn workbook_with_a_sales_table() -> Arc<AppState> {
    let state = Arc::new(crate::create_app_state());
    let seed = test_seed_effect();
    let rows: [[&str; 3]; 4] =
        [["Region", "Product", "Sales"], ["North", "Apples", "10"], ["South", "Apples", "20"], ["North", "Pears", "5"]];
    let mut sheet = engine::Grid::new();
    for (r, row) in rows.iter().enumerate() {
        for (c, v) in row.iter().enumerate() {
            let cell = match v.parse::<f64>() {
                Ok(n) => engine::Cell::new_number(n),
                Err(_) => engine::Cell::new_text(v.to_string()),
            };
            sheet.set_cell(r as u32, c as u32, cell);
        }
    }
    {
        let mut grid = state.grid.write(&seed).unwrap();
        let mut grids = state.grids.write(&seed).unwrap();
        if grids.is_empty() {
            grids.push(engine::Grid::new());
        }
        grids[0] = sheet.clone();
        *grid = sheet;
    }
    state
}

/// How many pivots the store holds, read on a thread of their own with a
/// deadline: `None` when `pivot_tables` could not be taken within `ms`.
fn pivot_count_within(pivots: &Arc<PivotState>, ms: u64) -> Option<usize> {
    let (tx, rx) = std::sync::mpsc::channel();
    {
        let pivots = Arc::clone(pivots);
        std::thread::spawn(move || {
            if let Ok(tables) = pivots.pivot_tables.read() {
                let _ = tx.send(tables.len());
            }
        });
    }
    rx.recv_timeout(Duration::from_millis(ms)).ok()
}

/// NEW-pivot-create-delete-undo-cycle AS A TEST, the create door. This thread
/// plays a CELL WRITER mid-step: it holds the undo stack, as `update_cell_impl`
/// does when it reads `pivot_tables` for GETPIVOTDATA. The create runs on
/// another thread and parks on the stack to record its step. The question is
/// whether it holds `pivot_tables` while it waits.
///
/// (`delete_pivot_table`, the other half of the finding, has its own runtime
/// test below, `deleting_a_pivot_never_holds_pivot_tables_while_it_waits_for_the_undo_stack`.)
///
/// SABOTAGE: take the undo stack in `create_pivot_core` while `pivot_tables`
/// is still held -- this fails at "DEADLOCK SHAPE".
#[test]
fn creating_a_pivot_never_holds_pivot_tables_while_it_waits_for_the_undo_stack() {
    let state = workbook_with_a_sales_table();
    let file = Arc::new(crate::persistence::FileState::default());
    let pivots = Arc::new(PivotState::new());
    let writer_holds_the_stack = state.undo_stack.lock().unwrap();
    let site = {
        let state = Arc::clone(&state);
        let file = Arc::clone(&file);
        let pivots = Arc::clone(&pivots);
        move || {
            let pane = crate::pane_control::PaneControlState::new();
            let ribbon = RibbonFilterState::new();
            let user_files = crate::persistence::UserFilesState::default();
            let recalc = crate::pivot::operations::PivotRecalcStates { pane: &pane, ribbon: &ribbon, user_files: &user_files };
            let request = crate::pivot::types::CreatePivotRequest {
                source_range: "A1:C4".to_string(),
                destination_cell: "F2".to_string(),
                source_sheet: Some(0),
                destination_sheet: Some(0),
                has_headers: Some(true),
                name: None,
                source_table_name: None,
                canvas_frame: None,
            };
            crate::pivot::commands::create_pivot_core(
                &state,
                &file,
                &pivots,
                recalc,
                request,
                vec!["Region".to_string()],
                vec![("Sales".to_string(), pivot_engine::AggregationType::Sum)],
            )
            .map(|response| response.pivot_id)
        }
    };
    let probe_pivots = Arc::clone(&pivots);
    let mut seen: Option<usize> = None;
    let (parked, _, result) = run_site_while_held(writer_holds_the_stack, site, || {
        seen = pivot_count_within(&probe_pivots, 400);
        seen.is_some()
    });
    assert!(
        parked,
        "PRECONDITION FAILED: the pivot create finished while the undo stack was held, so it never waited for it \
         and this test measured nothing"
    );
    assert_ne!(
        seen,
        Some(0),
        "the pivot create parked on the undo stack BEFORE it stored the pivot, so the probe measured nothing"
    );
    assert!(
        seen.is_some(),
        "DEADLOCK SHAPE (NEW-pivot-create-delete-undo-cycle): while the pivot create waited for the undo stack to \
         record its step, it HELD `pivot_tables`. A cell writer holds `grid`, `grids` and the undo stack while it \
         waits for `pivot_tables` (GETPIVOTDATA) -- an AI, MCP or notebook write meeting a pivot create froze the \
         window. Store the pivot, release the store, then record."
    );
    // NON-VACUITY: once the stack was free the create did all of it, as ONE step.
    let id = result.expect("the pivot create failed");
    assert!(pivots.pivot_tables.read().unwrap().contains_key(&id), "the pivot was not stored");
    assert_eq!(*pivots.active_pivot_id.lock().unwrap(), Some(id), "the new pivot is not the active one");
    assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), 1, "the pivot create is one undo step");
}

/// NEW-pivot-create-delete-undo-cycle AS A TEST, the DELETE door (round-9
/// review rev8B: it was pinned only by the source census). This thread plays a
/// CELL WRITER mid-step holding the undo stack (as `update_cell_impl` does when
/// it reads `pivot_tables` for GETPIVOTDATA); the delete runs on another thread
/// and parks on the stack to record its step. It must not hold `pivot_tables`
/// while it waits -- the store must still answer, with the pivot in it.
///
/// SABOTAGE: hold the `pivot_tables` read guard across the undo record in
/// `delete_pivot_table` -- this fails at "DEADLOCK SHAPE".
#[test]
fn deleting_a_pivot_never_holds_pivot_tables_while_it_waits_for_the_undo_stack() {
    let state = workbook_with_a_sales_table();
    let file = Arc::new(crate::persistence::FileState::default());
    let pivots = Arc::new(PivotState::new());
    let id = {
        let pane = crate::pane_control::PaneControlState::new();
        let ribbon = RibbonFilterState::new();
        let user_files = crate::persistence::UserFilesState::default();
        let recalc = crate::pivot::operations::PivotRecalcStates { pane: &pane, ribbon: &ribbon, user_files: &user_files };
        let request = crate::pivot::types::CreatePivotRequest {
            source_range: "A1:C4".to_string(),
            destination_cell: "F2".to_string(),
            source_sheet: Some(0),
            destination_sheet: Some(0),
            has_headers: Some(true),
            name: None,
            source_table_name: None,
            canvas_frame: None,
        };
        crate::pivot::commands::create_pivot_core(
            &state,
            &file,
            &pivots,
            recalc,
            request,
            vec!["Region".to_string()],
            vec![("Sales".to_string(), pivot_engine::AggregationType::Sum)],
        )
        .expect("the pivot to delete")
        .pivot_id
    };
    let depth_before = state.undo_stack.lock().unwrap().undo_depth();
    let writer_holds_the_stack = state.undo_stack.lock().unwrap();
    let site = {
        let state = Arc::clone(&state);
        let file = Arc::clone(&file);
        let pivots = Arc::clone(&pivots);
        move || {
            crate::pivot::commands::delete_pivot_table(
                &state,
                &file,
                &pivots,
                &crate::persistence::UserFilesState::default(),
                &crate::pane_control::PaneControlState::new(),
                &RibbonFilterState::new(),
                &crate::slicer::SlicerState::new(),
                &crate::timeline_slicer::TimelineSlicerState::new(),
                id,
            )
        }
    };
    let probe_pivots = Arc::clone(&pivots);
    let mut seen: Option<usize> = None;
    let (parked, _, result) = run_site_while_held(writer_holds_the_stack, site, || {
        seen = pivot_count_within(&probe_pivots, 400);
        seen.is_some()
    });
    assert!(
        parked,
        "PRECONDITION FAILED: the pivot delete finished while the undo stack was held, so it never waited for it \
         and this test measured nothing"
    );
    assert!(
        seen.is_some(),
        "DEADLOCK SHAPE (NEW-pivot-create-delete-undo-cycle): while the pivot delete waited for the undo stack to \
         record its step, it HELD `pivot_tables`. A cell writer holds `grid`, `grids` and the undo stack while it \
         waits for `pivot_tables` (GETPIVOTDATA) -- an AI, MCP or notebook write meeting a pivot delete froze the \
         window. Copy the pivot out, release the store, then record."
    );
    assert_eq!(seen, Some(1), "the delete parked on the stack BEFORE it removed the pivot");
    // NON-VACUITY: once the stack was free the delete did all of it, as ONE step.
    result.expect("the pivot delete failed");
    assert!(!pivots.pivot_tables.read().unwrap().contains_key(&id), "the pivot was not removed");
    assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), depth_before + 1, "the pivot delete is one undo step");
}
