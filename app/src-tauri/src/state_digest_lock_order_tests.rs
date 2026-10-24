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
                method,
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
                let is_let_binding = statement.trim_start().starts_with("let ");
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
        for (_, field, live, binding, via) in events {
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
                // binding outlives it (see `grid_locks_taken_while_holding`).
                let is_let_binding = statement.trim_start().starts_with("let ");
                let scope = if !is_let_binding && line.trim_end().ends_with('{') { depth + 1 } else { depth };
                alive.push(Guard { field, binding, scope });
            }
        }
        let dropped = dropped_on_line(line);
        alive.retain(|guard| guard.binding.is_empty() || !dropped.contains(&guard.binding));
        depth -= closes_here;
        alive.retain(|guard| depth >= guard.scope);
        depth += opens_here;
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
const CELL_WRITERS: [&str; 3] = ["update_cell_impl", "update_cells_batch_core", "fill_range"];

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
/// `sheet_ids` is read through calls too. The three name stores are read in
/// the bodies only: through calls they reach two cases in files this round does
/// not own (`remove_duplicates` holds all three and rebuilds every dependency
/// map; `rename_named_range_impl` holds `named_ranges` and rewrites both grids),
/// each a real cycle with the writers, reported open rather than exempted here.
fn late_store_inversions(file: &str, text: &str, graph: &CallGraph, writers_hold: &[String]) -> Vec<HeldAcquisition> {
    let then: Vec<&str> = writers_hold.iter().map(String::as_str).collect();
    let (recorders_first, name_stores) = TAKEN_LATE_BY_THE_CELL_WRITERS.split_at(1);
    let mut hits = held_while_acquiring(file, text, recorders_first, &then, graph);
    hits.extend(held_while_acquiring(file, text, name_stores, &then, &CallGraph::new()));
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
            "the name stores are read in the body only (the documented scope)",
            r##"pub fn remove_duplicates(state: &AppState) {
    let tables = state.tables.read().unwrap();
    rebuild_maps(state);
}
"##,
        ),
    ];
    let mut wider = writers_hold.clone();
    wider.push("dependents".to_string());
    for (label, src) in quiet_for_census_two {
        let hits = late_store_inversions("planted.rs", src, &graph, &wider);
        assert!(hits.is_empty(), "census 2 fired on `{label}`, which it must not: {hits:?}");
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

/// Torn reads this round could not reach: each a real one, in a file outside the
/// files the round owned, named as the census reports it (file, function).
///
/// TOLERATED, NOT REQUIRED: fixing one needs no edit here (then delete its
/// entry). Nothing may be ADDED -- a new torn read is a defect to fix, not an
/// entry to write.
const TORN_SHEET_PAIRS_NOT_YET_FIXED: [(&str, &str); 9] = [
    ("calp_collection.rs", "ready_author_collections"),
    ("calp_collection.rs", "list_collection_regions"),
    ("commands/sheet_blank.rs", "sheet_contents"),
    ("object_bindings/formula.rs", "read"),
    ("object_bindings/object_json.rs", "read"),
    ("object_bindings/page_overrides.rs", "read"),
    ("scripting/application_code_gate.rs", "workbook_sheet_facts"),
    ("scripting/notebook_commands.rs", "run_cell_internal"),
    ("sheets.rs", "with_pane_controls_following_rename"),
];

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
            if TORN_SHEET_PAIRS_NOT_YET_FIXED.contains(&(rel.as_str(), hit.function.as_str())) {
                continue;
            }
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
//      `get_slicer_items_core` holds the slicers while it reads `grids`. They
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
            "RequestedSheets::from_wire(params.sheet_ids, params.sheet_indices)",
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
        // The braces IN SOURCE ORDER. Counting closes before opens -- the other
        // trackers' rule, right for `} else {` -- reads a one-line closure at the
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
