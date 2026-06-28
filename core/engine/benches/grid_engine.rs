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

criterion_group!(
    benches,
    bench_grid_populate,
    bench_viewport_read,
    bench_recalc_cascade,
    bench_sum_whole_column
);
criterion_main!(benches);
