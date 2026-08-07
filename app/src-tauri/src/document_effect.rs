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
use std::sync::{Mutex, MutexGuard};

use crate::persistence::FileState;

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
    /// ORDERING. Construct it AFTER any protection/permission gate and at the point the
    /// mutation is actually committed, never at the top of a command that might still
    /// refuse: the flag is set eagerly and a refusal would leave a spuriously dirty
    /// document. For conditional mutations ("only if something actually changed"),
    /// construct it inside the branch that changes something -- see
    /// `commands::data::update_cells_batch`, which already works this way.
    pub fn mutates(file_state: &FileState) -> Self {
        if let Ok(mut modified) = file_state.is_modified.lock() {
            *modified = true;
        }
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
        *fs.is_modified.lock().unwrap()
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
}
