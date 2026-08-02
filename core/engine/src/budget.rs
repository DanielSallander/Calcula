//! FILENAME: core/engine/src/budget.rs
//! PURPOSE: The formula evaluator's work budget and cooperative cancellation.
//! CONTEXT: Every OTHER execution surface in Calcula already has a ceiling —
//! QuickJS scripts get a re-armable wall-clock deadline plus a memory cap
//! (core/script-engine/src/limits.rs) and writeback validators are bounded —
//! but expression evaluation had none, so a shallow-but-exponential formula
//! (`fib(35)` as a naive recursive LAMBDA) or a merely enormous one
//! (`MMULT` over two whole columns) wedged the application with no way out.
//! This module supplies both halves of the fix: a deterministic FUEL counter
//! that turns a runaway formula into `#LIMIT!`, and a `CancelToken` that lets
//! a human abandon a legitimate-but-slow recalculation (the Ctrl+Break
//! analogue). They deliberately share ONE amortized check so cancellation
//! costs nothing on top of the budget.
//!
//! ## Why fuel and not a clock
//!
//! A wall-clock budget would make a CELL VALUE a function of machine speed and
//! ambient load: the same workbook would compute differently on CI and on the
//! user's laptop, and the soak/regression oracles (`npm run soak`,
//! `npm run regression`) — which compare recalc results across runs — would go
//! nondeterministic by construction. Fuel exhaustion is not a promise about
//! seconds; it is the promise that `=fib(35)` stops IDENTICALLY everywhere. On
//! a slower machine it takes longer to reach the same stop, but it reaches it,
//! and meanwhile cancellation (which *is* time-shaped) is available the whole
//! way.
//!
//! So: **deterministic work produces values; wall-clock produces buttons.**
//! `deadline` exists on the budget but is `None` on every path that can write
//! a cell. Exactly one class of caller may arm it — the host's
//! `api.evaluate` / `evaluate_expressions` service boundary, whose results
//! cross IPC and are never persisted into a cell (see `set_deadline`).
//!
//! ## Fuel is charged in units of WORK, not AST nodes
//!
//! `=SUMPRODUCT(A:A,B:B)` is three AST nodes and a million multiplications; a
//! node counter would be blind to exactly the "wide, not deep" case. So range
//! materialization, array generation and internally-iterating builtins charge
//! their element count BEFORE they allocate or loop. Charging `n` once at loop
//! entry costs a single add, so the inner loop pays ZERO per element, and an
//! over-budget `MMULT` fails in microseconds instead of grinding through 8e9
//! multiply-adds first.
//!
//! One unit of fuel is roughly "one AST node evaluation". Raw `f64` inner
//! loops and char-grid matching are about an order of magnitude cheaper than
//! that, so they charge through `charge_arith`, which discounts by
//! `ARITH_FUEL_SHIFT`; charging them 1:1 would make MMULT ~16x stricter than
//! the rest of the language for no reason.

use std::cell::Cell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Fuel allowance for ONE top-level formula evaluation.
///
/// Denominated in node-equivalents (see the module docs). The intent is
/// "a couple of seconds of real work on a reference machine" — generous
/// enough that no legitimate formula is collateral damage, small enough that
/// a runaway is caught while the user is still looking at the screen.
///
/// Sanity check against the two motivating workloads:
///   - naive `fib(35)` ~= 29.8M lambda invocations x (LAMBDA_CALL_FUEL + ~7
///     body nodes) ~= 450M charges, so it trips ~14% of the way in;
///   - `fib(28)` (~630k invocations, ~9M charges) still COMPLETES, which is
///     the property that matters — legitimate recursion must not become
///     collateral damage.
pub const DEFAULT_CELL_FUEL: i64 = 64_000_000;

/// Aggregate ceiling for one host call that evaluates a CALLER-SUPPLIED list
/// of expressions (`api.evaluate`, `evaluate_expressions`, `evaluate_scoped`,
/// data-table what-if grids). Per-formula scoping alone would hand a script
/// unlimited total budget simply by passing 100,000 expressions in one call.
/// Not applied to `calculate_now`, where the list is the workbook's own
/// formula cells and a big workbook is legitimate work.
///
/// The host enforces this by summing [`EvalBudget::total_consumed`] across the
/// batch; the engine only supplies the number and the meter.
pub const BATCH_FUEL: i64 = 8 * DEFAULT_CELL_FUEL;

/// How much a single lambda invocation costs ON TOP of its body's nodes.
/// Scope save/restore, the captured-binding clone and the `HashMap` churn make
/// an invocation materially more expensive than an ordinary node.
pub const LAMBDA_CALL_FUEL: i64 = 8;

/// Charges between two slow checks. The fast path is a decrement and a
/// compare; the cancel flag, the sticky-trip test and the (usually absent)
/// deadline are consulted only when the counter CROSSES this stride, i.e.
/// roughly once in 65,536 charges — a few milliseconds of cancellation
/// granularity, far finer than a human notices, while the shared atomic's
/// cache line is touched ~65,000x less often than the private counter.
pub const POLL_INTERVAL: i64 = 65_536;

/// Discount applied by [`EvalBudget::charge_arith`]: raw `f64` inner loops and
/// char-grid wildcard matching cost ~1-3 ns per element against ~20-50 ns for
/// a node evaluation, so they are charged at 1/16.
pub const ARITH_FUEL_SHIFT: u32 = 4;

/// Hard cap on the element count of any array a single builtin may
/// MATERIALIZE (SEQUENCE, RANDARRAY, MAKEARRAY, MUNIT, EXPAND, WRAPROWS/COLS).
/// 4x a full column. `EvalResult` is ~48-56 bytes, so ~235 MB worst case.
///
/// This is NOT redundant with the fuel counter: a deadline or a counter cannot
/// save you from a single `Vec::with_capacity` that aborts the process before
/// any loop runs. Checked BEFORE allocating.
pub const MAX_ARRAY_ELEMENTS: i64 = 4_194_304;

/// Hard cap on the byte length of any string a single builtin may BUILD
/// (REPT, BASE padding, TEXTJOIN). Excel caps a *cell* at 32,767 characters;
/// 1 MiB leaves room for legitimate intermediate results while stopping
/// `REPT("x", 1e12)` from taking the process with it.
pub const MAX_TEXT_LEN: i64 = 1_048_576;

/// Why an evaluation was stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TripReason {
    /// The deterministic work ceiling was exhausted. Produces `#LIMIT!`.
    Fuel,
    /// A human (or the host) asked for the evaluation to stop. The host is
    /// the authority on this outcome: it owns the token and must check it
    /// BEFORE writing any result, so a cancelled formula never lands a bogus
    /// `#LIMIT!` in a cell the user only wanted to stop.
    Cancelled,
    /// A wall-clock deadline passed. Only reachable on a service boundary
    /// that explicitly armed one — never on a path that writes a cell.
    Deadline,
}

/// A cooperative cancellation flag shared between the host and the evaluator.
///
/// Shape deliberately copied from the pivot engine's `CancellationToken`
/// (app/src-tauri/src/pivot/types.rs) rather than imported: the engine is the
/// kernel and must not depend on the app crate.
///
/// `Relaxed` ordering is correct here. The flag carries no data and guards no
/// memory; the only requirement is that the store eventually becomes visible,
/// which it does on every platform Calcula targets, and the poll runs
/// thousands of times per second.
#[derive(Clone, Default, Debug)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        CancelToken(Arc::new(AtomicBool::new(false)))
    }

    /// Ask every evaluation sharing this token to stop at its next poll.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    #[inline]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    /// Clear the flag so the token can be reused for the next pass.
    pub fn reset(&self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

/// Whether an evaluator is metered, stated EXPLICITLY at the construction site.
///
/// This follows the `PinPolicy` precedent in core/calp/src/integrity.rs, and
/// for the same reason: this codebase has repeatedly been bitten by a safety
/// parameter that had a silent default. Deliberately has NO `Default` impl —
/// "unmetered" must be a word somebody typed.
///
/// Note the asymmetry, which is the whole point: `Evaluator::new` and friends
/// are metered WITHOUT asking, so a call site nobody remembered to update is
/// still protected. The only thing that must be spelled out is the removal of
/// the protection ([`Evaluator::unmetered`] / `set_budget_policy`). A missed
/// call site therefore fails safe — the worst case is a missing Cancel button,
/// never a wedged application.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetPolicy {
    /// Charge work against the given fuel allowance; exhaustion is `#LIMIT!`.
    Metered(i64),
    /// No work ceiling at all. Legitimate ONLY for benchmarks, for tests that
    /// deliberately measure unbounded behaviour, and for pure-function call
    /// sites that evaluate a known-tiny expression. Cancellation still works
    /// if a token is attached.
    Unmetered,
}

/// The evaluator's work meter. One per `Evaluator`; armed and reset at each
/// TOP-LEVEL `Evaluator::evaluate` entry, so the ceiling is per-formula.
///
/// Per-formula (rather than per-recalc-pass) scoping is what makes the three
/// motivating cases come out right: one pathological cell trips and every
/// other cell in the workbook still recalculates; a legitimate two-minute
/// recalc of 100k cells completes because each cell re-arms; and iterative
/// calculation is untouched, because 32,767 deliberate iterations look like
/// 32,767 cheap evaluations rather than one long one.
///
/// All interior state is `Cell`, so charging works through `&self` — the
/// evaluator's hot path is `&self` everywhere and must stay that way.
#[derive(Debug, Clone)]
pub struct EvalBudget {
    /// Counts DOWN. Negative means exhausted.
    fuel: Cell<i64>,
    /// Do the slow check once `fuel` has CROSSED this descending threshold.
    ///
    /// It must be a crossing test, not `fuel % N == 0` and not a bitmask: bulk
    /// pre-charges of a million jump clean over any single boundary and the
    /// poll would silently never fire. `slow_check` re-bases this to
    /// `fuel - POLL_INTERVAL`, which is crossing-safe for any charge size.
    next_poll: Cell<i64>,
    /// Fuel installed at each arm. `i64::MAX` when unmetered.
    initial: i64,
    /// False for `BudgetPolicy::Unmetered`: fuel is still counted (so the poll
    /// still fires and cancellation still works) but exhaustion never trips.
    metered: bool,
    armed: Cell<bool>,
    tripped: Cell<bool>,
    reason: Cell<Option<TripReason>>,
    /// Fuel consumed across ALL top-level evaluations on this budget, not
    /// reset by arming. The host sums this to enforce [`BATCH_FUEL`].
    total_consumed: Cell<i64>,
    /// `None` on every path that can write a cell. See the module docs.
    deadline: Cell<Option<Instant>>,
    cancel: Option<CancelToken>,
}

impl EvalBudget {
    /// The standard per-cell allowance. What every `Evaluator` constructor
    /// installs.
    pub fn default_cell() -> Self {
        Self::from_policy(BudgetPolicy::Metered(DEFAULT_CELL_FUEL))
    }

    /// Build a budget from an explicit policy.
    pub fn from_policy(policy: BudgetPolicy) -> Self {
        let (initial, metered) = match policy {
            BudgetPolicy::Metered(fuel) => (fuel.max(1), true),
            BudgetPolicy::Unmetered => (i64::MAX, false),
        };
        EvalBudget {
            fuel: Cell::new(initial),
            next_poll: Cell::new(initial - POLL_INTERVAL),
            initial,
            metered,
            armed: Cell::new(false),
            tripped: Cell::new(false),
            reason: Cell::new(None),
            total_consumed: Cell::new(0),
            deadline: Cell::new(None),
            cancel: None,
        }
    }

    /// Attach a cancellation token shared with the host.
    pub fn set_cancel_token(&mut self, token: CancelToken) {
        self.cancel = Some(token);
    }

    pub fn cancel_token(&self) -> Option<&CancelToken> {
        self.cancel.as_ref()
    }

    /// Arm a WALL-CLOCK deadline.
    ///
    /// Legitimate on exactly one class of caller: a host service boundary
    /// whose result is returned over IPC and never persisted into a cell
    /// (`api.evaluate` and its siblings), matching the 5 s contract sandboxed
    /// script code already lives under. Arming this on a path that writes a
    /// cell would make workbook CONTENT depend on machine speed and would
    /// poison the soak/regression oracles.
    ///
    /// Takes the DEADLINE, not a duration, so a test can pass an
    /// already-elapsed `Instant` and assert the trip with no sleeping and no
    /// timing window — the injectable clock this design needs, without a
    /// `Clock` trait.
    pub fn set_deadline(&mut self, at: Instant) {
        self.deadline.set(Some(at));
    }

    pub fn clear_deadline(&mut self) {
        self.deadline.set(None);
    }

    pub fn is_metered(&self) -> bool {
        self.metered
    }

    /// Fuel consumed by the CURRENT (or most recent) top-level evaluation.
    pub fn consumed(&self) -> i64 {
        self.initial - self.fuel.get()
    }

    /// Fuel remaining in the current top-level evaluation.
    pub fn remaining(&self) -> i64 {
        self.fuel.get()
    }

    /// Fuel consumed across every top-level evaluation this budget has run.
    /// The host's [`BATCH_FUEL`] ceiling is a comparison against this.
    pub fn total_consumed(&self) -> i64 {
        self.total_consumed.get()
    }

    /// True if the current top-level evaluation was stopped.
    pub fn tripped(&self) -> bool {
        self.tripped.get()
    }

    /// Why it was stopped, if it was.
    pub fn trip_reason(&self) -> Option<TripReason> {
        self.reason.get()
    }

    /// Arm this budget if no top-level evaluation is already in flight.
    /// Returns true for the OUTERMOST frame only — recursive `evaluate` calls
    /// get `false` and must not reset anything.
    pub(crate) fn arm_if_idle(&self) -> bool {
        if self.armed.get() {
            return false;
        }
        self.armed.set(true);
        self.tripped.set(false);
        self.reason.set(None);
        self.fuel.set(self.initial);
        // A cancel that is ALREADY pending, or a deadline that has ALREADY
        // passed, must stop the very first charge instead of buying another
        // POLL_INTERVAL of work. Setting next_poll to the full amount makes
        // charge #1 cross it.
        let already_over = self.cancel.as_ref().is_some_and(|c| c.is_cancelled())
            || self
                .deadline
                .get()
                .is_some_and(|d| Instant::now() >= d);
        self.next_poll.set(if already_over {
            self.initial
        } else {
            Self::poll_after(self.initial)
        });
        true
    }

    /// Where the next slow check belongs, given the fuel remaining.
    ///
    /// The `.max(-1)` clamp is load-bearing for SMALL budgets: with a plain
    /// `fuel - POLL_INTERVAL`, a budget of 1,000 would set the threshold to
    /// -64,536 and happily overrun its allowance by a whole poll interval
    /// before noticing. Clamping means a budget smaller than the stride is
    /// detected EXACTLY at exhaustion, which is what makes small budgets usable
    /// in tests and by hosts handing out a shrinking batch remainder. For a
    /// full-size budget the clamp only engages over the last 65,536 units.
    #[inline]
    fn poll_after(fuel: i64) -> i64 {
        (fuel - POLL_INTERVAL).max(-1)
    }

    /// Release the arm after the outermost frame returns.
    pub(crate) fn disarm(&self) {
        self.total_consumed
            .set(self.total_consumed.get().saturating_add(self.consumed()));
        self.armed.set(false);
    }

    /// THE FAST PATH: subtract, compare, predicted branch. About three or four
    /// instructions with the counter permanently hot in L1.
    #[inline(always)]
    pub(crate) fn charge(&self, units: i64) -> Result<(), TripReason> {
        let after = self.fuel.get().saturating_sub(units);
        self.fuel.set(after);
        if after <= self.next_poll.get() {
            return self.slow_check(after);
        }
        Ok(())
    }

    /// Charge work whose per-element cost is raw `f64` arithmetic or a char
    /// comparison — roughly an order of magnitude below a node evaluation.
    /// Always charges at least 1 so a caller can never charge nothing.
    #[inline]
    pub(crate) fn charge_arith(&self, units: i64) -> Result<(), TripReason> {
        self.charge((units >> ARITH_FUEL_SHIFT).max(1))
    }

    /// The cold path: taken roughly once per `POLL_INTERVAL` charges.
    #[cold]
    #[inline(never)]
    fn slow_check(&self, fuel_after: i64) -> Result<(), TripReason> {
        // Sticky: once tripped, stay tripped and keep failing fast so the
        // recursion unwinds without doing any more work. Deliberately does NOT
        // re-base next_poll, so every subsequent charge lands here too.
        if let Some(r) = self.reason.get() {
            return Err(r);
        }
        if self.cancel.as_ref().is_some_and(|c| c.is_cancelled()) {
            return Err(self.trip(TripReason::Cancelled));
        }
        // Only touch the clock when a deadline was explicitly armed — on every
        // cell path this is None and no syscall happens.
        if let Some(deadline) = self.deadline.get() {
            if Instant::now() >= deadline {
                return Err(self.trip(TripReason::Deadline));
            }
        }
        if self.metered && fuel_after < 0 {
            return Err(self.trip(TripReason::Fuel));
        }
        self.next_poll.set(Self::poll_after(fuel_after));
        Ok(())
    }

    fn trip(&self, reason: TripReason) -> TripReason {
        self.tripped.set(true);
        self.reason.set(Some(reason));
        reason
    }

    /// Copy the whole live state of another budget into this one.
    ///
    /// Used by the ONE place in the engine where evaluation continues inside a
    /// FRESH `Evaluator` (the per-sheet evaluator in `eval_3d_ref`). A fresh
    /// budget would hand out a whole second allowance; this makes the nested
    /// evaluator continue spending the outer one. Pair every `adopt` with an
    /// `absorb` on the way back out.
    pub(crate) fn adopt(&mut self, outer: &EvalBudget) {
        self.fuel.set(outer.fuel.get());
        self.next_poll.set(outer.next_poll.get());
        self.initial = outer.initial;
        self.metered = outer.metered;
        self.armed.set(outer.armed.get());
        self.tripped.set(outer.tripped.get());
        self.reason.set(outer.reason.get());
        self.deadline.set(outer.deadline.get());
        self.cancel = outer.cancel.clone();
    }

    /// Fold a nested budget's consumption back into this one.
    pub(crate) fn absorb(&self, nested: &EvalBudget) {
        self.fuel.set(nested.fuel.get());
        self.next_poll.set(nested.next_poll.get());
        if nested.tripped.get() {
            self.tripped.set(true);
            self.reason.set(nested.reason.get());
        }
    }
}

impl Default for EvalBudget {
    /// The SAFE default. There is no default for "unmetered" on purpose —
    /// see [`BudgetPolicy`].
    fn default() -> Self {
        Self::default_cell()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_metered_budget_trips_when_fuel_runs_out() {
        let b = EvalBudget::from_policy(BudgetPolicy::Metered(1000));
        assert!(b.arm_if_idle());
        for _ in 0..1000 {
            assert!(b.charge(1).is_ok());
        }
        // 1001st charge takes fuel negative.
        assert_eq!(b.charge(1), Err(TripReason::Fuel));
        assert!(b.tripped());
        assert_eq!(b.trip_reason(), Some(TripReason::Fuel));
    }

    #[test]
    fn a_bulk_charge_bigger_than_the_poll_interval_still_polls() {
        // THE ANTI-BITMASK REGRESSION TEST. A poll keyed on `fuel % N == 0`
        // (or on a bitmask) is jumped clean over by a bulk charge and never
        // fires again. Crossing a descending threshold cannot be jumped.
        let b = EvalBudget::from_policy(BudgetPolicy::Metered(POLL_INTERVAL * 4));
        assert!(b.arm_if_idle());
        assert_eq!(b.charge(POLL_INTERVAL * 10), Err(TripReason::Fuel));
    }

    #[test]
    fn a_single_charge_larger_than_the_whole_budget_trips_immediately() {
        let b = EvalBudget::from_policy(BudgetPolicy::Metered(1000));
        assert!(b.arm_if_idle());
        assert_eq!(b.charge(4_000_000_000), Err(TripReason::Fuel));
    }

    #[test]
    fn charging_cannot_overflow_into_a_positive_number() {
        // Two colossal charges must not wrap i64 and look like plenty of fuel.
        let b = EvalBudget::from_policy(BudgetPolicy::Metered(1000));
        assert!(b.arm_if_idle());
        let _ = b.charge(i64::MAX);
        assert!(b.charge(i64::MAX).is_err());
        assert!(b.remaining() < 0);
    }

    #[test]
    fn an_unmetered_budget_never_trips_on_fuel() {
        let b = EvalBudget::from_policy(BudgetPolicy::Unmetered);
        assert!(b.arm_if_idle());
        for _ in 0..10 {
            assert!(b.charge(POLL_INTERVAL * 100).is_ok());
        }
        assert!(b.charge(i64::MAX / 4).is_ok());
        assert!(!b.tripped());
    }

    #[test]
    fn an_unmetered_budget_still_honours_cancellation() {
        // "Unmetered" removes the WORK ceiling, not the user's escape hatch.
        let token = CancelToken::new();
        let mut b = EvalBudget::from_policy(BudgetPolicy::Unmetered);
        b.set_cancel_token(token.clone());
        assert!(b.arm_if_idle());
        assert!(b.charge(1).is_ok());
        token.cancel();
        // Cancellation is seen at the next poll boundary, not instantly.
        assert_eq!(b.charge(POLL_INTERVAL), Err(TripReason::Cancelled));
    }

    #[test]
    fn cancellation_is_seen_within_one_poll_interval() {
        // Asserted in CHARGES, not milliseconds, so the suite cannot go flaky.
        let token = CancelToken::new();
        let mut b = EvalBudget::from_policy(BudgetPolicy::Metered(i64::MAX / 2));
        b.set_cancel_token(token.clone());
        assert!(b.arm_if_idle());
        token.cancel();
        let mut charges = 0i64;
        while b.charge(1).is_ok() {
            charges += 1;
            assert!(charges <= POLL_INTERVAL, "cancel not observed in one poll interval");
        }
        assert_eq!(b.trip_reason(), Some(TripReason::Cancelled));
    }

    #[test]
    fn an_already_pending_cancel_stops_the_very_first_charge() {
        let token = CancelToken::new();
        token.cancel();
        let mut b = EvalBudget::from_policy(BudgetPolicy::Metered(DEFAULT_CELL_FUEL));
        b.set_cancel_token(token);
        assert!(b.arm_if_idle());
        assert_eq!(b.charge(1), Err(TripReason::Cancelled));
    }

    #[test]
    fn an_elapsed_deadline_trips_without_any_sleeping() {
        // The ONLY wall-clock test in the engine: the deadline is INJECTED as
        // an already-past Instant, so there is no timing window to be flaky
        // about and no thread ever sleeps.
        let past = Instant::now()
            .checked_sub(Duration::from_secs(60))
            .expect("a 60s-old Instant exists on every supported platform");
        let mut b = EvalBudget::from_policy(BudgetPolicy::Metered(DEFAULT_CELL_FUEL));
        b.set_deadline(past);
        assert!(b.arm_if_idle());
        assert_eq!(b.charge(1), Err(TripReason::Deadline));
    }

    #[test]
    fn a_future_deadline_does_not_trip() {
        let future = Instant::now() + Duration::from_secs(3600);
        let mut b = EvalBudget::from_policy(BudgetPolicy::Metered(DEFAULT_CELL_FUEL));
        b.set_deadline(future);
        assert!(b.arm_if_idle());
        for _ in 0..10 {
            assert!(b.charge(POLL_INTERVAL).is_ok());
        }
    }

    #[test]
    fn no_deadline_is_armed_by_default() {
        // The load-bearing invariant: nothing that can write a cell may have a
        // clock. `default_cell` is what every Evaluator constructor installs.
        let b = EvalBudget::default_cell();
        assert!(b.deadline.get().is_none());
        assert!(b.cancel.is_none());
        assert!(b.is_metered());
    }

    #[test]
    fn arming_resets_fuel_but_total_consumed_accumulates() {
        let b = EvalBudget::from_policy(BudgetPolicy::Metered(1000));
        for _ in 0..3 {
            assert!(b.arm_if_idle());
            assert!(b.charge(100).is_ok());
            b.disarm();
        }
        assert_eq!(b.total_consumed(), 300);
        assert!(b.arm_if_idle());
        assert_eq!(b.remaining(), 1000);
    }

    #[test]
    fn a_recursive_arm_attempt_does_not_reset_the_meter() {
        let b = EvalBudget::from_policy(BudgetPolicy::Metered(1000));
        assert!(b.arm_if_idle());
        assert!(b.charge(500).is_ok());
        assert!(!b.arm_if_idle(), "an inner frame must never re-arm");
        assert_eq!(b.remaining(), 500);
    }

    #[test]
    fn arith_charges_are_discounted_but_never_free() {
        let b = EvalBudget::from_policy(BudgetPolicy::Metered(1_000_000));
        assert!(b.arm_if_idle());
        assert!(b.charge_arith(1 << ARITH_FUEL_SHIFT).is_ok());
        assert_eq!(b.consumed(), 1);
        assert!(b.charge_arith(1).is_ok());
        assert_eq!(b.consumed(), 2, "a sub-unit charge still costs 1");
    }

    #[test]
    fn a_trip_is_sticky_until_the_next_arm() {
        let b = EvalBudget::from_policy(BudgetPolicy::Metered(10));
        assert!(b.arm_if_idle());
        assert!(b.charge(100).is_err());
        // Every later charge fails fast so the recursion unwinds cheaply.
        for _ in 0..100 {
            assert_eq!(b.charge(1), Err(TripReason::Fuel));
        }
        b.disarm();
        assert!(b.arm_if_idle());
        assert!(b.charge(1).is_ok(), "a fresh top-level evaluation starts clean");
        assert!(!b.tripped());
    }

    #[test]
    fn a_cancel_token_is_shared_by_clone() {
        let a = CancelToken::new();
        let b = a.clone();
        assert!(!b.is_cancelled());
        a.cancel();
        assert!(b.is_cancelled());
        b.reset();
        assert!(!a.is_cancelled());
    }
}
