//! FILENAME: app/src-tauri/src/scripting/types.rs
//! PURPOSE: Managed state and types for the scripting subsystem.
//! CONTEXT: ScriptState is registered as a separate Tauri managed state,
//! following the same pattern as PivotState.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// Managed state for the scripting extension.
/// Registered separately from AppState to keep the kernel feature-agnostic.
pub struct ScriptState {
    /// Stored permission grants per script: script_id -> granted permission names
    pub permission_grants: Mutex<HashMap<String, Vec<String>>>,
    /// Workbook-embedded scripts: script_id -> source code
    pub workbook_scripts: Mutex<HashMap<String, WorkbookScript>>,
    /// Global security level: "disabled", "prompt", "enabled"
    pub security_level: Mutex<String>,
}

impl ScriptState {
    pub fn new() -> Self {
        ScriptState {
            permission_grants: Mutex::new(HashMap::new()),
            workbook_scripts: Mutex::new(HashMap::new()),
            security_level: Mutex::new("prompt".to_string()),
        }
    }
}

/// A script stored within a workbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookScript {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub source: String,
}

/// Request payload for running a script.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunScriptRequest {
    /// The TypeScript/JavaScript source code
    pub source: String,
    /// Display name for the script (used in error messages)
    pub filename: String,
}

/// Response payload from script execution.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum RunScriptResponse {
    /// Script completed successfully
    Success {
        /// Console output lines collected during execution
        output: Vec<String>,
        /// Number of cells the script modified
        cells_modified: u32,
        /// Execution time in milliseconds
        duration_ms: u64,
    },
    /// Script encountered an error
    Error {
        /// The error message
        message: String,
        /// Console output collected before the error
        output: Vec<String>,
    },
}
