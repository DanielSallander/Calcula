//! FILENAME: app/src-tauri/src/logging.rs
// PURPOSE: Unified logging system for the application.

use std::collections::HashSet;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
use once_cell::sync::Lazy;

// ============================================================================
// UNIFIED LOGGING SYSTEM
// ============================================================================

/// Global sequence counter shared between frontend and backend
static LOG_SEQ: AtomicU64 = AtomicU64::new(0);

/// Global log file handle
/// Added 'pub' so it can be accessed by other modules
pub static LOG_FILE: Lazy<Mutex<Option<File>>> = Lazy::new(|| Mutex::new(None));

/// Cached log path for frontend access
static LOG_PATH: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

/// Muted categories — log calls with these categories are suppressed entirely
static MUTED_CATEGORIES: Lazy<RwLock<HashSet<String>>> = Lazy::new(|| RwLock::new(HashSet::new()));

/// Muted levels — log calls with these levels are suppressed entirely
static MUTED_LEVELS: Lazy<RwLock<HashSet<String>>> = Lazy::new(|| RwLock::new(HashSet::new()));

/// Master switch for backend debug-level logging (log_debug!/log_enter!/log_exit!).
/// OFF by default: debug logging sits on hot paths (e.g. per-cell number formatting
/// during recalc), where each line costs format! allocations, lock acquisitions and
/// a file write. The macros check this flag BEFORE evaluating their format arguments,
/// so a disabled call is a single relaxed atomic load.
/// Re-enable at runtime via the set_debug_logging command or with
/// "debugBackendEnabled": true in app/log-filter.config.json.
static DEBUG_LOG_ENABLED: AtomicBool = AtomicBool::new(false);

/// Cheap gate used by the D-level macros. Inlined to a single atomic load.
#[inline(always)]
pub fn debug_log_enabled() -> bool {
    DEBUG_LOG_ENABLED.load(Ordering::Relaxed)
}

/// Turn backend debug-level logging on/off at runtime.
pub fn set_debug_log_enabled(enabled: bool) {
    DEBUG_LOG_ENABLED.store(enabled, Ordering::Relaxed);
    eprintln!(
        "[LOG_FILTER] Backend debug logging {}",
        if enabled { "ENABLED" } else { "disabled" }
    );
}

/// Get next sequence number
pub fn next_seq() -> u64 {
    LOG_SEQ.fetch_add(1, Ordering::SeqCst) + 1
}

/// Get the project root directory.
fn get_project_root() -> Result<PathBuf, String> {
    let start_path = if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        PathBuf::from(manifest_dir)
    } else {
        std::env::current_exe()
            .map_err(|e| format!("Failed to get exe path: {}", e))?
            .parent()
            .ok_or("No parent directory for executable")?
            .to_path_buf()
    };

    let mut path = start_path.clone();

    for _ in 0..10 {
        if path.join("src-tauri").exists() && path.join("src-tauri").is_dir() {
            eprintln!("[LOG_INIT] Found root (contains src-tauri): {:?}", path);
            return Ok(path);
        }

        if path.file_name().and_then(|n| n.to_str()) == Some("src-tauri") {
            if let Some(parent) = path.parent() {
                eprintln!("[LOG_INIT] Found root (parent of src-tauri): {:?}", parent);
                return Ok(parent.to_path_buf());
            }
        }

        if !path.pop() {
            break;
        }
    }

    let mut path = start_path;
    for _ in 0..5 {
        if path.join("context_manager").exists() {
            eprintln!("[LOG_INIT] Found existing context_manager at: {:?}", path);
            return Ok(path);
        }
        if !path.pop() {
            break;
        }
    }

    let cwd = std::env::current_dir()
        .map_err(|e| format!("Failed to get cwd: {}", e))?;
    eprintln!("[LOG_INIT] Root detection failed, using CWD: {:?}", cwd);
    
    Ok(cwd)
}

/// Get the unified log file path
pub fn get_log_path() -> Result<PathBuf, String> {
    if let Ok(guard) = LOG_PATH.lock() {
        if let Some(ref path) = *guard {
            return Ok(path.clone());
        }
    }
    
    let project_root = get_project_root()?;
    
    let parent_of_root = project_root.parent()
        .ok_or("Project root has no parent directory")?;
    let log_dir = parent_of_root.join("context_manager");
    
    eprintln!("[LOG_INIT] Log directory target: {:?}", log_dir);
    
    if !log_dir.exists() {
        std::fs::create_dir_all(&log_dir)
            .map_err(|e| format!("Failed to create log dir at {:?}: {}", log_dir, e))?;
        eprintln!("[LOG_INIT] Created log directory");
    }
    
    let log_path = log_dir.join("log.log");
    
    if let Ok(mut guard) = LOG_PATH.lock() {
        *guard = Some(log_path.clone());
    }
    
    Ok(log_path)
}

/// How many previous sessions' logs to keep beside the live one.
///
/// Ten is enough to cover "it happened a few runs ago, before anyone looked",
/// which is the case that matters, while keeping the directory readable.
const RETAINED_SESSION_LOGS: usize = 10;

/// Rotate the PREVIOUS session's log out of the way and return the path this
/// session should write to.
///
/// WHY THIS EXISTS. `init_log_file` used to open the log with `.truncate(true)`,
/// so **every app start destroyed the previous run's log.** That is exactly the
/// wrong behaviour for the one artefact you go looking for after something went
/// wrong, and it has already cost this project a diagnosis: on 2026-08-16 a
/// journey E2E run wedged with the backend refusing to return from Tauri
/// commands for 64 consecutive tests over 5.4 hours (BUG-0098). By the time
/// anyone read the log, four later app starts had overwritten it, and the
/// mechanism is still unknown. The evidence existed and the app deleted it.
///
/// WHY ROTATION AND NOT APPEND. Appending looks simpler and is wrong here.
/// `LOG_SEQ` is a per-process `AtomicU64` that restarts at 0 on every launch,
/// and `sort_log_file` reads the whole file and sorts it by that sequence
/// number. Appending would interleave sessions into one stream of restarting
/// counters, so a single sort would shuffle two runs together beyond
/// reconstruction. Rotation keeps the "one file is one session" invariant that
/// the sort depends on, and leaves `log.log` as the stable path everything else
/// already knows.
///
/// WHAT HAPPENS WHEN A SECOND INSTANCE STARTS WHILE THE FIRST IS RUNNING —
/// measured, not assumed, by `a_locked_log_is_left_alone_...` below. Rust's
/// `File` opens with `FILE_SHARE_DELETE` among its share flags, so the rename
/// **succeeds** even though the first instance holds the file open. A Windows
/// handle follows the file object rather than the path, so that instance simply
/// carries on writing into the file at its new `history/` name and loses nothing,
/// while the newcomer gets a fresh `log.log`. The "one file is one session"
/// invariant still holds on both sides, so `sort_log_file` stays correct for
/// each. (An earlier version of this comment claimed the rename would fail with
/// a sharing violation. The test disproved it; the note is kept because that is
/// the intuition most readers will arrive with.)
///
/// WHY THERE IS STILL A FALLBACK, AND WHY IT MUST NOT TRUNCATE. A rename can
/// genuinely fail for reasons that have nothing to do with app instances:
/// Dropbox or Defender holding the file (this repo hits `os error 32` often
/// enough that the E2E harness has a bounded-retry helper for it), a permission
/// problem, or a cross-volume move. Truncating in those cases would destroy the
/// very evidence this function exists to keep — it would be the original defect
/// wearing a fallback's clothes. So the session takes its own uniquely-named
/// file and leaves whatever is there strictly alone.
///
/// This also retires the workaround in `docs/design/e2e-test-plan.md` operational
/// rule 9, where an isolated second launch needed a fake `src-tauri` marker
/// directory as its cwd purely so the shared `context_manager/log.log` would not
/// be truncated underneath a run in progress.
fn rotate_previous_session(log_path: &Path) -> PathBuf {
    // Decide whether there is anything worth preserving. On any error other than
    // "not found" we assume there IS — the whole point of this function is to
    // fail in the direction of keeping evidence.
    let should_rotate = match std::fs::metadata(log_path) {
        Ok(meta) => meta.len() > 0,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    };
    if !should_rotate {
        return log_path.to_path_buf();
    }

    let Some(dir) = log_path.parent() else {
        return log_path.to_path_buf();
    };
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();

    let history = dir.join("history");
    if let Err(e) = std::fs::create_dir_all(&history) {
        eprintln!("[LOG_INIT] Could not create log history dir {:?}: {}", history, e);
        // No history directory means no safe place to move the old log. Write
        // beside it under a unique name rather than overwrite it.
        return unique_session_path(dir, &stamp);
    }

    // `std::fs::rename` REPLACES an existing destination on Windows, so two
    // instances starting in the same second would silently lose one log. Pick a
    // name nothing occupies instead of trusting the timestamp to be unique.
    let mut archived = history.join(format!("log-{}.log", stamp));
    let mut n = 2;
    while archived.exists() && n < 100 {
        archived = history.join(format!("log-{}-{}.log", stamp, n));
        n += 1;
    }

    match std::fs::rename(log_path, &archived) {
        Ok(()) => {
            eprintln!("[LOG_INIT] Previous session's log kept at: {:?}", archived);
            prune_session_history(&history);
            log_path.to_path_buf()
        }
        Err(e) => {
            // Almost always os error 32 on Windows: another instance has it open.
            let own = unique_session_path(dir, &stamp);
            eprintln!(
                "[LOG_INIT] Could not rotate {:?} ({}). Another instance is most \
                 likely still writing it, so it is being LEFT ALONE and this \
                 session will log to {:?} instead.",
                log_path, e, own
            );
            own
        }
    }
}

/// A per-instance log path for when `log.log` cannot be claimed. The pid keeps
/// it distinct from any other instance starting in the same second.
fn unique_session_path(dir: &Path, stamp: &str) -> PathBuf {
    dir.join(format!("log-{}-pid{}.log", stamp, std::process::id()))
}

/// Keep the newest `RETAINED_SESSION_LOGS` rotated logs, delete the rest.
///
/// The `%Y%m%d-%H%M%S` stamp sorts lexicographically in chronological order, so
/// a name sort is a time sort and no file metadata is needed.
///
/// IT PRUNES ONLY `history/`, AND DELIBERATELY NOT THE `-pid` FALLBACK FILES that
/// `unique_session_path` creates in the parent directory. Do not "finish the job"
/// by extending it there: those are LIVE logs of instances that could not claim
/// `log.log`, and because Rust's handles carry `FILE_SHARE_DELETE`, deleting one
/// would SUCCEED against a running instance and silently destroy the log it is
/// still writing — reintroducing the exact defect this whole path exists to fix.
/// A rotated file in `history/` is by construction finished with; a `-pid` file is
/// not. They are rare (only a failed rename produces one), small, and inside a
/// gitignored directory, so leaving them is the cheap and correct trade.
fn prune_session_history(history: &Path) {
    let Ok(entries) = std::fs::read_dir(history) else {
        return;
    };
    let mut logs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("log-") && n.ends_with(".log"))
                .unwrap_or(false)
        })
        .collect();
    if logs.len() <= RETAINED_SESSION_LOGS {
        return;
    }
    logs.sort();
    let doomed = logs.len() - RETAINED_SESSION_LOGS;
    for stale in logs.into_iter().take(doomed) {
        if let Err(e) = std::fs::remove_file(&stale) {
            eprintln!("[LOG_INIT] Could not prune old log {:?}: {}", stale, e);
        }
    }
}

/// Initialize the unified log file.
///
/// The previous session's log is ROTATED, never overwritten — see
/// `rotate_previous_session` for why that is not negotiable and why appending
/// would be wrong.
pub fn init_log_file() -> Result<PathBuf, String> {
    let canonical = get_log_path()?;
    let log_path = rotate_previous_session(&canonical);

    // If we could not claim `log.log`, the cached path must follow the file we
    // are ACTUALLY writing, or the frontend's "show me the log" would hand the
    // user a different instance's file.
    if log_path != canonical {
        if let Ok(mut guard) = LOG_PATH.lock() {
            *guard = Some(log_path.clone());
        }
    }

    eprintln!("[LOG_INIT] Creating log file at: {:?}", log_path);

    // `truncate` is retained deliberately and is now a no-op in every reachable
    // case: the file has just been rotated away, was confirmed empty, or is a
    // freshly-minted unique name. It stays as the belt-and-braces guarantee that
    // a session never inherits half of another session's lines — which would
    // break `sort_log_file` just as appending would.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to create log file {:?}: {}", log_path, e))?;

    let mut log_file = LOG_FILE.lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    *log_file = Some(file);

    eprintln!("[LOG_INIT] Log file initialized successfully");

    Ok(log_path)
}

/// Check if a log call should be suppressed based on muted categories/levels
fn is_muted(level: &str, category: &str) -> bool {
    if let Ok(cats) = MUTED_CATEGORIES.read() {
        if cats.contains(category) {
            return true;
        }
    }
    if let Ok(lvls) = MUTED_LEVELS.read() {
        if lvls.contains(level) {
            return true;
        }
    }
    false
}

/// Write a log line in unified format.
/// PERFORMANCE: Does NOT flush after every write. The OS buffer handles batching.
/// Only info/warn/error levels print to console to reduce stdout I/O overhead.
pub fn write_log(level: &str, category: &str, message: &str) {
    if is_muted(level, category) {
        return;
    }

    let seq = next_seq();
    let line = format!("{}|{}|{}|{}", seq, level, category, message);

    if let Ok(mut guard) = LOG_FILE.lock() {
        if let Some(ref mut file) = *guard {
            if let Err(e) = writeln!(file, "{}", line) {
                eprintln!("[LOG_ERROR] Failed to write: {}", e);
            }
            // No flush here - let the OS buffer handle it for performance.
            // Logs will still be written; they just won't be forced to disk on every line.
        } else {
            eprintln!("[LOG_WARN] Log file not initialized, console only: {}", line);
        }
    }

    // Only print non-debug messages to console to reduce I/O overhead.
    // Debug messages are high-volume and printing each to stdout is very slow on Windows.
    if level != "D" {
        println!("{}", line);
    }
}

/// Explicitly flush the log file. Call this after batch operations
/// or at important checkpoints to ensure logs are persisted.
pub fn flush_log() {
    if let Ok(mut guard) = LOG_FILE.lock() {
        if let Some(ref mut file) = *guard {
            let _ = file.flush();
        }
    }
}

/// Write an ENTER log line for function entry
pub fn write_log_enter(level: &str, category: &str, func_name: &str, params: &str) {
    let message = if params.is_empty() {
        format!("ENTER {}", func_name)
    } else {
        format!("ENTER {} {}", func_name, params)
    };
    write_log(level, category, &message);
}

/// Write an EXIT log line for function exit
pub fn write_log_exit(level: &str, category: &str, func_name: &str, result: &str) {
    let message = if result.is_empty() {
        format!("EXIT {}", func_name)
    } else {
        format!("EXIT {} {}", func_name, result)
    };
    write_log(level, category, &message);
}

/// Write raw message
pub fn write_log_raw(message: &str) {
    if let Ok(mut guard) = LOG_FILE.lock() {
        if let Some(ref mut file) = *guard {
            if let Err(e) = writeln!(file, "{}", message) {
                eprintln!("[LOG_ERROR] Failed to write: {}", e);
            }
        }
    }
    println!("{}", message);
}

// ============================================================================
// TAURI COMMAND HANDLERS FOR LOGGING
// ============================================================================

/// Get next sequence number for frontend logging
#[tauri::command]
pub fn get_next_seq() -> u64 {
    next_seq()
}

/// Write a frontend log message (already formatted with seq)
#[tauri::command]
pub fn log_frontend(message: String) -> Result<(), String> {
    write_log_raw(&message);
    Ok(())
}

/// Write a frontend log message atomically (seq assigned and written together)
#[tauri::command]
pub fn log_frontend_atomic(level: String, category: String, message: String) -> Result<(), String> {
    // This ensures seq assignment and write happen atomically
    write_log(&level, &category, &message);
    Ok(())
}

/// Sort the log file by sequence number
#[tauri::command]
pub fn sort_log_file() -> Result<String, String> {
    log_enter_info!("CMD", "sort_log_file");
    
    let mut guard = LOG_FILE.lock().map_err(|e| e.to_string())?;
    
    let file = guard.as_mut().ok_or("Log file not initialized")?;
    
    // 1. Flush pending writes
    file.flush().map_err(|e| format!("Flush error: {}", e))?;
    
    // 2. Seek to start for reading
    file.seek(SeekFrom::Start(0)).map_err(|e| format!("Seek error: {}", e))?;
    
    // 3. Read all content into memory first (read the raw bytes)
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|e| format!("Read error: {}", e))?;
    
    // 4. Parse and sort
    let mut lines: Vec<(u64, String)> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let seq = line
                .split('|')
                .next()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(u64::MAX);
            (seq, line.to_string())
        })
        .collect();
    
    lines.sort_by_key(|(seq, _)| *seq);
    
    let line_count = lines.len();
    
    // 5. Truncate and rewrite
    file.set_len(0).map_err(|e| format!("Truncate error: {}", e))?;
    file.seek(SeekFrom::Start(0)).map_err(|e| format!("Seek error: {}", e))?;
    
    for (_, line) in &lines {
        writeln!(file, "{}", line).map_err(|e| format!("Write error: {}", e))?;
    }
    
    file.flush().map_err(|e| format!("Final flush error: {}", e))?;
    
    log_exit_info!("CMD", "sort_log_file", "sorted {} lines", line_count);
    Ok(format!("Sorted {} lines", line_count))
}

// ============================================================================
// LOG FILTER CONFIG
// ============================================================================

/// Config file structure matching app/log-filter.config.json
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFilterConfig {
    #[serde(default)]
    pub muted: Vec<String>,
    #[serde(default)]
    pub muted_backend_categories: Vec<String>,
    #[serde(default)]
    pub muted_backend_levels: Vec<String>,
    /// Backend debug-level logging master switch (default OFF — hot-path cost).
    #[serde(default)]
    pub debug_backend_enabled: bool,
}

/// Load log filter config from app/log-filter.config.json.
/// Applies backend filters and returns the full config for the frontend.
pub fn load_log_filter_config() -> Result<LogFilterConfig, String> {
    let project_root = get_project_root()?;
    let config_path = project_root.join("log-filter.config.json");

    if !config_path.exists() {
        eprintln!("[LOG_FILTER] No config file at {:?}, all logs enabled", config_path);
        return Ok(LogFilterConfig {
            muted: vec![],
            muted_backend_categories: vec![],
            muted_backend_levels: vec![],
            debug_backend_enabled: false,
        });
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read log filter config: {}", e))?;

    let config: LogFilterConfig = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse log filter config: {}", e))?;

    // Apply backend filters
    if let Ok(mut cats) = MUTED_CATEGORIES.write() {
        cats.clear();
        cats.extend(config.muted_backend_categories.clone());
    }
    if let Ok(mut lvls) = MUTED_LEVELS.write() {
        lvls.clear();
        lvls.extend(config.muted_backend_levels.clone());
    }
    set_debug_log_enabled(config.debug_backend_enabled);

    let cat_count = config.muted_backend_categories.len();
    let lvl_count = config.muted_backend_levels.len();
    let fe_count = config.muted.len();
    eprintln!(
        "[LOG_FILTER] Loaded config: {} frontend muted, {} backend categories muted, {} backend levels muted",
        fe_count, cat_count, lvl_count
    );

    Ok(config)
}

/// Get log filter config (reads from file, applies backend filters, returns full config)
#[tauri::command]
pub fn get_log_filter_config() -> Result<LogFilterConfig, String> {
    load_log_filter_config()
}

/// Set backend log filter at runtime (from frontend logFilter API)
#[tauri::command]
pub fn set_log_filter(muted_categories: Vec<String>, muted_levels: Vec<String>) -> Result<(), String> {
    if let Ok(mut cats) = MUTED_CATEGORIES.write() {
        cats.clear();
        cats.extend(muted_categories);
    }
    if let Ok(mut lvls) = MUTED_LEVELS.write() {
        lvls.clear();
        lvls.extend(muted_levels);
    }
    Ok(())
}

/// Toggle backend debug-level logging at runtime (log_debug!/log_enter!/log_exit!).
#[tauri::command]
pub fn set_debug_logging(enabled: bool) -> Result<(), String> {
    set_debug_log_enabled(enabled);
    Ok(())
}

// ============================================================================
// MACRO DEFINITIONS & EXPORTS
// ============================================================================

// NOTE: all D-level macros check debug_log_enabled() BEFORE evaluating their
// format arguments — a disabled call site costs one relaxed atomic load, no
// allocation, no locks, no I/O. Toggle via set_debug_logging (command) or
// "debugBackendEnabled" in log-filter.config.json.
#[macro_export]
macro_rules! log_debug {
    ($cat:expr, $($arg:tt)*) => {
        if $crate::logging::debug_log_enabled() {
            $crate::logging::write_log("D", $cat, &format!($($arg)*))
        }
    };
}

#[macro_export]
macro_rules! log_info {
    ($cat:expr, $($arg:tt)*) => {
        $crate::logging::write_log("I", $cat, &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_warn {
    ($cat:expr, $($arg:tt)*) => {
        $crate::logging::write_log("W", $cat, &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_error {
    ($cat:expr, $($arg:tt)*) => {
        $crate::logging::write_log("E", $cat, &format!($($arg)*))
    };
}

// ENTER/EXIT macros for function tracing

#[macro_export]
macro_rules! log_enter {
    ($cat:expr, $func:expr) => {
        if $crate::logging::debug_log_enabled() {
            $crate::logging::write_log_enter("D", $cat, $func, "")
        }
    };
    ($cat:expr, $func:expr, $($arg:tt)*) => {
        if $crate::logging::debug_log_enabled() {
            $crate::logging::write_log_enter("D", $cat, $func, &format!($($arg)*))
        }
    };
}

#[macro_export]
macro_rules! log_exit {
    ($cat:expr, $func:expr) => {
        if $crate::logging::debug_log_enabled() {
            $crate::logging::write_log_exit("D", $cat, $func, "")
        }
    };
    ($cat:expr, $func:expr, $($arg:tt)*) => {
        if $crate::logging::debug_log_enabled() {
            $crate::logging::write_log_exit("D", $cat, $func, &format!($($arg)*))
        }
    };
}

// Info-level ENTER/EXIT for more important function traces

#[macro_export]
macro_rules! log_enter_info {
    ($cat:expr, $func:expr) => {
        $crate::logging::write_log_enter("I", $cat, $func, "")
    };
    ($cat:expr, $func:expr, $($arg:tt)*) => {
        $crate::logging::write_log_enter("I", $cat, $func, &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_exit_info {
    ($cat:expr, $func:expr) => {
        $crate::logging::write_log_exit("I", $cat, $func, "")
    };
    ($cat:expr, $func:expr, $($arg:tt)*) => {
        $crate::logging::write_log_exit("I", $cat, $func, &format!($($arg)*))
    };
}

// Performance tracing macro - always prints to stdout (level "P")

#[macro_export]
macro_rules! log_perf {
    ($cat:expr, $($arg:tt)*) => {
        $crate::logging::write_log("P", $cat, &format!($($arg)*))
    };
}

// ============================================================================
// TESTS — log rotation
// ============================================================================

#[cfg(test)]
mod rotation_tests {
    //! These pin the ONE property that matters: **starting the app never
    //! destroys the previous session's log.** It used to, via `.truncate(true)`,
    //! and that is how the BUG-0098 wedge became undiagnosable — the backend's
    //! own account of a 5.4-hour failure was overwritten by four later starts
    //! before anyone read it.

    // `super::*` already brings `std::io::Write` into scope (the module imports
    // it for `writeln!`), so re-importing it here is a warning, not a fix.
    use super::*;

    /// A scratch directory that cleans itself up.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "calcula-log-rot-{}-{}-{:?}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Scratch(dir)
        }
        fn log(&self) -> PathBuf {
            self.0.join("log.log")
        }
        fn write_log(&self, contents: &str) {
            std::fs::write(self.log(), contents).expect("seed log");
        }
        fn history(&self) -> Vec<PathBuf> {
            let h = self.0.join("history");
            let Ok(rd) = std::fs::read_dir(&h) else {
                return vec![];
            };
            let mut v: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
            v.sort();
            v
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_previous_sessions_log_is_moved_aside_not_destroyed() {
        let s = Scratch::new("keep");
        s.write_log("1|I|SYS|the line that used to be deleted on the next start\n");

        let target = rotate_previous_session(&s.log());

        // This session still writes the canonical path...
        assert_eq!(target, s.log(), "the live log path must stay stable");
        // ...and the old content is still on disk, exactly once.
        let kept = s.history();
        assert_eq!(kept.len(), 1, "expected one archived log, got {:?}", kept);
        let content = std::fs::read_to_string(&kept[0]).expect("read archived");
        assert!(
            content.contains("the line that used to be deleted"),
            "the previous session's content must survive; got {:?}",
            content
        );
        assert!(
            !s.log().exists(),
            "log.log should have been renamed away, leaving init to create a fresh one"
        );
    }

    #[test]
    fn an_absent_or_empty_log_is_not_archived() {
        // Nothing there at all.
        let s = Scratch::new("absent");
        assert_eq!(rotate_previous_session(&s.log()), s.log());
        assert!(s.history().is_empty(), "nothing to archive, so no archive");

        // Present but empty — a launch that never logged. Archiving it would push
        // a genuinely useful log out of the retention window with a blank file.
        let s2 = Scratch::new("empty");
        s2.write_log("");
        assert_eq!(rotate_previous_session(&s2.log()), s2.log());
        assert!(s2.history().is_empty(), "an empty log is not evidence");
    }

    #[test]
    fn a_locked_log_is_left_alone_and_this_session_gets_its_own_file() {
        // A SECOND APP INSTANCE STARTING WHILE THE FIRST IS STILL WRITING.
        //
        // Whichever way the platform goes, the requirement is the same and is the
        // one a truncating fallback would get catastrophically wrong: the running
        // instance's lines must still exist afterwards.
        //
        // Measured on Windows 11 (2026-08-17): the rename SUCCEEDS, because
        // Rust's `File` includes FILE_SHARE_DELETE in its share mode. The held
        // handle follows the file object to its new name, so instance one keeps
        // logging into `history/` and loses nothing. The assertion is written to
        // accept either branch rather than encode one platform's answer, because
        // the property under test is "nothing was destroyed", not "rename failed".
        let s = Scratch::new("locked");
        s.write_log("1|I|SYS|a RUNNING instance is writing this\n");

        let mut held = OpenOptions::new()
            .read(true)
            .write(true)
            .open(s.log())
            .expect("hold the log open");
        writeln!(held, "2|I|SYS|still going").expect("write while held");

        let target = rotate_previous_session(&s.log());

        if target == s.log() {
            // The platform allowed the rename (non-Windows, or a share mode that
            // permits it). Then the requirement is just that nothing was lost.
            let kept = s.history();
            assert_eq!(kept.len(), 1, "if it rotated, the content must be in history");
        } else {
            // The expected Windows path: our own file, and the live one intact.
            assert!(
                target.file_name().unwrap().to_str().unwrap().contains("pid"),
                "fallback must be a per-instance name, got {:?}",
                target
            );
            let live = std::fs::read_to_string(s.log()).expect("live log still readable");
            assert!(
                live.contains("a RUNNING instance is writing this"),
                "the other instance's log MUST NOT be touched; got {:?}",
                live
            );
            assert!(
                target != s.log(),
                "this session must not open the file another instance holds"
            );
        }
        drop(held);
    }

    #[test]
    fn history_is_pruned_to_the_retention_limit_oldest_first() {
        let s = Scratch::new("prune");
        let history = s.0.join("history");
        std::fs::create_dir_all(&history).expect("history dir");

        // Names are timestamps, so lexical order IS chronological order.
        let total = RETAINED_SESSION_LOGS + 5;
        for i in 0..total {
            std::fs::write(
                history.join(format!("log-2026081{:02}-000000.log", i)),
                format!("session {}", i),
            )
            .expect("seed history");
        }
        // A file that is not a rotated log must be left alone.
        std::fs::write(history.join("notes.txt"), "not mine").expect("seed foreign");

        prune_session_history(&history);

        let left: Vec<String> = s
            .history()
            .iter()
            .filter_map(|p| p.file_name()?.to_str().map(|x| x.to_string()))
            .collect();
        let logs: Vec<&String> = left.iter().filter(|n| n.starts_with("log-")).collect();
        assert_eq!(
            logs.len(),
            RETAINED_SESSION_LOGS,
            "expected exactly the retention limit, got {:?}",
            logs
        );
        // The OLDEST must be the ones gone.
        assert!(
            !logs.iter().any(|n| n.contains("log-20260810-")),
            "oldest should have been pruned first, got {:?}",
            logs
        );
        assert!(
            logs.iter().any(|n| n.contains(&format!("log-2026081{:02}-", total - 1))),
            "newest must be retained, got {:?}",
            logs
        );
        assert!(
            left.iter().any(|n| n == "notes.txt"),
            "pruning must not delete files it does not own"
        );
    }

    #[test]
    fn two_rotations_in_the_same_second_do_not_overwrite_each_other() {
        // `std::fs::rename` REPLACES the destination on Windows, so relying on a
        // one-second timestamp for uniqueness silently loses a log.
        let s = Scratch::new("collide");

        s.write_log("first session\n");
        rotate_previous_session(&s.log());
        s.write_log("second session\n");
        rotate_previous_session(&s.log());

        let kept = s.history();
        assert_eq!(kept.len(), 2, "both sessions must be kept, got {:?}", kept);
        let bodies: Vec<String> = kept
            .iter()
            .map(|p| std::fs::read_to_string(p).unwrap_or_default())
            .collect();
        assert!(
            bodies.iter().any(|b| b.contains("first session")),
            "the first session survived the second's rotation; got {:?}",
            bodies
        );
        assert!(
            bodies.iter().any(|b| b.contains("second session")),
            "the second session was archived; got {:?}",
            bodies
        );
    }
}

// Re-export the macros so they can be imported via `use crate::logging::log_info;`
pub use log_debug;
pub use log_info;
pub use log_warn;
pub use log_error;
pub use log_enter;
pub use log_exit;
pub use log_enter_info;
pub use log_exit_info;
pub use log_perf;