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
    /// Named ranges / defined names
    pub named_ranges: Vec<SavedNamedRange>,
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
    pub id: u32,
    pub sheet_index: usize,
    pub spec_json: String,
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
    /// Sheet index for sheet-scoped names, None for workbook-scoped
    pub sheet_index: Option<usize>,
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
            named_ranges: Vec::new(),
        }
    }

    pub fn from_grid(grid: &Grid, styles: &StyleRegistry, dimensions: &DimensionData) -> Self {
        Self {
            sheets: vec![Sheet::from_grid("Sheet1".to_string(), grid, styles, dimensions)],
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
            named_ranges: Vec::new(),
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

    pub fn from_grid(name: String, grid: &Grid, styles: &StyleRegistry, dimensions: &DimensionData) -> Self {
        let mut cells = HashMap::new();

        for ((row, col), cell) in grid.cells.iter() {
            cells.insert((*row, *col), SavedCell::from_cell(cell));
        }

        Self {
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
            formula: cell.formula.clone(),
            style_index: cell.style_index,
            rich_text: cell.rich_text.clone(),
        }
    }

    pub fn to_cell(&self) -> Cell {
        Cell {
            value: self.value.to_value(),
            formula: self.formula.clone(),
            style_index: self.style_index,
            rich_text: self.rich_text.clone(),
            cached_ast: None,
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
    pub id: u64,
    pub name: String,
    pub sheet_index: usize,
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
    pub id: u32,
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
pub enum SavedSlicerSourceType {
    #[serde(rename = "table")]
    Table,
    #[serde(rename = "pivot")]
    Pivot,
}

/// Serializable slicer selection mode
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SavedSlicerSelectionMode {
    #[serde(rename = "standard")]
    Standard,
    #[serde(rename = "single")]
    Single,
    #[serde(rename = "multi")]
    Multi,
}

impl Default for SavedSlicerSelectionMode {
    fn default() -> Self {
        SavedSlicerSelectionMode::Standard
    }
}

/// Serializable slicer arrangement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SavedSlicerArrangement {
    #[serde(rename = "grid")]
    Grid,
    #[serde(rename = "horizontal")]
    Horizontal,
    #[serde(rename = "vertical")]
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
    pub id: u64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_text: Option<String>,
    pub sheet_index: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub source_type: SavedSlicerSourceType,
    pub source_id: u64,
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
}

/// A saved slicer computed property (formula-driven attribute).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSlicerComputedProperty {
    pub id: u64,
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

/// Calcula metadata structure stored as JSON in the hidden _calcula_meta sheet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalculaMeta {
    pub version: u32,
    pub tables: Vec<SavedTable>,
}

impl CalculaMeta {
    pub fn new(tables: Vec<SavedTable>) -> Self {
        Self {
            version: 1,
            tables,
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
}

/// A workbook-embedded notebook for .cala persistence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedNotebook {
    pub id: String,
    pub name: String,
    pub cells: Vec<SavedNotebookCell>,
}

/// A single cell in a saved notebook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedNotebookCell {
    pub id: String,
    pub source: String,
    pub last_output: Vec<String>,
    pub last_error: Option<String>,
    pub cells_modified: u32,
    pub duration_ms: u64,
    pub execution_index: Option<u32>,
}
