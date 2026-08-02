# Engine Performance Audit — Atomic-Level Findings and Lookup Acceleration Plan

**Date:** 2026-07-12
**Method:** 33-agent multi-phase audit (6 subsystem deep-readers + coverage critic + dedup/merge +
one adversarial verifier per finding, each re-reading the cited code with a mandate to refute).
22 findings survived verification (several materially amended by verifiers); 0 were refuted.
Criterion benchmarks were run live on the dev machine (ARM64 Windows, MSVC) to ground the numbers.
**Scope:** the formula calculation path only — `core/engine`, `core/parser`, and the app-side
recalc drivers in `app/src-tauri`. BI engine, pivot engine, and rendering are out of scope.
**Constraint honored throughout:** every proposal preserves the engine's *current observable
semantics* bug-for-bug (not assumed-Excel semantics) unless a divergence is explicitly called out.

---

## 1. Measured baseline (criterion, `core/engine/benches/grid_engine.rs`)

| Benchmark | 1k | 100k | 1M | Unit cost |
|---|---|---|---|---|
| grid_populate | 229.3 us | 28.63 ms | 402.3 ms | 229-402 ns per HashMap insert |
| viewport_read (1500 sparse probes) | 39.9 us | 62.9 us | 31.6 us | **21-42 ns per SipHash get_cell probe** |
| recalc_cascade (ordering only, no eval) | 242.8 us | 34.41 ms | 624.3 ms | 624 ns/cell at 1M just to order |
| sum_whole_column =SUM(A:A) | 41.8 us | 13.13 ms | 239.0 ms | 239 ns per populated cell |

**Dev profile (what `tauri dev` runs), N=1000:** grid_populate 1.029 ms (**4.5x slower**),
viewport_read 420.4 us (**10.5x**), recalc_cascade 3.645 ms (**15.0x**), sum_whole_column 380.0 us (**9.1x**).

LTO/codegen-units effects could not be resolved: run-to-run noise on this machine (big.LITTLE
scheduling, thermals, Dropbox) is ~2x and swamps 5-20% codegen effects. Only the debug-vs-release
bracket clears the noise floor decisively. See PERF-22 for the harness fix.

---

## 2. Correctness bugs found along the way (fix regardless of performance)

1. **Recalc order is not topological — stale cells on every edit with dependency depth >= 2.**
   `get_recalculation_order` (app/src-tauri/src/lib.rs:3247-3314) counts in-degrees including
   edges from the changed cell but seeds the ready queue with `deg == 0`, so Kahn's algorithm
   emits nothing (or almost nothing) and 100% of the output flows through the O(n^2)
   `Vec::contains` tail **in hash order**. For a chain A1 -> B1=A1+1 -> C1=B1+1, editing A1 can
   evaluate C1 before B1 (SipHash-seed randomized, ~50% per level), and
   `reevaluate_formula_cell` does not cascade, so C1 keeps a stale value.
   `multi_root_recalc_order` (app/src-tauri/src/control_values.rs:241-292) already implements the
   seeding correctly — generalize and share it. (Found by the PERF-06 verifier.)
2. **Batch paste in-batch staleness.** `update_cells_batch` (commands/data.rs:2412-2431) runs one
   BFS+Kahn per pasted cell, merges first-seen, and excludes batch cells from dependent recalc
   (`!updated_set.contains(&dep)`), so a pasted formula reading another pasted cell processed
   after it keeps a stale value. The fix (single multi-root traversal) is also the perf fix.
3. **Volatile functions go stale.** NOW/TODAY/RAND/INDIRECT/OFFSET only refresh on full recalc;
   docs (docs/functions/NOW.md:19 etc.) promise otherwise. See PERF-19 — fixing this *adds* work
   per edit, so it must be done deliberately (volatile-root set, never full recalc per edit).
4. **INDEX column-overflow wrap.** `fn_index`'s 2D branch computes `row_num*cols + col_num` on a
   flat array, so `INDEX(A1:B3, 1, 3)` silently returns A2's value instead of #REF!
   (evaluator.rs:5243-5244). Any fast path must replicate this bug or fix it deliberately.
5. **XMATCH binary search modes are silently linear** ("simplified to linear", evaluator.rs:10784)
   and XMATCH wildcard matching depends on `wildcard_match`'s internal re-uppercasing (its caller
   does not pre-fold case) — a trap for any refactor.

---

## 3. The headline problem: the lookup family is O(N*M) per recalc

Every lookup/criteria function is **materialize-then-scan with zero caching**:

- `fn_vlookup` (evaluator.rs:11700-11763): per call, `evaluate(table)` -> `eval_range`
  (711-777) does rows*cols SipHash grid probes cloning every cell value (Text = String clone),
  then `extract_2d_rows` (11861-11884) **deep-clones the entire table a second time**, then a
  linear scan. `fn_hlookup` identical.
- `fn_match` (5267-5320), `fn_xlookup` (2814-2884), `fn_xmatch` (10772-10855), `fn_index` (5223),
  LOOKUP, and the whole SUMIF/COUNTIF/AVERAGEIF(S)/MINIFS/MAXIFS family (3612-3807) share the
  shape via `eval_flat` = `evaluate()` + `flatten()`, where `flatten()` (231-243) re-clones every
  element of the already-owned array.
- Approximate modes are linear scans; only XLOOKUP has real binary search and only when the user
  passes search_mode +/-2.
- The full-recalc driver re-evaluates **every formula cell on the sheet per pass**
  (calculation.rs:397), so N lookup formulas over an M-row table cost O(N*M) time and O(N*M)
  cloned values **per edit**. A 100k-row VLOOKUP fill-down over a 100k-row table is ~10^10
  operations plus ~10-20 MB of allocation *per formula cell*. This is exactly the reported pain.

The fix is a program, not a single patch — in order of leverage:

1. **PERF-03 Lookup index cache** — turns the family from O(N*M) to O(N+M) per pass.
2. **PERF-14 Criteria aggregate index** — same for the COUNTIF/SUMIF fill-down idiom.
3. **PERF-04 Zero-copy range access** — kills the double/triple clone for everything else.
4. **PERF-12 / PERF-11** — O(1) INDEX and allocation-free comparators (independent quick wins).

---

## 4. Findings (priority order within waves)

Legend: verdicts are the adversarial verifier's (CONFIRMED / PARTLY = survives with amendments).
Impact/risk are post-verification revised ratings.

### Wave 0 — free wins, days of work, ship first

#### PERF-01 — Users run an opt-level=0 debug build (CONFIRMED, transformative, low risk)
The app is only ever launched via `tauri dev` (app/package.json:18-19; the /STACK workaround in
build.rs documents debug as the daily driver). No Cargo.toml in the repo defines any `[profile.*]`.
`app/src-tauri` is its own implicit workspace root, so engine/parser/identity compile at
opt-level=0: **measured 4.5-15x slower** across all benches.
**Fix:** in `app/src-tauri/Cargo.toml` add `[profile.dev.package."*"] opt-level = 2` (path deps
like engine/parser are covered by `"*"`; the app crate itself is not, so incremental app rebuilds
stay fast). Mirror in `core/Cargo.toml` **with explicit per-member entries**
(`[profile.dev.package.engine]` etc. — `"*"` does not cover workspace members; verifier amendment).
Add `[profile.release] lto = "thin", codegen-units = 1` and mirror `[profile.bench]`.
**Guards:** do NOT set `panic = "abort"` (pivot/operations.rs:71 relies on `catch_unwind`);
do not touch debug-assertions/overflow-checks; `target-cpu=native` only in an uncommitted local
`.cargo/config.toml` (dev machine is aarch64; bundles must stay baseline).

#### PERF-09 — Per-cell logging in the format hot path (CONFIRMED, large, low risk)
`log_debug!("FMT", ...)` inside `format_cell_value_with_color` (lib.rs:550-552) fires for every
numeric non-General cell on every recalc write-back, cascade, and viewport fetch. The macro
eagerly `format!`s (including `{:?}` of the whole NumberFormat enum) before any mute check, takes
three global Mutex locks, and does one unbuffered WriteFile syscall per cell (logging.rs:160-185).
~2-5 us/cell; 100k formatted cells => hundreds of ms per recalc plus ~8 MB log growth.
**Fix:** delete the line, or gate `log_debug!` behind a `static AtomicBool` checked *before*
argument formatting. **Guard:** do NOT naively wrap LOG_FILE in BufWriter — `sort_log_file`
seeks/reads the same handle and crash-forensics would lose buffered lines.

#### PERF-06 — Recalc ordering: O(n^2) tail + per-cell BFS in batch (CONFIRMED, large; also a bug fix)
See Correctness bugs 1-2. The tail loop (lib.rs:3307-3311) does n(n-1)/2 tuple comparisons —
50k dependents => ~1.25B comparisons, seconds per edit; multiplied per-root in batch paste.
**Fix (two stages):** (a) zero-semantic-change: replace the tail with an O(n) pass over the
in_degree map (entries with remaining degree > 0), ship immediately; (b) the real fix: correct
Kahn seeding by generalizing `multi_root_recalc_order` (control_values.rs:241-292), and give
`update_cells_batch` one multi-root traversal (seed BFS with all edited cells, single Kahn over
affected UNION batch formula cells). Changes observable order from random to topological —
strictly more correct, but soak-test recalc oracles may need re-baselining.

#### PERF-05 — FxHash for coordinate maps (CONFIRMED, moderate, low risk)
Grid.cells, the engine dependency graph, and the app's five dependency stores all use default
SipHash. Measured probe cost 21-42 ns of which SipHash finalization is ~30-50%.
**Fix:** `rustc-hash = "2"`, type aliases (`CellMap`, `FxHashSet<(u32,u32)>`) for grid.cells
(grid.rs:17), engine dependency_graph, AppState maps (lib.rs:204-225). Call sites compile
unchanged except ~3 explicit type annotations. Grid map is not serialized; iteration-order
consumers either sort or are already nondeterministic — FxHash makes them *more* deterministic.
Optional follow-on: packed `u64` key (`row<<32|col`) — bigger churn, do later if profiling justifies.

#### PERF-16 — Spill-protection full-map scans (CONFIRMED, moderate, low risk)
`check_spill_protection` (commands/data.rs:40-62) iterates every spill_hosts entry workbook-wide;
`update_cells_batch` calls it once per pasted cell with a single-cell range => O(paste x spills)
holding the mutex (10k x 10k => ~1e8 comparisons, 100-500 ms pre-eval overhead per paste).
**Fix:** single-cell ranges become one `HashMap::get`; range paths probe adaptively (area as u64
to avoid whole-column overflow). Byte-identical error text and outcome ordering.

#### PERF-20 — Cascade IPC payload (CONFIRMED, moderate, low risk)
Every cascade renders + localizes a formula string per recalculated dependent
(formula_display, data.rs:32-35) and ships full CellData JSON — while the canvas refetches
visible cells anyway after every cascade, so it is almost entirely wasted work.
**Fix:** omit the formula field for cascade-recalculated cells (keep it for the edited cell);
optionally compact wide cascades to (row,col,display,styleIndex) or a refetch-viewport signal.

### Wave 1 — the lookup family (the headline ask)

#### PERF-03 — Pass-scoped lookup index cache (PARTLY -> amended, transformative, medium risk)
**The centerpiece.** New `core/engine/src/lookup_cache.rs`, `LookupIndexCache` owned by the
*driver* for the lifetime of one recalc pass (created in calculate_now, recalculate_sheet_values,
and the update_cell cascade; dropped at pass end), attached to each per-cell Evaluator as
`Option<&RefCell<LookupIndexCache>>` via a `set_lookup_cache()` setter — the same wiring pattern
as `set_styles`/`set_gather_fn` (evaluator.rs:466-500). Pass-scoped, NOT persistent: persistence
would need invalidation hooks across set_cell/clear_region/structural ops/sheet remap/undo;
pass scope reduces the surface to one `notify_write` hook (drivers write results mid-pass).

- **Cache key:** (sheet, rect, key axis/offset, KeySemantics family).
- **FOUR equality families, not three** (verifier amendment — XMATCH is distinct):
  1. `VlookupExact` — `values_equal` (11905): num |a-b|<1e-10, ASCII-only case-insensitive text;
  2. `MatchExact` — `eval_values_equal` (3857): 1e-10, Unicode to_uppercase;
  3. `XlookupExact` — `xlookup_values_equal` (3315): f64::EPSILON, Unicode uppercase, plus
     Number<->parseable-Text cross-typing;
  4. `XmatchExact` — `as_number()` coercion both sides (Boolean->1/0, Text parse) with 1e-10,
     else **case-sensitive** text compare (10795). Alternatively exclude XMATCH from v1.
- **Text index:** `HashMap<Box<str>, u32 first_row>`, key folded per family (ascii vs Unicode).
- **Number index:** because both epsilon predicates are **non-transitive**, a bit-hash map is
  wrong for first-match-wins. Use `Vec<(f64, u32 row)>` sorted by value; query = binary-search
  the [v-eps, v+eps] window, verify with the ORIGINAL predicate, take min row.
- **Empty/error semantics:** reproduce eval_range exactly — absent/Empty => Number(0.0);
  Error cells excluded (every family returns false for errors).
- **Eligibility:** only `Expression::Range` with literal CellRef endpoints (optionally
  single-column ColumnRef, reproducing its populated-cells-only compacted ordering verbatim).
  Computed arrays (FILTER results etc.) keep today's scan. **Wildcards bypass the index**
  (MATCH with *?, XLOOKUP/XMATCH match_mode 2). Note: this engine's VLOOKUP exact does NOT
  implement wildcards — mirror the code, not Excel.
- **Approximate modes:** cached sortedness check **using each function's own comparator**
  (compare_values for VLOOKUP/HLOOKUP/LOOKUP; xlookup_compare for MATCH 1/-1), then binary
  search; unsorted keeps today's linear scan (preserves garbage-in behavior on unsorted data).
  XMATCH +/-1 modes are unsorted best-match scans — excluded from the binary path.
- **Effect:** N lookups over M rows: O(N*M) -> O(N+M) per pass, and the per-call double table
  clone disappears for cache-eligible calls.

#### PERF-14 — Criteria aggregate index for SUMIF/COUNTIF family (PARTLY -> amended, large, medium)
`=COUNTIF(A:A,A1)` fill-down is O(N^2) with a String allocation per row per cell. Extend the
pass-scoped cache with per-(sheet, criteria-rect, value-rect) aggregates built once in O(M):
text buckets keyed on the `as_text().to_uppercase()` normal form -> (count, sum, min, max,
numeric_count of the paired column); sorted numeric vec with prefix sums for Compare ops.
**Verifier amendments (all mandatory):** (a) ExactNumber served from the numeric index ONLY —
the text-bucket union double-counts (Number 5.0 sits in bucket "5" AND the epsilon window);
(b) ExactBool needs variant-tagged sub-counts or scan fallback (matches only the Boolean variant);
(c) NotEqual total = numeric-coercible total, not all rows; (d) **prefix-sum SUM changes float
summation order** — last-ulp drift collides with the soak-test recalc-determinism oracle.
v1: serve COUNT + exact-match buckets (bit-identical when accumulated in build order); gate
prefix-sum SUM behind tolerance-tested acceptance. Multi-criteria *IFS keep the scan in v1
(they still win from PERF-04). Preserve the flat-index pairing quirk (out-of-range get(i)
contributes nothing, evaluator.rs:3622).

#### PERF-04 — Zero-copy range access (CONFIRMED, transformative, medium risk)
`eval_range` probes per coordinate with no sparse fallback and pushes 80-byte Number(0.0) for
every empty cell (SUM over sparse A1:A1M = 1M probes + ~80 MB of zeros); `flatten()` re-clones
every leaf; sumif/averageif/LOOKUP clone a third time; VLOOKUP/HLOOKUP deep-clone tables via
extract_2d_rows. Staged fix:
(a) ownership fixes — consuming `into_flatten()` that MOVES leaves; borrowing table accessor
    replacing extract_2d_rows; kill the third clones. **TRAP (verifier):** a consuming
    `flatten_into` ALREADY EXISTS (evaluator.rs:2212-2224) with DIFFERENT semantics (unpacks
    List items; `flatten()` treats List/Dict as opaque). Do not reuse it; differential-test the
    new one against `flatten()`.
(b) `Grid::read_range()` bulk primitive: per-coordinate probes when area <= cells.len(), else
    one pass over grid.cells filtered to the rect into a pre-sized positional buffer —
    positionally identical output (same Number(0.0) fillers, same row-major order).
(c) full `RangeView<'g>` yielding `&CellValue` in the exact current traversal order with a
    shared empty sentinel + O(1) at(r,c) — no 2D table ever built; EvalResult::Array remains
    the spill/interop type. Traversal order is load-bearing (first-match-wins, SUMIF positional
    pairing; whole-column multi-col order differs from rect order — preserve verbatim).
    COUNTBLANK's quirk (counts only Text("")) must survive bug-for-bug.

#### PERF-12 — O(1) INDEX (PARTLY -> amended, large, low risk)
`INDEX(A1:A100000, 5)` materializes and double-copies 200k EvalResults to fetch one value.
Fast path for literal Range args: compute the flat row-major index, bounds-check
`idx < rows*cols` ONLY (to replicate the wrap quirk — see Correctness bug 4 — or deliberately
fix it with tests), address the grid directly with the same Empty->Number(0.0) conversion.
When cols<=1, use row_num alone and ignore col_num (current behavior). Keep the materialize
path for ColumnRef/RowRef (compacted ordering is load-bearing), computed arrays, and
row_num==0/col_num==0 whole-row/col cases. Note INDEX/MATCH pairs still need PERF-03 for the
MATCH half.

#### PERF-11 — Allocation-free comparison/criteria/wildcards (PARTLY -> amended, moderate, medium)
Every text comparison allocates 1-4 uppercase Strings (operators at evaluator.rs:1175,1204-1242;
compare_values 11893-11896; xlookup_compare 3306-3308); criteria matching allocates 1-2 Strings
per cell per call (3583-3601); wildcard matching builds Vec<char> pairs and (XMATCH only) an
O(P*T) DP table per element; MATCH re-uppercases its pattern per row.
**Fix:** stream comparators via `chars().flat_map(char::to_uppercase)` + `Iterator::cmp`
(exactly equivalent to comparing to_uppercase() Strings: uppercase has no context-dependent
mappings; UTF-8 byte order = code-point order — differential property tests with sharp-s,
dotted-I, ligatures required); buffer-reusing `as_text_into(&mut String)` for criteria
(reusing the EXACT number-formatting code, fract()==0 && abs<1e15 cutoff); compile wildcard
patterns once per call (two compilers, preserving the with-~-escape / without split between
MATCH/XLOOKUP/criteria and XMATCH — do not unify); hoist MATCH's pattern normalization out of
the row loop. **Verifier amendments:** VLOOKUP "double compare per row" is actually once per
lookup (drop that item); do NOT delete wildcard_match's internal to_uppercase without
compensating in XMATCH (its caller does not pre-fold); defer XMATCH binary modes until the
PERF-03 sortedness check exists.

### Wave 2 — driver rework (biggest constant-factor wins)

#### PERF-02 — Recalc drivers: stop re-parsing the world (PARTLY -> amended, large, medium risk)
`calculate_now` renders every stored AST to a string (cell.formula_string()), **re-parses**
(calculation.rs:140), re-resolves names/tables, deep-clones via convert_expr, clones the
row-heights/column-widths HashMaps, and rebuilds MultiSheetContext + Evaluator **per formula
cell per pass**; circular groups re-parse per iteration (up to 100x). The cascade already
evaluates cached ASTs (data.rs:1346) — the cheap path is proven.
**Fix:** iterate (row, col, &ast) and evaluate cached ASTs directly; keep render->parse->resolve
as a **guarded fallback** for cells whose AST is None or contains NamedRef/TableRef/SpillRef
nodes, `BuiltinFunction::Custom(_)`, or `__INVOKE__` splices (named-lambda freshness — verifier:
the guard set must include __INVOKE__/Custom or named-function redefinition breaks). Build
MultiSheetContext + Evaluator once per pass with `set_current_cell(row,col)`; clear LET/LAMBDA
scope between cells; dimension maps become `Option<Arc<HashMap>>` (also fixes the currently
degraded GET.ROW.HEIGHT fallback in cascades). Apply convert_expr's wildcard-sheet expansion
once at AST-cache time (existing TODO at lib.rs:709-711). Fix update_cell's entry to use
cell.get_ast() (data.rs:782-784). Hoist parse/resolve out of circular-iteration loops.

#### PERF-08 — Arc AST + in-place write-back + retire the grid mirror (CONFIRMED, large, medium)
`Cell::clone` deep-copies the boxed AST; calculate_now **deep-clones the entire active grid
every recalc** (calculation.rs:336-342, the BUG-0016 mirror workaround) and clones each result
cell 3-4x on write-back; undo snapshots clone full grids (structure.rs:626/824/1482/1730).
**Fix, staged:** (a) `Cell.ast: Option<Arc<Expression>>` — clone becomes refcount bump
(serde rc feature; persistence uses formula strings, unaffected); (b) `Grid::set_value()`
in-place value write-back — one CellValue move instead of three Cell clones; (c) retire the
state.grid mirror (root-cause BUG-0016) so the whole-grid clone per recalc disappears.

#### PERF-07 — Rect nodes for range dependencies (CONFIRMED, large, medium)
A1:A100000 inserts 100k per-cell edges (lib.rs:920-948, 3149-3156) — O(area) hash inserts per
formula edit and tens of MB per large-range formula. Whole-column refs already have stripe
treatment (lib.rs:949-978); finite rects always expand.
**Fix:** per-formula `Vec<Rect>` precedent rectangles + per-sheet interval index for the reverse
direction, mirroring the stripe pattern; delete the unused engine-side coordinate
DependencyGraph (it is dead code — benches exercise it, users never do; keep IdentityGraph).
Verifier note: single-edit cascades are already O(1) map lookups — the wins are formula-entry
latency, memory, and full-recalc dependency re-extraction, not cascade latency.

#### PERF-15 — Conditional-formatting tick (CONFIRMED, large, medium)
Every 200ms tick recomputes full-range stats per stats rule (TopBottom/ColorScale/DataBar/...)
by probing every coordinate of the rule range while holding the grids Mutex, re-parses identical
threshold formulas per viewport cell, and rebuilds frontend region Maps per tick.
**Fix:** sparse-iteration inversion **per range, not over the union** (overlap multiplicity is
load-bearing for duplicate counts — verifier amendment); viewport-intersection guard; hoist
parsed thresholds. Volatile detection for skip-if-unchanged must be a small hand-rolled
EngineExpr walk (no volatility infra exists yet).

#### PERF-17 — DataValidation refresh (CONFIRMED, moderate, medium)
The cellEvents subscription claims store-side debouncing that does not exist; one commit with N
dependents fires N+1 un-debounced IPC round-trips, and with Circle Invalid Data active, N+1 full
sheet scans **holding the grids mutex the calc path needs** — real recalc-latency contention.
**Fix:** 200ms trailing debounce (mirror cfStore.ts:147-163); value-only edits skip rule refetch;
hoist per-range invariants in get_invalid_cells (resolve list source once, uppercased HashSet).

#### PERF-10 — Number-format parse cache (PARTLY -> amended, moderate, low)
Custom formats are re-parsed per touched cell per recalc (custom_format.rs:1845/1857).
**Fix:** `OnceLock<RwLock<HashMap<String, Arc<Result<ParsedCustomFormat,String>>>>>` keyed on the
exact format string, ~4096 cap. Cache the Err case too. Parse is locale-independent (locale only
affects apply), so hits are bit-identical.

### Wave 3 — structural (do after Waves 0-2 prove out)

#### PERF-18 — Per-column ordered index for whole-column refs (CONFIRMED, large, medium)
eval_column_ref/eval_row_ref scan the ENTIRE cell map and sort, per reference per evaluation
(500k-cell sheet x 200 A:A formulas = 100M filter iterations per recalc).
**Fix:** `FxHashMap<u32, BTreeSet<u32>>` (col -> populated rows) maintained in Grid.
**Precondition:** encapsulate the ~45-60 real direct `.cells` mutation sites (verifier corrected
the count from 114 — many hits are other structs) behind Grid methods, or key a lazily-rebuilt
cache on a grid generation counter.

#### PERF-21 — Numeric coordinates in the AST (CONFIRMED, moderate, medium)
CellRef stores `col: String`; every evaluation re-runs col_to_index (26 sites in evaluator.rs),
and eval_range clones endpoint Strings just to discard them. Store 0-based u32 coords computed
once at parse; render derives letters via index_to_col. ~30 match sites change; persistence is
formula strings, so no format impact. Immediate zero-risk slice: borrow &str in eval_range.

#### PERF-13 — Box the Lambda payload (PARTLY -> amended, small, low)
Actual sizes (verifier-measured): EvalResult 80B (not 88), Cell 64B, map slot 72B. Boxing
Lambda's payload still shrinks EvalResult 80 -> 32B = 2.5x less traffic through every range
materialization. Add `const _: () = assert!(size_of::<EvalResult>() <= 32)`.
Becomes less critical once PERF-04's RangeView eliminates most materialization.

#### PERF-19 — Volatile tracking (PARTLY, small, medium — correctness item, costs perf)
See Correctness bug 3. Volatile-cell set unioned into cascade roots in automatic mode.
Explicitly NOT a perf win — it adds per-edit work; do it for correctness, sized by the
volatile closure, never via full recalc per edit.

#### PERF-22 — Bench coverage as the gate (CONFIRMED, moderate, low)
The suite has no lookup/criteria/parse benches, recalc_cascade measures the UNUSED engine
DependencyGraph, and the harness cannot resolve <2x on this machine.
**Fix:** add lookup (VLOOKUP/MATCH exact+approx over 1k/100k/1M), criteria (SUMIF/COUNTIF text +
wildcard), parse+extract throughput, and an end-to-end recalc bench **in the app crate** against
the real ordering+evaluation path (a core-crate bench cannot reach partition_formula_cells;
verifier amendment). Stabilize: longer measurement_time, pin to performance cores, sample-size
discipline. Every Wave 1-3 item lands with a before/after bench.

---

## 5. Recommended execution order

1. **Wave 0** (each independent, hours-to-days): PERF-01 profiles -> PERF-09 logging ->
   PERF-06(a) tail fix -> PERF-06(b) ordering correctness -> PERF-05 FxHash -> PERF-16 spill ->
   PERF-20 IPC. Wave 0 alone: dev builds get 4.5-15x faster, formatted-sheet recalcs lose
   hundreds of ms of logging overhead, deep-chain edits lose the O(n^2) tail AND become correct.
2. **PERF-22 bench extension** immediately after Wave 0 — it gates everything else.
3. **Wave 1** in order: PERF-12 (small, self-contained) -> PERF-11 (comparators feed the cache) ->
   PERF-04(a)(b) ownership+bulk-read -> PERF-03 lookup cache -> PERF-14 criteria index ->
   PERF-04(c) RangeView last (largest blast radius, gate on soak corpus).
4. **Wave 2**: PERF-02 -> PERF-08 -> PERF-10 -> PERF-07 -> PERF-15 -> PERF-17.
5. **Wave 3** as profiling justifies.

## 5b. Implementation status

**Wave 0 implemented 2026-07-13** (all six items):

- **PERF-01**: `[profile.dev.package."*"] opt-level = 2` + engine/parser at 3 in
  `app/src-tauri/Cargo.toml`; per-member mirrors + `[profile.release] lto="thin",
  codegen-units=1` in `core/Cargo.toml`. No `panic="abort"` anywhere.
- **PERF-09**: per user request, debug logging is DISABLED not removed — all D-level
  macros (`log_debug!`/`log_enter!`/`log_exit!`) check a `static AtomicBool` BEFORE
  evaluating format args (one relaxed load per disabled site, app-wide). Re-enable via
  the new `set_debug_logging` command or `"debugBackendEnabled": true` in
  `app/log-filter.config.json`. MUTED_* sets converted Mutex -> RwLock.
- **PERF-05**: `rustc-hash` in engine + app. Engine: `Grid.cells` -> `CellMap`
  (FxHashMap), `DependencyGraph` maps, `extract_dependencies` -> `CoordSet`,
  `GridSnapshot.cells`. App: `CoordSet`/`DependencyMap`/`StripeDependentsMap`/
  `StripeDependenciesMap`/`CrossSheetDependent(s|cies)Map` aliases in lib.rs; the
  AppState dependency quintet + extraction + shift helpers converted.
- **PERF-06**: `get_recalculation_order` rewritten as a thin wrapper over the new
  shared `recalc_order_from_seeds(seeds, dependents, include_seeds)` in lib.rs —
  correct Kahn seeding (member->member edges only), deterministic ordering (seeds
  first, sorted zero-degree, sorted cycle leftovers), O(n) cycle append (the O(n^2)
  `Vec::contains` tail is gone). `control_values::multi_root_recalc_order` now
  delegates to it (include_seeds=true). `update_cells_batch` + the fill variant use
  ONE multi-root traversal with batch cells as ordering members — fixes the in-batch
  stale-value bug (pasted formula reading a later-processed pasted cell).
  This also fixes correctness bug #1 (stale cells on depth>=2 edits) for every
  single-cell caller (update_cell, goal seek, solver, scenarios, animation, cube).
- **PERF-16**: `check_spill_protection` — O(1) point probe for single-cell ranges,
  adaptive rect-probe vs map-scan for ranges (u64 area, inverted-range guard).
- **PERF-20**: cascade-recalculated dependents omit the rendered+localized formula
  string when the cascade exceeds `CASCADE_FORMULA_LIMIT` (64) — small cascades are
  byte-identical to before; wide ones skip the render AND the payload. Threaded
  through `reevaluate_formula_cell`, `cascade_cross_sheet_dependents`, batch + fill
  loops, and the control-value recalc.

Verified: `cargo check --all-targets` clean on both workspaces; engine tests 380/380.
(App test run: see session notes; 5 pre-existing failures were already on HEAD.)

**Wave 1 implemented 2026-07-13** (engine-contained; PERF-04(c) RangeView deliberately
deferred as planned):

- **PERF-11 (partial)**: new `core/engine/src/text_cmp.rs` — allocation-free
  case-insensitive `cmp_ci`/`eq_ci`/`eq_ci_folded` (differential-tested against
  `to_uppercase()` over a Unicode edge corpus incl. sharp-s/ligatures/astral chars).
  Replaced at: eval_equal, all four ordering operators, compare_values,
  xlookup_compare, xlookup_values_equal, eval_values_equal, matches_criteria
  (ExactText/TextNotEqual stream Text values with zero allocation). MATCH's wildcard
  pattern normalization hoisted out of its per-row loop. Deferred from PERF-11:
  compiled wildcard patterns, as_text_into buffer reuse, XMATCH changes.
- **PERF-04(a)**: `EvalResult::into_flatten()` (MOVES leaves; mirrors `flatten()` —
  deliberately NOT the List-unpacking `flatten_into`); `eval_flat` and XLOOKUP use it.
  VLOOKUP/HLOOKUP view tables via borrowing `table_row_views` (the extract_2d_rows
  deep-clone is gone; only the matched cell is cloned). Third clones dropped in
  SUMIF/AVERAGEIF/LOOKUP (borrow the range vector when the value range is omitted).
- **PERF-04(b)**: eval_range extracts adaptively — per-coordinate probes when the
  rect is smaller than the populated-cell count, otherwise ONE pass over the sparse
  map into a positional buffer. Output positionally byte-identical.
- **PERF-12**: INDEX over a literal same-sheet range fetches one cell directly —
  O(1) instead of materialize+double-copy. Flat row-major addressing replicated
  exactly (col-overflow WRAP into the next row, 1-D branch ignoring col_num,
  row/col 0 == 1), verified by dedicated quirk tests.
- **PERF-03 (the centerpiece)**: `core/engine/src/lookup_cache.rs` — pass-scoped,
  thread-local index cache with a `PassGuard` RAII scope held by the drivers
  (calculate_now, recalculate_sheet_values, update_cell, update_cells_batch,
  fill_range, recalc_control_dependents_core). Invalidation is AUTOMATIC:
  `Grid::set_cell/clear_cell/clear_region` notify the active cache, which drops
  entries whose watched rectangle contains the write — mid-pass write-back is
  handled without driver discipline (a fill-down writing column D never touches an
  index over A:B). Grids are identified by address (stable within a pass; entries
  die with the guard). Served fast paths, each falling back to the UNCHANGED scan
  when not provably identical:
  - VLOOKUP/HLOOKUP exact over literal TRUE-2D rects (1-D rects keep the legacy
    flat-as-single-row quirk path); three separate equality families implemented
    (values_equal ASCII / eval_values_equal Unicode / xlookup_values_equal with
    no-trim parse cross-typing); numbers in a value-sorted vector probed by strict
    epsilon window with per-candidate verification and smallest-index wins
    (epsilon equality is non-transitive — a bits-keyed hash map would be wrong).
  - VLOOKUP/HLOOKUP approximate + MATCH type 1/-1: binary search ONLY on
    homogeneous (single comparator class, NaN-free) key vectors verified sorted
    under the exact family comparator, probed by a same-class needle — mixed-type,
    unsorted, or cross-class cases keep the scan bit-for-bit (compare_values is
    non-transitive across classes, so pairwise-sortedness alone would NOT make
    binary search safe).
  - MATCH exact (non-wildcard) over 1-D rects, 2-D rects (row-major flat), and
    single whole-column refs (populated-only compacted ordering mirrored).
  - XLOOKUP exact (match_mode 0, search_mode 1) over literal 1-D vectors, with
    direct grid fetch of the return cell and the idx>=return_len -> #N/A bound.
  - XMATCH: untouched (distinct fourth equality family; excluded from v1 per the
    audit verifier).
- **PERF-14 v1**: criteria aggregates in the same cache. COUNTIF served for ALL
  non-wildcard criteria (exact number/text/bool, <> both forms, all Compare ops —
  counts are exact integers, computed via partition_point over the sorted coercible
  values with NaN guards). SUMIF served for ExactText/ExactBool only, with bucket
  sums accumulated in flat order (bit-identical to the scan; numeric/Compare SUMIF
  keeps the scan because reordered float addition would drift the last ulp and
  collide with the soak determinism oracle). SUMIFS/COUNTIFS/AVERAGEIF: scan (v1).
- **PERF-22 (partial)**: three new bench groups — vlookup_exact scan-vs-cached,
  countif scan-vs-cached, vlookup_filldown_1k_lookups (1000 lookups per pass, the
  end-to-end fill-down shape).
- **Safety net**: `lookup_cache_differential_tests` in evaluator.rs — a nasty-grid
  battery (mixed types, case dups, epsilon-near dups, empty-as-0.0, errors,
  Unicode folds, parseable text, whole-column sparsity) asserting cache == scan for
  ~60 formulas across all six functions, plus build-vs-hit equality and mid-pass
  write invalidation. Engine suite: 394 tests green.

## 6. Testing strategy

- Differential property tests: stream comparators vs String::to_uppercase (Unicode edge corpus);
  into_flatten vs flatten; read_range vs eval_range positional equality; index-served lookups vs
  scan-served over randomized grids (mixed types, empties, errors, duplicates, epsilon-near
  numbers) for all four equality families.
- First-match-wins: duplicate-key grids must return identical rows through the cache.
- Sortedness gates: unsorted data must produce byte-identical (garbage) results to today's scans.
- Soak corpus (project regression system) on every Wave 1+ change; recalc-determinism oracle
  re-baselined only for PERF-06(b)'s deliberate ordering fix.
- Bench before/after per item (PERF-22 harness), dev-profile AND release.
