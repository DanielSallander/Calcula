//! FILENAME: core/script-engine/src/types.rs
//! PURPOSE: Types shared across the script engine.
//! CONTEXT: Defines ScriptContext (the data bridge between AppState and QuickJS),
//! HostState (the live workbook/view state the host feeds in), ScriptResult
//! (execution outcome), and ScriptMeta (script metadata).

use engine::cell::{Cell, CellValue};
use engine::grid::Grid;
use engine::style::StyleRegistry;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;

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

/// Live workbook + view state fed in by the host for ONE execution.
///
/// Every field here backs a `Calcula.*` getter. Before this existed the engine
/// hardcoded them, so `Calcula.getZoom()` answered 1.0 and `getNamedStyles()`
/// answered `[]` no matter what the app actually held — an API that answers
/// WRONG is worse than one that is absent. The host rebuilds this per run (per
/// CELL for a notebook session) so a mid-session change is picked up.
///
/// `Default` reproduces the engine's historical hardcoded values, which is what
/// a surface without host state (unit tests, `ScriptEngine::run`) still gets.
///
/// NOTE on the view fields (`display_zeros`, `view_mode`, `zoom`,
/// `display_headings`): these live in the frontend only — the Rust backend has
/// no authoritative copy — so a host that cannot see them leaves them at the
/// default. They are carried here (rather than omitted) so that the frontend
/// only has to send them along; nothing else has to change.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostState {
    /// Whether zero values are displayed in cells.
    pub display_zeros: bool,
    /// Whether the workbook has unsaved changes.
    pub is_dirty: bool,
    /// Current view mode: "normal" or "pageBreakPreview".
    pub view_mode: String,
    /// Current zoom level (1.0 = 100%).
    pub zoom: f64,
    /// Reference style: "A1" or "R1C1".
    pub reference_style: String,
    /// Per-sheet visibility: "visible", "hidden", or "veryHidden".
    pub sheet_visibility: Vec<String>,
    /// Workbook-level document properties (title, author, ...).
    pub workbook_properties: HashMap<String, String>,
    /// Named cell-style names available in the workbook.
    pub named_style_names: Vec<String>,
    /// Iterative calculation enabled.
    pub iteration_enabled: bool,
    /// Max iteration count for circular-reference resolution.
    pub iteration_max_count: u32,
    /// Max change threshold for iteration convergence.
    pub iteration_max_change: f64,
    /// Scroll-area restriction of the ACTIVE sheet (e.g. "A1:Z100"), or None.
    pub scroll_area: Option<String>,
    /// Whether gridlines are displayed on the active sheet.
    pub display_gridlines: bool,
    /// Whether row/column headings are displayed.
    pub display_headings: bool,
}

impl Default for HostState {
    fn default() -> Self {
        HostState {
            display_zeros: true,
            is_dirty: false,
            view_mode: "normal".to_string(),
            zoom: 1.0,
            reference_style: "A1".to_string(),
            sheet_visibility: Vec::new(),
            workbook_properties: HashMap::new(),
            named_style_names: Vec::new(),
            iteration_enabled: false,
            iteration_max_count: 100,
            iteration_max_change: 0.001,
            scroll_area: None,
            display_gridlines: true,
            display_headings: true,
        }
    }
}

fn default_true() -> bool {
    true
}

/// A single structured output item produced during script execution.
/// Text items come from console.log / Calcula.log and the REPL last-expression
/// display; Table items come from display.table() and table-shaped last
/// expressions (objects with `columns` + `rows` arrays).
///
/// Surfaces that only carry plain strings (run_script, MCP execute_script)
/// flatten items via `to_text()`. The notebook keeps items end-to-end so the
/// frontend can render tables. Mirrored in TS as `NotebookOutputItem`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ScriptOutputItem {
    #[serde(rename_all = "camelCase")]
    Text { text: String },
    #[serde(rename_all = "camelCase")]
    Table {
        /// Column headers; empty = render without a header row.
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
        /// True when rows were dropped to fit the per-item row cap.
        truncated: bool,
        /// Row count before truncation.
        total_rows: usize,
    },
}

impl ScriptOutputItem {
    pub fn text(s: impl Into<String>) -> Self {
        ScriptOutputItem::Text { text: s.into() }
    }

    /// Flatten to plain text for string-only surfaces (tab-separated rows).
    pub fn to_text(&self) -> String {
        match self {
            ScriptOutputItem::Text { text } => text.clone(),
            ScriptOutputItem::Table {
                columns,
                rows,
                truncated,
                total_rows,
            } => {
                let mut lines: Vec<String> = Vec::with_capacity(rows.len() + 2);
                if !columns.is_empty() {
                    lines.push(columns.join("\t"));
                }
                for row in rows {
                    lines.push(row.join("\t"));
                }
                if *truncated {
                    lines.push(format!("... ({} rows total)", total_rows));
                }
                lines.join("\n")
            }
        }
    }
}

/// A deferred action requested by a script, to be executed by the frontend
/// after the script completes. Analogous to Excel Application methods/properties
/// that affect the UI.
///
/// WIRE SHAPE: the container `rename_all` renames VARIANTS only — struct-variant
/// FIELDS need their own `rename_all`, which is why every variant below carries
/// one. Without them `sheet_index` / `start_row` / `max_change` went over the
/// IPC boundary snake_cased, in violation of the Golden Rule. Mirrored in TS as
/// `DeferredAction` (app/src/api/workbookScripts.ts).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum DeferredAction {
    /// Navigate to a specific cell (Excel: Application.Goto)
    #[serde(rename_all = "camelCase")]
    Goto {
        row: u32,
        col: u32,
        sheet_index: usize,
        /// If false, only scroll without changing selection (default: true)
        #[serde(default = "default_true")]
        select: bool,
    },
    /// Request a full recalculation (Excel: Application.Calculate)
    Calculate,
    /// Bring a sheet to the front (Excel: Worksheet.Activate). Queued by
    /// `setActiveSheet` / `nextSheet` / `previousSheet`, which also retarget the
    /// script's own writes; without this the host never followed the script.
    #[serde(rename_all = "camelCase")]
    ActivateSheet {
        sheet_index: usize,
    },
    /// Set the status bar message (Excel: Application.StatusBar)
    /// message = None means reset to default
    #[serde(rename_all = "camelCase")]
    SetStatusBar {
        message: Option<String>,
    },
    /// Set whether zeros are displayed in cells (Worksheet.DisplayZeros)
    #[serde(rename_all = "camelCase")]
    SetDisplayZeros {
        value: bool,
    },
    /// Set the view mode ("normal" or "pageBreakPreview")
    #[serde(rename_all = "camelCase")]
    SetViewMode {
        mode: String,
    },
    /// Set the zoom level (percentage, e.g. 1.0 = 100%)
    #[serde(rename_all = "camelCase")]
    SetZoom {
        percent: f64,
    },
    /// Set the reference style ("A1" or "R1C1")
    #[serde(rename_all = "camelCase")]
    SetReferenceStyle {
        style: String,
    },
    /// Set whether gridlines are displayed
    #[serde(rename_all = "camelCase")]
    SetDisplayGridlines {
        value: bool,
    },
    /// Set whether row/column headings are displayed
    #[serde(rename_all = "camelCase")]
    SetDisplayHeadings {
        value: bool,
    },
    /// Fill down: copy first row of range to remaining rows
    #[serde(rename_all = "camelCase")]
    FillDown {
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
    },
    /// Fill right: copy first column of range to remaining columns
    #[serde(rename_all = "camelCase")]
    FillRight {
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
    },
    /// Apply a named style to a cell
    #[serde(rename_all = "camelCase")]
    ApplyNamedStyle {
        name: String,
        row: u32,
        col: u32,
    },
    /// Set or clear the scroll area restriction
    #[serde(rename_all = "camelCase")]
    SetScrollArea {
        area: Option<String>,
    },
    /// Set iteration calculation settings
    #[serde(rename_all = "camelCase")]
    SetIterationSettings {
        enabled: bool,
        max_iterations: u32,
        max_change: f64,
    },
    /// Set sheet visibility
    #[serde(rename_all = "camelCase")]
    SetSheetVisibility {
        sheet_index: usize,
        visibility: String,
    },
}

/// A queued bookmark mutation produced by a script.
/// Applied on the frontend after script execution completes.
///
/// Same wire-shape rule as `DeferredAction`: the per-variant `rename_all` is
/// what actually camelCases the FIELDS.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum BookmarkMutation {
    /// Add a cell bookmark
    #[serde(rename_all = "camelCase")]
    AddCellBookmark {
        row: u32,
        col: u32,
        sheet_index: usize,
        label: Option<String>,
        color: Option<String>,
    },
    /// Remove a cell bookmark
    #[serde(rename_all = "camelCase")]
    RemoveCellBookmark {
        row: u32,
        col: u32,
        sheet_index: usize,
    },
    /// Create a view bookmark (capture happens on frontend after script completes)
    #[serde(rename_all = "camelCase")]
    CreateViewBookmark {
        label: String,
        color: Option<String>,
        dimensions_json: Option<String>,
    },
    /// Delete a view bookmark by ID
    #[serde(rename_all = "camelCase")]
    DeleteViewBookmark {
        id: String,
    },
    /// Activate a view bookmark by ID
    #[serde(rename_all = "camelCase")]
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
    /// Structured output collected during execution (console lines, tables)
    pub console_output: RefCell<Vec<ScriptOutputItem>>,
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
    /// Live workbook/view state fed in by the host (see HostState). Scripts
    /// read it through the `Calcula.*` getters; the setters mutate this copy
    /// AND queue a DeferredAction so the host applies the change for real.
    pub host: HostState,
    /// Workbook properties the script WROTE (key -> value), in write order of
    /// last write. `setWorkbookProperty` mutates `host.workbook_properties`
    /// (so a later read sees it) and records the change here so the apply path
    /// can persist it — the clone alone would be thrown away with the context.
    pub workbook_properties_changed: RefCell<HashMap<String, String>>,
    /// Host-provided read-only model access (None on surfaces without it:
    /// one-off run_script, MCP execute_script). See model_provider.rs.
    pub model_provider: Option<std::rc::Rc<dyn crate::model_provider::ModelDataProvider>>,
    /// The calling script-surface id (e.g. "notebook:nb-123"); the host keys
    /// capability grants + audit by it. Empty on surfaces without a provider.
    pub surface_id: String,
}

impl ScriptContext {
    /// Build a fresh context for one execution. The per-run counters/outputs
    /// start empty; `host` and `app_info` come from the host.
    pub fn new(
        grids: Vec<Grid>,
        style_registry: StyleRegistry,
        sheet_names: Vec<String>,
        active_sheet: usize,
        app_info: AppInfo,
        host: HostState,
    ) -> Self {
        ScriptContext {
            grids,
            style_registry,
            sheet_names,
            active_sheet,
            console_output: RefCell::new(Vec::new()),
            cells_modified: RefCell::new(0),
            cell_bookmarks_json: "[]".to_string(),
            view_bookmarks_json: "[]".to_string(),
            bookmark_mutations: RefCell::new(Vec::new()),
            app_info,
            screen_updating: RefCell::new(true),
            enable_events: RefCell::new(true),
            deferred_actions: RefCell::new(Vec::new()),
            host,
            workbook_properties_changed: RefCell::new(HashMap::new()),
            model_provider: None,
            surface_id: String::new(),
        }
    }

    /// Attach the bookmark JSON blobs the host passed in (builder style).
    pub fn with_bookmarks(mut self, cell_bookmarks_json: String, view_bookmarks_json: String) -> Self {
        self.cell_bookmarks_json = cell_bookmarks_json;
        self.view_bookmarks_json = view_bookmarks_json;
        self
    }

    /// Attach the host-injected read-only model provider (builder style).
    pub fn with_model_provider(
        mut self,
        provider: Option<std::rc::Rc<dyn crate::model_provider::ModelDataProvider>>,
    ) -> Self {
        self.model_provider = provider;
        self
    }
}

/// True when writing `new_value` into `existing` would actually change the
/// grid — the basis for an EFFECTIVE `cells_modified` count.
///
/// A write counts when the stored value differs, or when the target currently
/// holds a formula: script writes store `ast: None`, so overwriting a formula
/// is a real change even if its cached value happens to match. Writing an empty
/// value into an absent cell counts for nothing.
///
/// Without this, every write CALL was counted, so re-running an idempotent
/// script reported hundreds of "modified" cells that no diff could confirm —
/// and the number meant something different on every surface.
pub fn write_is_effective(existing: Option<&Cell>, new_value: &CellValue) -> bool {
    match existing {
        None => *new_value != CellValue::Empty,
        Some(cell) => cell.ast.is_some() || cell.value != *new_value,
    }
}

/// The result of executing a script, returned to the Tauri command layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ScriptResult {
    /// Script executed successfully
    Success {
        /// Structured output items (console lines, tables)
        output: Vec<ScriptOutputItem>,
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
        /// Workbook properties the script set (`Calcula.setWorkbookProperty`),
        /// for the apply path to persist. Server-side on purpose: this is
        /// document metadata, not a UI action, so it is NOT a DeferredAction.
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        workbook_properties_changed: HashMap<String, String>,
        /// Whether screen updating was enabled (Application.screenUpdating)
        screen_updating: bool,
        /// Whether events were enabled (Application.enableEvents)
        enable_events: bool,
    },
    /// Script encountered an error
    Error {
        /// Error message
        message: String,
        /// Structured output collected before the error
        output: Vec<ScriptOutputItem>,
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
