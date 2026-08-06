//! FILENAME: core/engine/src/row_visibility.rs
//! PURPOSE: Per-sheet row-visibility index for the visibility-aware aggregates
//!          (SUBTOTAL 1-11 / 101-111, AGGREGATE options 0-7).
//! CONTEXT: SUBTOTAL and AGGREGATE are the only formula functions whose result
//!          depends on something that is not a cell value: whether a row is
//!          VISIBLE. Excel distinguishes two independent reasons a row can be
//!          invisible, and the two aggregate families read them differently
//!          (see [`HiddenScope`]), so one flat "hidden" set cannot express the
//!          semantics — the index carries both notions, per sheet.
//!
//! WHY PER SHEET: `SUBTOTAL(109, Sheet2!A1:A10)` must consult SHEET2's hidden
//! rows. The evaluator resolves a range's grid per-sheet, so a sheet-blind set
//! would filter Sheet2's values through the active sheet's hidden rows — a
//! different wrong answer, not a fix. Keys are UPPERCASED sheet names, matching
//! `MultiSheetContext`'s case-insensitive grid lookup, and the evaluator
//! resolves a reference's key with the SAME fallback rule `get_grid_for_sheet`
//! uses, so the visibility set and the grid can never come from different
//! sheets. There is NO fallback across sheets: a sheet with no entry has
//! nothing hidden.
//!
//! WHY PASS-SCOPED: the index is built once per recalculation pass and shared,
//! never rebuilt per formula. The thread-local [`VisibilityPassGuard`] mirrors
//! `lookup_cache::PassGuard` exactly — a recalc driver installs the snapshot
//! next to `begin_lookup_pass()` and every `EvalContext` built inside that
//! scope sees it without threading a parameter through ~20 call sites. No
//! guard => `active()` is None => the aggregates behave as if nothing is
//! hidden (their pre-index behavior).
//!
//! COLUMNS ARE DELIBERATELY ABSENT: SUBTOTAL and AGGREGATE are row-oriented.
//! Microsoft's AGGREGATE reference is explicit that hiding COLUMNS in a
//! horizontal range does not affect the result. Do not add a column notion here
//! to "complete" the type.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Which of the two hidden notions exclude a row from an aggregate.
///
/// The mapping to Excel's function/option numbers lives in the evaluator; this
/// enum is just the predicate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HiddenScope {
    /// Only rows hidden by a FILTER are excluded. Rows the user hid by hand
    /// (or collapsed with an outline) still count.
    /// SUBTOTAL 1-11; AGGREGATE options 0, 2, 4, 6.
    FilterOnly,
    /// Rows hidden by a filter OR by hand OR by a collapsed outline group are
    /// all excluded.
    /// SUBTOTAL 101-111; AGGREGATE options 1, 3, 5, 7.
    FilterAndManual,
}

/// The hidden rows of ONE sheet, split by authority.
///
/// The two sets are independent — a row can be in both (hand-hidden and then
/// filtered out), and clearing one authority never clears the other. That is
/// the same union discipline the app's `collect_hidden_rows_for_sheet` uses;
/// this type simply refrains from collapsing the two before the evaluator has
/// had a chance to tell them apart.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SheetRowVisibility {
    /// Rows hidden by an AutoFilter or an applied advanced filter.
    pub filter_hidden: HashSet<u32>,
    /// Rows hidden by hand, or by a collapsed outline group. Excel's SUBTOTAL
    /// documentation calls these "manually hidden"; a collapsed outline row is
    /// hidden by the Hide Rows mechanism and behaves identically (this is what
    /// makes `SUBTOTAL(9, ...)` still count the detail rows of a collapsed
    /// group, which is the entire point of the automatic-subtotals feature).
    pub user_hidden: HashSet<u32>,
}

impl SheetRowVisibility {
    pub fn new(filter_hidden: HashSet<u32>, user_hidden: HashSet<u32>) -> Self {
        SheetRowVisibility {
            filter_hidden,
            user_hidden,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.filter_hidden.is_empty() && self.user_hidden.is_empty()
    }

    /// Is 0-indexed `row` excluded under `scope`?
    #[inline]
    pub fn is_hidden(&self, row: u32, scope: HiddenScope) -> bool {
        match scope {
            HiddenScope::FilterOnly => self.filter_hidden.contains(&row),
            HiddenScope::FilterAndManual => {
                self.filter_hidden.contains(&row) || self.user_hidden.contains(&row)
            }
        }
    }
}

/// The workbook-wide index: UPPERCASED sheet name -> that sheet's hidden rows.
///
/// The empty-string key is the entry used when the evaluator has no multi-sheet
/// context at all (a bare `Evaluator::new(&grid)` — single-grid evaluation, and
/// the shape most engine unit tests use). Build those with [`Self::single_sheet`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RowVisibility {
    by_sheet: HashMap<String, SheetRowVisibility>,
}

impl RowVisibility {
    pub fn new() -> Self {
        RowVisibility::default()
    }

    /// Index for a single unnamed grid (no multi-sheet context).
    pub fn single_sheet(filter_hidden: HashSet<u32>, user_hidden: HashSet<u32>) -> Self {
        let mut index = RowVisibility::default();
        index.insert(
            "",
            SheetRowVisibility::new(filter_hidden, user_hidden),
        );
        index
    }

    /// Registers (or replaces) one sheet's hidden rows. `sheet_name` is
    /// uppercased here so callers never have to remember the key convention.
    pub fn insert(&mut self, sheet_name: &str, visibility: SheetRowVisibility) {
        self.by_sheet
            .insert(sheet_name.to_uppercase(), visibility);
    }

    /// Builder form of [`Self::insert`].
    pub fn with_sheet(mut self, sheet_name: &str, visibility: SheetRowVisibility) -> Self {
        self.insert(sheet_name, visibility);
        self
    }

    /// The entry for an already-resolved key (see module docs: the key must
    /// come from the same resolution the grid came from). No cross-sheet
    /// fallback: an unknown sheet has nothing hidden.
    #[inline]
    pub fn sheet(&self, key: &str) -> Option<&SheetRowVisibility> {
        self.by_sheet.get(key)
    }

    /// Is 0-indexed `row` of the sheet at `key` excluded under `scope`?
    #[inline]
    pub fn is_hidden(&self, key: &str, row: u32, scope: HiddenScope) -> bool {
        self.by_sheet
            .get(key)
            .is_some_and(|v| v.is_hidden(row, scope))
    }

    /// True when no sheet in the index hides anything. Lets the evaluator skip
    /// the visibility walk entirely on the overwhelmingly common workbook.
    pub fn is_empty(&self) -> bool {
        self.by_sheet.values().all(|v| v.is_empty())
    }

    pub fn sheet_count(&self) -> usize {
        self.by_sheet.len()
    }
}

// ============================================================================
// Pass scope
// ============================================================================

thread_local! {
    /// Cheap "is anything installed" probe, so the hot path costs one
    /// thread-local bool load (same trick as lookup_cache::ACTIVE_FLAG).
    static ACTIVE_FLAG: Cell<bool> = const { Cell::new(false) };
    static ACTIVE: RefCell<Option<Arc<RowVisibility>>> = const { RefCell::new(None) };
}

/// RAII scope holding the row-visibility snapshot for one recalculation pass.
///
/// Unlike `lookup_cache::PassGuard` (where a nested guard is a no-op because
/// the cache is pure memoization), this guard SAVES AND RESTORES: a nested pass
/// that installs a different snapshot must win for its own duration, because
/// the snapshot is an ANSWER, not a cache. Dropping restores whatever was
/// installed before.
pub struct VisibilityPassGuard {
    previous: Option<Arc<RowVisibility>>,
}

/// Installs `index` for the current thread until the returned guard drops.
/// Call once per recalculation pass, next to `begin_lookup_pass()`.
pub fn begin_pass(index: Arc<RowVisibility>) -> VisibilityPassGuard {
    let previous = ACTIVE.with(|a| a.borrow_mut().replace(index));
    ACTIVE_FLAG.set(true);
    VisibilityPassGuard { previous }
}

impl Drop for VisibilityPassGuard {
    fn drop(&mut self) {
        let restored = self.previous.take();
        let still_active = restored.is_some();
        ACTIVE.with(|a| *a.borrow_mut() = restored);
        ACTIVE_FLAG.set(still_active);
    }
}

/// The snapshot installed for the current pass, or None outside any pass.
#[inline]
pub fn active() -> Option<Arc<RowVisibility>> {
    if !ACTIVE_FLAG.get() {
        return None;
    }
    ACTIVE.with(|a| a.borrow().clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(rows: &[u32]) -> HashSet<u32> {
        rows.iter().copied().collect()
    }

    #[test]
    fn filter_only_scope_ignores_user_hidden_rows() {
        let v = SheetRowVisibility::new(set(&[1]), set(&[2]));
        assert!(v.is_hidden(1, HiddenScope::FilterOnly));
        assert!(!v.is_hidden(2, HiddenScope::FilterOnly));
        assert!(!v.is_hidden(3, HiddenScope::FilterOnly));
    }

    #[test]
    fn filter_and_manual_scope_takes_the_union() {
        let v = SheetRowVisibility::new(set(&[1]), set(&[2]));
        assert!(v.is_hidden(1, HiddenScope::FilterAndManual));
        assert!(v.is_hidden(2, HiddenScope::FilterAndManual));
        assert!(!v.is_hidden(3, HiddenScope::FilterAndManual));
    }

    #[test]
    fn sheet_keys_are_case_insensitive() {
        let index = RowVisibility::new()
            .with_sheet("Sheet2", SheetRowVisibility::new(set(&[4]), HashSet::new()));
        assert!(index.is_hidden("SHEET2", 4, HiddenScope::FilterOnly));
        assert!(index.sheet("SHEET2").is_some());
    }

    #[test]
    fn unknown_sheet_hides_nothing_no_cross_sheet_fallback() {
        let index = RowVisibility::new()
            .with_sheet("Sheet1", SheetRowVisibility::new(set(&[0, 1, 2]), HashSet::new()));
        // The very bug that blocked the flat-set fix: Sheet2 must not inherit
        // Sheet1's hidden rows, and neither must the unnamed default entry.
        assert!(!index.is_hidden("SHEET2", 0, HiddenScope::FilterAndManual));
        assert!(!index.is_hidden("", 0, HiddenScope::FilterAndManual));
    }

    #[test]
    fn single_sheet_registers_the_unnamed_key() {
        let index = RowVisibility::single_sheet(set(&[7]), set(&[8]));
        assert!(index.is_hidden("", 7, HiddenScope::FilterOnly));
        assert!(index.is_hidden("", 8, HiddenScope::FilterAndManual));
        assert!(!index.is_hidden("", 8, HiddenScope::FilterOnly));
    }

    #[test]
    fn is_empty_is_true_only_when_every_sheet_hides_nothing() {
        assert!(RowVisibility::new().is_empty());
        assert!(RowVisibility::new()
            .with_sheet("A", SheetRowVisibility::default())
            .is_empty());
        assert!(!RowVisibility::new()
            .with_sheet("A", SheetRowVisibility::new(set(&[1]), HashSet::new()))
            .is_empty());
        assert!(!RowVisibility::new()
            .with_sheet("A", SheetRowVisibility::new(HashSet::new(), set(&[1])))
            .is_empty());
    }

    #[test]
    fn no_guard_means_no_active_snapshot() {
        assert!(active().is_none());
    }

    #[test]
    fn pass_guard_installs_and_removes_the_snapshot() {
        assert!(active().is_none());
        {
            let _g = begin_pass(Arc::new(RowVisibility::single_sheet(set(&[3]), HashSet::new())));
            let idx = active().expect("snapshot installed");
            assert!(idx.is_hidden("", 3, HiddenScope::FilterOnly));
        }
        assert!(active().is_none());
    }

    #[test]
    fn nested_pass_guard_wins_then_restores_the_outer_snapshot() {
        let outer = Arc::new(RowVisibility::single_sheet(set(&[1]), HashSet::new()));
        let inner = Arc::new(RowVisibility::single_sheet(set(&[2]), HashSet::new()));
        let _o = begin_pass(outer);
        assert!(active().unwrap().is_hidden("", 1, HiddenScope::FilterOnly));
        {
            let _i = begin_pass(inner);
            let a = active().unwrap();
            assert!(a.is_hidden("", 2, HiddenScope::FilterOnly));
            assert!(!a.is_hidden("", 1, HiddenScope::FilterOnly));
        }
        // Outer snapshot restored, not dropped.
        let a = active().unwrap();
        assert!(a.is_hidden("", 1, HiddenScope::FilterOnly));
        assert!(!a.is_hidden("", 2, HiddenScope::FilterOnly));
    }
}
