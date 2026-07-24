//! FILENAME: core/persistence/src/lib.rs
//! Calcula Persistence Module
//!
//! Handles saving and loading spreadsheet files in XLSX format.

mod error;
mod xlsx_chart_reader;
mod xlsx_reader;
mod xlsx_style_reader;
mod xlsx_writer;

pub use error::PersistenceError;
pub use xlsx_reader::load_xlsx;
pub use xlsx_writer::save_xlsx;

use engine::cell::{Cell, CellValue, DictKey, RichTextRun};
use engine::grid::Grid;
use engine::style::{CellStyle, StyleRegistry};
use engine::theme::ThemeDefinition;
use identity::{EntityId, SheetId};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ============================================================================
// METADATA SHEET NAME (used for persisting Calcula-specific data in XLSX)
// ============================================================================

/// Hidden metadata sheet name for storing Calcula-specific data in XLSX files.
/// This sheet is filtered out during load and written during save.
pub const META_SHEET_NAME: &str = "_calcula_meta";

// ============================================================================
// WORKBOOK
// ============================================================================

/// Represents a complete workbook that can be saved/loaded
#[derive(Debug, Clone)]
pub struct Workbook {
    pub sheets: Vec<Sheet>,
    pub active_sheet: usize,
    /// Table definitions across all sheets (serialized as JSON in metadata sheet)
    pub tables: Vec<SavedTable>,
    /// Slicer definitions across all sheets
    pub slicers: Vec<SavedSlicer>,
    /// User files stored inside the .cala archive (path -> content).
    /// Paths are relative, e.g. "README.md" or "docs/notes.txt".
    pub user_files: HashMap<String, Vec<u8>>,
    /// Document theme (colors + fonts). Defaults to Office theme.
    pub theme: ThemeDefinition,
    /// Workbook-embedded scripts
    pub scripts: Vec<SavedScript>,
    /// Workbook-embedded notebooks
    pub notebooks: Vec<SavedNotebook>,
    /// Default row height in pixels (24.0 when not customized)
    pub default_row_height: f64,
    /// Default column width in pixels (100.0 when not customized)
    pub default_column_width: f64,
    /// Document properties (author, title, subject, etc.)
    pub properties: WorkbookProperties,
    /// Chart entries (opaque JSON blobs)
    pub charts: Vec<SavedChart>,
    /// Sparkline entries (opaque JSON blobs, one per sheet)
    pub sparklines: Vec<SavedSparkline>,
    /// Named ranges / defined names
    pub named_ranges: Vec<SavedNamedRange>,
    /// Ribbon filter definitions (Filter Pane)
    pub ribbon_filters: Vec<SavedRibbonFilter>,
    /// Pane control definitions (Controls Pane — buttons, sliders, dropdowns,
    /// checkboxes, custom scripted controls). `config` and `value` are opaque
    /// app-owned JSON payloads.
    pub pane_controls: Vec<SavedPaneControl>,
    /// Saved pivot layout configurations (persisted in .cala)
    pub pivot_layouts: Vec<SavedPivotLayout>,
    /// Full pivot table definitions (opaque JSON — PivotDefinition from pivot-engine).
    /// The persistence layer stores these as-is; the app layer handles
    /// serializing/deserializing to the concrete PivotDefinition type.
    pub pivot_definitions: Vec<SavedPivotDefinition>,
    /// BI pivot metadata for reconnecting to BI models on load.
    /// Stored as opaque JSON — the app layer handles deserialization.
    pub bi_pivot_metadata: Vec<serde_json::Value>,
    /// Object scripts (scriptable objects — primitive + component scripts)
    pub object_scripts: Vec<SavedObjectScript>,
    /// Per-BI-connection "view as" RLS role selections, keyed by a stable
    /// connection identifier (package data source id, or model path for a local
    /// connection). Re-applied when the connection is (re)created on load.
    pub bi_connection_roles: Vec<SavedBiConnectionRole>,
    /// Locally-authored BI connections embedded in the workbook (model + spec +
    /// bindings, NOT credentials) so they reconstruct on open without depending
    /// on the original model file. Package-subscribed connections are NOT stored
    /// here — they reconstruct from the .calp on re-pull.
    pub bi_connections: Vec<SavedBiConnection>,
    /// Embedded BI table-cache blobs for cross-machine offline use. Outer key =
    /// connection id (matches SavedBiConnection.id); inner key = cache-dir file
    /// name (e.g. "metadata.json", "Sales_1a2b3c4d.arrow"); value = raw bytes.
    /// Only locally-authored connections are embedded. Stored as raw zip entries
    /// (not JSON) so binary Arrow data isn't base64-bloated.
    pub bi_connection_caches: HashMap<String, HashMap<String, Vec<u8>>>,
    /// Generic per-extension persisted state (extension id -> arbitrary JSON).
    /// The persistence layer treats each value as an opaque blob — the owning
    /// extension defines its own shape. This is the sanctioned way for ANY
    /// extension (built-in or third-party) to persist workbook state, so the
    /// file format does not need a new typed field per feature
    /// (Primitives-not-Features / No-First-Class-Citizens).
    pub extension_data: HashMap<String, serde_json::Value>,
    /// Conditional-formatting rules per sheet (opaque app-owned JSON payload,
    /// keyed by SheetId for stability). Stored opaquely — like bi_pivot_metadata —
    /// so the persistence layer does not depend on the app's CF rule types.
    pub conditional_formats: Vec<SavedSheetConditionalFormats>,
    /// Data-validation ranges per sheet (opaque app-owned JSON payload, keyed by
    /// SheetId). Stored opaquely for the same reason as conditional_formats.
    pub data_validations: Vec<SavedSheetDataValidations>,
    /// Cell-anchored control metadata per sheet (buttons, checkboxes, images —
    /// onSelect scripts, formula-driven properties). Opaque app-owned JSON
    /// payload keyed by SheetId, like conditional_formats.
    pub controls: Vec<SavedSheetControls>,
    /// Cell-type assignments per sheet (granular bricks: checkbox/progress/
    /// button/... typed cells). Opaque app-owned JSON payload keyed by SheetId,
    /// like conditional_formats.
    pub cell_types: Vec<SavedSheetCellTypes>,
    /// Cell-behavior bindings (granular bricks phase 2: per-range script
    /// behaviors). One entry per binding, keyed by SheetId.
    pub cell_behaviors: Vec<SavedCellBehavior>,
    /// Threaded comments per sheet (opaque app-owned JSON payload — a
    /// serialized list of comment threads with replies/mentions/resolved
    /// state — keyed by SheetId, like conditional_formats).
    pub comments: Vec<SavedSheetComments>,
    /// What-if scenarios per sheet (opaque app-owned JSON payload keyed by
    /// SheetId, like conditional_formats).
    pub scenarios: Vec<SavedSheetScenarios>,
    /// Row/column outline groups per sheet (opaque app-owned JSON payload
    /// keyed by SheetId, like conditional_formats). Collapsed groups also
    /// write their hidden rows/cols into the sheet's hidden sets, but the
    /// group STRUCTURE lives only here.
    pub outlines: Vec<SavedSheetOutline>,
    /// Sheet-level protection + per-cell locked/hidden overrides per sheet
    /// (opaque app-owned JSON payloads keyed by SheetId, like
    /// conditional_formats). Password HASHES only — never plaintext.
    pub sheet_protections: Vec<SavedSheetProtection>,
    /// Workbook structure protection (opaque app-owned JSON payload; None when
    /// the workbook is unprotected).
    pub workbook_protection: Option<serde_json::Value>,
}

/// Conditional-formatting rules for one sheet. `rules` is the opaque app-owned
/// payload (a serialized `Vec<ConditionalFormatDefinition>`); the persistence
/// layer never inspects it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSheetConditionalFormats {
    pub sheet_id: SheetId,
    pub rules: serde_json::Value,
}

/// Data-validation ranges for one sheet. `ranges` is the opaque app-owned payload
/// (a serialized `Vec<ValidationRange>`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSheetDataValidations {
    pub sheet_id: SheetId,
    pub ranges: serde_json::Value,
}

/// Protection state for one sheet. Both payloads are opaque app-owned JSON
/// (the app's `SheetProtection` shape and a list of per-cell
/// `{ row, col, locked, formulaHidden }` entries); the persistence layer never
/// inspects them. Passwords are stored as salted hashes by the app layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSheetProtection {
    pub sheet_id: SheetId,
    /// Sheet-level protection settings (None when the sheet is unprotected
    /// and carries no stored options).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protection: Option<serde_json::Value>,
    /// Per-cell locked/formula-hidden overrides (None when empty).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell_protection: Option<serde_json::Value>,
}

/// Cell-anchored controls for one sheet. `controls` is the opaque app-owned
/// payload (a serialized list of `{ row, col, controlType, properties }`
/// entries); the persistence layer never inspects it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSheetControls {
    pub sheet_id: SheetId,
    pub controls: serde_json::Value,
}

/// Cell-type assignments for one sheet. `cells` is the opaque app-owned
/// payload (a serialized list of `{ row, col, typeId, params }` entries); the
/// persistence layer never inspects it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSheetCellTypes {
    pub sheet_id: SheetId,
    pub cells: serde_json::Value,
}

/// One cell-behavior binding (granular bricks phase 2). `binding` is the
/// opaque app-owned payload (id, scriptId, in-sheet range, dispatch metadata);
/// the sheet association rides on the SheetId.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCellBehavior {
    pub sheet_id: SheetId,
    pub binding: serde_json::Value,
}

/// Threaded comments for one sheet. `comments` is the opaque app-owned
/// payload (a serialized list of comment threads — replies, mentions,
/// resolved flags, timestamps); the persistence layer never inspects it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSheetComments {
    pub sheet_id: SheetId,
    pub comments: serde_json::Value,
}

/// What-if scenarios for one sheet. `scenarios` is the opaque app-owned
/// payload (a serialized list of named scenarios with changing cells).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSheetScenarios {
    pub sheet_id: SheetId,
    pub scenarios: serde_json::Value,
}

/// Row/column outline groups for one sheet. `outline` is the opaque app-owned
/// payload (a serialized sheet outline: row groups, column groups, settings).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSheetOutline {
    pub sheet_id: SheetId,
    pub outline: serde_json::Value,
}

/// A locally-authored BI connection persisted in the workbook. Carries the
/// embedded model + connection spec + bindings, but never credentials (those
/// resolve via the credential cache / Connect, keyed by server+database).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedBiConnection {
    /// The connection's stable id (UUID string). Pivots reference it via their
    /// `data_source_id`, so reconstruction must reuse this id.
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub connection_type: String,
    #[serde(default)]
    pub server: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub preferred_auth: String,
    /// Original model file path. Not required to reconstruct (the model is
    /// embedded), but used to re-key the engine to its on-disk cache so the
    /// prior session's cached data is reused offline (same machine).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_path: Option<String>,
    /// The embedded BI model: a raw DataModel JSON object, or a ModelBundle
    /// wrapper (`{ formatVersion, model }`). Reconstruction handles both.
    pub model_json: serde_json::Value,
    #[serde(default)]
    pub bindings: Vec<SavedBiBinding>,
    /// Workbook-local calculated measures defined for this connection's model.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub calculated_measures: Vec<SavedCalculatedMeasure>,
}

/// A workbook-local calculated measure (name + engine measure expression).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCalculatedMeasure {
    pub name: String,
    pub expression: String,
}

/// A model-table -> source-table binding for a persisted BI connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedBiBinding {
    pub model_table: String,
    pub schema: String,
    pub source_table: String,
    /// When set, the table's rows come from this SQL SELECT rather than
    /// `schema.source_table`. Defaulted so older workbooks load unchanged.
    #[serde(default)]
    pub source_query: Option<String>,
}

/// A persisted RLS "view as" role selection for one BI connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedBiConnectionRole {
    /// Stable connection identity: the package data source id for a package
    /// connection, or the model path for a locally-created connection.
    pub connection_key: String,
    /// The active role name (always Some when persisted; an unrestricted
    /// connection simply has no entry).
    pub active_role: String,
}

/// A pivot table definition stored in the workbook.
/// Uses opaque JSON for the definition itself to avoid coupling
/// the persistence crate to the pivot-engine crate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPivotDefinition {
    /// The pivot's unique ID (for cross-referencing with BI metadata).
    pub id: EntityId,
    /// "grid" or "bi" — determines how to rebuild the cache on load.
    pub source_type: String,
    /// For grid-sourced pivots: the sheet index containing the source data.
    pub source_sheet_index: Option<usize>,
    /// The full PivotDefinition serialized as JSON.
    pub definition: serde_json::Value,
}

/// Workbook-level document properties.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookProperties {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub keywords: String,
    #[serde(default)]
    pub category: String,
    /// ISO 8601 date string
    #[serde(default)]
    pub created: String,
    /// ISO 8601 date string
    #[serde(default)]
    pub last_modified: String,
}

/// A chart entry persisted in the workbook.
/// The chart specification is stored as an opaque JSON string.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedChart {
    pub id: EntityId,
    pub sheet_id: SheetId,
    pub spec_json: String,
}

/// A sparkline entry persisted in the workbook.
/// Sparkline groups are stored as an opaque JSON string per sheet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSparkline {
    pub sheet_id: SheetId,
    pub groups_json: String,
}

/// A merged cell region for persistence.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedMergedRegion {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// A named range / defined name for persistence.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedNamedRange {
    /// The name identifier (e.g. "SalesData")
    pub name: String,
    /// The formula this name refers to (e.g. "Sheet1!$A$1:$B$10")
    pub refers_to: String,
    /// Sheet ID for sheet-scoped names, None for workbook-scoped
    pub sheet_id: Option<SheetId>,
    /// Optional comment/description (Name Manager).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// Optional folder for organizational grouping in the Name Manager.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

/// A note/comment attached to a cell for persistence.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedNote {
    pub row: u32,
    pub col: u32,
    pub text: String,
    pub author: String,
}

/// A hyperlink attached to a cell for persistence.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedHyperlink {
    pub row: u32,
    pub col: u32,
    /// The target URL, file path, or internal reference
    pub target: String,
    /// Display text (if different from cell value)
    pub display_text: Option<String>,
    /// Tooltip text
    pub tooltip: Option<String>,
}

/// Page setup / print settings for a sheet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPageSetup {
    /// Paper size name: "letter", "a4", "a3", "legal", "tabloid"
    pub paper_size: String,
    /// Page orientation: "portrait" or "landscape"
    pub orientation: String,
    /// Margins in inches
    pub margin_top: f64,
    pub margin_bottom: f64,
    pub margin_left: f64,
    pub margin_right: f64,
    pub margin_header: f64,
    pub margin_footer: f64,
    /// Header text
    pub header: String,
    /// Footer text
    pub footer: String,
    /// Print area (e.g. "A1:F20"), empty = entire sheet
    pub print_area: String,
    /// Rows to repeat at top (e.g. "1:2"), empty = none
    pub print_titles_rows: String,
    /// Manual row page breaks (0-indexed)
    pub manual_row_breaks: Vec<u32>,
    /// Print gridlines
    pub print_gridlines: bool,
    /// Center horizontally
    pub center_horizontally: bool,
    /// Center vertically
    pub center_vertically: bool,
    /// Scaling percentage (100 = no scaling)
    pub scale: u32,
    /// Fit to N pages wide (0 = disabled)
    pub fit_to_width: u32,
    /// Fit to N pages tall (0 = disabled)
    pub fit_to_height: u32,
    /// Page order: "downThenOver" or "overThenDown"
    pub page_order: String,
    /// First page number: -1 = auto
    pub first_page_number: i32,
}

impl Workbook {
    pub fn new() -> Self {
        Self {
            sheets: vec![Sheet::new("Sheet1".to_string())],
            active_sheet: 0,
            tables: Vec::new(),
            slicers: Vec::new(),
            user_files: HashMap::new(),
            theme: ThemeDefinition::default(),
            scripts: Vec::new(),
            notebooks: Vec::new(),
            default_row_height: 24.0,
            default_column_width: 100.0,
            properties: WorkbookProperties::default(),
            charts: Vec::new(),
            sparklines: Vec::new(),
            named_ranges: Vec::new(),
            ribbon_filters: Vec::new(),
            pane_controls: Vec::new(),
            pivot_layouts: Vec::new(),
            pivot_definitions: Vec::new(),
            bi_pivot_metadata: Vec::new(),
            object_scripts: Vec::new(),
            bi_connection_roles: Vec::new(),
            bi_connections: Vec::new(),
            bi_connection_caches: HashMap::new(),
            extension_data: HashMap::new(),
            conditional_formats: Vec::new(),
            data_validations: Vec::new(),
            controls: Vec::new(),
            cell_types: Vec::new(),
            cell_behaviors: Vec::new(),
            comments: Vec::new(),
            scenarios: Vec::new(),
            outlines: Vec::new(),
            sheet_protections: Vec::new(),
            workbook_protection: None,
        }
    }

    pub fn from_grid(grid: &Grid, styles: &StyleRegistry, dimensions: &DimensionData) -> Self {
        Self {
            sheets: vec![Sheet::from_grid(SheetId::from_bytes(identity::generate_uuid_v7()), "Sheet1".to_string(), grid, styles, dimensions)],
            active_sheet: 0,
            tables: Vec::new(),
            slicers: Vec::new(),
            user_files: HashMap::new(),
            theme: ThemeDefinition::default(),
            scripts: Vec::new(),
            notebooks: Vec::new(),
            default_row_height: 24.0,
            default_column_width: 100.0,
            properties: WorkbookProperties::default(),
            charts: Vec::new(),
            sparklines: Vec::new(),
            named_ranges: Vec::new(),
            ribbon_filters: Vec::new(),
            pane_controls: Vec::new(),
            pivot_layouts: Vec::new(),
            pivot_definitions: Vec::new(),
            bi_pivot_metadata: Vec::new(),
            object_scripts: Vec::new(),
            bi_connection_roles: Vec::new(),
            bi_connections: Vec::new(),
            bi_connection_caches: HashMap::new(),
            extension_data: HashMap::new(),
            conditional_formats: Vec::new(),
            data_validations: Vec::new(),
            controls: Vec::new(),
            cell_types: Vec::new(),
            cell_behaviors: Vec::new(),
            comments: Vec::new(),
            scenarios: Vec::new(),
            outlines: Vec::new(),
            sheet_protections: Vec::new(),
            workbook_protection: None,
        }
    }
}

impl Default for Workbook {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// SHEET
// ============================================================================

/// Represents a single worksheet
#[derive(Debug, Clone)]
pub struct Sheet {
    /// Stable identity for this sheet (UUID v7). Survives renames and reordering.
    pub id: SheetId,
    pub name: String,
    pub cells: HashMap<(u32, u32), SavedCell>,
    pub column_widths: HashMap<u32, f64>,
    pub row_heights: HashMap<u32, f64>,
    pub styles: Vec<CellStyle>,
    /// Merged cell regions
    pub merged_regions: Vec<SavedMergedRegion>,
    /// Freeze pane row (rows 0..freeze_row are frozen at top)
    pub freeze_row: Option<u32>,
    /// Freeze pane column (cols 0..freeze_col are frozen at left)
    pub freeze_col: Option<u32>,
    /// Hidden row indices
    pub hidden_rows: HashSet<u32>,
    /// Hidden column indices
    pub hidden_cols: HashSet<u32>,
    /// Tab color as CSS hex string (e.g. "#ff0000"). Empty = no color.
    pub tab_color: String,
    /// Sheet visibility: "visible", "hidden", or "veryHidden"
    pub visibility: String,
    /// Notes/comments attached to cells
    pub notes: Vec<SavedNote>,
    /// Hyperlinks attached to cells
    pub hyperlinks: Vec<SavedHyperlink>,
    /// Page setup / print settings
    pub page_setup: Option<SavedPageSetup>,
    /// Whether gridlines should be shown (default true)
    pub show_gridlines: bool,
}

impl Sheet {
    pub fn new(name: String) -> Self {
        Self {
            id: SheetId::from_bytes(identity::generate_uuid_v7()),
            name,
            cells: HashMap::new(),
            column_widths: HashMap::new(),
            row_heights: HashMap::new(),
            styles: vec![CellStyle::new()],
            merged_regions: Vec::new(),
            freeze_row: None,
            freeze_col: None,
            hidden_rows: HashSet::new(),
            hidden_cols: HashSet::new(),
            tab_color: String::new(),
            visibility: "visible".to_string(),
            notes: Vec::new(),
            hyperlinks: Vec::new(),
            page_setup: None,
            show_gridlines: true,
        }
    }

    pub fn new_with_id(id: SheetId, name: String) -> Self {
        let mut s = Self::new(name);
        s.id = id;
        s
    }

    pub fn from_grid(id: SheetId, name: String, grid: &Grid, styles: &StyleRegistry, dimensions: &DimensionData) -> Self {
        let mut cells = HashMap::new();

        for ((row, col), cell) in grid.cells.iter() {
            cells.insert((*row, *col), SavedCell::from_cell(cell));
        }

        Self {
            id,
            name,
            cells,
            column_widths: dimensions.column_widths.clone(),
            row_heights: dimensions.row_heights.clone(),
            styles: styles.all_styles().to_vec(),
            merged_regions: Vec::new(),
            freeze_row: None,
            freeze_col: None,
            hidden_rows: HashSet::new(),
            hidden_cols: HashSet::new(),
            tab_color: String::new(),
            visibility: "visible".to_string(),
            notes: Vec::new(),
            hyperlinks: Vec::new(),
            page_setup: None,
            show_gridlines: true,
        }
    }

    pub fn to_grid(&self) -> (Grid, StyleRegistry) {
        let mut grid = Grid::new();
        let mut style_registry = StyleRegistry::new();

        // Rebuild styles
        for style in &self.styles[1..] {
            style_registry.get_or_create(style.clone());
        }

        // Rebuild cells
        for ((row, col), saved_cell) in &self.cells {
            let cell = saved_cell.to_cell();
            grid.set_cell(*row, *col, cell);
        }

        (grid, style_registry)
    }
}

// ============================================================================
// DIMENSION DATA
// ============================================================================

/// Dimension data for columns and rows
#[derive(Debug, Clone, Default)]
pub struct DimensionData {
    pub column_widths: HashMap<u32, f64>,
    pub row_heights: HashMap<u32, f64>,
}

// ============================================================================
// SAVED CELL
// ============================================================================

/// A cell that can be serialized
#[derive(Debug, Clone)]
pub struct SavedCell {
    pub value: SavedCellValue,
    pub formula: Option<String>,
    pub style_index: usize,
    /// Rich text runs for partial formatting within the cell.
    pub rich_text: Option<Vec<RichTextRun>>,
}

impl SavedCell {
    pub fn from_cell(cell: &Cell) -> Self {
        Self {
            value: SavedCellValue::from_value(&cell.value),
            // Persist the RAW form: the internal `__INVOKE__("Name", lambda, ...)`
            // marker must round-trip so that on load the re-parsed AST resolves
            // back to the same form dependency extraction and evaluation expect.
            // (Display collapses it to `Name(...)` via `formula_string()`.)
            formula: cell.formula_string_raw(),
            style_index: cell.style_index,
            rich_text: cell.rich_text.clone(),
        }
    }

    pub fn to_cell(&self) -> Cell {
        if let Some(ref formula_str) = self.formula {
            let mut cell = Cell::new_formula(formula_str.clone());
            cell.value = self.value.to_value();
            cell.style_index = self.style_index;
            cell.rich_text = self.rich_text.clone();
            cell
        } else {
            Cell {
                ast: None,
                value: self.value.to_value(),
                style_index: self.style_index,
                rich_text: self.rich_text.clone(),
            }
        }
    }
}

/// Serializable cell value
#[derive(Debug, Clone)]
pub enum SavedCellValue {
    Empty,
    Number(f64),
    Text(String),
    Boolean(bool),
    Error(String),
    List(Vec<SavedCellValue>),
    /// Dict entries stored as (serialized_key, value) pairs.
    /// Key encoding: plain string for text keys, "n:<num>" for numbers, "b:<bool>" for booleans.
    Dict(Vec<(String, SavedCellValue)>),
}

/// Serialize a DictKey to a tagged string for persistence.
fn serialize_dict_key(key: &DictKey) -> String {
    match key {
        DictKey::Text(s) => s.clone(),
        DictKey::Number(n) => format!("n:{}", n),
        DictKey::Boolean(b) => format!("b:{}", b),
    }
}

/// Deserialize a tagged string back to a DictKey.
fn deserialize_dict_key(s: &str) -> DictKey {
    if let Some(rest) = s.strip_prefix("n:") {
        if let Ok(n) = rest.parse::<f64>() {
            return DictKey::Number(n);
        }
    }
    if let Some(rest) = s.strip_prefix("b:") {
        if rest == "true" {
            return DictKey::Boolean(true);
        } else if rest == "false" {
            return DictKey::Boolean(false);
        }
    }
    DictKey::Text(s.to_string())
}

impl SavedCellValue {
    pub fn from_value(value: &CellValue) -> Self {
        match value {
            CellValue::Empty => SavedCellValue::Empty,
            CellValue::Number(n) => SavedCellValue::Number(*n),
            CellValue::Text(s) => SavedCellValue::Text(s.clone()),
            CellValue::Boolean(b) => SavedCellValue::Boolean(*b),
            CellValue::Error(e) => SavedCellValue::Error(format!("{:?}", e)),
            CellValue::List(items) => {
                SavedCellValue::List(items.iter().map(SavedCellValue::from_value).collect())
            }
            CellValue::Dict(entries) => {
                SavedCellValue::Dict(
                    entries.iter().map(|(k, v)| {
                        (serialize_dict_key(k), SavedCellValue::from_value(v))
                    }).collect()
                )
            }
        }
    }

    pub fn to_value(&self) -> CellValue {
        match self {
            SavedCellValue::Empty => CellValue::Empty,
            SavedCellValue::Number(n) => CellValue::Number(*n),
            SavedCellValue::Text(s) => CellValue::Text(s.clone()),
            SavedCellValue::Boolean(b) => CellValue::Boolean(*b),
            SavedCellValue::Error(_) => CellValue::Error(engine::cell::CellError::Value),
            SavedCellValue::List(items) => {
                CellValue::List(Box::new(items.iter().map(|i| i.to_value()).collect()))
            }
            SavedCellValue::Dict(entries) => {
                CellValue::Dict(Box::new(
                    entries.iter().map(|(k, v)| {
                        (deserialize_dict_key(k), v.to_value())
                    }).collect()
                ))
            }
        }
    }
}

// ============================================================================
// SAVED TABLE (for persisting table definitions)
// ============================================================================

/// Serializable table definition for persistence.
/// Mirrors the runtime `Table` struct from the tables module.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedTable {
    pub id: EntityId,
    pub name: String,
    pub sheet_id: SheetId,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    pub columns: Vec<SavedTableColumn>,
    pub style_options: SavedTableStyleOptions,
    pub style_name: String,
}

/// Serializable table column
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedTableColumn {
    pub id: EntityId,
    pub name: String,
    pub totals_row_function: String,
    pub totals_row_formula: Option<String>,
    pub calculated_formula: Option<String>,
}

/// Serializable table style options
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedTableStyleOptions {
    pub banded_rows: bool,
    pub banded_columns: bool,
    pub header_row: bool,
    pub total_row: bool,
    pub first_column: bool,
    pub last_column: bool,
    pub show_filter_button: bool,
}

/// Serializable slicer source type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SavedSlicerSourceType {
    Table,
    Pivot,
    BiConnection,
}

/// A typed reference to a pivot or table that a slicer filters (Report Connection).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSlicerConnection {
    pub source_type: SavedSlicerSourceType,
    pub source_id: EntityId,
}

/// Serializable slicer selection mode
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SavedSlicerSelectionMode {
    Standard,
    Single,
    Multi,
}

impl Default for SavedSlicerSelectionMode {
    fn default() -> Self {
        SavedSlicerSelectionMode::Standard
    }
}

/// Serializable slicer arrangement
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SavedSlicerArrangement {
    Grid,
    Horizontal,
    Vertical,
}

impl Default for SavedSlicerArrangement {
    fn default() -> Self {
        SavedSlicerArrangement::Vertical
    }
}

/// Serializable slicer definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSlicer {
    pub id: EntityId,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_text: Option<String>,
    pub sheet_id: SheetId,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub source_type: SavedSlicerSourceType,
    /// The pivot/table ID used as the data source for fetching slicer items.
    pub cache_source_id: EntityId,
    pub field_name: String,
    pub selected_items: Option<Vec<String>>,
    pub show_header: bool,
    pub columns: u32,
    pub style_preset: String,
    #[serde(default)]
    pub selection_mode: SavedSlicerSelectionMode,
    #[serde(default)]
    pub hide_no_data: bool,
    #[serde(default = "default_true")]
    pub indicate_no_data: bool,
    #[serde(default = "default_true")]
    pub sort_no_data_last: bool,
    #[serde(default)]
    pub force_selection: bool,
    #[serde(default)]
    pub show_select_all: bool,
    #[serde(default)]
    pub arrangement: SavedSlicerArrangement,
    #[serde(default)]
    pub rows: u32,
    #[serde(default = "default_gap")]
    pub item_gap: f64,
    #[serde(default = "default_true")]
    pub autogrid: bool,
    #[serde(default)]
    pub item_padding: f64,
    #[serde(default = "default_button_radius")]
    pub button_radius: f64,
    /// Computed properties (formula-driven attributes)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub computed_properties: Vec<SavedSlicerComputedProperty>,
    /// Report Connections: pivots/tables that this slicer filters.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_sources: Vec<SavedSlicerConnection>,
}

/// A saved slicer computed property (formula-driven attribute).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSlicerComputedProperty {
    pub id: EntityId,
    pub attribute: String,
    pub formula: String,
}

fn default_true() -> bool {
    true
}

fn default_gap() -> f64 {
    4.0
}

fn default_button_radius() -> f64 {
    2.0
}

fn default_button_columns() -> u32 {
    2
}

// ============================================================================
// RIBBON FILTERS
// ============================================================================

/// Serializable ribbon filter display mode
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SavedRibbonFilterDisplayMode {
    Checklist,
    Buttons,
    Dropdown,
}

impl Default for SavedRibbonFilterDisplayMode {
    fn default() -> Self {
        SavedRibbonFilterDisplayMode::Checklist
    }
}

/// How a ribbon filter determines its connections.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SavedConnectionMode {
    Manual,
    BySheet,
    Workbook,
}

impl Default for SavedConnectionMode {
    fn default() -> Self {
        SavedConnectionMode::Manual
    }
}

/// Serializable ribbon filter definition.
/// Ribbon filter values always come from a Calcula model (BI) connection;
/// `connection_id` is the stable connection UUID (SavedBiConnection.id).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedRibbonFilter {
    pub id: EntityId,
    pub name: String,
    pub connection_id: EntityId,
    /// For filters on a package-pulled connection: the stable package
    /// data-source id used to re-bind connection_id after re-pull.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_source_id: Option<String>,
    pub field_name: String,
    #[serde(default = "default_unknown")]
    pub field_data_type: String,
    #[serde(default)]
    pub connection_mode: SavedConnectionMode,
    /// For manual mode: explicitly selected target pivots.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_pivots: Vec<EntityId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_sheets: Vec<usize>,
    #[serde(default)]
    pub display_mode: SavedRibbonFilterDisplayMode,
    pub selected_items: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cross_filter_targets: Vec<EntityId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cross_filter_slicer_targets: Vec<EntityId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced_filter: Option<SavedAdvancedFilter>,
    #[serde(default)]
    pub hide_no_data: bool,
    #[serde(default = "default_true")]
    pub indicate_no_data: bool,
    #[serde(default = "default_true")]
    pub sort_no_data_last: bool,
    #[serde(default)]
    pub show_select_all: bool,
    #[serde(default)]
    pub single_select: bool,
    #[serde(default)]
    pub order: u32,
    #[serde(default = "default_button_columns")]
    pub button_columns: u32,
    #[serde(default)]
    pub button_rows: u32,
}

/// Saved advanced filter condition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedAdvancedFilterCondition {
    pub operator: String,
    #[serde(default)]
    pub value: String,
}

/// Saved advanced filter (one or two conditions with logic).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedAdvancedFilter {
    pub condition1: SavedAdvancedFilterCondition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition2: Option<SavedAdvancedFilterCondition>,
    #[serde(default = "default_and")]
    pub logic: String,
}

fn default_unknown() -> String {
    "unknown".to_string()
}

fn default_and() -> String {
    "and".to_string()
}

// ============================================================================
// PANE CONTROLS (Controls Pane)
// ============================================================================

/// Serializable pane control definition (Controls Pane).
/// `config` and `value` are opaque app-owned JSON payloads — the persistence
/// layer never inspects them (like `bi_pivot_metadata`). A value-less control
/// (e.g. a button) stores `value: null`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPaneControl {
    pub id: EntityId,
    pub name: String,
    /// "button" | "slider" | "dropdown" | "checkbox" | "custom"
    pub control_type: String,
    /// Opaque control configuration (app-owned PaneControlConfig JSON).
    pub config: serde_json::Value,
    /// Opaque current value (app-owned ControlValue JSON; null when value-less).
    pub value: serde_json::Value,
    /// Position in the Controls-pane strip. Shares the number space with
    /// `SavedRibbonFilter.order` (one merged, mixed list).
    pub order: u32,
}

/// Calcula metadata structure stored as JSON in the hidden _calcula_meta sheet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalculaMeta {
    pub version: u32,
    pub tables: Vec<SavedTable>,
    /// Full-fidelity chart carry (position-keyed): the complete ChartDefinition
    /// JSON per chart, so a Calcula -> xlsx -> Calcula round-trip restores
    /// charts losslessly even where the native OOXML chart emission is only an
    /// approximation (or skipped for non-mappable marks).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub charts: Vec<MetaChart>,
    /// Full-fidelity sparkline carry (position-keyed) — xlsx has no native
    /// sparkline emission, so this is the only way they survive the format.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sparklines: Vec<MetaSparkline>,
}

/// A chart carried in the `_calcula_meta` sheet, keyed by 0-based visible-sheet
/// position (SheetIds are re-minted on xlsx import, so ids cannot be used).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaChart {
    pub sheet_index: usize,
    pub spec_json: String,
    /// True when this chart was ALSO emitted as a native OOXML chart at save.
    /// The reader compares the per-sheet count of these against the file's
    /// actual native charts to detect Excel-side edits: a mismatch means Excel
    /// touched the charts, so the native ones win over this stale carry.
    #[serde(default)]
    pub native_emitted: bool,
}

/// A sheet's sparkline groups carried in the `_calcula_meta` sheet
/// (position-keyed, same rationale as [`MetaChart`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaSparkline {
    pub sheet_index: usize,
    pub groups_json: String,
}

impl CalculaMeta {
    pub fn new(tables: Vec<SavedTable>) -> Self {
        Self {
            version: 1,
            tables,
            charts: Vec::new(),
            sparklines: Vec::new(),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn from_json(json: &str) -> Option<Self> {
        serde_json::from_str(json).ok()
    }
}

// ============================================================================
// SCRIPTS & NOTEBOOKS
// ============================================================================

/// Scope of a script: workbook-level or attached to a sheet.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SavedScriptScope {
    Workbook,
    Sheet { name: String },
}

impl Default for SavedScriptScope {
    fn default() -> Self {
        SavedScriptScope::Workbook
    }
}

/// A workbook-embedded script for .cala persistence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedScript {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub source: String,
    /// Where this script lives: workbook-level or scoped to a sheet.
    #[serde(default)]
    pub scope: SavedScriptScope,
    /// The .calp package this module script was distributed from (C8 provenance).
    /// None = local. Persisted so a refresh AFTER a save/reload still knows which
    /// modules belong to which package (replace/remove on refresh; keep locals).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_package: Option<String>,
}

/// A workbook-embedded notebook for .cala persistence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedNotebook {
    pub id: String,
    pub name: String,
    pub cells: Vec<SavedNotebookCell>,
    /// The .calp package this notebook was distributed from (C8 provenance).
    /// None = local. See SavedScript.source_package.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_package: Option<String>,
}

/// A single cell in a saved notebook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedNotebookCell {
    pub id: String,
    pub source: String,
    #[serde(default)]
    pub last_output: Vec<SavedNotebookOutputItem>,
    pub last_error: Option<String>,
    pub cells_modified: u32,
    pub duration_ms: u64,
    pub execution_index: Option<u32>,
}

/// A structured output item persisted with a notebook cell. Mirrors
/// script_engine::ScriptOutputItem (persistence must not depend on the
/// script engine crate, so the shape is mirrored here; the app layer
/// converts). Same serde representation across all layers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SavedNotebookOutputItem {
    #[serde(rename_all = "camelCase")]
    Text { text: String },
    #[serde(rename_all = "camelCase")]
    Table {
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
        truncated: bool,
        total_rows: usize,
    },
}

impl SavedNotebookOutputItem {
    pub fn text(s: impl Into<String>) -> Self {
        SavedNotebookOutputItem::Text { text: s.into() }
    }
}

// ============================================================================
// Object Scripts (Scriptable Objects)
// ============================================================================

/// The type of scriptable object a script is attached to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScriptableObjectType {
    Workbook,
    Sheet,
    Cell,
    Row,
    Column,
    Slicer,
    Chart,
    Pivot,
    Button,
    Textbox,
    Timeline,
    Shape,
    Table,
    NamedRange,
    Panel,
    /// A cell-behavior binding target (granular bricks phase 2): the script's
    /// instanceId is the binding id in the cell-behaviors store.
    Range,
}

/// Access level for object scripts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScriptAccessLevel {
    Restricted,
    Unlocked,
}

impl Default for ScriptAccessLevel {
    fn default() -> Self {
        ScriptAccessLevel::Restricted
    }
}

/// Where an object script came from. Distributed scripts (materialized from a
/// .calp package) require explicit user consent before mounting and cannot be
/// silently escalated or laundered back to local.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScriptProvenance {
    Local,
    Distributed,
}

impl Default for ScriptProvenance {
    fn default() -> Self {
        ScriptProvenance::Local
    }
}

/// The recognized capability ids a script source may declare (R19 ceiling).
/// Mirrors the frontend KNOWN_CAPABILITY_IDS in capabilities.ts. The origin
/// argument of a `// @capability net.fetch <origin>` pragma is a runtime grant
/// hint, not part of the ceiling, so only the cap id set is collected here.
pub const KNOWN_CAPABILITY_IDS: [&str; 4] = ["net.fetch", "bi.query", "storage", "ui.html"];

/// Parse a script source for `// @capability <id> [origin]` line-comment
/// pragmas and return the deduped set of recognized capability ids, in first-
/// seen order. This is the Rust mirror of parseDeclaredCapabilities (TS) and is
/// the AUTHORITATIVE ceiling for a LOCAL script. Unknown ids are ignored; the
/// optional origin argument is not part of the ceiling.
pub fn parse_declared_capabilities(source: &str) -> Vec<String> {
    let mut caps: Vec<String> = Vec::new();
    for line in source.lines() {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix("//") else { continue };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix("@capability") else { continue };
        // Require whitespace after the directive so "@capabilityx" doesn't match.
        if !rest.starts_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let mut tokens = rest.split_whitespace();
        if let Some(cap_id) = tokens.next() {
            if KNOWN_CAPABILITY_IDS.contains(&cap_id) && !caps.iter().any(|c| c == cap_id) {
                caps.push(cap_id.to_string());
            }
        }
    }
    caps
}

/// A script attached to a scriptable object (primitive or component).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedObjectScript {
    pub id: String,
    pub name: String,
    /// The object type this script targets.
    pub object_type: ScriptableObjectType,
    /// For component objects: the instance ID. None for primitive objects.
    pub instance_id: Option<String>,
    /// The script source code.
    pub source: String,
    /// Access level: restricted (default) or unlocked.
    #[serde(default)]
    pub access_level: ScriptAccessLevel,
    /// Optional description.
    pub description: Option<String>,
    /// Origin of the script: local (default) or distributed via a .calp package.
    #[serde(default)]
    pub provenance: ScriptProvenance,
    /// For distributed scripts: the package the script arrived from.
    #[serde(default)]
    pub package_name: Option<String>,
    /// The AUTHORITATIVE set of capability ids this script is allowed to use
    /// (R19 declared-capabilities ceiling). For local scripts this is derived
    /// from the source `// @capability <id>` pragmas on save. For distributed
    /// scripts this is set from the package manifest at pull time and is NEVER
    /// re-derived from the (tamperable) source, so a distributed script's
    /// source can never widen its ceiling. Recognized ids: net.fetch, bi.query,
    /// storage, ui.html.
    #[serde(default)]
    pub declared_capabilities: Vec<String>,
}

// ============================================================================
// Pivot Layouts
// ============================================================================

/// A saved pivot layout configuration that persists in the .cala file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedPivotLayout {
    pub id: EntityId,
    pub name: String,
    pub dsl_text: String,
    pub description: Option<String>,
    /// "table" or "bi"
    pub source_type: String,
    /// For table-sourced pivots: the Table object name
    pub source_table_name: Option<String>,
    /// For BI pivots: table names from the model
    pub source_bi_tables: Vec<String>,
    /// For BI pivots: measure names from the model
    pub source_bi_measures: Vec<String>,
    pub created_at: f64,
    pub updated_at: f64,
}
