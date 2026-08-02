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
//!
//!   A fifth group, `budget`, is the ACCEPTANCE GATE for the evaluation work
//!   budget (core/engine/src/budget.rs). Every case runs the identical workload
//!   twice — `Evaluator::unmetered` ("before": the meter disabled through its
//!   own `BudgetPolicy`, NOT by editing the charges out) against
//!   `Evaluator::new` ("after": metered, as shipped) — so the delta between the
//!   two bars IS the cost of the feature, measured under `profile.bench`
//!   (release-derived), which is the codegen that ships.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use engine::{extract_dependencies, Cell, CellCoord, DependencyGraph, EvalResult, Evaluator, Grid};
use std::time::Instant;

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

// ============================================================================
// The evaluation-budget acceptance gate
// ============================================================================
//
// Each case runs ONE workload twice over identical input:
//
//   "unmetered" — `Evaluator::unmetered`, i.e. the meter switched off through
//                 its OWN mechanism (`BudgetPolicy::Unmetered`). The charge
//                 call sites are still compiled in and still executed; only the
//                 ceiling is removed. This is the honest "before": it is not a
//                 build with the feature deleted, so it measures exactly the
//                 arithmetic the budget adds and nothing else.
//   "metered"   — `Evaluator::new`, exactly as every host call site builds one.
//
// Read the report as `metered / unmetered - 1`. Thresholds, from the design:
//   scalar_hot_loop      <= 3%   (worst case by construction: the cheapest
//                                 possible node, so per-node fuel is maximally
//                                 visible)
//   mixed_recalc_100k    <  1%   (THE gate — what a user actually feels)
//   sumproduct_1m        <  0.5% (proves the bulk pre-charge is O(1), not O(n))
//   sum_whole_column_1m  <  0.5% (range materializer charge)
//   vlookup_10k          <  1%   (lookup_cache interaction)
//   lambda_fib_24        <  2%   (the per-invocation LAMBDA_CALL_FUEL charge)

/// Parse a formula into an AST, panicking with the formula text on failure.
fn ast_of(formula: &str) -> engine::Expression {
    Cell::new_formula(formula.to_string())
        .get_ast()
        .unwrap_or_else(|| panic!("bench formula failed to parse: {formula}"))
        .clone()
}

/// Run `asts` end to end under both meters. `label` names the case.
fn bench_metered_pair(c: &mut Criterion, label: &str, grid: &Grid, asts: &[engine::Expression], samples: usize) {
    let mut group = c.benchmark_group("budget");
    group.sample_size(samples);

    let unmetered = Evaluator::unmetered(grid);
    let metered = Evaluator::new(grid);

    // Correctness guard: both evaluators must agree on every result, or the
    // "before"/"after" comparison is timing two different computations. This
    // also proves the budget never fires on any of these workloads — a trip
    // would show up here as a `#LIMIT!` mismatch, not as a fast number.
    for ast in asts {
        let a = unmetered.evaluate(ast);
        let b = metered.evaluate(ast);
        assert_eq!(a, b, "metered and unmetered disagreed in bench case {label}");
        assert!(
            !matches!(b, EvalResult::Error(engine::CellError::Limit)),
            "bench case {label} exhausted the real budget — it is not a \
             legitimate-work baseline and the threshold means nothing"
        );
    }

    group.bench_with_input(BenchmarkId::new("unmetered", label), &(), |b, _| {
        b.iter(|| {
            for ast in asts {
                black_box(unmetered.evaluate(black_box(ast)));
            }
        });
    });
    group.bench_with_input(BenchmarkId::new("metered", label), &(), |b, _| {
        b.iter(|| {
            for ast in asts {
                black_box(metered.evaluate(black_box(ast)));
            }
        });
    });
    group.finish();
}

/// Case 1 — the WORST case for a per-node counter by construction: the cheapest
/// possible nodes, so the fuel arithmetic is the largest possible fraction of
/// the work. 100k evaluations of a 9-node scalar expression.
fn bench_budget_scalar(c: &mut Criterion) {
    let mut grid = Grid::new();
    for col in 0..5u32 {
        grid.set_cell_unchecked(0, col, Cell::new_number((col + 2) as f64));
    }
    grid.update_bounds(0, 4);
    let ast = ast_of("=A1*B1+C1-D1/E1");
    let asts: Vec<_> = std::iter::repeat(ast).take(100_000).collect();
    bench_metered_pair(c, "scalar_hot_loop_100k", &grid, &asts, 20);
}

/// Case 2 — THE GATE. A 100k-formula recalculation of the shape a real
/// workbook has: arithmetic, windowed aggregates, branches and lookups, each
/// against a different row so nothing memoizes away.
fn bench_budget_mixed_recalc(c: &mut Criterion) {
    const N: u32 = 100_000;
    const LOOKUP_ROWS: u32 = 500;
    let mut grid = Grid::new();
    for r in 0..N {
        grid.set_cell_unchecked(r, 0, Cell::new_number((r % 977) as f64));
        grid.set_cell_unchecked(r, 1, Cell::new_number((r % 383 + 1) as f64));
    }
    // A lookup table in D:E whose keys are a subset of column A's values.
    for r in 0..LOOKUP_ROWS {
        grid.set_cell_unchecked(r, 3, Cell::new_number((r % 977) as f64));
        grid.set_cell_unchecked(r, 4, Cell::new_number(r as f64 * 1.5));
    }
    grid.update_bounds(N - 1, 4);

    let mut asts = Vec::with_capacity(N as usize);
    for r in 1..=N {
        let f = match r % 10 {
            0 => format!("=VLOOKUP(A{r},D1:E{LOOKUP_ROWS},2,FALSE)"),
            1 | 2 => format!("=SUM(A{}:A{})", r, (r + 99).min(N)),
            3 | 4 | 5 => format!("=IF(A{r}>B{r},A{r}-B{r},B{r}-A{r})"),
            _ => format!("=A{r}*B{r}"),
        };
        asts.push(ast_of(&f));
    }
    bench_metered_pair(c, "mixed_recalc_100k", &grid, &asts, 10);
}

/// Case 3 — the bulk pre-charge. One SUMPRODUCT over two 1M-element columns is
/// three AST nodes and a million multiply-adds; if the charge were per element
/// this would be the case that showed it.
fn bench_budget_sumproduct(c: &mut Criterion) {
    const N: u32 = 1_000_000;
    let mut grid = Grid::new();
    for r in 0..N {
        grid.set_cell_unchecked(r, 0, Cell::new_number((r % 7) as f64));
        grid.set_cell_unchecked(r, 1, Cell::new_number((r % 11) as f64));
    }
    grid.update_bounds(N - 1, 1);
    let asts = vec![ast_of(&format!("=SUMPRODUCT(A1:A{N},B1:B{N})"))];
    bench_metered_pair(c, "sumproduct_1m", &grid, &asts, 10);
}

/// Case 4 — the range materializer's single bulk charge over a whole column.
fn bench_budget_whole_column(c: &mut Criterion) {
    let grid = build_column_grid(1_000_000);
    let asts = vec![ast_of("=SUM(A:A)")];
    bench_metered_pair(c, "sum_whole_column_1m", &grid, &asts, 10);
}

/// Case 5 — the fill-down shape: 10k exact VLOOKUPs against a 100k-row table
/// UNDER A LOOKUP PASS, so the pass-scoped index is built once and probed 10k
/// times. The pass guard is the point, not an optimization of the bench: the
/// index build is a charged bulk operation and the probes are charged
/// individually, so this is the case where the meter and `lookup_cache`
/// actually interact. (Without the guard each call is a fresh O(M) scan —
/// 1e9 probes per iteration — which measures the scan, not the meter.)
fn bench_budget_vlookup(c: &mut Criterion) {
    const N: u32 = 100_000;
    let grid = build_lookup_grid(N);
    let asts: Vec<_> = (0..10_000u64)
        .map(|i| {
            let key = ((i % N as u64) * 2_654_435_761) % (N as u64 * 4);
            ast_of(&format!("=VLOOKUP({key},A1:B{N},2,FALSE)"))
        })
        .collect();

    let mut group = c.benchmark_group("budget");
    group.sample_size(10);
    let unmetered = Evaluator::unmetered(&grid);
    let metered = Evaluator::new(&grid);
    {
        let _pass = engine::begin_lookup_pass();
        for ast in asts.iter().take(64) {
            assert_eq!(
                unmetered.evaluate(ast),
                metered.evaluate(ast),
                "metered and unmetered disagreed in vlookup_10k_over_100k"
            );
        }
    }
    for (name, ev) in [("unmetered", &unmetered), ("metered", &metered)] {
        group.bench_with_input(
            BenchmarkId::new(name, "vlookup_10k_over_100k"),
            &(),
            |b, _| {
                b.iter(|| {
                    let _pass = engine::begin_lookup_pass();
                    for ast in &asts {
                        black_box(ev.evaluate(black_box(ast)));
                    }
                });
            },
        );
    }
    group.finish();
}

/// Case 6 — the LAMBDA_CALL_FUEL charge on the recursion path, at a depth
/// COMFORTABLY inside the allowance (fib(24) is ~150k invocations against a
/// 64M budget), so this measures the charge and not the trip.
fn bench_budget_lambda(c: &mut Criterion) {
    let grid = Grid::new();
    let asts = vec![ast_of("=LET(F, LAMBDA(N, IF(N<2, N, F(N-1)+F(N-2))), F(24))")];
    bench_metered_pair(c, "lambda_fib_24", &grid, &asts, 10);
}

/// Case 8 — REPORTED, NOT GATED. How long `DEFAULT_CELL_FUEL` actually takes to
/// burn under `profile.bench`, so the constant can be justified as "roughly N
/// seconds of felt work" rather than asserted as one. Not a criterion
/// benchmark: it is a single timed observation, printed, because a statistic
/// over a workload that by definition runs once per pathological formula would
/// be a false precision.
fn report_budget_trip_time(_c: &mut Criterion) {
    let grid = Grid::new();
    // fib(40) needs ~3e9 charges against a 64e6 allowance: it trips ~2% in.
    let ast = ast_of("=LET(F, LAMBDA(N, IF(N<2, N, F(N-1)+F(N-2))), F(40))");
    let ev = Evaluator::new(&grid);
    let t0 = Instant::now();
    let result = ev.evaluate(&ast);
    let elapsed = t0.elapsed();
    assert_eq!(result, EvalResult::Error(engine::CellError::Limit));
    let consumed = ev.budget().consumed();
    println!(
        "\n[budget calibration] DEFAULT_CELL_FUEL = {} charges burned in {:.3} s \
         under profile.bench ({:.1} M charges/s); consumed = {}\n",
        engine::DEFAULT_CELL_FUEL,
        elapsed.as_secs_f64(),
        consumed as f64 / elapsed.as_secs_f64() / 1e6,
        consumed
    );
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
criterion_group!(
    budget,
    bench_budget_scalar,
    bench_budget_mixed_recalc,
    bench_budget_sumproduct,
    bench_budget_whole_column,
    bench_budget_vlookup,
    bench_budget_lambda,
    report_budget_trip_time
);
criterion_main!(benches, budget);
