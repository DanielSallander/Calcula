//! FILENAME: app/src-tauri/src/scripting/types.rs
//! PURPOSE: Managed state and types for the scripting subsystem.
//! CONTEXT: ScriptState is registered as a separate Tauri managed state,
//! following the same pattern as PivotState. This module also owns the
//! builders that turn live AppState into the script engine's host inputs
//! (AppInfo + HostState), so every QuickJS surface feeds the engine the SAME
//! state instead of each command re-deriving its own subset — plus the
//! write-back that persists the workbook properties a script set.

use engine::grid::Grid;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

use crate::persistence::FileState;
use crate::AppState;

/// Managed state for the scripting extension.
/// Registered separately from AppState to keep the kernel feature-agnostic.
pub struct ScriptState {
    /// Stored permission grants per script: script_id -> granted permission names
    pub permission_grants: Mutex<HashMap<String, Vec<String>>>,
    /// Workbook-embedded scripts: script_id -> source code
    pub workbook_scripts: Mutex<HashMap<String, WorkbookScript>>,
    /// Global security level: "disabled", "prompt", "enabled"
    pub security_level: Mutex<String>,
    /// Access ceiling for the AI tool surface (MCP server + in-app AI chat):
    /// "read" (read-only tools), "mutate" (+ workbook edits/creates), or
    /// "script" (+ arbitrary script execution). Applied ON TOP of the Script
    /// Security consent gate — consent authorizes, the ceiling caps.
    pub mcp_access_level: Mutex<String>,
    /// Workbook-embedded notebooks: notebook_id -> NotebookDocument
    pub workbook_notebooks: Mutex<HashMap<String, NotebookDocument>>,
    /// Active notebook runtime bookkeeping (checkpoints, counters). Only one
    /// notebook can have an active runtime at a time. The QuickJS session
    /// itself lives on the executor thread (see notebook_executor).
    pub notebook_runtime: Mutex<NotebookRuntime>,
    /// Dedicated thread that owns the persistent QuickJS NotebookSession.
    pub notebook_executor: super::notebook_executor::NotebookExecutor,
    /// Serializes notebook execution commands end-to-end (run/run-all/rewind/
    /// reset). The frontend's isExecuting flag is advisory only; this lock is
    /// what actually prevents interleaved checkpoint bookkeeping.
    pub notebook_exec_lock: tokio::sync::Mutex<()>,
}

impl ScriptState {
    pub fn new() -> Self {
        ScriptState {
            permission_grants: Mutex::new(HashMap::new()),
            workbook_scripts: Mutex::new(HashMap::new()),
            security_level: Mutex::new("prompt".to_string()),
            mcp_access_level: Mutex::new("script".to_string()),
            workbook_notebooks: Mutex::new(HashMap::new()),
            notebook_runtime: Mutex::new(NotebookRuntime::new()),
            notebook_executor: super::notebook_executor::NotebookExecutor::new(),
            notebook_exec_lock: tokio::sync::Mutex::new(()),
        }
    }
}

// ============================================================================
// Host inputs for the script engine
// ============================================================================

/// Build the Application metadata the script engine exposes as
/// `Calcula.application.*` from live AppState (version, locale separators,
/// calculation mode). Poisoned/absent locks fall back to the engine defaults
/// rather than failing a script run.
pub fn build_app_info(state: &AppState) -> script_engine::types::AppInfo {
    let defaults = script_engine::types::AppInfo::default();
    let (decimal_separator, thousands_separator) = match state.locale.lock() {
        Ok(locale) => (
            locale.decimal_separator.to_string(),
            locale.thousands_separator.to_string(),
        ),
        Err(_) => (
            defaults.decimal_separator.clone(),
            defaults.thousands_separator.clone(),
        ),
    };
    script_engine::types::AppInfo {
        name: "Calcula".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        operating_system: std::env::consts::OS.to_string(),
        path_separator: std::path::MAIN_SEPARATOR.to_string(),
        decimal_separator,
        thousands_separator,
        calculation_mode: state
            .calculation_mode
            .lock()
            .map(|m| m.clone())
            .unwrap_or(defaults.calculation_mode),
    }
}

/// Build the live workbook state the script engine's `Calcula.*` getters answer
/// from. Every field the backend actually owns is read here; a poisoned lock
/// leaves that ONE field at its engine default instead of failing the run.
///
/// `file_state` supplies the dirty flag (it lives outside AppState); pass None
/// from surfaces that do not have it.
///
/// `display_zeros`, `view_mode`, `zoom` and `display_headings` have no
/// authoritative backend copy — they live in the Core grid state — so they come
/// off the run request instead: pass the request's `view_state` here and it is
/// merged over the defaults (see `apply_view_state`).
pub fn build_host_state(
    state: &AppState,
    file_state: Option<&FileState>,
    active_sheet: usize,
    view_state: Option<&HostViewState>,
) -> script_engine::types::HostState {
    let mut host = script_engine::types::HostState::default();
    if let Some(view) = view_state {
        apply_view_state(&mut host, view);
    }

    if let Some(fs) = file_state {
        if let Ok(modified) = fs.is_modified.lock() {
            host.is_dirty = *modified;
        }
    }
    if let Ok(style) = state.reference_style.lock() {
        host.reference_style = style.clone();
    }
    if let Ok(visibility) = state.sheet_visibility.lock() {
        host.sheet_visibility = visibility.clone();
    }
    if let Ok(props) = state.workbook_properties.lock() {
        // The typed document-properties struct flattened to the string map the
        // engine exposes; keys match the camelCase IPC field names.
        host.workbook_properties = HashMap::from([
            ("title".to_string(), props.title.clone()),
            ("author".to_string(), props.author.clone()),
            ("subject".to_string(), props.subject.clone()),
            ("description".to_string(), props.description.clone()),
            ("keywords".to_string(), props.keywords.clone()),
            ("category".to_string(), props.category.clone()),
            ("created".to_string(), props.created.clone()),
            ("lastModified".to_string(), props.last_modified.clone()),
        ]);
    }
    if let Ok(named) = state.named_styles.lock() {
        // Sorted so `getNamedStyles()` is deterministic across runs (the
        // registry is a HashMap).
        let mut names: Vec<String> = named.values().map(|s| s.name.clone()).collect();
        names.sort();
        host.named_style_names = names;
    }
    if let Ok(enabled) = state.iteration_enabled.lock() {
        host.iteration_enabled = *enabled;
    }
    if let Ok(max) = state.max_iterations.lock() {
        host.iteration_max_count = *max;
    }
    if let Ok(change) = state.max_change.lock() {
        host.iteration_max_change = *change;
    }
    if let Ok(areas) = state.scroll_areas.lock() {
        host.scroll_area = areas.get(active_sheet).cloned().flatten();
    }
    if let Ok(gridlines) = state.show_gridlines.lock() {
        host.display_gridlines = gridlines.get(active_sheet).copied().unwrap_or(true);
    }

    host
}

/// Apply a script's workbook-property writes onto the typed properties struct.
///
/// Writable keys are `title`, `author`, `subject`, `description`, `keywords`
/// and `category`. `created` / `lastModified` are deliberately NOT writable:
/// they are machine-maintained timestamps, and letting a script backdate them
/// would falsify document metadata.
///
/// Returns the number of properties actually changed; unknown keys and no-op
/// writes are ignored, so a caller can skip the dirty flag when nothing moved.
/// Pure (no locks) so the key mapping is unit-testable.
pub fn apply_workbook_property_map(
    props: &mut crate::api_types::WorkbookProperties,
    changes: &HashMap<String, String>,
) -> usize {
    let mut applied = 0usize;
    for (key, value) in changes {
        let field: Option<&mut String> = match key.as_str() {
            "title" => Some(&mut props.title),
            "author" => Some(&mut props.author),
            "subject" => Some(&mut props.subject),
            "description" => Some(&mut props.description),
            "keywords" => Some(&mut props.keywords),
            "category" => Some(&mut props.category),
            // "created"/"lastModified" and any unrecognized key: not writable.
            _ => None,
        };
        if let Some(slot) = field {
            if *slot != *value {
                *slot = value.clone();
                applied += 1;
            }
        }
    }
    applied
}

/// Persist the workbook properties a script set (`ScriptResult::Success ::
/// workbook_properties_changed`) into live AppState, marking the workbook dirty
/// when anything actually changed.
///
/// Server-side on purpose: document metadata is not a UI action, so it never
/// travels as a DeferredAction. No-ops on an empty map.
pub fn apply_workbook_property_changes(
    state: &AppState,
    file_state: &FileState,
    changes: &HashMap<String, String>,
) -> Result<usize, String> {
    if changes.is_empty() {
        return Ok(0);
    }
    let applied = {
        let mut props = state.workbook_properties.lock().map_err(|e| e.to_string())?;
        apply_workbook_property_map(&mut props, changes)
    };
    if applied > 0 {
        crate::persistence::mark_workbook_modified(file_state);
    }
    Ok(applied)
}

/// Scope of a script: workbook-level or attached to a specific sheet.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ScriptScope {
    /// Global script, not tied to any sheet.
    Workbook,
    /// Attached to a specific sheet by name.
    /// When that sheet is published, this script is included.
    Sheet { name: String },
}

impl Default for ScriptScope {
    fn default() -> Self {
        ScriptScope::Workbook
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
    /// Where this script lives: workbook-level or scoped to a sheet.
    #[serde(default)]
    pub scope: ScriptScope,
    /// The .calp package this module script was distributed from (C8 provenance).
    /// None for local/subscriber-authored scripts. Drives refresh: a package's
    /// prior modules are replaced/removed on its version bump, while local
    /// same-id scripts are preserved (parity with distributed object scripts).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_package: Option<String>,
}

/// Lightweight summary of a script (for listing without source code).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub scope: ScriptScope,
}

/// The view state the BACKEND does not own.
///
/// `displayZeros`, `viewMode`, `zoom` and `displayHeadings` live in the Core
/// grid state (frontend) — there is no authoritative Rust copy — so the caller
/// sends them with the run and `build_host_state` merges them in. Without this
/// `Calcula.getZoom()` answered 1.0 on a 150%-zoomed workbook: a getter that
/// lies is worse than one that is absent. Every field is optional: a caller
/// that knows only some of them overrides only those.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostViewState {
    pub display_zeros: Option<bool>,
    pub view_mode: Option<String>,
    /// Zoom FACTOR (1.0 = 100%), matching `Calcula.getZoom()`.
    pub zoom: Option<f64>,
    pub display_headings: Option<bool>,
}

/// Merge the frontend-owned view state onto a host state built from AppState.
pub fn apply_view_state(
    host: &mut script_engine::types::HostState,
    view: &HostViewState,
) {
    if let Some(v) = view.display_zeros {
        host.display_zeros = v;
    }
    if let Some(v) = &view.view_mode {
        host.view_mode = v.clone();
    }
    if let Some(v) = view.zoom {
        if v.is_finite() && v > 0.0 {
            host.zoom = v;
        }
    }
    if let Some(v) = view.display_headings {
        host.display_headings = v;
    }
}

/// Request payload for running a script.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunScriptRequest {
    /// The TypeScript/JavaScript source code
    pub source: String,
    /// Display name for the script (used in error messages)
    pub filename: String,
    /// Serialized cell bookmarks JSON (passed from frontend for script access)
    #[serde(default)]
    pub cell_bookmarks_json: Option<String>,
    /// Serialized view bookmarks JSON (passed from frontend for script access)
    #[serde(default)]
    pub view_bookmarks_json: Option<String>,
    /// The frontend-owned view state (zoom / view mode / zero + heading
    /// display). Absent = keep the engine defaults.
    #[serde(default)]
    pub view_state: Option<HostViewState>,
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
        /// Bookmark mutations to apply on the frontend
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        bookmark_mutations: Vec<script_engine::types::BookmarkMutation>,
        /// Deferred actions from Application object (goto, calculate, statusBar)
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        deferred_actions: Vec<script_engine::types::DeferredAction>,
        /// Application.screenUpdating value at end of script
        screen_updating: bool,
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
    /// The .calp package this notebook was distributed from (C8 provenance).
    /// None for local/subscriber-authored notebooks. See WorkbookScript.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_package: Option<String>,
}

/// A single cell in a notebook.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookCell {
    pub id: String,
    pub source: String,
    /// Structured output from last execution (text lines, tables)
    #[serde(default)]
    pub last_output: Vec<script_engine::ScriptOutputItem>,
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

/// Runtime bookkeeping for an active notebook session.
/// Not persisted — exists only while the notebook is open.
/// The QuickJS session itself is owned by the executor thread
/// (notebook_executor.rs), never stored here, so no unsafe Send is needed.
pub struct NotebookRuntime {
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
    /// The frontend-owned view state, re-sent per cell (a long-lived session
    /// must not answer with whatever was true when it was created).
    #[serde(default)]
    pub view_state: Option<HostViewState>,
}

/// Request to rewind a notebook to before a specific cell.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindNotebookRequest {
    /// The notebook ID
    pub notebook_id: String,
    /// Rewind to just before this cell (restore snapshot for this cell)
    pub target_cell_id: String,
    /// The frontend-owned view state, applied to every replayed/re-run cell.
    #[serde(default)]
    pub view_state: Option<HostViewState>,
}

/// Response from notebook cell execution.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum NotebookCellResponse {
    #[serde(rename_all = "camelCase")]
    Success {
        output: Vec<script_engine::ScriptOutputItem>,
        cells_modified: u32,
        duration_ms: u64,
        execution_index: u32,
        /// Application.screenUpdating value at end of cell execution
        screen_updating: bool,
        /// Deferred actions from Application object (goto, calculate, statusBar)
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        deferred_actions: Vec<script_engine::types::DeferredAction>,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        message: String,
        output: Vec<script_engine::ScriptOutputItem>,
    },
}

#[cfg(test)]
mod workbook_property_tests {
    use super::apply_workbook_property_map;
    use crate::api_types::WorkbookProperties;
    use std::collections::HashMap;

    fn changes(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn writes_the_user_authored_fields() {
        let mut props = WorkbookProperties::default();
        let applied = apply_workbook_property_map(
            &mut props,
            &changes(&[
                ("title", "Q3 Report"),
                ("author", "Daniel"),
                ("subject", "Revenue"),
                ("description", "Quarterly numbers"),
                ("keywords", "q3,revenue"),
                ("category", "Finance"),
            ]),
        );
        assert_eq!(applied, 6);
        assert_eq!(props.title, "Q3 Report");
        assert_eq!(props.author, "Daniel");
        assert_eq!(props.subject, "Revenue");
        assert_eq!(props.description, "Quarterly numbers");
        assert_eq!(props.keywords, "q3,revenue");
        assert_eq!(props.category, "Finance");
    }

    /// Machine-maintained timestamps and unrecognized keys are ignored — a
    /// script must not be able to backdate the document.
    #[test]
    fn ignores_timestamps_and_unknown_keys() {
        let mut props = WorkbookProperties::default();
        props.created = "2026-01-01T00:00:00Z".to_string();
        let applied = apply_workbook_property_map(
            &mut props,
            &changes(&[
                ("created", "1999-01-01T00:00:00Z"),
                ("lastModified", "1999-01-01T00:00:00Z"),
                ("totallyMadeUp", "x"),
            ]),
        );
        assert_eq!(applied, 0);
        assert_eq!(props.created, "2026-01-01T00:00:00Z");
        assert_eq!(props.last_modified, "");
    }

    /// Writing the value a property already holds is not a change, so the
    /// caller does not dirty the workbook for nothing.
    #[test]
    fn rewriting_the_same_value_reports_no_change() {
        let mut props = WorkbookProperties::default();
        props.author = "Daniel".to_string();
        let applied = apply_workbook_property_map(&mut props, &changes(&[("author", "Daniel")]));
        assert_eq!(applied, 0);
    }
}
