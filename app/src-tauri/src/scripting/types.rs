//! FILENAME: app/src-tauri/src/scripting/types.rs
//! PURPOSE: Managed state and types for the scripting subsystem.
//! CONTEXT: ScriptState is registered as a separate Tauri managed state,
//! following the same pattern as PivotState.

use engine::grid::Grid;
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
    /// Workbook-embedded notebooks: notebook_id -> NotebookDocument
    pub workbook_notebooks: Mutex<HashMap<String, NotebookDocument>>,
    /// Active notebook runtime (session + checkpoints). Only one notebook
    /// can have an active runtime at a time.
    pub notebook_runtime: Mutex<NotebookRuntime>,
}

impl ScriptState {
    pub fn new() -> Self {
        ScriptState {
            permission_grants: Mutex::new(HashMap::new()),
            workbook_scripts: Mutex::new(HashMap::new()),
            security_level: Mutex::new("prompt".to_string()),
            workbook_notebooks: Mutex::new(HashMap::new()),
            notebook_runtime: Mutex::new(NotebookRuntime::new()),
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

/// Lightweight summary of a script (for listing without source code).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSummary {
    pub id: String,
    pub name: String,
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
    #[serde(rename_all = "camelCase")]
    Success {
        /// Console output lines collected during execution
        output: Vec<String>,
        /// Number of cells the script modified
        cells_modified: u32,
        /// Execution time in milliseconds
        duration_ms: u64,
    },
    /// Script encountered an error
    #[serde(rename_all = "camelCase")]
    Error {
        /// The error message
        message: String,
        /// Console output collected before the error
        output: Vec<String>,
    },
}

// ============================================================================
// Notebook Types
// ============================================================================

/// A notebook document containing ordered cells for sequential execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookDocument {
    pub id: String,
    pub name: String,
    pub cells: Vec<NotebookCell>,
}

/// A single cell in a notebook.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookCell {
    pub id: String,
    pub source: String,
    /// Console output from last execution
    #[serde(default)]
    pub last_output: Vec<String>,
    /// Error message from last execution (if any)
    pub last_error: Option<String>,
    /// Number of cells modified in last execution
    #[serde(default)]
    pub cells_modified: u32,
    /// Execution duration in ms
    #[serde(default)]
    pub duration_ms: u64,
    /// Monotonic execution index (None = never run / stale)
    pub execution_index: Option<u32>,
}

/// Lightweight notebook summary for listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookSummary {
    pub id: String,
    pub name: String,
    pub cell_count: usize,
}

/// A grid checkpoint captured before a notebook cell execution.
/// Used for snapshot-based rewind.
pub struct GridCheckpoint {
    pub cell_id: String,
    pub grids: Vec<Grid>,
}

/// Wrapper to allow NotebookSession (which contains !Send QuickJS types)
/// to be stored in Tauri managed state behind a Mutex.
///
/// # Safety
/// This is safe because:
/// - Access is always serialized through a Mutex
/// - The session is never moved to another thread — it stays in place
/// - All operations on the session happen while the Mutex is held
pub struct SendableSession(pub Option<script_engine::NotebookSession>);

// SAFETY: See SendableSession doc comment. Access is Mutex-protected.
unsafe impl Send for SendableSession {}
unsafe impl Sync for SendableSession {}

/// Runtime state for an active notebook session.
/// Not persisted — exists only while the notebook is open.
pub struct NotebookRuntime {
    /// The persistent QuickJS session (variables survive across cells).
    /// Wrapped in SendableSession for thread-safety with Tauri's State.
    pub session: SendableSession,
    /// Grid snapshots taken before each cell execution, in execution order.
    pub checkpoints: Vec<GridCheckpoint>,
    /// Grid state before any notebook cell ran (for full rewind).
    pub baseline: Option<Vec<Grid>>,
    /// Monotonic counter for cell execution indices.
    pub execution_counter: u32,
    /// Maximum number of checkpoints to retain (LRU eviction).
    pub max_checkpoints: usize,
}

impl NotebookRuntime {
    pub fn new() -> Self {
        NotebookRuntime {
            session: SendableSession(None),
            checkpoints: Vec::new(),
            baseline: None,
            execution_counter: 0,
            max_checkpoints: 50,
        }
    }
}

/// Request to run a single notebook cell.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunNotebookCellRequest {
    /// The notebook ID
    pub notebook_id: String,
    /// The cell ID to execute
    pub cell_id: String,
    /// The cell source code (in case it was edited since last save)
    pub source: String,
}

/// Request to rewind a notebook to before a specific cell.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindNotebookRequest {
    /// The notebook ID
    pub notebook_id: String,
    /// Rewind to just before this cell (restore snapshot for this cell)
    pub target_cell_id: String,
}

/// Response from notebook cell execution.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum NotebookCellResponse {
    #[serde(rename_all = "camelCase")]
    Success {
        output: Vec<String>,
        cells_modified: u32,
        duration_ms: u64,
        execution_index: u32,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        message: String,
        output: Vec<String>,
    },
}
