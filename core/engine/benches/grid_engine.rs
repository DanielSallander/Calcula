//! FILENAME: core/engine/benches/grid_engine.rs
//! PURPOSE: Grid-engine performance benchmarks (C3c) — the first committed,
//!   reproducible measurement that substantiates the "1M+ rows" claim for the
//!   GRID engine (pivot-bench/pivot-engine only ever measured the BI/pivot path).
//! CONTEXT: Four groups over core/engine at N = 1k / 100k / 1M:
//!     grid_populate    — build N cells (sparse HashMap insert + bounds)
//!     viewport_read    — read a 50x30 get_cell window (a core-level proxy for a
//!                        viewport fetch; the real get_viewport_cells lives in
//!                        src-tauri and is out of scope for a core bench)
//!     recalc_cascade   — get_recalc_order over an N-wide fan-out from A1
//!     sum_whole_column — evaluate =SUM(A:A) over N populated cells (exercises
//!                        the C3a single-column fast path)
//!   Run (MSVC linker env required, per core/setup-rust-env.ps1):
//!     . core/setup-rust-env.ps1; cargo bench -p engine --bench grid_engine
//!   `cargo check -p engine` validates compilation without the linker.
//!
//!   NOTE on what each number means: SUM(A:A) scales with the number of
//!   POPULATED cells (sparse), not 1,048,576 dense rows; recalc_cascade measures
//!   ORDERING only (not re-evaluation). Stated so the figures aren't over-read.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use engine::{extract_dependencies, Cell, CellCoord, DependencyGraph, EvalResult, Evaluator, Grid};

/// Lookup-family benches use a smaller top size: the *scan* variants are
/// O(M) per call and 1M-row scans would dominate wall-clock for no insight.
const LOOKUP_SIZES: &[u32] = &[1_000, 100_000];

/// Cell counts spanning small / large / the headline 1M.
const SIZES: &[u32] = &[1_000, 100_000, 1_000_000];

/// Criterion needs sample_size >= 10; scale it down as N grows so the big cases
/// finish in reasonable wall-clock without starving the small cases of samples.
fn samples_for(n: u32) -> usize {
    match n {
        0..=10_000 => 50,
        10_001..=200_000 => 20,
        _ => 10,
    }
}

/// A grid with N unit cells stacked in column A (0-based col 0), bounds updated.
fn build_column_grid(n: u32) -> Grid {
    let mut grid = Grid::new();
    for r in 0..n {
        grid.set_cell_unchecked(r, 0, Cell::new_number(1.0));
    }
    grid.update_bounds(n.saturating_sub(1), 0);
    grid
}

fn bench_grid_populate(c: &mut Criterion) {
    let mut group = c.benchmark_group("grid_populate");
    for &n in SIZES {
        group.sample_size(samples_for(n));
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, &n| {
            b.iter(|| {
                let mut grid = Grid::new();
                for r in 0..n {
                    grid.set_cell_unchecked(r, 0, Cell::new_number(r as f64));
                }
                grid.update_bounds(n.saturating_sub(1), 0);
                black_box(&grid);
            });
        });
    }
    group.finish();
}

fn bench_viewport_read(c: &mut Criterion) {
    let mut group = c.benchmark_group("viewport_read");
    for &n in SIZES {
        let grid = build_column_grid(n);
        group.sample_size(samples_for(n));
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, _| {
            // A 50-row x 30-col window of get_cell lookups (1500 sparse probes):
            // column 0 hits, columns 1..30 miss — an honest micro-bench of the
            // HashMap-backed cell read regardless of grid size.
            b.iter(|| {
                for row in 0..50u32 {
                    for col in 0..30u32 {
                        black_box(grid.get_cell(black_box(row), black_box(col)));
                    }
                }
            });
        });
    }
    group.finish();
}

fn bench_recalc_cascade(c: &mut Criterion) {
    let mut group = c.benchmark_group("recalc_cascade");
    let a1: CellCoord = (0, 0);
    // Every dependent's precedent set is {A1}; extracted once from a parsed "=A1".
    let probe = Cell::new_formula("=A1".to_string());
    let a1_deps = extract_dependencies(probe.get_ast().expect("=A1 parses to an AST"));
    for &n in SIZES {
        // Build the fan-out ONCE per size: B1..Bn each depend on A1, so a change
        // to A1 must recalc all N — an O(N) cascade ordering.
        let mut graph = DependencyGraph::new();
        for r in 1..=n {
            graph.set_dependencies((r, 1), a1_deps.clone());
        }
        group.sample_size(samples_for(n));
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, _| {
            b.iter(|| {
                let order = graph.get_recalc_order(black_box(a1)).expect("acyclic");
                black_box(order);
            });
        });
    }
    group.finish();
}

fn bench_sum_whole_column(c: &mut Criterion) {
    let mut group = c.benchmark_group("sum_whole_column");
    for &n in SIZES {
        let grid = build_column_grid(n);
        let sum_cell = Cell::new_formula("=SUM(A:A)".to_string());
        let ast = sum_cell.get_ast().expect("=SUM(A:A) parses to an AST").clone();
        let eval = Evaluator::new(&grid);
        // Correctness guard: each cell is 1.0, so the total must be exactly N.
        // This prevents the bench from silently timing an error/empty path.
        assert_eq!(eval.evaluate(&ast), EvalResult::Number(n as f64));
        group.sample_size(samples_for(n));
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, _| {
            b.iter(|| {
                black_box(eval.evaluate(black_box(&ast)));
            });
        });
    }
    group.finish();
}

/// A two-column lookup table: A = shuffled-ish unique numeric keys,
/// B = payloads. Deterministic (no RNG) but not sorted, so exact-match paths
/// are exercised, not the sorted fast path.
fn build_lookup_grid(n: u32) -> Grid {
    let mut grid = Grid::new();
    for r in 0..n {
        // Bit-reversal-ish permutation keeps keys unique and unsorted.
        let key = ((r as u64 * 2_654_435_761) % (n as u64 * 4)) as f64;
        grid.set_cell_unchecked(r, 0, Cell::new_number(key));
        grid.set_cell_unchecked(r, 1, Cell::new_number(r as f64));
    }
    grid.update_bounds(n.saturating_sub(1), 1);
    grid
}

/// PERF-03: exact-match VLOOKUP with and without the pass-scoped lookup index.
/// `scan` = today's per-call O(M) path; `cached` = one index build amortized
/// across the pass, O(1) probes after (the fill-down shape).
fn bench_vlookup_exact(c: &mut Criterion) {
    let mut group = c.benchmark_group("vlookup_exact");
    for &n in LOOKUP_SIZES {
        let grid = build_lookup_grid(n);
        // Probe an existing key near the END of the table (worst case for scan).
        let probe_key = ((n as u64 - 1) * 2_654_435_761) % (n as u64 * 4);
        let formula = format!("=VLOOKUP({},A1:B{},2,FALSE)", probe_key, n);
        let cell = Cell::new_formula(formula);
        let ast = cell.get_ast().expect("vlookup parses").clone();
        let eval = Evaluator::new(&grid);
        let expected = EvalResult::Number((n - 1) as f64);
        assert_eq!(eval.evaluate(&ast), expected);

        group.sample_size(samples_for(n));
        group.bench_with_input(BenchmarkId::new("scan", n), &n, |b, _| {
            b.iter(|| black_box(eval.evaluate(black_box(&ast))));
        });
        group.bench_with_input(BenchmarkId::new("cached", n), &n, |b, _| {
            let _pass = engine::begin_lookup_pass();
            assert_eq!(eval.evaluate(&ast), expected); // build the index once
            b.iter(|| black_box(eval.evaluate(black_box(&ast))));
        });
    }
    group.finish();
}

/// PERF-14: COUNTIF over an unsorted numeric column, scan vs aggregate index.
fn bench_countif(c: &mut Criterion) {
    let mut group = c.benchmark_group("countif");
    for &n in LOOKUP_SIZES {
        let grid = build_lookup_grid(n);
        let probe_key = ((n as u64 / 2) * 2_654_435_761) % (n as u64 * 4);
        let formula = format!("=COUNTIF(A1:A{},{})", n, probe_key);
        let cell = Cell::new_formula(formula);
        let ast = cell.get_ast().expect("countif parses").clone();
        let eval = Evaluator::new(&grid);
        assert_eq!(eval.evaluate(&ast), EvalResult::Number(1.0));

        group.sample_size(samples_for(n));
        group.bench_with_input(BenchmarkId::new("scan", n), &n, |b, _| {
            b.iter(|| black_box(eval.evaluate(black_box(&ast))));
        });
        group.bench_with_input(BenchmarkId::new("cached", n), &n, |b, _| {
            let _pass = engine::begin_lookup_pass();
            assert_eq!(eval.evaluate(&ast), EvalResult::Number(1.0));
            b.iter(|| black_box(eval.evaluate(black_box(&ast))));
        });
    }
    group.finish();
}

/// PERF-03 end-to-end shape: a whole simulated fill-down pass — K lookups
/// against an M-row table under ONE pass guard (index built once, K-1 hits).
/// Compare against the same K lookups with no guard (K full scans).
fn bench_vlookup_filldown(c: &mut Criterion) {
    let mut group = c.benchmark_group("vlookup_filldown_1k_lookups");
    const K: u64 = 1_000;
    for &n in LOOKUP_SIZES {
        let grid = build_lookup_grid(n);
        let eval = Evaluator::new(&grid);
        // K distinct probes so neither variant can shortcut.
        let asts: Vec<_> = (0..K)
            .map(|i| {
                let key = ((i % n as u64) * 2_654_435_761) % (n as u64 * 4);
                let cell = Cell::new_formula(format!("=VLOOKUP({},A1:B{},2,FALSE)", key, n));
                cell.get_ast().expect("parses").clone()
            })
            .collect();
        group.sample_size(10);
        group.bench_with_input(BenchmarkId::new("scan", n), &n, |b, _| {
            b.iter(|| {
                for ast in &asts {
                    black_box(eval.evaluate(black_box(ast)));
                }
            });
        });
        group.bench_with_input(BenchmarkId::new("cached_pass", n), &n, |b, _| {
            b.iter(|| {
                let _pass = engine::begin_lookup_pass();
                for ast in &asts {
                    black_box(eval.evaluate(black_box(ast)));
                }
            });
        });
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_grid_populate,
    bench_viewport_read,
    bench_recalc_cascade,
    bench_sum_whole_column,
    bench_vlookup_exact,
    bench_countif,
    bench_vlookup_filldown
);
criterion_main!(benches);
