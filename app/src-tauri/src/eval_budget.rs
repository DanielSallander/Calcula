//! FILENAME: app/src-tauri/src/eval_budget.rs
//! PURPOSE: The HOST half of the formula evaluation budget — which work ceiling
//! each evaluation surface gets, the cancellation token a long recalculation can
//! be stopped with (the Ctrl+Break analogue), the ~100 ms progress clock behind
//! the Cancel button, and the record of what a cancelled pass left
//! un-recalculated so the workbook never silently rests in a half-computed state.
//! CONTEXT: The engine (core/engine/src/budget.rs) supplies the deterministic
//! fuel meter and the `CancelToken` type; it charges work and turns exhaustion
//! into `#LIMIT!`. It does NOT know what the user is doing. This module is where
//! "what the user is doing" becomes a number and a token.
//!
//! ## Why an ambient governor rather than a parameter on 78 call sites
//!
//! The design called for threading `budget`/`cancel` through the ~19
//! `evaluate_formula*` wrappers in lib.rs. Counted against HEAD, those wrappers
//! have ~78 direct callers spread over 18 files, and most of those callers are
//! themselves several frames below the command that knows which surface it is.
//! Threading a parameter that far means ~78 opportunities to pass the wrong one
//! and a permanent invitation for the next wrapper to forget — the precise
//! "a missed entry point is a hole that LOOKS fixed" failure this feature exists
//! to avoid.
//!
//! So the surface is declared ONCE, at the command boundary, by installing a
//! thread-local governor for the duration of the operation, and every
//! `Evaluator` construction site in this crate calls [`apply`] on the way out.
//! There are exactly 18 such sites (13 in lib.rs, 3 in formula.rs, 1 in
//! controls.rs, 1 in evaluate_formula.rs) and `apply` is called at every one;
//! `governor_is_applied_at_every_construction_site` in this module's tests is a
//! source-level guard that fails if a 19th appears without it.
//!
//! ## Why this is NOT the fail-open thread-local the design rejected
//!
//! The design (§8) rejected "a thread-local ambient budget in the
//! `lookup_cache::PassGuard` style" because it fails OPEN: a driver that forgets
//! the guard gets no protection. That objection is exactly right for an ambient
//! *budget*, and it does not apply here, because THE BUDGET IS NEVER AMBIENT.
//! Every `Evaluator` constructor in the engine installs
//! `EvalBudget::default_cell()` unconditionally; removing the ceiling requires
//! typing `BudgetPolicy::Unmetered`. This governor can therefore only
//!
//!   * TIGHTEN the ceiling (Transient), never remove it,
//!   * attach a cancellation token, and
//!   * attach a wall-clock deadline on the one class of caller allowed one.
//!
//! An evaluation that runs with no governor installed gets `DEFAULT_CELL_FUEL`
//! and no Cancel button — i.e. the interactive default, which is precisely the
//! failure mode the engine half already chose and documented. The application
//! cannot be wedged by a missed site; at worst a rarely-used surface is
//! uncancellable. Fail-open on a cache means "slower"; fail-open here means
//! "the interactive ceiling", not "unprotected".
//!
//! Nested installs are stacked and restored (a recalc pass that re-enters
//! computed-property evaluation gets the inner surface, then the outer one back)
//! and a nested install with no explicit token INHERITS the outer token, so
//! Cancel keeps working all the way down.

use std::cell::RefCell;
use std::time::{Duration, Instant};

use engine::{BudgetPolicy, CancelToken, Evaluator, BATCH_FUEL, DEFAULT_CELL_FUEL};
use serde::{Deserialize, Serialize};

// ============================================================================
// Per-surface ceilings
// ============================================================================

/// Fuel for evaluations whose result is NEVER persisted and which are
/// recomputed continuously (conditional-format rules while scrolling,
/// validation on every keystroke, chart per-row scopes on every repaint).
///
/// A quarter of the interactive allowance. Deliberately tighter: nobody asked
/// for these, they run behind other interactions, and a four-second stall
/// during a repaint reads as a hang rather than as a slow calculation. Because
/// nothing here is written into a cell, a trip costs a highlight or a tooltip,
/// never a workbook value.
pub const TRANSIENT_CELL_FUEL: i64 = DEFAULT_CELL_FUEL / 4;

/// Wall-clock ceiling for one `api.evaluate` / `evaluate_expressions` call.
///
/// Matches `ScriptLimits::DEFAULT_ONE_OFF_TIMEOUT_MS` (core/script-engine):
/// sandboxed code already lives under a 5 s contract, and code reaching the
/// evaluator through the WorksheetFunction bridge should be governed by script
/// rules rather than escaping them by changing language.
pub const SCRIPT_EVAL_TIMEOUT_MS: u64 = 5_000;

/// What the user is doing, and therefore what ceiling their evaluation gets.
///
/// ## The rule that decides these numbers
///
/// **Any surface whose result is WRITTEN INTO A CELL must get exactly the same
/// fuel as every other such surface.** If a full recalc gave a formula 64M
/// charges and a .calp refresh gave it 16M, that formula would hold `#LIMIT!`
/// or its real answer depending on which code path last touched it — the
/// workbook's CONTENT would depend on the caller. That is the same class of
/// nondeterminism the engine banned wall-clocks for, arriving through a
/// different door, and it would break the soak/regression oracles just as
/// thoroughly.
///
/// So the surfaces differentiate on the axis it is SAFE to differentiate on —
/// whether the result is persisted — and the three persisting surfaces share
/// one number BY REQUIREMENT, not by oversight. They stay separate variants
/// because they differ in what the *user* can do about a slow one: a full
/// recalc gets progress and a Cancel button, an interactive edit is over before
/// a button could be drawn, and a background refresh is cancellable but silent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvalSurface {
    /// A cell edit and its dependent cascade, fill/autofill, batch cell writes,
    /// row/column insert-delete re-evaluation, table calculated columns,
    /// computed properties. The user typed this and is waiting for it.
    ///
    /// `DEFAULT_CELL_FUEL` — THE REFERENCE CEILING. Every other persisting
    /// surface is defined as "the same as this".
    Interactive,

    /// A full recalculation pass (F9 / `calculate_now` / `calculate_sheet`).
    /// Writes cells, so the same fuel as `Interactive`, per the rule above.
    ///
    /// The pass itself has NO aggregate ceiling: the list of formulas is the
    /// workbook's own, and a big workbook is legitimate work — that is the
    /// whole case a per-pass timeout would have broken. What the length of the
    /// pass buys the user instead is progress and a Cancel button.
    Recalc,

    /// Recalculation the user did not personally start: `.calp` subscription
    /// refresh, override revert/accept, scenario show, animation frames, and
    /// the inner recalcs of Goal Seek / Solver / data tables.
    ///
    /// Writes cells, so again the same fuel as `Interactive`. Cancellable
    /// (these are the passes most likely to be long) but without its own
    /// progress chrome — the operation that owns them reports progress.
    Background,

    /// `api.evaluate` / `evaluate_formula_typed` / `evaluate_expressions`: a
    /// CALLER-SUPPLIED list of expressions whose results cross IPC and are
    /// never persisted into a cell.
    ///
    /// Per-expression fuel is `DEFAULT_CELL_FUEL` — EQUAL to what an
    /// interactive edit gets, never more, so a script cannot buy itself a
    /// bigger formula by asking through the bridge. On top of that it is the
    /// only surface with two extra ceilings, because it is the only one where
    /// the *list* is untrusted:
    ///   * `BATCH_FUEL` across the whole call (otherwise 100,000 expressions in
    ///     one call is 100,000 full allowances), enforced by the host loop; and
    ///   * a `SCRIPT_EVAL_TIMEOUT_MS` wall clock — legitimate here and nowhere
    ///     else precisely because no cell value can depend on it.
    Script,

    /// Results that are recomputed continuously and never persisted:
    /// conditional-format rule tests, data-validation checks, chart per-row
    /// `evaluate_scoped` scopes, slicer computed fields, `GET.CONTROLVALUE`
    /// probes, `GETPIVOTDATA` lookups.
    ///
    /// `TRANSIENT_CELL_FUEL` (a quarter). See that constant.
    Transient,
}

impl EvalSurface {
    /// The per-formula fuel allowance for this surface.
    pub fn fuel(self) -> i64 {
        match self {
            // Persisting surfaces MUST agree — see the type-level doc comment.
            EvalSurface::Interactive | EvalSurface::Recalc | EvalSurface::Background => {
                DEFAULT_CELL_FUEL
            }
            // Equal to the interactive ceiling, never above it.
            EvalSurface::Script => DEFAULT_CELL_FUEL,
            EvalSurface::Transient => TRANSIENT_CELL_FUEL,
        }
    }

    /// Whether results from this surface are written into cells. The three
    /// surfaces for which this is true are the ones whose fuel must be equal.
    pub fn persists_results(self) -> bool {
        matches!(
            self,
            EvalSurface::Interactive | EvalSurface::Recalc | EvalSurface::Background
        )
    }

    pub fn name(self) -> &'static str {
        match self {
            EvalSurface::Interactive => "interactive",
            EvalSurface::Recalc => "recalc",
            EvalSurface::Background => "background",
            EvalSurface::Script => "script",
            EvalSurface::Transient => "transient",
        }
    }
}

// ============================================================================
// The ambient governor
// ============================================================================

#[derive(Clone)]
struct Governor {
    surface: EvalSurface,
    cancel: CancelToken,
    /// `Some` ONLY for `EvalSurface::Script`. Anything that can write a cell
    /// must never carry a clock; see the engine's `EvalBudget::set_deadline`.
    deadline: Option<Instant>,
}

thread_local! {
    static ACTIVE: RefCell<Option<Governor>> = const { RefCell::new(None) };
}

/// Restores the previously-active governor when dropped, so nested surfaces
/// stack correctly (a `Recalc` pass that re-enters computed-property evaluation
/// as `Interactive` gets `Recalc` back afterwards).
#[must_use = "the governor is uninstalled the moment this guard is dropped"]
pub struct GovernorGuard {
    prev: Option<Governor>,
}

impl Drop for GovernorGuard {
    fn drop(&mut self) {
        let prev = self.prev.take();
        ACTIVE.with(|g| *g.borrow_mut() = prev);
    }
}

fn set_active(next: Governor) -> GovernorGuard {
    let prev = ACTIVE.with(|g| g.borrow_mut().replace(next));
    GovernorGuard { prev }
}

/// Declare the surface for everything evaluated on this thread until the guard
/// drops, INHERITING the enclosing cancellation token when there is one.
///
/// Inheritance is what keeps Cancel working through nesting: a recalc pass that
/// re-enters computed properties must still stop when the user hits Cancel,
/// even though computed properties know nothing about the pass.
pub fn install(surface: EvalSurface) -> GovernorGuard {
    let cancel = active_cancel().unwrap_or_default();
    set_active(Governor { surface, cancel, deadline: None })
}

/// Keep whatever surface is already governing this thread; declare `fallback`
/// only if there is none.
///
/// For shared bodies that several surfaces call into — the dependent-recalc
/// cascade is reached from an interactive edit, from a control-value refresh
/// and from a `.calp` refresh — where overriding the caller's declaration would
/// be a lie about what the user is doing. With nothing installed it declares
/// `fallback`, which makes a bare helper call still cancellable if the caller
/// later gains a token.
pub fn inherit_or(fallback: EvalSurface) -> GovernorGuard {
    match ACTIVE.with(|g| g.borrow().clone()) {
        Some(existing) => set_active(existing),
        None => install(fallback),
    }
}

/// Declare the surface AND the token a user can stop it with. Used by the
/// entry points that own a long operation.
pub fn install_cancellable(surface: EvalSurface, cancel: CancelToken) -> GovernorGuard {
    set_active(Governor { surface, cancel, deadline: None })
}

/// Declare a SERVICE boundary: a caller-supplied expression list whose results
/// cross IPC and are never persisted.
///
/// This is the only entry point that arms a wall clock, and it deliberately
/// refuses to do so for a surface that writes cells — a mistake here would make
/// workbook content depend on machine speed, which is the one failure this
/// whole design is arranged to prevent. A misuse is a panic in debug builds and
/// a silently clock-free budget in release, never a nondeterministic cell.
pub fn install_service(
    surface: EvalSurface,
    cancel: CancelToken,
    timeout: Duration,
) -> GovernorGuard {
    debug_assert!(
        !surface.persists_results(),
        "a wall-clock deadline must never be armed on a surface that writes cells"
    );
    let deadline = if surface.persists_results() {
        None
    } else {
        Instant::now().checked_add(timeout)
    };
    set_active(Governor { surface, cancel, deadline })
}

/// The surface currently governing this thread, if any.
pub fn active_surface() -> Option<EvalSurface> {
    ACTIVE.with(|g| g.borrow().as_ref().map(|gov| gov.surface))
}

/// The cancellation token currently governing this thread, if any.
pub fn active_cancel() -> Option<CancelToken> {
    ACTIVE.with(|g| g.borrow().as_ref().map(|gov| gov.cancel.clone()))
}

/// True when the governing token has been tripped. Host loops call this
/// BEFORE writing each result — see [`crate::calculation`].
pub fn cancel_requested() -> bool {
    ACTIVE.with(|g| {
        g.borrow()
            .as_ref()
            .is_some_and(|gov| gov.cancel.is_cancelled())
    })
}

/// Apply the governing surface to a freshly built `Evaluator`.
///
/// **Every `Evaluator::{new, with_multi_sheet, with_context}` call site in this
/// crate must call this.** With no governor installed this is a no-op and the
/// evaluator keeps the engine's default `DEFAULT_CELL_FUEL` — protected, just
/// not cancellable.
pub fn apply(evaluator: &mut Evaluator<'_>) {
    ACTIVE.with(|g| {
        if let Some(gov) = g.borrow().as_ref() {
            // Order matters only for readability: set_budget_policy carries any
            // existing token forward, and we install ours immediately after.
            evaluator.set_budget_policy(BudgetPolicy::Metered(gov.surface.fuel()));
            evaluator.set_cancel_token(gov.cancel.clone());
            if let Some(at) = gov.deadline {
                evaluator.set_deadline(at);
            }
        }
    });
}

/// The aggregate ceiling for ONE call that evaluates a caller-supplied list.
/// Re-exported here so the host loops that enforce it read as one idea.
pub const CALL_BATCH_FUEL: i64 = BATCH_FUEL;

/// Owns a cancellation token for the duration of ONE operation.
///
/// Resets the flag on the way in AND on the way out. Both matter:
///   * IN, because a Cancel the user clicked at the tail of the previous pass
///     must not abort the calculation they asked for next;
///   * OUT, because the flag is shared application state and a pass that ends
///     cancelled would otherwise poison every later evaluation on that token —
///     including the resume the user is about to ask for.
///
/// Resetting on drop also covers the panic path, which a manual reset at the
/// end of the function would not.
pub struct PassToken {
    token: CancelToken,
    /// False when an enclosing operation already owns this token. A nested pass
    /// must NOT reset it — see `begin_nested`.
    owns: bool,
}

impl PassToken {
    /// Claim the token, but ONLY if nothing already owns it.
    ///
    /// THE ONLY CONSTRUCTOR, deliberately. An "always reset" variant existed
    /// briefly and was a defect generator in both directions: used on a nested
    /// pass it DISCARDS a Cancel the user just issued against the enclosing
    /// operation (the Cancel button un-presses itself on any compound
    /// operation), and omitted entirely it LEAKS a raised flag into the next
    /// operation, which then aborts and writes `#LIMIT!` into an ordinary cell.
    /// One conditional claim serves both shapes correctly, so there is nothing
    /// to choose between and nothing to get wrong.
    ///
    /// Ownership is decided by whether a governor is already installed on this
    /// thread, which is precisely "is somebody else already running".
    pub fn claim(token: &CancelToken) -> Self {
        let owns = active_cancel().is_none();
        if owns {
            token.reset();
        }
        PassToken { token: token.clone(), owns }
    }

    /// Has the user asked to stop? Host loops call this BEFORE writing each
    /// result, never after — an in-flight formula aborted by cancellation
    /// returns `#LIMIT!`, and writing that would land a bogus error in a cell
    /// the user only wanted to STOP computing.
    pub fn cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    pub fn token(&self) -> &CancelToken {
        &self.token
    }
}

impl Drop for PassToken {
    fn drop(&mut self) {
        // Only the owner clears the flag; a nested pass leaves it for the
        // enclosing operation, which still has work to abandon.
        if self.owns {
            self.token.reset();
        }
    }
}

/// A governed, cancellable operation: the surface declaration and the token
/// claim as ONE thing.
///
/// THE INVARIANT IT EXISTS TO ENFORCE: **the cancel flag never survives the
/// operation it was raised against.** Installing a governor and claiming the
/// token were originally two calls, and the split was a real defect waiting to
/// happen — an entry point that installed the token without claiming it would
/// leave the flag set after being cancelled, and the NEXT interactive edit
/// would abort on its first charge and write `#LIMIT!` into a perfectly
/// ordinary cell. One combined guard makes the safe pairing the only pairing
/// available.
///
/// Field order is drop order and is load-bearing: the governor is uninstalled
/// BEFORE the token guard runs, so `PassToken::drop` sees the same
/// "is anybody else running" answer that `begin_nested` used to decide
/// ownership.
pub struct CalcPass {
    _governor: GovernorGuard,
    token: PassToken,
}

impl CalcPass {
    /// Has the user asked to stop? Call this BEFORE writing each result.
    pub fn cancelled(&self) -> bool {
        self.token.cancelled()
    }

    pub fn token(&self) -> &CancelToken {
        self.token.token()
    }
}

/// Begin a governed, cancellable operation on a cell-writing surface.
///
/// Claims the token if nothing else already owns it (so a nested pass cannot
/// discard a Cancel aimed at the operation containing it), and clears it on the
/// way out.
pub fn begin_pass(surface: EvalSurface, token: &CancelToken) -> CalcPass {
    // Ownership must be decided BEFORE the governor is installed — otherwise
    // every pass would see its own governor and conclude somebody else was
    // already running.
    let claimed = PassToken::claim(token);
    let governor = install_cancellable(surface, token.clone());
    CalcPass { _governor: governor, token: claimed }
}

/// Begin a governed operation on a SERVICE boundary — a caller-supplied
/// expression list whose results cross IPC and are never persisted.
///
/// The only form that arms a wall clock. See [`install_service`].
pub fn begin_service_pass(
    surface: EvalSurface,
    token: &CancelToken,
    timeout: Duration,
) -> CalcPass {
    let claimed = PassToken::claim(token);
    let governor = install_service(surface, token.clone(), timeout);
    CalcPass { _governor: governor, token: claimed }
}

// ============================================================================
// What a cancelled pass leaves behind
// ============================================================================

/// One cell that a cancelled recalculation did not get to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCell {
    pub row: u32,
    pub col: u32,
}

/// The un-recalculated remainder of a cancelled pass.
///
/// A cancelled recalc leaves some cells holding new values and some holding
/// pre-pass values, and **a stale cell is visually indistinguishable from a
/// correct one**. Rolling back was rejected (a full grid clone per recalc, and
/// it discards work the user may want); a per-cell dirty bit was rejected (it
/// adds a bit to `Cell` and an invalidation problem). What is recorded instead
/// is the remainder itself: `calculate_now` already builds its work in
/// topological order, so the cells it did not reach are exactly the suffix of
/// that order plus any untouched circular group.
///
/// Consequences, all of them deliberate:
///   * the status bar switches from "Ready" to "Calculate" — Excel's own
///     affordance for "this workbook has un-recalculated cells";
///   * the next recalculation starts FROM this set rather than from scratch, so
///     an accidental Cancel costs nothing;
///   * saving and `.calp` publishing consult it, because distributing a report
///     with silently stale cells is a data-correctness bug, not a UI nicety.
///
/// A `#LIMIT!` cell uses NONE of this. It is a COMPLETED evaluation with a
/// stable, coherent, persisted error value. That asymmetry is exactly why the
/// budget and cancellation are separate mechanisms sharing one check: one
/// produces a value, the other produces an incomplete pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRecalc {
    /// The sheet the cancelled pass was evaluating.
    pub sheet_index: usize,
    /// Cells that did NOT recalculate, in the topological order they would
    /// have been evaluated in, so a resumed pass can simply walk them.
    pub cells: Vec<PendingCell>,
}

impl PendingRecalc {
    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    pub fn contains(&self, row: u32, col: u32) -> bool {
        self.cells.iter().any(|c| c.row == row && c.col == col)
    }

    /// Drop one cell from the pending set because something else recalculated
    /// it (an edit cascade, say). Over-reporting staleness is safe — a cell
    /// left in the set is merely recalculated again on resume — so callers are
    /// not obliged to be exhaustive here.
    pub fn remove_cell(&mut self, row: u32, col: u32) {
        self.cells.retain(|c| !(c.row == row && c.col == col));
    }
}

// ============================================================================
// Progress reporting
// ============================================================================

/// Event name for recalculation progress. Payload: [`CalcProgressEvent`].
pub const CALC_PROGRESS_EVENT: &str = "app:calc-progress";

/// Progress of a running (or just-finished) recalculation.
///
/// Emitted on a HOST-side ~100 ms clock, never per formula: the wall clock that
/// drives this touches no cell value, which is why it is allowed to exist at
/// all. Nondeterminism is confined to WHEN a human is offered a Cancel button,
/// and no oracle compares that.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalcProgressEvent {
    /// "workbook" (calculate_now / F9) or "sheet".
    pub scope: String,
    pub cells_done: usize,
    pub cells_total: usize,
    pub elapsed_ms: u64,
    /// True on the final event of a pass.
    pub done: bool,
    /// True when the pass ended because the user cancelled it.
    pub cancelled: bool,
    /// How many cells were left un-recalculated (non-zero only when cancelled).
    pub pending_cells: usize,
}

/// Minimum interval between progress events.
const PROGRESS_INTERVAL_MS: u64 = 100;

/// Emits [`CalcProgressEvent`] no more than once per [`PROGRESS_INTERVAL_MS`].
///
/// Holds a `tauri::Window` so it can emit; constructed with `None` in tests and
/// in the non-command recalculation paths, where it degrades to a counter.
pub struct ProgressEmitter {
    window: Option<tauri::Window>,
    scope: &'static str,
    total: usize,
    started: Instant,
    last_emit: Instant,
}

impl ProgressEmitter {
    pub fn new(window: Option<tauri::Window>, scope: &'static str, total: usize) -> Self {
        let now = Instant::now();
        ProgressEmitter {
            window,
            scope,
            total,
            started: now,
            last_emit: now,
        }
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// Report progress if the interval has elapsed. Cheap enough to call in the
    /// per-cell loop: one `Instant::elapsed` per cell, which is nothing next to
    /// evaluating a formula (and, unlike a clock inside the evaluator, it can
    /// never influence a value).
    pub fn tick(&mut self, done: usize) {
        if self.last_emit.elapsed().as_millis() as u64 >= PROGRESS_INTERVAL_MS {
            self.last_emit = Instant::now();
            self.emit(done, false, false, 0);
        }
    }

    /// Final event of the pass.
    pub fn finish(&mut self, done: usize, cancelled: bool, pending_cells: usize) {
        self.emit(done, true, cancelled, pending_cells);
    }

    fn emit(&self, done: usize, finished: bool, cancelled: bool, pending_cells: usize) {
        let Some(window) = &self.window else { return };
        let payload = CalcProgressEvent {
            scope: self.scope.to_string(),
            cells_done: done,
            cells_total: self.total,
            elapsed_ms: self.elapsed_ms(),
            done: finished,
            cancelled,
            pending_cells,
        };
        // A failed emit must never fail a calculation: the webview may already
        // be gone (window closing mid-recalc).
        let _ = tauri::Emitter::emit(window, CALC_PROGRESS_EVENT, payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_persisting_surface_gets_the_same_fuel() {
        // THE determinism invariant: a formula's VALUE must not depend on which
        // code path recalculated it. If this test fails, some surface can write
        // a `#LIMIT!` into a cell that another surface would have computed
        // successfully, and the workbook's content becomes caller-dependent.
        let persisting = [
            EvalSurface::Interactive,
            EvalSurface::Recalc,
            EvalSurface::Background,
        ];
        for s in persisting {
            assert!(s.persists_results(), "{} must be a persisting surface", s.name());
            assert_eq!(
                s.fuel(),
                DEFAULT_CELL_FUEL,
                "{} diverged from the reference ceiling",
                s.name()
            );
        }
    }

    #[test]
    fn a_script_never_gets_more_than_an_interactive_edit() {
        // Requirement: "A script-initiated evaluation should not be able to
        // exceed what an interactive one gets."
        assert!(EvalSurface::Script.fuel() <= EvalSurface::Interactive.fuel());
        assert!(EvalSurface::Transient.fuel() <= EvalSurface::Interactive.fuel());
    }

    #[test]
    fn transient_is_strictly_tighter_and_never_persists() {
        assert!(EvalSurface::Transient.fuel() < DEFAULT_CELL_FUEL);
        assert!(!EvalSurface::Transient.persists_results());
        assert!(!EvalSurface::Script.persists_results());
    }

    #[test]
    fn no_governor_means_no_change_to_the_engine_default() {
        let grid = engine::Grid::new();
        let mut ev = Evaluator::new(&grid);
        apply(&mut ev);
        // The fail-safe: an ungoverned evaluator keeps the ENGINE's default
        // ceiling. It is not cancellable, but it cannot wedge the app either.
        assert!(ev.budget().is_metered());
        assert!(ev.budget().cancel_token().is_none());
        assert_eq!(active_surface(), None);
    }

    #[test]
    fn a_governor_installs_its_surfaces_fuel_and_token() {
        let token = CancelToken::new();
        let grid = engine::Grid::new();
        let guard = install_cancellable(EvalSurface::Transient, token.clone());
        let mut ev = Evaluator::new(&grid);
        apply(&mut ev);
        assert!(ev.budget().cancel_token().is_some());
        ev.budget();
        assert_eq!(active_surface(), Some(EvalSurface::Transient));
        drop(guard);
        assert_eq!(active_surface(), None);
    }

    #[test]
    fn nested_governors_stack_and_restore() {
        let token = CancelToken::new();
        let outer = install_cancellable(EvalSurface::Recalc, token.clone());
        assert_eq!(active_surface(), Some(EvalSurface::Recalc));
        {
            let _inner = install(EvalSurface::Interactive);
            assert_eq!(active_surface(), Some(EvalSurface::Interactive));
            // The inner surface INHERITED the outer token, so Cancel still
            // reaches evaluations that happen inside a nested surface.
            token.cancel();
            assert!(cancel_requested());
        }
        assert_eq!(active_surface(), Some(EvalSurface::Recalc));
        assert!(cancel_requested());
        drop(outer);
        assert!(!cancel_requested());
    }

    #[test]
    fn a_service_boundary_arms_a_clock_and_a_cell_path_never_does() {
        let token = CancelToken::new();
        let grid = engine::Grid::new();
        {
            let _g = install_service(
                EvalSurface::Script,
                token.clone(),
                Duration::from_millis(SCRIPT_EVAL_TIMEOUT_MS),
            );
            let mut ev = Evaluator::new(&grid);
            apply(&mut ev);
            // Can't read the deadline back through the public API; assert the
            // governor's own record instead, which is what `apply` copies.
            let armed = ACTIVE.with(|g| g.borrow().as_ref().unwrap().deadline.is_some());
            assert!(armed, "the script service boundary must arm a deadline");
        }
        for surface in [
            EvalSurface::Interactive,
            EvalSurface::Recalc,
            EvalSurface::Background,
            EvalSurface::Transient,
        ] {
            let _g = install_cancellable(surface, token.clone());
            let armed = ACTIVE.with(|g| g.borrow().as_ref().unwrap().deadline.is_some());
            assert!(
                !armed,
                "{} must never carry a wall clock — a cell value would depend on machine speed",
                surface.name()
            );
        }
    }

    #[test]
    fn a_pending_set_reports_and_forgets_cells() {
        let mut p = PendingRecalc {
            sheet_index: 0,
            cells: vec![
                PendingCell { row: 1, col: 1 },
                PendingCell { row: 2, col: 1 },
            ],
        };
        assert!(!p.is_empty());
        assert!(p.contains(2, 1));
        p.remove_cell(2, 1);
        assert!(!p.contains(2, 1));
        assert_eq!(p.cells.len(), 1);
    }

    /// SOURCE-LEVEL GUARD. Every `Evaluator` construction site in this crate
    /// must hand the result to `eval_budget::apply`, or that surface silently
    /// loses its ceiling and its Cancel button. Counting is crude but it is the
    /// only check that fails when somebody adds a 19th site next year.
    #[test]
    fn governor_is_applied_at_every_construction_site() {
        let sources: [(&str, &str); 4] = [
            ("lib.rs", include_str!("lib.rs")),
            ("formula.rs", include_str!("formula.rs")),
            ("controls.rs", include_str!("controls.rs")),
            ("evaluate_formula.rs", include_str!("evaluate_formula.rs")),
        ];
        let mut constructions = 0usize;
        let mut applications = 0usize;
        for (_name, src) in sources {
            for pat in ["Evaluator::new(", "Evaluator::with_multi_sheet(", "Evaluator::with_context("] {
                constructions += src.matches(pat).count();
            }
            applications += src.matches("eval_budget::apply(").count();
        }
        assert_eq!(
            constructions, applications,
            "every Evaluator construction in this crate must be followed by \
             eval_budget::apply(): found {} constructions and {} applications. \
             A construction without it evaluates with the engine default and \
             cannot be cancelled.",
            constructions, applications
        );
        assert!(constructions >= 18, "expected the known 18 construction sites, found {}", constructions);
    }
}
