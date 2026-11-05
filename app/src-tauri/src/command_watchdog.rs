//! FILENAME: app/src-tauri/src/command_watchdog.rs
// PURPOSE: Write into the backend log, while it is happening, that the OS main
//          thread has stopped answering, and which command it is inside.
// CONTEXT: BUG-0098. A journey run lost 5.4 hours to 64 timeouts because the
//          backend stopped returning from Tauri commands while every liveness
//          signal stayed green. Two later E2E runs (2026-10-02) showed 30-35 s
//          stalls with total IPC silence, and the evidence could not say which
//          side was stuck: "either the page's JS thread or the backend main
//          thread was blocked; the logs cannot tell which". Nothing has been
//          reproduced, so nothing here FIXES anything. This module makes the
//          next occurrence attributable from the backend log alone:
//
//            * A HEARTBEAT. A watchdog thread posts a no-op task to the main
//              thread's event loop once a second. When none has run for
//              `STALL_AFTER`, it logs `WATCHDOG|main thread silent ...`; every
//              `REPEAT_EVERY` while the silence lasts it logs again; when a beat
//              lands it logs how long the silence was. A stall with NO such line
//              means the backend's main thread was free -- look at the renderer.
//            * THE COMMAND IN FLIGHT. Every invoke the app's handler dispatches
//              is entered into a small registry for as long as the handler holds
//              it, and the silence line names each entry and how long it has
//              been running. A SYNCHRONOUS command runs inside the handler, on
//              the main thread, so a sync command that hangs is named exactly.
//              An `async` command only SPAWNS inside the handler and leaves the
//              registry at once, so its body is not timed here; a hang inside
//              one leaves the heartbeat fresh, which is itself the attribution.
//
//          WHAT THIS DELIBERATELY DOES NOT DO. It changes no dispatch: the
//          wrapper calls the generated handler with the same `Invoke` and
//          returns its answer unchanged. It takes no application lock. Its one
//          mutex is a leaf held for a push or a scan, never across a call or a
//          log write. It writes through `write_log`, which puts the line in the
//          log FILE before echoing it to stdout, so even a stdout pipe that has
//          stopped draining (one of the three candidates BUG-0098 lists) cannot
//          keep the line out of the file.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use tauri::ipc::Invoke;
use tauri::{AppHandle, Runtime};

/// Silence on the main thread for this long is reported. Ten seconds is far
/// beyond any healthy interactive command and well inside the 30-35 s stalls of
/// 2026-10-02, so those would each have left a line.
pub const STALL_AFTER: Duration = Duration::from_secs(10);
/// While a silence lasts, it is reported again this often, so a wedge that
/// never ends leaves a growing figure rather than one line.
pub const REPEAT_EVERY: Duration = Duration::from_secs(60);
/// How often the watchdog posts a heartbeat and looks.
const TICK: Duration = Duration::from_secs(1);

/// Process start, the clock every timestamp below is measured from.
static EPOCH: Lazy<Instant> = Lazy::new(Instant::now);
/// Milliseconds since `EPOCH` at which the main thread last ran a heartbeat; 0
/// until the event loop has run one (so start-up is never reported as a stall).
static LAST_BEAT_MS: AtomicU64 = AtomicU64::new(0);
/// A heartbeat is queued and has not run yet. One at a time: a stuck main thread
/// must not accumulate a queue of them.
static BEAT_PENDING: AtomicBool = AtomicBool::new(false);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static STARTED: AtomicBool = AtomicBool::new(false);

/// One command the handler is currently running.
#[derive(Debug, Clone, PartialEq)]
pub struct InFlight {
    pub id: u64,
    pub command: String,
    pub started_ms: u64,
    /// "main" or the thread's name/id, so a command that is NOT on the main
    /// thread is never mistaken for the reason the main thread is silent.
    pub thread: String,
}

static IN_FLIGHT: Lazy<Mutex<Vec<InFlight>>> = Lazy::new(|| Mutex::new(Vec::new()));

fn now_ms() -> u64 {
    // +1 so a reading taken in the very first millisecond is never the "no beat
    // yet" sentinel 0.
    EPOCH.elapsed().as_millis() as u64 + 1
}

fn thread_label() -> String {
    let t = std::thread::current();
    match t.name() {
        Some(name) => name.to_string(),
        None => format!("{:?}", t.id()),
    }
}

/// Removes its entry from the registry when the handler returns (or unwinds).
pub struct InFlightGuard {
    id: u64,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        let finished = now_ms();
        let removed = match IN_FLIGHT.lock() {
            Ok(mut list) => list
                .iter()
                .position(|e| e.id == self.id)
                .map(|i| list.swap_remove(i)),
            Err(_) => None,
        };
        // Logged AFTER the registry lock is released.
        if let Some(entry) = removed {
            let took = finished.saturating_sub(entry.started_ms);
            if took >= STALL_AFTER.as_millis() as u64 {
                crate::log_warn!(
                    "WATCHDOG",
                    "command `{}` returned after {:.1} s on thread {}",
                    entry.command,
                    took as f64 / 1000.0,
                    entry.thread
                );
            }
        }
    }
}

/// Enter `command` into the in-flight registry until the guard drops.
pub fn enter(command: &str) -> InFlightGuard {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let entry = InFlight {
        id,
        command: command.to_string(),
        started_ms: now_ms(),
        thread: thread_label(),
    };
    if let Ok(mut list) = IN_FLIGHT.lock() {
        list.push(entry);
    }
    InFlightGuard { id }
}

/// Wrap the generated invoke handler so every dispatch is in the registry while
/// the handler runs. Behaviour-neutral: same `Invoke` in, same `bool` out.
pub fn timed<R, F>(handler: F) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static
where
    R: Runtime,
    F: Fn(Invoke<R>) -> bool + Send + Sync + 'static,
{
    move |invoke: Invoke<R>| {
        let _in_flight = enter(invoke.message.command());
        handler(invoke)
    }
}

fn snapshot() -> Vec<InFlight> {
    IN_FLIGHT.lock().map(|list| list.clone()).unwrap_or_default()
}

/// What the watchdog decided to say on one tick.
#[derive(Debug, Clone, PartialEq)]
pub enum Report {
    /// The main thread has run no heartbeat for `silent_ms`. `repeat` is false
    /// on the first report of this silence.
    MainThreadSilent { silent_ms: u64, repeat: bool, in_flight: Vec<(String, u64, String)> },
    /// A heartbeat ran again after a reported silence of `silent_ms`.
    MainThreadAnswered { silent_ms: u64 },
    /// A command has been in the handler for `running_ms` (reported once per
    /// invoke, whether or not the main thread is silent).
    CommandSlow { command: String, running_ms: u64, thread: String },
}

/// The watchdog's decisions, separated from the clock and the event loop so
/// they can be tested.
#[derive(Debug, Default)]
pub struct Monitor {
    /// The beat timestamp the current reported silence started from, and when
    /// it was last reported.
    silence: Option<(u64, u64)>,
    reported_commands: HashSet<u64>,
}

impl Monitor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decide what to report at `now_ms`, given when the last heartbeat ran
    /// (`0` = none yet) and what is in flight.
    pub fn observe(&mut self, now_ms: u64, last_beat_ms: u64, in_flight: &[InFlight]) -> Vec<Report> {
        let mut out = Vec::new();
        let stall = STALL_AFTER.as_millis() as u64;
        let repeat = REPEAT_EVERY.as_millis() as u64;

        // Forget commands that have left, so the set cannot grow without bound.
        let live: HashSet<u64> = in_flight.iter().map(|e| e.id).collect();
        self.reported_commands.retain(|id| live.contains(id));
        for e in in_flight {
            let running = now_ms.saturating_sub(e.started_ms);
            if running >= stall && self.reported_commands.insert(e.id) {
                out.push(Report::CommandSlow {
                    command: e.command.clone(),
                    running_ms: running,
                    thread: e.thread.clone(),
                });
            }
        }

        if last_beat_ms == 0 {
            // The event loop has not run a heartbeat yet: start-up, not a stall.
            return out;
        }
        let silent = now_ms.saturating_sub(last_beat_ms);
        match self.silence {
            Some((from, _)) if last_beat_ms != from => {
                // A beat landed since the silence was reported.
                out.push(Report::MainThreadAnswered { silent_ms: last_beat_ms.saturating_sub(from) });
                self.silence = None;
            }
            _ => {}
        }
        if silent >= stall {
            let listed = || {
                in_flight
                    .iter()
                    .map(|e| (e.command.clone(), now_ms.saturating_sub(e.started_ms), e.thread.clone()))
                    .collect::<Vec<_>>()
            };
            match self.silence {
                None => {
                    self.silence = Some((last_beat_ms, now_ms));
                    out.push(Report::MainThreadSilent { silent_ms: silent, repeat: false, in_flight: listed() });
                }
                Some((from, last_report)) if now_ms.saturating_sub(last_report) >= repeat => {
                    self.silence = Some((from, now_ms));
                    out.push(Report::MainThreadSilent { silent_ms: silent, repeat: true, in_flight: listed() });
                }
                Some(_) => {}
            }
        }
        out
    }
}

/// One log line per report, in words a reader of the backend log can act on.
pub fn describe(report: &Report) -> String {
    match report {
        Report::MainThreadSilent { silent_ms, repeat, in_flight } => {
            let what = if in_flight.is_empty() {
                "no command is in the handler (the main thread is busy outside a command: an event \
                 handler, a run_on_main_thread task or a native modal dialog)"
                    .to_string()
            } else {
                let items: Vec<String> = in_flight
                    .iter()
                    .map(|(c, ms, t)| format!("`{}` for {:.1} s on thread {}", c, *ms as f64 / 1000.0, t))
                    .collect();
                format!("in the handler: {}", items.join(", "))
            };
            format!(
                "main thread {}silent for {:.1} s (no queued task has run); {}",
                if *repeat { "STILL " } else { "" },
                *silent_ms as f64 / 1000.0,
                what
            )
        }
        Report::MainThreadAnswered { silent_ms } => format!(
            "main thread answered again after a silence of {:.1} s",
            *silent_ms as f64 / 1000.0
        ),
        Report::CommandSlow { command, running_ms, thread } => format!(
            "command `{}` has not returned after {:.1} s on thread {}",
            command,
            *running_ms as f64 / 1000.0,
            thread
        ),
    }
}

/// Start the heartbeat thread. Idempotent; call once the app is built.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    Lazy::force(&EPOCH);
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("main-thread-watchdog".into())
        .spawn(move || {
            let mut monitor = Monitor::new();
            loop {
                std::thread::sleep(TICK);
                if !BEAT_PENDING.swap(true, Ordering::SeqCst) {
                    let posted = app.run_on_main_thread(|| {
                        LAST_BEAT_MS.store(now_ms(), Ordering::SeqCst);
                        BEAT_PENDING.store(false, Ordering::SeqCst);
                    });
                    if posted.is_err() {
                        // The event loop is gone (shutdown): nothing left to watch.
                        return;
                    }
                }
                let reports =
                    monitor.observe(now_ms(), LAST_BEAT_MS.load(Ordering::SeqCst), &snapshot());
                for report in &reports {
                    crate::log_warn!("WATCHDOG", "{}", describe(report));
                }
                if !reports.is_empty() {
                    crate::logging::flush_log();
                }
            }
        });
    if let Err(e) = spawned {
        crate::log_warn!("WATCHDOG", "could not start the main-thread watchdog: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(id: u64, command: &str, started_ms: u64) -> InFlight {
        InFlight { id, command: command.into(), started_ms, thread: "main".into() }
    }

    #[test]
    fn watchdog_reports_a_silence_once_names_the_command_and_its_end() {
        let mut m = Monitor::new();
        // Healthy: a beat a second ago, nothing slow.
        assert!(m.observe(5_000, 4_000, &[]).is_empty());
        // `new_file` entered at 5 s and the beats stopped at 5 s.
        let flight = [cmd(7, "new_file", 5_000)];
        assert!(m.observe(14_000, 5_000, &flight).is_empty(), "9 s is under the threshold");
        let at_15 = m.observe(15_000, 5_000, &flight);
        assert_eq!(
            at_15,
            vec![
                Report::CommandSlow { command: "new_file".into(), running_ms: 10_000, thread: "main".into() },
                Report::MainThreadSilent {
                    silent_ms: 10_000,
                    repeat: false,
                    in_flight: vec![("new_file".into(), 10_000, "main".into())],
                },
            ]
        );
        assert!(describe(&at_15[1]).contains("`new_file` for 10.0 s on thread main"));
        // Next ticks of the same silence stay quiet until REPEAT_EVERY.
        assert!(m.observe(16_000, 5_000, &flight).is_empty());
        let at_75 = m.observe(75_000, 5_000, &flight);
        assert!(matches!(at_75.as_slice(), [Report::MainThreadSilent { repeat: true, silent_ms: 70_000, .. }]));
        // The command returns and a beat lands at 76 s.
        assert_eq!(m.observe(77_000, 76_000, &[]), vec![Report::MainThreadAnswered { silent_ms: 71_000 }]);
        assert!(m.observe(78_000, 77_500, &[]).is_empty(), "healthy again");
    }

    #[test]
    fn watchdog_is_quiet_before_the_first_beat_and_names_a_busy_loop_with_no_command() {
        let mut m = Monitor::new();
        assert!(m.observe(60_000, 0, &[]).is_empty(), "start-up is not a stall");
        let r = m.observe(61_000, 45_000, &[]);
        assert_eq!(r.len(), 1);
        assert!(describe(&r[0]).contains("no command is in the handler"));
    }

    #[test]
    fn watchdog_reports_a_slow_command_off_the_main_thread_once() {
        let mut m = Monitor::new();
        let flight = [InFlight { id: 3, command: "goal_seek".into(), started_ms: 1_000, thread: "tokio-runtime-worker".into() }];
        // Beats keep landing: the main thread is fine, the command is not.
        assert_eq!(
            m.observe(12_000, 11_500, &flight),
            vec![Report::CommandSlow { command: "goal_seek".into(), running_ms: 11_000, thread: "tokio-runtime-worker".into() }]
        );
        assert!(m.observe(13_000, 12_500, &flight).is_empty(), "reported once per invoke");
    }

    #[test]
    fn watchdog_registry_holds_a_command_exactly_while_its_guard_lives() {
        let g = enter("watchdog_registry_probe_command");
        assert!(snapshot().iter().any(|e| e.command == "watchdog_registry_probe_command"));
        drop(g);
        assert!(!snapshot().iter().any(|e| e.command == "watchdog_registry_probe_command"));
    }
}
