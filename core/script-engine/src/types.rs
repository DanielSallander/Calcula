//! FILENAME: core/script-engine/src/types.rs
//! PURPOSE: Types shared across the script engine.
//! CONTEXT: Defines ScriptContext (the data bridge between AppState and QuickJS),
//! ScriptResult (execution outcome), and ScriptMeta (script metadata).

use engine::cell::CellValue;
use engine::grid::Grid;
use engine::style::StyleRegistry;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;

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
