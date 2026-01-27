//! FILENAME: app/src-tauri/src/logging.rs
// PURPOSE: Unified logging system for the application.

use std::fs::File;
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
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

/// Initialize the unified log file
pub fn init_log_file() -> Result<PathBuf, String> {
    let log_path = get_log_path()?;
    
    eprintln!("[LOG_INIT] Creating log file at: {:?}", log_path);
    
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

/// Write a log line in unified format
pub fn write_log(level: &str, category: &str, message: &str) {
    let seq = next_seq();
    let line = format!("{}|{}|{}|{}", seq, level, category, message);
    
    if let Ok(mut guard) = LOG_FILE.lock() {
        if let Some(ref mut file) = *guard {
            if let Err(e) = writeln!(file, "{}", line) {
                eprintln!("[LOG_ERROR] Failed to write: {}", e);
            }
            let _ = file.flush();
        } else {
            eprintln!("[LOG_WARN] Log file not initialized, console only: {}", line);
        }
    }
    
    println!("{}", line);
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
            let _ = file.flush();
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
// MACRO DEFINITIONS & EXPORTS
// ============================================================================

#[macro_export]
macro_rules! log_debug {
    ($cat:expr, $($arg:tt)*) => {
        $crate::logging::write_log("D", $cat, &format!($($arg)*))
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
        $crate::logging::write_log_enter("D", $cat, $func, "")
    };
    ($cat:expr, $func:expr, $($arg:tt)*) => {
        $crate::logging::write_log_enter("D", $cat, $func, &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_exit {
    ($cat:expr, $func:expr) => {
        $crate::logging::write_log_exit("D", $cat, $func, "")
    };
    ($cat:expr, $func:expr, $($arg:tt)*) => {
        $crate::logging::write_log_exit("D", $cat, $func, &format!($($arg)*))
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

// Re-export the macros so they can be imported via `use crate::logging::log_info;`
pub use log_debug;
pub use log_info;
pub use log_warn;
pub use log_error;
pub use log_enter;
pub use log_exit;
pub use log_enter_info;
pub use log_exit_info;