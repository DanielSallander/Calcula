//! FILENAME: app/src-tauri/src/document_effect.rs
// PURPOSE: The forcing function for the workbook dirty flag.
//
// THE DEFECT THIS EXISTS TO PREVENT
// ---------------------------------
// `FileState::is_modified` is the single gate for BOTH the close-without-saving
// prompt (app/src/shell/Layout.tsx) and AutoRecover (persistence::auto_recover_save).
// A command that mutates state which lives in the .cala but never sets the flag
// loses the user's work silently: no prompt at close, and no auto-recover snapshot
// either. A census of all 746 Tauri commands found 256 mutating commands that never
// set it -- 255 of which do not even take `FileState`.
//
// A partial fix is worse than a uniform bug: users learn to trust the prompt, and an
// unpredictable mix of commands that do and do not prompt destroys that trust. So the
// rule must be enforced by the compiler, not by review.
//
// THE PRECEDENT
// -------------
// `core/calp/src/integrity.rs` had TOFU pin-writing ship wrong three times, so
// `verify_and_load_manifest_via` was given a REQUIRED `PinPolicy` parameter: a caller
// who does not think about pinning fails to COMPILE. This module is the same move for
// document mutation.
//
// WHERE THE GATE LIVES, AND WHY NOT ON THE COMMAND SIGNATURE
// ----------------------------------------------------------
// A Tauri command is a free function. Rust cannot force a free function to accept a
// parameter -- the author writes the signature, so "every mutating command must take a
// DocumentEffect" is a convention, not a constraint (and a `State<FileState>` argument
// can be accepted and then ignored, which is exactly the failure mode 5 commands
// already exhibit today). PinPolicy works because it sits on a CALLEE the caller cannot
// avoid.
//
// So the gate sits on the STATE: every persisted store is a `Persisted<T>`.
//   * `store.read()`               -- free, immutable, no decision required.
//   * `store.write(&effect)`       -- requires a `DocumentEffect`.
// A mutation therefore cannot be expressed without producing a `DocumentEffect`, and a
// `DocumentEffect` cannot be produced without picking an arm.
//
// THE ARMS
// --------
//   DocumentEffect::mutates(&FileState)          -- marks dirty AT CONSTRUCTION.
//   DocumentEffect::transient(&TransientScope)   -- a write that is guaranteed to be undone.
//   DocumentEffect::deliberately_clean(reason)   -- an audited, closed-enum opt-out.
//
// `mutates` sets the flag in its own constructor rather than in a `Drop` impl or in the
// guard: possession of the value is then PROOF the flag was set. There is no ordering to
// get wrong, no early `return` that skips it, and no `mem::forget` that defeats it.
//
// THE NEGATIVE CASE IS AS VISIBLE AS THE POSITIVE ONE
// ----------------------------------------------------
// "This deliberately does not dirty the document" is a call to
// `DocumentEffect::deliberately_clean(CleanReason::...)`, so the complete audit list is
//     rg "deliberately_clean" app/src-tauri/src
// `CleanReason` is a CLOSED enum on purpose. A free-text reason string would let anyone
// mint a new excuse in passing; adding a `CleanReason` variant is its own reviewable diff.

use std::collections::HashMap;
use std::fmt;
use std::ops::{Deref, DerefMut};
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::persistence::FileState;

// ============================================================================
// The dirty ANNOUNCEMENT -- how the title bar learns the flag moved
// ============================================================================

/// The Tauri event the backend emits when the workbook's dirty state CHANGES.
///
/// Bridged onto the `@api` event bus (`AppEvents.DIRTY_STATE_CHANGED`) by
/// `app/src/shell/bootstrap.ts`, which is what `Layout.tsx` already re-titles on.
pub const DIRTY_STATE_EVENT: &str = "document:dirty-changed";

/// Payload of [`DIRTY_STATE_EVENT`].
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyStatePayload {
    pub is_dirty: bool,
}

/// The app handle used to announce dirty transitions. Installed once from
/// `run()`; absent in unit tests, where announcing is a no-op.
static DIRTY_ANNOUNCER: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Install the handle that [`DirtyFlag`] announces transitions through. Called
/// once from `run()` right after the Tauri app is built, alongside the writeback
/// BI handle.
pub fn install_dirty_announcer(app: tauri::AppHandle) {
    let _ = DIRTY_ANNOUNCER.set(app);
}

/// Emit the transition to every window. No-op before the handle is installed.
fn announce_globally(is_dirty: bool) {
    if let Some(app) = DIRTY_ANNOUNCER.get() {
        use tauri::Emitter;
        let _ = app.emit(DIRTY_STATE_EVENT, DirtyStatePayload { is_dirty });
    }
}

// ============================================================================
// DirtyFlag -- the flag that announces its own transitions
// ============================================================================

/// Permission to write `FileState`'s dirty flag.
///
/// THE POINT. `FileState::is_modified` is PRIVATE, and the only method that can
/// change it (`FileState::set_dirty`) demands one of these. The field here is a
/// private unit, there is no public constructor, no `Default` and no `Clone` --
/// so a value of this type can only come into existence inside THIS module.
/// "`DocumentEffect` is the sole writer of the dirty flag" is therefore a fact
/// about the type system rather than a convention, and the audit is
///     rg "DirtyWrite" app/src-tauri/src
/// which returns this file and nothing else.
///
/// Rust has no `friend`, so this is the standard stand-in: a capability token
/// whose constructor is module-private. It is the same move `TransientScope`
/// makes for the transient exemption, one level down.
pub struct DirtyWrite(());

impl DirtyWrite {
    /// The only constructor, private to this module.
    fn new() -> Self {
        DirtyWrite(())
    }
}

/// The in-memory document now equals what is on disk: it was just saved, just
/// opened, or is a fresh blank. CLEARS the dirty flag.
///
/// WHY THIS IS A FUNCTION AND NOT A `DocumentEffect` ARM. The three arms of
/// `DocumentEffect` all answer "what does this WRITE do to the saved document?".
/// Clearing the flag is not a write at all -- it is the save path telling the
/// flag that the question has been settled. Giving it its own name keeps the arms
/// meaning one thing, and keeps every mutation of the flag inside this module.
///
/// The clean transition is announced exactly like the dirty one, which is what
/// makes the title-bar asterisk disappear after a backend-driven save.
pub fn mark_saved(file_state: &FileState) {
    file_state.set_dirty(DirtyWrite::new(), false);
}

/// Observer invoked with the NEW value whenever the flag actually changes.
type DirtyObserver = Box<dyn Fn(bool) + Send + Sync>;

/// `FileState::is_modified`: a `Mutex<bool>` that announces every transition.
///
/// WHY THE ANNOUNCEMENT LIVES ON THE FLAG AND NOT AT THE CALL SITES
/// ----------------------------------------------------------------
/// The dirty INDICATOR (the `*` in the title bar) lagged the dirty FLAG: after a
/// backend-only mutation `is_file_modified` was true but nothing told the
/// frontend, which only re-titled on six frontend-originated events. The obvious
/// repair -- "make every mutating command emit an event" -- is exactly the
/// failure mode the dirty-flag census existed to end: 256 of 746 commands had
/// already forgotten the far more consequential `is_modified` write itself.
///
/// So the announcement sits on the one thing every writer must already touch.
/// `DocumentEffect::mutates`, the legacy `mark_workbook_modified`, the ~60
/// remaining direct `*is_modified.lock() = true` sites and the three save/load
/// `= false` sites all go through `DirtyFlag::lock()`, and the guard's `Drop`
/// compares the value it was locked at against the value at release. Nothing has
/// to remember anything, and a future writer cannot bypass it without replacing
/// the field's type.
///
/// ONLY TRANSITIONS ARE ANNOUNCED. A bulk operation that dirties an
/// already-dirty document emits nothing; a 10,000-cell paste produces at most
/// one event. That is the difference between an ambient signal and a flood.
///
/// READS ARE FREE. `lock()` for a read releases with the value unchanged, so no
/// event fires -- including `is_file_modified`, which the frontend polls from
/// inside the very listener this feeds. Without the transition test that would
/// be an infinite loop.
pub struct DirtyFlag {
    inner: Mutex<bool>,
    /// Test-only redirection of the announcement, scoped to ONE instance.
    ///
    /// A global test sink would be polluted by every other test in the binary
    /// that flips a `FileState` -- and there are dozens. Binding the observer to
    /// the flag under test makes the assertion independent of test ordering and
    /// of `cargo test`'s thread pool.
    observer: Mutex<Option<DirtyObserver>>,
}

impl DirtyFlag {
    pub fn new(value: bool) -> Self {
        DirtyFlag { inner: Mutex::new(value), observer: Mutex::new(None) }
    }

    /// Lock the flag. Reading through the guard is free; writing a DIFFERENT
    /// value announces the transition when the guard is released.
    ///
    /// Mirrors `Mutex::lock`'s shape (`Result` whose error is `Debug + Display`)
    /// so the existing `.unwrap()` and `.map_err(|e| e.to_string())?` call sites
    /// are unchanged.
    pub fn lock(&self) -> Result<DirtyGuard<'_>, LockPoisoned> {
        match self.inner.lock() {
            Ok(guard) => {
                let was = *guard;
                Ok(DirtyGuard { flag: self, guard: Some(guard), was })
            }
            Err(_) => Err(LockPoisoned),
        }
    }

    /// Announce a transition: to the instance observer if a test installed one,
    /// otherwise to every window through the installed app handle.
    fn announce(&self, is_dirty: bool) {
        if let Ok(observer) = self.observer.lock() {
            if let Some(f) = observer.as_ref() {
                f(is_dirty);
                return;
            }
        }
        announce_globally(is_dirty);
    }

    /// Redirect this flag's announcements. Tests only -- production code has
    /// exactly one announcer, installed at startup.
    #[cfg(test)]
    pub fn set_observer(&self, f: impl Fn(bool) + Send + Sync + 'static) {
        if let Ok(mut observer) = self.observer.lock() {
            *observer = Some(Box::new(f));
        }
    }
}

impl Default for DirtyFlag {
    fn default() -> Self {
        DirtyFlag::new(false)
    }
}

impl fmt::Debug for DirtyFlag {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.inner.lock() {
            Ok(v) => write!(f, "DirtyFlag({})", *v),
            Err(_) => write!(f, "DirtyFlag(poisoned)"),
        }
    }
}

/// Guard over [`DirtyFlag`]. Derefs to `bool` in both directions; announces on
/// release if the value changed.
pub struct DirtyGuard<'a> {
    flag: &'a DirtyFlag,
    /// `Option` so `Drop` can RELEASE the mutex before announcing. Emitting
    /// while still holding it would publish the transition to every window from
    /// inside the critical section, and the listener's first act is to call back
    /// into `is_file_modified` -- which locks this very mutex.
    guard: Option<MutexGuard<'a, bool>>,
    was: bool,
}

impl<'a> Deref for DirtyGuard<'a> {
    type Target = bool;
    fn deref(&self) -> &bool {
        self.guard.as_ref().expect("DirtyGuard used after drop")
    }
}

impl<'a> DerefMut for DirtyGuard<'a> {
    fn deref_mut(&mut self) -> &mut bool {
        self.guard.as_mut().expect("DirtyGuard used after drop")
    }
}

impl<'a> Drop for DirtyGuard<'a> {
    fn drop(&mut self) {
        let Some(guard) = self.guard.take() else { return };
        let now = *guard;
        drop(guard);
        if now != self.was {
            self.flag.announce(now);
        }
    }
}

// ============================================================================
// CleanReason -- the closed set of audited reasons NOT to dirty
// ============================================================================

/// Why a write to persisted state deliberately leaves the document clean.
///
/// Closed on purpose: every variant below is a decision that was made once and can be
/// re-audited. If a new situation does not fit any variant, that is a signal to think,
/// not to add a variant in passing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanReason {
    /// The load path (`open_file` / `new_file` / a package pull that replaces the
    /// document). These commands rebuild every store from disk and then assign
    /// `is_modified = false` themselves as their last act; a store write inside them
    /// must not fight that. Dirtying here would make every freshly-opened workbook
    /// prompt to save.
    LoadingFromDisk,

    /// Navigation: which sheet the user is LOOKING at. `active_sheet` is persisted and
    /// Excel does dirty on a sheet switch, but merely reading a workbook must never make
    /// it dirty or the prompt loses all meaning. This is a deliberate divergence.
    Navigation,

    /// A derived cache that is rebuilt at save time from authorities which are themselves
    /// persisted (e.g. the effective-hidden row set). The authority's own command owns
    /// the flag; marking here would dirty on a pure repaint.
    DerivedCache,

    /// A recalculation-only companion of a mutating command (e.g.
    /// `recalc_visibility_dependents`, `recalculate_sheets_after_script_write`). The
    /// ENTRY command owns the flag; the recalc leaf must not add one.
    RecalcCompanion,

    /// The AutoRecover background save. It READS `is_modified` as its gate and must
    /// neither set nor clear it: setting it re-dirties on every tick, clearing it loses
    /// everything since the last manual save if the process then dies.
    AutoRecoverProbe,

    /// An append to the per-workbook audit trail (`state.audit_log`, persisted as
    /// user_files/audit_log.json) that RECORDS an action rather than being one.
    ///
    /// WHY THIS IS NOT `mutates`. The audit ring is appended to by read-only capability
    /// surfaces as well as mutating ones -- `bi_query`, `script_bi_sql`, `cube_udf_value`,
    /// `script_http_fetch` all log that a capability was exercised. If the append itself
    /// dirtied, a workbook whose CUBE formulas prefetch on open would be dirty before the
    /// user touched anything, and the close prompt would stop meaning "you have unsaved
    /// work". That is the same failure the `Navigation` arm exists to prevent.
    ///
    /// WHY THE TRAIL IS STILL SAFE. The audit entry rides the action it records: a
    /// capability call that MUTATES the document dirties through that mutation, and the
    /// entry is written by the same save. Only the pure-read entries are allowed to be
    /// lost on a close-without-saving, and in that case nothing they describe was
    /// persisted either.
    ///
    /// NOT for user actions ON the trail: `calp_clear_audit_log` and
    /// `calp_set_audit_enabled` change what a save writes on their own account and use
    /// `mutates`.
    AuditTrail,
}

impl CleanReason {
    /// Stable label, for audit output and test assertions.
    pub fn label(self) -> &'static str {
        match self {
            CleanReason::LoadingFromDisk => "loading-from-disk",
            CleanReason::Navigation => "navigation",
            CleanReason::DerivedCache => "derived-cache",
            CleanReason::RecalcCompanion => "recalc-companion",
            CleanReason::AutoRecoverProbe => "auto-recover-probe",
            CleanReason::AuditTrail => "audit-trail",
        }
    }
}

// ============================================================================
// TransientScope -- proof that a restore is registered
// ============================================================================

/// Proof that a transient write will be undone.
///
/// THE TRAP THIS CLOSES. `docs/design/animation-simulation.md` cites
/// `scenario_manager::scenario_show` as the transient-write precedent, and it is -- in
/// the UNDO sense. But there is no `scenario_restore` anywhere: the values `scenario_show`
/// applies stay in the cells and get saved. Copying the animation exemption to it would
/// be wrong.
///
/// So "transient" is defined operationally as: **there is a restore, and it is already
/// registered**. `TransientScope` can only be built by presenting the snapshot registry
/// that the restore will read back from, with a token that is actually in it. Animation
/// qualifies (`anim_snapshot` files the snapshot before any frame is applied, and
/// `anim_restore` plays it back; playback is also force-stopped and restored on
/// BEFORE_SAVE / BEFORE_CLOSE / BEFORE_NEW / SHEET_CHANGED). `scenario_show` has no
/// registry to present, so it cannot construct one of these and cannot claim the
/// exemption -- the distinction is structural rather than remembered.
#[must_use = "a TransientScope is proof for DocumentEffect::transient; dropping it discards the proof"]
pub struct TransientScope {
    token: String,
}

impl TransientScope {
    /// The only constructor. Succeeds only if `token` is present in the snapshot
    /// registry that the paired restore command will read.
    pub fn prove_restore_registered<V>(
        registry: &HashMap<String, V>,
        token: &str,
    ) -> Result<Self, String> {
        if registry.contains_key(token) {
            Ok(TransientScope { token: token.to_string() })
        } else {
            Err(format!(
                "Transient write refused: no restore snapshot is registered for token '{}'. \
                 A transient write is only legal when the state it overwrites can be put back.",
                token
            ))
        }
    }

    /// The token this scope is proof for.
    pub fn token(&self) -> &str {
        &self.token
    }
}

// ============================================================================
// DocumentEffect
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EffectKind {
    Mutates,
    Transient,
    DeliberatelyClean(CleanReason),
}

/// A decision about what a write does to the saved document.
///
/// Deliberately NOT `Clone`, NOT `Copy`, NOT `Default`, and with a private field: the
/// only way to obtain one is to call a constructor, and every constructor is a decision.
/// Pass it by reference (`&effect`) to as many `write()` calls as one command needs.
#[must_use = "constructing a DocumentEffect is the decision; bind it (`let effect = ...`) and pass it to the writes it authorises"]
pub struct DocumentEffect {
    kind: EffectKind,
}

impl DocumentEffect {
    /// This write changes what a save would write to disk. **Marks the workbook dirty
    /// immediately**, so holding this value is proof the flag is set.
    ///
    /// ANNOUNCEMENT. Setting the flag here is also what makes the title-bar asterisk
    /// appear: [`DirtyFlag`] emits `document:dirty-changed` on the clean->dirty
    /// TRANSITION, so a backend-only mutation is visible without asking the command to
    /// remember to emit anything. A mutation of an already-dirty document announces
    /// nothing.
    ///
    /// ORDERING. Construct it AFTER any protection/permission gate and at the point the
    /// mutation is actually committed, never at the top of a command that might still
    /// refuse: the flag is set eagerly and a refusal would leave a spuriously dirty
    /// document. For conditional mutations ("only if something actually changed"),
    /// construct it inside the branch that changes something -- see
    /// `commands::data::update_cells_batch`, which already works this way.
    pub fn mutates(file_state: &FileState) -> Self {
        file_state.set_dirty(DirtyWrite::new(), true);
        DocumentEffect { kind: EffectKind::Mutates }
    }

    /// This write is transient: it will be undone by the restore proven by `scope`, and
    /// must not dirty the document. See [`TransientScope`].
    pub fn transient(_scope: &TransientScope) -> Self {
        DocumentEffect { kind: EffectKind::Transient }
    }

    /// This write touches persisted state but deliberately leaves the document clean.
    /// Every use of this is an audit point; see [`CleanReason`].
    pub fn deliberately_clean(reason: CleanReason) -> Self {
        DocumentEffect { kind: EffectKind::DeliberatelyClean(reason) }
    }

    /// Whether this effect marked the document dirty. For tests and audit surfaces.
    pub fn marks_dirty(&self) -> bool {
        matches!(self.kind, EffectKind::Mutates)
    }

    /// Stable label for audit output and test assertions.
    pub fn label(&self) -> &'static str {
        match self.kind {
            EffectKind::Mutates => "mutates",
            EffectKind::Transient => "transient",
            EffectKind::DeliberatelyClean(r) => r.label(),
        }
    }
}

impl fmt::Debug for DocumentEffect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DocumentEffect({})", self.label())
    }
}

// ============================================================================
// Persisted<T> -- a store whose writes require a decision
// ============================================================================

/// A `Mutex<T>` holding state that is written into the .cala by the save path.
///
/// Reads are free. Writes require a [`DocumentEffect`], which is what makes forgetting
/// the dirty flag a compile error rather than a silent data-loss bug.
///
/// Migration from a bare `Mutex<T>` is mechanical:
///   `store.lock().unwrap()`            -> `store.read().unwrap()`               (read)
///   `let mut g = store.lock().unwrap()`-> `let mut g = store.write(&effect).unwrap()` (write)
/// and `LockPoisoned` implements `Display`, so `.map_err(|e| e.to_string())?` still works.
pub struct Persisted<T> {
    inner: Mutex<T>,
}

/// Returned when the underlying mutex is poisoned. Mirrors the old
/// `.lock()` failure mode so call sites can keep `.unwrap()` / `.map_err(..)`.
#[derive(Debug)]
pub struct LockPoisoned;

impl fmt::Display for LockPoisoned {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "poisoned lock")
    }
}

impl std::error::Error for LockPoisoned {}

impl<T> Persisted<T> {
    pub fn new(value: T) -> Self {
        Persisted { inner: Mutex::new(value) }
    }

    /// Read-only access. Free -- reading never changes what a save writes.
    pub fn read(&self) -> Result<ReadGuard<'_, T>, LockPoisoned> {
        self.inner.lock().map(ReadGuard).map_err(|_| LockPoisoned)
    }

    /// Mutable access. Requires a [`DocumentEffect`]: the caller must have decided
    /// whether this write dirties the document, and if it does, the flag is already set.
    pub fn write(&self, _effect: &DocumentEffect) -> Result<WriteGuard<'_, T>, LockPoisoned> {
        self.inner.lock().map(WriteGuard).map_err(|_| LockPoisoned)
    }

    /// Replace the whole value. Same gate as [`Persisted::write`]; a convenience for the
    /// load path, which assigns rather than edits.
    pub fn replace(&self, effect: &DocumentEffect, value: T) -> Result<(), LockPoisoned> {
        let mut guard = self.write(effect)?;
        *guard = value;
        Ok(())
    }

    /// Take the lock NOW and decide about dirtiness LATER, in the same critical
    /// section. Reads through the returned guard immediately; call
    /// [`PendingGuard::authorize`] with a [`DocumentEffect`] to obtain `&mut`.
    ///
    /// WHY THIS EXISTS -- AND WHY IT IS NOT A LOOPHOLE
    /// ----------------------------------------------
    /// [`DocumentEffect::mutates`] dirties AT CONSTRUCTION, so it must be built
    /// *after* every gate that can still refuse -- otherwise a rejected command
    /// leaves a spuriously dirty document. But the gates themselves READ the store
    /// they are about to guard: sheet protection resolves a cell's lock state
    /// through the grid and the style tiers, so it needs `&Grid` before anything is
    /// decided. Every gated command therefore has the shape
    ///
    ///     lock the grid  ->  run the gates (may return Err)  ->  decide  ->  mutate
    ///
    /// and `write(&effect)` cannot express its first step, because the effect does
    /// not exist yet.
    ///
    /// The obvious workaround -- `read()` for the gate, drop it, then
    /// `write(&effect)` -- is WRONG, and that is the whole argument for this method.
    /// Tauri dispatches commands on a thread pool, so releasing the lock between the
    /// gate and the mutation opens a TOCTOU window in every gated command: the
    /// protection check passes, the lock drops, a concurrent writer changes the
    /// grid, and the mutation lands on state nobody checked. Today those commands
    /// hold ONE lock across gate and commit; that atomicity is a property worth
    /// keeping, so the guard bends instead of the callers.
    ///
    /// Nothing is weakened. `PendingGuard` has `Deref` and no `DerefMut`, exactly
    /// like [`ReadGuard`] -- holding one without deciding lets you READ, and the
    /// only route from it to `&mut T` still runs through a `DocumentEffect`. What
    /// this buys is that the gate-then-decide ORDER, which until now was a comment
    /// on `DocumentEffect::mutates` asking authors to remember, is the only order
    /// the types will accept.
    pub fn lock_pending(&self) -> Result<PendingGuard<'_, T>, LockPoisoned> {
        self.inner.lock().map(PendingGuard).map_err(|_| LockPoisoned)
    }
}

impl<T: Default> Default for Persisted<T> {
    fn default() -> Self {
        Persisted::new(T::default())
    }
}

/// Immutable guard. Derefs to `&T` only -- there is no `DerefMut`, which is what stops a
/// `read()` from being quietly upgraded into a mutation.
pub struct ReadGuard<'a, T>(MutexGuard<'a, T>);

impl<'a, T> Deref for ReadGuard<'a, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

/// A held lock whose dirty decision has not been made yet. Derefs to `&T` only;
/// [`PendingGuard::authorize`] is the sole route to `&mut T`. See
/// [`Persisted::lock_pending`].
#[must_use = "a PendingGuard grants only read access; call .authorize(&effect) to mutate"]
pub struct PendingGuard<'a, T>(MutexGuard<'a, T>);

impl<'a, T> Deref for PendingGuard<'a, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

impl<'a, T> PendingGuard<'a, T> {
    /// Convert this held lock into a mutable one. Consumes `self`, so the
    /// read-only view is gone rather than aliased, and the underlying mutex is
    /// never released in between -- the gate and the mutation stay in one
    /// critical section.
    pub fn authorize(self, _effect: &DocumentEffect) -> WriteGuard<'a, T> {
        WriteGuard(self.0)
    }
}

/// A seeding effect for unit-test harnesses: building a two-sheet `AppState`
/// by hand is not a document edit.
///
/// `#[cfg(test)]`, so it does not exist in the shipped binary and the guarantee
/// this module makes outside the test build is unchanged. It exists because
/// dozens of harnesses push per-sheet slots onto the parallel vectors, and
/// spelling `deliberately_clean(CleanReason::LoadingFromDisk)` out at each of
/// them buries the assertion the test is actually making.
#[cfg(test)]
pub fn test_seed_effect() -> DocumentEffect {
    DocumentEffect::deliberately_clean(CleanReason::LoadingFromDisk)
}

/// Mutable guard, obtainable only by presenting a [`DocumentEffect`].
pub struct WriteGuard<'a, T>(MutexGuard<'a, T>);

impl<'a, T> Deref for WriteGuard<'a, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

impl<'a, T> DerefMut for WriteGuard<'a, T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_dirty(fs: &FileState) -> bool {
        fs.is_dirty()
    }

    #[test]
    fn mutates_marks_dirty_at_construction() {
        let fs = FileState::default();
        assert!(!is_dirty(&fs));
        let effect = DocumentEffect::mutates(&fs);
        // The flag is set by the constructor, before any write happens: possession of
        // the value is proof, so no early return can skip it.
        assert!(is_dirty(&fs));
        assert!(effect.marks_dirty());
    }

    #[test]
    fn deliberately_clean_does_not_mark_dirty() {
        let fs = FileState::default();
        let store: Persisted<Vec<u32>> = Persisted::new(Vec::new());
        let effect = DocumentEffect::deliberately_clean(CleanReason::LoadingFromDisk);
        store.write(&effect).unwrap().push(7);
        assert_eq!(store.read().unwrap().len(), 1);
        assert!(!is_dirty(&fs));
        assert!(!effect.marks_dirty());
        assert_eq!(effect.label(), "loading-from-disk");
    }

    #[test]
    fn transient_requires_a_registered_restore() {
        let mut registry: HashMap<String, Vec<u8>> = HashMap::new();
        // scenario_show's shape: nothing registered -> the scope cannot be built, so
        // DocumentEffect::transient is unreachable for it.
        assert!(TransientScope::prove_restore_registered(&registry, "tok-1").is_err());

        // animation's shape: anim_snapshot files the restore first.
        registry.insert("tok-1".to_string(), vec![1, 2, 3]);
        let scope = TransientScope::prove_restore_registered(&registry, "tok-1").unwrap();
        assert_eq!(scope.token(), "tok-1");

        let fs = FileState::default();
        let effect = DocumentEffect::transient(&scope);
        assert!(!effect.marks_dirty());
        assert!(!is_dirty(&fs));
    }

    // ------------------------------------------------------------------
    // DirtyFlag: the announcement that keeps the title bar in step
    // ------------------------------------------------------------------

    use std::sync::Arc;

    /// Record every announcement THIS flag makes. Instance-scoped, so the log is
    /// unaffected by the dozens of other tests in this binary that flip a
    /// FileState on other threads.
    fn recorder(flag: &DirtyFlag) -> Arc<Mutex<Vec<bool>>> {
        let log: Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&log);
        flag.set_observer(move |is_dirty| sink.lock().unwrap().push(is_dirty));
        log
    }

    fn seen(log: &Arc<Mutex<Vec<bool>>>) -> Vec<bool> {
        log.lock().unwrap().clone()
    }

    #[test]
    fn dirty_flag_announces_the_clean_to_dirty_transition() {
        let fs = FileState::default();
        let log = recorder(fs.dirty_flag());

        let _effect = DocumentEffect::mutates(&fs);

        // The defect: the flag moved but nothing told the frontend. It now does.
        assert_eq!(seen(&log), vec![true]);
        assert!(is_dirty(&fs));
    }

    #[test]
    fn dirty_flag_announces_only_transitions_not_every_mutation() {
        let fs = FileState::default();
        let log = recorder(fs.dirty_flag());

        // A bulk operation: many mutating writes over one already-dirty document.
        for _ in 0..500 {
            let _effect = DocumentEffect::mutates(&fs);
        }

        // One event, not 500. Announcing per mutation would flood the bus on a
        // large paste and buy nothing -- the indicator is already showing `*`.
        assert_eq!(seen(&log), vec![true]);
    }

    #[test]
    fn dirty_flag_announces_the_dirty_to_clean_direction_too() {
        let fs = FileState::default();
        let log = recorder(fs.dirty_flag());

        let _effect = DocumentEffect::mutates(&fs);
        // What save / new_file / open_file do as their last act.
        mark_saved(&fs);

        // Without the second announcement the asterisk would never CLEAR after a
        // backend-driven save.
        assert_eq!(seen(&log), vec![true, false]);
        assert!(!is_dirty(&fs));
    }

    #[test]
    fn dirty_flag_reads_announce_nothing() {
        let fs = FileState::default();
        let log = recorder(fs.dirty_flag());

        // `is_file_modified` is called by the frontend from INSIDE the listener
        // this event feeds. If a read announced, that would be an infinite loop.
        for _ in 0..10 {
            let _ = fs.is_dirty();
        }
        assert_eq!(seen(&log), Vec::<bool>::new());

        let _effect = DocumentEffect::mutates(&fs);
        for _ in 0..10 {
            let _ = fs.is_dirty();
        }
        assert_eq!(seen(&log), vec![true]);
    }

    #[test]
    fn dirty_flag_announces_both_of_the_two_remaining_write_paths() {
        // There are exactly two writers left in the crate, and both are in this
        // module: `DocumentEffect::mutates` and `mark_saved`. The ~60 direct
        // `*is_modified.lock() = true` sites and the 15
        // `mark_workbook_modified` calls that this test used to cover are gone --
        // `FileState::is_modified` is private and `FileState::set_dirty` demands
        // a `DirtyWrite`, which only this module can mint.
        let fs = FileState::default();
        let log = recorder(fs.dirty_flag());
        let _effect = DocumentEffect::mutates(&fs);
        assert_eq!(seen(&log), vec![true]);

        let fs2 = FileState::default();
        let log2 = recorder(fs2.dirty_flag());
        let _effect2 = DocumentEffect::mutates(&fs2);
        mark_saved(&fs2);
        assert_eq!(seen(&log2), vec![true, false]);
    }

    #[test]
    fn deliberately_clean_and_transient_announce_nothing() {
        let fs = FileState::default();
        let log = recorder(fs.dirty_flag());

        let _clean = DocumentEffect::deliberately_clean(CleanReason::Navigation);
        let mut registry: HashMap<String, Vec<u8>> = HashMap::new();
        registry.insert("tok".to_string(), vec![1]);
        let scope = TransientScope::prove_restore_registered(&registry, "tok").unwrap();
        let _transient = DocumentEffect::transient(&scope);

        // Merely LOOKING at a workbook must not raise the asterisk.
        assert_eq!(seen(&log), Vec::<bool>::new());
    }

    #[test]
    fn dirty_flag_payload_is_camel_case() {
        // Golden rule: Rust snake_case field, camelCase on the wire, so the
        // bridge in bootstrap.ts can read `payload.isDirty`.
        let json = serde_json::to_string(&DirtyStatePayload { is_dirty: true }).unwrap();
        assert_eq!(json, r#"{"isDirty":true}"#);
    }

    #[test]
    fn writes_go_through_the_guard() {
        let fs = FileState::default();
        let store: Persisted<Vec<u32>> = Persisted::new(vec![1]);
        {
            let effect = DocumentEffect::mutates(&fs);
            let mut g = store.write(&effect).unwrap();
            g.push(2);
        }
        assert_eq!(*store.read().unwrap(), vec![1, 2]);
        assert!(is_dirty(&fs));
    }

    // ------------------------------------------------------------------
    // The sole-writer guarantee
    // ------------------------------------------------------------------

    /// Every `.rs` under `src/`, so the scans below cannot be fooled by a new file.
    fn crate_sources() -> Vec<(std::path::PathBuf, String)> {
        fn walk(dir: &std::path::Path, out: &mut Vec<(std::path::PathBuf, String)>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        out.push((path, text));
                    }
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut out = Vec::new();
        walk(&root, &mut out);
        assert!(out.len() > 50, "source walk found only {} files", out.len());
        out
    }

    /// Lines that are not comments (the flag is discussed in prose all over the
    /// crate; only executable references matter here).
    fn code_lines(text: &str) -> impl Iterator<Item = (usize, &str)> {
        text.lines().enumerate().filter(|(_, l)| {
            let t = l.trim_start();
            !t.starts_with("//") && !t.starts_with("///") && !t.starts_with("//!")
        })
    }

    /// D9 STANDS: CALCULA HAS ONE DATE SYSTEM (open-items 1.2).
    ///
    /// The decision is to offer no 1904-date-system setting. The 1904 system
    /// exists to paper over Lotus 1-2-3's fictitious 1900-02-29, which Calcula
    /// deliberately reproduces for Excel serial parity; a 1904 workbook is
    /// CONVERTED AT IMPORT (`xlsx_reader::converts_from_1904`) and written back
    /// as 1900 with the attribute omitted. Excel's own documentation warns that
    /// toggling the setting changes what every date in a workbook means without
    /// moving a single stored value — precisely the silent-corruption shape
    /// this crate spends its time removing.
    ///
    /// WHY A CENSUS AND NOT A TYPE. The absence of a concept cannot be enforced
    /// by the compiler: there is no private field to protect, because the
    /// correct implementation is that no field exists. Until now the claim was
    /// true by grep only, and a grep is not a guard — someone adding a
    /// `date_system` to `AppState` or a `File ▸ Options` toggle would turn
    /// nothing red. Same reasoning as `is_modified_has_no_writer_outside_
    /// document_effect` below: pin the shape of the remedy.
    ///
    /// It lives in this module, off-theme, because the source-walking machinery
    /// it needs (`crate_sources`, whose own `out.len() > 50` assertion stops a
    /// broken walk from passing vacuously, and `code_lines`, which keeps prose
    /// discussion legal) is here. Re-implementing it elsewhere would be a
    /// second source of truth about what "every file in the crate" means.
    /// THE NEEDLES ARE ASSEMBLED, NOT WRITTEN OUT, and the failure message
    /// spells none of them either. A census that names what it forbids matches
    /// ITSELF, and the obvious repair — exempting the file it lives in — would
    /// blind it to a setting genuinely added to this module. Building the
    /// strings at runtime keeps the census total: every file in the crate is
    /// searched, including this one.
    #[test]
    fn no_calendar_epoch_setting_exists_outside_the_xlsx_importer() {
        let needles = [
            format!("date{}", 1904),
            format!("date{}system", '_'),
            format!("Date{}", "System"),
        ];
        let mut offenders: Vec<String> = Vec::new();
        for (path, text) in crate_sources() {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            for (i, line) in code_lines(&text) {
                for needle in &needles {
                    if line.contains(needle.as_str()) {
                        offenders.push(format!("{}:{}: {}", name, i + 1, line.trim()));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "D9 stands — Calcula has ONE calendar epoch (Excel's 1900 system). A \
             flag naming a second one in the app crate means a setting was \
             half-added. Convert a foreign epoch AT IMPORT \
             (`core/persistence/src/xlsx_reader.rs::converts_from_1904`); never \
             store an epoch. If a Mac-authored process really needs the OOXML \
             workbook-level flag written back, that is an EXPORT option, not a \
             setting.\n{}",
            offenders.join("\n")
        );
    }

    /// THE GUARANTEE THIS WHOLE MODULE EXISTS FOR.
    ///
    /// `FileState::is_modified` is private, so the compiler already rejects an
    /// outside writer -- that is the real enforcement and it cannot be evaded.
    /// This test pins the SHAPE of the remedy rather than re-proving the
    /// compiler: it fails if someone re-widens the field, or adds a third way to
    /// reach `set_dirty` in a module that is not this one.
    ///
    /// Without it, `pub is_modified` could come back in a hurry-up diff and
    /// every direct write in the crate would compile again in silence -- which
    /// is precisely the state the dirty-flag census started from.
    #[test]
    fn is_modified_has_no_writer_outside_document_effect() {
        let mut offenders: Vec<String> = Vec::new();
        for (path, text) in crate_sources() {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let is_flag_owner = name == "document_effect.rs" || name == "persistence.rs";
            for (i, line) in code_lines(&text) {
                // The field itself, reached from anywhere outside its own module.
                if line.contains(".is_modified") && !is_flag_owner {
                    offenders.push(format!("{}:{}: {}", name, i + 1, line.trim()));
                }
                // The private setter, called from outside this module.
                if line.contains("set_dirty(") && name != "document_effect.rs" && name != "persistence.rs" {
                    offenders.push(format!("{}:{}: {}", name, i + 1, line.trim()));
                }
                // The capability token, minted anywhere but here.
                if line.contains("DirtyWrite") && name != "document_effect.rs" && name != "persistence.rs" {
                    offenders.push(format!("{}:{}: {}", name, i + 1, line.trim()));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "`FileState::is_modified` must have exactly one writing module \
             (`document_effect`). These reach it from elsewhere:\n{}",
            offenders.join("\n")
        );
    }

    /// The field must stay PRIVATE. A `pub` here is what would silently re-open
    /// every direct-write path, so it is asserted on the source text: nothing
    /// else can notice the difference until a bug report arrives.
    #[test]
    fn the_dirty_flag_field_is_private() {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/persistence.rs"),
        )
        .expect("persistence.rs");
        let decl = code_lines(&src)
            .find(|(_, l)| l.trim_start().starts_with("is_modified:") || l.contains("pub is_modified"))
            .map(|(_, l)| l.trim().to_string())
            .expect("FileState must still declare an is_modified field");
        assert_eq!(
            decl, "is_modified: crate::document_effect::DirtyFlag,",
            "the dirty flag must stay private -- `pub` re-opens every direct write \
             the census closed"
        );
    }

    /// `DirtyWrite` is minted in exactly the two places that are allowed to move
    /// the flag: `DocumentEffect::mutates` (set) and `mark_saved` (clear). A
    /// third `DirtyWrite::new()` is a new writer and must be argued for.
    #[test]
    fn the_capability_token_is_minted_exactly_twice() {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/document_effect.rs"),
        )
        .expect("document_effect.rs");
        // Split so this line does not contain the literal it is searching for --
        // the first version of this test counted itself and reported three.
        let needle = concat!("set_dirty(DirtyWrite", "::new()");
        let mints: Vec<&str> = code_lines(&src)
            .map(|(_, l)| l.trim())
            .filter(|l| l.contains(needle))
            .collect();
        assert_eq!(
            mints.len(),
            2,
            "expected exactly two DirtyWrite mints (mutates + mark_saved), found: {:#?}",
            mints
        );
    }

    /// The grid is the document. If either half of the pair goes back to a bare
    /// `Mutex`, `.lock()` returns a `MutexGuard` and every one of the 391 call
    /// sites this refactor gated can mutate undecided again -- with no error
    /// anywhere, which is exactly how the gap survived the first census.
    #[test]
    fn the_grid_stores_are_persisted_not_bare_mutexes() {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"),
        )
        .expect("lib.rs");
        for decl in [
            "pub grids: document_effect::Persisted<Vec<Grid>>,",
            "pub grid: document_effect::Persisted<Grid>,",
        ] {
            assert!(
                code_lines(&src).any(|(_, l)| l.trim() == decl),
                "AppState must declare `{}` -- a bare Mutex here ungates every grid write",
                decl
            );
        }
    }

    /// THE FIELDS WHOSE `Persisted<T>` STATUS IS NOT SELF-EVIDENT.
    ///
    /// The grid pair above is obviously the document, so nobody would demote it
    /// by accident. These are the ones that LOOK like view state and are not:
    /// widths, hidden rows, zoom, split bars, the active index, the style
    /// registry, the filter and protection stores. Every one of them ends up in
    /// the .cala, and every one of them was a bare `Mutex` until this pass -- so
    /// the failure mode this test exists for is a future author reading
    /// `sheet_zooms` as "just the viewport" and reaching for `Mutex` again.
    ///
    /// The check is on the source text because there is nothing else to check:
    /// a demotion compiles, `.lock()` hands back a `MutexGuard`, and every one
    /// of the ~1,100 call sites gated here silently mutates undecided again.
    #[test]
    fn every_persisted_appstate_store_is_gated_not_a_bare_mutex() {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"),
        )
        .expect("lib.rs");

        // (field, why it reaches disk) -- the second half is the argument, and
        // it is here so a future demotion has to be argued against, not just
        // made to compile.
        let must_be_gated: &[(&str, &str)] = &[
            ("sheet_names", "Sheet::name, every save"),
            ("sheet_ids", "Sheet::id -- the stable identity every SheetId-keyed section resolves through"),
            ("active_sheet", "workbook.active_sheet (gated to say NO: writes are Navigation)"),
            ("style_registry", "Sheet::from_grid resolves every cell's style through it"),
            ("column_widths", "DimensionData, active sheet"),
            ("row_heights", "DimensionData, active sheet"),
            ("all_column_widths", "DimensionData, background sheets"),
            ("all_row_heights", "DimensionData, background sheets"),
            ("default_row_height", "workbook.default_row_height"),
            ("default_column_width", "workbook.default_column_width"),
            ("merged_regions", "Sheet::merged_regions, active sheet"),
            ("all_merged_regions", "Sheet::merged_regions, background sheets"),
            ("user_hidden_rows", "Sheet::user_hidden_rows -- a third hidden-ness AUTHORITY with nowhere else to live"),
            ("user_hidden_cols", "Sheet::user_hidden_cols"),
            ("all_user_hidden_rows", "Sheet::user_hidden_rows, background sheets"),
            ("all_user_hidden_cols", "Sheet::user_hidden_cols, background sheets"),
            ("sheet_zooms", "Sheet::zoom (.cala v6)"),
            ("split_configs", "Sheet::split_row / split_col"),
            ("auto_filters", "user_files/autofilters.json"),
            ("sheet_protection", "workbook.sheet_protections"),
            ("workbook_protection", "workbook.workbook_protection"),
            ("model_writeback", "user_files/model_writeback_values.json"),
        ];

        let mut ungated: Vec<String> = Vec::new();
        for (field, why) in must_be_gated {
            let decl = code_lines(&src)
                .map(|(_, l)| l.trim())
                .find(|l| l.starts_with(&format!("pub {}:", field)))
                .unwrap_or_else(|| panic!("AppState no longer declares `{}`", field));
            if !decl.contains("Persisted<") {
                ungated.push(format!("{}  ({})\n      {}", field, why, decl));
            }
        }
        assert!(
            ungated.is_empty(),
            "these AppState stores are written into the .cala and MUST be \
             `Persisted<T>`; a bare Mutex re-opens every write on them:\n  {}",
            ungated.join("\n  ")
        );
    }

    /// The negative half: `scroll_areas` must STAY a bare `Mutex`.
    ///
    /// It is the one store that looks like it belongs in the list above and
    /// does not -- `assemble_workbook_for_save` never reads it and
    /// `persistence::Sheet` has no `scroll_area` field, so a dirty flag raised
    /// on it would promise the user that saving keeps something that is gone
    /// either way. Promoting it is only correct AFTER the persistence gap it
    /// documents is closed, and this test is what makes that ordering explicit
    /// rather than remembered.
    #[test]
    fn scroll_areas_stays_ungated_until_it_is_actually_persisted() {
        let lib = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"),
        )
        .expect("lib.rs");
        let decl = code_lines(&lib)
            .map(|(_, l)| l.trim())
            .find(|l| l.starts_with("pub scroll_areas:"))
            .expect("AppState must still declare scroll_areas");
        let persistence = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/persistence.rs"),
        )
        .expect("persistence.rs");
        let saved = code_lines(&persistence)
            .any(|(_, l)| l.contains("scroll_area") && l.contains("workbook"));
        assert!(
            !saved,
            "the save path now writes scroll_areas -- promote it to Persisted<T> \
             and move it into `every_persisted_appstate_store_is_gated_not_a_bare_mutex`"
        );
        assert!(
            !decl.contains("Persisted<"),
            "scroll_areas is gated but still never saved: a dirty flag on state \
             that never reaches disk makes the close prompt lie in the other \
             direction. Fix the persistence gap first."
        );
    }
}
