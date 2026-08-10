//! FILENAME: app/src-tauri/src/undo_history.rs
// PURPOSE: `AppState::undo_stack` as a store that ANNOUNCES its own
//          availability transitions, so the Undo/Redo affordances can be
//          enabled and disabled the way Excel's are.
//
// THE DEFECT THIS CLOSES
// ----------------------
// The Home tab rendered Undo and Redo as plain buttons and the Edit menu item
// carried no enablement, so the app offered an undo it might not have: press
// Undo on a freshly-opened workbook and nothing happens, with no signal that
// nothing COULD happen. Measured while writing `undo-across-open.spec.ts`
// (register §3ax(1)): nothing in `app/src` or `app/extensions` read `canUndo`
// for a UI state at all.
//
// WHY THE ANNOUNCEMENT LIVES ON THE STACK AND NOT AT THE CALL SITES
// -----------------------------------------------------------------
// This is `DirtyFlag`'s argument, one store over, and it is the same argument
// because it is the same shape. There are ~100 `undo_stack.lock()` sites across
// 30 files; every one of them can change undo availability, and asking each to
// remember an emit is the failure mode the dirty-flag census exists to end.
// So the announcement sits on the one thing every writer must already touch —
// the lock — and the guard compares availability at acquisition against
// availability at release.
//
// The polling alternative is worse than verbose, it is WRONG: a frontend that
// re-reads `get_undo_state` after its own commands still learns nothing about
// a mutation that originated in the backend (a script, an MCP tool, a package
// pull, a scheduled job), which is exactly the class of edit the dirty
// indicator used to miss.
//
// AND `document:dirty-changed` IS NOT ENOUGH, which is why this is its own
// channel rather than a second subscriber to that one. The dirty flag
// announces TRANSITIONS, and the two states are not in step:
//
//   * undo back to depth 0 leaves the document dirty; the next edit then moves
//     `can_undo` false -> true with no dirty transition at all;
//   * an edit after an undo clears the redo stack — `can_redo` true -> false —
//     while the document was already dirty and stays dirty.
//
// Both of those are a stale ribbon button under a dirty-flag subscription.
//
// ONLY TRANSITIONS ARE ANNOUNCED. A 10,000-cell paste that pushes one
// transaction onto an already-non-empty stack emits nothing; typing in ten
// cells in a row emits at most one event (the first). That is the difference
// between an ambient signal and a flood, and it matters more here than for the
// dirty flag because the undo stack is locked far more often than the flag is
// written.
//
// READS ARE FREE. `lock()` for a read releases with availability unchanged, so
// no event fires — including the `get_undo_state` the frontend calls from
// inside the very listener this feeds, which would otherwise loop forever.

use std::fmt;
use std::ops::{Deref, DerefMut};
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::document_effect::LockPoisoned;
use engine::UndoStack;

// ============================================================================
// The announcement
// ============================================================================

/// The Tauri event the backend emits when undo/redo AVAILABILITY changes.
///
/// Bridged onto the `@api` event bus (`AppEvents.UNDO_STATE_CHANGED`) by
/// `app/src/shell/undoStateBridge.ts`.
pub const UNDO_STATE_EVENT: &str = "document:undo-state-changed";

/// Payload of [`UNDO_STATE_EVENT`], and the value the guard compares.
///
/// DEPTHS AND DESCRIPTIONS ARE DELIBERATELY ABSENT. They change on every single
/// edit, so carrying them would turn a transition announcement back into a
/// flood — and nothing in the UI needs them: a button is enabled or it is not.
/// `get_undo_state` still reports them for the test oracles that read depth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoAvailability {
    pub can_undo: bool,
    pub can_redo: bool,
}

impl UndoAvailability {
    fn of(stack: &UndoStack) -> Self {
        UndoAvailability {
            can_undo: stack.can_undo(),
            can_redo: stack.can_redo(),
        }
    }
}

/// The app handle used to announce availability transitions. Installed once
/// from `run()`; absent in unit tests, where announcing is a no-op.
static UNDO_ANNOUNCER: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Install the handle that [`UndoHistory`] announces transitions through.
/// Called once from `run()`, alongside `install_dirty_announcer`.
pub fn install_undo_announcer(app: tauri::AppHandle) {
    let _ = UNDO_ANNOUNCER.set(app);
}

/// Emit the transition to every window. No-op before the handle is installed.
fn announce_globally(availability: UndoAvailability) {
    if let Some(app) = UNDO_ANNOUNCER.get() {
        use tauri::Emitter;
        let _ = app.emit(UNDO_STATE_EVENT, availability);
    }
}

/// Observer invoked with the NEW availability whenever it actually changes.
type UndoObserver = Box<dyn Fn(UndoAvailability) + Send + Sync>;

// ============================================================================
// UndoHistory -- the stack that announces its own transitions
// ============================================================================

/// `AppState::undo_stack`: a `Mutex<UndoStack>` that announces every
/// availability transition.
///
/// `Mutex`-shaped on purpose (`lock()` returning a `Result` whose error is
/// `Debug + Display`), so the ~100 existing `.unwrap()`,
/// `.map_err(|e| e.to_string())?`, `if let Ok(..)` and `let Ok(..) else` call
/// sites are unchanged. A future writer cannot bypass the announcement without
/// replacing the field's type.
pub struct UndoHistory {
    inner: Mutex<UndoStack>,
    /// Test-only redirection of the announcement, scoped to ONE instance.
    ///
    /// A global test sink would be polluted by every other test in the binary
    /// that touches an `AppState` — and there are hundreds. Binding the
    /// observer to the instance under test makes the assertion independent of
    /// test ordering and of `cargo test`'s thread pool. Same reasoning, and the
    /// same shape, as `DirtyFlag::observer`.
    observer: Mutex<Option<UndoObserver>>,
}

impl UndoHistory {
    pub fn new(stack: UndoStack) -> Self {
        UndoHistory {
            inner: Mutex::new(stack),
            observer: Mutex::new(None),
        }
    }

    /// Lock the stack. Reading through the guard is free; leaving it with a
    /// DIFFERENT `(can_undo, can_redo)` announces the transition on release.
    pub fn lock(&self) -> Result<UndoHistoryGuard<'_>, LockPoisoned> {
        match self.inner.lock() {
            Ok(guard) => {
                let was = UndoAvailability::of(&guard);
                Ok(UndoHistoryGuard {
                    history: self,
                    guard: Some(guard),
                    was,
                })
            }
            Err(_) => Err(LockPoisoned),
        }
    }

    /// Announce a transition: to the instance observer if a test installed one,
    /// otherwise to every window through the installed app handle.
    fn announce(&self, availability: UndoAvailability) {
        if let Ok(observer) = self.observer.lock() {
            if let Some(f) = observer.as_ref() {
                f(availability);
                return;
            }
        }
        announce_globally(availability);
    }

    /// Redirect this instance's announcements. Tests only — production code has
    /// exactly one announcer, installed at startup.
    #[cfg(test)]
    pub fn set_observer(&self, f: impl Fn(UndoAvailability) + Send + Sync + 'static) {
        if let Ok(mut observer) = self.observer.lock() {
            *observer = Some(Box::new(f));
        }
    }
}

impl Default for UndoHistory {
    fn default() -> Self {
        UndoHistory::new(UndoStack::new())
    }
}

impl fmt::Debug for UndoHistory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.inner.lock() {
            Ok(s) => write!(f, "UndoHistory({:?})", *s),
            Err(_) => write!(f, "UndoHistory(poisoned)"),
        }
    }
}

/// Guard over [`UndoHistory`]. Derefs to `UndoStack` in both directions;
/// announces on release if availability changed.
pub struct UndoHistoryGuard<'a> {
    history: &'a UndoHistory,
    /// `Option` so `Drop` can RELEASE the mutex before announcing. Emitting
    /// while still holding it would publish to every window from inside the
    /// critical section, and a listener's first act is to call back into
    /// `get_undo_state` — which locks this very mutex.
    guard: Option<MutexGuard<'a, UndoStack>>,
    was: UndoAvailability,
}

impl<'a> Deref for UndoHistoryGuard<'a> {
    type Target = UndoStack;
    fn deref(&self) -> &UndoStack {
        self.guard.as_ref().expect("UndoHistoryGuard used after drop")
    }
}

impl<'a> DerefMut for UndoHistoryGuard<'a> {
    fn deref_mut(&mut self) -> &mut UndoStack {
        self.guard.as_mut().expect("UndoHistoryGuard used after drop")
    }
}

impl<'a> Drop for UndoHistoryGuard<'a> {
    fn drop(&mut self) {
        let Some(guard) = self.guard.take() else { return };
        let now = UndoAvailability::of(&guard);
        drop(guard);
        if now != self.was {
            self.history.announce(now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Collect every announcement this instance makes.
    fn recorder(history: &UndoHistory) -> Arc<Mutex<Vec<UndoAvailability>>> {
        let seen: Arc<Mutex<Vec<UndoAvailability>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        history.set_observer(move |a| sink.lock().unwrap().push(a));
        seen
    }

    fn push_one(history: &UndoHistory, description: &str) {
        let mut stack = history.lock().unwrap();
        stack.begin_transaction(description.to_string());
        stack.record_cell_change(0, 0, 0, None);
        stack.commit_transaction();
    }

    #[test]
    fn the_first_edit_announces_that_undo_became_available() {
        let history = UndoHistory::default();
        let seen = recorder(&history);
        push_one(&history, "Edit cell");
        assert_eq!(
            *seen.lock().unwrap(),
            vec![UndoAvailability { can_undo: true, can_redo: false }],
            "the transition from an empty stack to a non-empty one is exactly \
             what enables the Undo button, and it was not announced"
        );
    }

    #[test]
    fn a_second_edit_announces_nothing() {
        let history = UndoHistory::default();
        push_one(&history, "First");
        let seen = recorder(&history);
        push_one(&history, "Second");
        assert!(
            seen.lock().unwrap().is_empty(),
            "an edit that does not CHANGE availability announced anyway — that \
             is one IPC event per keystroke, which is why this compares rather \
             than emits"
        );
    }

    #[test]
    fn reading_the_stack_announces_nothing() {
        let history = UndoHistory::default();
        push_one(&history, "First");
        let seen = recorder(&history);
        {
            let stack = history.lock().unwrap();
            assert!(stack.can_undo());
            assert_eq!(stack.undo_depth(), 1);
        }
        assert!(
            seen.lock().unwrap().is_empty(),
            "a READ announced. The frontend calls `get_undo_state` from inside \
             the listener this event feeds, so a read that announces is an \
             infinite loop"
        );
    }

    #[test]
    fn undoing_the_last_entry_announces_both_halves_of_the_move() {
        let history = UndoHistory::default();
        push_one(&history, "First");
        let seen = recorder(&history);
        {
            let mut stack = history.lock().unwrap();
            let popped = stack.pop_undo();
            assert!(popped.is_some());
            stack.push_redo(popped.unwrap());
        }
        assert_eq!(
            *seen.lock().unwrap(),
            vec![UndoAvailability { can_undo: false, can_redo: true }],
            "after undoing the only entry, Undo must go grey and Redo must \
             light up — one event carrying both, because they moved together"
        );
    }

    #[test]
    fn replacing_the_stack_wholesale_announces_the_reset() {
        // The document-replacing paths assign a fresh `UndoStack` through this
        // same guard (`*state.undo_stack.lock()? = UndoStack::new()`), so File
        // > New and File > Open must grey the buttons out with nothing extra
        // written at those call sites. That is the whole point of putting the
        // announcement on the store.
        let history = UndoHistory::default();
        push_one(&history, "First");
        let seen = recorder(&history);
        {
            let mut stack = history.lock().unwrap();
            *stack = UndoStack::new();
        }
        assert_eq!(
            *seen.lock().unwrap(),
            vec![UndoAvailability { can_undo: false, can_redo: false }],
            "`reset_document_scoped_stores` replaces the stack through this \
             guard; if that does not announce, a freshly opened workbook keeps \
             offering the previous document's undo"
        );
    }

    #[test]
    fn the_payload_is_camel_case_over_the_wire() {
        // The naming rule: Rust snake_case fields, camelCase JSON, via the
        // struct-level rename. The bridge reads `canUndo`/`canRedo`.
        let json = serde_json::to_string(&UndoAvailability { can_undo: true, can_redo: false })
            .expect("the payload must serialise");
        assert_eq!(json, r#"{"canUndo":true,"canRedo":false}"#);
    }
}
