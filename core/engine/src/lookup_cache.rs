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
//! - Exact-match semantics differ per function family and are mirrored
//!   bug-for-bug (see [`EqFamily`]). Epsilon number equality is NON-transitive,
//!   so numbers live in a value-sorted vector probed by epsilon window with
//!   per-candidate verification and smallest-flat-index (first-match) wins —
//!   a hash map keyed on bits would be wrong.
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

/// Equality family — one per distinct equality predicate in the evaluator.
/// The fold/epsilon/cross-typing rules here MUST mirror the corresponding
/// evaluator functions exactly (cited per variant).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EqFamily {
    /// `values_equal`: |a-b| < 1e-10; text ASCII-case-insensitive; bool ==;
    /// no cross-typing. (VLOOKUP / HLOOKUP exact.)
    Vlookup,
    /// `eval_values_equal`: |a-b| < 1e-10; text Unicode-uppercase-insensitive;
    /// bool ==; no cross-typing. (MATCH exact.)
    Match,
    /// `xlookup_values_equal`: |a-b| < f64::EPSILON; text Unicode-uppercase-
    /// insensitive; bool ==; PLUS Number<->Text cross-typing where the text
    /// side parses via `str::parse::<f64>()` (NO trim). (XLOOKUP exact.)
    Xlookup,
}

impl EqFamily {
    #[inline]
    fn epsilon(self) -> f64 {
        match self {
            EqFamily::Vlookup | EqFamily::Match => 1e-10,
            EqFamily::Xlookup => f64::EPSILON,
        }
    }

    #[inline]
    fn fold(self, s: &str) -> String {
        match self {
            // eq_ignore_ascii_case(a, b) == (a.to_ascii_uppercase() == b.to_ascii_uppercase())
            EqFamily::Vlookup => s.to_ascii_uppercase(),
            EqFamily::Match | EqFamily::Xlookup => s.to_uppercase(),
        }
    }
}

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
    /// One full column of a rect, absent cells materialized as Number(0.0).
    RectCol(u32),
    /// One full row of a rect, absent cells materialized as Number(0.0).
    RectRow(u32),
    /// The whole rect flattened row-major (absent -> Number(0.0)).
    RectFlat,
    /// A whole-column reference: populated cells only, ascending row order.
    WholeCol(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntryKind {
    Exact { family: EqFamily, axis: Axis },
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
pub struct ExactIndex {
    /// folded text -> smallest flat index.
    text: FxHashMap<Box<str>, u32>,
    /// (value, flat index, source_was_text) sorted by value; NaNs excluded
    /// (they match nothing under any family's epsilon predicate).
    /// `source_was_text` entries exist only for EqFamily::Xlookup (cross-typed
    /// parseable text); they may match a Number needle but not a Text needle
    /// (Text-vs-Text equality goes through the folded map, never parsing).
    numbers: Vec<(f64, u32, bool)>,
    /// smallest flat index holding Boolean(false) / Boolean(true).
    bools: [Option<u32>; 2],
}

impl ExactIndex {
    pub fn build(family: EqFamily, values: &[EvalResult]) -> Self {
        let mut text: FxHashMap<Box<str>, u32> = FxHashMap::default();
        let mut numbers: Vec<(f64, u32, bool)> = Vec::new();
        let mut bools: [Option<u32>; 2] = [None, None];

        for (i, v) in values.iter().enumerate() {
            let i = i as u32;
            match v {
                EvalResult::Number(n) => {
                    if !n.is_nan() {
                        numbers.push((*n, i, false));
                    }
                }
                EvalResult::Text(s) => {
                    text.entry(family.fold(s).into_boxed_str()).or_insert(i);
                    if family == EqFamily::Xlookup {
                        // xlookup_values_equal cross-types via s.parse (no trim).
                        if let Ok(parsed) = s.parse::<f64>() {
                            if !parsed.is_nan() {
                                numbers.push((parsed, i, true));
                            }
                        }
                    }
                }
                EvalResult::Boolean(b) => {
                    let slot = &mut bools[*b as usize];
                    if slot.is_none() {
                        *slot = Some(i);
                    }
                }
                // Errors/arrays/lists/dicts/lambdas match nothing in any family.
                _ => {}
            }
        }
        // No NaNs inserted, so this comparator is total.
        numbers.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        ExactIndex { text, numbers, bools }
    }

    /// Smallest flat index whose value equals `needle` under `family`.
    /// Returns None when nothing matches — a DEFINITIVE no-match (the caller
    /// maps it to its usual #N/A / if_not_found handling, not to a scan).
    pub fn first_match(&self, family: EqFamily, needle: &EvalResult) -> Option<u32> {
        let eps = family.epsilon();
        match needle {
            EvalResult::Number(x) => self.window_min(*x, eps, /*allow_text_sources*/ family == EqFamily::Xlookup),
            EvalResult::Text(s) => {
                let text_hit = self.text.get(family.fold(s).as_str()).copied();
                if family == EqFamily::Xlookup {
                    // A parseable text needle can also match Number cells
                    // (cross-typing) — but never other Text cells via parsing.
                    let num_hit = s
                        .parse::<f64>()
                        .ok()
                        .filter(|p| !p.is_nan())
                        .and_then(|p| self.window_min(p, eps, false));
                    match (text_hit, num_hit) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        (a, b) => a.or(b),
                    }
                } else {
                    text_hit
                }
            }
            EvalResult::Boolean(b) => self.bools[*b as usize],
            // Error needles are handled by callers before probing; every other
            // variant compares false against everything in all families.
            _ => None,
        }
    }

    /// Smallest flat index among number entries within the strict epsilon
    /// window around x. `allow_text_sources` admits cross-typed text entries.
    fn window_min(&self, x: f64, eps: f64, allow_text_sources: bool) -> Option<u32> {
        if x.is_nan() {
            return None;
        }
        let lo = self.numbers.partition_point(|e| e.0 < x - eps);
        let mut best: Option<u32> = None;
        for e in &self.numbers[lo..] {
            if e.0 > x + eps {
                break;
            }
            if (e.0 - x).abs() < eps && (allow_text_sources || !e.2) {
                best = Some(match best {
                    Some(b) => b.min(e.1),
                    None => e.1,
                });
            }
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
    /// Count of coercible values INCLUDING NaN coercions (NotEqual semantics:
    /// (v-n).abs() >= 1e-10 is false for NaN, so NaN never matches — but it IS
    /// coercible; keep both counts to mirror exactly).
    bools: [u32; 2],
    bool_sums: [f64; 2],
    len: u32,
}

impl CriteriaIndex {
    pub fn build(values: &[EvalResult], paired: Option<&[EvalResult]>) -> Self {
        let mut text_counts: FxHashMap<Box<str>, u32> = FxHashMap::default();
        let mut text_sums: FxHashMap<Box<str>, f64> = FxHashMap::default();
        let mut numbers: Vec<f64> = Vec::new();
        let mut bools = [0u32; 2];
        let mut bool_sums = [0f64; 2];

        for (i, v) in values.iter().enumerate() {
            // Text form exists for every variant (mirrors as_text()).
            let folded = v.as_text().to_uppercase().into_boxed_str();
            let paired_num = paired
                .and_then(|p| p.get(i))
                .and_then(|pv| pv.as_number());
            if let Some(n) = paired_num {
                *text_sums.entry(folded.clone()).or_insert(0.0) += n;
            }
            *text_counts.entry(folded).or_insert(0) += 1;

            if let Some(n) = v.as_number() {
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

    pub fn count_text_not_equal(&self, folded: &str) -> u32 {
        self.len - self.count_exact_text(folded)
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
    fn exact_index_first_match_wins_across_epsilon_and_text() {
        // Duplicates: first (smallest index) must win.
        let vals = vec![t("Apple"), n(5.0), t("apple"), n(5.0 + 1e-12)];
        let ix = ExactIndex::build(EqFamily::Vlookup, &vals);
        assert_eq!(ix.first_match(EqFamily::Vlookup, &t("APPLE")), Some(0));
        assert_eq!(ix.first_match(EqFamily::Vlookup, &n(5.0)), Some(1));
        assert_eq!(ix.first_match(EqFamily::Vlookup, &n(7.0)), None);
    }

    #[test]
    fn exact_index_epsilon_is_strict_and_windowed() {
        let vals = vec![n(1.0), n(1.0 + 2e-10), n(1.0 + 0.5e-10)];
        let ix = ExactIndex::build(EqFamily::Vlookup, &vals);
        // 1.0 matches idx 0 and idx 2 (|d| < 1e-10); idx 2 > idx 0 so 0 wins.
        assert_eq!(ix.first_match(EqFamily::Vlookup, &n(1.0)), Some(0));
        // 1.0 + 2e-10 only matches itself.
        assert_eq!(ix.first_match(EqFamily::Vlookup, &n(1.0 + 2e-10)), Some(1));
    }

    #[test]
    fn xlookup_cross_typing_matches_number_to_parseable_text_only() {
        let vals = vec![t("5.0"), n(5.0)];
        let ix = ExactIndex::build(EqFamily::Xlookup, &vals);
        // Number needle matches the parseable text at 0 first (cross-typed).
        assert_eq!(ix.first_match(EqFamily::Xlookup, &n(5.0)), Some(0));
        // Text needle "5" does NOT match Text "5.0" (Text-Text is string
        // equality), but DOES cross-match Number 5.0 at index 1.
        assert_eq!(ix.first_match(EqFamily::Xlookup, &t("5")), Some(1));
        // Vlookup family: no cross-typing at all.
        let ix2 = ExactIndex::build(EqFamily::Vlookup, &vals);
        assert_eq!(ix2.first_match(EqFamily::Vlookup, &t("5")), None);
        assert_eq!(ix2.first_match(EqFamily::Vlookup, &n(5.0)), Some(1));
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

    #[test]
    fn criteria_counts_and_sums_mirror_scan() {
        let range = vec![t("a"), t("A"), n(5.0), t("6"), EvalResult::Boolean(true)];
        let paired = vec![n(1.0), n(2.0), n(4.0), n(8.0), n(16.0)];
        let ci = CriteriaIndex::build(&range, Some(&paired));
        assert_eq!(ci.count_exact_text("A"), 2);
        assert_eq!(ci.sum_exact_text("A"), 3.0);
        // "6" is text but coercible; TRUE coerces to 1.
        assert_eq!(ci.count_greater(0.5), 3); // 5, 6, 1(TRUE)
        assert_eq!(ci.count_exact_number(1.0), 1); // TRUE
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
                    kind: EntryKind::Exact { family: EqFamily::Vlookup, axis: Axis::RectCol(0) },
                };
                c.exact(key, [Some(key.rect), None], || {
                    ExactIndex::build(EqFamily::Vlookup, &[n(1.0)])
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
