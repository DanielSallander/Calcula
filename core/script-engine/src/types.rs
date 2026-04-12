//! FILENAME: core/script-engine/src/types.rs
//! PURPOSE: Types shared across the script engine.
//! CONTEXT: Defines ScriptContext (the data bridge between AppState and QuickJS),
//! ScriptResult (execution outcome), and ScriptMeta (script metadata).

use engine::cell::CellValue;
use engine::grid::Grid;
use engine::style::StyleRegistry;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;

/// Application-level metadata passed into the script runtime.
/// Maps to Excel's Application object read-only properties.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// Application name ("Calcula")
    pub name: String,
    /// Application version (e.g. "0.1.0")
    pub version: String,
    /// Operating system description
    pub operating_system: String,
    /// File path separator ("\" on Windows, "/" on Unix)
    pub path_separator: String,
    /// Locale decimal separator (e.g. "." or ",")
    pub decimal_separator: String,
    /// Locale thousands separator (e.g. "," or ".")
    pub thousands_separator: String,
    /// Calculation mode: "automatic" or "manual"
    pub calculation_mode: String,
}

impl Default for AppInfo {
    fn default() -> Self {
        Self {
            name: "Calcula".to_string(),
            version: "0.1.0".to_string(),
            operating_system: std::env::consts::OS.to_string(),
            path_separator: std::path::MAIN_SEPARATOR.to_string(),
            decimal_separator: ".".to_string(),
            thousands_separator: ",".to_string(),
            calculation_mode: "automatic".to_string(),
        }
    }
}

/// A deferred action requested by a script, to be executed by the frontend
/// after the script completes. Analogous to Excel Application methods/properties
/// that affect the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum DeferredAction {
    /// Navigate to a specific cell (Excel: Application.Goto)
    Goto {
        row: u32,
        col: u32,
        sheet_index: usize,
    },
    /// Request a full recalculation (Excel: Application.Calculate)
    Calculate,
    /// Set the status bar message (Excel: Application.StatusBar)
    /// message = None means reset to default
    SetStatusBar {
        message: Option<String>,
    },
}

/// A queued bookmark mutation produced by a script.
/// Applied on the frontend after script execution completes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum BookmarkMutation {
    /// Add a cell bookmark
    AddCellBookmark {
        row: u32,
        col: u32,
        sheet_index: usize,
        label: Option<String>,
        color: Option<String>,
    },
    /// Remove a cell bookmark
    RemoveCellBookmark {
        row: u32,
        col: u32,
        sheet_index: usize,
    },
    /// Create a view bookmark (capture happens on frontend after script completes)
    CreateViewBookmark {
        label: String,
        color: Option<String>,
        dimensions_json: Option<String>,
    },
    /// Delete a view bookmark by ID
    DeleteViewBookmark {
        id: String,
    },
    /// Activate a view bookmark by ID
    ActivateViewBookmark {
        id: String,
    },
}

/// The data context shared with the QuickJS runtime via Rc<RefCell<>>.
/// Contains cloned data from AppState for isolated script execution.
/// After execution, changes are extracted and applied back to AppState.
pub struct ScriptContext {
    /// Cloned grids (one per sheet) - scripts read/write these
    pub grids: Vec<Grid>,
    /// Cloned style registry for reading styles
    pub style_registry: StyleRegistry,
    /// Sheet names
    pub sheet_names: Vec<String>,
    /// Active sheet index
    pub active_sheet: usize,
    /// Console output collected during execution
    pub console_output: RefCell<Vec<String>>,
    /// Count of cells modified by the script
    pub cells_modified: RefCell<u32>,
    /// Serialized cell bookmarks JSON (read-only from script perspective)
    pub cell_bookmarks_json: String,
    /// Serialized view bookmarks JSON (read-only from script perspective)
    pub view_bookmarks_json: String,
    /// Queued bookmark mutations to apply after script execution
    pub bookmark_mutations: RefCell<Vec<BookmarkMutation>>,
    /// Application-level metadata (read-only from script perspective)
    pub app_info: AppInfo,
    /// Writable: Application.screenUpdating (default true)
    pub screen_updating: RefCell<bool>,
    /// Writable: Application.enableEvents (default true)
    pub enable_events: RefCell<bool>,
    /// Deferred actions queued by the script (goto, calculate, statusBar, etc.)
    pub deferred_actions: RefCell<Vec<DeferredAction>>,
}

/// The result of executing a script, returned to the Tauri command layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ScriptResult {
    /// Script executed successfully
    Success {
        /// Console output lines
        output: Vec<String>,
        /// Number of cells modified
        cells_modified: u32,
        /// Execution duration in milliseconds
        duration_ms: u64,
        /// Bookmark mutations to apply on the frontend
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        bookmark_mutations: Vec<BookmarkMutation>,
        /// Deferred actions to execute on the frontend
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        deferred_actions: Vec<DeferredAction>,
        /// Whether screen updating was enabled (Application.screenUpdating)
        screen_updating: bool,
        /// Whether events were enabled (Application.enableEvents)
        enable_events: bool,
    },
    /// Script encountered an error
    Error {
        /// Error message
        message: String,
        /// Console output collected before the error
        output: Vec<String>,
    },
}

/// Metadata for a stored script (workbook-embedded or user file).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptMeta {
    /// Unique script identifier
    pub id: String,
    /// Display name
    pub name: String,
    /// Optional description
    pub description: Option<String>,
    /// Author name
    pub author: Option<String>,
}

/// Helper to format a CellValue as a display string.
pub fn cell_value_to_string(value: &CellValue) -> String {
    match value {
        CellValue::Empty => String::new(),
        CellValue::Number(n) => {
            if *n == (*n as i64) as f64 && n.is_finite() {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        CellValue::Text(s) => s.clone(),
        CellValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
        CellValue::Error(e) => format!("{:?}", e),
        CellValue::List(items) => format!("[List({})]", items.len()),
        CellValue::Dict(entries) => format!("[Dict({})]", entries.len()),
    }
}

/// Parse a string value into a CellValue (number, boolean, or text).
pub fn string_to_cell_value(s: &str) -> CellValue {
    if s.is_empty() {
        return CellValue::Empty;
    }
    // Try parsing as number
    if let Ok(n) = s.parse::<f64>() {
        return CellValue::Number(n);
    }
    // Try parsing as boolean
    match s.to_uppercase().as_str() {
        "TRUE" => return CellValue::Boolean(true),
        "FALSE" => return CellValue::Boolean(false),
        _ => {}
    }
    // Default to text
    CellValue::Text(s.to_string())
}
