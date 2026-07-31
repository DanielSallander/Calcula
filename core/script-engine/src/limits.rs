//! FILENAME: core/script-engine/src/limits.rs
//! PURPOSE: Runtime safety limits for the embedded QuickJS interpreter.
//! CONTEXT: A hostile or merely buggy script must never wedge the thread that
//! runs it. This module owns the three guards every QuickJS Runtime in the
//! engine installs: a heap ceiling, a JS stack ceiling, and a wall-clock
//! deadline enforced through QuickJS's interrupt handler. The deadline is
//! re-armable so a long-lived runtime (the notebook session) can budget each
//! execution independently instead of the session as a whole.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Instant;

use rquickjs::Runtime;
use serde::{Deserialize, Serialize};

/// Heap ceiling for a script runtime (256 MB).
///
/// Large enough that a legitimate analysis cell can materialize a multi-million
/// cell result set, small enough that an allocation bomb fails fast instead of
/// pushing the whole app into swap. QuickJS raises a normal "out of memory"
/// JS exception when the limit is hit, so the script fails with a message
/// rather than taking the process down.
pub const DEFAULT_MEMORY_BYTES: usize = 256 * 1024 * 1024;

/// JS stack ceiling (256 KB) — QuickJS's own default, pinned explicitly.
///
/// Deliberately far below the OS thread stack (Rust's default is 2 MiB for
/// spawned threads, and the notebook executor thread takes that default): the
/// JS-side limit must trip FIRST so unbounded recursion surfaces as a catchable
/// "stack overflow" exception instead of a native stack overflow that kills the
/// process. Raising this without also raising the thread stack is unsafe.
pub const DEFAULT_MAX_STACK_BYTES: usize = 256 * 1024;

/// Wall-clock budget for a one-off script (`ScriptEngine::run*`, MCP
/// `execute_script`): 5 seconds.
///
/// These run on the caller's thread inside a synchronous Tauri command, so the
/// UI is blocked for the whole budget — it has to stay short enough that a
/// runaway script feels like an error, not a hang.
pub const DEFAULT_ONE_OFF_TIMEOUT_MS: u64 = 5_000;

/// Wall-clock budget for one notebook cell: 30 seconds.
///
/// Six times the one-off budget because a notebook cell is an ANALYSIS surface:
/// it runs on the dedicated executor thread (the UI stays responsive), and a
/// single cell legitimately blocks on host round-trips — `model.query`,
/// `model.sql` — whose latency counts against this budget too, since the
/// interrupt handler only fires while the interpreter is running JS. The budget
/// is per CELL, re-armed on every run; a session may stay alive for hours.
pub const DEFAULT_NOTEBOOK_TIMEOUT_MS: u64 = 30_000;

/// Per-execution safety limits handed to a QuickJS runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptLimits {
    /// Wall-clock budget in milliseconds; 0 disables the deadline.
    pub timeout_ms: u64,
    /// Heap ceiling in bytes; 0 means unlimited (QuickJS semantics).
    pub memory_bytes: usize,
    /// JS stack ceiling in bytes.
    pub max_stack_bytes: usize,
}

impl Default for ScriptLimits {
    /// The one-off/run_script profile. `ScriptLimits::notebook()` is the
    /// longer-budget profile for notebook cells.
    fn default() -> Self {
        ScriptLimits {
            timeout_ms: DEFAULT_ONE_OFF_TIMEOUT_MS,
            memory_bytes: DEFAULT_MEMORY_BYTES,
            max_stack_bytes: DEFAULT_MAX_STACK_BYTES,
        }
    }
}

impl ScriptLimits {
    /// The notebook-cell profile: same memory/stack ceilings, longer clock.
    pub fn notebook() -> Self {
        ScriptLimits {
            timeout_ms: DEFAULT_NOTEBOOK_TIMEOUT_MS,
            ..ScriptLimits::default()
        }
    }

    /// A profile with an explicit wall-clock budget (0 = no deadline).
    pub fn with_timeout_ms(timeout_ms: u64) -> Self {
        ScriptLimits {
            timeout_ms,
            ..ScriptLimits::default()
        }
    }
}

/// A re-armable wall-clock deadline shared with the QuickJS interrupt handler.
///
/// The handler is installed ONCE per runtime and holds an `Rc` to this cell;
/// arming/disarming mutates the shared state, which is what lets a long-lived
/// notebook runtime budget each cell independently without reinstalling the
/// handler. `Cell` (not `RefCell`) because the handler runs re-entrantly from
/// inside the interpreter — it must never be able to panic on a borrow.
#[derive(Debug, Default)]
pub struct Deadline {
    /// When the current execution must stop; `None` = not armed.
    expires_at: Cell<Option<Instant>>,
    /// Budget of the current arming, for the error message.
    budget_ms: Cell<u64>,
    /// Set by the interrupt handler when it aborted an execution.
    tripped: Cell<bool>,
}

impl Deadline {
    /// A fresh, disarmed deadline.
    pub fn new() -> Rc<Self> {
        Rc::new(Deadline::default())
    }

    /// Start a new budget. `timeout_ms == 0` leaves the deadline disarmed
    /// (used by tests and by callers that opt out deliberately).
    pub fn arm(&self, timeout_ms: u64) {
        self.tripped.set(false);
        self.budget_ms.set(timeout_ms);
        if timeout_ms == 0 {
            self.expires_at.set(None);
        } else {
            self.expires_at
                .set(Some(Instant::now() + std::time::Duration::from_millis(timeout_ms)));
        }
    }

    /// Stop enforcing a budget (between notebook cells).
    pub fn disarm(&self) {
        self.expires_at.set(None);
    }

    /// The interrupt-handler body: `true` aborts the running script.
    fn expired(&self) -> bool {
        match self.expires_at.get() {
            Some(at) if Instant::now() >= at => {
                self.tripped.set(true);
                true
            }
            _ => false,
        }
    }

    /// Whether the last execution was aborted by this deadline.
    pub fn tripped(&self) -> bool {
        self.tripped.get()
    }

    /// The user-facing message for an aborted execution.
    pub fn timeout_message(&self) -> String {
        let ms = self.budget_ms.get();
        // Whole seconds when the budget divides evenly, else one decimal.
        let secs = ms as f64 / 1000.0;
        let rendered = if ms % 1000 == 0 {
            format!("{}", ms / 1000)
        } else {
            format!("{:.1}", secs)
        };
        format!("Script exceeded its time budget ({}s)", rendered)
    }
}

/// Apply `limits` to `rt` and install the interrupt handler that enforces the
/// wall-clock budget. Returns the shared `Deadline` so the caller can arm it
/// before each execution and inspect it afterwards.
///
/// The returned deadline starts DISARMED: installing limits must never abort
/// the API-registration evals that run before the user's script.
pub fn install(rt: &Runtime, limits: ScriptLimits) -> Rc<Deadline> {
    rt.set_memory_limit(limits.memory_bytes);
    rt.set_max_stack_size(limits.max_stack_bytes);

    let deadline = Deadline::new();
    let handler_deadline = deadline.clone();
    rt.set_interrupt_handler(Some(Box::new(move || handler_deadline.expired())));
    deadline
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_profiles_differ_only_in_clock() {
        let one_off = ScriptLimits::default();
        let notebook = ScriptLimits::notebook();
        assert_eq!(one_off.timeout_ms, DEFAULT_ONE_OFF_TIMEOUT_MS);
        assert_eq!(notebook.timeout_ms, DEFAULT_NOTEBOOK_TIMEOUT_MS);
        assert_eq!(one_off.memory_bytes, notebook.memory_bytes);
        assert_eq!(one_off.max_stack_bytes, notebook.max_stack_bytes);
    }

    #[test]
    fn arming_zero_leaves_the_deadline_disarmed() {
        let d = Deadline::new();
        d.arm(0);
        assert!(!d.expired());
        assert!(!d.tripped());
    }

    #[test]
    fn expiry_trips_once_armed() {
        let d = Deadline::new();
        d.arm(1);
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(d.expired());
        assert!(d.tripped());
        // Re-arming clears the trip flag (per-execution semantics).
        d.arm(60_000);
        assert!(!d.tripped());
        assert!(!d.expired());
        // Disarming stops enforcement entirely.
        d.disarm();
        assert!(!d.expired());
    }

    #[test]
    fn timeout_message_renders_seconds() {
        let d = Deadline::new();
        d.arm(5_000);
        assert_eq!(d.timeout_message(), "Script exceeded its time budget (5s)");
        d.arm(1_500);
        assert_eq!(d.timeout_message(), "Script exceeded its time budget (1.5s)");
    }
}
