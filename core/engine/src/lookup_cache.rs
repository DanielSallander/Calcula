//! FILENAME: core/engine/src/lookup_cache.rs
//! PURPOSE: Pass-scoped lookup/criteria index cache (PERF-03 / PERF-14).
//!
//! N lookup formulas over an M-row table cost O(N*M) when each call re-scans
//! its range. This cache lets the lookup family (VLOOKUP/HLOOKUP/MATCH/
//! XLOOKUP) and the criteria family (COUNTIF/SUMIF) build ONE index per
//! (grid, range, semantics-family) per recalculation pass and answer every
//! subsequent call in O(log M) or O(1) — O(N+M) total.
//!
//! DESIGN CONSTRAINTS (all load-bearing):
//! - Pass-scoped, thread-local. A recalc driver holds a [`PassGuard`] for the
//!   duration of one pass; the cache exists only inside that scope. No guard →
//!   `with_active` returns None → callers use their unchanged scan paths.
//!   This bounds the invalidation problem to a single mechanism (below) and
//!   means correctness never depends on driver discipline beyond "hold the
//!   guard around evaluation".
//! - Invalidation is automatic: `Grid::set_cell`/`clear_cell`/`clear_region`
//!   call [`notify_write`], which drops every entry whose watched rectangle
//!   contains the written coordinate. Mid-pass result write-back therefore
//!   invalidates exactly the indexes it could affect (a fill-down writing
//!   column D never touches an index over A:B; a formula writing INTO its own
//!   lookup range degrades to a rebuild per call — today's cost, never a
//!   stale answer). Coordinates are compared sheet-agnostically, which can
//!   only over-invalidate, never under-invalidate.
//! - Grids are identified by address (`&Grid as *const _ as usize`). Within a
//!   pass no structural mutation occurs, so addresses are stable; entries die
//!   with the guard, so no cross-pass reuse of a dangling identity.
//! - Exact-match semantics are ONE predicate for the whole lookup family —
//!   `Evaluator::exact_lookup_equal`, which is the `=` operator's own ladder.
//!   [`ExactIndex`] implements exactly that and nothing else; it used to mirror
//!   three per-function predicates "bug-for-bug", and the bugs it mirrored were
//!   real (see that struct's doc). Numbers still live in a value-sorted vector
//!   rather than a bit-keyed hash map so that first-match-wins is decided by
//!   smallest flat index across an equal run, and so -0.0 and 0.0 — equal
//!   numbers with different bits — cannot land in different buckets.
//! - Approximate (sorted) modes only use binary search when the key vector is
//!   HOMOGENEOUS (one comparator class) and verified sorted under that exact
//!   comparator; anything else reports [`SortedKeys::Unusable`] and the caller
//!   keeps its linear scan, preserving garbage-in behavior on unsorted or
//!   mixed-type data byte-for-byte.

use std::cell::{Cell, RefCell};

use rustc_hash::FxHashMap;

use crate::evaluator::EvalResult;

// ============================================================================
// Keys
// ============================================================================

/// Closed rectangle of 0-based grid coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Rect {
    pub min_row: u32,
    pub max_row: u32,
    pub min_col: u32,
    pub max_col: u32,
}

impl Rect {
    #[inline]
    pub fn contains(&self, row: u32, col: u32) -> bool {
        row >= self.min_row && row <= self.max_row && col >= self.min_col && col <= self.max_col
    }

    #[inline]
    pub fn intersects(&self, other: &Rect) -> bool {
        self.min_row <= other.max_row
            && other.min_row <= self.max_row
            && self.min_col <= other.max_col
            && other.min_col <= self.max_col
    }
}

// THERE IS NO `EqFamily` ANY MORE, and its absence is the point.
//
// It used to carry three variants — `Vlookup`, `Match`, `Xlookup` — one per
// hand-written equality predicate in the evaluator, "mirrored bug-for-bug".
// Mirroring three predicates faithfully is only useful while there ARE three,
// and there should never have been: `Evaluator::exact_lookup_equal` is now the
// single exact-match rule for VLOOKUP/HLOOKUP/LOOKUP/MATCH/XLOOKUP/SWITCH, so
// the cache has one family, which is no family at all.
//
// Consequences that fell out of the collapse, all wanted:
//   - NO EPSILON WINDOW. The old `window_radius` (1e-10 / 0.0 / f64::EPSILON)
//     existed only because two of the three predicates had a tolerance. Number
//     equality is `==`, so the "window" is the single value and
//     `partition_point` lands directly on it.
//   - NO CROSS-TYPING. Only `Xlookup` parsed text keys into the number vector.
//     Excel never matches a lookup value against a different type, so the
//     `source_was_text` bookkeeping is gone with it.
//   - ONE FOLD. `Vlookup` folded ASCII-only; the other two folded Unicode.
//     Everything folds Unicode now, which is what `text_cmp::eq_ci` does.
//   - ONE CACHE ENTRY per range instead of three. A sheet where VLOOKUP and
//     MATCH read the same key column now builds the index once.

/// Comparator family for sorted (approximate) modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CmpFamily {
    /// `compare_values`: Number-Number numeric; Text-Text case-insensitive;
    /// mixed classes have constant/degenerate results. Homogeneous classes are
    /// strict variants: all `Number` or all `Text`. (VLOOKUP/HLOOKUP approx.)
    CompareValues,
    /// `xlookup_compare`: both sides `as_number()`-coercible -> numeric
    /// compare; else case-insensitive compare of `as_text()` forms.
    /// Homogeneous classes: all coercible (no NaN) or all non-coercible.
    /// (MATCH type 1 / -1.)
    XlookupCompare,
}

/// Which vector of a range an index is built over, and how it is materialized.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Axis {
    /// One full column of a rect, absent cells materialized as `Blank`.
    RectCol(u32),
    /// One full row of a rect, absent cells materialized as `Blank`.
    RectRow(u32),
    /// The whole rect flattened row-major (absent -> `Blank`).
    RectFlat,
    /// A whole-column reference: populated cells only, ascending row order.
    WholeCol(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntryKind {
    /// No family field: there is ONE exact-match predicate, so VLOOKUP, MATCH
    /// and XLOOKUP over the same vector share one entry.
    Exact { axis: Axis },
    Sorted { family: CmpFamily, axis: Axis, descending: bool },
    /// Criteria aggregates; `value` is the paired sum-range rect (SUMIF) if any.
    Criteria { axis: Axis, value: Option<Rect> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EntryKey {
    /// Address of the Grid the index was built from (stable within a pass).
    pub grid: usize,
    /// The range the key vector lives in (also the primary invalidation rect).
    pub rect: Rect,
    pub kind: EntryKind,
}

// ============================================================================
// Exact-match index
// ============================================================================

/// First-match exact index over one materialized key vector.
/// Flat indices are positions in that vector; "first match wins" = smallest.
///
/// THE PREDICATE IT IMPLEMENTS IS `Evaluator::exact_lookup_equal`, and every
/// structural choice below is that predicate and nothing else: numbers keyed by
/// exact value, text keyed by its Unicode uppercase fold, booleans keyed by the
/// bit, and never a comparison across those three. A number needle can only
/// reach the number vector, a text needle only the folded map, a boolean needle
/// only `bools` — which is how "a lookup value of a different type never
/// matches" becomes a property of the data structure rather than a rule someone
/// has to remember to re-check here.
pub struct ExactIndex {
    /// Unicode-uppercase-folded text -> smallest flat index.
    text: FxHashMap<Box<str>, u32>,
    /// (value, flat index) sorted by value; NaNs excluded — a NaN is not equal
    /// to itself, so it can never be a first match.
    numbers: Vec<(f64, u32)>,
    /// smallest flat index holding Boolean(false) / Boolean(true).
    bools: [Option<u32>; 2],
}

impl ExactIndex {
    pub fn build(values: &[EvalResult]) -> Self {
        let mut text: FxHashMap<Box<str>, u32> = FxHashMap::default();
        let mut numbers: Vec<(f64, u32)> = Vec::new();
        let mut bools: [Option<u32>; 2] = [None, None];

        for (i, v) in values.iter().enumerate() {
            let i = i as u32;
            match v {
                EvalResult::Number(n) => {
                    if !n.is_nan() {
                        numbers.push((*n, i));
                    }
                }
                EvalResult::Text(s) => {
                    text.entry(s.to_uppercase().into_boxed_str()).or_insert(i);
                }
                EvalResult::Boolean(b) => {
                    let slot = &mut bools[*b as usize];
                    if slot.is_none() {
                        *slot = Some(i);
                    }
                }
                // Errors/arrays/lists/dicts/lambdas — and BLANK, which
                // `exact_lookup_equal` gives no rung, so it matches nothing.
                _ => {}
            }
        }
        // No NaNs inserted, so this comparator is total.
        numbers.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        ExactIndex { text, numbers, bools }
    }

    /// Smallest flat index whose value is `exact_lookup_equal` to `needle`.
    /// Returns None when nothing matches — a DEFINITIVE no-match (the caller
    /// maps it to its usual #N/A / if_not_found handling, not to a scan).
    pub fn first_match(&self, needle: &EvalResult) -> Option<u32> {
        match needle {
            EvalResult::Number(x) => self.number_min(*x),
            EvalResult::Text(s) => self.text.get(s.to_uppercase().as_str()).copied(),
            EvalResult::Boolean(b) => self.bools[*b as usize],
            // Error needles are handled by callers before probing; every other
            // variant (Blank included) compares false against everything.
            _ => None,
        }
    }

    /// Smallest flat index among number entries EXACTLY equal to `x`.
    /// `partition_point` lands on the first entry not below `x`; the loop stops
    /// at the first entry above it, so it visits only the equal run.
    fn number_min(&self, x: f64) -> Option<u32> {
        if x.is_nan() {
            return None;
        }
        let lo = self.numbers.partition_point(|e| e.0 < x);
        let mut best: Option<u32> = None;
        for e in &self.numbers[lo..] {
            if e.0 > x {
                break;
            }
            best = Some(match best {
                Some(b) => b.min(e.1),
                None => e.1,
            });
        }
        best
    }
}

// ============================================================================
// Sorted keys (approximate modes)
// ============================================================================

/// Verified-sorted, homogeneous key vector for binary approximate matching.
/// `Unusable` = mixed classes, NaNs, or not sorted under the family comparator
/// in the requested direction — callers keep their linear scan.
pub enum SortedKeys {
    Numbers(Vec<f64>),
    /// Folded (uppercased) text keys; ordering via `Ord` on the folded strings
    /// equals `text_cmp::cmp_ci` on the originals.
    Texts(Vec<Box<str>>),
    Unusable,
}

impl SortedKeys {
    /// Classify + fold + verify sortedness in one pass.
    pub fn build(family: CmpFamily, values: &[EvalResult], descending: bool) -> Self {
        // Classify.
        enum Class {
            Numbers(Vec<f64>),
            Texts(Vec<Box<str>>),
        }
        let class = match family {
            CmpFamily::CompareValues => {
                if values.iter().all(|v| matches!(v, EvalResult::Number(n) if !n.is_nan())) {
                    Class::Numbers(
                        values
                            .iter()
                            .map(|v| match v {
                                EvalResult::Number(n) => *n,
                                _ => unreachable!(),
                            })
                            .collect(),
                    )
                } else if values.iter().all(|v| matches!(v, EvalResult::Text(_))) {
                    Class::Texts(
                        values
                            .iter()
                            .map(|v| match v {
                                EvalResult::Text(s) => s.to_uppercase().into_boxed_str(),
                                _ => unreachable!(),
                            })
                            .collect(),
                    )
                } else {
                    return SortedKeys::Unusable;
                }
            }
            CmpFamily::XlookupCompare => {
                let coerced: Vec<Option<f64>> = values.iter().map(|v| v.as_number()).collect();
                if coerced.iter().all(|c| matches!(c, Some(n) if !n.is_nan())) {
                    Class::Numbers(coerced.into_iter().map(|c| c.unwrap()).collect())
                } else if coerced.iter().all(|c| c.is_none()) {
                    Class::Texts(
                        values
                            .iter()
                            .map(|v| v.as_text().to_uppercase().into_boxed_str())
                            .collect(),
                    )
                } else {
                    return SortedKeys::Unusable;
                }
            }
        };

        // Verify monotonicity in the requested direction.
        match class {
            Class::Numbers(v) => {
                let ok = if descending {
                    v.windows(2).all(|w| w[0] >= w[1])
                } else {
                    v.windows(2).all(|w| w[0] <= w[1])
                };
                if ok {
                    SortedKeys::Numbers(v)
                } else {
                    SortedKeys::Unusable
                }
            }
            Class::Texts(v) => {
                let ok = if descending {
                    v.windows(2).all(|w| w[0] >= w[1])
                } else {
                    v.windows(2).all(|w| w[0] <= w[1])
                };
                if ok {
                    SortedKeys::Texts(v)
                } else {
                    SortedKeys::Unusable
                }
            }
        }
    }

    /// Ascending keys: rightmost index with key <= needle (None if none).
    /// Equals the scan "keep last <=, break on first >" on sorted data.
    pub fn rightmost_le_number(&self, x: f64) -> Option<usize> {
        match self {
            SortedKeys::Numbers(v) => {
                let n = v.partition_point(|k| *k <= x);
                if n == 0 { None } else { Some(n - 1) }
            }
            _ => None,
        }
    }

    pub fn rightmost_le_text(&self, folded_needle: &str) -> Option<usize> {
        match self {
            SortedKeys::Texts(v) => {
                let n = v.partition_point(|k| k.as_ref() <= folded_needle);
                if n == 0 { None } else { Some(n - 1) }
            }
            _ => None,
        }
    }

    /// Descending keys: rightmost index with key >= needle (None if none).
    pub fn rightmost_ge_number(&self, x: f64) -> Option<usize> {
        match self {
            SortedKeys::Numbers(v) => {
                let n = v.partition_point(|k| *k >= x);
                if n == 0 { None } else { Some(n - 1) }
            }
            _ => None,
        }
    }

    pub fn rightmost_ge_text(&self, folded_needle: &str) -> Option<usize> {
        match self {
            SortedKeys::Texts(v) => {
                let n = v.partition_point(|k| k.as_ref() >= folded_needle);
                if n == 0 { None } else { Some(n - 1) }
            }
            _ => None,
        }
    }

    pub fn is_numbers(&self) -> bool {
        matches!(self, SortedKeys::Numbers(_))
    }

    pub fn is_texts(&self) -> bool {
        matches!(self, SortedKeys::Texts(_))
    }
}

// ============================================================================
// Criteria aggregates (COUNTIF / SUMIF)
// ============================================================================

/// Per-range aggregates serving the criteria family. Counts are exact
/// integers (no float-order concerns); sums are accumulated in flat (build)
/// order, which is bit-identical to the scan's accumulation order.
pub struct CriteriaIndex {
    /// to_uppercase(as_text(v)) -> count. Every element has a text form.
    text_counts: FxHashMap<Box<str>, u32>,
    /// Per text bucket: sum of paired values in flat order (only built when a
    /// paired value vector is supplied).
    text_sums: FxHashMap<Box<str>, f64>,
    /// as_number()-coercible values, sorted (NaNs excluded — they match no
    /// numeric criteria).
    numbers: Vec<f64>,
    /// Per-boolean counts, indexed by `false`/`true`. (The comment that used
    /// to sit here described NaN coercion counts and a field that does not
    /// exist; NaNs are excluded from `numbers` above, which is where that rule
    /// actually lives.)
    bools: [u32; 2],
    bool_sums: [f64; 2],
    len: u32,
    /// BLANK CELLS, counted but never bucketed.
    ///
    /// A blank matches no ordinary criteria — not `0`, not `""`, not
    /// `"<>apple"` — so it must not appear in `numbers` (where it would be a
    /// zero) nor in `text_counts` (where it would be an empty-string bucket).
    /// But `count_text_not_equal` is computed as a COMPLEMENT of `len`, so the
    /// blanks have to be subtracted back out there, and that needs their count.
    /// The three criteria that DO match a blank (`""`, `"="`, `"<>"`) are
    /// refused by `criteria_count_cached` and served by the scan instead.
    blanks: u32,
}

impl CriteriaIndex {
    pub fn build(values: &[EvalResult], paired: Option<&[EvalResult]>) -> Self {
        let mut text_counts: FxHashMap<Box<str>, u32> = FxHashMap::default();
        let mut text_sums: FxHashMap<Box<str>, f64> = FxHashMap::default();
        let mut numbers: Vec<f64> = Vec::new();
        let mut bools = [0u32; 2];
        let mut bool_sums = [0f64; 2];

        let mut blanks = 0u32;

        for (i, v) in values.iter().enumerate() {
            // A BLANK IS BUCKETED NOWHERE. It is not the number 0 and not the
            // empty string, and both of those coercions would be applied to it
            // below — `as_text()` gives it `""` and `as_number()` gives it
            // `0.0`, each on purpose for a different caller. Counting it here
            // is what made the cached `COUNTIF(rng,"<=1")` answer one more than
            // the scan.
            if v.is_blank() {
                blanks += 1;
                continue;
            }
            // Text form exists for every variant (mirrors as_text()).
            let folded = v.as_text().to_uppercase().into_boxed_str();
            let paired_num = paired
                .and_then(|p| p.get(i))
                .and_then(|pv| pv.as_sample_number());
            if let Some(n) = paired_num {
                *text_sums.entry(folded.clone()).or_insert(0.0) += n;
            }
            *text_counts.entry(folded).or_insert(0) += 1;

            // `criteria_number`, NOT `as_number`. This index answers a CRITERIA
            // comparison, so it must bucket by the reading `matches_criteria`
            // uses; on `as_number` it read the rich arithmetic spellings, and a
            // text cell saying "5%" would land in `numbers` as 0.05 — counted
            // by `=COUNTIF(rng,0.05)` when the pass cache was live and not
            // counted when it was not. A cached answer that differs from the
            // scanned one is the one bug this cache may never have.
            if let Some(n) = crate::evaluator::criteria_number(v) {
                if !n.is_nan() {
                    numbers.push(n);
                }
            }
            if let EvalResult::Boolean(b) = v {
                bools[*b as usize] += 1;
                if let Some(n) = paired_num {
                    bool_sums[*b as usize] += n;
                }
            }
        }
        numbers.sort_by(|a, b| a.partial_cmp(b).unwrap());
        CriteriaIndex {
            text_counts,
            text_sums,
            numbers,
            bools,
            bool_sums,
            len: values.len() as u32,
            blanks,
        }
    }

    #[inline]
    pub fn len(&self) -> u32 {
        self.len
    }

    pub fn count_exact_number(&self, n: f64) -> u32 {
        self.window_count(n)
    }

    pub fn count_exact_text(&self, folded: &str) -> u32 {
        self.text_counts.get(folded).copied().unwrap_or(0)
    }

    /// `"<>text"` — everything that is not that text AND is not blank. The
    /// blanks are subtracted because they are not in `text_counts` at all, and
    /// a complement of `len` alone would hand every one of them back.
    pub fn count_text_not_equal(&self, folded: &str) -> u32 {
        self.len - self.blanks - self.count_exact_text(folded)
    }

    pub fn count_exact_bool(&self, b: bool) -> u32 {
        self.bools[b as usize]
    }

    /// matches_criteria Compare ops are plain float comparisons over
    /// as_number()-coercible values — exact via partition_point.
    pub fn count_greater(&self, n: f64) -> u32 {
        (self.numbers.len() - self.numbers.partition_point(|v| *v <= n)) as u32
    }

    pub fn count_greater_equal(&self, n: f64) -> u32 {
        (self.numbers.len() - self.numbers.partition_point(|v| *v < n)) as u32
    }

    pub fn count_less(&self, n: f64) -> u32 {
        self.numbers.partition_point(|v| *v < n) as u32
    }

    pub fn count_less_equal(&self, n: f64) -> u32 {
        self.numbers.partition_point(|v| *v <= n) as u32
    }

    /// NotEqual: coercible values with (v-n).abs() >= 1e-10.
    pub fn count_not_equal(&self, n: f64) -> u32 {
        self.numbers.len() as u32 - self.window_count(n)
    }

    pub fn sum_exact_text(&self, folded: &str) -> f64 {
        self.text_sums.get(folded).copied().unwrap_or(0.0)
    }

    pub fn sum_exact_bool(&self, b: bool) -> f64 {
        self.bool_sums[b as usize]
    }

    /// Count of coercible values with |v-n| < 1e-10 (ExactNumber predicate).
    fn window_count(&self, n: f64) -> u32 {
        if n.is_nan() {
            return 0;
        }
        const EPS: f64 = 1e-10;
        let lo = self.numbers.partition_point(|v| *v < n - EPS);
        let mut count = 0u32;
        for v in &self.numbers[lo..] {
            if *v > n + EPS {
                break;
            }
            if (*v - n).abs() < EPS {
                count += 1;
            }
        }
        count
    }
}

// ============================================================================
// The pass cache + thread-local plumbing
// ============================================================================

pub enum Payload {
    Exact(ExactIndex),
    Sorted(SortedKeys),
    Criteria(CriteriaIndex),
}

struct Entry {
    /// Rectangles whose mutation invalidates this entry (key range, and the
    /// paired value range for SUMIF).
    watch: [Option<Rect>; 2],
    payload: Payload,
}

/// Soft cap on distinct indexes per pass — a runaway workbook falls back to
/// scans rather than hoarding memory.
const MAX_ENTRIES: usize = 256;

#[derive(Default)]
pub struct LookupPassCache {
    entries: FxHashMap<EntryKey, Entry>,
}

impl LookupPassCache {
    /// Fetch or build an entry. Returns None when the cache is full and the
    /// key is absent (callers scan). The build closure materializes the
    /// payload; it MUST only read the grid (never write).
    fn get_or_build(
        &mut self,
        key: EntryKey,
        watch: [Option<Rect>; 2],
        build: impl FnOnce() -> Payload,
    ) -> Option<&Payload> {
        if !self.entries.contains_key(&key) {
            if self.entries.len() >= MAX_ENTRIES {
                return None;
            }
            let payload = build();
            self.entries.insert(key, Entry { watch, payload });
        }
        Some(&self.entries[&key].payload)
    }

    pub fn exact(
        &mut self,
        key: EntryKey,
        watch: [Option<Rect>; 2],
        build: impl FnOnce() -> ExactIndex,
    ) -> Option<&ExactIndex> {
        match self.get_or_build(key, watch, || Payload::Exact(build())) {
            Some(Payload::Exact(ix)) => Some(ix),
            _ => None,
        }
    }

    pub fn sorted(
        &mut self,
        key: EntryKey,
        watch: [Option<Rect>; 2],
        build: impl FnOnce() -> SortedKeys,
    ) -> Option<&SortedKeys> {
        match self.get_or_build(key, watch, || Payload::Sorted(build())) {
            Some(Payload::Sorted(sk)) => Some(sk),
            _ => None,
        }
    }

    pub fn criteria(
        &mut self,
        key: EntryKey,
        watch: [Option<Rect>; 2],
        build: impl FnOnce() -> CriteriaIndex,
    ) -> Option<&CriteriaIndex> {
        match self.get_or_build(key, watch, || Payload::Criteria(build())) {
            Some(Payload::Criteria(ci)) => Some(ci),
            _ => None,
        }
    }

    fn invalidate_point(&mut self, row: u32, col: u32) {
        self.entries
            .retain(|_, e| !e.watch.iter().flatten().any(|r| r.contains(row, col)));
    }

    fn invalidate_rect(&mut self, rect: &Rect) {
        self.entries
            .retain(|_, e| !e.watch.iter().flatten().any(|r| r.intersects(rect)));
    }

    #[cfg(test)]
    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }
}

thread_local! {
    static ACTIVE_FLAG: Cell<bool> = const { Cell::new(false) };
    static ACTIVE: RefCell<Option<LookupPassCache>> = const { RefCell::new(None) };
}

/// RAII scope for one recalculation pass. Nested guards are no-ops (the
/// outermost owns the cache), so drivers can guard liberally.
pub struct PassGuard {
    owner: bool,
}

pub fn begin_pass() -> PassGuard {
    ACTIVE.with(|a| {
        let mut slot = a.borrow_mut();
        if slot.is_some() {
            PassGuard { owner: false }
        } else {
            *slot = Some(LookupPassCache::default());
            ACTIVE_FLAG.set(true);
            PassGuard { owner: true }
        }
    })
}

impl Drop for PassGuard {
    fn drop(&mut self) {
        if self.owner {
            ACTIVE.with(|a| *a.borrow_mut() = None);
            ACTIVE_FLAG.set(false);
        }
    }
}

/// Run `f` against the active pass cache, or return None when no pass guard
/// is held (callers then use their unchanged scan paths).
/// The closure must return plain data — never references into the cache — and
/// must not trigger grid writes (which would re-enter the RefCell).
pub fn with_active<R>(f: impl FnOnce(&mut LookupPassCache) -> R) -> Option<R> {
    if !ACTIVE_FLAG.get() {
        return None;
    }
    ACTIVE.with(|a| a.borrow_mut().as_mut().map(f))
}

/// Called by Grid mutators on every cell write. Cheap when no pass is active
/// (one thread-local flag load).
#[inline]
pub fn notify_write(row: u32, col: u32) {
    if !ACTIVE_FLAG.get() {
        return;
    }
    ACTIVE.with(|a| {
        if let Some(cache) = a.borrow_mut().as_mut() {
            cache.invalidate_point(row, col);
        }
    });
}

/// Called by Grid region mutators (clear_region).
#[inline]
pub fn notify_write_rect(min_row: u32, max_row: u32, min_col: u32, max_col: u32) {
    if !ACTIVE_FLAG.get() {
        return;
    }
    let rect = Rect { min_row, max_row, min_col, max_col };
    ACTIVE.with(|a| {
        if let Some(cache) = a.borrow_mut().as_mut() {
            cache.invalidate_rect(&rect);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(x: f64) -> EvalResult {
        EvalResult::Number(x)
    }
    fn t(s: &str) -> EvalResult {
        EvalResult::Text(s.to_string())
    }

    #[test]
    fn exact_index_first_match_wins_and_folds_unicode() {
        // Duplicates: first (smallest index) must win.
        let vals = vec![t("Apple"), n(5.0), t("apple"), n(5.0)];
        let ix = ExactIndex::build(&vals);
        assert_eq!(ix.first_match(&t("APPLE")), Some(0));
        assert_eq!(ix.first_match(&n(5.0)), Some(1));
        assert_eq!(ix.first_match(&n(7.0)), None);
        // UNICODE fold, not ASCII. This case answered None while the index was
        // built for the "Vlookup family", whose fold was `to_ascii_uppercase`,
        // so `=VLOOKUP("STRASSE",…,FALSE)` was #N/A over a cell holding
        // "Straße" while MATCH, XLOOKUP, COUNTIF and `=` all matched it.
        let ix2 = ExactIndex::build(&[t("Straße")]);
        assert_eq!(ix2.first_match(&t("STRASSE")), Some(0));
    }

    /// REWRITTEN. This test used to be `exact_index_epsilon_is_strict_and_
    /// windowed` and asserted that 1.0 MATCHES 1.0 + 0.5e-10 — the VLOOKUP
    /// family's 1e-10 tolerance. That tolerance is gone: exact-match lookup is
    /// the `=` operator's predicate, and `=(1=1.00000000005)` is FALSE.
    ///
    /// OLD expectation: `first_match(1.0)` over `[1.0, 1.0+2e-10, 1.0+0.5e-10]`
    /// matched indices 0 AND 2, returning 0 "because 0 < 2".
    /// NEW expectation: it matches index 0 ONLY.
    #[test]
    fn exact_index_numbers_are_exact_not_windowed() {
        let vals = vec![n(1.0 + 0.5e-10), n(1.0), n(1.0 + 2e-10)];
        let ix = ExactIndex::build(&vals);
        // The needle is at index 1. Under the old 1e-10 window index 0 was
        // also "equal" and, being smaller, WON — a silent wrong row. The order
        // here is deliberate: with the tolerance restored this assertion reads
        // Some(0), so it cannot pass by accident.
        assert_eq!(ix.first_match(&n(1.0)), Some(1));
        assert_eq!(ix.first_match(&n(1.0 + 2e-10)), Some(2));
        // CONTROL: a genuine duplicate still resolves to the smallest index,
        // so "exact" has not been mistaken for "unique".
        let dup = ExactIndex::build(&[n(3.0), n(3.0)]);
        assert_eq!(dup.first_match(&n(3.0)), Some(0));
    }

    /// REWRITTEN. This test used to be `xlookup_cross_typing_matches_number_to_
    /// parseable_text_only` and PINNED the cross-typing as correct. Excel never
    /// matches a lookup value against a different type, and the divergence was
    /// measurable: over {1, "1", TRUE, "apple"},
    /// `=XLOOKUP("1",A1:A4,B1:B4)` returned the row of the NUMBER 1 while
    /// MATCH, VLOOKUP, HLOOKUP and `=` all chose the row of the TEXT "1".
    ///
    /// OLD expectation over `["5.0", 5.0]`: `first_match(5.0)` = Some(0) (the
    /// number needle cross-matched the parseable TEXT) and `first_match("5")` =
    /// Some(1) (the text needle cross-matched the NUMBER).
    /// NEW expectation: Some(1) and None — each needle sees only its own type.
    #[test]
    fn exact_index_never_matches_across_types() {
        let vals = vec![t("5.0"), n(5.0)];
        let ix = ExactIndex::build(&vals);
        // A number needle reaches the number vector only.
        assert_eq!(ix.first_match(&n(5.0)), Some(1));
        // A text needle reaches the folded map only — and "5" is not "5.0".
        assert_eq!(ix.first_match(&t("5")), None);
        // CONTROL: the same text needle spelled exactly does match, so this is
        // a type rule and not "text never matches".
        assert_eq!(ix.first_match(&t("5.0")), Some(0));
        // Booleans are their own class: TRUE is not the number 1.
        let bx = ExactIndex::build(&[n(1.0), EvalResult::Boolean(true)]);
        assert_eq!(bx.first_match(&n(1.0)), Some(0));
        assert_eq!(bx.first_match(&EvalResult::Boolean(true)), Some(1));
    }

    /// THE MIRROR CONTRACT, MECHANISED. The cache exists to answer the same
    /// question as the scan path, faster. Every previous version of that
    /// promise was a doc comment naming an evaluator function, and all three
    /// had drifted from it. This asserts it instead: for a corpus that crosses
    /// every type boundary, the index's answer equals a linear scan under
    /// `Evaluator::exact_lookup_equal` itself.
    ///
    /// WITHOUT THIS, a change to the predicate that forgets the index makes the
    /// SAME formula give two answers depending on whether a recalc pass guard
    /// happened to be held — which is invisible in a unit test (no guard) and
    /// wrong in the app (guard held).
    #[test]
    fn exact_index_answers_exactly_what_the_scan_path_would() {
        use crate::evaluator::Evaluator;
        let corpus = vec![
            n(1.0),
            t("1"),
            EvalResult::Boolean(true),
            t("apple"),
            t("Apple"),
            n(-0.0),
            n(0.0),
            EvalResult::Blank,
            t(""),
            EvalResult::Boolean(false),
            n(2e-300),
            t("Straße"),
            n(5.0),
            t("5.0"),
        ];
        let ix = ExactIndex::build(&corpus);
        let needles = [
            n(1.0),
            t("1"),
            t("STRASSE"),
            t("APPLE"),
            EvalResult::Boolean(true),
            EvalResult::Boolean(false),
            n(0.0),
            n(-0.0),
            n(1e-300),
            n(2e-300),
            n(5.0),
            t("5"),
            t(""),
            EvalResult::Blank,
            n(99.0),
        ];
        for needle in &needles {
            let scanned = corpus
                .iter()
                .position(|v| Evaluator::exact_lookup_equal(needle, v))
                .map(|i| i as u32);
            assert_eq!(
                ix.first_match(needle),
                scanned,
                "index and scan disagree for needle {:?}",
                needle
            );
        }
    }

    #[test]
    fn sorted_keys_reject_mixed_and_unsorted() {
        assert!(matches!(
            SortedKeys::build(CmpFamily::CompareValues, &[n(1.0), t("a")], false),
            SortedKeys::Unusable
        ));
        assert!(matches!(
            SortedKeys::build(CmpFamily::CompareValues, &[n(2.0), n(1.0)], false),
            SortedKeys::Unusable
        ));
        // Booleans are coercible for XlookupCompare but not CompareValues.
        assert!(matches!(
            SortedKeys::build(CmpFamily::CompareValues, &[EvalResult::Boolean(true)], false),
            SortedKeys::Unusable
        ));
        assert!(matches!(
            SortedKeys::build(CmpFamily::XlookupCompare, &[n(1.0), EvalResult::Boolean(true)], false),
            SortedKeys::Numbers(_)
        ));
    }

    #[test]
    fn sorted_rightmost_le_matches_scan_semantics() {
        let sk = SortedKeys::build(
            CmpFamily::CompareValues,
            &[n(1.0), n(3.0), n(3.0), n(7.0)],
            false,
        );
        assert_eq!(sk.rightmost_le_number(3.0), Some(2)); // rightmost duplicate
        assert_eq!(sk.rightmost_le_number(0.5), None);
        assert_eq!(sk.rightmost_le_number(100.0), Some(3));
    }

    /// REWRITTEN 2026-08-24 — the two boolean expectations here were the CACHE
    /// half of `=COUNTIF(rng,1)` counting TRUE. `CriteriaIndex::build` bucketed
    /// through `criteria_number`, which reached `as_number()` and rendered TRUE
    /// as the number 1.
    ///
    /// ```text
    ///                            OLD (asserted)   NEW (asserted)
    ///   count_greater(0.5)             3               2      (5 and "6"; not TRUE)
    ///   count_exact_number(1.0)        1               0      (nothing IS 1)
    /// ```
    ///
    /// The scan path and the cache moved together because the rule lives in
    /// `criteria_number`, which both call — the single reason it was put there
    /// rather than in `matches_criteria`.
    #[test]
    fn criteria_counts_and_sums_mirror_scan() {
        let range = vec![t("a"), t("A"), n(5.0), t("6"), EvalResult::Boolean(true)];
        let paired = vec![n(1.0), n(2.0), n(4.0), n(8.0), n(16.0)];
        let ci = CriteriaIndex::build(&range, Some(&paired));
        assert_eq!(ci.count_exact_text("A"), 2);
        assert_eq!(ci.sum_exact_text("A"), 3.0);
        // "6" is text but coercible — criteria DO read numeric text. TRUE is
        // not a number and is not in the numeric bucket at all.
        assert_eq!(ci.count_greater(0.5), 2); // 5 and "6"
        assert_eq!(ci.count_exact_number(1.0), 0); // TRUE is not 1
        // CONTROL: the boolean bucket still holds it, so `COUNTIF(rng,TRUE)`
        // and `SUMIF(rng,TRUE,…)` are unaffected — this is a type rule, not a
        // disappearance.
        assert_eq!(ci.count_exact_bool(true), 1);
        assert_eq!(ci.sum_exact_bool(true), 16.0);
        assert_eq!(ci.count_text_not_equal("A"), 3);
        assert_eq!(ci.len(), 5);
    }

    #[test]
    fn pass_guard_scopes_and_invalidation() {
        assert!(with_active(|_| ()).is_none());
        {
            let _g = begin_pass();
            let built = with_active(|c| {
                let key = EntryKey {
                    grid: 1,
                    rect: Rect { min_row: 0, max_row: 9, min_col: 0, max_col: 0 },
                    kind: EntryKind::Exact { axis: Axis::RectCol(0) },
                };
                c.exact(key, [Some(key.rect), None], || {
                    ExactIndex::build(&[n(1.0)])
                })
                .is_some()
            });
            assert_eq!(built, Some(true));
            // Write outside the watched rect: entry survives.
            notify_write(5, 3);
            assert_eq!(with_active(|c| c.entry_count()), Some(1));
            // Write inside: entry dropped.
            notify_write(5, 0);
            assert_eq!(with_active(|c| c.entry_count()), Some(0));
            // Nested guard is a no-op owner.
            {
                let _inner = begin_pass();
            }
            assert!(with_active(|_| ()).is_some());
        }
        assert!(with_active(|_| ()).is_none());
    }
}
